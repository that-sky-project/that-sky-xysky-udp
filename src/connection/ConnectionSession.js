import { StateError } from '../errors.js';
import { ConnectionState, TRANSITIONS } from './states.js';

let nextSessionId = 1;

// Re-exported for callers that already import the session module directly.
export { ConnectionState };

export class ConnectionSession {
  constructor({ peerId, roomId }) {
    this.id = nextSessionId++;
    this.peerId = peerId;
    this.roomId = roomId;
    this.connectedAt = Date.now();
    this.lastPacketAt = this.connectedAt;
    this.player = null;
    this.state = ConnectionState.CONNECTED;
    this.closed = false;
    this.badPackets = 0;
    this._sessionSeq = 0;
    this._packetSeq = new Map();
    this.connMagic = null;
  }

  /**
   * Allocate the next session_seq and packet_seq for packet type `typeId`.
   * Returns { sessionSeq: u32, packetSeq: u08 } for the outbound header.
   */
  nextOutboundSeq(typeId) {
    this._sessionSeq = (this._sessionSeq + 1) >>> 0;
    const prev = this._packetSeq.get(typeId) ?? 0;
    const seq = (prev + 1) & 0xff;
    this._packetSeq.set(typeId, seq);
    return { sessionSeq: this._sessionSeq, packetSeq: seq };
  }

  markPacket(now = Date.now()) {
    this.lastPacketAt = now;
  }

  attachPlayer(player) {
    this.player = player;
  }

  transition(nextState) {
    if (nextState === this.state) {
      return this.state;
    }
    if (!TRANSITIONS[this.state]?.has(nextState)) {
      throw new StateError('invalid connection state transition', {
        sessionId: this.id,
        from: this.state,
        to: nextState
      });
    }
    this.state = nextState;
    this.closed = nextState === ConnectionState.CLOSED;
    return this.state;
  }

  is(state) {
    return this.state === state;
  }

  isActive() {
    return this.state === ConnectionState.ACTIVE;
  }

  isPlayerSession() {
    return this.state === ConnectionState.ACTIVE || this.state === ConnectionState.MOVING;
  }

  close() {
    if (this.state !== ConnectionState.CLOSED) {
      this.transition(ConnectionState.CLOSED);
    }
  }

  registerBadPacket() {
    this.badPackets += 1;
    return this.badPackets;
  }

  toApi() {
    return {
      id: this.id,
      roomId: this.roomId,
      peerId: this.peerId.toString(),
      state: this.state,
      connectedAt: this.connectedAt,
      lastPacketAt: this.lastPacketAt,
      playerId: this.player?.id,
      badPackets: this.badPackets
    };
  }
}
