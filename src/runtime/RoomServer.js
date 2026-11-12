import { PacketIds } from '../protocol/PacketIds.js'
import { PacketCodec } from '../protocol/PacketCodec.js'
import { ConnectionManager } from '../connection/ConnectionManager.js'
import { PacketDispatcher } from '../connection/PacketDispatcher.js'
import { registerAllHandlers } from '../connection/handlers/index.js'
import { PlayerStore } from '../domain/PlayerStore.js'
import { LevelStateStore } from '../domain/LevelStateStore.js'
import { RoomDirectory } from '../domain/RoomDirectory.js'
import { EnetServer } from '../transport/EnetServer.js'
import { BroadcastService } from '../features/broadcast/BroadcastService.js'
import { JoinService } from '../features/join/JoinService.js'
import { LevelService } from '../features/level/LevelService.js'
import { GameMessageService } from '../features/gamemsg/GameMessageService.js'
import { MoveService } from '../features/move/MoveService.js'
import { AudienceService } from '../features/audience/AudienceService.js'
import { PerformanceAuthority } from '../features/audience/PerformanceAuthority.js'
import { AudienceReactionService } from '../features/audience/AudienceReactionService.js'
import { AudienceCodec } from '../protocol/AudienceCodec.js'
import { QwdClient } from '../qwd/QwdClient.js'
import { ErrorCode, fail, ok } from '../qwd/errorCodes.js'
import { PeerEventHandler } from './PeerEventHandler.js'
import { TickLoop } from './TickLoop.js'
import { AuthorityElectionGate } from './AuthorityElectionCoordinator.js'
import { PacketDebugLog } from '../observability/debugPackets.js'
import { dispatchQwdCommand } from './QwdCommands.js'
import { destinationUuid } from './destinationUuid.js'
const TELEMETRY_FULL_RESYNC_FRAMES = 30
const TELEMETRY_FULL_RESYNC_MS = 10_000
const TELEMETRY_PLAYER_KEEPALIVE_MS = 2_000
export class RoomServer {
  constructor ({ config, logger, metrics }) {
    this.config = config
    this.logger = logger
    this.metrics = metrics
    this.codec = new PacketCodec()
    this.packetDebug = new PacketDebugLog({
      logger,
      enabled: new Set(config.debugPackets ?? []),
      channels: new Set(config.debugChannels ?? [])
    })
    this.sessions = new ConnectionManager({ roomId: config.id })
    this.roomCapacity = 8
    this.players = new PlayerStore({ maxPlayers: this.roomCapacity })
    this.levels = new LevelStateStore({ roomId: config.id, logger })
    this.rooms = new RoomDirectory()
    this.qwd = new QwdClient({
      url: config.qwdUrl,
      room: config,
      logger,
      onCommand: command => this.handleQwdCommand(command),
      onRoomIdConflict: roomId => this.handleRoomIdConflict(roomId),
      onConnected: () => this.reannounceQwdState(),
      snapshot: () => ({
        players: this.players.size,
        version: this.telemetrySeq,
        capacity: this.roomCapacity
      }),
      onTransportDropped: () => {
        this.audienceReactionService?.disconnected()
        this.audienceService?.performance?.disconnected().catch(error => this.logger.warn?.({ err: error }, 'performance disconnect cleanup failed'))
        const deadline = Date.now() + 15000
        for (const reservation of this.qwdReservations.values()) {
          reservation.expiresAt = Math.min(reservation.expiresAt, deadline)
        }
      }
    })
    this.telemetrySeq = 0
    this.lastQwdTelemetryAt = 0
    this.lastTelemetryRoster = null
    this.lastTelemetrySeqSent = 0
    this.lastFullTelemetrySeq = 0
    this.lastFullTelemetryAt = 0
    this.lastTelemetrySentAt = new Map()
    this.qwdReservations = new Map()
    this.migrationRosters = new Map()
    this.authorityElectionGate = new AuthorityElectionGate()
    this.transport = new EnetServer({
      host: config.host,
      port: config.port,
      maxPeers: config.maxPeers,
      channels: config.channels,
      logger
    })
    this.broadcaster = new BroadcastService({
      codec: this.codec,
      transport: this.transport,
      sessions: this.sessions,
      metrics,
      packetDebug: this.packetDebug
    })
    this.joinService = new JoinService({
      players: this.players,
      levels: this.levels,
      levelService: undefined,
      broadcaster: this.broadcaster,
      logger,
      metrics,
      migration: {
        claim: (session, payload) =>
          this.claimMigrationRoster(session, payload),
        complete: roster => this.completeMigrationRoster(roster)
      },
      onPlayerJoined: player => {
        this.consumeQwdReservation(player.uuid.toString())
        this.qwd.publish('player.join', {
          roomId: this.config.id,
          player: { playerId: player.uuid.toString(), level: player.levelId }
        })
      },
      onEvict: previous => {
        const playerId = previous.uuid?.toString?.() ?? ''
        const roster = playerId
          ? this.audienceService?.rosters.get(playerId)
          : undefined
        this.audienceService?.forgetPlayer(playerId)
        this.moveService?.forgetPlayerMoves?.(previous)
        this.sessions.remove(previous.session?.peerId)
        this.transport.disconnect(previous.session?.peerId, 'later')
        this.broadcaster.broadcast(
          {
            id: PacketIds.PlayerLeft,
            payload: { playerId: previous.id, reason: 0 }
          },
          { playerOnly: true }
        )
        if (playerId) {
          this.qwd.publish('player.leave', {
            roomId: this.config.id,
            player: { playerId }
          })
          if (roster) {
            this.qwd.publish('seat.released', {
              roomId: this.config.id,
              player: { playerId },
              levelId: roster.levelId ?? 0,
              benchId: roster.benchId,
              seatId: roster.seatId
            })
          }
        }
      }
    })
    this.levelService = new LevelService({
      players: this.players,
      levels: this.levels,
      broadcaster: this.broadcaster,
      logger
    })
    this.joinService._levelService = this.levelService
    this.gameMessageService = new GameMessageService({
      players: this.players,
      levels: this.levels,
      broadcaster: this.broadcaster,
      logger,
      stateDecode: this.config.playerStateDecode,
      packetDebug: this.packetDebug,
      onAudienceState: sample => this.audienceReactionService?.collect(sample)
    })
    this.audienceCodec = new AudienceCodec()
    this.audienceService = new AudienceService({
      logger,
      packetDebug: this.packetDebug,
      currentLevelOf: playerId => this.players.getByUuid(playerId)?.levelId,
      // Audience frames and every barn sample share one clock domain: the
      // local wall clock (seconds). Cross-room ghost seats arrive stamped
      // with the source node's wall clock; without a shared clamp a source
      // running ahead future-stamps its birds here and they never render
      // (the one-way-visibility bug).
      barnClock: () => Date.now() / 1000,
      onPositionChanged: (playerId, roster, position, levelTime) => {
        this.qwd.publish('seat.occupied', {
          roomId: this.config.id,
          player: { playerId },
          levelId: roster.levelId ?? 0,
          benchId: roster.benchId,
          seatId: roster.seatId,
          position,
          levelTime
        })
      },
      sendToClient: (playerId, packet) => {
        const session = this._sessionForPlayer(playerId)
        if (!session) return false
        const reliable = packet.id !== 27 && packet.id !== 33
        const buffer = this.audienceCodec.encode(packet)
        this.packetDebug?.log('s2c', packet, {
          peerId: session.peerId?.toString?.(),
          sessionId: session.id
        })
        return this.transport.send(session.peerId, buffer, { reliable })
      }
    })
    this.audienceService.performance = new PerformanceAuthority({
      audience: this.audienceService,
      publish: (event, data) => this.qwd.publish(event, data),
      roomId: () => this.config.id,
      sessionOf: playerId => this._sessionForPlayer(playerId),
      levels: () => this.players.listActive().map(player => player.levelId),
      logger
    })
    this.audienceReactionService = new AudienceReactionService({
      audience: this.audienceService,
      publish: (event, data) => this.qwd.publish(event, data),
      roomId: () => this.config.id,
      sessionOf: playerId => this._sessionForPlayer(playerId),
      logger
    })
    this.moveService = new MoveService({
      players: this.players,
      rooms: this.rooms,
      broadcaster: this.broadcaster,
      transport: this.transport,
      levelService: this.levelService,
      logger,
      moveTimeoutMs: config.moveTimeoutMs,
      onMoveResult: (move, accepted) => {
        if (!move.transactionId) return
        this.qwd.publish('move.result', {
          roomId: this.config.id,
          moveId: move.transactionId,
          accepted,
          movedPlayerIds: accepted ? [move.playerUuid] : [],
          failedPlayerIds: accepted ? [] : [move.playerUuid],
          reason: accepted ? undefined : `client_move_result_${move.result}`
        })
      }
    })
    this.levels.onAuthorityElected((levelId, authority, targetPlayer) => {
      this._handleAuthorityElected(levelId, authority, targetPlayer)
    })
    const context = Object.freeze({
      joinService: this.joinService,
      levelService: this.levelService,
      gameMessageService: this.gameMessageService,
      audienceService: this.audienceService,
      moveService: this.moveService,
      broadcaster: this.broadcaster,
      logger,
      clock: () => Date.now() / 1000,
      transport: this.transport
    })
    this.dispatcher = new PacketDispatcher({ context })
    registerAllHandlers(this.dispatcher)
    this.peerHandler = new PeerEventHandler({
      config,
      sessions: this.sessions,
      codec: this.codec,
      dispatcher: this.dispatcher,
      players: this.players,
      levelService: this.levelService,
      moveService: this.moveService,
      audienceService: this.audienceService,
      broadcaster: this.broadcaster,
      transport: this.transport,
      metrics,
      logger,
      packetDebug: this.packetDebug,
      onPlayerLeft: player => {
        this.qwd.publish('player.leave', {
          roomId: this.config.id,
          player: { playerId: player.uuid.toString() }
        })
        const playerId = player.uuid.toString()
        const roster = this.audienceService.rosters.get(playerId)
        if (roster) {
          this.qwd.publish('seat.released', {
            roomId: this.config.id,
            player: { playerId },
            levelId: roster.levelId ?? 0,
            benchId: roster.benchId,
            seatId: roster.seatId
          })
        }
      }
    })
    this.tickLoop = new TickLoop({
      tickRate: config.tickRate,
      logger,
      onTick: () => this.onTick()
    })
  }
  async start () {
    this.qwd.start()
    this.transport.on('peer:connect', peerId =>
      this.peerHandler.onConnect(peerId)
    )
    this.transport.on('peer:message', (peerId, data, channel) =>
      this.peerHandler.onMessage(peerId, data, channel)
    )
    this.transport.on('peer:disconnect', (peerId, data) =>
      this.peerHandler.onDisconnect(peerId, data)
    )
    this.transport.on('error', error => {
      this.logger.error({ err: error }, 'enet transport error')
    })
    await this.transport.start()
    this.tickLoop.start()
  }
  async stop () {
    this.qwd.stop()
    this.tickLoop.stop()
    await this.transport.stop()
  }
  handleRoomIdConflict (roomId) {
    this.config.id = roomId
    this.sessions.setRoomId(roomId)
    this.levels.roomId = roomId
  }
  reannounceQwdState () {
    const active = this.players.listActive()
    this.logger.info(
      {
        roomId: this.config.id,
        players: active.length,
        lastSeqSent: this.lastTelemetrySeqSent,
        lastFullSeq: this.lastFullTelemetrySeq
      },
      'qwd connected; forcing full telemetry resync'
    )
    this.lastTelemetryRoster = null
    this.lastQwdTelemetryAt = 0
    this.publishQwdTelemetry()
    this.audienceService.performance.connected()
  }
  _handleAuthorityElected (levelId, authority, targetPlayer) {
    if (this.authorityElectionGate.isSuppressed(levelId)) {
      return
    }
    if (targetPlayer) {
      this.gameMessageService.sendElect(
        targetPlayer,
        authority,
        this.levels.loadLevelData(levelId)
      )
      return
    }
    for (const player of this.players.listActiveInLevel(levelId)) {
      this.gameMessageService.sendElect(
        player,
        authority,
        this.levels.loadLevelData(levelId)
      )
    }
  }
  _sessionForPlayer (playerId) {
    return this.players.getByUuid(playerId)?.session ?? null
  }
  onTick () {
    this.audienceReactionService.tick()
    if (!this.performanceTick) {
      const authority = this.audienceService.performance
      this.performanceTick = authority.enqueue(() => authority.tick())
        .catch(error => this.logger.warn?.({ err: error }, 'performance tick failed'))
        .finally(() => { this.performanceTick = null })
    }
    this.expireMigrationRosters()
    this.expireQwdReservations()
    this.moveService.expireStuckMoves()
    this.metrics.connectedPeers.set(this.sessions.size)
    this.metrics.onlinePlayers.set(this.players.size)
    this.gameMessageService.syncPlayerStates()
    this.gameMessageService.syncLevelData()
    this.gameMessageService.sendSnapshotAcks()
    this.publishQwdTelemetry()
    this.tickCounter = (this.tickCounter ?? 0) + 1
    if (this.tickCounter % 50 === 0) {
      const stateSample = []
      for (const playerId of this.audienceService.rosters.keys()) {
        const player = this.players.getByUuid(playerId)
        const delta = player?.playerDelta
        stateSample.push({
          playerId,
          lastReadAt: delta?.stats?.lastReadAt,
          readStatus: delta?.stats?.lastReadStatus,
          readError: delta?.stats?.lastReadError,
          dataBytes: delta?.stats?.lastReadDataBytes,
          position: delta?.decodedState?.fields?.position ?? null,
          levelLastReadAt: player?.levelDelta?.stats?.lastReadAt,
          levelReadStatus: player?.levelDelta?.stats?.lastReadStatus,
          levelReadError: player?.levelDelta?.stats?.lastReadError,
          levelBytes: player?.levelDelta?.stats?.lastReadDataBytes,
          lvSeq: player?.lvSeq
        })
      }
    }
    const nowMs = Date.now()
    if (this.audienceService.rosters.size > 0) {
      this.audienceService.feedLocalPositions(
        Date.now() / 1000,
        playerId =>
          this.players.getByUuid(playerId)?.playerDelta?.decodedState?.fields
            ?.position
      )
    }
    if (
      this.audienceService.rosters.size > 0 &&
      nowMs - (this.lastAudienceFrameAt ?? 0) >= 1000
    ) {
      this.lastAudienceFrameAt = nowMs
      this.audienceService
        .broadcastFrame(Date.now() / 1000, this.audienceOrigin)
        .catch(error =>
          this.logger.debug?.({ err: error }, 'audience frame failed')
        )
    }
    if (
      this.audienceService.rosters.size > 0 &&
      nowMs - (this.lastAudienceTimelineAt ?? 0) >= 2500
    ) {
      this.lastAudienceTimelineAt = nowMs
      this.audienceService
        .broadcastTimeline(Date.now() / 1000)
        .catch(error =>
          this.logger.debug?.({ err: error }, 'audience timeline failed')
        )
    }
  }
  claimMigrationRoster (session, payload) {
    if (
      !Array.isArray(payload.move?.players) ||
      payload.move.players.length === 0
    ) {
      return undefined
    }
    const ownUuid = payload.uuid?.toString?.()
    const uuids = payload.move.players
      .map(uuid => uuid?.toString?.())
      .filter(Boolean)
    if (!ownUuid || !uuids.includes(ownUuid)) return undefined
    let reservationId
    for (const [id, reservation] of this.qwdReservations) {
      if (
        reservation.playerIds.has(ownUuid) &&
        uuids.every(uuid => reservation.playerIds.has(uuid))
      ) {
        reservationId = id
        break
      }
    }
    if (!payload.moving && !reservationId) return undefined
    const key = reservationId ?? `move:${uuids.slice().sort().join(',')}`
    let roster = this.migrationRosters.get(key)
    if (!roster) {
      if (this.players.size + uuids.length > this.players.maxPlayers) {
        this.logger.warn(
          { key, players: this.players.size, requested: uuids.length },
          'migration roster exceeds room capacity'
        )
        return undefined
      }
      const entries = []
      const used = new Set(this.players.list().map(player => player.id))
      for (const uuid of uuids) {
        let netId = this.players.allocateId()
        while (used.has(netId)) netId = this.players.allocateId()
        used.add(netId)
        this.players.reserveId(netId)
        const value = payload.move.players.find(
          item => item.toString() === uuid
        )
        entries.push({ netId, uuid: value, levelId: payload.levelId ?? 0 })
      }
      roster = {
        key,
        entries,
        joined: new Set(),
        expiresAt: Date.now() + 15000,
        sessionIds: new Set()
      }
      this.migrationRosters.set(key, roster)
    }
    roster.sessionIds.add(session.id)
    roster.expiresAt = Date.now() + 15000
    return roster
  }
  completeMigrationRoster (roster) {
    if (!roster) return
    const allJoined = roster.entries.every(entry =>
      roster.joined.has(entry.uuid.toString())
    )
    if (!allJoined) return
    this.migrationRosters.delete(roster.key)
    for (const entry of roster.entries)
      this.players.releaseReservedId(entry.netId)
    for (const [id, reservation] of this.qwdReservations) {
      if (
        reservation.playerIds.size === roster.entries.length &&
        roster.entries.every(entry =>
          reservation.playerIds.has(entry.uuid.toString())
        )
      ) {
        this.qwdReservations.delete(id)
      }
    }
  }
  expireMigrationRosters (now = Date.now()) {
    for (const [key, roster] of this.migrationRosters) {
      if (roster.expiresAt > now) continue
      this.migrationRosters.delete(key)
      for (const entry of roster.entries)
        this.players.releaseReservedId(entry.netId)
    }
  }
  handleQwdCommand (command) {
    this.packetDebug.logChannel(
      'qwdCommand',
      {
        cmd: command?.cmd,
        roomId: command?.data?.roomId
      },
      'qwd command'
    )
    this.expireQwdReservations()
    return dispatchQwdCommand(command, this)
  }
  reservedSlots () {
    let total = 0
    for (const reservation of this.qwdReservations.values())
      total += reservation.playerIds.size
    return total
  }
  hasReservationCapacity (count) {
    return this.players.size + this.reservedSlots() + count <= this.roomCapacity
  }
  findReservationByPlayer (playerId) {
    const wanted = String(playerId)
    for (const [reservationId, reservation] of this.qwdReservations) {
      if (reservation.playerIds.has(wanted)) return reservationId
    }
    return undefined
  }
  expireQwdReservations (now = Date.now()) {
    for (const [moveId, reservation] of this.qwdReservations) {
      if (reservation.expiresAt > now) continue
      this.qwdReservations.delete(moveId)
      this.qwd.publish('reservation.expired', {
        roomId: this.config.id,
        moveId,
        playerIds: [...reservation.playerIds]
      })
    }
  }
  consumeQwdReservation (playerId) {
    for (const [moveId, reservation] of this.qwdReservations) {
      if (!reservation.playerIds.has(String(playerId))) continue
      reservation.joined.add(String(playerId))
      if (reservation.joined.size >= reservation.playerIds.size) {
        this.qwdReservations.delete(moveId)
        this.qwd.publish('move.completed', {
          roomId: this.config.id,
          moveId,
          playerIds: [...reservation.playerIds]
        })
      }
    }
  }
  publishQwdTelemetry () {
    const now = Date.now()
    if (now - this.lastQwdTelemetryAt < 1000) return
    this.lastQwdTelemetryAt = now
    const active = this.players.listActive()
    const players = active.map(player => ({
      playerId: player.uuid.toString(),
      levelId: player.levelId,
      position: player.playerDelta.decodedState?.fields?.position,
      velocity: player.playerDelta.decodedState?.fields?.move?.velocity
        ? Math.hypot(...player.playerDelta.decodedState.fields.move.velocity)
        : undefined,
      stateAt: player.playerDelta.stats.lastReadAt ?? player.lastSeenAt,
      lastMoveAt: player.lastSeenAt,
      affinity: Object.fromEntries(
        (player.lastAffinity?.entries ?? [])
          .map(entry => {
            const peer = active.find(
              candidate => candidate.id === entry.netPlayerId
            )
            return peer
              ? [
                  peer.uuid.toString(),
                  Math.max(0, Math.min(1, Number(entry.value) / 255))
                ]
              : null
          })
          .filter(Boolean)
      )
    }))
    const seq = this.telemetrySeq + 1
    const previous = this.lastTelemetryRoster
    const current = new Map()
    for (const player of players) current.set(player.playerId, player)
    const canDelta =
      previous !== null &&
      previous.size > 0 &&
      seq - this.lastFullTelemetrySeq < TELEMETRY_FULL_RESYNC_FRAMES &&
      now - this.lastFullTelemetryAt < TELEMETRY_FULL_RESYNC_MS
    if (!canDelta) {
      this.telemetrySeq = seq
      this.qwd.publishTelemetry(players, seq)
      this.lastTelemetryRoster = current
      this.lastFullTelemetrySeq = seq
      this.lastFullTelemetryAt = now
      this.lastTelemetrySeqSent = seq
      this.lastTelemetrySentAt = new Map(
        players.map(player => [player.playerId, now])
      )
      return
    }
    const changed = []
    for (const [playerId, player] of current) {
      const before = previous.get(playerId)
      const sentAt = this.lastTelemetrySentAt.get(playerId) ?? 0
      if (
        !before ||
        !this.sameTelemetry(before, player) ||
        now - sentAt >= TELEMETRY_PLAYER_KEEPALIVE_MS
      ) {
        changed.push(player)
      }
    }
    const removed = []
    for (const playerId of previous.keys()) {
      if (!current.has(playerId)) removed.push(playerId)
    }
    if (changed.length === 0 && removed.length === 0) {
      this.lastTelemetryRoster = current
      return
    }
    this.telemetrySeq = seq
    this.qwd.publishTelemetry(changed, seq, {
      kind: 'delta',
      baseSeq: this.lastTelemetrySeqSent,
      removedPlayers: removed
    })
    this.lastTelemetryRoster = current
    this.lastTelemetrySeqSent = seq
    for (const player of changed)
      this.lastTelemetrySentAt.set(player.playerId, now)
    for (const playerId of removed) this.lastTelemetrySentAt.delete(playerId)
  }
  sameTelemetry (a, b) {
    if (a.levelId !== b.levelId) return false
    if (a.velocity !== b.velocity) return false
    const ap = a.position
    const bp = b.position
    if (!ap !== !bp) return false
    if (ap && bp && (ap[0] !== bp[0] || ap[1] !== bp[1] || ap[2] !== bp[2]))
      return false
    return this.sameAffinity(a.affinity, b.affinity)
  }
  sameAffinity (a, b) {
    const ak = a ? Object.keys(a) : []
    const bk = b ? Object.keys(b) : []
    if (ak.length !== bk.length) return false
    for (const key of ak) {
      if (!b || b[key] !== a[key]) return false
    }
    return true
  }
}
