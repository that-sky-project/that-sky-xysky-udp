export const RESERVATION_TTL_MS = 35_000
export const ALLOCATION_RESERVATION_TTL_MS = 30_000
export const DROPPED_TRANSPORT_RESERVATION_TTL_MS = 15_000

export class RoomReservations {
  #reservations = new Map()

  constructor ({ players, capacity = players.maxPlayers, identity, publish, now = Date.now }) {
    Object.assign(this, { players, capacity, identity, publish, now })
  }

  get size () { return this.#reservations.size }
  get (id) { return this.#reservations.get(id) }
  entries () { return this.#reservations.entries() }

  reservedSlots () {
    let total = 0
    for (const reservation of this.#reservations.values()) total += reservation.playerIds.size - reservation.joined.size
    return total
  }

  facts (version) {
    return { capacity: this.capacity, physicalPlayers: this.players.size,
      activePlayers: this.players.listActive?.().length ?? this.players.size,
      reservedSlots: this.reservedSlots(), version }
  }

  hasCapacity (count, replacementCredit = 0) {
    return this.players.size - replacementCredit + this.reservedSlots() + count <= this.capacity
  }

  findByPlayer (playerId, { outstandingOnly = false } = {}) {
    const wanted = String(playerId)
    for (const [id, reservation] of this.#reservations) {
      if (reservation.playerIds.has(wanted) && (!outstandingOnly || !reservation.joined.has(wanted))) return id
    }
  }

  create (id, playerIds, ttlMs = RESERVATION_TTL_MS, { reservationToken, internal = false } = {}) {
    const reservation = { playerIds: new Set(playerIds.map(String)), joined: new Set(),
      expiresAt: this.now() + ttlMs, reservationToken, internal }
    this.#reservations.set(id, reservation)
    return reservation
  }

  matchesToken (id, reservationToken) {
    return this.get(id)?.reservationToken === reservationToken
  }

  renew (id, ttlMs = RESERVATION_TTL_MS) {
    const reservation = this.get(id)
    if (reservation) reservation.expiresAt = this.now() + ttlMs
    return reservation
  }

  cancel (id) { return this.#reservations.delete(id) }

  transportDropped () {
    const deadline = this.now() + DROPPED_TRANSPORT_RESERVATION_TTL_MS
    for (const reservation of this.#reservations.values()) reservation.expiresAt = Math.min(reservation.expiresAt, deadline)
  }

  expire (now = this.now()) {
    for (const [moveId, reservation] of this.#reservations) {
      if (reservation.expiresAt > now) continue
      this.cancel(moveId)
      if (!reservation.internal) this.publish?.('reservation.expired', {
        roomId: this.identity.id, moveId, reservationToken: reservation.reservationToken,
        playerIds: [...reservation.playerIds], admittedPlayerIds: [...reservation.joined], expiresAt: reservation.expiresAt
      })
    }
  }

  consume (playerId) {
    const wanted = String(playerId)
    const moveId = this.findByPlayer(wanted, { outstandingOnly: true })
    const reservation = this.get(moveId)
    if (!reservation) return false
    reservation.joined.add(wanted)
    if (reservation.joined.size === reservation.playerIds.size) {
      this.cancel(moveId)
      if (!reservation.internal) this.publish?.('move.completed', {
        roomId: this.identity.id, moveId, reservationToken: reservation.reservationToken,
        playerIds: [...reservation.joined], admittedPlayerIds: [...reservation.joined], expiresAt: reservation.expiresAt
      })
    }
    return true
  }

  clear () { this.#reservations.clear() }
}
