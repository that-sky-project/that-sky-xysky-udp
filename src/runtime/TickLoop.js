export class TickLoop {
  #timer = null
  #inFlight = null

  constructor ({ tickRate, onTick, logger }) {
    this.tickRate = tickRate
    this.onTick = onTick
    this.logger = logger
  }

  start () {
    if (this.#timer !== null) return
    const interval = Math.max(1, Math.floor(1000 / this.tickRate))
    this.#timer = setInterval(() => {
      if (this.#inFlight) return
      try {
        const result = this.onTick()
        if (result && typeof result.then === 'function') {
          this.#inFlight = Promise.resolve(result)
            .catch(error => this.logger.error({ err: error }, 'tick failed'))
            .finally(() => { this.#inFlight = null })
        }
      } catch (error) {
        this.logger.error({ err: error }, 'tick failed')
      }
    }, interval)
  }

  async stop () {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    await this.#inFlight
  }
}
