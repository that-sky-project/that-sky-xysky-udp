export const MIGRATION_ROSTER_TTL_MS = 15_000

export class MigrationRosters {
  #rosters = new Map()

  constructor ({ players, reservations, logger, now = Date.now }) {
    this.players = players
    this.reservations = reservations
    this.logger = logger
    this.now = now
  }

  get size () { return this.#rosters.size }
  get (key) { return this.#rosters.get(key) }

  claim (session, payload) {
    if (!Array.isArray(payload.move?.players) || payload.move.players.length === 0) return undefined
    const ownUuid = payload.uuid?.toString?.()
    const uuids = payload.move.players.map(uuid => uuid?.toString?.()).filter(Boolean)
    if (!ownUuid || !uuids.includes(ownUuid)) return undefined
    let reservationId
    for (const [id, reservation] of this.reservations.entries()) {
      if (reservation.playerIds.has(ownUuid) && uuids.every(uuid => reservation.playerIds.has(uuid))) {
        reservationId = id
        break
      }
    }
    if (!payload.moving && !reservationId) return undefined
    const key = reservationId ?? `move:${uuids.slice().sort().join(',')}`
    let roster = this.#rosters.get(key)
    if (!roster) {
      if (this.players.size + uuids.length > this.players.maxPlayers) {
        this.logger.warn({ key, players: this.players.size, requested: uuids.length }, 'migration roster exceeds room capacity')
        return undefined
      }
      const entries = []
      try {
        for (const uuid of uuids) {
          const netId = this.players.allocateId()
          this.players.reserveId(netId)
          entries.push({ netId, uuid: payload.move.players.find(item => item.toString() === uuid), levelId: payload.levelId ?? 0 })
        }
      } catch (error) {
        for (const entry of entries) this.players.releaseReservedId(entry.netId)
        throw error
      }
      roster = { key, entries, joined: new Set(), expiresAt: this.now() + MIGRATION_ROSTER_TTL_MS, sessionIds: new Set() }
      this.#rosters.set(key, roster)
    }
    roster.sessionIds.add(session.id)
    roster.expiresAt = this.now() + MIGRATION_ROSTER_TTL_MS
    return roster
  }

  complete (roster) {
    if (!roster || !roster.entries.every(entry => roster.joined.has(entry.uuid.toString()))) return
    this.release(roster.key)
    this.reservations.releaseMatching(roster.entries.map(entry => entry.uuid.toString()))
  }

  release (key) {
    const roster = this.#rosters.get(key)
    if (!roster) return
    this.#rosters.delete(key)
    for (const entry of roster.entries) this.players.releaseReservedId(entry.netId)
  }

  expire (now = this.now()) {
    for (const [key, roster] of this.#rosters) {
      if (roster.expiresAt <= now) this.release(key)
    }
  }

  clear () {
    for (const key of this.#rosters.keys()) this.release(key)
  }
}
