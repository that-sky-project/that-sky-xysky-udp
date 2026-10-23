import { PacketIds } from '../../PacketIds.js';
import { TgcUuid } from '../../types/TgcUuid.js';
import { NetVersion } from '../../types/NetVersion.js';
import { NetAddress } from '../../types/NetAddress.js';
import { ProtocolError } from '../../../errors.js';

const MAX_MOVE_PLAYERS = 7;
const MAX_LEVEL_DATA_BYTES = 0x2000;

function decodeMove(reader) {
  const address = NetAddress.decode(reader);
  const moveNonce = reader.readUInt64();
  const splitType = reader.readUInt8();
  const playerCount = reader.readUInt32();
  if (playerCount > MAX_MOVE_PLAYERS) {
    throw new ProtocolError('join move player list too large', { playerCount, max: MAX_MOVE_PLAYERS });
  }
  const players = Array.from({ length: playerCount }, () => TgcUuid.decode(reader));
  return { address, moveNonce, splitType, playerCount, players };
}

function encodeMove(writer, move = {}) {
  const address = move.address instanceof NetAddress ? move.address : new NetAddress(move.address);
  address.encode(writer);
  writer.writeUInt64(move.moveNonce ?? move.unknownLong ?? 0n);
  writer.writeUInt8(move.splitType ?? move.flags ?? 0);
  const players = move.players ?? [];
  if (players.length > MAX_MOVE_PLAYERS) {
    throw new ProtocolError('join move player list too large', { count: players.length, max: MAX_MOVE_PLAYERS });
  }
  writer.writeUInt32(players.length);
  for (const player of players) {
    const uuid = player instanceof TgcUuid ? player : player?.uuid;
    (uuid instanceof TgcUuid ? uuid : new TgcUuid(uuid)).encode(writer);
  }
}

export class JoinGamePacket {
  static id = PacketIds.JoinGame;
  static name = 'JoinGamePacket';

  static decode(reader) {
    const uuid = TgcUuid.decode(reader);
    const sessionUuid = TgcUuid.decode(reader);
    const sessionToken = reader.readBytes(32);
    const move = decodeMove(reader);
    const joinToken = reader.readUInt32();
    const joinState = reader.readUInt8();
    const joinFlags = reader.readUInt32();
    const joinSignature = reader.readBytes(16);
    const serverVersion = reader.readUInt16();
    const clientVersion = reader.readUInt16();
    const rpcHash = reader.readUInt32();
    const netVersion = NetVersion.decode(reader);
    const levelChangeCount = reader.readUInt8();
    const levelId = reader.readUInt32();
    const levelSummary = reader.readBytes(64);
    const localPlayerId = reader.readUInt32();
    const currentPlayerId = reader.readUInt32();
    const levelDataLength = reader.readUInt32();
    if (levelDataLength > MAX_LEVEL_DATA_BYTES) {
      throw new ProtocolError('join level data too large', { levelDataLength, max: MAX_LEVEL_DATA_BYTES });
    }
    const levelData = reader.readBytes(levelDataLength);
    const moving = reader.readBool();
    const hasTransferAddress = reader.readBool();
    const mergeState = reader.readCompressed(0xff);
    const transferAddress = NetAddress.decodeTyped(reader);
    const moveResult = reader.readUInt32();

    return {
      uuid, sessionUuid, sessionToken, move,
      joinToken, joinState, joinFlags, joinSignature,
      serverVersion, clientVersion, rpcHash, netVersion,
      levelChangeCount, levelId, levelSummary, levelState: levelSummary,
      localPlayerId, currentPlayerId, levelData,
      moving, hasTransferAddress, mergeState, mergeFlags: mergeState,
      transferAddress, moveResult
    };
  }

  static encode(writer, packet) {
    (packet.uuid instanceof TgcUuid ? packet.uuid : new TgcUuid(packet.uuid)).encode(writer);
    (packet.sessionUuid instanceof TgcUuid ? packet.sessionUuid : new TgcUuid(packet.sessionUuid)).encode(writer);
    const token = Buffer.from(packet.sessionToken ?? Buffer.alloc(32));
    if (token.length !== 32) throw new ProtocolError('session token must be 32 bytes', { length: token.length });
    writer.writeBytes(token);
    encodeMove(writer, packet.move);
    writer.writeUInt32(packet.joinToken ?? 0);
    writer.writeUInt8(packet.joinState ?? 0);
    writer.writeUInt32(packet.joinFlags ?? 0);
    const signature = Buffer.from(packet.joinSignature ?? Buffer.alloc(16));
    if (signature.length !== 16) throw new ProtocolError('join signature must be 16 bytes', { length: signature.length });
    writer.writeBytes(signature);
    writer.writeUInt16(packet.serverVersion ?? 0);
    writer.writeUInt16(packet.clientVersion ?? 0);
    writer.writeUInt32(packet.rpcHash ?? 0);
    (packet.netVersion instanceof NetVersion ? packet.netVersion : new NetVersion(packet.netVersion?.values)).encode(writer);
    writer.writeUInt8(packet.levelChangeCount ?? 0);
    writer.writeUInt32(packet.levelId ?? 0);
    const summary = Buffer.from(packet.levelSummary ?? Buffer.alloc(64));
    if (summary.length !== 64) throw new ProtocolError('level summary must be 64 bytes', { length: summary.length });
    writer.writeBytes(summary);
    writer.writeUInt32(packet.localPlayerId ?? 0);
    writer.writeUInt32(packet.currentPlayerId ?? 0);
    const levelData = Buffer.from(packet.levelData ?? Buffer.alloc(0));
    if (levelData.length > MAX_LEVEL_DATA_BYTES) throw new ProtocolError('join level data too large', { max: MAX_LEVEL_DATA_BYTES });
    writer.writeUInt32(levelData.length);
    writer.writeBytes(levelData);
    writer.writeBool(packet.moving);
    writer.writeBool(packet.hasTransferAddress);
    writer.writeCompressed(packet.mergeState ?? packet.mergeFlags ?? 0, 0xff);
    const transferAddress = packet.transferAddress instanceof NetAddress
      ? packet.transferAddress
      : new NetAddress(packet.transferAddress ?? { host: '0.0.0.0', port: 0, type: 0 });
    transferAddress.encodeTyped(writer);
    writer.writeUInt32(packet.moveResult ?? 0);
  }
}
