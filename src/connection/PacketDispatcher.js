import { PacketIds } from '../protocol/PacketIds.js';
import { ConnectionState } from './states.js';

const ALLOWED_BY_STATE = Object.freeze({
  [ConnectionState.CONNECTED]: new Set(),
  [ConnectionState.PENDING]: new Set([PacketIds.JoinGame]),
  [ConnectionState.ACTIVE]: new Set([PacketIds.LevelUpdate, PacketIds.GameMsg, PacketIds.MoveResult, PacketIds.NetTimePing]),
  [ConnectionState.MOVING]: new Set([PacketIds.MoveResult]),
  [ConnectionState.CLOSED]: new Set()
});

export class PacketDispatcher {
  constructor({ context }) {
    this.handlers = new Map();
    this.context = context;
  }

  register(packetId, handlerFn) {
    this.handlers.set(packetId, handlerFn);
    return this;
  }

  dispatch(session, packet) {
    const allowed = ALLOWED_BY_STATE[session.state];
    if (allowed && !allowed.has(packet.id)) {
      this.context.logger.debug({ sessionId: session.id, state: session.state, id: packet.id, name: packet.name }, 'packet rejected by connection state');
      return false;
    }
    const handler = this.handlers.get(packet.id);
    if (!handler) {
      this.context.logger.debug({ id: packet.id, name: packet.name }, 'packet handler not implemented');
      return;
    }
    handler(session, packet.payload, this.context);
    return true;
  }
}
