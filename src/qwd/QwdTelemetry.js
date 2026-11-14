export const TELEMETRY_INTERVAL_MS = 1_000
export const TELEMETRY_FULL_RESYNC_FRAMES = 30
export const TELEMETRY_FULL_RESYNC_MS = 10_000
export const TELEMETRY_PLAYER_KEEPALIVE_MS = 2_000

export class QwdTelemetry {
  constructor ({ players, publishTelemetry, seatOf = null, now = Date.now }) {
    this.players = players
    this.publishTelemetry = publishTelemetry
    // Seat facts ride telemetry so the manager can rebuild its allocator after
    // a restart with zero churn: the node's roster is the source of truth for
    // who sits where, and re-deriving seats manager-side renumbered every
    // bench and re-projected the whole hall.
    this.seatOf = typeof seatOf === 'function' ? seatOf : null
    this.now = now
    this.seq = 0
    this.lastPublishedAt = -Infinity
    this.lastRoster = null
    this.lastSeqSent = 0
    this.lastFullSeq = 0
    this.lastFullAt = 0
    this.lastSentAt = new Map()
  }

  get version () { return this.seq }

  forceFull () {
    this.lastRoster = null
    this.lastPublishedAt = -Infinity
    this.publish()
  }

  publish () {
    const now = this.now()
    if (now - this.lastPublishedAt < TELEMETRY_INTERVAL_MS) return
    this.lastPublishedAt = now
    const active = this.players.listActive()
    const peers = new Map(active.map(player => [player.id, player.uuid.toString()]))
    const players = active.map(player => {
      const fields = player.playerDelta.decodedState?.fields
      const playerId = player.uuid.toString()
      const seat = this.seatOf?.(playerId)
      return {
        playerId,
        levelId: player.levelId,
        ...(seat && Number.isInteger(seat.benchId) && Number.isInteger(seat.seatId)
          ? { benchId: seat.benchId, seatId: seat.seatId }
          : {}),
        position: fields?.position ? [...fields.position] : undefined,
        velocity: fields?.move?.velocity ? Math.hypot(...fields.move.velocity) : undefined,
        stateAt: player.playerDelta.stats.lastReadAt ?? player.lastSeenAt,
        lastMoveAt: player.lastSeenAt,
        affinity: Object.fromEntries((player.lastAffinity?.entries ?? []).flatMap(entry => {
          const peerId = peers.get(entry.netPlayerId)
          return peerId ? [[peerId, Math.max(0, Math.min(1, Number(entry.value) / 255))]] : []
        }))
      }
    })
    const seq = this.seq + 1
    const previous = this.lastRoster
    const current = new Map(players.map(player => [player.playerId, player]))
    const canDelta = previous !== null && previous.size > 0 &&
      seq - this.lastFullSeq < TELEMETRY_FULL_RESYNC_FRAMES && now - this.lastFullAt < TELEMETRY_FULL_RESYNC_MS
    if (!canDelta) {
      this.seq = seq
      this.publishTelemetry(players, seq)
      this.lastRoster = current
      this.lastFullSeq = seq
      this.lastFullAt = now
      this.lastSeqSent = seq
      this.lastSentAt = new Map(players.map(player => [player.playerId, now]))
      return
    }
    const changed = []
    for (const [playerId, player] of current) {
      const before = previous.get(playerId)
      if (!before || !sameTelemetry(before, player) || now - (this.lastSentAt.get(playerId) ?? 0) >= TELEMETRY_PLAYER_KEEPALIVE_MS) changed.push(player)
    }
    const removed = [...previous.keys()].filter(playerId => !current.has(playerId))
    if (changed.length === 0 && removed.length === 0) {
      this.lastRoster = current
      return
    }
    this.seq = seq
    this.publishTelemetry(changed, seq, { kind: 'delta', baseSeq: this.lastSeqSent, removedPlayers: removed })
    this.lastRoster = current
    this.lastSeqSent = seq
    for (const player of changed) this.lastSentAt.set(player.playerId, now)
    for (const playerId of removed) this.lastSentAt.delete(playerId)
  }
}

function sameTelemetry (a, b) {
  if (a.levelId !== b.levelId || a.velocity !== b.velocity) return false
  if (a.benchId !== b.benchId || a.seatId !== b.seatId) return false
  if (!a.position !== !b.position) return false
  if (a.position && b.position && a.position.some((value, index) => value !== b.position[index])) return false
  const keys = Object.keys(a.affinity ?? {})
  if (keys.length !== Object.keys(b.affinity ?? {}).length) return false
  return keys.every(key => b.affinity?.[key] === a.affinity[key])
}
