import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BinaryReader } from '../src/protocol/binary/BinaryReader.js'
import { decodeNetRpcRecords, GIFT_CLASS_HASH } from '../src/protocol/packets/shared/netRpc/NetRpcCodec.js'
import { createNetRpcRouter } from '../src/protocol/packets/shared/netRpc/NetRpcRouter.js'
import { decodeGiftBody, GiftTypeFlag } from '../src/protocol/packets/shared/netRpc/handlers/giftHandler.js'

// Official captures (packetdump_20261030203945 / 20260913131425, GameMsg
// type 2). The wire record layout is [slot u8][classHash u32 LE][flags u8]
// [bodyLen u16 LE][body] for relayed traffic; live client traffic chains
// records without the slot byte. The 36-byte gift body layout is
// [slots 2][typeFlag 1][abilityId 4 LE][itemCount 4 LE]
// [signedReceiverUuid 16 @11][extra 4][trailing 5].
const UP_GIFT_FULL = Buffer.from(
  '0206001db3b9d9200028001d1f0001000000010000000000000000000000000000000000000000000000010000000000000000',
  'hex'
)
const DOWN_GIFT_83 = Buffer.from(
  '02061f1fb3b9d9200048001d1f01010000000100000003846ebce35d448e81d2aa021f3ca5b92fcec46b0100000000200000006136646564626634336439653361353733636265616462653133363131663931',
  'hex'
)

// Live session log (2026-08-14 18:02:40.450, C2S accept, no-slot framing):
// body[2]=1 (accept), ability 0x23, count 1, accepting player's own uuid at
// body[11..27].
const LIVE_ACCEPT_RPC = Buffer.from(
  'b3b9d920002400' + '0201 01 23000000 01000000'.replaceAll(' ', '') +
  'fe2ab94df211451f94ba32ad9562597d' + '000000000100000000',
  'hex'
)

test('official gift UP packet parses as a slot/hash/len record', () => {
  // strip the 3-byte GameMsg header, then decode
  const rpcData = UP_GIFT_FULL.subarray(3)
  const parsed = decodeNetRpcRecords(rpcData)
  assert.equal(parsed.records.length, 1, 'single record')
  const rec = parsed.records[0]
  assert.equal(rec.slot, 0x1d, 'slot byte precedes the class hash')
  assert.equal(rec.classHash, GIFT_CLASS_HASH, 'gift class hash b3b9d920')
  assert.equal(rec.flags, 0x00, 'gift flags byte is 0x00 on the wire')
  assert.equal(rec.bodyLen, 0x28, 'bodyLen 40')
  assert.equal(rec.body.length, 40)
  assert.equal(parsed.framing, 'slot', 'official capture uses slot-prefixed framing')
})

test('official gift DOWN 83-byte packet carries the accepter uuid at body offset 11', () => {
  const rpcData = DOWN_GIFT_83.subarray(3)
  const parsed = decodeNetRpcRecords(rpcData)
  assert.equal(parsed.records.length, 1)
  const rec = parsed.records[0]
  assert.equal(rec.classHash, GIFT_CLASS_HASH)
  assert.equal(rec.bodyLen, 0x48, 'bodyLen 72')
  // packetdump_20260913131425: 7/7 accepts are v4-valid ONLY at body[11..27]
  // (0/7 at offsets 10 and 12) — this record is one of them.
  const uuid = rec.body.subarray(11, 27)
  assert.equal(uuid.toString('hex'), '03846ebce35d448e81d2aa021f3ca5b9')
  assert.equal(uuid[6] >> 4, 4, 'uuid version nibble 4')
  assert.equal(uuid[8] & 0xC0, 0x80, 'uuid variant 10xx')
  assert.equal(rec.body.subarray(10, 26).toString('hex') !== uuid.toString('hex') ||
    rec.body[10] === 0, true)
})

test('gift body decodes slots, ability, count and the receiver uuid', () => {
  const rpcData = DOWN_GIFT_83.subarray(3)
  const rec = decodeNetRpcRecords(rpcData).records[0]
  const body = decodeGiftBody(rec.body)
  assert.equal(body.typeFlag, GiftTypeFlag.Accept)
  assert.equal(body.abilityId, 1)
  assert.equal(body.itemCount, 1)
  assert.equal(body.receiverUuid.toString('hex'), '03846ebce35d448e81d2aa021f3ca5b9')
})

test('router patches the accepter uuid at body offset 11 in slot framing', () => {
  const router = createNetRpcRouter()
  const rpcData = DOWN_GIFT_83.subarray(3)
  const uuid = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', 'hex')
  const out = router.process(rpcData, {
    source: { id: 31, uuid: { bytes: uuid, toString: () => 'aa-ab' } },
    logger: null
  })
  assert.notDeepEqual([...out], [...rpcData], 'patched')
  // structure preserved: slot/hash/flags/len unchanged
  assert.equal(out[0], rpcData[0], 'slot preserved')
  assert.equal(out.readUInt32LE(1), GIFT_CLASS_HASH, 'hash preserved')
  assert.equal(out.readUInt16LE(6), rpcData.readUInt16LE(6), 'bodyLen preserved (same size)')
  // slot framing: body starts at rpcData[8], so body[11..27] = rpcData[19..35]
  assert.deepEqual([...out.subarray(19, 35)], [...uuid], 'uuid written at body offset 11')
  // bytes outside the uuid stay identical
  assert.deepEqual([...out.subarray(8, 19)], [...rpcData.subarray(8, 19)], 'pre-uuid bytes intact')
  assert.deepEqual([...out.subarray(35)], [...rpcData.subarray(35)], 'post-uuid bytes intact')
})

test('router patches the live no-slot accept without corrupting the chain', () => {
  const router = createNetRpcRouter()
  const uuid = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', 'hex')
  const out = router.process(LIVE_ACCEPT_RPC, {
    source: { id: 1, uuid: { bytes: uuid, toString: () => 'aa-ab' } },
    logger: null
  })
  assert.notDeepEqual([...out], [...LIVE_ACCEPT_RPC], 'patched')
  const reparsed = decodeNetRpcRecords(out)
  assert.equal(reparsed.framing, 'no-slot')
  assert.equal(reparsed.records.length, 1)
  const rec = reparsed.records[0]
  assert.equal(rec.classHash, GIFT_CLASS_HASH)
  assert.equal(rec.flags, 0x00)
  assert.equal(rec.bodyLen, 0x24, 'bodyLen 36 unchanged')
  assert.equal(rec.body[2], GiftTypeFlag.Accept)
  assert.deepEqual([...rec.body.subarray(11, 27)], [...uuid], 'uuid at body[11..27]')
  assert.equal(rec.body.readUInt32LE(3), 0x23, 'ability preserved')
  assert.equal(rec.body.readUInt32LE(7), 1, 'item count preserved')
  assert.deepEqual([...out.subarray(7, 18)], [...LIVE_ACCEPT_RPC.subarray(7, 18)], 'header + pre-uuid intact')
  assert.deepEqual([...out.subarray(34)], [...LIVE_ACCEPT_RPC.subarray(34)], 'extra + trailing intact')
})

test('a throwing handler leaves the record byte-identical and never throws out', () => {
  const router = createNetRpcRouter()
  router.register(GIFT_CLASS_HASH, 0x00, () => { throw new Error('boom') })
  const out = router.process(LIVE_ACCEPT_RPC, {
    source: { id: 1, uuid: { bytes: Buffer.alloc(16, 1) } },
    logger: { warn () {} }
  })
  assert.deepEqual([...out], [...LIVE_ACCEPT_RPC], 'record relayed untouched on handler failure')
})

test('multi-record gift batch keeps unhandled records byte-identical', () => {
  // The 79-byte DOWN capture carries two records (40 + 27+pad bodies).
  const two = Buffer.concat([
    UP_GIFT_FULL.subarray(3),
    Buffer.from('0f', 'hex'), // second record: slot 0x0f
    Buffer.from('2001d2f5', 'hex'), // some other class hash
    Buffer.from('00', 'hex'), // flags
    Buffer.from('0400', 'hex'), // bodyLen 4
    Buffer.from('deadbeef', 'hex') // body
  ])
  const router = createNetRpcRouter()
  const uuid = Buffer.alloc(16, 0xcd)
  const out = router.process(two, {
    source: { id: 29, uuid: { bytes: uuid, toString: () => 'cd-cd' } },
    logger: null
  })
  // second record tail untouched
  assert.deepEqual(
    [...out.subarray(out.length - 15)],
    [...two.subarray(two.length - 15)],
    'trailing unhandled record preserved'
  )
  // The first record is an OFFER (body[2]=0), not an accept — the router
  // must leave it byte-identical, and the fake uuid must appear nowhere.
  assert.deepEqual(
    [...out.subarray(0, 48)],
    [...UP_GIFT_FULL.subarray(3)],
    'offer record untouched'
  )
  assert.ok(!out.subarray(19, 35).some(b => b === 0xcd), 'no uuid injected on offer')
})
