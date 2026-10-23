import { PacketIds } from '../../PacketIds.js';
import { NetAddress } from '../../types/NetAddress.js';
import { TgcUuid } from '../../types/TgcUuid.js';
import { ProtocolError } from '../../../errors.js';

const MAX_MOVE_PLAYERS = 7;

export class MoveGamePacket {
  static id = PacketIds.MoveGame;
  static name = 'MoveGamePacket';

  // Wire format (Server→Client), reversed from sub_140e14630 + sub_140e18100:
  //   raw_bytes_32  u08[32]    — unknown 32-byte block at struct+0x4c
  //   move          Move       — serialized by sub_140e142d0
  //   u32_field     u32        — stored at struct+0x5c
  //   u08_field     u08        — stored at struct+0xbc
  //   u32_field2    u32        — stored at struct+0x60
  //   is_split      bool       — if true, triggers split-move flow on client
  //   destination_uuid u08[16] — destination room UUID at struct+0xc9
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
    // u32Field2 lands in the client's matchmaking reservation slot (state+420)
    // when the move is accepted. 0xFFFFFFFF means "no event reservation"; a
    // plain 0 here leaves the client in a phantom reservation state that makes
    // every later generic mm signal ("EventId 0") get rejected, deadlocking
    // reconnection until the next non-generic move.
    writer.writeUInt32(packet.u32Field2 ?? 0xFFFFFFFF);
    writer.writeBool(packet.isSplit);

    // destination_uuid identifies the destination room. Statically configured
    // move targets have no known uuid, so keep the legacy zeroed encoding there;
    // the QWD command path validates the room uuid before reaching this point.
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
