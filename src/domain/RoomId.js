import { randomInt } from 'node:crypto';

/** Inclusive bounds of an 8-digit decimal room id. */
const MIN_ROOM_ID = 10_000_000;
const MAX_ROOM_ID = 99_999_999;

/**
 * Room ids are an 8-digit decimal number rendered as a string, not a UUID.
 * They are short enough to read in logs and admin views; the only place that
 * needs a real UUID is the client-facing MoveGame packet, which derives one
 * deterministically from this value (see RoomServer.destinationUuid).
 *
 * Collisions between nodes are possible (90M ids) but rare; the manager's
 * room.id_conflict handshake makes the loser regenerate its id.
 */
export function createRoomId() {
  return String(randomInt(MIN_ROOM_ID, MAX_ROOM_ID + 1));
}
