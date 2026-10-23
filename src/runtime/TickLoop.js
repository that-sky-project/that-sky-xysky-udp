export class TickLoop {
  constructor({ tickRate, onTick, logger }) {
    this.tickRate = tickRate;
    this.onTick = onTick;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    const interval = Math.max(1, Math.floor(1000 / this.tickRate));
    this.running = true;
    this.timer = setInterval(() => {
      try {
        this.onTick();
      } catch (error) {
        this.logger.error({ err: error }, 'tick failed');
      }
    }, interval);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
