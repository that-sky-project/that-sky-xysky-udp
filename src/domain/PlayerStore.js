import { Player } from './Player.js';
import { StateError } from '../errors.js';

export class PlayerStore {
  constructor({ maxPlayers = 8 } = {}) {
    this.maxPlayers = maxPlayers;
    this.playersById = new Map();
    this.playersBySession = new Map();
    this.playersByUuid = new Map();
    this.reservedIds = new Set();
    this.netIdCount = 0;
  }

  get size() {
    return this.playersById.size;
  }

  add({ session, uuid, levelId, netVersion, levelChangeCount, id }) {
    if (this.size >= this.maxPlayers) {
      throw new StateError('room player limit reached', { maxPlayers: this.maxPlayers });
    }
    if (this.playersBySession.has(session.id)) {
      throw new StateError('session already has a player', { sessionId: session.id });
    }
    const uuidKey = uuid.toString();
    if (this.playersByUuid.has(uuidKey)) {
      throw new StateError('uuid already has an active player', { uuid: uuidKey });
    }

    const playerId = id === undefined ? this.allocateId() : this.claimId(id);
    const player = new Player({ id: playerId, uuid, session, levelId, netVersion, levelChangeCount });

    this.playersById.set(playerId, player);
    this.playersBySession.set(session.id, player);
    this.playersByUuid.set(uuidKey, player);

    return player;
  }

  allocateId() {
    // Player IDs are an on-wire u8 with zero reserved.  A wrapped counter
    // must skip IDs that are still active instead of overwriting their entry.
    const start = this.netIdCount === 0 ? 1 : this.netIdCount;
    for (let offset = 0; offset < 0xff; offset += 1) {
      const id = ((start - 1 + offset) % 0xff) + 1;
      if (this.playersById.has(id) || this.reservedIds.has(id)) {
        continue;
      }

      this.netIdCount = (id % 0xff) + 1;
      return id;
    }

    throw new StateError('no player IDs available', { maxIds: 0xff });
  }

  reserveId(id) {
    const value = Number(id);
    if (!Number.isInteger(value) || value < 1 || value > 0xff || this.playersById.has(value)) {
      throw new StateError('player ID cannot be reserved', { id });
    }
    this.reservedIds.add(value);
    return value;
  }

  releaseReservedId(id) {
    this.reservedIds.delete(Number(id));
  }

  claimId(id) {
    const value = Number(id);
    if (!Number.isInteger(value) || value < 1 || value > 0xff || this.playersById.has(value)) {
      throw new StateError('player ID is unavailable', { id });
    }
    this.reservedIds.delete(value);
    this.netIdCount = (value % 0xff) + 1;
    return value;
  }

  getBySession(session) {
    return this.playersBySession.get(session.id);
  }

  getById(id) {
    return this.playersById.get(id);
  }

  removeBySession(session) {
    const player = this.getBySession(session);
    if (!player) {
      return undefined;
    }

    // Keep removal identity-safe.  This matters if a stale disconnect arrives
    // after an ID/UUID has been reused by a newer player.
    if (this.playersById.get(player.id) === player) {
      this.playersById.delete(player.id);
    }
    if (this.playersBySession.get(session.id) === player) {
      this.playersBySession.delete(session.id);
    }
    const uuidKey = player.uuid.toString();
    if (this.playersByUuid.get(uuidKey) === player) {
      this.playersByUuid.delete(uuidKey);
    }
    return player;
  }

  list() {
    return Array.from(this.playersById.values());
  }

  listInLevel(levelId) {
    return this.list().filter(player => player.levelId === levelId);
  }

  listActive() {
    return this.list().filter(isActivePlayer);
  }

  listActiveInLevel(levelId) {
    return this.listInLevel(levelId).filter(isActivePlayer);
  }
}

function isActivePlayer(player) {
  return typeof player.session?.isActive === 'function'
    ? player.session.isActive()
    : !player.session?.closed;
}
