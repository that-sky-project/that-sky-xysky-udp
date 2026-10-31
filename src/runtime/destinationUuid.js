import { TgcUuid } from '../protocol/types/TgcUuid.js';

/**
 * MoveGame.destinationUuid must identify the destination room, but the manager
 * only sends the numeric room id. Derive a deterministic uuid from it unless a
 * real uuid text was supplied.
 *
 * Lives outside RoomServer so the command bus can import it without pulling in
 * the whole server class.
 */
export function destinationUuid(roomId) {
  if (roomId === undefined || roomId === null) return undefined;
  const value = String(roomId);
  if (TgcUuid.isText(value)) return value;
  if (!/^\d{1,15}$/.test(value)) return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric > 0xffffffffffff) return undefined;
  return `00000000-0000-4000-8000-${numeric.toString(16).padStart(12, '0')}`;
}
