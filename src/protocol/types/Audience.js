export const AUDIENCE_MAX_ENTITY = 10203
export const AUDIENCE_MAX_ENTITY_INDEX = 10143
export const AUDIENCE_ROOM_MEMBER_LIMIT = 8
export const AUDIENCE_PRESENCE_LIMIT = 100
export const AUDIENCE_ENTITY_FULL_BYTES = 576
export const AUDIENCE_ENTITY_LIGHT_BYTES = 112
export const AUDIENCE_UPDATE_TOLERANCE_MS = 5000
export const AUDIENCE_HISTORY_SLOTS = 3
export const AudienceEntityFlags = Object.freeze({
  Interpolating: 0x0001,
  FlagBit4: 0x0010,
  NotInRoom: 0x0040,
  InRoom: 0x1000,
  FlagBit13: 0x2000,
  FlagBit14: 0x4000,
  Default: 0x8040
})
export const AudiencePacketId = Object.freeze({
  Audience: 18,
  AudienceRoomIds: 22,
  AudienceReliableData: 23,
  SocialBroadcastDown: 24,
  AudienceConsensus: 25,
  AudienceChatDownReliable: 26,
  AudienceChatDownUnreliable: 27,
  AudienceStreamInfo: 28,
  AudienceSpotlightResponse: 29,
  AudienceFeatureFlags: 32,
  PresenceMatches: 33
})
export const AudienceChatEntityId = Object.freeze({
  SetFloatParam: 10144,
  ClearBroadcast: 10145
})
export const AudienceGameMsgType = Object.freeze({
  Hint: 19,
  SocialBroadcast: 20,
  ConsensusVote: 21,
  Chat: 22,
  SpotlightRequest: 24
})
export function encodeFloat16 (value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num === 0) return 0
  const buf = new ArrayBuffer(4)
  new Float32Array(buf)[0] = num
  const bits = new Uint32Array(buf)[0] >>> 0
  const sign = (bits >>> 16) & 0x8000
  const exp32 = (bits >>> 23) & 0xff
  if (exp32 === 0) return sign
  if (exp32 > 0x8e) return sign | 0x7c00
  if (exp32 < 0x71) return sign
  return (((exp32 << 10) + 0x4000) | ((bits >>> 13) & 0x3ff) | sign) & 0xffff
}
export function decodeFloat16 (bits) {
  const v = Number(bits) & 0xffff
  const exponent = (v >>> 10) & 0x1f
  if (exponent === 0) return v & 0x8000 ? -0 : 0
  const sign = (v & 0x8000) << 16
  const mantissa = v & 0x3ff
  const float32Bits = (((exponent + 112) << 23) | (mantissa << 13) | sign) >>> 0
  const buf = new ArrayBuffer(4)
  new Uint32Array(buf)[0] = float32Bits
  return new Float32Array(buf)[0]
}
export function writeAudienceActive (writer, active) {
  writer.writeBool(active !== false)
}
export function readAudienceActive (reader) {
  return reader.readBool()
}
export function writeAudienceEntity (writer, entity) {
  const hasData = entity.hasData !== false
  writer.writeBool(hasData)
  if (!hasData) return
  writer.writeBool(entity.inThisRoom === true)
  writer.writeCompressed(entity.flag7 ?? 0, 7)
  const type = entity.type ?? 0
  writer.writeCompressed(type, 15)
  if ((type & 0xfe) === 0x0e) {
    writer.writeCompressed(entity.extraVal ?? 0, 0x100)
  }
}
export function readAudienceEntity (reader) {
  const hasData = reader.readBool()
  const entity = { hasData }
  if (!hasData) return entity
  entity.inThisRoom = reader.readBool()
  entity.flag7 = reader.readCompressed(7)
  entity.type = reader.readCompressed(15)
  if ((entity.type & 0xfe) === 0x0e) {
    entity.extraVal = reader.readCompressed(0x100)
  }
  return entity
}
export function writeAudienceEntityExtra (writer, entity) {
  const hasExtra = entity.extra != null
  writer.writeBool(hasExtra)
  if (!hasExtra) return
  writer.writeBounded(entity.extra, 1, 31)
}
export function readAudienceEntityExtra (reader) {
  const hasExtra = reader.readBool()
  if (!hasExtra) return { hasExtra: false }
  return { hasExtra: true, extra: reader.readBounded(1, 31) }
}
export function writeAudiencePosition (writer, position, origin) {
  const o = origin ?? [0, 0, 0]
  const p = position ?? [0, 0, 0]
  writer.writeUInt16(encodeFloat16(p[0] - o[0]))
  writer.writeUInt16(encodeFloat16(p[1] - o[1]))
  writer.writeUInt16(encodeFloat16(p[2] - o[2]))
}
export function readAudiencePosition (reader, origin) {
  const o = origin ?? [0, 0, 0]
  return [
    decodeFloat16(reader.readUInt16()) + o[0],
    decodeFloat16(reader.readUInt16()) + o[1],
    decodeFloat16(reader.readUInt16()) + o[2]
  ]
}
export function writeAudienceEntityIndex (writer, index) {
  writer.writeCompressed(index, AUDIENCE_MAX_ENTITY_INDEX)
}
export function readAudienceEntityIndex (reader) {
  return reader.readCompressed(AUDIENCE_MAX_ENTITY_INDEX)
}
