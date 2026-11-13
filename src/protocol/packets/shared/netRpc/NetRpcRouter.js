import { decodeNetRpcRecords, GIFT_CLASS_HASH } from './NetRpcCodec.js'
import { GiftTypeFlag, patchGiftReceiverUuidInBody } from './handlers/giftHandler.js'

/**
 * Routes NetRpc records by class hash + flags byte.
 *
 * Handlers run per record and may return a replacement BODY (Buffer). The
 * router splices patched bodies back into the exact original wire bytes —
 * every unhandled record stays byte-identical.
 */
export class NetRpcRouter {
  constructor () {
    // key `${classHash}:${flags}` -> Map(flagOrStar -> handler)
    this._handlers = new Map()
  }

  register (classHash, flags, handler) {
    const key = `${classHash}:${flags ?? '*'}`
    if (!this._handlers.has(key)) this._handlers.set(key, new Map())
    this._handlers.get(key).set(flags ?? '*', handler)
    return this
  }

  process (rpcData, context) {
    const parsed = decodeNetRpcRecords(rpcData)
    if (!parsed || parsed.records.length === 0) return rpcData

    const patches = []
    for (const record of parsed.records) {
      const typemap =
        this._handlers.get(`${record.classHash}:${record.flags}`) ??
        this._handlers.get(`${record.classHash}:*`)
      if (!typemap) continue
      const handler = typemap.get(record.flags) ?? typemap.get('*')
      if (!handler) continue
      let newBody
      try {
        newBody = handler(record, context)
      } catch (error) {
        // A failing handler must never take the whole NetRpc packet down —
        // the record stays byte-identical and the caller relays it as-is.
        context?.logger?.warn?.(
          { classHash: record.classHash.toString(16), flags: record.flags,
            bodyLen: record.bodyLen, err: error?.message ?? String(error) },
          'netrpc handler failed; relaying record untouched'
        )
        continue
      }
      if (newBody && Buffer.isBuffer(newBody) && !newBody.equals(record.body)) {
        patches.push({ record, newBody })
      }
    }
    if (patches.length === 0) return rpcData

    // splice patched bodies into the original bytes
    const parts = []
    let cursor = 0
    for (const { record, newBody } of patches) {
      // everything before this record stays untouched
      parts.push(rpcData.subarray(cursor, record.recordStart))
      const header = Buffer.from(rpcData.subarray(record.recordStart, record.bodyStart))
      // the bodyLen field sits at record.lenOffset (6 with a slot byte, 5
      // without — writing at a fixed 6 overran the no-slot header).
      header.writeUInt16LE(newBody.length, record.lenOffset)
      parts.push(header, newBody)
      cursor = record.bodyStart + record.bodyLen
    }
    parts.push(rpcData.subarray(cursor))
    return Buffer.concat(parts)
  }
}

export function createNetRpcRouter () {
  const router = new NetRpcRouter()

  // Gift: the record flags byte is 0x00 on every captured gift packet — the
  // offer/accept/complete/cancel distinction lives inside the BODY at
  // body[2]. On accept the SERVER decides who receives the gift: inject the
  // accepting player's own uuid over whatever the client wrote
  // (anti-forgery). Capture-verified: the signed receiver uuid sits at body
  // offset 11 (7/7 official accepts v4-valid there, 0/7 at 10 and 12) — in
  // no-slot framing the same bytes are rpcData[18..34], the offset the
  // reference server patches.
  router.register(GIFT_CLASS_HASH, 0x00, (record, { source, logger }) => {
    if (record.body[2] !== GiftTypeFlag.Accept) return null
    const uuid = source?.uuid?.bytes
    if (!uuid) {
      logger?.debug({ playerId: source?.id }, 'gift accept: source has no uuid, skipping injection')
      return null
    }
    const patched = patchGiftReceiverUuidInBody(record.body, uuid)
    logger?.debug(
      { playerId: source.id, uuid: source.uuid.toString(), bodyLen: record.body.length },
      'gift replace ok (capture-format router)'
    )
    return patched
  })

  return router
}
