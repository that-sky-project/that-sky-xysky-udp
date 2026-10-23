import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createRoomId } from '../domain/RoomId.js';
import { ErrorCode } from './errorCodes.js';

const QUEUE_LIMIT = 256;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Liveness is proven by any inbound frame: a JSON message, a ping or a pong.
// WebSocket control frames are handled by the protocol layer and never surface
// as 'message' events, so a watchdog that only watches messages fires on a
// perfectly healthy idle link.
const LIVENESS_TICK_MS = 5000;
// Four missed rounds of our own ping is a dead link. The manager may also ping
// independently; either direction landing here counts.
const MANAGER_SILENCE_LIMIT_MS = LIVENESS_TICK_MS * 4;
// Reconnect attempts only reset after a connection proves it can stay up this
// long. A handshake that dies a second later must not restart the backoff at
// attempt 1 forever.
const STABLE_CONNECTION_MS = 10_000;

export class QwdClient {
  constructor({ url, room, logger, onCommand, onRoomIdConflict, onConnected, onTransportDropped, snapshot }) {
    this.url = url;
    this.room = room;
    // Stable identity of this node process across reconnects so the manager can
    // restore its rooms within the grace window. Deliberately NOT the room id:
    // room ids are short numbers, can collide between nodes, and are
    // regenerated after a room.id_conflict — none of which may change the
    // identity of a live control connection.
    this.nodeId = randomUUID();
    this.logger = logger;
    this.onCommand = onCommand;
    this.onRoomIdConflict = onRoomIdConflict;
    this.onConnected = onConnected;
    this.onTransportDropped = onTransportDropped;
    this.snapshot = snapshot;
    this.socket = null;
    this.queue = [];
    this.droppedFrames = 0;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.stopped = true;
    // Commands are handled strictly one at a time: a second move.commit while
    // the first is still mutating pendingMoves would interleave group state.
    this.commandChain = Promise.resolve();
    // Last inbound activity of any kind (message / ping / pong).
    this.lastActivityAt = 0;
    this.connectedAt = 0;
    this.livenessTimer = null;
    // Rate limit for "offline, frames are queued" warnings.
    this.lastOfflineWarnAt = 0;
  }

  start() {
    if (!this.url) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopLivenessWatch();
    this.reconnectTimer = null;
    this.socket?.removeAllListeners?.();
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  /**
   * Queue a frame when offline. Telemetry is coalesced: only the newest
   * snapshot matters, so a full queue drops the oldest telemetry instead of
   * silently discarding everything. Control events keep insertion order.
   */
  publish(event, data) {
    const message = JSON.stringify({ v: 1, event, data });
    // A socket in CLOSING/CLOSED swallows writes, so treat it as offline and
    // let the queue keep the newest state instead of losing the frame.
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // The manager cannot see anything published while we are offline. Warn
      // once per window so this shows up next to the manager's resync logs.
      // Skip it for a standalone node (no qwd.url) and while shutting down.
      const at = Date.now();
      if (this.url && !this.stopped && at - this.lastOfflineWarnAt >= 30_000) {
        this.lastOfflineWarnAt = at;
        this.logger.warn?.({ roomId: this.room.id, event, queued: this.queue.length }, 'qwd offline; frames are queued and the manager will be resynced on reconnect');
      }
      if (event === 'room.telemetry') {
        const index = this.queue.findIndex(entry => entry.startsWith('{"v":1,"event":"room.telemetry"'));
        if (index >= 0) {
          this.queue[index] = message;
          return;
        }
      }
      if (this.queue.length >= QUEUE_LIMIT) {
        this.droppedFrames += 1;
        if (this.droppedFrames === 1 || this.droppedFrames % 100 === 0) {
          this.logger.warn?.({ dropped: this.droppedFrames, event }, 'qwd publish queue full; frame dropped');
        }
        return;
      }
      this.queue.push(message);
      return;
    }
    this.socket.send(message);
  }

  publishTelemetry(players, seq = 0, framing = null) {
    const data = { roomId: this.room.id, seq, players, timestamp: Date.now(), ...this.occupancy() };
    if (framing?.kind === 'delta') {
      data.kind = 'delta';
      data.baseSeq = framing.baseSeq;
      data.removedPlayers = framing.removedPlayers ?? [];
    }
    this.publish('room.telemetry', data);
  }

  /**
   * Node-level occupancy for the manager's placement scoring. It must come
   * from the authoritative player store, not from the frame's player list: a
   * delta telemetry frame only carries the changed entries, so counting it
   * would report a fraction of the real load.
   */
  occupancy() {
    const state = this.snapshot?.() ?? {};
    const capacity = state.capacity ?? this.room.maxPeers ?? 8;
    const players = state.players ?? 0;
    return { capacity, load: capacity > 0 ? Math.min(1, players / capacity) : 0 };
  }

  connect() {
    if (this.stopped) return;
    // Never leave a previous socket dangling: a stale CLOSING socket would
    // keep firing events against the new connection's state.
    if (this.socket) {
      this.socket.removeAllListeners?.();
      try {
        this.socket.terminate?.();
      } catch {
        this.socket.close();
      }
      this.socket = null;
      this.connected = false;
    }
    this.stopLivenessWatch();
    try {
      const endpoint = new URL(this.url);
      // qwd accepts node connections on the root WebSocket endpoint.
      endpoint.pathname = '/';
      endpoint.searchParams.set('v', '1');
      if (this.nodeId) endpoint.searchParams.set('node', this.nodeId);
      const socket = new WebSocket(endpoint, { handshakeTimeout: 10_000 });
      this.socket = socket;
      socket.on('open', () => {
        if (this.socket !== socket) {
          socket.terminate();
          return;
        }
        this.connected = true;
        this.connectedAt = Date.now();
        this.markAlive();
        this.logger.info?.({ endpoint: endpoint.toString(), roomId: this.room.id }, 'qwd websocket connected');
        // Events queued while qwd was unavailable are stale snapshots. Drop
        // them and replay the node's current authoritative state instead.
        const discardedQueuedFrames = this.queue.length;
        this.queue.length = 0;
        if (discardedQueuedFrames > 0) {
          this.logger.warn?.({ roomId: this.room.id, discardedQueuedFrames }, 'qwd reconnected; discarded queued frames, full resync follows');
        }
        this.publish('node.ready', { ...this.occupancy(), timestamp: Date.now() });
        // Report the authoritative occupancy, not 0: a reconnect while players
        // are present must not make the manager see an empty room and start
        // planning migrations against a wrong snapshot.
        this.publish('room.created', {
          roomId: this.room.id,
          udpHost: this.room.publicHost,
          port: this.room.publicPort,
          capacity: this.snapshot?.().capacity ?? 8,
          players: this.snapshot?.().players ?? 0,
          version: this.snapshot?.().version ?? 1
        });
        this.onConnected?.();
        this.startLivenessWatch(endpoint.toString());
      });
      socket.on('message', (data) => {
        if (this.socket !== socket) return;
        this.markAlive();
        try {
          const command = JSON.parse(data.toString());
          if (!command?.cmd) return;
          if (command.cmd === 'room.id_conflict') {
            const previousRoomId = this.room.id;
            this.room.id = createRoomId();
            this.logger.warn?.({ previousRoomId, roomId: this.room.id }, 'qwd room id conflict; regenerated room id');
            this.onRoomIdConflict?.(this.room.id, previousRoomId);
            if (this.connected) {
              this.publish('room.created', {
                roomId: this.room.id,
                udpHost: this.room.publicHost,
                port: this.room.publicPort,
                capacity: this.snapshot?.().capacity ?? 8,
                players: this.snapshot?.().players ?? 0,
                version: this.snapshot?.().version ?? 1
              });
            }
            return;
          }
          this.commandChain = this.commandChain
            .then(() => Promise.resolve(this.onCommand?.(command)))
            .then(result => this.sendAck(command.id, result?.code ?? 0, result?.data))
            .catch(error => this.sendAck(command.id, ErrorCode.INTERNAL, { message: error?.message ?? String(error) }));
        } catch (error) {
          this.logger.warn?.({ err: error }, 'invalid qwd command');
        }
      });
      // Control frames are answered by the WebSocket layer automatically, so
      // they never reach 'message'. They still prove the link is alive.
      socket.on('ping', () => {
        if (this.socket !== socket) return;
        this.markAlive();
      });
      socket.on('pong', () => {
        if (this.socket !== socket) return;
        this.markAlive();
      });
      socket.on('close', (code, reason) => {
        if (this.socket !== socket) return;
        this.connected = false;
        this.socket = null;
        this.stopLivenessWatch();
        // Only a connection that survived a while proves the link is healthy.
        // Otherwise a flapping handshake would pin the backoff at attempt 1.
        if (Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) {
          this.reconnectAttempts = 0;
        }
        this.onTransportDropped?.();
        this.logger.warn?.({ code, reason: reason?.toString?.(), endpoint: endpoint.toString() }, 'qwd websocket closed');
        if (!this.stopped) this.scheduleReconnect();
      });
      socket.on('error', error => this.logger.warn?.({ err: error, endpoint: endpoint.toString() }, 'qwd websocket error'));
    } catch (error) {
      this.logger.warn?.({ err: error, endpoint: this.url }, 'qwd websocket connection failed');
      this.scheduleReconnect();
    }
  }

  /**
   * Exponential backoff with jitter. A fixed 2s delay makes every node in the
   * cluster reconnect at the same instant after a manager restart, stampeding
   * the handshake path.
   */
  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    const delay = Math.round(exponential * (0.5 + Math.random()));
    this.logger.info?.({ attempt: this.reconnectAttempts, delayMs: delay }, 'qwd reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * Liveness watchdog plus node-initiated heartbeat.
   *
   * `readyState === OPEN` does not prove the peer is reachable: a NAT timeout
   * or a silent partition leaves a half-open socket that accepts writes and
   * never answers. Every tick sends a ping; any inbound frame (message, ping or
   * pong) proves the link is alive. When nothing has arrived for the whole
   * window the socket is terminated so the reconnect path runs.
   */
  startLivenessWatch(endpoint) {
    this.stopLivenessWatch();
    this.livenessTimer = setInterval(() => {
      const socket = this.socket;
      if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) return;
      const silentFor = Date.now() - this.lastActivityAt;
      if (silentFor > MANAGER_SILENCE_LIMIT_MS) {
        this.logger.warn?.({ endpoint, silentForMs: silentFor }, 'qwd silent too long; dropping connection');
        this.stopLivenessWatch();
        try {
          socket.terminate();
        } catch {
          socket.close();
        }
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        this.logger.debug?.({ err: error, endpoint }, 'qwd heartbeat ping failed');
      }
    }, LIVENESS_TICK_MS);
    this.livenessTimer.unref?.();
  }

  stopLivenessWatch() {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  markAlive(now = Date.now()) {
    this.lastActivityAt = now;
  }

  sendAck(id, code, data) {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN || !id) return;
    this.socket.send(JSON.stringify({ v: 1, id, code, data }));
  }
}
