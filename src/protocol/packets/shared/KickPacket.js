import { PacketIds } from '../../PacketIds.js';

export class KickPacket {
  static id = PacketIds.Kick;
  static name = 'KickPacket';

  static decode(reader) {
    const length = reader.readUInt32();
    const data = reader.readBytes(length);
    return { reason: data.toString('utf8') };
  }

  static encode(writer, packet) {
    const reason = packet.reason ?? '';
    const data = Buffer.from(String(reason), 'utf8').subarray(0, 256);
    writer.writeUInt32(data.length);
    writer.writeBytes(data);
  }
}
