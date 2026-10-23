import { loadConfig } from './config/index.js';
import { createLogger } from './observability/logger.js';
import { RoomServer } from './runtime/RoomServer.js';
import { createMetrics } from './observability/metrics.js';

const config = loadConfig();
const logger = createLogger(config.logging);
const metrics = createMetrics();

const room = new RoomServer({ config: config.room, logger, metrics });

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, 'shutdown requested');

  await Promise.allSettled([
    room.stop()
  ]);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('uncaughtException', error => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException').finally(() => process.exit(1));
});

process.on('unhandledRejection', reason => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection').finally(() => process.exit(1));
});

async function bootstrap() {
  logger.info({
    enet: `${config.room.host}:${config.room.port}`,
    roomId: config.room.id
  }, 'starting server');

  try {
    await room.start();
    logger.info({
      enet: `${config.room.host}:${config.room.port}`,
      roomId: config.room.id
    }, 'server started');
  } catch (error) {
    logger.fatal({ err: error }, 'startup failed');
    await shutdown('startupFailed');
    process.exit(1);
  }
}

await bootstrap();
