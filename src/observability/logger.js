import pino from 'pino';
import { finished } from 'node:stream/promises';

export function createLogging(config) {
  const transport = config.pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' }
      })
    : undefined;
  const logger = pino({ level: config.level }, transport);
  let closing;

  return {
    logger,
    close() {
      if (closing) return closing;
      closing = (async () => {
        await new Promise((resolve, reject) => {
          logger.flush(error => error ? reject(error) : resolve());
        });
        if (transport && !transport.destroyed) {
          const ended = finished(transport, { readable: false, cleanup: true });
          transport.end();
          await ended;
        }
      })();
      return closing;
    }
  };
}
