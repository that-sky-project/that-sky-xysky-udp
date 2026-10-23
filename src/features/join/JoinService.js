import { PacketIds } from '../../protocol/PacketIds.js';
import { ConnectionState } from '../../connection/states.js';

export class JoinService {
  constructor({ players, levels, broadcaster, logger, metrics, migration, onPlayerJoined }) {
    this.players = players;
    this.levels = levels;
    this.broadcaster = broadcaster;
    this.logger = logger;
    this.metrics = metrics;
    this.migration = migration;
    this.onPlayerJoined = onPlayerJoined;
  }

  join(session, payload) {
    if (session.player) {
      return session.player;
    }

    const migrationRoster = this.migration?.claim?.(session, payload) ?? undefined;
    const playerId = migrationRoster?.entries.find(entry => entry.uuid.toString() === payload.uuid.toString())?.netId;

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
      if (migrationRoster && playerId !== undefined) this.players.releaseReservedId(playerId);
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
      this.broadcaster.send(session, enterGame);
    } catch (error) {
      this.players.removeBySession(session);
      throw error;
    }
    session.attachPlayer(player);
    session.transition(ConnectionState.ACTIVE);
    migrationRoster?.joined?.add(payload.uuid.toString());
    this.migration?.complete?.(migrationRoster);
    this.broadcaster.broadcast(enterGame, { playerOnly: true, exceptSession: session });

    this.metrics.onlinePlayers.set(this.players.size);
    this.onPlayerJoined?.(player);

    // setAuthority triggers the onAuthorityElected event on LevelStateStore,
    // which RoomServer subscribes to for sending NetLevelDataElect.
    const authority = this.levels.getAuthority(player.levelId);
    if (!authority) {
      this.levels.setAuthority(player.levelId, player, { reason: 'join_first_player' });
    } else {
      // Authority already exists — fire a synthetic elect-notify for the joining player.
      // We trigger the event handlers manually here so RoomServer can send the Elect
      // to the joiner without changing the stored authority.
      for (const handler of this.levels._authorityElectedHandlers) {
        handler(player.levelId, authority, player);
      }
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
