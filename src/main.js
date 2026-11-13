import { loadConfig } from './config/index.js';
import { parseCliArgs } from './config/cli.js';
import { createLogging } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { createMetricsServer } from './observability/metricsServer.js';
import { createProcessLifecycle } from './processLifecycle.js';

export async function main() {
  let cli;
  let config;
  try {
    cli = parseCliArgs();
    if (cli.help || cli.version) return;
    config = loadConfig(cli.configFile, cli.overrides);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let logging;
  try {
    logging = createLogging(config.logging);
  } catch (error) {
    console.error(`Failed to initialize logging: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { logger } = logging;
  const lifecycle = createProcessLifecycle({ logger, closeLogging: logging.close });
  try {
    const metrics = createMetrics();
    lifecycle.add('metrics registry', () => metrics.registry.clear());
    const { createRoomApplication } = await import('./runtime/composition.js');
    if (lifecycle.stopping) return;
    const room = createRoomApplication({
      config,
      logger,
      metrics,
      onFatalError: error => void lifecycle.fatal(error, 'room transport failed')
    });
    lifecycle.add('room', () => room.stop());
    for (const warning of config.debug.warnings) logger.warn(warning);
    logger.info({
      config: config.file,
      enet: `${config.room.host}:${config.room.port}`,
      roomId: room.roomId
    }, 'starting server');
    await room.start();
    if (lifecycle.stopping) return;

    if (config.metrics.enabled) {
      const exporter = createMetricsServer({
        registry: metrics.registry,
        ...config.metrics,
        logger,
        onFatalError: error => void lifecycle.fatal(error, 'metrics server failed')
      });
      lifecycle.add('metrics exporter', () => exporter.stop());
      await exporter.start();
    }
    if (!lifecycle.stopping) {
      logger.info({ enet: `${config.room.host}:${config.room.port}`, roomId: room.roomId }, 'server started');
    }
  } catch (error) {
    await lifecycle.fatal(error, 'startup failed');
  }
}

// The SEA entry owns invocation when bundled; source execution remains unchanged.
if (typeof __XYSKY_EXECUTABLE__ === 'undefined') void main();
