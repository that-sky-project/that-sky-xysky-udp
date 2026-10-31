// Gift RPC (MetaClass ID: b3 b9 d9 20 00 24 00)
//
// Wire layout (rpcData):
//   [0..6]   class_id      u8[7]   fixed MetaClass identifier
//   [7]      sender_slot   u8
//   [8]      receiver_slot u8
//   [9]      type_flag     u8      0=offer 1=accept 2=complete 3=cancel
//   [10..13] ability_id    u32 LE
//   [14..17] item_count    u32 LE
//   [18..33] receiver_uuid u8[16]  injected by server on accept
//   [34..37] extra         u32 LE
//   [38..41] items         u32 LE
//   [42]     trailing      u8

export const GIFT_CLASS_ID = Buffer.from([0xb3, 0xb9, 0xd9, 0x20, 0x00, 0x24, 0x00]);

export const GiftTypeFlag = Object.freeze({
  Offer:    0,
  Accept:   1,
  Complete: 2,
  Cancel:   3
});

const RECEIVER_UUID_OFFSET = 18;
const RECEIVER_UUID_LENGTH = 16;
const MIN_GIFT_LENGTH = RECEIVER_UUID_OFFSET + RECEIVER_UUID_LENGTH;

export function decodeGiftRpc(rpcData) {
  if (!Buffer.isBuffer(rpcData) || rpcData.length < MIN_GIFT_LENGTH) {
    return null;
  }

  return {
    senderSlot:   rpcData[7],
    receiverSlot: rpcData[8],
    typeFlag:     rpcData[9],
    abilityId:    rpcData.readUInt32LE(10),
    itemCount:    rpcData.readUInt32LE(14),
    receiverUuid: rpcData.subarray(RECEIVER_UUID_OFFSET, RECEIVER_UUID_OFFSET + RECEIVER_UUID_LENGTH)
  };
}

export function patchGiftReceiverUuid(rpcData, uuidBytes) {
  const patched = Buffer.from(rpcData);
  uuidBytes.copy(patched, RECEIVER_UUID_OFFSET);
  return patched;
}
