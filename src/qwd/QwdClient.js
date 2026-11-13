import { randomUUID } from 'node:crypto'
import { createRoomId } from '../domain/RoomId.js'
import { ErrorCode } from './errorCodes.js'
import { websocketImpl as productionWebsocketImpl } from './WebSocketAdapter.js'

const OPEN = 1
const QUEUE_LIMIT = 256
const COMMAND_CACHE_LIMIT = 512
const LIVENESS_TICK_MS = 5000
const MANAGER_SILENCE_LIMIT_MS = 20_000

export class QwdClient {
  constructor ({
    url,
    room,
    identity,
    logger,
    onCommand,
    onRoomIdConflict,
    onConnected,
    onTransportDropped,
    snapshot,
    websocketImpl = productionWebsocketImpl,
    backpressureLimitBytes = 1024 * 1024
  }) {
    this.websocketImpl = websocketImpl
    this.backpressureLimitBytes = backpressureLimitBytes
    this.commandResults = new Map()
    this.queuedCommands = 0
    this.connectionEpoch = 0
    this.url = url
    this.room = room
    // Runtime owns this mutable identity. Configuration is never an id fallback.
    this.identity = identity
    this.nodeId = randomUUID()
    this.logger = logger
    this.onCommand = onCommand
    this.onRoomIdConflict = onRoomIdConflict
    this.onConnected = onConnected
    this.onTransportDropped = onTransportDropped
    this.snapshot = snapshot
    this.socket = null
    this.transport = null
    this.listeners = null
    this.queue = []
    this.droppedFrames = 0
    this.connected = false
    this.stopped = true
    this.commandChain = Promise.resolve()
    this.pendingCommandTasks = new Set()
    this.stopPromise = null
    this.stopping = false
    this.lastActivityAt = 0
    this.livenessTimer = null
    this.lastOfflineWarnAt = 0
    this.startedAt = 0
    this.everConnected = false
    this.offlineLogged = false
  }

  start () {
    if (!this.url || !this.stopped || this.stopping) return
    this.stopPromise = null
    this.stopped = false
    this.startedAt = Date.now()
    try {
      const endpoint = new URL(this.url)
      endpoint.searchParams.set('v', '1')
      endpoint.searchParams.set('node', this.nodeId)
      const transport = this.websocketImpl({
        url: endpoint.toString(),
        onActivity: () => { if (!this.stopped && this.transport === transport) this.markAlive() },
        onAttempt: () => {
          if (this.stopped || this.transport !== transport) return
          this.connected = false
          this.stopLivenessWatch()
          this.nextEpoch()
        }
      })
      this.transport = transport
      const socket = this.socket = transport.socket
      const current = () => !this.stopped && this.transport === transport
      this.listeners = {
        open: () => {
          if (!current()) return
          this.nextEpoch()
          this.connected = true
          this.markAlive()
          this.logger.info?.({ endpoint: endpoint.toString(), roomId: this.identity.id }, 'qwd websocket connected')
          const discardedQueuedFrames = this.queue.length
          this.queue.length = 0
          if (discardedQueuedFrames > 0) {
            const fields = { roomId: this.identity.id, discardedQueuedFrames }
            if (this.everConnected) this.logger.warn?.(fields, 'qwd reconnected; discarded queued frames, full resync follows')
            else this.logger.debug?.(fields, 'discarded frames queued before the first connection; full resync follows')
          }
          this.everConnected = true
          this.offlineLogged = false
          this.publish('node.ready', { ...this.occupancy(), timestamp: Date.now() })
          this.announceRoom()
          if (this.connected) {
            this.startLivenessWatch(endpoint.toString())
            this.onConnected?.()
          }
        },
        message: event => {
          if (!current() || !this.connected) return
          this.markAlive()
          this.receiveCommand(event.data, transport, this.connectionEpoch)
        },
        close: event => {
          if (!current()) return
          this.connected = false
          this.nextEpoch()
          this.stopLivenessWatch()
          this.onTransportDropped?.()
          this.logger.warn?.({ code: event.code, reason: event.reason, endpoint: endpoint.toString() }, 'qwd websocket closed')
          // RW alone owns retries and backoff; retain the same RW object.
        },
        error: event => {
          if (!current()) return
          this.logger.warn?.({ err: event.error ?? event, endpoint: endpoint.toString() }, 'qwd websocket error')
          // RW may have called close() on a failed handshake. Bound that native
          // close even when the remote peer never completes the handshake.
          transport.terminate()
        }
      }
      for (const [type, listener] of Object.entries(this.listeners)) socket.addEventListener(type, listener)
      socket.reconnect()
    } catch (error) {
      void this.stop().catch(cleanupError => this.logger.error?.({ err: cleanupError }, 'qwd startup cleanup failed'))
      throw error
    }
  }

  stop () {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopped = true
    this.connected = false
    this.nextEpoch()
    this.stopLivenessWatch()
    const transport = this.transport
    if (this.socket && this.listeners) {
      for (const [type, listener] of Object.entries(this.listeners)) this.socket.removeEventListener(type, listener)
    }
    this.listeners = null
    this.transport = null
    this.socket = null
    this.queue.length = 0
    transport?.dispose()
    // Include commands from retired connection epochs, not only the current
    // commandChain. Runtime awaits this before clearing its domain stores.
    this.stopPromise = Promise.allSettled([...this.pendingCommandTasks]).then(() => {
      this.stopping = false
    })
    return this.stopPromise
  }

  nextEpoch () {
    this.connectionEpoch++
    this.commandResults.clear()
    this.queuedCommands = 0
    this.commandChain = Promise.resolve()
  }

  isCurrent (transport, epoch) {
    return !this.stopped && this.connected && this.transport === transport && this.connectionEpoch === epoch && this.socket?.readyState === OPEN
  }

  dropTransport (transport = this.transport) {
    if (!transport || transport !== this.transport || this.stopped) return
    this.connected = false
    this.nextEpoch()
    this.stopLivenessWatch()
    transport.terminate()
  }

  publish (event, data) {
    const message = JSON.stringify({ v: 1, event, data })
    const control = event.startsWith('performance.') || event.startsWith('liveBroadcast.') || event === 'audience.reaction'
    const online = this.connected && this.socket?.readyState === OPEN
    if (control && !online) {
      this.logger.warn?.({ event }, 'QWD control send rejected: offline')
      return false
    }
    if (online && this.socket.bufferedAmount + Buffer.byteLength(message) > this.backpressureLimitBytes) {
      this.logger.warn?.({ event }, 'QWD send rejected: backpressure')
      return false
    }
    if (!online) {
      const at = Date.now()
      const worthWarning = this.everConnected || (this.startedAt > 0 && at - this.startedAt >= 10_000)
      if (this.url && !this.stopped && worthWarning && at - this.lastOfflineWarnAt >= 30_000) {
        this.lastOfflineWarnAt = at
        this.logger.warn?.({ roomId: this.identity.id, event, queued: this.queue.length }, 'qwd offline; frames are queued and the manager will be resynced on reconnect')
      } else if (!this.everConnected && !this.offlineLogged) {
        this.offlineLogged = true
        this.logger.debug?.({ roomId: this.identity.id, event }, 'waiting for the qwd connection')
      }
      const entry = { event, data: JSON.parse(message).data }
      if (event === 'room.telemetry') {
        const index = this.queue.findIndex(entry => entry.event === event)
        if (index >= 0) { this.queue[index] = entry; return true }
      }
      if (this.queue.length >= QUEUE_LIMIT) {
        this.droppedFrames++
        if (this.droppedFrames === 1 || this.droppedFrames % 100 === 0) this.logger.warn?.({ dropped: this.droppedFrames, event }, 'qwd publish queue full; frame dropped')
        return false
      }
      this.queue.push(entry)
      return true
    }
    return this.send(message, { event })
  }

  send (message, fields, transport = this.transport, epoch = this.connectionEpoch) {
    if (!this.isCurrent(transport, epoch)) return false
    let failed = false
    try {
      const accepted = transport.send(message, error => {
        if (!error || !this.isCurrent(transport, epoch)) return
        failed = true
        this.logger.warn?.({ err: error, ...fields }, 'QWD send failed')
        this.dropTransport(transport)
      })
      if (accepted === false) {
        this.logger.warn?.(fields, 'QWD send rejected: native socket offline')
        this.dropTransport(transport)
        return false
      }
      return !failed
    } catch (error) {
      this.logger.warn?.({ err: error, ...fields }, 'QWD send failed')
      this.dropTransport(transport)
      return false
    }
  }

  publishTelemetry (players, seq = 0, framing = null) {
    const data = { roomId: this.identity.id, seq, players, timestamp: Date.now(), ...this.occupancy() }
    if (framing?.kind === 'delta') {
      data.kind = 'delta'
      data.baseSeq = framing.baseSeq
      data.removedPlayers = framing.removedPlayers ?? []
    }
    return this.publish('room.telemetry', data)
  }

  occupancy () {
    const state = this.snapshot?.() ?? {}
    const capacity = state.capacity ?? this.room.maxPeers ?? 8
    const players = state.players ?? 0
    return { capacity, load: capacity > 0 ? Math.min(1, players / capacity) : 0 }
  }

  announceRoom () {
    const state = this.snapshot?.() ?? {}
    return this.publish('room.created', {
      roomId: this.identity.id,
      udpHost: this.room.publicHost,
      port: this.room.publicPort,
      capacity: state.capacity ?? 8,
      players: state.players ?? 0,
      version: state.version ?? 1
    })
  }

  receiveCommand (data, transport, epoch) {
    let command
    try {
      command = JSON.parse(data.toString())
      if (!command?.cmd) return
      if (typeof command !== 'object' || Array.isArray(command) || command.v !== 1 ||
        typeof command.cmd !== 'string' || !command.cmd.trim() ||
        !Number.isSafeInteger(command.id) || command.id < 0 ||
        (command.data !== undefined && (command.data === null || typeof command.data !== 'object' || Array.isArray(command.data)))) {
        throw new Error('invalid QWD command envelope')
      }
    } catch (error) {
      this.logger.warn?.({ err: error }, 'invalid qwd command')
      return
    }
    if (this.queuedCommands >= QUEUE_LIMIT) {
      this.sendAck(command.id, ErrorCode.INTERNAL, { message: 'command queue full' }, this.socket, epoch)
      return
    }
    this.queuedCommands++
    const task = this.commandChain.then(async () => {
      if (!this.isCurrent(transport, epoch)) return
      const fingerprint = JSON.stringify(command)
      let cached = this.commandResults.get(command.id)
      if (cached && cached.fingerprint !== fingerprint) throw new Error('command id reused with different content')
      if (!cached) {
        let result
        try {
          if (command.cmd === 'room.id_conflict') {
            const previousId = this.identity.id
            const newId = createRoomId()
            // The runtime callback is the sole identity writer.
            await this.onRoomIdConflict?.(newId, previousId)
            if (!this.isCurrent(transport, epoch)) return
            this.logger.warn?.({ previousRoomId: previousId, roomId: this.identity.id }, 'qwd room id conflict; regenerated room id')
            this.announceRoom()
            result = { code: ErrorCode.OK }
          } else result = await this.onCommand?.(command)
        } catch (error) {
          result = { code: ErrorCode.INTERNAL, data: { message: error?.message ?? String(error) } }
        }
        if (!this.isCurrent(transport, epoch)) return
        cached = { fingerprint, code: result?.code ?? 0, data: result?.data }
        this.commandResults.set(command.id, cached)
        while (this.commandResults.size > COMMAND_CACHE_LIMIT) this.commandResults.delete(this.commandResults.keys().next().value)
      }
      this.sendAck(command.id, cached.code, cached.data, this.socket, epoch)
    }).catch(error => {
      this.sendAck(command.id, ErrorCode.INTERNAL, { message: error.message }, this.socket, epoch)
    }).finally(() => {
      if (epoch === this.connectionEpoch) this.queuedCommands--
      this.pendingCommandTasks.delete(task)
    })
    this.pendingCommandTasks.add(task)
    this.commandChain = task
  }

  startLivenessWatch (endpoint) {
    this.stopLivenessWatch()
    this.livenessTimer = setInterval(() => {
      if (!this.connected || this.socket?.readyState !== OPEN) return
      const silentFor = Date.now() - this.lastActivityAt
      if (silentFor > MANAGER_SILENCE_LIMIT_MS) {
        this.logger.warn?.({ endpoint, silentForMs: silentFor }, 'qwd silent too long; dropping connection')
        this.dropTransport()
        return
      }
      try { this.transport.ping() } catch (error) {
        this.logger.debug?.({ err: error, endpoint }, 'qwd heartbeat ping failed')
        this.dropTransport()
      }
    }, LIVENESS_TICK_MS)
    this.livenessTimer.unref?.()
  }

  stopLivenessWatch () {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }

  markAlive (now = Date.now()) { this.lastActivityAt = now }

  sendAck (id, code, data, socket = this.socket, epoch = this.connectionEpoch) {
    if (socket !== this.socket || !this.isCurrent(this.transport, epoch) || !Number.isSafeInteger(id) || id < 0) return false
    const message = JSON.stringify({ v: 1, id, code, data })
    if (socket.bufferedAmount + Buffer.byteLength(message) > this.backpressureLimitBytes) {
      this.logger.warn?.({ id }, 'QWD ACK rejected: backpressure')
      this.dropTransport()
      return false
    }
    return this.send(message, { id }, this.transport, epoch)
  }
}
