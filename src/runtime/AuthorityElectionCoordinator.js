export class AuthorityElectionGate {
  constructor() {
    this.suppressedLevels = new Set();
  }

  isSuppressed(levelId) {
    return this.suppressedLevels.has(levelId);
  }

  suppress(levelId, fn) {
    this.suppressedLevels.add(levelId);
    try {
      return fn();
    } finally {
      this.suppressedLevels.delete(levelId);
    }
  }
}

export function revokeAndRebalanceAuthority({
  levelId,
  reason,
  levels,
  levelService,
  gameMessageService,
  electionGate
}) {
  const revokedAuthority = levels.getAuthority(levelId);
  if (!revokedAuthority) {
    return false;
  }

  levels.revokeAuthority(levelId, { reason: `server_revoke:${reason}` });
  const { authority: nextAuthority } = electionGate.suppress(
    levelId,
    () => levelService.rebalanceAuthority(levelId)
  );
  gameMessageService.sendRevokeAndElect(
    levelId,
    revokedAuthority,
    nextAuthority,
    levels.loadLevelData(levelId),
    reason
  );
  return true;
}
