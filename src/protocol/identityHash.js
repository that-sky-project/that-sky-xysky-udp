/**
 * Player identity hash — the function the client uses to bind an audience
 * entity or a performance stream to a player.
 *
 * Reverse-engineered from libBootloader.so 0.35.1 (ARM64), see
 * `docs/audience-reverse-engineering-0.35.1.md` §2. The client computes this
 * in at least four places, all over the SAME 16 raw bytes of the player's
 * UUID (TgcUuid wire order — the bytes as they travel on the wire and as the
 * client stores them in its player entity at +47220):
 *
 * - `sub_1157808` (packet 22 AudienceRoomIds): hashes each LOCAL room
 *   player's uuid bytes, then binds every member entity whose reliable-data
 *   profile `f0` equals that hash. This is how the client decides "this
 *   badminton bird is the player sitting next to me".
 * - `sub_10FE178` (packet 28 AudienceStreamInfo): compares the stream's
 *   `sessionId` against the hash of the local player's own uuid — equal means
 *   "I am the performer" (state 3) and the client rewinds startTime by 5 s.
 * - `sub_115BA7C` (packet 24 SocialBroadcastDown): drops the packet when
 *   sessionId equals the local player's own hash (echo suppression), and
 *   otherwise attaches the JSON action to the first entity whose profile
 *   `f0` equals sessionId — so a performance broadcast MUST carry
 *   `sessionId = identityHashOf(performer uuid)` or it renders nowhere.
 * - Entity binding in `sub_11119B8`: a profile with f0 == 0 falls back to an
 *   LCG(entityIdx) deterministic random appearance; only f0 != 0 marks the
 *   entity as "identified".
 *
 * Algorithm: standard FNV-1a, 64-bit, byte-serial:
 *   hash = 0xCBF29CE484222325
 *   for each byte b: hash = (hash XOR b) * 0x100000001B3   (mod 2^64)
 *
 * It is NOT a hash of the uuid TEXT — hashing the text (as the previous
 * `profileF0Of` did) never matches the client's comparison and silently
 * breaks performer detection, room-mate binding and action attachment at
 * once.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const FNV_MASK = (1n << 64n) - 1n

/** Standard FNV-1a-64 test vector ("foobar" -> 0x85944171f73967e8). */
export const FNV1A64_TEST_VECTOR = 0x85944171f73967e8n

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function fnv1a64 (bytes) {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i])
    hash = (hash * FNV_PRIME) & FNV_MASK
  }
  return hash
}

/**
 * The uuid's 16 wire bytes, accepting every shape a caller might hold:
 * TgcUuid ({ bytes: Buffer(16) }), Buffer(16), Uint8Array(16) or uuid text.
 * Text → bytes uses the same hex layout TgcUuid.parse does, so the hash of a
 * roster's `playerId` string always matches the hash of the wire uuid the
 * client received.
 */
export function uuidWireBytes (uuid) {
  if (!uuid) return null
  if (Buffer.isBuffer(uuid) || uuid instanceof Uint8Array) {
    return uuid.length === 16 ? Buffer.from(uuid) : null
  }
  if (typeof uuid === 'object' && Buffer.isBuffer(uuid.bytes)) {
    return uuid.bytes.length === 16 ? Buffer.from(uuid.bytes) : null
  }
  const text = String(uuid)
  if (!UUID_TEXT.test(text)) return null
  return Buffer.from(text.replace(/-/g, ''), 'hex')
}

/**
 * FNV-1a-64 over the uuid's 16 wire bytes. Returns null for an
 * unparseable/missing uuid — callers must treat that as "no identity" (f0 = 0,
 * the client's LCG-random-appearance path) rather than fabricating a number.
 */
export function identityHashOfUuid (uuid) {
  const bytes = uuidWireBytes(uuid)
  if (!bytes) return null
  return fnv1a64(bytes)
}

/**
 * Identity hash from a roster playerId — the uuid TEXT form used across
 * stores, telemetry and QWD events. Returns null when the text is not a
 * uuid (e.g. synthetic ids); callers fall back to no-identity.
 */
export function identityHashOfPlayerId (playerId) {
  if (playerId === null || playerId === undefined) return null
  return identityHashOfUuid(String(playerId))
}

/** Golden vectors for tests (documented in identityHash.test.js). */
export const GOLDEN = Object.freeze({
  // 79a9c25c-be60-4da5-9f80-ea24c04cd268 -> 0x5c297b7fb25d975e
  playerA: Object.freeze({
    uuid: '79a9c25c-be60-4da5-9f80-ea24c04cd268',
    hash: 0x5c297b7fb25d975en
  }),
  // 0d17e2c6-cdbd-40a5-983d-b9deb380dd00 -> 0x776f5dee8fef6a76
  playerB: Object.freeze({
    uuid: '0d17e2c6-cdbd-40a5-983d-b9deb380dd00',
    hash: 0x776f5dee8fef6a76n
  })
})
