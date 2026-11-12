// Gift RPC (MetaClass hash 0x20d9b9b3 — wire bytes b3 b9 d9 20, flags 0x00)
//
// Capture-verified record layout (rpcData, GameMsg type 2):
//   [0]      slot        u8    associated player slot
//   [1..4]   classHash   u32   LE = 0x20d9b9b3
//   [5]      flags       u8    0x00 on every captured gift packet
//   [6..7]   bodyLen     u16   LE (<= 0x1000)
//   [8..]    body
//
// Gift body (from the official DOWN capture, 83-byte packet):
//   [0..1]   sender/receiver slots (1d 1f in the capture)
//   [2..3]   type/sequence pair (01 01 on accept)
//   [4..7]   ability/gift id u32 LE
//   [8..9]   short fields
//   [10..25] receiver uuid u8[16]  <- server injects the accepting player's
//            uuid here on ACCEPT; at rpcData offset 18, matching the old
//            flat-header offset, which is why live gifts kept working.
//   [26..]   trailing fields / optional name bytes

export const GIFT_CLASS_HASH = 0x20d9b9b3

export const GiftTypeFlag = Object.freeze({
  Offer:    0,
  Accept:   1,
  Complete: 2,
  Cancel:   3
})

// body offset of the 16-byte receiver uuid
const RECEIVER_UUID_BODY_OFFSET = 12
const RECEIVER_UUID_LENGTH = 16

export function decodeGiftBody (body) {
  if (!Buffer.isBuffer(body) || body.length < RECEIVER_UUID_BODY_OFFSET + RECEIVER_UUID_LENGTH) {
    return null
  }
  return {
    receiverUuid: body.subarray(
      RECEIVER_UUID_BODY_OFFSET,
      RECEIVER_UUID_BODY_OFFSET + RECEIVER_UUID_LENGTH
    )
  }
}

/**
 * Write the accepting player's uuid into the body's receiver field.
 * Returns a new Buffer; the original wire is never mutated.
 */
export function patchGiftReceiverUuidInBody (body, uuidBytes) {
  if (!Buffer.isBuffer(body) || body.length < RECEIVER_UUID_BODY_OFFSET + RECEIVER_UUID_LENGTH) {
    return null
  }
  const patched = Buffer.from(body)
  uuidBytes.copy(patched, RECEIVER_UUID_BODY_OFFSET)
  return patched
}

// Backwards-shaped alias kept for any caller still thinking in rpcData
// offsets: rpcData offset 18 == body offset 10 with the 8-byte record header.
export const RECEIVER_UUID_OFFSET = 18
