import { PacketIds } from '../../protocol/PacketIds.js';
import { handleJoin } from './handleJoin.js';
import { handlePing } from './handlePing.js';
import { handleLevelUpdate } from './handleLevelUpdate.js';
import { handleGameMsg } from './handleGameMsg.js';
import { handleMoveResult } from './handleMoveResult.js';

export function registerAllHandlers(dispatcher) {
  dispatcher
    .register(PacketIds.JoinGame,    handleJoin)
    .register(PacketIds.NetTimePing, handlePing)
    .register(PacketIds.LevelUpdate, handleLevelUpdate)
    .register(PacketIds.GameMsg,     handleGameMsg)
    .register(PacketIds.MoveResult,  handleMoveResult);
}
