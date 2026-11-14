import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotResyncPacket } from '../src/protocol/packets/server/SnapshotResyncPacket.js'
import { packetTypes } from '../src/protocol/PacketRegistry.js'
import { PlayerSnapshotState } from '../src/features/gamemsg/PlayerSnapshotState.js'
import { BinaryWriter } from '../src/protocol/binary/BinaryWriter.js'

test('SnapshotResync (id 5) registers with zero payload', () => {
  const t = packetTypes.get(5)
  assert.equal(t, SnapshotResyncPacket)
  const w = new BinaryWriter()
  t.encode(w, {})
  assert.equal(w.toBuffer().length, 0, 'client id-5 branch reads no payload')
})

test('PlayerSnapshotState flags resyncRequired on resyncfailed', () => {
  const st = new PlayerSnapshotState()
  assert.equal(st.resyncRequired, false)
  // Fill the window without ever acking. At the default 10-frame keyframe
  // period the 16-entry window overflows twice after ~330 unacked frames
  // (overflow 1 = resyncstart empties it; the second overflow, with resync
  // already pending, reports resyncfailed).
  for (let i = 0; i < 400; i += 1) {
    st.write(Buffer.alloc(64, 2))
  }
  assert.equal(st.resyncRequired, true, 'state flagged for id-5 dispatch')
  st.reset()
  assert.equal(st.resyncRequired, false, 'reset clears the flag')
})

test('acked window stays healthy', () => {
  const st = new PlayerSnapshotState()
  st.write(Buffer.alloc(32, 7))
  const frame = st.write(Buffer.alloc(32, 7))
  assert.ok(frame, "frame emitted")  // delta frames carry save_seq=0
  st.ack(frame.sequence)
  assert.equal(st.writer.resync, false, 'acked window is healthy')
  assert.equal(st.resyncRequired, false)
})
