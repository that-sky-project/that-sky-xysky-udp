/** Aurora concert hall — the 千人 audience map. */
export const AURORA_CONCERT_LEVEL = 263580627;

/** Second venue that reuses the same barn and needs the silhouettes. */
export const AURORA_HALL_LEVEL = 1559613961;

/** Levels that are allowed to use the audience system. */
export const AUDIENCE_LEVELS = new Set([
  AURORA_CONCERT_LEVEL,
  AURORA_HALL_LEVEL
]);

export function isAudienceLevel(levelId) {
  const id = Number(levelId);
  return Number.isFinite(id) && AUDIENCE_LEVELS.has(id);
}
