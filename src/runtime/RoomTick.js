export class RoomTick {
  #closed = false

  constructor ({ players, sessions, metrics, gameMessageService, moveService,
    reservations, migrationRosters, telemetry }) {
    this.players = players
    this.sessions = sessions
    this.metrics = metrics
    this.gameMessageService = gameMessageService
    this.moveService = moveService
    this.reservations = reservations
    this.migrationRosters = migrationRosters
    this.telemetry = telemetry
  }

  tick () {
    if (this.#closed) return
    this.migrationRosters.expire()
    this.reservations.expire()
    this.moveService.expireStuckMoves()
    this.metrics.connectedPeers.set(this.sessions.size)
    this.metrics.onlinePlayers.set(this.players.size)
    this.gameMessageService.syncPlayerStates()
    this.gameMessageService.syncLevelData()
    this.gameMessageService.sendSnapshotAcks()
    this.telemetry.publish()
  }

  async stop () {
    this.#closed = true
  }
}
