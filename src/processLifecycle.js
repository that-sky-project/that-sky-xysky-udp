const SHUTDOWN_TIMEOUT_MS = 10_000;

export function createProcessLifecycle({ logger, closeLogging, process: target = process, timeoutMs = SHUTDOWN_TIMEOUT_MS }) {
  const resources = [];
  let shutdownTask;
  let exitCode = 0;

  const signal = name => {
    if (shutdownTask) {
      target.stderr.write('Second shutdown signal received; exiting immediately.\n');
      target.exit(1);
      return;
    }
    void shutdown(name);
  };
  const fatal = (error, reason = 'fatal error') => {
    exitCode = 1;
    logger.fatal({ err: error }, reason);
    return shutdown(reason, 1);
  };
  const listeners = {
    SIGINT: () => signal('SIGINT'),
    SIGTERM: () => signal('SIGTERM'),
    uncaughtException: error => void fatal(error, 'uncaught exception'),
    unhandledRejection: reason => void fatal(reason, 'unhandled rejection')
  };

  for (const [event, listener] of Object.entries(listeners)) target.on(event, listener);

  function shutdown(reason, code = 0) {
    exitCode = Math.max(exitCode, code);
    if (shutdownTask) return shutdownTask;
    shutdownTask = Promise.resolve().then(async () => {
      const deadline = setTimeout(() => {
        target.stderr.write('Shutdown timed out; exiting immediately.\n');
        target.exit(1);
      }, timeoutMs);
      logger.info({ reason }, 'shutdown requested');
      try {
        for (const { name, stop } of [...resources].reverse()) {
          try {
            await stop();
          } catch (error) {
            exitCode = 1;
            logger.error({ err: error, resource: name }, 'resource shutdown failed');
          }
        }
        logger.info({ exitCode }, 'shutdown complete');
        await closeLogging();
      } catch (error) {
        exitCode = 1;
        target.stderr.write(`Logging shutdown failed: ${error.message}\n`);
      } finally {
        clearTimeout(deadline);
        for (const [event, listener] of Object.entries(listeners)) target.off(event, listener);
        target.exit(exitCode);
      }
    });
    return shutdownTask;
  }

  return {
    get stopping() { return Boolean(shutdownTask); },
    add(name, stop) {
      if (shutdownTask) throw new Error('cannot add resources during shutdown');
      resources.push({ name, stop });
    },
    shutdown,
    fatal
  };
}
