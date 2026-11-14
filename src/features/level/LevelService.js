import { PacketIds } from '../../protocol/PacketIds.js';
import { activePlayers, activePlayersInLevel } from '../../domain/playerQueries.js';
import { selectAuthorityCandidate } from '../../domain/authorityCandidates.js';

export class LevelService {
  constructor({ players, levels, broadcaster, logger }) {
    this.players = players;
    this.levels = levels;
    this.broadcaster = broadcaster;
    this.logger = logger;
  }

  changeLevel(session, payload) {
    const player = this.players.getBySession(session);
    if (!player) {
      return;
    }

    const oldLevelId = player.levelId;
    const incomingGeneration = Number.isFinite(payload.levelChangeCount) ? (Math.trunc(payload.levelChangeCount) & 0xff) : undefined;
    if (incomingGeneration !== undefined) {
      const advance = (incomingGeneration - player.lvSeq + 256) & 0xff;
      // Half-range u8 serial arithmetic: 255 -> 0 is new, 0 -> 255 is stale.
      // Equal generation may initialize a joined level, never change its identity.
      if (advance >= 128 || (advance === 0 && oldLevelId !== payload.levelId)) return false;
    }
    const oldGeneration = player.lvSeq;
    const wasReady = player.levelReady;
    const changedLevel = oldLevelId !== payload.levelId;
    if (changedLevel) {
      this.levels.clearAuthorityPenalty?.(oldLevelId, player);
    }
    player.changeLevel(payload.levelId, payload.netVersion, payload.levelChangeCount);

    if (changedLevel && this.levels.getAuthority(oldLevelId) === player) {
      this.levels.revokeAuthority(oldLevelId, { reason: 'authority_left_level' });
      this.rebalanceAuthority(oldLevelId);
    }

    let authority = this.levels.getAuthority(player.levelId);
    const generationChanged = player.lvSeq !== oldGeneration;
    if (!authority) {
      authority = this.rebalanceAuthority(player.levelId, 'level_update_no_authority').authority;
    }
    if (authority && (!wasReady || changedLevel || generationChanged)) {
      this.levels.syncAuthority(player.levelId, player);
    }

    if (!changedLevel) {
      return;
    }

    const changedLevelPacket = {
      id: PacketIds.PlayerChangedLevel,
      payload: { playerId: player.id, levelId: player.levelId }
    };
    for (const target of this._activePlayers()) {
      if (target.session !== session) {
        this.broadcaster.send(target.session, changedLevelPacket);
      }
    }

    this.logger.debug({
      playerId: player.id,
      oldLevelId,
      levelId: player.levelId,
      authorityPlayerId: authority?.id
    }, 'player changed level');
  }

  releaseAuthority(player, reason = 'player_disconnected') {
    if (!player) {
      return { authority: undefined };
    }

    const levelId = player.levelId;
    this.levels.clearAuthorityPenalty?.(levelId, player);
    if (this.levels.getAuthority(levelId) === player) {
      this.levels.revokeAuthority(levelId, { reason });
    }

    return this.rebalanceAuthority(levelId);
  }

  rebalanceAuthority(levelId, reason = 'level_rebalance') {
    const current = this.levels.getAuthority(levelId);
    const players = this._activeInLevel(levelId);
    this.levels.pruneAuthorityCandidatePenalties?.(levelId, players);

    if (
      current &&
      players.includes(current) &&
      !this.levels.isAuthorityCandidatePenalized?.(levelId, current)
    ) {
      return { authority: current };
    }

    const previousAuthorityPlayerId = current?.id;
    const next = selectAuthorityCandidate(this.levels, levelId, players);
    if (next) {
      this.levels.setAuthority(levelId, next, {
        previousAuthorityPlayerId,
        reason: current ? 'authority_left_level' : reason
      });
      return { authority: next };
    }

    if (players.length === 0) {
      this.levels.reset?.(levelId, { reason: 'level_empty' });
    }
    return { authority: undefined };
  }

  _activeInLevel(levelId) {
    return activePlayersInLevel(this.players, levelId);
  }

  _activePlayers() {
    return activePlayers(this.players);
  }

}
