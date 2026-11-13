import WebSocket from 'ws'
import ReconnectingWebSocket from 'reconnecting-websocket'

const OPEN = 1
const CLOSED = 3

/**
 * websocketImpl injection contract: ({ url, onActivity, onAttempt }) => port.
 * port.socket is a startClosed ReconnectingWebSocket (browser event interface).
 * port.send(text, callback) returns false when no native socket is open;
 * port.ping(), port.terminate(), and idempotent port.dispose() operate on the
 * current native socket. QwdClient attaches listeners before socket.reconnect().
 * Native callback errors and ping/pong are deliberately not routed through RW's
 * unsupported send callback / ping APIs, or through its private fields.
 * createWebSocketImpl allows ws-compatible constructors and retry timings in tests.
 */
export function createWebSocketImpl ({ WebSocket: NativeWebSocket = WebSocket, reconnectOptions = {} } = {}) {
  return ({ url, onActivity, onAttempt }) => {
    let current = null
    let disposed = false
    const records = new Map()
    const release = raw => {
      const listeners = records.get(raw)
      if (!listeners) return
      raw.removeListener('ping', listeners.activity)
      raw.removeListener('pong', listeners.activity)
      raw.removeListener('close', listeners.close)
      records.delete(raw)
      // Keep the harmless error sink: terminating a CONNECTING ws emits error
      // asynchronously, after RW has already detached its own listeners.
    }
    const drop = raw => {
      if (raw && raw.readyState !== CLOSED) raw.terminate()
    }
    class ManagedWebSocket extends NativeWebSocket {
      constructor (endpoint, protocols) {
        onAttempt?.()
        drop(current)
        if (current) release(current)
        super(endpoint, protocols, { handshakeTimeout: 10_000, maxPayload: 512 * 1024 })
        current = this
        const activity = () => { if (!disposed && current === this) onActivity?.() }
        const close = () => release(this)
        this.on('error', () => {})
        this.on('ping', activity)
        this.on('pong', activity)
        this.on('close', close)
        records.set(this, { activity, close })
        if (disposed) drop(this)
      }
    }
    const socket = new ReconnectingWebSocket(String(url), [], {
      minReconnectionDelay: 1000 + Math.random() * 1000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 2,
      minUptime: 10_000,
      connectionTimeout: 10_000,
      ...reconnectOptions,
      WebSocket: ManagedWebSocket,
      startClosed: true,
      maxEnqueuedMessages: 0
    })
    return {
      socket,
      send (text, callback) {
        const raw = current
        if (disposed || raw?.readyState !== OPEN) return false
        raw.send(text, error => {
          if (!disposed && current === raw) callback?.(error)
        })
        return true
      },
      ping () {
        if (!disposed && current?.readyState === OPEN) current.ping()
      },
      terminate () { drop(current) },
      dispose () {
        if (disposed) return
        disposed = true
        // close disables RW retries, including a constructor still awaiting delay.
        // terminate then bounds the native closing handshake, even if peer hangs.
        try { socket.close() } finally {
          for (const raw of records.keys()) {
            drop(raw)
            release(raw)
          }
          drop(current)
          current = null
        }
      }
    }
  }
}

export const websocketImpl = createWebSocketImpl()
