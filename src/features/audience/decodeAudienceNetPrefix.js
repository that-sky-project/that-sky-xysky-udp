import { BinaryReader } from '../../protocol/binary/BinaryReader.js'

// Independently verified 0.35.1 C->S PlayerState prefix. IDA 1C68038:
// bounded kind -> three aligned f32 -> net (1A81604), without a preceding
// header or kind/platform conditional. This deliberately does not parse tail.
export function decodeAudienceNetPrefix (rawState) {
  if (!Buffer.isBuffer(rawState) || rawState.length < 25) return null
  try {
    const reader = new BinaryReader(rawState)
    const stateKind = reader.readBounded(0, 4)
    const position = [reader.readFloat(), reader.readFloat(), reader.readFloat()]
    if (!position.every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) return null
    const net = {
      offset_4: reader.readUInt16(),
      modeBytes: [reader.readUInt8(), reader.readUInt8()],
      offset_8: reader.readBounded(0, 256),
      offset_a: reader.readUInt8(),
      offset_c: reader.readUInt32(),
      offset_0: reader.readBounded(0, 3),
      flags: [reader.readBool(), reader.readBool()]
    }
    if (net.modeBytes[0] > 7 || net.modeBytes[1] > 15) return null
    return { version: 'sky-0.35.1-net-prefix', parsed: true, fields: { stateKind, position, net } }
  } catch { return null }
}
