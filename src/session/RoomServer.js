import { PacketCodec } from '../protocol/PacketCodec.js';
import { PacketIds } from '../protocol/PacketIds.js';
import { GameMsgType } from '../protocol/packets/shared/GameMsgPacket.js';
import { ConnectionManager } from './ConnectionManager.js';
import { PlayerStore } from '../domain/PlayerStore.js';
import { LevelStateStore } from '../domain/LevelStateStore.js';
import { RoomDirectory } from '../domain/RoomDirectory.js';
import { EnetServer } from '../transport/EnetServer.js';
import { BroadcastService } from '../services/BroadcastService.js';
import { JoinService } from '../services/JoinService.js';
import { LevelService } from '../services/LevelService.js';
import { GameMessageService } from '../services/GameMessageService.js';
import { MoveService } from '../services/MoveService.js';
import { PacketDispatcher } from './PacketDispatcher.js';
import { PeerEventHandler } from './PeerEventHandler.js';
import { TickLoop } from './TickLoop.js';
import { registerAllHandlers } from './handlers/index.js';
import { AuthorityElectionGate, revokeAndRebalanceAuthority } from './AuthorityElectionCoordinator.js';
import { QwdClient } from '../services/QwdClient.js';

export class RoomServer {
  constructor({ config, logger, metrics }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;

    // Infrastructure
    this.codec = new PacketCodec();
    this.sessions = new ConnectionManager({ roomId: config.id });
    // Sky rooms are semantically capped at eight players even when the ENet
    // peer socket pool is configured larger for handshakes or spectators.
    this.players = new PlayerStore({ maxPlayers: 8 });
    this.levels = new LevelStateStore({ roomId: config.id, logger });
    this.rooms = new RoomDirectory();
    this.qwd = new QwdClient({ url: config.qwdUrl, room: config, logger, onCommand: command => this.handleQwdCommand(command), onRoomIdConflict: roomId => this.handleRoomIdConflict(roomId), onConnected: () => this.reannounceQwdState() });
    this.telemetrySeq = 0;
    this.lastQwdTelemetryAt = 0;
    this.qwdReservations = new Map();
    this.migrationRosters = new Map();
    this.authorityElectionGate = new AuthorityElectionGate();
    this.transport = new EnetServer({
      host: config.host,
      port: config.port,
      maxPeers: config.maxPeers,
      channels: config.channels,
      logger
    });

    // Services
    this.broadcaster = new BroadcastService({
      codec: this.codec,
      transport: this.transport,
      sessions: this.sessions,
      metrics
    });

    this.joinService = new JoinService({
      players: this.players,
      levels: this.levels,
      broadcaster: this.broadcaster,
      logger,
      metrics,
      migration: {
        claim: (session, payload) => this.claimMigrationRoster(session, payload),
        complete: roster => this.completeMigrationRoster(roster)
      },
      onPlayerJoined: player => { this.consumeQwdReservation(player.uuid.toString()); this.qwd.publish('player.join', { roomId: this.config.id, player: { playerId: player.uuid.toString() } }); }
    });

    this.levelService = new LevelService({
      players: this.players,
      levels: this.levels,
      broadcaster: this.broadcaster,
      logger
    });

    this.gameMessageService = new GameMessageService({
      players: this.players,
      levels: this.levels,
      broadcaster: this.broadcaster,
      logger
    });

    this.moveService = new MoveService({
      players: this.players,
      rooms: this.rooms,
      broadcaster: this.broadcaster,
      transport: this.transport,
      levelService: this.levelService,
      logger,
      moveTimeoutMs: config.moveTimeoutMs,
      onMoveResult: (move, accepted) => {
        if (!move.transactionId) return;
        this.qwd.publish('move.result', {
          roomId: this.config.id,
          moveId: move.transactionId,
          accepted,
          movedPlayerIds: accepted ? [move.playerUuid] : [],
          failedPlayerIds: accepted ? [] : [move.playerUuid],
          reason: accepted ? undefined : `client_move_result_${move.result}`
        });
      }
    });

    // Wire up authority-elected event: send NetLevelDataElect to all affected players.
    // The third argument (targetPlayer) is set by JoinService/LevelService when only
    // one specific player needs the Elect (stable authority, single-target notify).
    this.levels.onAuthorityElected((levelId, authority, targetPlayer) => {
      this._handleAuthorityElected(levelId, authority, targetPlayer);
    });

    // Dispatcher — holds context bag, registers all C→S handlers
    const context = Object.freeze({
      joinService: this.joinService,
      levelService: this.levelService,
      gameMessageService: this.gameMessageService,
      moveService: this.moveService,
      broadcaster: this.broadcaster,
      logger,
      clock: () => Date.now() / 1000,
      transport: this.transport
    });

    this.dispatcher = new PacketDispatcher({ context });
    registerAllHandlers(this.dispatcher);

    // Peer event handler (transport ↔ dispatcher bridge)
    this.peerHandler = new PeerEventHandler({
      config,
      sessions: this.sessions,
      codec: this.codec,
      dispatcher: this.dispatcher,
      players: this.players,
      levelService: this.levelService,
      moveService: this.moveService,
      broadcaster: this.broadcaster,
      transport: this.transport,
      metrics,
      logger,
      onPlayerLeft: player => this.qwd.publish('player.leave', { roomId: this.config.id, player: { playerId: player.uuid.toString() } })
    });

    // Move targets
    for (const target of config.moveTargets) {
      this.rooms.register(target);
    }

    this.tickLoop = new TickLoop({
      tickRate: config.tickRate,
      logger,
      onTick: () => this.onTick()
    });
  }

  async start() {
    this.qwd.start();
    this.transport.on('peer:connect',    peerId => this.peerHandler.onConnect(peerId));
    this.transport.on('peer:message',    (peerId, data) => this.peerHandler.onMessage(peerId, data));
    this.transport.on('peer:disconnect', (peerId, data) => this.peerHandler.onDisconnect(peerId, data));

    await this.transport.start();
    this.tickLoop.start();
  }

  async stop() {
    this.qwd.stop();
    this.tickLoop.stop();
    await this.transport.stop();
  }

  handleRoomIdConflict(roomId) {
    this.config.id = roomId;
    this.sessions.roomId = roomId;
    this.levels.roomId = roomId;
  }

  reannounceQwdState() {
    for (const player of this.players.listActive()) {
      this.qwd.publish('player.join', {
        roomId: this.config.id,
        player: {
          playerId: player.uuid.toString(),
          level: player.levelId
        }
      });
    }
    this.lastQwdTelemetryAt = 0;
    this.publishQwdTelemetry();
  }

  // ── Management API (used by httpServer) ─────────────────────────────────────

  kickPlayer(playerId, reason = 0) {
    const player = this.players.getById(Number(playerId));
    if (!player) {
      return false;
    }

    const reasonStr = typeof reason === 'string' ? reason : String(reason);
    this.broadcaster.send(player.session, {
      id: PacketIds.Kick,
      payload: { reason: reasonStr }
    });
    this.transport.disconnect(player.session.peerId, 'later', reason);
    return true;
  }

  broadcastRpc({ levelId, playerId = 0, rpcData }) {
    const data = Buffer.isBuffer(rpcData)
      ? rpcData
      : Buffer.from(String(rpcData ?? ''), 'utf8');

    for (const player of this.players.list()) {
      if (levelId !== undefined && player.levelId !== Number(levelId)) {
        continue;
      }

      this.broadcaster.send(player.session, {
        id: PacketIds.GameMsg,
        payload: {
          type: GameMsgType.NetRpc,
          levelChangeCount: player.lvSeq,
          sourcePlayer: 0,
          playerId,
          rpcData: data
        }
      });
    }
  }

  revokeLevelAuthority(levelId, reason = 0) {
    const nLevelId = Number(levelId);
    return revokeAndRebalanceAuthority({
      levelId: nLevelId,
      reason,
      levels: this.levels,
      levelService: this.levelService,
      gameMessageService: this.gameMessageService,
      electionGate: this.authorityElectionGate
    });
  }

  _handleAuthorityElected(levelId, authority, targetPlayer) {
    if (this.authorityElectionGate.isSuppressed(levelId)) {
      return;
    }
    if (targetPlayer) {
      this.gameMessageService.sendElect(targetPlayer, authority, this.levels.loadLevelData(levelId));
      return;
    }
    for (const player of this.players.listActiveInLevel(levelId)) {
      this.gameMessageService.sendElect(player, authority, this.levels.loadLevelData(levelId));
    }
  }

  registerMoveTarget(room) {
    return this.rooms.register(room);
  }

  unregisterMoveTarget(roomId) {
    return this.rooms.unregister(roomId);
  }

  movePlayerToRoom(playerId, roomId = undefined) {
    const player = this.players.getById(Number(playerId));
    if (!player) {
      return { ok: false, reason: 'player_not_found' };
    }

    const target = roomId
      ? this.rooms.getById(roomId)
      : this.rooms.findTarget({ levelId: player.levelId });

    if (!target) {
      this.moveService.cancelPlayerMove(player, 1);
      return { ok: false, reason: 'target_not_found' };
    }

    return {
      ok: this.moveService.movePlayer(player, target),
      targetRoomId: target.id
    };
  }

  moveLevelToRoom(levelId, roomId = undefined) {
    const target = roomId
      ? this.rooms.getById(roomId)
      : this.rooms.findTarget({ levelId });

    if (!target) {
      return { ok: false, reason: 'target_not_found' };
    }

    return {
      ok: true,
      moved: this.moveService.moveLevel(levelId, target),
      targetRoomId: target.id
    };
  }

  onTick() {
    this.expireMigrationRosters();
    this.moveService.expireStuckMoves();
    this.metrics.connectedPeers.set(this.sessions.size);
    this.metrics.onlinePlayers.set(this.players.size);
    this.gameMessageService.syncPlayerStates();
    this.gameMessageService.syncLevelData();
    this.gameMessageService.sendSnapshotAcks();
    this.publishQwdTelemetry();
  }

  claimMigrationRoster(session, payload) {
    if (!Array.isArray(payload.move?.players) || payload.move.players.length === 0) {
      return undefined;
    }
    const ownUuid = payload.uuid?.toString?.();
    const uuids = payload.move.players
      .map(uuid => uuid?.toString?.())
      .filter(Boolean);
    if (!ownUuid || !uuids.includes(ownUuid)) return undefined;

    let reservationId;
    for (const [id, reservation] of this.qwdReservations) {
      if (reservation.playerIds.has(ownUuid) && uuids.every(uuid => reservation.playerIds.has(uuid))) {
        reservationId = id;
        break;
      }
    }
    // A non-moving Join with an arbitrary UUID list is not a migration. The
    // reservation is the authenticated cross-room handoff; moving=true is
    // accepted for deployments that do not run QWD.
    if (!payload.moving && !reservationId) return undefined;
    const key = reservationId ?? `move:${uuids.slice().sort().join(',')}`;
    let roster = this.migrationRosters.get(key);
    if (!roster) {
      if (this.players.size + uuids.length > this.players.maxPlayers) {
        this.logger.warn({ key, players: this.players.size, requested: uuids.length }, 'migration roster exceeds room capacity');
        return undefined;
      }
      const entries = [];
      const used = new Set(this.players.list().map(player => player.id));
      for (const uuid of uuids) {
        let netId = this.players.allocateId();
        while (used.has(netId)) netId = this.players.allocateId();
        used.add(netId);
        this.players.reserveId(netId);
        const value = payload.move.players.find(item => item.toString() === uuid);
        entries.push({ netId, uuid: value, levelId: payload.levelId ?? 0 });
      }
      roster = { key, entries, joined: new Set(), expiresAt: Date.now() + 15000, sessionIds: new Set() };
      this.migrationRosters.set(key, roster);
    }
    roster.sessionIds.add(session.id);
    roster.expiresAt = Date.now() + 15000;
    return roster;
  }

  completeMigrationRoster(roster) {
    if (!roster) return;
    const allJoined = roster.entries.every(entry => roster.joined.has(entry.uuid.toString()));
    if (!allJoined) return;
    this.migrationRosters.delete(roster.key);
    for (const entry of roster.entries) this.players.releaseReservedId(entry.netId);
    for (const [id, reservation] of this.qwdReservations) {
      if (reservation.playerIds.size === roster.entries.length && roster.entries.every(entry => reservation.playerIds.has(entry.uuid.toString()))) {
        this.qwdReservations.delete(id);
      }
    }
  }

  expireMigrationRosters(now = Date.now()) {
    for (const [key, roster] of this.migrationRosters) {
      if (roster.expiresAt > now) continue;
      this.migrationRosters.delete(key);
      for (const entry of roster.entries) this.players.releaseReservedId(entry.netId);
    }
  }

  handleQwdCommand(command) {
    this.expireQwdReservations();
    if (command.cmd === 'room.reserve') {
      const roomId = String(command.data?.roomId ?? '');
      const playerId = String(command.data?.playerId ?? '');
      if (!roomId || roomId !== String(this.config.id) || !playerId) {
        return { code: 4000, data: { message: 'invalid room reservation' } };
      }
      for (const [reservationId, reservation] of this.qwdReservations) {
        if (reservation.playerIds.has(playerId)) {
          return { code: 0, data: { accepted: true, reservationId, slots: 1 } };
        }
      }
      const reserved = [...this.qwdReservations.values()].reduce((sum, item) => sum + item.playerIds.size, 0);
      if (this.players.size + reserved + 1 > 8) return { code: 4029, data: { message: 'room capacity reserved' } };
      const reservationId = `allocation-${playerId}-${Date.now()}`;
      this.qwdReservations.set(reservationId, {
        playerIds: new Set([playerId]),
        joined: new Set(),
        expiresAt: Date.now() + Number(command.data?.ttlMs ?? 15000)
      });
      return { code: 0, data: { accepted: true, reservationId, slots: 1 } };
    }
    if (command.cmd === 'move.prepare') {
      const moveId = String(command.data?.moveId ?? '');
      const playerIds = Array.isArray(command.data?.playerIds) ? command.data.playerIds.map(String) : [];
      if (!moveId || !playerIds.length || new Set(playerIds).size !== playerIds.length) return { code: 4000, data: { message: 'invalid move prepare' } };
      const existing = this.qwdReservations.get(moveId);
      if (existing) {
        const same = existing.playerIds.size === playerIds.length && playerIds.every(id => existing.playerIds.has(id));
        if (!same) return { code: 4009, data: { message: 'move reservation conflicts' } };
        existing.expiresAt = Date.now() + Number(command.data?.ttlMs ?? 15000);
        return { code: 0, data: { accepted: true, moveId, slots: playerIds.length, idempotent: true } };
      }
      const reserved = [...this.qwdReservations.values()].reduce((sum, item) => sum + item.playerIds.size, 0);
      if (this.players.size + reserved + playerIds.length > 8) return { code: 4029, data: { message: 'room capacity reserved' } };
      this.qwdReservations.set(moveId, { playerIds: new Set(playerIds), joined: new Set(), expiresAt: Date.now() + Number(command.data?.ttlMs ?? 15000) });
      return { code: 0, data: { accepted: true, moveId, slots: playerIds.length } };
    }
    if (command.cmd === 'move.cancel') {
      this.qwdReservations.delete(String(command.data?.moveId ?? ''));
      return { code: 0, data: { accepted: true } };
    }
    if (command.cmd !== 'move.commit' && command.cmd !== 'player.redirect') return { code: 4000, data: { message: 'unsupported command' } };
    const ids = command.data?.playerIds ?? [command.data?.playerId];
    const group = [];
    for (const id of ids) {
      const player = this.players.list().find(item => item.uuid.toString() === String(id) || item.id === Number(id));
      if (!player || !command.data?.udpHost) return { code: 4004, data: { message: 'source player not found', playerId: id } };
      group.push(player);
    }
    const target = { id: command.data.toRoomId, address: { host: command.data.udpHost, port: command.data.udpPort, toApi() { return this; } } };
    const result = this.moveService.movePlayersAtomic(group, target, { moveId: command.data.moveId });
    this.qwd.publish('move.result', { roomId: this.config.id, moveId: command.data.moveId, accepted: result.accepted, reason: result.reason });
    return { code: result.accepted ? 0 : 409, data: result };
  }

  expireQwdReservations(now = Date.now()) {
    for (const [moveId, reservation] of this.qwdReservations) if (reservation.expiresAt <= now) this.qwdReservations.delete(moveId);
  }

  consumeQwdReservation(playerId) {
    for (const [moveId, reservation] of this.qwdReservations) {
      if (!reservation.playerIds.has(String(playerId))) continue;
      reservation.joined.add(String(playerId));
      if (reservation.joined.size >= reservation.playerIds.size) this.qwdReservations.delete(moveId);
    }
  }

  publishQwdTelemetry() {
    const now = Date.now();
    if (now - this.lastQwdTelemetryAt < 1000) return;
    this.lastQwdTelemetryAt = now;
    const active = this.players.listActive();
    const players = active.map(player => ({
      playerId: player.uuid.toString(), levelId: player.levelId,
      position: player.playerDelta.decodedState?.fields?.position,
      velocity: player.playerDelta.decodedState?.fields?.move?.velocity ? Math.hypot(...player.playerDelta.decodedState.fields.move.velocity) : undefined,
      stateAt: player.playerDelta.stats.lastReadAt ?? player.lastSeenAt, lastMoveAt: player.lastSeenAt,
      affinity: Object.fromEntries((player.lastAffinity?.entries ?? []).map(entry => {
        const peer = active.find(candidate => candidate.id === entry.netPlayerId);
        return peer ? [peer.uuid.toString(), Math.max(0, Math.min(1, Number(entry.value) / 255))] : null;
      }).filter(Boolean))
    }));
    this.qwd.publishTelemetry(players, ++this.telemetrySeq);
  }

  getStatus() {
    return {
      host: this.config.host,
      roomId: this.config.id,
      port: this.config.port,
      publicUri: this.config.publicUri,
      publicHost: this.config.publicHost,
      publicPort: this.config.publicPort,
      peers: this.sessions.size,
      players: this.players.size,
      tickRate: this.config.tickRate,
      limits: {
        maxPacketBytes: this.config.maxPacketBytes,
        badPacketLimit: this.config.badPacketLimit
      },
      moveTargets: this.rooms.list(),
      pendingMoves: this.moveService.listPending(),
      moveHistory: this.moveService.listHistory()
    };
  }
}
