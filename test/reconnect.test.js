import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayerStore } from '../src/domain/PlayerStore.js';
import { LevelStateStore } from '../src/domain/LevelStateStore.js';
import { JoinService } from '../src/features/join/JoinService.js';
import { TgcUuid } from '../src/protocol/types/TgcUuid.js';

/**
 * Minimal session double: the join path only needs an id, a peer id, a state
 * transition and the player slot.
 */
function makeSession(id) {
  return {
    id,
    peerId: { toString: () => `peer-${id}` },
    state: 'PENDING',
    player: null,
    closed: false,
    isActive: () => true,
    transition(state) { this.state = state; },
    attachPlayer(player) { this.player = player; }
  };
}

function makeService(overrides = {}) {
  const evicted = [];
  const broadcast = [];
  const service = new JoinService({
    players: new PlayerStore({ maxPlayers: 8 }),
    levels: new LevelStateStore({ roomId: 1 }),
    broadcaster: {
      send: () => {},
      broadcast: (packet, options) => broadcast.push({ packet, options })
    },
    logger: { info() {}, warn() {}, debug() {} },
    metrics: { onlinePlayers: { set() {} } },
    onEvict: player => evicted.push(player.uuid.toString()),
    ...overrides
  });
  return { service, evicted, broadcast };
}

const payload = {
  uuid: new TgcUuid(TgcUuid.parse('79a9c25c-be60-4da5-9f80-ea24c04cd268')),
  levelId: 100,
  netVersion: 1,
  levelChangeCount: 0
};

test('a reconnect takes over from the stale session instead of being rejected', () => {
  // A reconnect is a new ENet peer, so the old session lingers with the uuid
  // still claimed. Without eviction `PlayerStore.add` rejects the join and the
  // client loops on "Already in <room>" forever.
  const { service, evicted } = makeService();

  const first = makeSession('s1');
  service.join(first, payload);
  assert.equal(service.players.size, 1);

  // Same uuid, brand-new session — this is what a client reconnect looks like.
  const second = makeSession('s2');
  service.join(second, payload);

  assert.equal(evicted.length, 1, 'the stale session is evicted');
  assert.equal(evicted[0], '79a9c25c-be60-4da5-9f80-ea24c04cd268');
  assert.equal(service.players.size, 1, 'still exactly one player for that uuid');

  const player = service.players.getByUuid('79a9c25c-be60-4da5-9f80-ea24c04cd268');
  assert.equal(player.session, second, 'the newest connection owns the player');
});

test('a reconnect does not evict a different player', () => {
  const { service, evicted } = makeService();

  service.join(makeSession('s1'), payload);
  const other = {
    ...payload,
    uuid: new TgcUuid(TgcUuid.parse('7f75f1b5-c3d2-4ed5-9bb7-f13133f08047'))
  };
  service.join(makeSession('s2'), other);

  assert.equal(evicted.length, 0, 'a different uuid is a second player, not a reconnect');
  assert.equal(service.players.size, 2);
});

test('rejoining on the same session is a no-op', () => {
  // `JoinGame` can be retransmitted; the same session must not evict itself.
  const { service, evicted } = makeService();

  const session = makeSession('s1');
  service.join(session, payload);
  const again = service.join(session, payload);

  assert.equal(evicted.length, 0);
  assert.equal(service.players.size, 1);
  assert.equal(again.uuid.toString(), '79a9c25c-be60-4da5-9f80-ea24c04cd268');
});

test('the evicted player is announced to the rest of the room', () => {
  // The eviction removes the session, so the peer's own disconnect handler
  // finds nothing to report. The room still has to learn the avatar is gone.
  const { service, broadcast } = makeService();

  service.join(makeSession('s1'), payload);
  const before = broadcast.length;
  service.join(makeSession('s2'), payload);

  assert.ok(broadcast.length > before, 'the reconnect broadcast an EnterGame roster');
  assert.ok(
    service.players.getByUuid('79a9c25c-be60-4da5-9f80-ea24c04cd268'),
    'and the uuid is still joined afterwards'
  );
});


test('eviction releases the level authority', () => {
  // Removing the player from the store alone leaves `authorities[levelId]`
  // pointing at an object that no longer exists, and the next join is told that
  // ghost is the elected player. The release has to run through LevelService.
  const released = [];
  const { service } = makeService({
    levelService: {
      releaseAuthority: (player, reason) => released.push({ uuid: player.uuid.toString(), reason })
    }
  });

  const session = makeSession('s1');
  service.join(session, payload);
  service.join(makeSession('s2'), payload);

  assert.equal(released.length, 1, 'the evicted session released its authority');
  assert.equal(released[0].uuid, '79a9c25c-be60-4da5-9f80-ea24c04cd268');
  assert.equal(released[0].reason, 'session_evicted');
});
