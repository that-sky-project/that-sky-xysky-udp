import { PacketIds } from '../../PacketIds.js';
import { NetAddress } from '../../types/NetAddress.js';
import { TgcUuid } from '../../types/TgcUuid.js';
import { ProtocolError } from '../../../errors.js';

const MAX_MOVE_PLAYERS = 7;

export class MoveGamePacket {
  static id = PacketIds.MoveGame;
  static name = 'MoveGamePacket';

  static encode(writer, packet) {
    const rawBytes32 = Buffer.from(packet.rawBytes32 ?? Buffer.alloc(32));
    if (rawBytes32.length !== 32) {
      throw new ProtocolError('MoveGame prefix must be 32 bytes', { length: rawBytes32.length });
    }
    writer.writeBytes(rawBytes32);

    const address = packet.address instanceof NetAddress
      ? packet.address
      : new NetAddress(packet.address);
    address.encode(writer);
    writer.writeUInt64(packet.moveNonce ?? packet.unknownLong ?? 0n);
    writer.writeUInt8(packet.splitType ?? packet.flags ?? 0);
    const players = packet.players ?? [];
    if (players.length > MAX_MOVE_PLAYERS) {
      throw new ProtocolError('MoveGame player list too large', { count: players.length, max: MAX_MOVE_PLAYERS });
    }
    writer.writeUInt32(players.length);

    for (const player of players) {
      const uuid = player instanceof TgcUuid ? player : player?.uuid;
      (uuid instanceof TgcUuid ? uuid : new TgcUuid(uuid)).encode(writer);
    }

    writer.writeUInt32(packet.u32Field ?? 0);
    writer.writeUInt8(packet.u08Field ?? 0);
  
    writer.writeUInt32(packet.u32Field2 ?? 0xFFFFFFFF);
    writer.writeBool(packet.isSplit);

    const rawDest = packet.destinationUuid;
    const destUuid = rawDest instanceof TgcUuid ? rawDest : new TgcUuid(rawDest != null ? rawDest : Buffer.alloc(16));
    destUuid.encode(writer);
  }

  static decode(reader) {
    const rawBytes32 = reader.readBytes(32);

    const address = NetAddress.decode(reader);
    const moveNonce = reader.readUInt64();
    const splitType = reader.readUInt8();
    const playerCount = reader.readUInt32();
    if (playerCount > MAX_MOVE_PLAYERS) {
      throw new ProtocolError('MoveGame player list too large', { playerCount, max: MAX_MOVE_PLAYERS });
    }
    const players = [];
    for (let i = 0; i < playerCount; i++) {
      players.push(TgcUuid.decode(reader));
    }

    const u32Field = reader.readUInt32();
    const u08Field = reader.readUInt8();
    const u32Field2 = reader.readUInt32();
    const isSplit = reader.readBool();
    const destinationUuid = TgcUuid.decode(reader);

    return {
      rawBytes32,
      address,
      moveNonce,
      splitType,
      players,
      u32Field,
      u08Field,
      u32Field2,
      isSplit,
      destinationUuid
    };
  }
}
