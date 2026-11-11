import { BinaryReader } from '../binary/BinaryReader.js'
import { BinaryWriter } from '../binary/BinaryWriter.js'
import { NET_LEVEL_DATA_MAX_BYTES } from '../snapshot/constants.js'
import { ProtocolError } from '../../errors.js'

/**
 * NetLevelData message — layout captured byte-exact from the official server
 * (packetdump_20261030203945, GameMsg type 11), verified by bit-level probe:
 * the levelId dword sits at bit 40 of the payload, i.e. after
 * [electedPlayer u8][unknown0 u8][unknown1 u16][hasInitialData 1 bit + pad].
 *
 * The previous implementation read [electedPlayer][levelId][unknown1]
 * [hasInitialData] — levelId landed three bytes early and silently became
 * 0x01000101 on every official packet, and re-encoding corrupted byte 8
 * (levelId's high byte was replaced with 0x00). That encoder feeds
 * syncLevelData and sendElect, so every new joiner received a corrupted
 * level id in their initial world state.
 */
export function decodeNetLevelDataMsg (buffer, options = {}) {
  const reader =
    buffer instanceof BinaryReader ? buffer : new BinaryReader(buffer)
  const { skipHeaderBytes = 0 } = options
  if (skipHeaderBytes > 0) {
    reader.skip(skipHeaderBytes)
  }
  const electedPlayer = reader.readUInt8()
  const unknown0 = reader.readUInt8()
  const unknown1 = reader.readUInt16()
  const hasInitialData = reader.readBool()
  reader.alignToByte()
  const levelId = reader.readUInt32()
  const netLevelData = readNetLevelData(reader, options)
  const remaining = reader.remaining
  return {
    electedPlayer,
    unknown0,
    unknown1,
    hasInitialData,
    levelId,
    ...netLevelData,
    trailingBytes: remaining
  }
}
export function encodeNetLevelDataMsg ({
  electedPlayer,
  levelId,
  levelData = Buffer.alloc(0),
  mergeState = 0,
  unknown0 = 1,
  unknown1 = 0,
  unknown2 = 0,
  unknown3 = 0,
  levelHash = 0,
  unknown4 = levelHash,
  unknown5 = 0,
  unknown6 = 0,
  hasInitialData = false
}) {
  if (levelData.length > NET_LEVEL_DATA_MAX_BYTES) {
    throw new ProtocolError('level data exceeds latest NetLevelData limit', {
      dataLength: levelData.length,
      max: NET_LEVEL_DATA_MAX_BYTES
    })
  }
  const writer = new BinaryWriter(64 + levelData.length)
  writer.writeUInt8(electedPlayer)
  writer.writeUInt8(unknown0)
  writer.writeUInt16(unknown1)
  writer.writeBool(hasInitialData)
  writer.writeUInt32(levelId)
  writer.writeUInt16(unknown2)
  writer.writeUInt8(unknown3)
  writer.writeUInt32(unknown4)
  writer.writeUInt8(mergeState)
  writer.writeUInt16(unknown5)
  writer.writeUInt16(unknown6)
  writer.writeUInt16(levelData.length)
  writer.writeBytes(levelData)
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
    throw new ProtocolError('level data too large', {
      dataLength,
      max: maxDataBytes
    })
  }
  const levelData =
    dataLength > 0 ? reader.readBytes(dataLength) : Buffer.alloc(0)
  return {
    unknown2,
    unknown3,
    levelHash,
    unknown4: levelHash,
    mergeState,
    unknown5,
    unknown6,
    dataLength,
    levelData
  }
}
export function writeNetLevelData (
  writer,
  {
    unknown2 = 0,
    unknown3 = 0,
    levelHash = 0,
    unknown4 = levelHash,
    mergeState = 0,
    unknown5 = 0,
    unknown6 = 0,
    dataLength,
    levelData = Buffer.alloc(0)
  }
) {
  writer.writeUInt16(unknown2)
  writer.writeUInt8(unknown3)
  writer.writeUInt32(unknown4)
  writeNetLevelMergeState(writer, mergeState)
  writer.writeUInt16(unknown5)
  writer.writeUInt16(unknown6)
  const actualLength = levelData.length
  if (actualLength > NET_LEVEL_DATA_MAX_BYTES) {
    throw new ProtocolError(
      'level data length exceeds latest NetLevelData limit',
      { dataLength: actualLength, max: NET_LEVEL_DATA_MAX_BYTES }
    )
  }
  if (dataLength !== undefined && dataLength !== actualLength) {
    throw new ProtocolError('level data length mismatch', {
      dataLength,
      actualLength
    })
  }
  writer.writeUInt16(actualLength)
  writer.writeBytes(levelData)
}
export function readNetLevelMergeState (reader) {
  return reader.readUInt8()
}
export function writeNetLevelMergeState (writer, mergeState = 0) {
  writer.writeUInt8(mergeState)
}
