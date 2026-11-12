import {
  JoinGamePacket,
  EnterGamePacket,
  PlayerChangeLevelPacket,
  SnapshotResyncPacket,
  CancelMovePacket,
  DisconnectPacket,
  GameMsgPacket,
  KickPacket,
  LevelUpdatePacket,
  MoveGamePacket,
  MoveResultPacket,
  NetTimePingPacket,
  NetTimePongPacket,
  PlayerLeftPacket
} from './packets/index.js';

export const packetTypes = new Map();

export function registerPacket(packetType) {
  packetTypes.set(packetType.id, packetType);
}

[
  JoinGamePacket,
  EnterGamePacket,
  PlayerChangeLevelPacket,
  CancelMovePacket,
  DisconnectPacket,
  GameMsgPacket,
  KickPacket,
  LevelUpdatePacket,
  MoveGamePacket,
  MoveResultPacket,
  NetTimePingPacket,
  NetTimePongPacket,
  PlayerLeftPacket,
  SnapshotResyncPacket
].forEach(registerPacket);
