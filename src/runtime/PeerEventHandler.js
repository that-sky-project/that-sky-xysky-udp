import { PacketIds } from '../protocol/PacketIds.js';
import { ConnectionState } from '../connection/states.js';
import { PacketDebugLog, PacketFormatter } from '../observability/debugPackets.js';
import { AdmissionError } from '../errors.js';

export class PeerEventHandler {
  constructor({ config, sessions, codec, dispatcher, players, levelService, moveService, broadcaster, transport, metrics, logger, packetDebug, onPlayerLeft, finalizeSession }) {
    this.config = config;
    this.sessions = sessions;
    this.codec = codec;
    this.dispatcher = dispatcher;
    this.players = players;
    this.levelService = levelService;
    this.moveService = moveService;
    this.broadcaster = broadcaster;
    this.transport = transport;
    this.metrics = metrics;
    this.logger = logger;
    this.packetDebug = packetDebug ?? new PacketDebugLog({ logger });
    this.onPlayerLeft = onPlayerLeft;
    this.finalizeSession = finalizeSession;
    this.lastWarningAt = -Infinity;
    this.inboundCounts = new Map();
  }

  /**
   * Snapshot and clear the inbound packet counters.
   *
   * @returns {Record<string, number>} packet id -> count since the last call
   */
  takeInboundCounts() {
    const out = {};
    for (const [id, count] of this.inboundCounts) out[id] = count;
    this.inboundCounts.clear();
    return out;
  }

  onConnect(peerId) {
    if (this.sessions.get(peerId)) {
      this._warn({ peerId: peerId.toString() }, 'ignored duplicate peer connect event');
      return;
    }
    if (this.sessions.size >= this.config.maxPeers) {
      this.transport.disconnect(peerId, 'now');
      return;
    }

    const session = this.sessions.add(peerId);
    session.transition(ConnectionState.PENDING);

    this.metrics.connectedPeers.set(this.sessions.size);
    this.logger.debug({ peerId: peerId.toString(), sessionId: session.id }, 'peer connected');
  }

  onMessage(peerId, data, channel = 0) {
    const session = this.sessions.get(peerId);
    if (!session || session.closed) {
      return;
    }

    session.markPacket(Date.now());
    this.metrics.packetBytes.inc({ direction: 'client' }, data.length);

    if (data.length > this.config.maxPacketBytes) {
      this._rejectSessionPacket(session, 'packet_too_large');
      return;
    }

    let packet;
    try {
      packet = this.codec.decodeClient(data);
    } catch (error) {
      this._rejectSessionPacket(session, error.name ?? 'decode_error');
      this._warn({
        err: error,
        peerId: peerId.toString(),
        sessionId: session.id,
        channel,
        rawPacket: formatPacketBytes(data)
      }, 'failed to process packet');
      return;
    }

    if (packet.unknown) {
      this.logger.debug({ peerId: peerId.toString(), sessionId: session.id, channel, id: packet.id, sequence: packet.sequence }, 'ignored unknown client packet');
      return;
    }

    if (session.connMagic === null && packet.id !== PacketIds.JoinGame) {
      this._rejectSessionPacket(session, 'join_required');
      return;
    }
    if (session.connMagic === null) {
      session.connMagic = packet.token;
    } else if (packet.token !== session.connMagic) {
      this._rejectSessionPacket(session, 'magic_mismatch');
      this._warn({
        peerId: peerId.toString(),
        sessionId: session.id,
        expected: session.connMagic,
        got: packet.token
      }, 'rejected packet: connection magic mismatch');
      return;
    }

    this.metrics.packets.inc({ direction: 'client', type: packet.name });
    this.inboundCounts.set(packet.id, (this.inboundCounts.get(packet.id) ?? 0) + 1);
    this._logClientPacket(session, peerId, channel, data, packet);
    const endTimer = this.metrics.packetDuration.startTimer({ type: packet.name });
    try {
      this.dispatcher.dispatch(session, packet);
    } catch (error) {
      if (error instanceof AdmissionError) {
        this.metrics.admissionRejections?.inc({ reason: 'capacity' });
        if (this.finalizeSession) this.finalizeSession(session, 'capacity_rejected', { disconnect: 'now' });
        else {
          this.sessions.remove(session.peerId, session);
          this.transport.disconnect(session.peerId, 'now');
        }
        return;
      }
      this._rejectSessionPacket(session, error.name ?? 'dispatch_error');
      this._warn({
        err: error,
        peerId: peerId.toString(),
        sessionId: session.id,
        channel,
        rawPacket: formatPacketBytes(data)
      }, 'failed to dispatch packet');
    } finally {
      endTimer();
    }
  }

  onDisconnect(peerId, data, expectedSession) {
    const current = this.sessions.get(peerId);
    if (expectedSession && current !== expectedSession) return;
    if (this.finalizeSession) return this.finalizeSession(current, 'peer_disconnected');
    const session = this.sessions.remove(peerId, expectedSession);
    if (!session) {
      return;
    }

    const player = this.players.removeBySession(session);
    if (player) {
      this.onPlayerLeft?.(player);
      this.moveService?.forgetPlayerMoves(player);
      this.levelService.releaseAuthority(player);
      this.broadcaster.broadcast({
        id: PacketIds.PlayerLeft,
        payload: { playerId: player.id, reason: 0 }
      }, { playerOnly: true });
    }

    this.metrics.connectedPeers.set(this.sessions.size);
    this.metrics.onlinePlayers.set(this.players.size);
    this.metrics.disconnects.inc({ reason: String(data ?? 'normal') });

    this.logger.info({
      peerId: peerId.toString(),
      sessionId: session.id,
      playerId: player?.id,
      uuid: player?.uuid?.toString?.(),
      levelId: player?.levelId,
      disconnectData: data
    }, 'peer disconnected');
  }

  _logClientPacket(session, peerId, channel, data, packet) {
    if (!this.packetDebug.isEnabled(packet)) return;

    this.packetDebug.log('c2s', packet, {
      peerId: peerId.toString(),
      sessionId: session.id,
      channel
    });
    this.logger.trace?.({
      peerId: peerId.toString(),
      sessionId: session.id,
      channel,
      packet: packetLogFormatter.packet(packet),
      raw: packetLogFormatter.bytes(data, { header: readClientPacketHeader(Buffer.from(data)) })
    }, 'client packet raw');
  }

  _warn(fields, message) {
    const now = Date.now();
    if (now - this.lastWarningAt < 1000) return;
    this.lastWarningAt = now;
    this.logger.warn(fields, message);
  }

  _rejectSessionPacket(session, reason) {
    const count = session.registerBadPacket();
    this.metrics.packetErrors.inc({ reason });

    if (count >= this.config.badPacketLimit) {
      if (this.finalizeSession) this.finalizeSession(session, 'bad_packet_limit', { disconnect: 'now' });
      else {
        session.close();
        this.metrics.disconnects.inc({ reason: 'bad_packet_limit' });
        this.transport.disconnect(session.peerId, 'later');
      }
    }
  }
}

const packetLogFormatter = new PacketFormatter();

function formatPacketBytes(data) {
  const buffer = Buffer.from(data);
  return {
    bytes: buffer.length,
    hex: buffer.toString('hex'),
    base64: buffer.toString('base64'),
    header: readClientPacketHeader(buffer)
  };
}

function readClientPacketHeader(buffer) {
  return {
    token: buffer.length >= 4 ? buffer.readUInt32LE(0) : null,
    id: buffer.length >= 5 ? buffer.readUInt8(4) : null,
    sequence: buffer.length >= 6 ? buffer.readUInt8(5) : null,
    payloadBytes: Math.max(0, buffer.length - 6)
  };
}
