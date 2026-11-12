// NetRpc wire format — captured byte-exact from the official server
// (packetdump_20261030203945 + 20260913131425, GameMsg type 2).
//
// rpcData is a CONCATENATION of records, each:
//
//   [0]      slot        u8    associated player slot (sender on C->S)
//   [1..4]   classHash   u32   LE — MetaClass hash (gift = 0x20d9b9b3,
//                    bytes b3 b9 d9 20)
//   [5]      flags       u8    per-class flag (gift wire shows 0x00)
//   [6..7]   bodyLen     u16   LE, bounded <= 0x1000 (client reader
//                    sub_1A692A8: u32 + u8 + bounded(0, 0x1000))
//   [8..]    body        bodyLen bytes, format defined by the class
//
// Records repeat until the buffer ends. The previous implementation assumed
// a flat [class_id u8×7][sender][receiver][type_flag] header — no capture
// packet matches that shape, so the gift patch never fired on real traffic.
//
// The GameMsg envelope ([type u8][levelChangeCount u8][sourcePlayer u8]) is
// stripped before rpcData reaches this layer.

export const RECORD_HEADER_LENGTH = 8 // slot(1) + classHash(4) + flags(1) + bodyLen(2)
export const RECORD_MAX_BODY = 0x1000

/**
 * Parse rpcData into its records. Malformed trailing bytes are returned as
 * `trailing` so callers can pass them through untouched — the wire must be
 * preserved byte-exactly for classes we do not handle.
 */
export function decodeNetRpcRecords (rpcData) {
  if (!Buffer.isBuffer(rpcData)) return null
  const records = []
  let offset = 0
  while (offset + RECORD_HEADER_LENGTH <= rpcData.length) {
    const slot = rpcData[offset]
    const classHash = rpcData.readUInt32LE(offset + 1)
    const flags = rpcData[offset + 5]
    const bodyLen = rpcData.readUInt16LE(offset + 6)
    if (bodyLen > RECORD_MAX_BODY) return { records, trailing: rpcData.subarray(offset) }
    const bodyStart = offset + RECORD_HEADER_LENGTH
    if (bodyStart + bodyLen > rpcData.length) {
      return { records, trailing: rpcData.subarray(offset) }
    }
    records.push({
      slot,
      classHash,
      flags,
      bodyLen,
      body: rpcData.subarray(bodyStart, bodyStart + bodyLen),
      // absolute offsets into the original buffer, so a patched body can be
      // spliced back without re-serialising anything else
      recordStart: offset,
      bodyStart
    })
    offset = bodyStart + bodyLen
  }
  return { records, trailing: offset < rpcData.length ? rpcData.subarray(offset) : null }
}

/** The 32-bit LE class hash of the gift MetaClass (bytes b3 b9 d9 20). */
export const GIFT_CLASS_HASH = 0x20d9b9b3

export { GIFT_CLASS_HASH as classIdKey }

/**
 * First-record summary for logging (RpcTap). Returns the leading record's
 * routing fields, or null when the buffer doesn't parse as records.
 * `sender`/`receiver` legacy fields map to slot/flags for log continuity.
 */
export function decodeNetRpcHeader (rpcData) {
  const parsed = decodeNetRpcRecords(rpcData)
  if (!parsed || parsed.records.length === 0) return null
  const first = parsed.records[0]
  return {
    classIdKey: first.classHash.toString(16).padStart(8, '0'),
    sender: first.slot,
    receiver: first.flags,
    typeFlag: first.flags,
    bodyLen: first.bodyLen,
    recordCount: parsed.records.length
  }
}
