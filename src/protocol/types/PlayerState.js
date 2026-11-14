import { isDeepStrictEqual } from 'node:util'
import { BinaryReader } from '../binary/BinaryReader.js'
import { BinaryWriter } from '../binary/BinaryWriter.js'
import { PLAYER_STATE_MAX_BYTES } from '../snapshot/constants.js'
import { ProtocolError } from '../../errors.js'

const PI = Math.fround(Math.PI)

/**
 * Client builds do not all serialize the same field set: some write an 8-byte
 * value at state+0x52B8 and some omit it entirely, which shifts every later
 * field by 64 bits. Rather than hard-coding one build, each variant is tried
 * and the first one that consumes the record exactly wins.
 */
const LAYOUTS = Object.freeze([
  { id: 'u64-full', offset52b8: true },
  { id: 'u64-full-352', offset52b8: true, trailingByte: true },
  { id: 'u64-no-52b8', offset52b8: false }
])
const DEFAULT_LAYOUT = LAYOUTS[0]

function resolveLayout (id) {
  return LAYOUTS.find(entry => entry.id === id) ?? DEFAULT_LAYOUT
}

export function decodePlayerState (
  buffer,
  {
    maxBytes = PLAYER_STATE_MAX_BYTES,
    mode = 2,
    idTable = null,
    layout = null,
    preferredLayout = null
  } = {}
) {
  const rawState = Buffer.from(buffer ?? [])
  assertStateSize(rawState, maxBytes)

  const ordered =
    preferredLayout && !layout
      ? [
          ...LAYOUTS.filter(entry => entry.id === preferredLayout),
          ...LAYOUTS.filter(entry => entry.id !== preferredLayout)
        ]
      : null
  const candidates = layout
    ? LAYOUTS.filter(entry => entry.id === layout)
    : ordered ?? LAYOUTS
  let lastError
  for (const candidate of candidates) {
    const boundOverrides = new Map()
    const widened = []
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const io = new NativeIo(new BinaryReader(rawState), {
        mode,
        idTable,
        layout: candidate,
        boundOverrides
      })
      try {
        const fields = playerState(io)

        if (io.reader.remainingBits > 7) {
          const trailing = new ProtocolError(
            'PlayerState layout left trailing data',
            {
              layout: candidate.id,
              remainingBits: io.reader.remainingBits
            }
          )
          trailing.consumedBits = io.bits
          if (
            !lastError ||
            trailing.consumedBits >= (lastError.consumedBits ?? 0)
          )
            lastError = trailing
          break
        }
        return {
          layout: candidate.id,
          rawState,
          fields,
          complete: true,
          parsed: true,
          bits: io.bits,
          ...(widened.length ? { boundWidened: widened } : {}),
          _originalFields: structuredClone(fields)
        }
      } catch (error) {
        error.consumedBits = io.bits
        if (!lastError || error.consumedBits >= (lastError.consumedBits ?? 0))
          lastError = error
        const d = error.details ?? {}
        if (
          attempt < 7 &&
          typeof d.encoded === 'number' &&
          Number.isSafeInteger(d.min) &&
          Number.isSafeInteger(d.max) &&
          d.min < d.max &&
          d.encoded >= d.min
        ) {
          const width = Math.ceil(Math.log2(d.max - d.min + 1))
          const rawMax = d.min + 2 ** width - 1
          if (rawMax > d.max) {
            const key =
              d.bitOffset !== undefined
                ? `${d.operation}:${d.bitOffset}`
                : `r${d.min}:${d.max}`
            if (!boundOverrides.has(key)) {
              boundOverrides.set(key, rawMax)
              widened.push({
                key,
                min: d.min,
                max: d.max,
                encoded: d.encoded,
                rawMax
              })
              continue
            }
          }
        }
        break
      }
    }
  }
  throw lastError ?? new ProtocolError('PlayerState could not be decoded')
}

/**
 * Header + move only: stateKind, position and velocity.
 *
 * Cross-room migration is driven by where a player is and how fast they are
 * moving; nothing below the move block is used. Stopping there skips the body
 * frames, the queued pose, the outfit strings and the whole tail, which is
 * where most of the cost — and most of the exposure to layout changes between
 * client builds — lives.
 *
 * The layout is not self-validating in this mode (there is no "consumed the
 * whole record" check), so callers pass the layout confirmed by a previous
 * full decode.
 */
export function decodePlayerStateLite (
  buffer,
  {
    maxBytes = PLAYER_STATE_MAX_BYTES,
    mode = 2,
    idTable = null,
    layout = null
  } = {}
) {
  const rawState = Buffer.from(buffer ?? [])
  assertStateSize(rawState, maxBytes)
  const candidate = resolveLayout(layout)
  const io = new NativeIo(new BinaryReader(rawState), {
    mode,
    idTable,
    layout: candidate
  })
  const fields = {}
  fields.stateKind = io.bounded(undefined, 0, 4)
  fields.position = io.vec()
  fields.net = netState(io)
  fields.moveHeader = moveHeader(io)
  fields.offset_52cb = io.u8()
  fields.offset_52b0 = io.u16()
  fields.offset_519c = io.u32()
  if (candidate.offset52b8) fields.offset_52b8 = io.u64(0n)
  fields.move = io.scoped('move', () => moveState(io))
  return {
    layout: candidate.id,
    rawState,
    fields,
    minimal: true,
    complete: false,
    parsed: true,
    bits: io.bits
  }
}

export function encodePlayerState (
  state,
  {
    maxBytes = PLAYER_STATE_MAX_BYTES,
    preserveRaw = true,
    mode = 2,
    idTable = null
  } = {}
) {
  if (Buffer.isBuffer(state) || state instanceof Uint8Array) {
    const raw = Buffer.from(state)
    assertStateSize(raw, maxBytes)
    return raw
  }
  if (!state || typeof state !== 'object' || !state.fields) {
    throw new ProtocolError(
      'PlayerState must be bytes or a decoded state object'
    )
  }
  if (
    preserveRaw &&
    state.rawState &&
    state._originalFields &&
    isDeepStrictEqual(state.fields, state._originalFields)
  )
    return Buffer.from(state.rawState)
  const writer = new BinaryWriter(PLAYER_STATE_MAX_BYTES)
  playerState(
    new NativeIo(writer, {
      mode,
      idTable,
      layout: resolveLayout(state.layout)
    }),
    state.fields
  )
  const encoded = writer.toBuffer()
  assertStateSize(encoded, maxBytes)
  return encoded
}

class NativeIo {
  constructor (
    stream,
    {
      mode = 2,
      idTable = null,
      layout = DEFAULT_LAYOUT,
      boundOverrides = null
    } = {}
  ) {
    this.reader = stream instanceof BinaryReader ? stream : null
    this.writer = stream instanceof BinaryWriter ? stream : null
    this.scopeName = 'PlayerState'
    this.operation = 0

    this.boundOverrides = boundOverrides

    this.mode = [1, 2, 3].includes(mode) ? mode : 2

    this.idTable = idTable

    this.layout = layout ?? DEFAULT_LAYOUT
  }
  get bits () {
    const s = this.reader ?? this.writer
    return s.offset * 8 + s.bitOffset
  }
  bool (v = false) {
    return this.reader
      ? this.reader.readBool()
      : (this.writer.writeBool(v), !!v)
  }
  u8 (v = 0) {
    return this.reader
      ? this.reader.readUInt8()
      : (this.writer.writeUInt8(v), v)
  }
  u16 (v = 0) {
    return this.reader
      ? this.reader.readUInt16()
      : (this.writer.writeUInt16(v), v)
  }
  u32 (v = 0) {
    return this.reader
      ? this.reader.readUInt32()
      : (this.writer.writeUInt32(v), v)
  }
  u64 (v = 0n) {
    return this.reader
      ? this.reader.readUInt64()
      : (this.writer.writeUInt64(v), BigInt(v))
  }
  f32 (v = 0) {
    return this.reader
      ? this.reader.readFloat()
      : (this.writer.writeFloat(v), v)
  }
  bounded (v, min, max, field) {
    const bitOffset = this.bits
    this.operation += 1
    const override = this.boundOverrides?.get(`${this.operation}:${bitOffset}`)
    const x = v ?? min
    try {
      return this.reader
        ? this.reader.readBounded(min, override ?? max)
        : (this.writer.writeBounded(x, min, max), x)
    } catch (error) {
      error.details = {
        ...error.details,
        scope: this.scopeName,
        field,
        operation: this.operation,
        bitOffset
      }
      throw error
    }
  }

  sbounded (v, min, max, field) {
    const x = v ?? min
    const offset = 0x80000000
    const raw = this.reader ? null : (x + offset) >>> 0
    if (this.reader) {
      const rawMin = min + offset,
        rawMax = max + offset
      const override = this.boundOverrides?.get(`r${rawMin}:${rawMax}`)
      return this.reader.readBounded(rawMin, override ?? rawMax) - offset
    }
    return this.setSBounded(raw, min, max, field), x
  }

  setSBounded (raw, min, max, field) {
    const bitOffset = this.bits
    this.operation += 1
    try {
      this.writer.writeBounded(raw, min + 0x80000000, max + 0x80000000)
    } catch (error) {
      error.details = {
        ...error.details,
        scope: this.scopeName,
        field,
        operation: this.operation,
        bitOffset
      }
      throw error
    }
  }

  dynU8 (v = 0) {
    if (this.mode === 3)
      return this.reader
        ? this.reader.readUInt32()
        : (this.writer.writeUInt32(v), v)
    if (this.mode === 2) return this._dynMappedId(v)
    if (this.mode === 1) return this.u8(v)
    throw new ProtocolError('dynamic id field has no negotiated mode', {
      mode: this.mode,
      scope: this.scopeName
    })
  }

  _dynMappedId (v) {
    if (this.reader) {
      const slot = this.reader.readUInt8()
      return this.idTable ? this.idTable.idForSlot(slot) : slot
    }
    const slot = this.idTable ? this.idTable.slotForId(v) : v
    this.writer.writeUInt8(slot & 0xff)
    return v
  }

  scoped (name, callback) {
    const previous = this.scopeName
    this.scopeName = name
    try {
      return callback()
    } finally {
      this.scopeName = previous
    }
  }
  qf (v, min, max, pivot, bits) {
    const x = v ?? pivot
    return this.reader
      ? this.reader.readQuantizedFloat(min, max, pivot, bits)
      : (this.writer.writeQuantizedFloat(x, min, max, pivot, bits), x)
  }
  qv (v, min, max, pivot, bits) {
    const x = v ?? [0, 0, 0]
    return this.reader
      ? this.reader.readQuantizedVector3(min, max, pivot, bits)
      : (this.writer.writeQuantizedVector3(x, min, max, pivot, bits), x)
  }
  vec (v = [0, 0, 0]) {
    return [this.f32(v[0]), this.f32(v[1]), this.f32(v[2])]
  }
  bytes (v, size) {
    if (this.reader) return Buffer.from(this.reader.readBytes(size))
    const b = Buffer.from(v ?? Buffer.alloc(size))
    if (b.length !== size)
      throw new ProtocolError('fixed PlayerState field has wrong size', {
        size,
        actual: b.length
      })
    this.writer.writeBytes(b)
    return b
  }
  string (v = '', max = 64) {
    if (this.reader) {
      const bitOffset = this.bits
      const n = this.reader.readUInt32()
      if (n < 1 || n > max)
        throw new ProtocolError('PlayerState string length out of range', {
          size: n,
          max,
          scope: this.scopeName,
          bitOffset
        })
      const b = this.reader.readBytes(n)
      if (b[n - 1] !== 0)
        throw new ProtocolError('PlayerState string is not NUL terminated', {
          scope: this.scopeName,
          bitOffset,
          size: n
        })
      return b.subarray(0, n - 1).toString('utf8')
    }
    const b = Buffer.concat([Buffer.from(String(v), 'utf8'), Buffer.from([0])])
    if (b.length > max)
      throw new ProtocolError('PlayerState string too long', {
        size: b.length,
        max
      })
    this.writer.writeUInt32(b.length)
    this.writer.writeBytes(b)
    return v
  }
}

function playerState (io, v = {}) {
  const o = {}
  o.stateKind = io.bounded(v.stateKind, 0, 4)
  o.position = io.vec(v.position)
  o.net = netState(io, v.net)
  o.moveHeader = moveHeader(io, v.moveHeader)
  o.offset_52cb = io.u8(v.offset_52cb)
  o.offset_52b0 = io.u16(v.offset_52b0)
  o.offset_519c = io.u32(v.offset_519c)

  if (io.layout.offset52b8) o.offset_52b8 = io.u64(v.offset_52b8 ?? 0n)
  o.move = io.scoped('move', () => moveState(io, v.move))
  const bodyCount = io.bounded(v.body?.length ?? v.bodyCount, 0, 4)
  o.body = Array.from({ length: bodyCount }, (_, i) =>
    io.scoped(`body[${i}]`, () =>
      bodyKeyFrame(io, v.body?.[i], o.position, o.move.rotation0[0])
    )
  )
  o.queuedState = io.scoped('queuedState', () => queuedState(io, v.queuedState))

  o.poseMode = io.bounded(v.offset_5b54 ?? v.poseMode, 0, 3)
  o.levelMeshId = io.u32(v.levelMeshId)

  o.collideOffset = io.vec(v.collideOffset ?? v.offset_5a10)
  o.action = io.scoped('action', () => actionState(io, v.action))
  o.energy = io.scoped('energy', () => energyState(io, v.energy))
  o.offset_5a20 = io.vec(v.offset_5a20)
  o.collideDirection = io.qv(
    v.collideDirection ?? v.facing ?? v.offset_5a30,
    -1,
    1,
    0,
    5
  )
  o.anim = io.scoped('anim', () => animState(io, v.anim))

  o.candleState = boolArray(io, v.candleState ?? v.flags_5ba3, 4)
  o.candlePlayerId = io.dynU8(v.candlePlayerId ?? v.offset_5b28)
  o.candleCharge = io.qf(v.candleCharge ?? v.offset_5ab4, 0, 1, 0, 4)

  o.followerScalar = io.f32(v.followerScalar ?? v.offset_5abc)
  o.followerPlayerId = io.dynU8(v.followerPlayerId ?? v.offset_52d4)
  o.followerState = io.bool(v.followerState ?? v.offset_5bb2)
  o.followerSlotA = io.bounded(v.followerSlotA ?? v.offset_52d8, 0, 3)
  o.followerSlotB = io.bounded(v.followerSlotB ?? v.offset_52d9, 0, 3)

  o.offset_5ba7 = io.bool(v.offset_5ba7)
  if (o.offset_5ba7) {
    o.offset_5b2c = io.dynU8(v.offset_5b2c)
    o.offset_5a40 = io.vec(v.offset_5a40)
  }

  o.offset_5198 = io.qf(v.offset_5198, 0, 50, 0, 8)

  o.offset_52c0 = io.sbounded(v.offset_52c0, -1, 62)
  o.offset_52c4 = io.u16(v.offset_52c4)
  o.offset_52cc = io.u8(v.offset_52cc)
  o.offset_52ce = io.u8(v.offset_52ce)

  o.offset_52c6 = io.bounded(v.offset_52c6, 0, 0x3ff)
  o.offset_52c8_2 = io.bounded(v.offset_52c8_2, 0, 0x3ff)
  o.offset_52cd = io.u8(v.offset_52cd)
  o.offset_52ca = io.bounded(v.offset_52ca, 0, 0x11)

  o.offset_52cf = io.bool(v.offset_52cf)
  o.offset_52d0 = io.bool(v.offset_52d0)
  o.offset_5ba8 = io.bool(v.offset_5ba8)
  o.offset_5ba9 = io.bool(v.offset_5ba9)

  o.offset_5b30 = io.dynU8(v.offset_5b30)
  o.offset_5bc2 = io.u8(v.offset_5bc2)

  o.offset_5b5c = io.sbounded(v.offset_5b5c, -1, 30)
  o.offset_5b60 = io.sbounded(v.offset_5b60, -1, 0xe)

  o.offset_5baa = io.bool(v.offset_5baa)
  o.offset_5890 = io.bool(v.offset_5890)
  o.poseVectors = Array.from({ length: 6 }, (_, i) =>
    io.vec(v.poseVectors?.[i])
  )
  o.offset_5914 = io.u8(v.offset_5914)
  o.offset_5bab = io.bool(v.offset_5bab)
  o.offset_5b8a = io.u8(v.offset_5b8a)

  o.offset_5b79 = io.bounded(v.offset_5b79, 0, 3, 'offset_5b79')
  o.offset_5b7a = io.bounded(v.offset_5b7a, 0, 3, 'offset_5b7a')

  o.outfit = io.scoped('outfit', () => outfitState(io, v.outfit))
  o.offset_5b7b = io.u8(v.offset_5b7b)
  o.offset_5b58 = io.u32(v.offset_5b58)
  o.offset_5b6c = io.bounded(v.offset_5b6c, 0, 255, 'offset_5b6c')

  o.attachedPlayerId = io.dynU8(v.offset_5b44 ?? v.attachedPlayerId)

  const buffSrc = (v.buffs?.length ? v.buffs : v.ids) ?? []
  const buffCount = io.bounded(
    buffSrc.length || v.buffCount || v.idCount,
    0,
    5,
    'buffCount/offset_5b7c'
  )
  o.buffs = Array.from({ length: buffCount }, (_, i) => {
    const item = buffSrc[i]
    const item0 = typeof item === 'object' && item !== null ? item : undefined
    const blob = io.u64(item0?.blob !== undefined ? item0.blob : 0n)
    const value = io.u8(item0?.value ?? v.buffValues?.[i])
    return { blob, value }
  })

  o.offset_5b64 = io.u32(v.offset_5b64)
  o.offset_5b68 = io.u16(v.offset_5b68)
  o.offset_5b34 = io.dynU8(v.offset_5b34)
  o.offset_5bac = io.bool(v.offset_5bac)
  o.offset_5ac0 = io.qf(v.offset_5ac0, 0, 1, 0, 4)

  const attachedCount = io.bounded(
    v.offset_5b7d?.length ?? v.offset_5b7dCount,
    0,
    7,
    'offset_5b7d'
  )
  o.offset_5b7d = Array.from({ length: attachedCount }, (_, i) =>
    io.dynU8(v.offset_5b7d?.[i])
  )
  o.social = io.scoped('social', () => socialState(io, v.social))
  o.worldQuests = io.scoped('worldQuests', () =>
    worldQuestState(io, v.worldQuests)
  )

  o.offset_5bb3 = io.bool(v.offset_5bb3)
  o.offset_5b82 = io.u16(v.offset_5b82)
  o.offset_5b84 = io.u16(v.offset_5b84)
  o.offset_5b86_u16 = io.u16(v.offset_5b86_u16)
  o.offset_5b88 = io.u16(v.offset_5b88)
  o.offset_52d1 = io.bool(v.offset_52d1 ?? v.offset_52c5)
  o.tail = io.scoped('tail', () => tailState(io, v.tail, o.position))
  o.offset_b4 = io.u32(v.offset_b4)
  o.offset_54 = io.bytes(v.offset_54, 16)
  o.offset_64 = io.u32(v.offset_64)
  o.offset_68 = io.bytes(v.offset_68, 16)
  o.offset_78 = io.u8(v.offset_78)
  o.offset_88 = io.u64(v.offset_88 ?? 0n)
  o.offset_80 = io.u32(v.offset_80)
  o.flags_90 = boolArray(io, v.flags_90, 4)
  o.offset_a0 = io.vec(v.offset_a0)
  o.flags_b8 = boolArray(io, v.flags_b8, 4)
  o.offset_5178 = io.bytes(v.offset_5178, 32)
  o.finalFlags = Array.from({ length: 10 }, (_, i) => io.u8(v.finalFlags?.[i]))

  if (io.layout.trailingByte) o.trailing352 = io.u8(v.trailing352)
  return o
}

function netState (io, v = {}) {
  return {
    offset_4: io.u16(v.offset_4),

    modeBytes: [
      io.u8(v.modeBytes?.[0] ?? v.bytes_6_7?.[0]),
      io.u8(v.modeBytes?.[1] ?? v.bytes_6_7?.[1])
    ],
    offset_8: io.bounded(v.offset_8, 0, 0x100),
    offset_a: io.u8(v.offset_a),
    offset_c: io.u32(v.offset_c),
    offset_0: io.bounded(v.offset_0, 0, 3),
    flags: boolArray(io, v.flags ?? v.flags_1, 2)
  }
}

function moveHeader (io, v = {}) {
  return {
    offset_0: io.u64(v.offset_0 ?? 0n),
    bytes_c_11_12_13: [
      io.u8(v.bytes_c_11_12_13?.[0]),
      io.u8(v.bytes_c_11_12_13?.[1]),
      io.u8(v.bytes_c_11_12_13?.[2]),
      io.u8(v.bytes_c_11_12_13?.[3])
    ],
    flags_17_14: boolArray(io, v.flags_17_14, 2),
    offset_15: io.bounded(v.offset_15, 0, 0x30),
    offset_3a: io.bool(v.offset_3a),
    offset_3c: io.u16(v.offset_3c),
    offset_44: io.bounded(v.offset_44, 0, 3),
    offset_46: io.u16(v.offset_46)
  }
}

function moveState (io, v = {}) {
  return {
    rotation0: io.qv(v.rotation0, -PI, PI, 0, 6),
    rotation1: io.qv(v.rotation1, -PI, PI, 0, 6),

    velocity: io.qv(v.velocity, -150, 150, 0, 8),

    direction0: io.qv(v.direction0, -1, 1, 0, 5),
    direction1: io.qv(v.direction1, -1, 1, 0, 5),
    direction2: io.qv(v.direction2, -1.5, 1.5, 0, 5),

    scalar0: io.qf(v.scalar0, -20, 20, 0, 5),
    scalar1: io.qf(v.scalar1, -20, 20, 0, 5),

    flag: io.bool(v.flag),
    direction3: io.qv(v.direction3, -1, 1, 0, 5)
  }
}

function bodyKeyFrame (io, v = {}, base = [0, 0, 0], anglePivot = 0) {
  const time = io.qf(v.time, 0, 3, 0, 12)

  const weights = Array.from({ length: 6 }, (_, i) =>
    io.qf(v.weights?.[i], 0, 1, 0, 3)
  )
  const position = add3(base, io.qv(sub3(v.position, base), -20, 20, 0, 12))
  return {
    time,
    weights,
    position,

    normal: io.qv(v.normal, -1, 1, 0, 6),
    tangent: io.qv(v.tangent, -1, 1, 0, 8),

    point0: add3(position, io.qv(sub3(v.point0, position), -4, 4, 0, 8)),
    point1: add3(position, io.qv(sub3(v.point1, position), -2, 2, 0, 5)),
    point2: add3(position, io.qv(sub3(v.point2, position), -2, 2, 0, 5)),
    point3: add3(position, io.qv(sub3(v.point3, position), -2, 2, 0, 8)),
    point4: add3(position, io.qv(sub3(v.point4, position), -2, 2, 0, 8)),

    angle: io.qf(v.angle, -PI, PI, anglePivot, 10),
    flag: io.bool(v.flag)
  }
}

function queuedState (io, v = {}) {
  const o = {
    pendingFlag: io.u8(v.pendingFlag ?? v.offset_2f9),
    id: io.u32(v.id),
    position: io.vec(v.position),
    rotation: io.qf(v.rotation, -PI, PI, 0, 6)
  }
  const n = io.bounded(
    v.frames?.length ?? v.count,
    0,
    4,
    'queuedState.count/offset_2f4'
  )
  o.frames = Array.from({ length: n }, (_, i) =>
    bodyKeyFrame(io, v.frames?.[i], o.position, o.rotation)
  )
  o.offset_2f0 = io.u32(v.offset_2f0)
  o.blendByte = io.u64(v.blendByte ?? v.offset_2e0 ?? 0n)
  o.blendWeight = io.qf(v.blendWeight ?? v.offset_2d0, 0, 3, 0, 9)
  o.blendRaw = io.f32(v.blendRaw ?? v.offset_2dc)

  o.reserved = Array.from({ length: 4 }, (_, i) =>
    io.u8(v.reserved?.[i] ?? v.bytes_2f5?.[i])
  )
  o.queueMode = io.bounded(v.queueMode ?? v.offset_2ec, 0, 8)
  return o
}

function actionState (io, v = {}) {
  return {
    playerId: io.dynU8(v.playerId),

    progress0: io.qf(v.progress0 ?? v.amount0, 0, 1, 0, 5),
    raw0: io.f32(v.raw0),
    progress1: io.qf(v.progress1 ?? v.amount1, 0, 1, 0, 5),
    raw1: io.f32(v.raw1),
    raw2: io.f32(v.raw2),
    flags: boolArray(io, v.flags, 10),

    actionId: io.bounded(v.actionId, 0, 0x1401),
    signed0: io.sbounded(v.signed0, -1, 8),
    signed1: io.sbounded(v.signed1, -1, 8),
    finalFlag: io.u8(v.finalFlag)
  }
}

function energyState (io, v = {}) {
  const maxEnergy = io.bounded(v.wingTier ?? v.maxEnergy, 0, 14)
  return {
    maxEnergy,
    wingTier: maxEnergy,
    normalized: io.qf(v.normalized, 0, 1, 0, 6),
    low: io.bool(v.low),

    current: io.qf(v.wingCharge ?? v.current, -3, maxEnergy, 0, 14),
    velocity: io.qf(v.velocity, -4, 4, 0, 8),

    onlyUseFlightEnergy: io.bool(v.onlyUseFlightEnergy),
    charge: io.qf(v.charge, 0, 10, 0, 5),
    flight: io.qf(v.flight, 0, 10, 0, 5),
    flags: boolArray(io, v.flags, 5),
    raw0: io.f32(v.raw0),
    scalar0: io.qf(v.scalar0, -1, 2, 0, 16),
    scalar1: io.qf(v.scalar1, 1, 2, 1.5, 8),
    raw1: io.f32(v.raw1)
  }
}

function animState (io, v = {}) {
  return {
    id: io.u32(v.id),

    time: io.u64(v.time ?? 0n),

    duration: io.qf(v.duration, 0, 3, 0, 12),
    raw: io.f32(v.raw),
    reserved: Array.from({ length: 4 }, (_, i) =>
      io.u8(v.reserved?.[i] ?? v.bytes?.[i])
    ),

    mode: io.bounded(v.mode, 0, 15),

    variant: io.bounded(v.variant, 0, 15),

    weights: Array.from({ length: 3 }, (_, i) =>
      io.qf(v.weights?.[i], 0, 1, 0, 5)
    ),
    flag: io.bool(v.flag),

    blend: Array.from({ length: 5 }, (_, i) => io.qf(v.blend?.[i], 0, 1, 0, 8)),
    raw2: io.f32(v.raw2),

    blendFinal: io.qf(v.blendFinal ?? v.final, 0, 1, 0, 4)
  }
}

export const OUTFIT_SLOTS = Object.freeze([
  'hair',
  'hat',
  'horn',
  'mask',
  'face',
  'neck',
  'body',
  'feet',
  'wing',
  'prop'
])

function outfitState (io, v = {}) {
  const items = Array.from({ length: OUTFIT_SLOTS.length }, (_, i) => {
    const slot = OUTFIT_SLOTS[i]
    const src = v.item?.[slot] ?? v.items?.[i]
    return {
      slot,

      id: io.u32(src?.id),

      tintA: io.bounded(src?.tintA ?? src?.a, 0, 3, `items[${i}].offset_28`),
      tintB: io.bounded(src?.tintB ?? src?.b, 0, 3, `items[${i}].offset_32`),
      tintC: io.bounded(src?.tintC ?? src?.c, 0, 3, `items[${i}].offset_3c`),
      name: io.string(src?.name, 64)
    }
  })
  return {
    items,

    tintScalar0: io.qf(v.tintScalar0 ?? v.scalar0, -3, 3, 0, 8),
    tintScalar1: io.qf(v.tintScalar1 ?? v.scalar1, -5, 3, 0, 8),

    hairTintType: io.bounded(
      v.hairTintType ?? v.type0,
      0,
      15,
      'type0/offset_65'
    ),
    outfitType: io.bounded(v.outfitType ?? v.type1, 0, 14, 'type1/offset_64'),
    id: io.u32(v.id),
    value: io.u16(v.value)
  }
}

function socialState (io, v = {}) {
  const o = { flags: boolArray(io, v.flags, 2) }

  o.playerIds = [
    io.dynU8(v.playerIds?.[0]),
    io.dynU8(v.playerIds?.[1]),
    io.dynU8(v.playerIds?.[2])
  ]
  o.flags2 = boolArray(io, v.flags2, 2)

  o.type = io.bounded(v.type, 1, 2)
  o.mode = io.bounded(v.mode, 0, 3)
  o.scalar = io.qf(v.scalar, 0, 2, 0, 9)
  o.byte0 = io.u8(v.byte0)
  o.byte1 = io.bounded(v.byte1, 0, 2)

  o.signed = io.sbounded(v.friendshipLevel ?? v.signed, -4, 4)
  o.final = io.bool(v.final)
  o.offset_5b8b = io.u8(v.offset_5b8b)
  return o
}

function worldQuestState (io, v = {}) {
  const version = io.u16(v.version)
  const id0 = io.u32(v.id0)
  const id1 = io.u32(v.id1)
  const enabled = io.bool(v.enabled)
  const count = io.bounded(v.count, 0, 0x100)
  return {
    version,
    id0,
    id1,
    enabled,
    count,
    flags: Array.from({ length: 0x100 }, (_, i) =>
      io.bool(i < count ? v.flags?.[i] : false)
    )
  }
}

function tailState (io, v = {}, position = [0, 0, 0]) {
  const masks = Array.from({ length: 16 }, (_, i) =>
    boolArray(io, v.masks?.[i], 3)
  )
  return {
    masks,

    maskId: io.u32(v.maskId),
    table: slotTable(io, v.table, position),
    flag: io.bool(v.flag),

    type: io.bounded(v.type, 0, 25),
    byte: io.u8(v.byte),
    raw0: io.f32(v.raw0),
    flag2: io.bool(v.flag2),
    vector: io.vec(v.vector),
    id: io.u32(v.id),
    raw1: io.f32(v.raw1)
  }
}

function slotTable (io, v = {}, position = [0, 0, 0]) {
  const countA = io.bounded(v.countA, 0, 3)
  const header = {
    countA,
    h0: io.bounded(v.h0, 0, 0xa1),
    h1: io.bounded(v.h1, 0, 7),
    h2: io.bounded(v.h2, 0, 0xa1),
    h3: io.bounded(v.h3, 0, 0x200),
    h4: io.bounded(v.h4, 0, 0x200),
    h5: io.bounded(v.h5, 0, 0xa1)
  }

  const wireCountA = io.u8(v.wireCountA ?? countA)
  const wireCountB = io.u8(v.wireCountB ?? v.countB)
  const slotsA = Array.from({ length: wireCountA }, () => ({}))
  const slotsB = Array.from({ length: wireCountB }, () => ({}))

  for (let i = 0; i < wireCountA; i += 1) {
    slotsA[i].active = io.bool(v.slotsA?.[i]?.active)
    if (slotsA[i].active) slotsA[i].kind = io.bool(v.slotsA?.[i]?.kind)
  }
  for (let i = 0; i < wireCountB; i += 1)
    slotsB[i].active = io.bool(v.slotsB?.[i]?.active)

  for (let i = 0; i < wireCountA; i += 1) {
    if (!slotsA[i].active || !slotsA[i].kind) continue
    slotsA[i].nearFlag0 = io.bool(v.slotsA?.[i]?.nearFlag0)
    slotsA[i].nearFlag1 = io.bool(v.slotsA?.[i]?.nearFlag1)

    const relative = clampVectorLength(
      sub3(v.slotsA?.[i]?.position, position),
      4
    )
    slotsA[i].position = add3(position, io.qv(relative, -4, 4, 0, 6))
  }

  for (let i = 0; i < wireCountA; i += 1) {
    if (!slotsA[i].active) continue
    slotsA[i].value0 = io.bounded(v.slotsA?.[i]?.value0, 0, 0x7f)
    slotsA[i].value1 = io.bounded(v.slotsA?.[i]?.value1, 0, 0x7f)
  }
  return {
    ...header,
    wireCountA,
    wireCountB,
    countB: wireCountB,
    slotsA,
    slotsB
  }
}

function boolArray (io, values = [], count) {
  return Array.from({ length: count }, (_, i) => io.bool(values?.[i]))
}
function sub3 (value = [0, 0, 0], base = [0, 0, 0]) {
  return [0, 1, 2].map(i => (value?.[i] ?? base?.[i] ?? 0) - (base?.[i] ?? 0))
}
function add3 (base = [0, 0, 0], delta = [0, 0, 0]) {
  return [0, 1, 2].map(i => (base?.[i] ?? 0) + (delta?.[i] ?? 0))
}
function clampVectorLength (value, maxLength) {
  const length = Math.hypot(value[0], value[1], value[2])
  if (!Number.isFinite(length) || length === 0 || length <= maxLength)
    return value
  const scale = maxLength / length
  return value.map(componentValue => componentValue * scale)
}
function assertStateSize (buffer, maxBytes) {
  if (buffer.length > maxBytes)
    throw new ProtocolError('PlayerState exceeds latest serializer limit', {
      stateBytes: buffer.length,
      max: maxBytes
    })
}
