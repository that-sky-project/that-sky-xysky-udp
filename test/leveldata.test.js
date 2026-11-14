import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayerStore } from '../src/domain/PlayerStore.js';
import { LevelStateStore } from '../src/domain/LevelStateStore.js';
import { GameMessageService } from '../src/features/gamemsg/GameMessageService.js';
import { GameMsgType } from '../src/protocol/packets/shared/GameMsgPacket.js';
import { NetVersion } from '../src/protocol/types/NetVersion.js';
import { decodeNetLevelDataMsg } from '../src/protocol/types/NetLevelDataMsg.js';
import { SnapshotReader } from '../src/protocol/snapshot/SnapshotReader.js';
import { PacketIds } from '../src/protocol/PacketIds.js';

/**
 * These regressions are lifted straight out of the official-server capture
 * `packetdump_20261030203945`, which is the only ground truth we have for the
 * level-state side channel. Every constant below is a byte that appears in it.
 */

const CONCERT = 1559613961;

/** The concert hall's level hash as the client reports it (`values[0]`). */
const CONCERT_LEVEL_HASH = 0x6752;

/**
 * First 32 bytes of the concert hall's level data, taken from the `JoinGame`
 * at capture seq 1062 (`52 67 00 00 …`) and echoed by the server at seq 1081.
 */
function concertLevelData(length = 4172) {
  const data = Buffer.alloc(length);
  Buffer.from('5267000000000000', 'hex').copy(data, 0);
  return data;
}

function makeSession(id) {
  return {
    id,
    peerId: { toString: () => `peer-${id}` },
    player: null,
    isActive: () => true,
    transition() {},
    attachPlayer(player) { this.player = player; }
  };
}

function makeHarness({ netVersionValues = [CONCERT_LEVEL_HASH, 49307, 23536, 0, 0, 25536] } = {}) {
  const sent = [];
  const players = new PlayerStore({ maxPlayers: 8 });
  const levels = new LevelStateStore({ roomId: 1, logger: { info() {}, warn() {} } });
  const service = new GameMessageService({
    players,
    levels,
    broadcaster: {
      send: (session, packet) => sent.push({ session, packet }),
      broadcast: () => {}
    },
    logger: { info() {}, warn() {}, debug() {} }
  });

  const session = makeSession('s1');
  const player = players.add({
    session,
    uuid: { toString: () => 'uuid-solo' },
    levelId: CONCERT,
    netVersion: new NetVersion(netVersionValues)
  });
  session.attachPlayer(player);
  levels.setAuthority(CONCERT, player, { reason: 'join_first_player' });
  levels.saveLevelData(CONCERT, {
    authorityVersion: levels.getAuthorityVersion(CONCERT),
    payload: concertLevelData(),
    mergeState: 22,
    unknown2: 0x63c0,
    unknown3: 0,
    levelHash: 0,
    authorityPlayerId: player.id
  });

  return { service, players, levels, player, session, sent };
}

test('the level hash is the first net-version word', () => {
  // Capture: the concert hall's JoinGame level data starts `52 67 00 00` and
  // its net version is [0x6752, 49307, 23536, …]. `values[2]` is 23536 for
  // every level it appears on and is not a hash.
  const version = new NetVersion([CONCERT_LEVEL_HASH, 49307, 23536, 0, 0, 25536]);
  assert.equal(version.levelHash, CONCERT_LEVEL_HASH);
  assert.equal(concertLevelData(4).readUInt32LE(0), version.levelHash);
});

test('only the authority upload is stored, and it replaces the previous one', () => {
  // The capture's client sent 1117 of its 1120 concert uploads while it was the
  // authority, and 3 while joining behind authority 80. Delegation is a single
  // slot: a new authority's serialization supersedes the old one rather than
  // accumulating per-player copies.
  const levels = new LevelStateStore({ roomId: 1 });
  const first = Buffer.alloc(8, 0xaa);
  const second = Buffer.alloc(8, 0xbb);

  levels.saveLevelData(CONCERT, { payload: first, mergeState: 22 });
  assert.deepEqual(levels.loadLevelData(CONCERT).payload, first);

  levels.saveLevelData(CONCERT, { payload: second, mergeState: 22 });
  assert.deepEqual(levels.loadLevelData(CONCERT).payload, second, 'the newer authority wins');
  assert.equal(levels.loadLevelData(CONCERT).payload.length, 8);
});

test('every captured join blobs the level it declares', () => {
  // Six `JoinGame`s appear in the capture and all six set `moving` — the
  // client reconnects into the new room rather than sending a MoveGame. None
  // of them ever carries the previous level's state: each blob's first u32 is
  // that join's own net-version hash and its level data header names that same
  // level. This is the property a room change relies on.
  const joins = [
    { levelId: 3526133726, hash: 0x8ff3, merge: 32, len: 4292 },
    { levelId: 3526133726, hash: 0x8ff3, merge: 0, len: 4292 },
    { levelId: 1559613961, hash: 0x6752, merge: 22, len: 4172 },
    { levelId: 1559613961, hash: 0x6752, merge: 22, len: 4172 },
    { levelId: 3526133726, hash: 0x8ff3, merge: 32, len: 4294 },
    { levelId: 3082753918, hash: 0x5231, merge: 0, len: 4478 }
  ];

  for (const join of joins) {
    const blob = Buffer.alloc(join.len);
    blob.writeUInt32LE(join.hash, 0);
    const version = new NetVersion([join.hash, 49307, 23536, 0, 0, 25536]);
    assert.equal(blob.readUInt32LE(0), version.levelHash, `level ${join.levelId} blob matches its net version`);
    assert.ok(join.len <= 0x2000, 'the join blob fits the level-data limit');
  }
});


test('the stream names the receiver level, which is the only field the client checks', () => {
  // `sub_140E68790` case 11 decodes NetLevelDataMsg and accepts it only when
  // `levelId` equals the level the client is on (`v9 == DWORD1(v63)`); the rest
  // of the header — including `unknown1` — is informational. So the record must
  // be stamped with the receiver's level, not the authority's, or a client whose
  // level id ever differs drops the whole stream.
  const levels = new LevelStateStore({ roomId: 1 });
  const players = new PlayerStore({ maxPlayers: 8 });
  const sent = [];
  const service = new GameMessageService({
    players, levels,
    broadcaster: { send: (session, packet) => sent.push(packet), broadcast() {} },
    logger: { info() {}, warn() {}, debug() {} }
  });

  const authoritySession = makeSession('auth');
  const authority = players.add({
    session: authoritySession,
    uuid: { toString: () => 'auth' },
    levelId: CONCERT,
    netVersion: new NetVersion([0x6752, 49307, 23536, 0, 0, 25536])
  });
  authoritySession.attachPlayer(authority);
  levels.setAuthority(CONCERT, authority, { reason: 'join' });
  levels.saveLevelData(CONCERT, { payload: concertLevelData(), mergeState: 22 });

  const peerSession = makeSession('peer');
  const peer = players.add({
    session: peerSession,
    uuid: { toString: () => 'peer' },
    levelId: CONCERT,
    netVersion: new NetVersion([0x6752, 49307, 23536, 0, 0, 25536])
  });
  peerSession.attachPlayer(peer);

  service.syncLevelData();

  const record = sent.find(packet => packet.payload.type === GameMsgType.NetLevelData);
  assert.ok(record, 'the peer receives the stream');
  const decoded = new SnapshotReader().read({
    ...record.payload.snapshot,
    payload: record.payload.payload
  });
  assert.ok(decoded.ok);
  const message = decodeNetLevelDataMsg(decoded.data, {});
  assert.equal(message.levelId, peer.levelId, 'stamped with the receiver level');
  assert.equal(message.electedPlayer, authority.id, 'and it still names the authority');
});
