import { PacketCodec } from '../protocol/PacketCodec.js'
import { AudienceCodec } from '../protocol/AudienceCodec.js'
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
import { AudienceChatGlobalService } from '../features/audience/AudienceChatGlobalService.js'
import { IndependentLiveBroadcastService } from '../features/audience/LiveBroadcastService.js'
import { QwdClient } from '../qwd/QwdClient.js'
import { RoomIdentity } from '../qwd/RoomIdentity.js'
import { QwdTelemetry } from '../qwd/QwdTelemetry.js'
import { RoomReservations } from '../qwd/RoomReservations.js'
import { MigrationRosters } from '../qwd/MigrationRosters.js'
import { PacketDebugLog } from '../observability/debugPackets.js'
import { PeerEventHandler } from './PeerEventHandler.js'
import { TickLoop } from './TickLoop.js'
import { RoomTick } from './RoomTick.js'
import { RoomServer } from './RoomServer.js'
import { AuthorityElectionGate } from './AuthorityElectionCoordinator.js'
import { dispatchQwdCommand } from './QwdCommands.js'
import { attachPerformanceAuthority, createAudienceSender } from './audiencePorts.js'
import { createPlayerLifecycle } from './playerLifecycle.js'

const ROOM_CAPACITY = 8

export function createRoomApplication ({ config, logger, metrics, onFatalError }) {
  const identity = new RoomIdentity()
  const room = config.room
  const codec = new PacketCodec()
  const packetDebug = new PacketDebugLog({ logger, enabled: config.debug.packets, channels: config.debug.channels })
  const sessions = new ConnectionManager({ roomId: identity.id })
  const players = new PlayerStore({ maxPlayers: ROOM_CAPACITY })
  const levels = new LevelStateStore({ roomId: identity.id, logger })
  const rooms = new RoomDirectory()
  const transport = new EnetServer({ ...room, logger })
  const broadcaster = new BroadcastService({ codec, transport, sessions, metrics, packetDebug })
  const levelService = new LevelService({ players, levels, broadcaster, logger })

  // QWD callbacks are deferred until start; all domain services are complete then.
  let qwd
  const publish = (event, data) => qwd.publish(event, data)
  const reservations = new RoomReservations({ players, identity, publish })
  const migrationRosters = new MigrationRosters({ players, reservations, logger })
  const telemetry = new QwdTelemetry({ players, publishTelemetry: (...args) => qwd.publishTelemetry(...args) })
  const sessionOf = playerId => players.getByUuid(playerId)?.session ?? null
  const audienceCodec = new AudienceCodec()
  const audienceService = new AudienceService({
    logger, packetDebug,
    currentLevelOf: playerId => players.getByUuid(playerId)?.levelId,
    barnClock: () => Date.now() / 1000,
    sendToClient: createAudienceSender({ players, transport, codec: audienceCodec, packetDebug }),
    onPositionChanged: (playerId, roster, position, levelTime) => publish('seat.occupied', {
      roomId: identity.id, player: { playerId }, levelId: roster.levelId ?? 0,
      benchId: roster.benchId, seatId: roster.seatId, position, levelTime
    })
  })
  const authorityPorts = {
    audience: audienceService, publish, roomId: () => identity.id, sessionOf,
    levels: () => players.listActive().map(player => player.levelId), logger
  }
  const performanceAuthority = new PerformanceAuthority(authorityPorts)
  attachPerformanceAuthority(audienceService, performanceAuthority)
  const liveBroadcastService = new IndependentLiveBroadcastService(authorityPorts)
  const audienceReactionService = new AudienceReactionService(authorityPorts)
  const audienceChatGlobalService = new AudienceChatGlobalService({ audience: audienceService, logger })
  const moveService = new MoveService({
    players, rooms, broadcaster, transport, levelService, logger,
    moveTimeoutMs: room.moveTimeoutMs,
    onMoveResult: (move, accepted) => {
      if (!move.transactionId) return
      publish('move.result', {
        roomId: identity.id, moveId: move.transactionId, accepted,
        movedPlayerIds: accepted ? [move.playerUuid] : [],
        failedPlayerIds: accepted ? [] : [move.playerUuid],
        reason: accepted ? undefined : `client_move_result_${move.result}`
      })
    }
  })
  const playerLifecycle = createPlayerLifecycle({
    identity, publish, audience: audienceService, sessions, transport, broadcaster, moveService, reservations
  })
  const joinService = new JoinService({
    players, levels, levelService, broadcaster, logger, metrics, migration: migrationRosters,
    onPlayerJoined: playerLifecycle.joined, onEvict: playerLifecycle.evicted
  })
  const gameMessageService = new GameMessageService({
    players, levels, broadcaster, logger, stateDecode: room.playerStateDecode, packetDebug,
    onAudienceState: sample => audienceReactionService.collect(sample)
  })
  const authorityElectionGate = new AuthorityElectionGate()
  levels.onAuthorityElected((levelId, authority, targetPlayer) => {
    if (authorityElectionGate.isSuppressed(levelId)) return
    const targets = targetPlayer ? [targetPlayer] : players.listActiveInLevel(levelId).filter(player => player.levelReady)
    for (const player of targets) {
      gameMessageService.sendElect(player, authority, levels.loadLevelData(levelId))
      player.lastAuthoritySync = `${levelId}:${player.lvSeq}:${authority.id}:${levels.getAuthorityVersion(levelId)}`
    }
  })
  const dispatcher = new PacketDispatcher({ context: Object.freeze({
    joinService, levelService, gameMessageService, audienceService, moveService,
    broadcaster, logger, clock: () => Date.now() / 1000, transport
  }) })
  registerAllHandlers(dispatcher)
  const peerHandler = new PeerEventHandler({
    config: room, sessions, codec, dispatcher, players, levelService, moveService,
    audienceService, broadcaster, transport, metrics, logger, packetDebug,
    onPlayerLeft: playerLifecycle.notifyLeft
  })
  const commands = Object.freeze({
    identity, players, reservations, telemetry, migrationRosters, moveService,
    audienceService, performanceAuthority, liveBroadcastService,
    audienceReactionService, audienceChatGlobalService,
    qwd: { publish }
  })
  const disconnected = () => {
    reservations.transportDropped()
    audienceReactionService.disconnected()
    for (const [name, service] of [
      ['global chat', audienceChatGlobalService], ['live broadcast', liveBroadcastService], ['performance', performanceAuthority]
    ]) {
      service.enqueue(() => service.disconnected())
        .catch(error => logger.warn({ err: error }, `${name} disconnect cleanup failed`))
    }
  }
  qwd = new QwdClient({
    url: config.qwd.url, room, identity, logger,
    snapshot: () => ({ players: players.size, version: telemetry.version, capacity: ROOM_CAPACITY }),
    onCommand: command => {
      packetDebug.logChannel('qwdCommand', { cmd: command?.cmd, roomId: command?.data?.roomId }, 'qwd command')
      reservations.expire()
      return dispatchQwdCommand(command, commands)
    },
    onRoomIdConflict: roomId => {
      identity.id = roomId
      sessions.setRoomId(roomId)
      levels.roomId = roomId
    },
    onConnected: () => {
      logger.info({ roomId: identity.id, players: players.size }, 'qwd connected; forcing full telemetry resync')
      telemetry.forceFull()
      performanceAuthority.connected()
      liveBroadcastService.connected()
    },
    onTransportDropped: disconnected
  })
  const tick = new RoomTick({
    players, sessions, metrics, gameMessageService, moveService, audienceService,
    performanceAuthority, liveBroadcastService, audienceReactionService,
    audienceChatGlobalService, reservations, migrationRosters, telemetry, logger
  })
  const tickLoop = new TickLoop({ tickRate: room.tickRate, onTick: () => tick.tick(), logger })
  return new RoomServer({
    identity, transport, qwd, tickLoop, tick, peerHandler, performanceAuthority,
    liveBroadcastService, audienceReactionService, audienceChatGlobalService,
    sessions, players, reservations, migrationRosters, logger, onFatalError
  })
}
