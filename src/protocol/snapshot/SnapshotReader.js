import { fnv1a8 } from './fnv1a.js';
import { SNAPSHOT_MAX_DATA_BYTES } from './constants.js';

// Wire frame layout (matches Rust colorsky SnapshotReader):
//   [save_seq: u8][base_seq: u8][checksum: u8][payload...]
//
// Frame types:
//   raw:      save_seq != 0, base_seq == 0  — full raw state, stored in window
//   keyframe: save_seq != 0, base_seq != 0  — XOR-RLE diff, stored in window
//   delta:    save_seq == 0, base_seq != 0  — XOR-RLE diff, NOT stored in window
//   invalid:  save_seq == 0, base_seq == 0  — ignored

const MAX_WINDOW = 16;

export class SnapshotReader {
  constructor({ baseSize = SNAPSHOT_MAX_DATA_BYTES } = {}) {
    this.baseSize = baseSize;
    // Native Initialize seeds an empty sequence-1 base. This lets the first
    // wire frame be a saved delta with save_seq 2 and base_seq 1.
    // Entries are ordered oldest-first.
    this.window = [{ sequence: 1, data: Buffer.alloc(0) }];
    this.waitingForKeyframe = false;
    this.onStatus = undefined;
  }

  onSync(callback) {
    this.onStatus = typeof callback === 'function' ? callback : undefined;
  }

  /** Reset — force waiting for next raw/keyframe before accepting deltas. */
  forceWaitForKeyframe() {
    this.window = [];
    this.waitingForKeyframe = true;
    this.onStatus?.('resyncstart');
  }

  /** Most recently decoded save_seq (0 if none). */
  latestSequence() {
    for (let i = this.window.length - 1; i >= 0; i--) {
      if (this.window[i].sequence !== 0) return this.window[i].sequence;
    }
    return 0;
  }

  /**
   * Apply an incoming frame (Buffer: 3-byte header + payload).
   * Returns { ok: true, data: Buffer, ack: number, raw: bool } on success,
   * or { ok: false, reason: string } on failure.
   */
  read(frameOrObj) {
    // Accept either a raw Buffer frame or the object form { sequence, base, checksum, payload }
    let saveSeq, baseSeq, checksum, payload;

    if (Buffer.isBuffer(frameOrObj)) {
      if (frameOrObj.length < 3) {
        return { ok: false, reason: 'too_short' };
      }
      saveSeq  = frameOrObj[0];
      baseSeq  = frameOrObj[1];
      checksum = frameOrObj[2];
      payload  = frameOrObj.subarray(3);
    } else {
      // Object form from GameMsgPacket decoder: { sequence, base, checksum, payload }
      saveSeq  = frameOrObj.sequence ?? 0;
      baseSeq  = frameOrObj.base ?? 0;
      checksum = frameOrObj.checksum;
      payload  = frameOrObj.payload;
      if (!Buffer.isBuffer(payload)) {
        payload = Buffer.from(payload ?? []);
      }
    }

    // Invalid: both zero
    if (saveSeq === 0 && baseSeq === 0) {
      return { ok: false, reason: 'invalid_frame' };
    }

    if (fnv1a8(payload) !== checksum) {
      this.onStatus?.('hasherror');
      return { ok: false, reason: 'checksum' };
    }

    // ── Raw frame: save_seq != 0, base_seq == 0 ──────────────────────
    if (baseSeq === 0 && saveSeq !== 0) {
      if (payload.length > this.baseSize) {
        return { ok: false, reason: 'snapshot_oversize' };
      }
      const recovering = this.waitingForKeyframe;
      const data = Buffer.from(payload);
      this.window = [];
      this._addToWindow(saveSeq, data);
      this.waitingForKeyframe = false;
      if (recovering) this.onStatus?.('resyncsuccess');
      return { ok: true, data, ack: saveSeq, raw: true };
    }

    // ── Key or delta frame: base_seq != 0 ────────────────────────────
    if (this.waitingForKeyframe && saveSeq === 0) {
      // delta while waiting for keyframe — ignore
      return { ok: false, reason: 'resyncing' };
    }

    const baseEntry = this.window.find(e => e.sequence === baseSeq);
    if (!baseEntry) {
      const wasWaiting = this.waitingForKeyframe;
      if (!wasWaiting) this.onStatus?.('nokeyframe');
      this.window = [];
      this.waitingForKeyframe = true;
      if (!wasWaiting) this.onStatus?.('resyncstart');
      return { ok: false, reason: 'missing_base' };
    }

    const decoded = _rleDecode(payload);
    if (decoded === null) {
      return { ok: false, reason: 'rle_truncated' };
    }
    if (decoded.length > this.baseSize) {
      return { ok: false, reason: 'snapshot_oversize' };
    }

    // The base is present here; missing bases were rejected above and require a raw/keyframe.
    const base = baseEntry ? baseEntry.data : Buffer.alloc(0);
    const outLen = decoded.length;
    const newState = Buffer.alloc(outLen);
    const copyLen = Math.min(base.length, outLen);
    base.copy(newState, 0, 0, copyLen);
    for (let i = 0; i < copyLen; i++) newState[i] = base[i] ^ decoded[i];
    if (outLen > base.length) decoded.copy(newState, base.length, base.length);

    if (saveSeq !== 0) {
      // Keyframe: store in window
      const recovering = this.waitingForKeyframe;
      this._addToWindow(saveSeq, newState);
      this.waitingForKeyframe = false;
      if (recovering) this.onStatus?.('resyncsuccess');
    }

    return { ok: true, data: newState, ack: saveSeq !== 0 ? saveSeq : 0, raw: false };
  }

  _addToWindow(sequence, data) {
    this.window = this.window.filter(e => e.sequence !== sequence);
    this.window.push({ sequence, data: Buffer.from(data) });
    while (this.window.length > MAX_WINDOW) {
      this.window.shift(); // evict oldest
    }
  }
}

function _rleDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === 0x00) {
      if (i + 1 >= data.length) return null; // truncated
      const count = data[i + 1];
      if (count === 0) return null;
      for (let k = 0; k < count; k++) out.push(0);
      i += 2;
    } else {
      out.push(data[i++]);
    }
  }
  return Buffer.from(out);
}
