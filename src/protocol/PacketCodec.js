import { BinaryReader } from './binary/BinaryReader.js';
import { BinaryWriter } from './binary/BinaryWriter.js';
import { packetTypes } from './PacketRegistry.js';
import { ProtocolError } from '../errors.js';

export class PacketCodec {
  decodeClient(buffer) {
    const reader = new BinaryReader(buffer);
    const token = reader.readUInt32();
    const id = reader.readUInt8();
    const sequence = reader.readUInt8();
    const packetType = packetTypes.get(id);

    if (!packetType?.decode) {
      const raw = reader.remaining > 0 ? reader.readBytes(reader.remaining) : Buffer.alloc(0);
      return {
        id,
        name: `Unknown${id}`,
        token,
        sequence,
        payload: { raw, unknownId: id },
        unknown: true
      };
    }

    const payload = packetType.decode(reader, { fromServer: false });
    return {
      id,
      name: packetType.name,
      token,
      sequence,
      payload
    };
  }

  encodeServer(packet, session) {
    const packetType = packetTypes.get(packet.id);
    if (!packetType?.encode) {
      throw new ProtocolError('unknown server packet', { id: packet.id });
    }

    const payloadWriter = new BinaryWriter();
    packetType.encode(payloadWriter, packet.payload ?? {}, { fromServer: true });

    const payload = payloadWriter.toBuffer();
    if (payload.length > 0xffff) {
      throw new ProtocolError('server packet payload too large', {
        id: packet.id,
        length: payload.length,
        max: 0xffff
      });
    }

    // Application-layer S→C header: [packet_id: u08][payload_length: u16 LE]
    const writer = new BinaryWriter(3 + payload.length);
    writer.writeUInt8(packet.id);
    writer.writeUInt16(payload.length);
    writer.writeBytes(payload);
    return writer.toBuffer();
  }
}
