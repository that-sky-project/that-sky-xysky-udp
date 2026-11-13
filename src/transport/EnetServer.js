import { EventEmitter } from 'node:events'
import { Server } from 'sky-enet'

export class EnetServer extends EventEmitter {
  #state = 'new'
  #startPromise = null
  #stopPromise = null
  #createTask = null
  #rejectReady = null
  #nativeListeners = []
  #failure = null

  constructor ({ host, port, maxPeers, channels, logger, createServer = options => Server.create(options) }) {
    super()
    this.host = host
    this.port = port
    this.maxPeers = maxPeers
    this.channels = channels
    this.logger = logger
    this.createServer = createServer
    this.server = null
    this.listenTask = null
  }

  start () {
    if (this.#state === 'starting' || this.#state === 'running') return this.#startPromise
    if (this.#state !== 'new') return Promise.reject(new Error('ENet transport is single-use; create a new transport to restart'))
    this.#state = 'starting'
    this.#startPromise = this.#start()
    return this.#startPromise
  }

  async #start () {
    try {
      this.#createTask = Promise.resolve().then(() => this.createServer({
        ip: this.host, port: this.port, maxPeer: this.maxPeers,
        channelLimit: this.channels, checksum: true
      }))
      this.server = await this.#createTask
      if (this.#state !== 'starting') throw new Error('ENet startup cancelled')
      const native = this.server
      await new Promise((resolve, reject) => {
        this.#rejectReady = reject
        const ready = () => {
          if (this.#state !== 'starting' || this.#failure) return
          this.#state = 'running'
          this.#rejectReady = null
          this.emit('ready')
          resolve()
        }
        this.#nativeListeners = [
          ['ready', ready],
          ['connect', event => this.emit('peer:connect', event.peer)],
          ['disconnect', event => this.emit('peer:disconnect', event.peer, event.data)],
          ['receive', event => this.emit('peer:message', event.peer, event.data, event.channelID)],
          ['error', error => this.#reportFailure(error)]
        ]
        for (const [event, listener] of this.#nativeListeners) native.on(event, listener)
        // Native listen catches service errors and may resolve instead of reject.
        // Both rejection and an unexpected normal exit are fatal, including before ready.
        this.listenTask = Promise.resolve().then(() => {
          if (this.#state !== 'starting') return
          return native.listen()
        }).then(() => {
          if (this.#state !== 'stopping' && this.#state !== 'stopped') {
            this.#reportFailure(new Error('ENet listen loop exited unexpectedly'))
          }
        }, error => this.#reportFailure(error))
      })
    } catch (error) {
      if (this.#state !== 'stopping' && this.#state !== 'stopped') this.#reportFailure(error)
      throw error
    } finally {
      this.#rejectReady = null
    }
  }

  #reportFailure (error) {
    if (this.#failure) return
    this.#failure = error
    this.#rejectReady?.(error)
    this.logger.error({ err: error }, 'enet transport failed')
    if (this.listenerCount('error') > 0) this.emit('error', error)
  }

  stop () {
    if (this.#stopPromise) return this.#stopPromise
    this.#state = 'stopping'
    this.#rejectReady?.(new Error('ENet startup cancelled'))
    this.#stopPromise = this.#stop()
    return this.#stopPromise
  }

  async #stop () {
    const errors = []
    try {
      // Creation can be in flight when a signal arrives. Never lose that host.
      if (this.#createTask) {
        try { this.server = await this.#createTask } catch { /* startup reports creation errors */ }
      }
      const native = this.server
      if (!native) return
      try { native.stop() } catch (error) { errors.push(error) }
      // sky-enet stop clears its loop flag; destroy must follow the final poll/yield.
      try { await this.listenTask } catch (error) { errors.push(error) }
      try { native.destroy() } catch (error) { errors.push(error) }
      for (const [event, listener] of this.#nativeListeners) native.off(event, listener)
      if (errors.length) throw new AggregateError(errors, 'ENet shutdown failed')
    } finally {
      this.server = null
      this.listenTask = null
      this.#nativeListeners = []
      this.#state = 'stopped'
    }
  }

  send (peerId, buffer, { channel = 0, reliable = true } = {}) {
    if (!this.server) return -1
    // Native ENet returns 0 on successful queuing, negative on failure.
    return this.server.send(peerId, channel, buffer, reliable)
  }

  disconnect (peerId, mode = 'now', data = 0) {
    if (!this.server) return
    if (mode === 'later') this.server.disconnectLater(peerId, data)
    else if (mode === 'normal') this.server.disconnect(peerId, data)
    else this.server.disconnectNow(peerId, data)
  }
}
