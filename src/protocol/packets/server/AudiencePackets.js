import { BinaryReader } from '../../binary/BinaryReader.js'
import { BinaryWriter } from '../../binary/BinaryWriter.js'
import {
  AudiencePacketId,
  AudienceChatEntityId,
  AUDIENCE_MAX_ENTITY_INDEX,
  AUDIENCE_MAX_ENTITY,
  AUDIENCE_ROOM_MEMBER_LIMIT,
  AUDIENCE_PRESENCE_LIMIT,
  readAudienceActive,
  writeAudienceActive,
  readAudienceEntity,
  writeAudienceEntity,
  readAudienceEntityExtra,
  writeAudienceEntityExtra,
  readAudiencePosition,
  writeAudiencePosition
} from '../../types/Audience.js'
const ENTITY_INDEX_MAX = AUDIENCE_MAX_ENTITY_INDEX
// StreamInfo index fields are signed-bounded [-1, 10203] on the wire
// (sub_1A81EC4 via sub_2955448); 10203 = the entity-slot ceiling, one above
// the 10143 room-member ceiling.
const STREAM_INFO_INDEX_MAX = 10203
const ROOM_MEMBER_MAX = AUDIENCE_ROOM_MEMBER_LIMIT
const ROOM_IDS_TAIL_BITS = 5
const ROOM_IDS_TAIL_MAX = 0x1f
const ROOM_IDS_TAIL = 9
const ENTITY_INDEX_BITS = 32 - Math.clz32(AUDIENCE_MAX_ENTITY_INDEX)
export class AudiencePacket {
  static id = AudiencePacketId.Audience
  static name = 'AudiencePacket'
  static decode (reader) {
    const idxStart = reader.readCompressed(ENTITY_INDEX_MAX)
    const idxEnd = reader.readCompressed(ENTITY_INDEX_MAX)
    const levelTime = reader.readDouble()
    const origin = [reader.readFloat(), reader.readFloat(), reader.readFloat()]
    const count = Math.max(0, idxEnd - idxStart + 1)
    const entities = []
    for (let i = 0; i < count; i += 1)
      entities.push({ active: readAudienceActive(reader) })
    for (const entity of entities) {
      if (!entity.active) continue
      Object.assign(entity, readAudienceEntity(reader))
    }
    for (const entity of entities) {
      if (!entity.active) continue
      Object.assign(entity, readAudienceEntityExtra(reader))
    }
    for (const entity of entities) {
      if (!entity.active) continue
      entity.position = readAudiencePosition(reader, origin)
    }
    return { idxStart, idxEnd, levelTime, origin, entities }
  }
  static encode (writer, packet) {
    const entities = packet.entities ?? []
    const idxStart = packet.idxStart ?? 0
    const idxEnd = packet.idxEnd ?? idxStart + entities.length - 1
    writer.writeCompressed(idxStart, ENTITY_INDEX_MAX)
    writer.writeCompressed(idxEnd, ENTITY_INDEX_MAX)
    writer.writeDouble(packet.levelTime ?? 0)
    const origin = packet.origin ?? [0, 0, 0]
    writer.writeFloat(origin[0] ?? 0)
    writer.writeFloat(origin[1] ?? 0)
    writer.writeFloat(origin[2] ?? 0)
    for (const entity of entities) writeAudienceActive(writer, entity.active)
    for (const entity of entities) {
      if (entity.active !== false) writeAudienceEntity(writer, entity)
    }
    for (const entity of entities) {
      if (entity.active !== false) writeAudienceEntityExtra(writer, entity)
    }
    for (const entity of entities) {
      if (entity.active !== false)
        writeAudiencePosition(writer, entity.position, origin)
    }
  }
}
export class AudienceRoomIdsPacket {
  static id = AudiencePacketId.AudienceRoomIds
  static name = 'AudienceRoomIdsPacket'
  static decode (reader) {
    const count = reader.readCompressed(ROOM_MEMBER_MAX)
    const indices = []
    for (let i = 0; i < count; i += 1)
      indices.push(reader.readCompressed(ENTITY_INDEX_MAX))
    const tail =
      reader.remainingBits >= ROOM_IDS_TAIL_BITS
        ? reader.readBits(ROOM_IDS_TAIL_BITS)
        : 0
    return { count, indices, tail }
  }
  static encode (writer, packet) {
    const indices = (packet.indices ?? []).slice(0, ROOM_MEMBER_MAX)
    writer.writeCompressed(indices.length, ROOM_MEMBER_MAX)
    for (const index of indices) writer.writeCompressed(index, ENTITY_INDEX_MAX)
    writer.writeBits(
      Math.min(packet.tail ?? ROOM_IDS_TAIL, ROOM_IDS_TAIL_MAX),
      ROOM_IDS_TAIL_BITS
    )
  }
}
export class AudienceReliableDataPacket {
  static id = AudiencePacketId.AudienceReliableData
  static name = 'AudienceReliableDataPacket'
  static decode (reader) {
    const count = reader.readBits(8)
    const entries = []
    for (let i = 0; i < count; i += 1) {
      const entityIdx = reader.readBits(ENTITY_INDEX_BITS)
      entries.push({ entityIdx, profile: readAudienceProfile(reader, true) })
    }
    return { count, entries }
  }
  static encode (writer, packet) {
    if (Buffer.isBuffer(packet.raw) || packet.raw instanceof Uint8Array) {
      writer.writeBytes(Buffer.from(packet.raw))
      return
    }
    const entries = packet.entries ?? []
    writer.writeBits(Math.min(entries.length, 0xff), 8)
    for (const entry of entries) {
      writer.writeBits(entry.entityIdx ?? 0, ENTITY_INDEX_BITS)
      writeAudienceProfile(writer, entry.profile ?? {}, true)
    }
  }
}
export class SocialBroadcastDownPacket {
  static id = AudiencePacketId.SocialBroadcastDown
  static name = 'SocialBroadcastDownPacket'
  static decode (reader) {
    const sessionId = reader.readUInt64()
    const flags = reader.readUInt32()
    const time = reader.readDouble()
    const counter = reader.readUInt32()
    const length = reader.readUInt32()
    const json = reader.readBytes(Math.min(length, reader.remaining))
    return { sessionId, flags, time, counter, length, json }
  }
  static encode (writer, packet) {
    if (Buffer.isBuffer(packet.raw) || packet.raw instanceof Uint8Array) {
      writer.writeBytes(Buffer.from(packet.raw))
      return
    }
    const json = Buffer.isBuffer(packet.json)
      ? packet.json
      : Buffer.from(String(packet.json ?? ''), 'utf8')
    writer.writeUInt64(packet.sessionId ?? 0n)
    writer.writeUInt32(packet.flags ?? 0)
    writer.writeDouble(packet.time ?? 0)
    writer.writeUInt32(packet.counter ?? 0)
    writer.writeUInt32(packet.length ?? json.length)
    writer.writeBytes(json)
  }
}
export class AudienceConsensusPacket {
  static id = AudiencePacketId.AudienceConsensus
  static name = 'AudienceConsensusPacket'
  static decode (reader) {
    const start = reader.readDouble()
    const end = reader.readDouble()
    const flags = reader.readUInt16() & 0x1fff
    return { start, end, flags }
  }
  static encode (writer, packet) {
    if (Buffer.isBuffer(packet.raw) || packet.raw instanceof Uint8Array) {
      writer.writeBytes(Buffer.from(packet.raw))
      return
    }
    writer.writeDouble(packet.start ?? 0)
    writer.writeDouble(packet.end ?? 0)
    writer.writeUInt16((packet.flags ?? 0) & 0x1fff)
  }
}
export class AudienceChatDownPacket {
  constructor (reliable) {
    this.reliable = reliable
    this.id = reliable
      ? AudiencePacketId.AudienceChatDownReliable
      : AudiencePacketId.AudienceChatDownUnreliable
    this.name = reliable
      ? 'AudienceChatDownReliablePacket'
      : 'AudienceChatDownUnreliablePacket'
  }
  decode (reader) {
    const messages = []
    while (reader.remaining > 0) {
      const entityId = reader.readUInt16()
      const payload = readLengthPrefixedBytes(reader)
      messages.push({
        entityId,
        payload,
        control: entityId >= AudienceChatEntityId.SetFloatParam
      })
    }
    return { messages }
  }
  encode (writer, packet) {
    for (const message of packet.messages ?? []) {
      writer.writeUInt16(message.entityId ?? 0)
      writeLengthPrefixedBytes(writer, message.payload ?? Buffer.alloc(0))
    }
  }
}
export const AudienceChatDownReliablePacket = new AudienceChatDownPacket(true)
export const AudienceChatDownUnreliablePacket = new AudienceChatDownPacket(
  false
)
export class AudienceStreamInfoPacket {
  static id = AudiencePacketId.AudienceStreamInfo
  static name = 'AudienceStreamInfoPacket'
  // sub_1A81EC4 reads both index fields with the signed-bounded primitive
  // sub_2955448(-1, 10203): wire value = stored value + 1, bit width
  // ceil(log2(10203 - (-1) + 1)) = 14. The node used compressed(0..10143)
  // — same width, but off by one against the client's stored-value mapping.
  static #readIndex (reader) {
    const encoded = reader.readBits(
      Math.ceil(Math.log2(STREAM_INFO_INDEX_MAX + 2))
    )
    return encoded - 1
  }
  static #writeIndex (writer, value) {
    const stored = (Number.isInteger(value) ? value : 0) + 1
    const bits = Math.ceil(Math.log2(STREAM_INFO_INDEX_MAX + 2))
    if (stored < 0 || stored > STREAM_INFO_INDEX_MAX + 1) {
      throw new RangeError(`stream index ${value} outside [-1, ${STREAM_INFO_INDEX_MAX}]`)
    }
    writer.writeBits(stored, bits)
  }
  static decode (reader) {
    const startIdx = this.#readIndex(reader)
    const hasStart = reader.readBool()
    const endIdx = this.#readIndex(reader)
    const hasEnd = reader.readBool()
    const flags = [
      reader.readBool(),
      reader.readBool(),
      reader.readBool(),
      reader.readBool(),
      reader.readBool()
    ]
    const hasDetail = reader.readBool()
    const out = { startIdx, hasStart, endIdx, hasEnd, flags, hasDetail }
    if (hasDetail) {
      out.hasSession = reader.readBool()
      out.hasStage = reader.readBool()
      out.stage = out.hasStage ? reader.readUInt16() : 0
      out.hasStageEnd = reader.readBool()
      out.stageEnd = out.hasStageEnd ? reader.readUInt16() : 0xffff
      out.stageStart = reader.readUInt16()
      out.hasStartTime = reader.readBool()
      out.startTime = out.hasStartTime ? reader.readDouble() : 0
      if (out.hasSession) out.sessionId = reader.readUInt64()
    }
    out.trailing = [reader.readBool(), reader.readBool(), reader.readBool()]
    out.extra = reader.readBool() ? reader.readUInt32() : 0
    return out
  }
  static encode (writer, packet) {
    if (Buffer.isBuffer(packet.raw) || packet.raw instanceof Uint8Array) {
      writer.writeBytes(Buffer.from(packet.raw))
      return
    }
    this.#writeIndex(writer, packet.startIdx ?? 0)
    writer.writeBool(packet.hasStart === true)
    this.#writeIndex(writer, packet.endIdx ?? 0)
    writer.writeBool(packet.hasEnd === true)
    const flags = packet.flags ?? []
    for (let i = 0; i < 5; i += 1) writer.writeBool(flags[i] === true)
    writer.writeBool(packet.hasDetail === true)
    if (packet.hasDetail === true) {
      const hasSession = packet.hasSession === true
      writer.writeBool(hasSession)
      const hasStage = (packet.stage ?? 0) !== 0
      writer.writeBool(hasStage)
      if (hasStage) writer.writeUInt16(packet.stage)
      const hasStageEnd = (packet.stageEnd ?? 0xffff) !== 0xffff
      writer.writeBool(hasStageEnd)
      if (hasStageEnd) writer.writeUInt16(packet.stageEnd)
      writer.writeUInt16(packet.stageStart ?? 0)
      const hasStartTime = (packet.startTime ?? 0) !== 0
      writer.writeBool(hasStartTime)
      if (hasStartTime) writer.writeDouble(packet.startTime)
      if (hasSession) writer.writeUInt64(packet.sessionId ?? 0n)
    }
    const trailing = packet.trailing ?? []
    for (let i = 0; i < 3; i += 1) writer.writeBool(trailing[i] === true)
    const hasExtra = (packet.extra ?? 0) !== 0
    writer.writeBool(hasExtra)
    if (hasExtra) writer.writeUInt32(packet.extra)
  }
}
export class AudienceSpotlightResponsePacket {
  static id = AudiencePacketId.AudienceSpotlightResponse
  static name = 'AudienceSpotlightResponsePacket'
  static decode (reader) {
    // `sub_140E7F8D0` reads exactly two bools: [valid][value]. The old
    // `state` byte was a phantom field that misaligned the bitstream — with
    // state=2 the first bit read 0 and the client treated a release as a
    // rejected request, so a performer could never leave the stage.
    const valid = reader.readBool()
    const value = reader.readBool()
    return { valid, value, accepted: valid && value, released: valid && !value }
  }
  static encode (writer, packet) {
    writer.writeBool(true)
    writer.writeBool(packet.accepted === true)
  }
}
export class AudienceFeatureFlagsPacket {
  static id = AudiencePacketId.AudienceFeatureFlags
  static name = 'AudienceFeatureFlagsPacket'
  static decode (reader) {
    return {
      b0: reader.readBool(),
      b1: reader.readBool(),
      b2: reader.readBool(),
      b3: reader.readBool()
    }
  }
  static encode (writer, packet) {
    writer.writeBool(packet.b0 === true)
    writer.writeBool(packet.b1 === true)
    writer.writeBool(packet.b2 === true)
    writer.writeBool(packet.b3 === true)
  }
}
export class PresenceMatchesPacket {
  static id = AudiencePacketId.PresenceMatches
  static name = 'PresenceMatchesPacket'
  static decode (reader) {
    const count = reader.readCompressed(AUDIENCE_PRESENCE_LIMIT)
    const matches = []
    for (let i = 0; i < count; i += 1) {
      matches.push({
        playerIdHash: reader.readUInt64(),
        distance: reader.readQuantizedFloat(0, 1, 0, 8)
      })
    }
    return { count, matches }
  }
  static encode (writer, packet) {
    const matches = (packet.matches ?? []).slice(0, AUDIENCE_PRESENCE_LIMIT)
    writer.writeCompressed(matches.length, AUDIENCE_PRESENCE_LIMIT)
    for (const match of matches) {
      writer.writeUInt64(match.playerIdHash ?? 0n)
      writer.writeQuantizedFloat(match.distance ?? 0, 0, 1, 0, 8)
    }
  }
}
function writeLengthPrefixedBytes (writer, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value)
  writer.writeUInt32(buf.length)
  writer.writeBytes(buf)
}
function readLengthPrefixedBytes (reader) {
  const length = reader.readUInt32()
  return reader.readBytes(length)
}
function writeLengthPrefixedString (writer, value) {
  const buf = Buffer.from(String(value ?? ''), 'utf8')
  writer.writeUInt32(buf.length)
  writer.writeBytes(buf)
}
function readLengthPrefixedString (reader) {
  const length = reader.readUInt32()
  return reader.readBytes(length).toString('utf8')
}
function readBits64 (reader) {
  const low = reader.readBits(32)
  const high = reader.readBits(32)
  return high * 2 ** 32 + low
}
function writeBits64 (writer, value) {
  const numeric = Number(value) || 0
  writer.writeBits(numeric % 2 ** 32, 32)
  writer.writeBits(Math.floor(numeric / 2 ** 32) % 2 ** 32, 32)
}
export function readAudienceProfile (reader, hasId = true) {
  const profile = {}
  if (hasId) profile.f0 = reader.readAlignedBigUInt(8)
  profile.f12 = reader.readAlignedUInt(1)
  profile.f17 = reader.readAlignedUInt(1)
  profile.f18 = reader.readAlignedUInt(1)
  profile.f19 = reader.readAlignedUInt(1)
  profile.f23 = reader.readBits(1) === 1
  profile.f24 = reader.readBits(1) === 1
  profile.f20 = reader.readBits(1) === 1
  profile.f21 = reader.readBits(1) ? reader.readBits(6) : 0
  profile.f22 = reader.readBits(1) === 1
  profile.f14 = reader.readBits(1) ? reader.readAlignedUInt(2) : 0
  profile.f16 = reader.readBits(1) ? reader.readAlignedUInt(1) : 0
  profile.f25 = reader.readBits(1) ? reader.readAlignedUInt(1) : 0
  profile.name = readAudienceString(reader)
  profile.f8 = reader.readBits(1) ? reader.readAlignedUInt(4) : 0
  profile.f58 = reader.readBits(1) === 1
  profile.f60 = reader.readBits(1) ? reader.readAlignedUInt(2) : 0
  profile.f62 = reader.readBits(4)
  profile.f64 = reader.readAlignedUInt(4)
  profile.f68 = reader.readBits(2)
  profile.f70 = reader.readBits(1) ? reader.readAlignedUInt(2) : 0
  return profile
}
export function writeAudienceProfile (writer, profile, hasId = true) {
  if (hasId) writer.writeAlignedUInt(profile.f0 ?? 0n, 8)
  writer.writeAlignedUInt(profile.f12 ?? 0, 1)
  writer.writeAlignedUInt(profile.f17 ?? 0, 1)
  writer.writeAlignedUInt(profile.f18 ?? 0, 1)
  writer.writeAlignedUInt(profile.f19 ?? 0, 1)
  writer.writeBits(profile.f23 ? 1 : 0, 1)
  writer.writeBits(profile.f24 ? 1 : 0, 1)
  writer.writeBits(profile.f20 ? 1 : 0, 1)
  writer.writeBits((profile.f21 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f21 ?? 0) !== 0) writer.writeBits(profile.f21, 6)
  writer.writeBits(profile.f22 ? 1 : 0, 1)
  writer.writeBits((profile.f14 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f14 ?? 0) !== 0) writer.writeAlignedUInt(profile.f14, 2)
  writer.writeBits((profile.f16 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f16 ?? 0) !== 0) writer.writeAlignedUInt(profile.f16, 1)
  writer.writeBits((profile.f25 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f25 ?? 0) !== 0) writer.writeAlignedUInt(profile.f25, 1)
  writeAudienceString(writer, profile.name ?? null)
  writer.writeBits((profile.f8 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f8 ?? 0) !== 0) writer.writeAlignedUInt(profile.f8, 4)
  writer.writeBits(profile.f58 ? 1 : 0, 1)
  writer.writeBits((profile.f60 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f60 ?? 0) !== 0) writer.writeAlignedUInt(profile.f60, 2)
  writer.writeBits(profile.f62 ?? 0, 4)
  writer.writeAlignedUInt(profile.f64 ?? 0, 4)
  writer.writeBits(profile.f68 ?? 0, 2)
  writer.writeBits((profile.f70 ?? 0) !== 0 ? 1 : 0, 1)
  if ((profile.f70 ?? 0) !== 0) writer.writeAlignedUInt(profile.f70, 2)
}
export function readAudienceString (reader) {
  const differs = reader.readBits(1) === 1
  if (!differs) return null
  const length = reader.readBits(32)
  let text = ''
  for (let i = 0; i < length; i += 1)
    text += String.fromCharCode(reader.readBits(8))
  return text
}
export function writeAudienceString (writer, value) {
  const present = typeof value === 'string' && value.length > 0
  writer.writeBits(present ? 1 : 0, 1)
  if (!present) return
  const text = value.slice(0, 0x1f)
  writer.writeBits(text.length, 32)
  for (const ch of text) writer.writeBits(ch.charCodeAt(0) & 0xff, 8)
}
export const audienceServerPackets = new Map([
  [AudiencePacketId.Audience, AudiencePacket],
  [AudiencePacketId.AudienceRoomIds, AudienceRoomIdsPacket],
  [AudiencePacketId.AudienceReliableData, AudienceReliableDataPacket],
  [AudiencePacketId.SocialBroadcastDown, SocialBroadcastDownPacket],
  [AudiencePacketId.AudienceConsensus, AudienceConsensusPacket],
  [AudiencePacketId.AudienceChatDownReliable, AudienceChatDownReliablePacket],
  [
    AudiencePacketId.AudienceChatDownUnreliable,
    AudienceChatDownUnreliablePacket
  ],
  [AudiencePacketId.AudienceStreamInfo, AudienceStreamInfoPacket],
  [AudiencePacketId.AudienceSpotlightResponse, AudienceSpotlightResponsePacket],
  [AudiencePacketId.AudienceFeatureFlags, AudienceFeatureFlagsPacket],
  [AudiencePacketId.PresenceMatches, PresenceMatchesPacket]
])
export { BinaryReader, BinaryWriter }
