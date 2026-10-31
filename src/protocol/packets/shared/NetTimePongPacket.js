import { PacketIds } from '../../PacketIds.js';

/**
 * kNetMsg_NetTimePong (13)
 *
 *   [requestId: u16]
 *   [serverTime: f64]     Unix seconds; the client uses this as its clock base
 *   [reserved: u32]       always 0 in the live capture
 *   [scalar: f32]         ~1.30-1.56, varies per reply; treated as opaque
 *
 */
export class NetTimePongPacket {
  static id = PacketIds.NetTimePong;
  static name = 'NetTimePongPacket';

  static decode(reader) {
    return {
      requestId: reader.readUInt16(),
      serverTime: reader.readDouble(),
      reserved: reader.readUInt32(),
      scalar: reader.readFloat()
    };
  }

  static encode(writer, packet) {
    writer.writeUInt16(packet.requestId ?? 0);
    writer.writeDouble(packet.serverTime ?? 0);
    writer.writeUInt32(packet.reserved ?? 0);
    writer.writeFloat(packet.scalar ?? 0);
  }
}
