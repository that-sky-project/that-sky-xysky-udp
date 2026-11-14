import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePlayerState, encodePlayerState } from '../src/protocol/types/PlayerState.js'

// Official 0.35.1 C2S PlayerState (packetdump_20261112162042, decompressed via
// the session snapshot channel). The Nov-12 session only exercised mode=0 /
// variant 0..7 / 5b79=0, which is how the earlier bounds (mode 0..8,
// variant 0..10, 5b79/5b7a 0..2) were derived; live 0.35.1 clients write
// mode=14, 5b79=3 and those were rejected ("bounded integer exceeds range").
const GOLDEN = Buffer.from('012b528d3ff18a903f7d04c5bedb270000000000c59d1c810677f72723d3d23af379120c0800010000000100010000de872cd20000000000000000dff77ddff7f7f7f71e78efbff7def3de4bc9ffc0ff7ffff77fdff7fdfdfdfd398242f79c7b83637a7a6381ff0101000000000000000000000000000000001f000000000000000000000000000000000000000000000000ffffffff00000000000000000000000000000000000000000000000000a0400100000000fafbffff00200000000000aaaa0000000000000000000000000000000000ef3d020000006fd56c33ccf38cb44d030000803e000000000000000000000000000000000000000000000000000500910003687cf401000001000000000000000000000000000000000000000000000000000080bf0000000000000000000000000000000000000000000000000000000000000000000080bf00000000000000000000000000000000846d05dc000c000000286e6f6e652c6e6f6e652900773ed485000c000000286e6f6e652c6e6f6e65290090de4149000c000000286e6f6e652c6e6f6e652900a2e85ada000c000000286e6f6e652c6e6f6e652900d3e58ce2000c000000286e6f6e652c6e6f6e65290026e6515b000c000000286e6f6e652c6e6f6e6529001df65fdb000c000000286e6f6e652c6e6f6e652900c57093d6000c000000286e6f6e652c6e6f6e652900114e4d79000c000000286e6f6e652c6e6f6e652900737aa557000c000000286e6f6e652c6e6f6e652900719d0001000000e4010001000000000000ffffffffffff001e0000000000000010000000f301d009986c0000180000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004ff9a99993f00000000000000000000000000ffffffff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000dff7ffffffffffffffffbf3ff07bef81c7f31ef01008ee8101d003000000000000000000000000000000', 'hex')

test('official 0.35.1 state decodes with exact consumption', () => {
  const decoded = decodePlayerState(GOLDEN)
  assert.equal(decoded.complete, true)
  assert.equal(decoded.layout, 'u64-full')
  assert.equal(GOLDEN.length * 8 - decoded.bits <= 7, true)
})

test('widened bounds accept live-client values and round-trip exactly', () => {
  const base = decodePlayerState(GOLDEN)
  const mutated = structuredClone(base.fields)
  mutated.anim.mode = 14
  mutated.anim.variant = 15
  mutated.offset_5b79 = 3
  mutated.offset_5b7a = 3
  mutated.outfit.items[0].name = 'Thexiaoyu'
  const encoded = encodePlayerState({ fields: mutated, layout: base.layout, rawState: base.rawState })
  const back = decodePlayerState(encoded)
  assert.equal(back.complete, true)
  assert.equal(back.fields.anim.mode, 14)
  assert.equal(back.fields.anim.variant, 15)
  assert.equal(back.fields.offset_5b79, 3)
  assert.equal(back.fields.offset_5b7a, 3)
  assert.equal(back.fields.outfit.items[0].name, 'Thexiaoyu')
  assert.equal(encoded.length * 8 - back.bits <= 7, true)
})

test('bound widening is width-neutral: byte count unchanged', () => {
  // bounded(0,2)→(0,3) stays 2 bits; bounded(0,8)/(0,10)→(0,15) stay 4 bits,
  // so re-encoding the ORIGINAL fields must reproduce the original bytes.
  const base = decodePlayerState(GOLDEN)
  const encoded = encodePlayerState({ fields: base.fields, layout: base.layout, rawState: base.rawState })
  assert.equal(encoded.length, GOLDEN.length)
})
