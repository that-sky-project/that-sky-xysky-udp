import { performance as monotonicClock } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { isAudienceLevel } from './AudienceLevels.js'
import { ErrorCode } from '../../qwd/errorCodes.js'

const MAX_RETIRED_EPOCHS = 16
const defaultMonotonic = () => monotonicClock.now()

export function validAudienceChatGlobalState (data) {
  const safeTime = value => Number.isSafeInteger(value) && value >= 0
  if (!data || typeof data.authorityEpoch !== 'string' || !data.authorityEpoch ||
    data.authorityEpoch.length > 256 || data.authorityEpoch.trim() !== data.authorityEpoch ||
    !Number.isSafeInteger(data.revision) || data.revision < 0 ||
    !Number.isSafeInteger(data.levelId) || !isAudienceLevel(data.levelId) ||
    typeof data.enabled !== 'boolean' ||
    !safeTime(data.remainingSeconds) || !safeTime(data.serverNowMs) ||
    !safeTime(data.expiresAtMs)) return false

  return data.enabled
    ? data.remainingSeconds > 0 && data.expiresAtMs > data.serverNowMs
    : data.remainingSeconds === 0 && data.expiresAtMs <= data.serverNowMs
}

// QWD owns the authoritative state and revisions. This service projects that
// state onto packet 26 and keeps only a monotonic fail-safe expiry locally.
export class AudienceChatGlobalService {
  constructor ({
    audience,
    clock = Date.now,
    monotonic = defaultMonotonic,
    logger = console
  } = {}) {
    if (!audience) throw new TypeError('audience is required')
    Object.assign(this, { audience, clock, monotonic, logger })
    this.states = new Map()
    this.authorityEpoch = null
    this.retiredEpochs = new Set()
    this.operationChain = Promise.resolve()
    this.stopped = false
    audience.chatGlobalService = this
  }

  enqueue (operation) {
    const result = this.operationChain.then(operation)
    this.operationChain = result.catch(() => {})
    return result
  }

  ack (data, applied, reason, code = ErrorCode.CONFLICT) {
    return {
      code: applied ? ErrorCode.OK : code,
      data: {
        authorityEpoch: data?.authorityEpoch,
        revision: data?.revision,
        levelId: data?.levelId,
        enabled: data?.enabled,
        remainingSeconds: data?.remainingSeconds,
        applied,
        ...(reason ? { reason } : {})
      }
    }
  }

  identity (data) {
    const { serverNowMs: ignored, ...identity } = data
    return identity
  }

  current (levelId) {
    const entry = this.states.get(levelId)
    if (!entry) return null
    if (!entry.data.enabled) return null
    const remainingSeconds = this.#remainingSeconds(entry)
    if (remainingSeconds <= 0) return null
    return { ...structuredClone(entry.data), remainingSeconds }
  }

  async apply (data) {
    if (!validAudienceChatGlobalState(data)) {
      return this.ack(data, false, 'invalid', ErrorCode.BAD_REQUEST)
    }
    if (this.stopped) return this.ack(data, false, 'stopped')

    if (this.retiredEpochs.has(data.authorityEpoch)) {
      return this.ack(data, false, 'stale_epoch')
    }

    if (this.authorityEpoch && data.authorityEpoch !== this.authorityEpoch) {
      // Clear every projection from the old authority before exposing any state
      // from the new one. If a send fails, keep the old epoch so a retry repeats
      // all closes rather than acknowledging a partially ordered transition.
      const levels = this.#activeLevels(this.states)
      let cursor = 0
      try {
        for (; cursor < levels.length; cursor++) {
          await this.#sendClose(levels[cursor])
        }
      } catch (error) {
        // Some old levels were already closed before this new-epoch attempt
        // failed. Leave them retryable so the next attempt re-closes every old
        // level and no partially-cleared transition can be ACKed.
        for (let index = 0; index < cursor; index++) levels[index].entry.expiryClosed = false
        throw error
      }
      this.retiredEpochs.add(this.authorityEpoch)
      while (this.retiredEpochs.size > MAX_RETIRED_EPOCHS) {
        this.retiredEpochs.delete(this.retiredEpochs.values().next().value)
      }
      this.states.clear()
      this.authorityEpoch = data.authorityEpoch
    } else if (!this.authorityEpoch) {
      this.authorityEpoch = data.authorityEpoch
    }

    const previous = this.states.get(data.levelId)
    if (previous && data.revision < previous.data.revision) {
      return this.ack(data, false, 'stale')
    }
    if (previous && data.revision === previous.data.revision) {
      if (!isDeepStrictEqual(this.identity(previous.data), this.identity(data))) {
        return this.ack(data, false, 'conflict')
      }
      // Retrying a command deliberately refreshes every recipient. There is no
      // per-player commit set: a partial ENet failure must resend the full level.
      const projection = this.#projection(previous)
      await this.audience.sendChatGlobalState(data.levelId, projection)
      if (!projection.enabled && previous.data.enabled) previous.expiryClosed = true
      return this.ack(data, true)
    }

    const entry = this.#entry(data)
    // Store before output so an all-recipient retry is possible after a partial
    // send. The first packet uses QWD's integer verbatim; later retries derive a
    // non-extending value from the fixed local deadline.
    this.states.set(data.levelId, entry)
    await this.audience.sendChatGlobalState(data.levelId, {
      enabled: data.enabled,
      remainingSeconds: data.enabled ? data.remainingSeconds : 0
    })
    return this.ack(data, true)
  }

  async sendToPlayerOnSeat (playerId, levelId) {
    const entry = this.states.get(levelId)
    if (!entry || !entry.data.enabled) return 0
    const projection = this.#projection(entry)
    if (!projection.enabled) return 0
    return this.audience.sendChatGlobalState(levelId, projection, { playerId })
  }

  async tick () {
    const failures = []
    for (const [levelId, entry] of this.states) {
      if (!entry.data.enabled || entry.expiryClosed || this.#remainingMs(entry) > 0) continue
      try {
        await this.audience.sendChatGlobalState(levelId, {
          enabled: false,
          remainingSeconds: 0
        })
        entry.expiryClosed = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw failures[0]
  }

  async disconnect () {
    const states = this.states
    try {
      await this.#closeActiveLevels(states)
    } finally {
      this.states = new Map()
      this.authorityEpoch = null
      this.retiredEpochs.clear()
    }
  }

  disconnected () {
    return this.enqueue(() => this.disconnect())
  }

  stop () {
    return this.enqueue(async () => {
      if (this.stopped) return
      this.stopped = true
      await this.disconnect()
    })
  }

  #entry (data) {
    const state = structuredClone(data)
    if (!state.enabled) return { data: state, deadline: -Infinity, wallDeadline: -Infinity, expiryClosed: false }
    const remainingMs = Math.min(
      state.expiresAtMs - state.serverNowMs,
      state.remainingSeconds * 1000
    )
    return {
      data: state,
      deadline: this.monotonic() + remainingMs,
      wallDeadline: this.clock() + remainingMs,
      expiryClosed: false
    }
  }

  #remainingMs (entry) {
    return Math.min(
      entry.deadline - this.monotonic(),
      entry.wallDeadline - this.clock()
    )
  }

  #remainingSeconds (entry) {
    return Math.max(0, Math.ceil(this.#remainingMs(entry) / 1000))
  }

  #projection (entry) {
    if (!entry.data.enabled) return { enabled: false, remainingSeconds: 0 }
    const remainingSeconds = this.#remainingSeconds(entry)
    return remainingSeconds > 0
      ? { enabled: true, remainingSeconds }
      : { enabled: false, remainingSeconds: 0 }
  }

  async #sendClose ({ levelId, entry }) {
    await this.audience.sendChatGlobalState(levelId, {
      enabled: false,
      remainingSeconds: 0
    })
    entry.expiryClosed = true
  }

  #activeLevels (states) {
    return [...states]
      .filter(([, entry]) => entry.data.enabled && !entry.expiryClosed)
      .map(([levelId, entry]) => ({ levelId, entry }))
  }

  async #closeActiveLevels (states) {
    const failures = []
    for (const level of this.#activeLevels(states)) {
      try {
        await this.#sendClose(level)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw failures[0]
  }
}
