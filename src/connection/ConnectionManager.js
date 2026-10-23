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

  remove(peerId) {
    const session = this.sessions.get(peerId);
    if (session) {
      session.close();
      this.sessions.delete(peerId);
    }

    return session;
  }

  // QWD can force a room id change after a conflict. Existing sessions (and
  // the players that report roomId through their session) must follow.
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
