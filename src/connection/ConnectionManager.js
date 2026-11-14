import { ConnectionSession } from './ConnectionSession.js';

export class ConnectionManager {
  constructor({ roomId } = {}) {
    this.roomId = roomId;
    this.sessions = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  add(peerId) {
    const session = new ConnectionSession({ peerId, roomId: this.roomId });
    this.sessions.set(peerId, session);
    return session;
  }

  get(peerId) {
    return this.sessions.get(peerId);
  }

  remove(peerId, expectedSession) {
    const session = this.sessions.get(peerId);
    if (expectedSession && session !== expectedSession) return undefined;
    if (session) {
      session.close();
      this.sessions.delete(peerId);
    }

    return session;
  }

  setRoomId(roomId) {
    this.roomId = roomId;
    for (const session of this.sessions.values()) {
      session.roomId = roomId;
    }
  }

  list() {
    return Array.from(this.sessions.values());
  }
}
