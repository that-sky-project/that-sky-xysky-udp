// Async audience lanes do not overlap, but do not delay the packet/state tick.
// Shutdown stops scheduling first and awaits every outstanding lane before cleanup.
export class RoomTick {
  #tasks = new Map()
  #closed = false
  #lastFrameAt = 0
  #lastTimelineAt = 0

  constructor ({ players, sessions, metrics, gameMessageService, moveService,
    audienceService, performanceAuthority, liveBroadcastService,
    audienceReactionService, audienceChatGlobalService, reservations,
    migrationRosters, telemetry, logger, now = Date.now }) {
    this.players = players
    this.sessions = sessions
    this.metrics = metrics
    this.gameMessageService = gameMessageService
    this.moveService = moveService
    this.audienceService = audienceService
    this.performanceAuthority = performanceAuthority
    this.liveBroadcastService = liveBroadcastService
    this.audienceReactionService = audienceReactionService
    this.audienceChatGlobalService = audienceChatGlobalService
    this.reservations = reservations
    this.migrationRosters = migrationRosters
    this.telemetry = telemetry
    this.logger = logger
    this.now = now
  }

  #schedule (lane, operation, message, severity = 'warn') {
    if (this.#closed || this.#tasks.has(lane)) return
    const task = Promise.resolve().then(operation)
      .catch(error => this.logger[severity]?.({ err: error }, message))
      .finally(() => this.#tasks.delete(lane))
    this.#tasks.set(lane, task)
  }

  tick () {
    if (this.#closed) return
    this.audienceReactionService.tick()
    this.#schedule('chat', () => {
      const chat = this.audienceChatGlobalService
      return chat.enqueue(() => chat.tick())
    }, 'global chat tick failed')
    this.#schedule('performance', async () => {
      const authority = this.performanceAuthority
      await authority.enqueue(() => authority.tick())
      const live = this.liveBroadcastService
      await live.enqueue(() => live.tick())
    }, 'performance tick failed')
    this.migrationRosters.expire()
    this.reservations.expire()
    this.moveService.expireStuckMoves()
    this.metrics.connectedPeers.set(this.sessions.size)
    this.metrics.onlinePlayers.set(this.players.size)
    this.gameMessageService.syncPlayerStates()
    this.gameMessageService.syncLevelData()
    this.gameMessageService.sendSnapshotAcks()
    this.telemetry.publish()
    const now = this.now()
    if (this.audienceService.rosters.size === 0) return
    this.audienceService.feedLocalPositions(now / 1000,
      playerId => this.players.getByUuid(playerId)?.playerDelta?.decodedState?.fields?.position)
    if (now - this.#lastFrameAt >= 1000) {
      this.#lastFrameAt = now
      this.#schedule('frame', () => this.audienceService.broadcastFrame(now / 1000), 'audience frame failed', 'debug')
    }
    if (now - this.#lastTimelineAt >= 2500) {
      this.#lastTimelineAt = now
      this.#schedule('timeline', () => this.audienceService.broadcastTimeline(now / 1000), 'audience timeline failed', 'debug')
    }
  }

  async stop () {
    this.#closed = true
    await Promise.all(this.#tasks.values())
  }
}
