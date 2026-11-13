// NetRpc wire format — reconciled from THREE evidence sources:
//
// 1. Production live capture (2026-11-12): client rpcData chains perfectly as
//    [classHash u32 LE][flags u8][bodyLen u16 LE][body] with NO slot byte —
//    e.g. the 12-byte packet be6718d7 00 0500 9c6d18af02 (hash 0xd71867be,
//    len 5, consumes exactly) and the 880-byte 110-record chat stream.
// 2. Official-server dump (packetdump_20260913131425): gift/chat records show
//    ONE extra byte before the class hash (1d/1f/83 = source player id the
//    relayed record carries). Same bytes parse as slot-prefixed records that
//    also consume exactly.
// 3. Client asm sub_1A692A8: key = u32 + u8 + bounded-u16 — the hash/flags/
//    len triple, with the id field coming from the GameMsg envelope.
//
// Reconciliation: the stream is a chain of records; SOME streams (relayed /
// certain classes) prefix records with a 1-byte source-player id. Rather than
// guessing, the parser is SELF-SYNCING: it tries the no-slot chain first and
// accepts it when the chain consumes the buffer exactly; otherwise it retries
// with a slot byte per record; otherwise it gives up and the caller passes
// the payload through untouched. Gift matching runs on whichever records
// were recovered — the class hash identifies the gift record wherever it is.

export const RECORD_HEADER_LENGTH = 8 // slot(1) + classHash(4) + flags(1) + bodyLen(2)
export const RECORD_HEADER_LENGTH_NO_SLOT = 7 // classHash(4) + flags(1) + bodyLen(2)
export const RECORD_MAX_BODY = 0x1000

function chainParse (rpcData, slotWidth) {
  const records = []
  let offset = 0
  const headerLen = slotWidth === 1 ? RECORD_HEADER_LENGTH : RECORD_HEADER_LENGTH_NO_SLOT
  while (offset + headerLen <= rpcData.length) {
    let cursor = offset
    let slot = null
    if (slotWidth === 1) {
      slot = rpcData[cursor]
      cursor += 1
    }
    const classHash = rpcData.readUInt32LE(cursor)
    const flags = rpcData[cursor + 4]
    const bodyLen = rpcData.readUInt16LE(cursor + 5)
    if (bodyLen > RECORD_MAX_BODY) return null
    const bodyStart = cursor + 7
    if (bodyStart + bodyLen > rpcData.length) return null
    records.push({
      slot,
      classHash,
      flags,
      bodyLen,
      body: rpcData.subarray(bodyStart, bodyStart + bodyLen),
      recordStart: offset,
      bodyStart,
      // offset of the bodyLen field within the record (for splicing a
      // resized body back into the wire): slot framing puts it at +6,
      // no-slot framing at +5.
      lenOffset: offset + headerLen - 2
    })
    offset = bodyStart + bodyLen
  }
  if (offset !== rpcData.length) return null // must consume exactly
  return records
}

/**
 * Parse rpcData into records, self-syncing the framing:
 * 1. no-slot chain ([hash][flags][len][body] per record) — live client format
 * 2. slot chain ([slot][hash][flags][len][body]) — official relayed format
 * Returns { records, framing } or null when neither consumes exactly.
 */
export function decodeNetRpcRecords (rpcData) {
  if (!Buffer.isBuffer(rpcData)) return null
  if (rpcData.length === 0) return { records: [], framing: 'empty' }
  const noSlot = chainParse(rpcData, 0)
  if (noSlot) return { records: noSlot, framing: 'no-slot' }
  const withSlot = chainParse(rpcData, 1)
  if (withSlot) return { records: withSlot, framing: 'slot' }
  return null
}

/** The 32-bit LE class hash of the gift MetaClass (bytes b3 b9 d9 20). */
export const GIFT_CLASS_HASH = 0x20d9b9b3

/**
 * First-record summary for logging (RpcTap). Returns the leading record's
 * routing fields, or null when the buffer doesn't parse as records.
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
    recordCount: parsed.records.length,
    framing: parsed.framing
  }
}
