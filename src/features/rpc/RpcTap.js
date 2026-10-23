/**
 * RpcTap — in-memory ring buffer for NetRpc (GameMsg type 2) debugging.
 *
 * Keeps the last N C→S NetRpc frames plus stale-generation drops so
 * social_arm / gift classId ambiguities can be triaged without restarting
 * with debug logging or Wireshark. All capture is O(1) and never throws
 * into the hot path.
 */

export class RpcTap {
  constructor({ maxEntries = 500, maxHexBytes = 96 } = {}) {
    this.maxEntries = maxEntries;
    this.maxHexBytes = maxHexBytes;
    this.enabled = true;
    this._buf = [];
    this._seq = 0;
    this._staleDrops = 0;
    this._total = 0;
    this._byKey = new Map(); // "classIdKey:typeFlag" -> count
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  clear() {
    this._buf.length = 0;
    this._seq = 0;
    this._staleDrops = 0;
    this._total = 0;
    this._byKey.clear();
  }

  /**
   * @param {object} entry - already shaped by GameMessageService
   */
  push(entry) {
    if (!this.enabled) return;
    this._seq += 1;
    this._total += 1;
    const key = entry.header
      ? `${entry.header.classIdKey}:${entry.header.typeFlag}`
      : 'unknown:*';
    this._byKey.set(key, (this._byKey.get(key) ?? 0) + 1);
    if (entry.status === 'stale_dropped') this._staleDrops += 1;

    const rec = {
      seq: this._seq,
      ts: Date.now(),
      iso: new Date().toISOString(),
      ...entry,
    };
    this._buf.push(rec);
    if (this._buf.length > this.maxEntries) this._buf.shift();
  }

  /**
   * @param {object} [filter]
   * @param {number} [filter.limit]
   * @param {string} [filter.classIdKey] 7-byte hex lower case
   * @param {number|string} [filter.typeFlag]
   * @param {number|string} [filter.playerId]
   * @param {string} [filter.status]
   */
  list({ limit = 50, classIdKey, typeFlag, playerId, status } = {}) {
    let out = this._buf;
    if (classIdKey) {
      const k = String(classIdKey).toLowerCase();
      out = out.filter(r => r.header?.classIdKey === k);
    }
    if (typeFlag !== undefined && typeFlag !== '') {
      const tf = Number(typeFlag);
      out = out.filter(r => r.header?.typeFlag === tf);
    }
    if (playerId !== undefined && playerId !== '') {
      const pid = Number(playerId);
      out = out.filter(r => r.playerId === pid);
    }
    if (status) out = out.filter(r => r.status === status);
    const n = Math.max(1, Math.min(Number(limit) || 50, this.maxEntries));
    return out.slice(-n).reverse();
  }

  stats() {
    const byKey = [...this._byKey.entries()]
      .map(([k, count]) => {
        const [classIdKey, typeFlag] = k.split(':');
        return { classIdKey, typeFlag: typeFlag === '*' ? '*' : Number(typeFlag), count };
      })
      .sort((a, b) => b.count - a.count);

    return {
      enabled: this.enabled,
      maxEntries: this.maxEntries,
      total: this._total,
      buffered: this._buf.length,
      staleDrops: this._staleDrops,
      seq: this._seq,
      byKey,
    };
  }

  toApi() {
    return this.stats();
  }
}

export const rpcTap = new RpcTap();

/**
 * Truncate a Buffer to a hex string for the API.
 */
export function toHexPreview(buf, maxBytes = 96) {
  if (!Buffer.isBuffer(buf)) return null;
  const slice = buf.subarray(0, maxBytes);
  return {
    hex: slice.toString('hex'),
    truncated: buf.length > maxBytes,
    bytes: buf.length,
  };
}
