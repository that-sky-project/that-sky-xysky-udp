import { AdmissionError, ProtocolError } from '../errors.js'
export const MIGRATION_ROSTER_TTL_MS = 15_000

export class MigrationRosters {
  #rosters = new Map()

  constructor ({ players, reservations, logger, now = Date.now }) {
    Object.assign(this, { players, reservations, logger, now })
  }

  get size () { return this.#rosters.size }
  get (key) { return this.#rosters.get(key) }

  claim (session, payload) {
    if (!Array.isArray(payload.move?.players) || payload.move.players.length === 0) return undefined
    const ownUuid = payload.uuid?.toString?.()
    const wireUuids = payload.move.players.map(uuid => uuid?.toString?.())
    if (!ownUuid || wireUuids.some(uuid => !uuid) || new Set(wireUuids).size !== wireUuids.length || wireUuids.length > 7) {
      throw new ProtocolError('invalid migration roster')
    }
    const reservationId = this.reservations.findByPlayer(ownUuid)
    if (!payload.moving && !reservationId) return undefined
    // Native JoinGame may list companions only. Normalize self exactly once;
    // seven wire companions plus the joining player still obey room capacity 8.
    const identities = new Map([[ownUuid, payload.uuid]])
    payload.move.players.forEach((uuid, index) => identities.set(wireUuids[index], uuid))
    const uuids = [...identities.keys()]
    const key = `move:${uuids.slice().sort().join(',')}`
    let roster = this.#rosters.get(key)
    if (!roster) {
      const unreserved = uuids.filter(uuid => !this.players.getByUuid(uuid) &&
        !this.reservations.findByPlayer(uuid, { outstandingOnly: true }))
      if (!this.reservations.hasCapacity(unreserved.length)) throw new AdmissionError('migration roster exceeds room capacity')
      const entries = []
      try {
        for (const uuid of uuids) {
          const live = this.players.getByUuid(uuid)
          const netId = live?.id ?? this.players.reserveId(this.players.allocateId())
          entries.push({ netId, uuid: identities.get(uuid), levelId: live?.levelId ?? payload.levelId ?? 0 })
        }
      } catch (error) {
        for (const entry of entries) this.players.releaseReservedId(entry.netId)
        throw error
      }
      // Native unprepared moves may use spare capacity, but their unarrived members
      // must be held too, otherwise ordinary joins can invalidate the sent roster.
      const internalReservationId = unreserved.length ? `roster:${key}` : undefined
      if (internalReservationId) this.reservations.create(internalReservationId, unreserved, MIGRATION_ROSTER_TTL_MS, { internal: true })
      roster = { key, entries, joined: new Set(uuids.filter(uuid => this.players.getByUuid(uuid))),
        expiresAt: this.now() + MIGRATION_ROSTER_TTL_MS, sessionIds: new Set(), internalReservationId }
      this.#rosters.set(key, roster)
    }
    roster.sessionIds.add(session.id)
    roster.expiresAt = this.now() + MIGRATION_ROSTER_TTL_MS
    if (roster.internalReservationId) this.reservations.renew(roster.internalReservationId, MIGRATION_ROSTER_TTL_MS)
    return roster
  }

  complete (roster) {
    if (!roster || !roster.entries.every(entry => roster.joined.has(entry.uuid.toString()))) return
    // Reservation conversion owns completion; never delete it before consume.
    this.release(roster.key)
  }

  rollback (roster, playerId) {
    if (roster && playerId !== undefined && !this.players.getById(playerId)) this.players.reserveId(playerId)
  }

  release (key) {
    const roster = this.#rosters.get(key)
    if (!roster) return
    this.#rosters.delete(key)
    for (const entry of roster.entries) this.players.releaseReservedId(entry.netId)
    if (roster.internalReservationId) this.reservations.cancel(roster.internalReservationId)
  }

  expire (now = this.now()) {
    for (const [key, roster] of this.#rosters) if (roster.expiresAt <= now) this.release(key)
  }

  clear () { for (const key of this.#rosters.keys()) this.release(key) }
}
