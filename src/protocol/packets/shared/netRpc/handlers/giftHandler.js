// Gift RPC (MetaClass hash 0x20d9b9b3 — wire bytes b3 b9 d9 20, record flags byte 0x00)
//
// Record chain framing (see NetRpcCodec.js): live client traffic is no-slot
// ([classHash u32 LE][flags u8][bodyLen u16 LE][body]); official relayed
// traffic prefixes each record with a 1-byte slot. The BODY layout is
// framing-independent and is byte-verified from four sources:
//
//   * official packetdump_20260913131425: 7 accept records (flag=1), the
//     16-byte uuid is v4-valid ONLY at body[11..27] (0/7 at offsets 10/12);
//   * live session logs: the accept C2S carries the accepting player's own
//     uuid at body[11..27] (fe2ab94d-f211-451f-94ba-32ad9562597d);
//   * the annotated 36-byte capture: [0..2] slots, [2] type_flag,
//     [3..7] ability_id u32 LE, [7..11] item_count u32 LE, [11..27]
//     signed_receiver_uuid, [27..31] extra, [31..36] trailing;
//   * the reference server implementation patches no-slot rpcData[18..34]
//     == body[11..27].
//
// Official 72-byte DOWN relays additionally append a u32-prefixed 32-char
// ascii uuid after the base 36-byte body; the base layout above is unchanged.

export const GIFT_CLASS_HASH = 0x20d9b9b3

export const GiftTypeFlag = Object.freeze({
  Offer:    0,
  Accept:   1,
  Complete: 2,
  Cancel:   3
})

// body offset of the 16-byte signed receiver uuid
const RECEIVER_UUID_BODY_OFFSET = 11
const RECEIVER_UUID_LENGTH = 16

export function decodeGiftBody (body) {
  if (!Buffer.isBuffer(body) || body.length < RECEIVER_UUID_BODY_OFFSET + RECEIVER_UUID_LENGTH) {
    return null
  }
  return {
    typeFlag: body[2],
    abilityId: body.readUInt32LE(3),
    itemCount: body.readUInt32LE(7),
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

// Kept for callers thinking in rpcData offsets: in no-slot framing the body
// starts at rpcData+7, so body offset 11 == no-slot rpcData offset 18 — the
// same absolute offset the reference server patches.
export const RECEIVER_UUID_OFFSET = 18
