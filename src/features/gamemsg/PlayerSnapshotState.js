import { SnapshotReader } from '../../protocol/snapshot/SnapshotReader.js';
import { SnapshotWriter } from '../../protocol/snapshot/SnapshotWriter.js';
import { decodePlayerState } from '../../protocol/types/PlayerState.js';

export class PlayerSnapshotState {
  constructor({ decodeFields = false } = {}) {
    this.decodeFields = decodeFields;
    this.rawState = null;
    this.decodedState = null;
    this.readAckSequence = undefined;
    this.stats = {
      lastReadAt: undefined,
      lastReadSequence: undefined,
      lastReadPayloadBytes: 0,
      lastReadDataBytes: 0,
      lastReadError: undefined,
      lastReadStatus: undefined,
      lastWriteAt: undefined,
      lastWriteSequence: undefined,
      lastWritePayloadBytes: 0,
      lastWriteDataBytes: 0,
      lastWriteStatus: undefined,
      droppedWrites: 0
    };
    this._initReaderWriter();
  }

  _initReaderWriter() {
    this.reader = new SnapshotReader();
    this.writer = new SnapshotWriter();
    this.reader.onSync(status => { this.stats.lastReadStatus = status; });
    this.writer.onSync(status => { this.stats.lastWriteStatus = status; });
  }

  read(snapshot, payload) {
    const result = this.reader.read({ ...snapshot, payload });
    this.stats.lastReadAt = Date.now();
    this.stats.lastReadSequence = snapshot?.sequence;
    this.stats.lastReadPayloadBytes = payload?.length ?? 0;
    this.stats.lastReadDataBytes = result.ok ? result.data.length : 0;
    this.stats.lastReadError = result.ok ? undefined : result.reason;
    if (!result.ok && result.reason === 'missing_base') {
      this.rawState = null;
      this.readAckSequence = undefined;
    }
    if (result.ok) {
      this.rawState = result.data;
      if (this.decodeFields) {
        try {
          this.decodedState = decodePlayerState(result.data);
        } catch {
          // Keep the raw state available for the size check and opaque relay.
          this.decodedState = null;
        }
      } else {
        this.decodedState = null;
      }
      if (result.ack) {
        this.readAckSequence = result.ack;
      }
    }
    return result;
  }

  write(data) {
    const frameBuf = this.writer.write(data);
    if (!frameBuf) {
      this.stats.droppedWrites += 1;
      return undefined;
    }

    // Writer returns a Buffer: [save_seq, base_seq, checksum, ...payload]
    // Unpack into the object form expected by GameMessageService.
    const frame = {
      sequence: frameBuf[0],
      base:     frameBuf[1],
      checksum: frameBuf[2],
      payload:  frameBuf.subarray(3)
    };

    this.stats.lastWriteAt = Date.now();
    this.stats.lastWriteSequence = frame.sequence;
    this.stats.lastWritePayloadBytes = frame.payload.length;
    this.stats.lastWriteDataBytes = data.length;
    return frame;
  }

  ack(sequence) {
    this.writer.ack(sequence);
  }

  latestSequence() {
    return this.reader.latestSequence();
  }

  reset() {
    this.stats.lastReadAt = undefined;
    this.stats.lastReadSequence = undefined;
    this.stats.lastReadPayloadBytes = 0;
    this.stats.lastReadDataBytes = 0;
    this.stats.lastReadError = undefined;
    this.stats.lastReadStatus = 'reset';
    this.stats.lastWriteAt = undefined;
    this.stats.lastWriteSequence = undefined;
    this.stats.lastWritePayloadBytes = 0;
    this.stats.lastWriteDataBytes = 0;
    this.stats.lastWriteStatus = 'reset';
    this.stats.droppedWrites = 0;
    this.rawState = null;
    this.decodedState = null;
    this.readAckSequence = undefined;
    this._initReaderWriter();
  }

  toApi() {
    return { ...this.stats, readAckSequence: this.readAckSequence };
  }
}
