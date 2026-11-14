// Single-use lifecycle. Service construction and all domain wiring live in composition.
export class RoomServer {
  #state = 'new'
  #startPromise = null
  #stopPromise = null
  #fatalReported = false
  #listeners

  constructor ({ identity, transport, qwd, tickLoop, tick, peerHandler,
    sessions, players, reservations, migrationRosters, logger, onFatalError }) {
    this.identity = identity
    this.transport = transport
    this.qwd = qwd
    this.tickLoop = tickLoop
    this.tick = tick
    this.peerHandler = peerHandler
    this.sessions = sessions
    this.players = players
    this.reservations = reservations
    this.migrationRosters = migrationRosters
    this.logger = logger
    this.onFatalError = onFatalError
    const accepting = () => this.#state === 'starting' || this.#state === 'running'
    this.#listeners = [
      ['peer:connect', peerId => { if (accepting()) peerHandler.onConnect(peerId) }],
      ['peer:message', (peerId, data, channel) => { if (accepting()) peerHandler.onMessage(peerId, data, channel) }],
      ['peer:disconnect', (peerId, data) => { if (accepting()) peerHandler.onDisconnect(peerId, data) }],
      ['error', error => {
        logger.error({ err: error }, 'room transport failed')
        if (!accepting() || this.#fatalReported) return
        this.#fatalReported = true
        // Parent owns process shutdown; do not await it inside the listen task.
        try {
          Promise.resolve(onFatalError?.(error)).catch(failure => logger.error({ err: failure }, 'fatal error callback failed'))
        } catch (failure) {
          logger.error({ err: failure }, 'fatal error callback failed')
        }
      }]
    ]
    for (const [event, listener] of this.#listeners) transport.on(event, listener)
  }

  get roomId () { return this.identity.id }

  start () {
    if (this.#state === 'starting' || this.#state === 'running') return this.#startPromise
    if (this.#state !== 'new') return Promise.reject(new Error('Room application is single-use; create a new application to restart'))
    this.#state = 'starting'
    this.#startPromise = this.#start()
    return this.#startPromise
  }

  async #start () {
    try {
      // A destination must be listening before QWD can advertise/register it.
      await this.transport.start()
      if (this.#state !== 'starting') throw new Error('Room startup cancelled')
      await this.qwd.start()
      if (this.#state !== 'starting') throw new Error('Room startup cancelled')
      this.tickLoop.start()
      this.#state = 'running'
    } catch (error) {
      try { await this.stop() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Room startup and cleanup failed')
      }
      throw error
    }
  }

  stop () {
    if (this.#stopPromise) return this.#stopPromise
    this.#state = 'stopping'
    this.#stopPromise = this.#stop()
    return this.#stopPromise
  }

  async #stop () {
    const errors = []
    const attempt = async operation => {
      try { await operation() } catch (error) { errors.push(error) }
    }
    try {
      // Disable scheduling and inputs before draining async work. QWD stop drains
      // every epoch's command callbacks before mutable room state is cleared.
      const qwdStopped = Promise.resolve().then(() => this.qwd.stop())
      qwdStopped.catch(() => {}) // Observed immediately; aggregated below after tick lanes drain.
      await attempt(() => this.tickLoop.stop())
      await attempt(() => this.tick.stop())
      await attempt(() => qwdStopped)
      // Reuse normal disconnect ownership; never duplicate PlayerLeft broadcasts
      // or domain removal in composition. Fallback ensures failed handlers cannot
      // leave sessions/player indexes alive after shutdown.
      for (const session of this.sessions.list()) {
        await attempt(() => this.peerHandler.onDisconnect(session.peerId, 'shutdown'))
        await attempt(() => this.players.removeBySession(session))
        await attempt(() => this.sessions.remove(session.peerId))
      }
      await attempt(() => this.migrationRosters.clear())
      await attempt(() => this.reservations.clear())
      await attempt(() => this.transport.stop())
    } finally {
      for (const [event, listener] of this.#listeners) this.transport.off(event, listener)
      this.#state = 'stopped'
    }
    if (errors.length) throw new AggregateError(errors, 'Room shutdown failed')
  }
}
