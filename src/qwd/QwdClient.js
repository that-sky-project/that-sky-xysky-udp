import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { createRoomId } from '../domain/RoomId.js'
import { ErrorCode } from './errorCodes.js'
const QUEUE_LIMIT = 256
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const LIVENESS_TICK_MS = 5000
const MANAGER_SILENCE_LIMIT_MS = LIVENESS_TICK_MS * 4
const STABLE_CONNECTION_MS = 10_000
export class QwdClient {
  constructor ({
    url,
    room,
    logger,
    onCommand,
    onRoomIdConflict,
    onConnected,
    onTransportDropped,
    snapshot,
    socketFactory = (url, options) => new WebSocket(url, options),
    backpressureLimitBytes = 1024 * 1024
  }) {
    this.socketFactory = socketFactory
    this.backpressureLimitBytes = backpressureLimitBytes
    this.commandResults = new Map()
    this.queuedCommands = 0
    this.connectionEpoch = 0
    this.url = url
    this.room = room
    this.nodeId = randomUUID()
    this.logger = logger
    this.onCommand = onCommand
    this.onRoomIdConflict = onRoomIdConflict
    this.onConnected = onConnected
    this.onTransportDropped = onTransportDropped
    this.snapshot = snapshot
    this.socket = null
    this.queue = []
    this.droppedFrames = 0
    this.connected = false
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.stopped = true
    this.commandChain = Promise.resolve()
    this.lastActivityAt = 0
    this.connectedAt = 0
    this.livenessTimer = null
    this.lastOfflineWarnAt = 0
    this.startedAt = 0
    this.everConnected = false
    this.offlineLogged = false
  }
  start () {
    if (!this.url) return
    this.stopped = false
    this.startedAt = Date.now()
    this.connect()
  }
  stop () {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopLivenessWatch()
    this.reconnectTimer = null
    this.socket?.removeAllListeners?.()
    this.socket?.close()
    this.socket = null
    this.connected = false
  }
  publish (event, data) {
    const message = JSON.stringify({ v: 1, event, data })
    const performance = event.startsWith('performance.') || event === 'audience.reaction'
    if (performance && (!this.connected || this.socket?.readyState !== WebSocket.OPEN)) {
      this.logger.warn?.({ event }, 'QWD control send rejected: offline')
      return false
    }
    if (this.socket?.readyState === WebSocket.OPEN &&
      this.socket.bufferedAmount + Buffer.byteLength(message) > this.backpressureLimitBytes) {
      this.logger.warn?.({ event }, 'QWD send rejected: backpressure')
      return false
    }
    if (
      !this.connected ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      const at = Date.now()
      const worthWarning =
        this.everConnected ||
        (this.startedAt > 0 && at - this.startedAt >= 10_000)
      if (
        this.url &&
        !this.stopped &&
        worthWarning &&
        at - this.lastOfflineWarnAt >= 30_000
      ) {
        this.lastOfflineWarnAt = at
        this.logger.warn?.(
          { roomId: this.room.id, event, queued: this.queue.length },
          'qwd offline; frames are queued and the manager will be resynced on reconnect'
        )
      } else if (!this.everConnected && !this.offlineLogged) {
        this.offlineLogged = true
        this.logger.debug?.(
          { roomId: this.room.id, event },
          'waiting for the qwd connection'
        )
      }
      if (event === 'room.telemetry') {
        const index = this.queue.findIndex(entry =>
          entry.startsWith('{"v":1,"event":"room.telemetry"')
        )
        if (index >= 0) {
          this.queue[index] = message
          return
        }
      }
      if (this.queue.length >= QUEUE_LIMIT) {
        this.droppedFrames += 1
        if (this.droppedFrames === 1 || this.droppedFrames % 100 === 0) {
          this.logger.warn?.(
            { dropped: this.droppedFrames, event },
            'qwd publish queue full; frame dropped'
          )
        }
        return
      }
      this.queue.push(message)
      return
    }
    const socket = this.socket
    try {
      socket.send(message, error => {
        if (error && this.socket === socket) {
          this.logger.warn?.({ err: error, event }, 'QWD send failed')
          socket.terminate()
        }
      })
      return true
    } catch (error) {
      this.logger.warn?.({ err: error, event }, 'QWD send failed')
      socket.terminate()
      return false
    }
  }
  publishTelemetry (players, seq = 0, framing = null) {
    const data = {
      roomId: this.room.id,
      seq,
      players,
      timestamp: Date.now(),
      ...this.occupancy()
    }
    if (framing?.kind === 'delta') {
      data.kind = 'delta'
      data.baseSeq = framing.baseSeq
      data.removedPlayers = framing.removedPlayers ?? []
    }
    this.publish('room.telemetry', data)
  }
  occupancy () {
    const state = this.snapshot?.() ?? {}
    const capacity = state.capacity ?? this.room.maxPeers ?? 8
    const players = state.players ?? 0
    return {
      capacity,
      load: capacity > 0 ? Math.min(1, players / capacity) : 0
    }
  }
  connect () {
    if (this.stopped) return
    if (this.socket) {
      this.socket.removeAllListeners?.()
      try {
        this.socket.terminate?.()
      } catch {
        this.socket.close()
      }
      this.socket = null
      this.connected = false
    }
    this.stopLivenessWatch()
    try {
      const endpoint = new URL(this.url)
      endpoint.pathname = '/'
      endpoint.searchParams.set('v', '1')
      if (this.nodeId) endpoint.searchParams.set('node', this.nodeId)
      const socket = this.socketFactory(endpoint, { handshakeTimeout: 10_000, maxPayload: 512 * 1024 })
      const epoch = ++this.connectionEpoch
      this.commandResults.clear()
      this.queuedCommands = 0
      this.commandChain = Promise.resolve()
      this.socket = socket
      socket.on('open', () => {
        if (this.socket !== socket) {
          socket.terminate()
          return
        }
        this.connected = true
        this.connectedAt = Date.now()
        this.markAlive()
        this.logger.info?.(
          { endpoint: endpoint.toString(), roomId: this.room.id },
          'qwd websocket connected'
        )
        const discardedQueuedFrames = this.queue.length
        const reconnected = this.everConnected
        this.queue.length = 0
        if (discardedQueuedFrames > 0) {
          const fields = { roomId: this.room.id, discardedQueuedFrames }
          if (reconnected)
            this.logger.warn?.(
              fields,
              'qwd reconnected; discarded queued frames, full resync follows'
            )
          else
            this.logger.debug?.(
              fields,
              'discarded frames queued before the first connection; full resync follows'
            )
        }
        this.everConnected = true
        this.offlineLogged = false
        this.publish('node.ready', {
          ...this.occupancy(),
          timestamp: Date.now()
        })
        this.publish('room.created', {
          roomId: this.room.id,
          udpHost: this.room.publicHost,
          port: this.room.publicPort,
          capacity: this.snapshot?.().capacity ?? 8,
          players: this.snapshot?.().players ?? 0,
          version: this.snapshot?.().version ?? 1
        })
        this.onConnected?.()
        this.startLivenessWatch(endpoint.toString())
      })
      socket.on('message', data => {
        if (this.socket !== socket) return
        this.markAlive()
        try {
          const command = JSON.parse(data.toString())
          if (!command?.cmd) return
          if (command.v !== 1 || !Number.isSafeInteger(command.id) || command.id < 0) throw new Error('invalid QWD command envelope')
          if (command.cmd === 'room.id_conflict') {
            const previousRoomId = this.room.id
            this.room.id = createRoomId()
            this.logger.warn?.(
              { previousRoomId, roomId: this.room.id },
              'qwd room id conflict; regenerated room id'
            )
            this.onRoomIdConflict?.(this.room.id, previousRoomId)
            if (this.connected) {
              this.publish('room.created', {
                roomId: this.room.id,
                udpHost: this.room.publicHost,
                port: this.room.publicPort,
                capacity: this.snapshot?.().capacity ?? 8,
                players: this.snapshot?.().players ?? 0,
                version: this.snapshot?.().version ?? 1
              })
            }
            return
          }
          if (this.queuedCommands >= QUEUE_LIMIT) {
            this.sendAck(command.id, ErrorCode.INTERNAL, { message: 'command queue full' }, socket, epoch)
            return
          }
          this.queuedCommands++
          this.commandChain = this.commandChain.then(async () => {
            if (this.socket !== socket || epoch !== this.connectionEpoch || !this.connected) return
            const fingerprint = JSON.stringify(command)
            let cached = this.commandResults.get(command.id)
            if (cached && cached.fingerprint !== fingerprint) throw new Error('command id reused with different content')
            if (!cached) {
              let result
              try { result = await this.onCommand?.(command) } catch (error) {
                result = { code: ErrorCode.INTERNAL, data: { message: error?.message ?? String(error) } }
              }
              if (this.socket !== socket || epoch !== this.connectionEpoch) return
              cached = { fingerprint, code: result?.code ?? 0, data: result?.data }
              this.commandResults.set(command.id, cached)
              while (this.commandResults.size > 512) this.commandResults.delete(this.commandResults.keys().next().value)
            }
            this.sendAck(command.id, cached.code, cached.data, socket, epoch)
          }).catch(error => {
            this.sendAck(command.id, ErrorCode.INTERNAL, { message: error.message }, socket, epoch)
          }).finally(() => {
            if (epoch === this.connectionEpoch) this.queuedCommands--
          })
        } catch (error) {
          this.logger.warn?.({ err: error }, 'invalid qwd command')
        }
      })
      socket.on('ping', () => {
        if (this.socket !== socket) return
        this.markAlive()
      })
      socket.on('pong', () => {
        if (this.socket !== socket) return
        this.markAlive()
      })
      socket.on('close', (code, reason) => {
        if (this.socket !== socket) return
        this.connected = false
        this.socket = null
        this.stopLivenessWatch()
        if (Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) {
          this.reconnectAttempts = 0
        }
        this.onTransportDropped?.()
        this.logger.warn?.(
          { code, reason: reason?.toString?.(), endpoint: endpoint.toString() },
          'qwd websocket closed'
        )
        if (!this.stopped) this.scheduleReconnect()
      })
      socket.on('error', error =>
        this.logger.warn?.(
          { err: error, endpoint: endpoint.toString() },
          'qwd websocket error'
        )
      )
    } catch (error) {
      this.logger.warn?.(
        { err: error, endpoint: this.url },
        'qwd websocket connection failed'
      )
      this.scheduleReconnect()
    }
  }
  scheduleReconnect () {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempts += 1
    const exponential = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts - 1, 5)
    )
    const delay = Math.round(exponential * (0.5 + Math.random()))
    this.logger.info?.(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'qwd reconnect scheduled'
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }
  startLivenessWatch (endpoint) {
    this.stopLivenessWatch()
    this.livenessTimer = setInterval(() => {
      const socket = this.socket
      if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN)
        return
      const silentFor = Date.now() - this.lastActivityAt
      if (silentFor > MANAGER_SILENCE_LIMIT_MS) {
        this.logger.warn?.(
          { endpoint, silentForMs: silentFor },
          'qwd silent too long; dropping connection'
        )
        this.stopLivenessWatch()
        try {
          socket.terminate()
        } catch {
          socket.close()
        }
        return
      }
      try {
        socket.ping()
      } catch (error) {
        this.logger.debug?.(
          { err: error, endpoint },
          'qwd heartbeat ping failed'
        )
      }
    }, LIVENESS_TICK_MS)
    this.livenessTimer.unref?.()
  }
  stopLivenessWatch () {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }
  markAlive (now = Date.now()) {
    this.lastActivityAt = now
  }
  sendAck (id, code, data, socket = this.socket, epoch = this.connectionEpoch) {
    if (!this.connected || !socket || this.socket !== socket || epoch !== this.connectionEpoch ||
      socket.readyState !== WebSocket.OPEN || !id) return false
    try {
      const message = JSON.stringify({ v: 1, id, code, data })
      if (socket.bufferedAmount + Buffer.byteLength(message) > this.backpressureLimitBytes) {
        socket.terminate()
        return false
      }
      socket.send(message, error => { if (error && this.socket === socket) socket.terminate() })
      return true
    } catch (error) {
      this.logger.warn?.({ err: error, id }, 'QWD ACK failed')
      socket.terminate()
      return false
    }
  }
}
