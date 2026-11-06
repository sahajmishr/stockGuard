const env = require('./src/config/env');
const app = require('./src/app');
const pool = require('./src/config/db');
const { logger } = require('./src/config/logger');

const server = app.listen(env.port, () => {
  logger.info('api listening', { port: env.port, instanceId: env.instanceId });
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown initiated', { signal });

  const force = setTimeout(() => {
    logger.error('forced exit after 10s');
    process.exit(1);
  }, 10000);
  force.unref();

  server.close(async () => {
    try {
      await pool.end();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('pool close failed', { error: err.message });
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});
