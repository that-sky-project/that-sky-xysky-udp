export const RESERVATION_TTL_MS = 15_000
export const DROPPED_TRANSPORT_RESERVATION_TTL_MS = 15_000

export class RoomReservations {
  #reservations = new Map()

  constructor ({ players, capacity = players.maxPlayers, identity, publish, now = Date.now }) {
    this.players = players
    this.capacity = capacity
    this.identity = identity
    this.publish = publish
    this.now = now
  }

  get size () { return this.#reservations.size }
  get (id) { return this.#reservations.get(id) }
  entries () { return this.#reservations.entries() }

  reservedSlots () {
    let total = 0
    for (const reservation of this.#reservations.values()) total += reservation.playerIds.size
    return total
  }

  hasCapacity (count) {
    return this.players.size + this.reservedSlots() + count <= this.capacity
  }

  findByPlayer (playerId) {
    const wanted = String(playerId)
    for (const [id, reservation] of this.#reservations) {
      if (reservation.playerIds.has(wanted)) return id
    }
  }

  create (id, playerIds, ttlMs = RESERVATION_TTL_MS) {
    const reservation = {
      playerIds: new Set(playerIds.map(String)),
      joined: new Set(),
      expiresAt: this.now() + Number(ttlMs)
    }
    this.#reservations.set(id, reservation)
    return reservation
  }

  renew (id, ttlMs = RESERVATION_TTL_MS) {
    const reservation = this.get(id)
    if (reservation) reservation.expiresAt = this.now() + Number(ttlMs)
  }

  cancel (id) { return this.#reservations.delete(id) }

  releaseMatching (playerIds) {
    const wanted = playerIds.map(String)
    for (const [id, reservation] of this.#reservations) {
      if (reservation.playerIds.size === wanted.length && wanted.every(playerId => reservation.playerIds.has(playerId))) {
        this.cancel(id)
      }
    }
  }

  transportDropped () {
    const deadline = this.now() + DROPPED_TRANSPORT_RESERVATION_TTL_MS
    for (const reservation of this.#reservations.values()) {
      reservation.expiresAt = Math.min(reservation.expiresAt, deadline)
    }
  }

  expire (now = this.now()) {
    for (const [moveId, reservation] of this.#reservations) {
      if (reservation.expiresAt > now) continue
      this.cancel(moveId)
      this.publish('reservation.expired', {
        roomId: this.identity.id,
        moveId,
        playerIds: [...reservation.playerIds]
      })
    }
  }

  consume (playerId) {
    const wanted = String(playerId)
    for (const [moveId, reservation] of this.#reservations) {
      if (!reservation.playerIds.has(wanted)) continue
      reservation.joined.add(wanted)
      if (reservation.joined.size < reservation.playerIds.size) continue
      this.cancel(moveId)
      this.publish('move.completed', {
        roomId: this.identity.id,
        moveId,
        playerIds: [...reservation.playerIds]
      })
    }
  }

  clear () { this.#reservations.clear() }
}
