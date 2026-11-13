import test from 'node:test';
import assert from 'node:assert/strict';
import { QwdTelemetry } from '../src/qwd/QwdTelemetry.js';
import { RoomReservations } from '../src/qwd/RoomReservations.js';
import { MigrationRosters } from '../src/qwd/MigrationRosters.js';
import { PlayerStore } from '../src/domain/PlayerStore.js';

function telemetryFixture() {
  let now = 0;
  let active = [{ id: 1, uuid: { toString: () => 'p1' }, levelId: 10, lastSeenAt: 0,
    playerDelta: { decodedState: { fields: { position: [1, 2, 3] } }, stats: {} } }];
  const frames = [];
  const telemetry = new QwdTelemetry({ players: { listActive: () => active }, now: () => now,
    publishTelemetry: (players, seq, framing) => frames.push({ players, seq, framing }) });
  return { telemetry, frames, advance: ms => { now += ms; }, player: active[0], remove: () => { active = []; } };
}

test('telemetry first frame is full, unchanged players are kept alive, then removed via delta', () => {
  const f = telemetryFixture();
  f.telemetry.publish();
  assert.equal(f.frames[0].framing, undefined);
  assert.equal(f.frames[0].seq, 1);
  f.advance(1000); f.telemetry.publish();
  assert.equal(f.frames.length, 1);
  f.advance(1000); f.telemetry.publish();
  assert.equal(f.frames[1].framing.kind, 'delta');
  assert.equal(f.frames[1].framing.baseSeq, 1);
  f.remove(); f.advance(1000); f.telemetry.publish();
  assert.deepEqual(f.frames[2].framing.removedPlayers, ['p1']);
});

test('telemetry snapshots position arrays and periodically resynchronizes full state', () => {
  const f = telemetryFixture();
  f.telemetry.publish();
  f.player.playerDelta.decodedState.fields.position[0] = 9;
  f.advance(1000); f.telemetry.publish();
  assert.equal(f.frames[0].players[0].position[0], 1);
  assert.equal(f.frames[1].players[0].position[0], 9);
  f.advance(10_000); f.telemetry.publish();
  assert.equal(f.frames.at(-1).framing, undefined);
  const before = f.frames.length;
  f.telemetry.forceFull();
  assert.equal(f.frames.length, before + 1);
  assert.equal(f.frames.at(-1).framing, undefined);
});

function reservationFixture(players = { size: 1, maxPlayers: 8 }) {
  let now = 0;
  const events = [];
  const reservations = new RoomReservations({ players, identity: { id: 'room' }, now: () => now,
    publish: (event, data) => events.push({ event, data }) });
  return { reservations, events, advance: ms => { now += ms; } };
}

test('reservations enforce capacity accounting, completion and expiry ownership', () => {
  const f = reservationFixture();
  f.reservations.create('move', ['a', 'b']);
  assert.equal(f.reservations.reservedSlots(), 2);
  assert.equal(f.reservations.hasCapacity(5), true);
  assert.equal(f.reservations.hasCapacity(6), false);
  assert.equal(f.reservations.findByPlayer('a'), 'move');
  f.reservations.consume('a');
  assert.equal(f.reservations.size, 1);
  f.reservations.consume('b');
  assert.equal(f.reservations.size, 0);
  assert.equal(f.events[0].event, 'move.completed');
  f.reservations.create('expires', ['c'], 100);
  f.advance(100); f.reservations.expire();
  assert.equal(f.reservations.size, 0);
  assert.equal(f.events[1].event, 'reservation.expired');
});

test('transport loss caps reservation lifetime; renew and cancel use explicit store APIs', () => {
  const f = reservationFixture();
  f.reservations.create('move', ['a'], 100_000);
  f.reservations.transportDropped();
  assert.equal(f.reservations.get('move').expiresAt, 15_000);
  f.reservations.renew('move', 200);
  assert.equal(f.reservations.get('move').expiresAt, 200);
  f.reservations.cancel('move');
  assert.equal(f.reservations.size, 0);
});

test('migration rosters reserve unique IDs and release them on expiry and shutdown', () => {
  const players = new PlayerStore({ maxPlayers: 8 });
  const { reservations } = reservationFixture(players);
  let now = 0;
  const rosters = new MigrationRosters({ players, reservations, logger: { warn() {} }, now: () => now });
  const ids = ['a', 'b'].map(value => ({ toString: () => value }));
  const payload = { uuid: ids[0], moving: true, levelId: 7, move: { players: ids } };
  const roster = rosters.claim({ id: 'session' }, payload);
  assert.equal(roster.entries.length, 2);
  assert.notEqual(roster.entries[0].netId, roster.entries[1].netId);
  assert.equal(rosters.claim({ id: 'second' }, payload), roster);
  now = 15_000;
  rosters.expire();
  assert.equal(rosters.size, 0);
  const next = rosters.claim({ id: 'third' }, payload);
  assert.ok(next);
  rosters.clear();
  assert.equal(rosters.size, 0);
});

test('completed migration roster releases matching reservation only after everyone joins', () => {
  const players = new PlayerStore({ maxPlayers: 8 });
  const { reservations } = reservationFixture(players);
  reservations.create('move', ['a', 'b']);
  const rosters = new MigrationRosters({ players, reservations, logger: { warn() {} } });
  const ids = ['a', 'b'].map(value => ({ toString: () => value }));
  const roster = rosters.claim({ id: 'session' }, { uuid: ids[0], move: { players: ids } });
  roster.joined.add('a'); rosters.complete(roster);
  assert.equal(rosters.size, 1);
  roster.joined.add('b'); rosters.complete(roster);
  assert.equal(rosters.size, 0);
  assert.equal(reservations.size, 0);
});
