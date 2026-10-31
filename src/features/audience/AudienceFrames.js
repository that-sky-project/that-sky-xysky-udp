import { AUDIENCE_MAX_ENTITY_INDEX } from '../../protocol/types/Audience.js'
const FRAME_HEADER_BYTES = 4 + 8 + 12
export function estimateFrameBytes (frame) {
  let bits = frame.entities.length
  let positions = 0
  for (const entity of frame.entities) {
    if (!entity.active) continue
    bits += 1
    if (entity.hasData) bits += 1 + 3 + 4
    bits += 1
    positions += 6
  }
  return FRAME_HEADER_BYTES + Math.ceil(bits / 8) + positions
}
export function hashEntity (index, playerId) {
  const text = `${index}:${playerId ?? ''}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0
  }
  const h3 = Math.imul(h1 ^ h2, 0xc2b2ae35) >>> 0
  const h4 = Math.imul(h2 ^ (h1 >>> 13), 0x27d4eb2f) >>> 0
  return {
    u64: h1 * 2 ** 32 + h3,
    u64Big: (BigInt(h1) << 32n) | BigInt(h3),
    u32: h2,
    appearance: 5 + (h1 % 249),
    a: h2 & 0xff,
    b: h3 & 0xff,
    c: h4 & 0xff,
    f62: 1 + (h1 % 8),
    f68: 0,
    v: h4
  }
}
export function profileF0Of (playerId) {
  if (!playerId) return undefined
  const text = String(playerId)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code, 0x01000193) >>> 0
  }
  return (BigInt(h1) << 32n) | BigInt(h2)
}
export function suggestOrigin (barn) {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity
  let count = 0
  for (const entity of barn.entities.values()) {
    if (!entity.playerId) continue
    const p = entity.position
    if (!p) continue
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[2] < minZ) minZ = p[2]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
    if (p[2] > maxZ) maxZ = p[2]
    count += 1
  }
  if (count === 0) return [0, 0, 0]
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
}
export function buildFrame (
  barn,
  { pageStart, pageEnd, memberIndices, levelTime = 0, origin = [0, 0, 0] }
) {
  const memberSet = new Set(memberIndices ?? [])
  const entities = []
  for (let index = pageStart; index < pageEnd; index += 1) {
    const entity = barn.entities.get(index)
    if (!entity) {
      entities.push({ active: false })
      continue
    }
    const position = barn.latestPosition(index, levelTime)
    if (!position) {
      entities.push({ active: false })
      continue
    }
    entities.push({
      active: true,
      hasData: entity.hasData !== false,
      inThisRoom: memberSet.has(index),
      flag7: entity.flag7 ?? 0,
      type: entity.type ?? 0,
      extraVal: entity.extraVal ?? 0,
      extra: entity.extra ?? undefined,
      position
    })
  }
  return {
    idxStart: pageStart,
    idxEnd: pageEnd - 1,
    levelTime,
    origin,
    entities
  }
}
export function buildFrames (
  barn,
  { memberIndices, levelTime = 0, origin = [0, 0, 0], byteBudget = 630 } = {}
) {
  const visible = new Set()
  for (const [index] of barn.entities) {
    if (barn.latestPosition(index, levelTime)) visible.add(index)
  }
  const coverage = new Set(visible)
  for (const index of memberIndices ?? []) {
    if (barn.entities.has(index)) coverage.add(index)
  }
  const indices = [...coverage].sort((a, b) => a - b)
  if (indices.length === 0) return []
  const frames = []
  let first = 0
  while (first < indices.length) {
    const startIdx = indices[first]
    let visibleCount = 0
    let variableBits = 0
    let best = null
    for (let j = first; j < indices.length; j += 1) {
      const index = indices[j]
      if (visible.has(index)) {
        visibleCount += 1
        const entity = barn.entities.get(index)
        variableBits += 1
        if (entity?.hasData !== false) {
          variableBits += 1 + 7 + 4
          if (((entity?.type ?? 0) & 0xfe) === 0x0e) variableBits += 9
        }
        variableBits += 1
      }
      const slots = index - startIdx + 1
      const estimate =
        FRAME_HEADER_BYTES +
        Math.ceil((slots + variableBits) / 8) +
        visibleCount * 6
      if (j > first && estimate > byteBudget) break
      best = { end: index, j }
    }
    if (!best) break
    frames.push(
      buildFrame(barn, {
        pageStart: startIdx,
        pageEnd: best.end + 1,
        memberIndices,
        levelTime,
        origin
      })
    )
    first = best.j + 1
  }
  return frames
}
const BEHAVIOR_GESTURES = [1, 2, 3, 4, 5, 6, 7, 8]
const QUEUE_WAVE_SPAN = 110
const QUEUE_WAVE_SECONDS = 6
export function behaviorOf (index, playerId, nowSeconds, onStage) {
  if (onStage) return { f62: 3, f68: 2 }
  const seed = hashEntity(index, playerId)
  const slot = Math.floor(nowSeconds / 4) + (seed.u32 % 7)
  const f62 = BEHAVIOR_GESTURES[slot % BEHAVIOR_GESTURES.length]
  const wave =
    Math.floor(index / QUEUE_WAVE_SPAN) +
    Math.floor(nowSeconds / QUEUE_WAVE_SECONDS)
  const warm = (wave + seed.v) % 5 === 0
  return { f62, f68: warm ? 1 : 0 }
}
export function buildProfileChunks (
  barn,
  {
    limit = 25,
    budget,
    rangeStart,
    rangeLength,
    nowSeconds = 0,
    onStagePlayerIds
  } = {}
) {
  const entries = []
  const maxEntries = Number.isInteger(budget) && budget > 0 ? budget : limit
  const windowed = Number.isInteger(rangeStart) && Number.isInteger(rangeLength)
  const span = AUDIENCE_MAX_ENTITY_INDEX + 1
  const picked = new Set()
  const stage = onStagePlayerIds ?? new Set()
  const build = (index, entity) => {
    const seed = hashEntity(index, entity.playerId)
    const behavior = behaviorOf(
      index,
      entity.playerId,
      nowSeconds,
      stage.has(entity.playerId)
    )
    return {
      entityIdx: index,
      profile: {
        f0: entity.profileF0 ?? profileF0Of(entity.playerId) ?? seed.u64Big,
        f12: seed.appearance,
        f17: seed.a,
        f18: seed.b,
        f19: seed.c,
        f23: false,
        f24: false,
        f20: false,
        f21: 0,
        f22: true,
        f14: seed.a % 39,
        f16: seed.b % 8,
        f25: 0,
        name: null,
        f8: 0,
        f58: true,
        f60: 0,
        f62: behavior.f62,
        f64: seed.u32,
        f68: behavior.f68,
        f70: 0
      }
    }
  }
  const eligible = entity =>
    Boolean(entity) &&
    Boolean(entity.playerId) &&
    entity.hasData !== false &&
    Boolean(entity.position)
  for (const index of barn.dirtyEntities) {
    if (picked.size >= maxEntries) break
    const entity = barn.entities.get(index)
    if (!eligible(entity)) continue
    picked.add(index)
    entries.push(build(index, entity))
  }
  for (const [index, entity] of barn.entities) {
    if (entries.length >= maxEntries) break
    if (!eligible(entity)) continue
    if (picked.has(index)) continue
    if (windowed) {
      const offset = (index - rangeStart + span) % span
      if (offset >= rangeLength) continue
    }
    entries.push(build(index, entity))
  }
  for (const entry of entries) barn.dirtyEntities.delete(entry.entityIdx)
  const chunks = []
  for (let i = 0; i < entries.length; i += limit) {
    chunks.push({
      count: Math.min(limit, entries.length - i),
      entries: entries.slice(i, i + limit)
    })
  }
  return chunks
}
