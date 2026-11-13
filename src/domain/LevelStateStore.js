import { StateError } from '../errors.js';

export class LevelStateStore {
  constructor({ roomId, logger }) {
    this.roomId = roomId;
    this.logger = logger;
    this.authorities = new Map();
    this.authorityVersions = new Map();
    this.penalizedAuthorityCandidates = new Map();
    /** levelId -> the authority's serialized level state. */
    this.levelData = new Map();
    this._authorityElectedHandlers = [];
  }

  onAuthorityElected(callback) {
    this._authorityElectedHandlers.push(callback);
  }

  getAuthority(levelId) {
    return this.authorities.get(levelId);
  }

  getAuthorityVersion(levelId) {
    return this.authorityVersions.get(levelId) ?? 0;
  }

  syncAuthority(levelId, targetPlayer) {
    const authority = this.getAuthority(levelId);
    if (!authority || !targetPlayer.levelReady || targetPlayer.levelId !== levelId) return false;
    const authorityVersion = this.getAuthorityVersion(levelId);
    const identity = `${levelId}:${targetPlayer.lvSeq}:${authority.id}:${authorityVersion}`;
    if (targetPlayer.lastAuthoritySync === identity) return false;
    for (const handler of this._authorityElectedHandlers) {
      handler(levelId, authority, targetPlayer);
    }
    targetPlayer.lastAuthoritySync = identity;
    return true;
  }

  setAuthority(levelId, player, context = {}) {
    if (!player || (player.levelId !== undefined && player.levelId !== levelId)) {
      throw new StateError('authority player is not in level', {
        levelId,
        playerId: player?.id,
        playerLevelId: player?.levelId
      });
    }
    const previous = this.authorities.get(levelId);
    this.authorities.set(levelId, player);

    if (previous !== player) {
      // New elections advance the u16 authority epoch; recipient resyncs do not.
      const version = (this.getAuthorityVersion(levelId) + 2) & 0xffff;
      this.authorityVersions.set(levelId, version);
      const cached = this.levelData.get(levelId);
      if (cached) cached.authorityVersion = version;
      this.logger?.info({
        roomId: this.roomId,
        levelId,
        authorityPlayerId: player.id,
        authorityVersion: version,
        previousAuthorityPlayerId: context.previousAuthorityPlayerId ?? previous?.id,
        peerId: player.session?.peerId?.toString(),
        uuid: player.uuid?.toString(),
        reason: context.reason
      }, 'level authority elected');

      for (const handler of this._authorityElectedHandlers) {
        handler(levelId, player, context.targetPlayer);
      }
    }
  }

  revokeAuthority(levelId, context = {}) {
    const previous = this.authorities.get(levelId);
    const revoked = this.authorities.delete(levelId);

    if (revoked) {
      this.logger?.info({
        roomId: this.roomId,
        levelId,
        authorityPlayerId: previous?.id,
        peerId: previous?.session?.peerId?.toString(),
        uuid: previous?.uuid?.toString(),
        reason: context.reason
      }, 'level authority revoked');
    }
  }

  isAuthority(player, levelId = player.levelId) {
    return this.getAuthority(levelId) === player;
  }

  penalizeAuthorityCandidate(levelId, player) {
    let penalized = this.penalizedAuthorityCandidates.get(levelId);
    if (!penalized) {
      penalized = new Set();
      this.penalizedAuthorityCandidates.set(levelId, penalized);
    }
    penalized.add(player);
  }

  clearAuthorityPenalty(levelId, player) {
    const penalized = this.penalizedAuthorityCandidates.get(levelId);
    if (!penalized) return;
    penalized.delete(player);
    if (penalized.size === 0) this.penalizedAuthorityCandidates.delete(levelId);
  }

  isAuthorityCandidatePenalized(levelId, player) {
    return this.penalizedAuthorityCandidates.get(levelId)?.has(player) ?? false;
  }

  pruneAuthorityCandidatePenalties(levelId, activePlayers) {
    const penalized = this.penalizedAuthorityCandidates.get(levelId);
    if (!penalized) return;
    const active = new Set(activePlayers);
    for (const player of penalized) {
      if (!active.has(player)) penalized.delete(player);
    }
    if (penalized.size === 0) this.penalizedAuthorityCandidates.delete(levelId);
  }

  forgetLevelData(levelId) {
    this.levelData.delete(levelId);
  }

  saveLevelData(levelId, data) {
    const authority = this.getAuthority(levelId);
    const payload = Buffer.from(data.payload ?? Buffer.alloc(0));
    const authorityVersion = data.authorityVersion ?? this.getAuthorityVersion(levelId);
    if (!Number.isInteger(authorityVersion) || authorityVersion < 0 || authorityVersion > 0xffff) {
      throw new StateError('invalid level authority version', { levelId, authorityVersion });
    }
    if (authority && authorityVersion !== this.getAuthorityVersion(levelId)) {
      throw new StateError('stale level authority version', { levelId, authorityVersion,
        expectedVersion: this.getAuthorityVersion(levelId) });
    }
    this.authorityVersions.set(levelId, authorityVersion);
    this.levelData.set(levelId, {
      electedPlayer: authority?.id ?? data.authorityPlayerId ?? 0,
      authorityVersion,
      mergeState: data.mergeState ?? 0,
      unknown2: data.unknown2 ?? 0,
      unknown3: data.unknown3 ?? 0,
      levelHash: data.levelHash ?? data.unknown4 ?? 0,
      unknown4: data.unknown4 ?? 0,
      unknown5: data.unknown5 ?? 0,
      unknown6: data.unknown6 ?? 0,
      dataLength: payload.length,
      payload,
      updatedAt: data.updatedAt ?? Date.now(),
      authorityPlayerId: data.authorityPlayerId
    });
  }

  loadLevelData(levelId) {
    return this.levelData.get(levelId);
  }

  reset(levelId, context = {}) {
    if (levelId === undefined) {
      this.authorities.clear();
      this.authorityVersions.clear();
      this.penalizedAuthorityCandidates.clear();
      this.levelData.clear();
      return;
    }

    this.revokeAuthority(levelId, context);
    this.authorityVersions.delete(levelId);
    this.penalizedAuthorityCandidates.delete(levelId);
    this.levelData.delete(levelId);
  }

  toApi() {
    return Array.from(new Set([
      ...this.authorities.keys(),
      ...this.authorityVersions.keys(),
      ...this.penalizedAuthorityCandidates.keys(),
      ...this.levelData.keys()
    ])).map(levelId => {
      const state = this.levelData.get(levelId);
      return {
        roomId: this.roomId,
        levelId,
        authorityPlayerId: this.authorities.get(levelId)?.id,
        authorityVersion: this.getAuthorityVersion(levelId),
        penalizedAuthorityPlayerIds: Array.from(this.penalizedAuthorityCandidates.get(levelId) ?? [], player => player.id),
        hasLevelData: Boolean(state),
        levelDataBytes: state?.payload?.length ?? 0,
        levelHash: state?.levelHash ?? 0,
        mergeState: state?.mergeState ?? 0,
        updatedAt: state?.updatedAt
      };
    });
  }
}
