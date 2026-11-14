import test from 'node:test'
import assert from 'node:assert/strict'

import { PlayerStore } from '../src/domain/PlayerStore.js'
import { LevelStateStore } from '../src/domain/LevelStateStore.js'
import { LevelService } from '../src/features/level/LevelService.js'
import { GameMessageService } from '../src/features/gamemsg/GameMessageService.js'
import { GameMsgType } from '../src/protocol/packets/shared/GameMsgPacket.js'
import { SnapshotReader } from '../src/protocol/snapshot/SnapshotReader.js'
import { SnapshotWriter } from '../src/protocol/snapshot/SnapshotWriter.js'
import { decodeNetLevelDataMsg, encodeNetLevelDataMsg } from '../src/protocol/types/NetLevelDataMsg.js'

const LEVEL = 2477345666

function session (id) {
  return { id, peerId: { toString: () => id }, isActive: () => true, transition () {}, attachPlayer (player) { this.player = player } }
}

function harness () {
  const sent = []
  const players = new PlayerStore({ maxPlayers: 8 })
  const levels = new LevelStateStore({ roomId: 1, logger: { info () {}, debug () {}, warn () {} } })
  const broadcaster = { send: (target, packet) => sent.push({ target, packet }), broadcast () {} }
  const messages = new GameMessageService({ players, levels, broadcaster,
    logger: { info () {}, debug () {}, warn () {} } })
  const levelService = new LevelService({ players, levels, broadcaster,
    logger: { info () {}, debug () {}, warn () {} } })
  levels.onAuthorityElected((levelId, authority, targetPlayer) => {
    const targets = (targetPlayer ? [targetPlayer] : players.listActiveInLevel(levelId))
      .filter(player => player.levelReady)
    for (const player of targets) {
      messages.sendElect(player, authority, levels.loadLevelData(levelId))
      player.lastAuthoritySync = `${levelId}:${player.lvSeq}:${authority.id}:${levels.getAuthorityVersion(levelId)}`
    }
  })
  const s = session('s1')
  const player = players.add({ session: s, uuid: { toString: () => 'uuid-1' }, levelId: LEVEL,
    netVersion: { values: [0x28e5, 39133, 23504, 0, 0, 25504] }, levelChangeCount: 0 })
  s.player = player
  levels.setAuthority(LEVEL, player, { reason: 'join_first_player' })
  return { sent, players, levels, messages, levelService, session: s, player }
}

function elects (state) {
  return state.sent.filter(entry => entry.packet.payload.type === GameMsgType.NetLevelDataElect)
}

function decodeElect (entry) {
  const payload = entry.packet.payload
  const decoded = new SnapshotReader().read({ ...payload.snapshot, payload: payload.payload })
  assert.equal(decoded.ok, true)
  return decodeNetLevelDataMsg(decoded.data)
}

test('initial Elect waits for LevelUpdate and duplicate updates do not re-elect', () => {
  const state = harness()
  assert.equal(elects(state).length, 0, 'JoinGame is not yet a ready level generation')
  assert.equal(state.levels.getAuthorityVersion(LEVEL), 2)
  state.levelService.changeLevel(state.session, { levelId: LEVEL, netVersion: state.player.netVersion,
    levelChangeCount: 1 })
  assert.equal(elects(state).length, 1)
  const first = decodeElect(elects(state)[0])
  assert.equal(first.levelId, LEVEL)
  assert.equal(first.electedPlayer, state.player.id)
  assert.equal(first.authorityVersion, 2)
  assert.equal(first.hasInitialData, false)
  assert.equal(elects(state)[0].packet.payload.levelChangeCount, 1)

  state.levelService.changeLevel(state.session, { levelId: LEVEL, netVersion: state.player.netVersion,
    levelChangeCount: 1 })
  assert.equal(elects(state).length, 1, 'same-level same-generation update is idempotent')

  state.levelService.changeLevel(state.session, { levelId: LEVEL, netVersion: state.player.netVersion,
    levelChangeCount: 2 })
  assert.equal(elects(state).length, 2, 'a new client generation receives the current election')
  const second = decodeElect(elects(state)[1])
  assert.equal(second.authorityVersion, first.authorityVersion, 'resync does not invent a new election')
  assert.equal(elects(state)[1].packet.payload.levelChangeCount, 2)
})

test('a second joiner does not receive Elect before its LevelUpdate', async () => {
  const state = harness()
  const { JoinService } = await import('../src/features/join/JoinService.js')
  const joinerSession = session('s2')
  const joins = new JoinService({ players: state.players, levels: state.levels,
    broadcaster: { send () {}, broadcast () {} }, logger: { info () {}, warn () {}, debug () {} },
    metrics: { onlinePlayers: { set () {} } } })
  joins.join(joinerSession, { uuid: { toString: () => 'uuid-2' }, levelId: LEVEL,
    netVersion: state.player.netVersion, levelChangeCount: 0 })
  assert.equal(elects(state).length, 0)
  state.levelService.changeLevel(joinerSession, { levelId: LEVEL, netVersion: state.player.netVersion,
    levelChangeCount: 1 })
  assert.equal(elects(state).length, 1)
  assert.equal(elects(state)[0].target, joinerSession)
  assert.equal(decodeElect(elects(state)[0]).electedPlayer, state.player.id)
})

test('new authorities advance version, sync peers, and reject stale uploads', () => {
  const state = harness()
  const firstVersion = state.levels.getAuthorityVersion(LEVEL)
  state.levels.revokeAuthority(LEVEL, { reason: 'test' })
  state.levels.setAuthority(LEVEL, state.player, { reason: 'test_reselect' })
  assert.equal(state.levels.getAuthorityVersion(LEVEL), firstVersion + 2)

  const body = Buffer.from([1, 2, 3])
  const makeUpload = authorityVersion => {
    const raw = encodeNetLevelDataMsg({ electedPlayer: 0, levelId: LEVEL, authorityVersion,
      hasInitialData: true, levelData: body })
    const frame = new SnapshotWriter().write(raw)
    return { type: GameMsgType.NetLevelData, levelChangeCount: state.player.lvSeq, sourcePlayer: 0,
      snapshot: { sequence: frame[0], base: frame[1], checksum: frame[2] }, payload: frame.subarray(3) }
  }

  state.messages.handle(state.session, makeUpload(firstVersion))
  assert.equal(state.levels.loadLevelData(LEVEL), undefined, 'old authority epoch is rejected')

  state.player.levelDelta.reset()
  state.messages.handle(state.session, makeUpload(state.levels.getAuthorityVersion(LEVEL)))
  assert.deepEqual(state.levels.loadLevelData(LEVEL).payload, body)

  const peerSession = session('peer')
  const peer = state.players.add({ session: peerSession, uuid: { toString: () => 'uuid-peer' }, levelId: LEVEL,
    netVersion: state.player.netVersion, levelChangeCount: 1 })
  peer.levelReady = true
  state.messages.syncLevelData()
  const packet = state.sent.find(entry => entry.target === peerSession &&
    entry.packet.payload.type === GameMsgType.NetLevelData)?.packet
  assert.ok(packet, 'ready non-authority peer receives cached level data')
  const decodedFrame = new SnapshotReader().read({ ...packet.payload.snapshot, payload: packet.payload.payload })
  assert.equal(decodedFrame.ok, true)
  const synced = decodeNetLevelDataMsg(decodedFrame.data)
  assert.equal(synced.authorityVersion, state.levels.getAuthorityVersion(LEVEL) + 1)
  assert.equal(synced.levelId, LEVEL)
  assert.deepEqual(synced.levelData, body)
})
