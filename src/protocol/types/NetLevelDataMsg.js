import { BinaryReader } from '../binary/BinaryReader.js'
import { BinaryWriter } from '../binary/BinaryWriter.js'
import { NET_LEVEL_DATA_MAX_BYTES } from '../snapshot/constants.js'
import { ProtocolError } from '../../errors.js'

// sub_1A80EA8 serializes the decompressed message, not its Snapshot frame.
// [player u8][levelId u32][authorityVersion u16][hasData bit + pad]
// [NetLevelData...]. Official empty Elect messages are exactly 22 bytes.
export const NET_LEVEL_DATA_HEADER_BYTES = 22

function unsignedField (name, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ProtocolError(`invalid NetLevelData ${name}`, { value, max })
  }
}

export function decodeNetLevelDataMsg (buffer, options = {}) {
  const reader = buffer instanceof BinaryReader ? buffer : new BinaryReader(buffer)
  const { skipHeaderBytes = 0 } = options
  unsignedField('skipHeaderBytes', skipHeaderBytes, NET_LEVEL_DATA_MAX_BYTES)
  if (skipHeaderBytes > 0) reader.skip(skipHeaderBytes)
  const electedPlayer = reader.readUInt8()
  const levelId = reader.readUInt32()
  const authorityVersion = reader.readUInt16()
  const hasInitialData = reader.readBool()
  reader.alignToByte()
  const netLevelData = readNetLevelData(reader, options)
  if (reader.remaining !== 0) {
    throw new ProtocolError('NetLevelData has trailing bytes', { trailingBytes: reader.remaining })
  }
  return { electedPlayer, levelId, authorityVersion, hasInitialData, ...netLevelData, trailingBytes: 0 }
}

export function encodeNetLevelDataMsg (packet) {
  const { electedPlayer = 0, levelId, authorityVersion = 0, hasInitialData = false } = packet
  if (packet.unknown0 !== undefined || packet.unknown1 !== undefined) {
    throw new ProtocolError('obsolete NetLevelData header fields')
  }
  unsignedField('electedPlayer', electedPlayer, 0xff)
  unsignedField('levelId', levelId, 0xffffffff)
  unsignedField('authorityVersion', authorityVersion, 0xffff)
  if (typeof hasInitialData !== 'boolean') throw new ProtocolError('invalid NetLevelData hasInitialData')
  const writer = new BinaryWriter(NET_LEVEL_DATA_HEADER_BYTES + (packet.levelData?.length ?? 0))
  writer.writeUInt8(electedPlayer)
  writer.writeUInt32(levelId)
  writer.writeUInt16(authorityVersion)
  writer.writeBool(hasInitialData)
  writeNetLevelData(writer, packet)
  return writer.toBuffer()
}

export function readNetLevelData (reader, options = {}) {
  const { maxDataBytes = NET_LEVEL_DATA_MAX_BYTES } = options
  const unknown2 = reader.readUInt16()
  const unknown3 = reader.readUInt8()
  const levelHash = reader.readUInt32()
  const mergeState = readNetLevelMergeState(reader)
  const unknown5 = reader.readUInt16()
  const unknown6 = reader.readUInt16()
  const dataLength = reader.readUInt16()
  if (dataLength > maxDataBytes) {
    throw new ProtocolError('level data too large', { dataLength, max: maxDataBytes })
  }
  const levelData = reader.readBytes(dataLength)
  return { unknown2, unknown3, levelHash, unknown4: levelHash, mergeState, unknown5, unknown6, dataLength, levelData }
}

export function writeNetLevelData (writer, {
  unknown2 = 0,
  unknown3 = 0,
  levelHash = 0,
  unknown4 = levelHash,
  unknown5 = 0,
  unknown6 = 0,
  mergeState = 0,
  dataLength,
  levelData = Buffer.alloc(0)
}) {
  if (!Buffer.isBuffer(levelData) && !(levelData instanceof Uint8Array)) {
    throw new ProtocolError('NetLevelData body must be bytes')
  }
  for (const [name, value, max] of [
    ['unknown2', unknown2, 0xffff], ['unknown3', unknown3, 0xff],
    ['levelHash', unknown4, 0xffffffff], ['mergeState', mergeState, 0xff],
    ['unknown5', unknown5, 0xffff], ['unknown6', unknown6, 0xffff]
  ]) unsignedField(name, value, max)
  const actualLength = levelData.length
  if (actualLength > NET_LEVEL_DATA_MAX_BYTES) {
    throw new ProtocolError('level data length exceeds latest NetLevelData limit', {
      dataLength: actualLength, max: NET_LEVEL_DATA_MAX_BYTES
    })
  }
  if (dataLength !== undefined && dataLength !== actualLength) {
    throw new ProtocolError('level data length mismatch', { dataLength, actualLength })
  }
  writer.writeUInt16(unknown2)
  writer.writeUInt8(unknown3)
  writer.writeUInt32(unknown4)
  writeNetLevelMergeState(writer, mergeState)
  writer.writeUInt16(unknown5)
  writer.writeUInt16(unknown6)
  writer.writeUInt16(actualLength)
  writer.writeBytes(levelData)
}

export function readNetLevelMergeState (reader) {
  return reader.readUInt8()
}

export function writeNetLevelMergeState (writer, mergeState = 0) {
  writer.writeUInt8(mergeState)
}
