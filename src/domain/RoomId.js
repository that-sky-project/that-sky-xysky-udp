import { randomInt } from 'node:crypto';

/** Inclusive bounds of an 8-digit decimal room id. */
const MIN_ROOM_ID = 10_000_000;
const MAX_ROOM_ID = 99_999_999;

export function createRoomId() {
  return String(randomInt(MIN_ROOM_ID, MAX_ROOM_ID + 1));
}
