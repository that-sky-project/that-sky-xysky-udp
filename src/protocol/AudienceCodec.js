import { BinaryReader } from './binary/BinaryReader.js';
import { BinaryWriter } from './binary/BinaryWriter.js';
import { audienceServerPackets } from './packets/server/AudiencePackets.js';
import { audienceRequestPayloads } from './packets/client/AudienceRequests.js';
import { ProtocolError } from '../errors.js';

export class AudienceCodec {
  /**
   * Encode a server→client audience packet.
   *
   * @param {object} packet `{ id, payload }` where `id` is an AudiencePacketId.
   */
  encode(packet) {
    const packetType = audienceServerPackets.get(packet.id);
    if (!packetType?.encode) {
      throw new ProtocolError('unknown audience packet', { id: packet.id });
    }

    const payloadWriter = new BinaryWriter();
    packetType.encode(payloadWriter, packet.payload ?? {});

    const payload = payloadWriter.toBuffer();
    if (payload.length > 0xffff) {
      throw new ProtocolError('audience packet payload too large', {
        id: packet.id,
        length: payload.length,
        max: 0xffff
      });
    }

    const writer = new BinaryWriter(3 + payload.length);
    writer.writeUInt8(packet.id);
    writer.writeUInt16(payload.length);
    writer.writeBytes(payload);
    return writer.toBuffer();
  }

  decode(id, buffer) {
    const packetType = audienceServerPackets.get(id);
    if (!packetType?.decode) {
      return {
        id,
        name: `Unknown${id}`,
        payload: { raw: new BinaryReader(buffer).readBytes(buffer.length) },
        unknown: true
      };
    }
    return {
      id,
      name: packetType.name,
      payload: packetType.decode(new BinaryReader(buffer), { fromServer: true })
    };
  }

  static encodeGameMsg({ gameMsgType, levelSeq = 0, sourcePlayer = 0, payload = Buffer.alloc(0) }) {
    const writer = new BinaryWriter(3 + payload.length);
    writer.writeUInt8(gameMsgType);
    writer.writeUInt8(levelSeq);
    writer.writeUInt8(sourcePlayer);
    writer.writeBytes(payload);
    return writer.toBuffer();
  }

  static decodeGameMsg(buffer) {
    const reader = new BinaryReader(buffer);
    return {
      gameMsgType: reader.readUInt8(),
      levelSeq: reader.readUInt8(),
      sourcePlayer: reader.readUInt8(),
      payload: reader.readBytes(reader.remaining)
    };
  }

  static encodeRequest({ gameMsgType, levelSeq = 0, sourcePlayer = 0, ...data }) {
    const schema = audienceRequestPayloads.get(gameMsgType);
    if (!schema) {
      throw new ProtocolError('unknown audience request type', { gameMsgType });
    }
    const payloadWriter = new BinaryWriter();
    schema.encode(payloadWriter, data);
    return AudienceCodec.encodeGameMsg({
      gameMsgType,
      levelSeq,
      sourcePlayer,
      payload: payloadWriter.toBuffer()
    });
  }

  static decodeRequest(buffer) {
    const frame = AudienceCodec.decodeGameMsg(buffer);
    const schema = audienceRequestPayloads.get(frame.gameMsgType);
    if (!schema) {
      return { ...frame, payload: frame.payload, unknown: true };
    }
    return {
      ...frame,
      payload: schema.decode(new BinaryReader(frame.payload))
    };
  }
}

export const audienceCodec = new AudienceCodec();
