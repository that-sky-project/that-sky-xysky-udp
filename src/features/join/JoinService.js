import { PacketIds } from '../../protocol/PacketIds.js';
import { ConnectionState } from '../../connection/states.js';
import { AdmissionError } from '../../errors.js';
import { sendPacket } from '../broadcast/sendPacket.js';

export class JoinService {
  constructor({ players, levels, levelService, broadcaster, logger, metrics, migration, reservations, onPlayerJoined, onEvict }) {
    this.players = players;
    this.levels = levels;
    this._levelService = levelService;
    this.broadcaster = broadcaster;
    this.logger = logger;
    this.metrics = metrics;
    this.migration = migration;
    this.reservations = reservations ?? migration?.reservations;
    this.onPlayerJoined = onPlayerJoined;
    this.onEvict = onEvict;
  }

  evictSession(previous) {
    this.logger?.warn({
      uuid: previous.uuid?.toString?.(),
      oldPeerId: previous.session?.peerId?.toString?.()
    }, 'uuid reconnected; evicting the previous session');
    this.players.removeBySession(previous.session);
    this._levelService?.releaseAuthority(previous, 'session_evicted');
    this.onEvict?.(previous);
  }

  join(session, payload) {
    if (session.player) {
      return session.player;
    }

    const previous = this.players.getByUuid(payload.uuid.toString());
    this.reservations?.expire();
    const ownsSlot = this.reservations?.findByPlayer(payload.uuid.toString(), { outstandingOnly: true });
    const replacementCredit = previous && previous.session !== session ? 1 : 0;
    const required = ownsSlot ? 0 : 1;
    const hasCapacity = this.reservations
      ? this.reservations.hasCapacity(required, replacementCredit)
      : this.players.size - replacementCredit < this.players.maxPlayers;
    if (!hasCapacity) throw new AdmissionError();
    const migrationRoster = this.migration?.claim?.(session, payload) ?? undefined;
    // Reconnects and rebuilt rosters preserve a UUID's currently live native ID.
    const playerId = previous?.id ?? migrationRoster?.entries.find(entry => entry.uuid.toString() === payload.uuid.toString())?.netId;

    if (previous && previous.session !== session) {
      this.evictSession(previous);
    }

    let player;
    try {
      player = this.players.add({
        session,
        uuid: payload.uuid,
        levelId: payload.levelId ?? 0,
        netVersion: payload.netVersion,
        levelChangeCount: payload.levelChangeCount,
        id: playerId
      });
    } catch (error) {
      this.migration?.rollback?.(migrationRoster, playerId);
      throw error;
    }

    const rosterEntries = migrationRoster?.entries ?? [];
    const known = new Set();
    const enterPlayers = [];
    for (const entry of [...rosterEntries, ...this.players.list().map(current => ({
      netId: current.id,
      uuid: current.uuid,
      levelId: current.levelId
    }))]) {
      const key = entry.uuid.toString();
      if (known.has(key)) continue;
      known.add(key);
      enterPlayers.push(entry);
    }
    const enterGame = {
      id: PacketIds.EnterGame,
      payload: {
        players: enterPlayers
      }
    };
    try {
      sendPacket(this.broadcaster, session, enterGame, undefined, 'EnterGame send failed to queue');
    } catch (error) {
      this.players.removeBySession(session);
      this.migration?.rollback?.(migrationRoster, playerId);
      throw error;
    }
    session.attachPlayer(player);
    session.transition(ConnectionState.ACTIVE);
    migrationRoster?.joined?.add(payload.uuid.toString());
    this.reservations?.consume(payload.uuid.toString());
    this.migration?.complete?.(migrationRoster);
    this.broadcaster.broadcast(enterGame, { playerOnly: true, exceptSession: session });

    this.metrics.onlinePlayers.set(this.players.size);
    this.onPlayerJoined?.(player);

    const authority = this.levels.getAuthority(player.levelId);
    if (!authority) {
      this.levels.setAuthority(player.levelId, player, { reason: 'join_first_player' });
    } else if (player.levelReady) {
      this.levels.syncAuthority(player.levelId, player);
    }

    this.logger.info({
      peerId: session.peerId.toString(),
      playerId: player.id,
      uuid: player.uuid.toString(),
      levelId: player.levelId
    }, 'player joined');

    return player;
  }
}
