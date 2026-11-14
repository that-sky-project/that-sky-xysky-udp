export function activePlayers(players) {
  const candidates = typeof players.listActive === 'function' ? players.listActive() : players.list();
  return candidates.filter(isActivePlayer);
}

export function activePlayersInLevel(players, levelId) {
  const candidates = typeof players.listActiveInLevel === 'function'
    ? players.listActiveInLevel(levelId)
    : players.listInLevel(levelId);
  return candidates.filter(isActivePlayer);
}

function isActivePlayer(player) {
  return player.session?.isActive?.() ?? true;
}
