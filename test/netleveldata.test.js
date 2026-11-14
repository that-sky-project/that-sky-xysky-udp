import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeNetLevelDataMsg, encodeNetLevelDataMsg, NET_LEVEL_DATA_HEADER_BYTES } from '../src/protocol/types/NetLevelDataMsg.js'
import { SnapshotReader } from '../src/protocol/snapshot/SnapshotReader.js'

// Official empty Elect, packetdump_20261112162042 seq 369. The first three
// bytes are Snapshot [save=2, base=1, checksum=0x18]; the remainder is XOR-RLE.
const OFFICIAL_EMPTY_ELECT_FRAME = Buffer.from('0201185cde872cd2020010', 'hex')
const OFFICIAL_EMPTY_ELECT = Buffer.from('5cde872cd20200000000000000000000000000000000', 'hex')

// Decompressed prefix from official type-11 C2S data (capture seq 377).
const OFFICIAL_UPLOAD_HEAD = Buffer.from('00de872cd2020001a06300000000002002007d00c2109c30', 'hex')

test('official empty Elect snapshot decodes to the native 22-byte message', () => {
  const decoded = new SnapshotReader().read(OFFICIAL_EMPTY_ELECT_FRAME)
  assert.equal(decoded.ok, true)
  assert.deepEqual(decoded.data, OFFICIAL_EMPTY_ELECT)
  assert.equal(decoded.data.length, NET_LEVEL_DATA_HEADER_BYTES)

  const message = decodeNetLevelDataMsg(decoded.data)
  assert.equal(message.electedPlayer, 92)
  assert.equal(message.levelId, 0xd22c87de)
  assert.equal(message.authorityVersion, 2)
  assert.equal(message.hasInitialData, false)
  assert.equal(message.dataLength, 0)
  assert.equal(message.trailingBytes, 0)
  assert.deepEqual(encodeNetLevelDataMsg(message), decoded.data)
})

test('official authority upload head follows the same native field order', () => {
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt8(0), 0, 'upload player field; authority is bound to the session')
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt32LE(1), 0xd22c87de, 'level id')
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt16LE(5), 2, 'authority version inherited from Elect')
  assert.equal(OFFICIAL_UPLOAD_HEAD[7] & 1, 1, 'initial state present')
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt16LE(8), 25504, 'unknown2')
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt8(10), 0, 'unknown3')
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt32LE(11), 0, 'level hash')
  assert.equal(OFFICIAL_UPLOAD_HEAD.readUInt8(15), 32, 'merge state')
})

test('round-trip preserves the native header and level state', () => {
  const original = {
    electedPlayer: 3,
    levelId: 0xdeadbeef,
    authorityVersion: 74,
    hasInitialData: true,
    unknown2: 2,
    unknown3: 1,
    levelHash: 0x63c001,
    mergeState: 6,
    unknown5: 2,
    unknown6: 1,
    levelData: Buffer.from([1, 2, 3, 4, 5])
  }
  const wire = encodeNetLevelDataMsg(original)
  const back = decodeNetLevelDataMsg(wire)
  assert.equal(wire.length, NET_LEVEL_DATA_HEADER_BYTES + 5)
  assert.equal(back.electedPlayer, original.electedPlayer)
  assert.equal(back.levelId, original.levelId)
  assert.equal(back.authorityVersion, original.authorityVersion)
  assert.equal(back.hasInitialData, true)
  assert.equal(back.levelHash, original.levelHash)
  assert.equal(back.mergeState, original.mergeState)
  assert.deepEqual(back.levelData, original.levelData)
})

test('encoder rejects obsolete header fields and decoder rejects trailing bytes', () => {
  assert.throws(() => encodeNetLevelDataMsg({ electedPlayer: 1, levelId: 2, unknown0: 1 }), /obsolete/)
  const wire = encodeNetLevelDataMsg({ electedPlayer: 1, levelId: 2, authorityVersion: 2 })
  assert.throws(() => decodeNetLevelDataMsg(Buffer.concat([wire, Buffer.from([0])])), /trailing bytes/)
})
