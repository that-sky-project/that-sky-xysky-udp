import { createServer } from 'node:http';

export function createMetricsServer({ registry, host, port, logger, onFatalError }) {
  let server;
  let starting;
  let stopping;

  const handleRequest = async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await registry.metrics();
      response.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
    } catch (error) {
      logger.error({ err: error }, 'metrics collection failed');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  };

  return {
    get address() {
      return server?.address() ?? null;
    },

    start() {
      if (stopping) return Promise.reject(new Error('metrics server has been stopped'));
      if (starting) return starting;
      server = createServer((request, response) => void handleRequest(request, response));
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      starting = new Promise((resolve, reject) => {
        const failed = error => {
          server.off('listening', ready);
          reject(error);
        };
        const ready = () => {
          server.off('error', failed);
          server.on('error', error => {
            logger.error({ err: error }, 'metrics server error');
            onFatalError?.(error);
          });
          logger.info({ address: server.address() }, 'metrics server started');
          resolve();
        };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen({ host, port });
      });
      return starting;
    },

    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (!server) return;
        await starting.catch(() => {});
        if (!server.listening) return;
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
        });
      })();
      return stopping;
    }
  };
}
