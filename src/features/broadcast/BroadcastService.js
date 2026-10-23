export class BroadcastService {
  constructor({ codec, transport, sessions, metrics }) {
    this.codec = codec;
    this.transport = transport;
    this.sessions = sessions;
    this.metrics = metrics;
  }

  send(session, packet, options = { reliable: true }) {
    const buffer = this.codec.encodeServer(packet, session);
    this.metrics?.packetBytes?.inc({ direction: 'server' }, buffer.length);
    return this.transport.send(session.peerId, buffer, options);
  }

  broadcast(packet, { exceptSession, playerOnly = true, channel = 0, reliable = true } = {}) {
    this._iterateSessions({ exceptSession, playerOnly }, session => {
      const buffer = this.codec.encodeServer(packet, session);
      this.metrics?.packetBytes?.inc({ direction: 'server' }, buffer.length);
      this.transport.send(session.peerId, buffer, { channel, reliable });
    });
  }

  broadcastEncoded(buffer, { exceptSession, playerOnly = true, channel = 0, reliable = true } = {}) {
    this.metrics?.packetBytes?.inc({ direction: 'server' }, buffer.length);
    this._iterateSessions({ exceptSession, playerOnly }, session => {
      this.transport.send(session.peerId, buffer, { channel, reliable });
    });
  }

  _iterateSessions({ exceptSession, playerOnly = true }, fn) {
    for (const session of this.sessions.list()) {
      if (session.closed || session === exceptSession) {
        continue;
      }
      if (playerOnly && !isActiveSession(session)) {
        continue;
      }
      fn(session);
    }
  }
}

function isActiveSession(session) {
  return typeof session.isActive === 'function' ? session.isActive() : Boolean(session.player);
}
