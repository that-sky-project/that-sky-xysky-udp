import { PacketCodec } from '../protocol/PacketCodec.js';
import { TgcUuid } from '../protocol/types/TgcUuid.js';
import { ConnectionManager } from '../connection/ConnectionManager.js';
import { PacketDispatcher } from '../connection/PacketDispatcher.js';
import { registerAllHandlers } from '../connection/handlers/index.js';
import { PlayerStore } from '../domain/PlayerStore.js';
import { LevelStateStore } from '../domain/LevelStateStore.js';
import { RoomDirectory } from '../domain/RoomDirectory.js';
import { EnetServer } from '../transport/EnetServer.js';
import { BroadcastService } from '../features/broadcast/BroadcastService.js';
import { JoinService } from '../features/join/JoinService.js';
import { LevelService } from '../features/level/LevelService.js';
import { GameMessageService } from '../features/gamemsg/GameMessageService.js';
import { MoveService } from '../features/move/MoveService.js';
import { QwdClient } from '../qwd/QwdClient.js';
import { ErrorCode, fail, ok } from '../qwd/errorCodes.js';
import { PeerEventHandler } from './PeerEventHandler.js';
import { TickLoop } from './TickLoop.js';
import { AuthorityElectionGate } from './AuthorityElectionCoordinator.js';

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
    this.roomCapacity = 8;
    this.players = new PlayerStore({ maxPlayers: this.roomCapacity });
    this.levels = new LevelStateStore({ roomId: config.id, logger });
    this.rooms = new RoomDirectory();
    this.qwd = new QwdClient({
      url: config.qwdUrl,
      room: config,
      logger,
      onCommand: command => this.handleQwdCommand(command),
      onRoomIdConflict: roomId => this.handleRoomIdConflict(roomId),
      onConnected: () => this.reannounceQwdState(),
      snapshot: () => ({ players: this.players.size, version: this.telemetrySeq, capacity: this.roomCapacity }),
      // A dropped control socket does not cancel an in-flight migration — the
      // client is still moving. Keep reservations but stop honouring them
      // indefinitely: shrink the TTL so capacity cannot leak if the manager
      // never returns.
      onTransportDropped: () => {
        const deadline = Date.now() + 15000;
        for (const reservation of this.qwdReservations.values()) {
          reservation.expiresAt = Math.min(reservation.expiresAt, deadline);
        }
      }
    });
    this.telemetrySeq = 0;
    this.lastQwdTelemetryAt = 0;
    // Differential telemetry bookkeeping.
    this.lastTelemetryRoster = null;
    this.lastTelemetrySeqSent = 0;
    this.lastFullTelemetrySeq = 0;
    this.lastFullTelemetryAt = 0;
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
      onPlayerJoined: player => { this.consumeQwdReservation(player.uuid.toString()); this.qwd.publish('player.join', { roomId: this.config.id, player: { playerId: player.uuid.toString(), level: player.levelId } }); }
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
    this.sessions.setRoomId(roomId);
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
        return fail(ErrorCode.BAD_REQUEST, 'invalid room reservation');
      }
      const existingId = this.findReservationByPlayer(playerId);
      if (existingId) {
        return ok({ accepted: true, reservationId: existingId, slots: 1 });
      }
      if (!this.hasReservationCapacity(1)) {
        return fail(ErrorCode.NO_CAPACITY, 'room capacity reserved');
      }
      const reservationId = `allocation-${playerId}-${Date.now()}`;
      this.qwdReservations.set(reservationId, {
        playerIds: new Set([playerId]),
        joined: new Set(),
        expiresAt: Date.now() + Number(command.data?.ttlMs ?? 15000)
      });
      return ok({ accepted: true, reservationId, slots: 1 });
    }
    if (command.cmd === 'move.prepare') {
      const moveId = String(command.data?.moveId ?? '');
      const playerIds = Array.isArray(command.data?.playerIds) ? command.data.playerIds.map(String) : [];
      if (!moveId || !playerIds.length || new Set(playerIds).size !== playerIds.length) return fail(ErrorCode.BAD_REQUEST, 'invalid move prepare');
      const existing = this.qwdReservations.get(moveId);
      if (existing) {
        const same = existing.playerIds.size === playerIds.length && playerIds.every(id => existing.playerIds.has(id));
        if (!same) return fail(ErrorCode.CONFLICT, 'move reservation conflicts');
        existing.expiresAt = Date.now() + Number(command.data?.ttlMs ?? 15000);
        return ok({ accepted: true, moveId, slots: playerIds.length, idempotent: true, version: this.telemetrySeq });
      }
      if (!this.hasReservationCapacity(playerIds.length)) {
        return fail(ErrorCode.NO_CAPACITY, 'room capacity reserved');
      }

      // The manager plans against a cached room snapshot. If its expectedVersion
      // predates our latest telemetry the plan was built from stale state: report
      // a conflict instead of executing a migration that no longer matches.
      const expectedVersion = command.data?.expectedVersion;
      if (typeof expectedVersion === 'number' && Number.isFinite(expectedVersion)) {
        const currentVersion = this.telemetrySeq;
        if (expectedVersion < currentVersion && currentVersion - expectedVersion > 3) {
          return fail(ErrorCode.STALE_PLAN, 'room state advanced past the plan', { expectedVersion, currentVersion, players: this.players.size });
        }
      }

      this.qwdReservations.set(moveId, { playerIds: new Set(playerIds), joined: new Set(), expiresAt: Date.now() + Number(command.data?.ttlMs ?? 15000) });
      return ok({ accepted: true, moveId, slots: playerIds.length, version: this.telemetrySeq });
    }
    if (command.cmd === 'move.cancel') {
      this.qwdReservations.delete(String(command.data?.moveId ?? ''));
      return ok();
    }
    if (command.cmd !== 'move.commit' && command.cmd !== 'player.redirect') return fail(ErrorCode.BAD_REQUEST, 'unsupported command');
    const ids = command.data?.playerIds ?? [command.data?.playerId];
    const group = [];
    for (const id of ids) {
      const player = this.players.list().find(item => item.uuid.toString() === String(id) || item.id === Number(id));
      if (!player || !command.data?.udpHost) return fail(ErrorCode.NOT_FOUND, 'source player not found', { playerId: id });
      group.push(player);
    }
    // MoveGame.destinationUuid must identify the destination room. QWD addresses
    // rooms by id, and node room ids are UUIDs, so the id is the UUID unless the
    // manager supplies a distinct one.
    const toRoomUuid = command.data.toRoomUuid ?? command.data.toRoomId;
    if (!TgcUuid.isText(toRoomUuid)) return fail(ErrorCode.BAD_REQUEST, 'invalid destination room uuid', { toRoomId: command.data.toRoomId });
    const target = { id: command.data.toRoomId, udpHost: command.data.udpHost, udpPort: command.data.udpPort, uuid: toRoomUuid, address: { host: command.data.udpHost, port: command.data.udpPort, toApi() { return { host: this.host, port: this.port }; } } };
    const result = this.moveService.movePlayersAtomic(group, target, { moveId: command.data.moveId });
    this.qwd.publish('move.result', { roomId: this.config.id, moveId: command.data.moveId, accepted: result.accepted, reason: result.reason });
    // Was `409`, which the manager cannot match against its ErrorCode enum and
    // therefore reports as an unknown failure. CONFLICT (4009) carries the
    // "move could not be applied" meaning the manager expects.
    return result.accepted ? ok(result) : { code: ErrorCode.CONFLICT, data: result };
  }

  /** Slots currently held by unexpired reservations. */
  reservedSlots() {
    let total = 0;
    for (const reservation of this.qwdReservations.values()) total += reservation.playerIds.size;
    return total;
  }

  /**
   * Whether `count` more players fit alongside live players and existing holds.
   * Both room.reserve and move.prepare used to inline this formula; keeping one
   * copy means the cap cannot drift between the two paths.
   */
  hasReservationCapacity(count) {
    return this.players.size + this.reservedSlots() + count <= this.roomCapacity;
  }

  /** The reservation already holding this player, if any (reserve is idempotent). */
  findReservationByPlayer(playerId) {
    const wanted = String(playerId);
    for (const [reservationId, reservation] of this.qwdReservations) {
      if (reservation.playerIds.has(wanted)) return reservationId;
    }
    return undefined;
  }

  expireQwdReservations(now = Date.now()) {
    for (const [moveId, reservation] of this.qwdReservations) {
      if (reservation.expiresAt > now) continue;
      this.qwdReservations.delete(moveId);
      // Tell the manager the hold is gone so it can settle the transaction
      // immediately instead of waiting for its own 15s timeout.
      this.qwd.publish('reservation.expired', {
        roomId: this.config.id,
        moveId,
        playerIds: [...reservation.playerIds]
      });
    }
  }

  consumeQwdReservation(playerId) {
    for (const [moveId, reservation] of this.qwdReservations) {
      if (!reservation.playerIds.has(String(playerId))) continue;
      reservation.joined.add(String(playerId));
      if (reservation.joined.size >= reservation.playerIds.size) {
        this.qwdReservations.delete(moveId);
        // Positive confirmation that the whole group landed. The manager
        // otherwise infers completion from player.join/leave alone, which is
        // fragile when a client is lost mid-migration.
        this.qwd.publish('move.completed', {
          roomId: this.config.id,
          moveId,
          playerIds: [...reservation.playerIds]
        });
      }
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
    const seq = ++this.telemetrySeq;

    // Differential telemetry: after the first snapshot only send players whose
    // observable state changed, plus the ids that left. Falls back to a full
    // snapshot every FULL_RESYNC_EVERY frames so a desynced manager self-heals.
    const previous = this.lastTelemetryRoster;
    const current = new Map();
    for (const player of players) current.set(player.playerId, player);

    const canDelta =
      previous !== null &&
      previous.size > 0 &&
      seq - this.lastFullTelemetrySeq < 30 &&
      now - this.lastFullTelemetryAt < 30_000;

    if (!canDelta) {
      this.qwd.publishTelemetry(players, seq);
      this.lastTelemetryRoster = current;
      this.lastFullTelemetrySeq = seq;
      this.lastFullTelemetryAt = now;
      this.lastTelemetrySeqSent = seq;
      return;
    }

    const changed = [];
    for (const [playerId, player] of current) {
      const before = previous.get(playerId);
      if (!before || !this.sameTelemetry(before, player)) changed.push(player);
    }
    const removed = [];
    for (const playerId of previous.keys()) {
      if (!current.has(playerId)) removed.push(playerId);
    }

    if (changed.length === 0 && removed.length === 0) {
      // Nothing observable changed: skip the frame entirely. baseSeq still
      // advances because the manager treats an unseen seq as a gap and will
      // wait for the next full snapshot, which is what we want.
      this.lastTelemetryRoster = current;
      return;
    }

    this.qwd.publishTelemetry(changed, seq, { kind: 'delta', baseSeq: this.lastTelemetrySeqSent, removedPlayers: removed });
    this.lastTelemetryRoster = current;
    this.lastTelemetrySeqSent = seq;
  }

  sameTelemetry(a, b) {
    if (a.levelId !== b.levelId) return false;
    if (a.velocity !== b.velocity) return false;
    const ap = a.position;
    const bp = b.position;
    if (!ap !== !bp) return false;
    if (ap && bp && (ap[0] !== bp[0] || ap[1] !== bp[1] || ap[2] !== bp[2])) return false;
    return this.sameAffinity(a.affinity, b.affinity);
  }

  sameAffinity(a, b) {
    const ak = a ? Object.keys(a) : [];
    const bk = b ? Object.keys(b) : [];
    if (ak.length !== bk.length) return false;
    for (const key of ak) {
      if (!b || b[key] !== a[key]) return false;
    }
    return true;
  }

}
