/** Candidate selection only: callers retain ownership of elections and revoke ordering. */
export function selectAuthorityCandidate(levels, levelId, players) {
  levels.pruneAuthorityCandidatePenalties?.(levelId, players);
  let next = players.find(player => !levels.isAuthorityCandidatePenalized?.(levelId, player));
  if (!next && players.length === 1) {
    next = players[0];
    levels.clearAuthorityPenalty?.(levelId, next);
  }
  return next;
}
