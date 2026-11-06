process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'stockguard-consumer';
const env = require('../config/env');
const pool = require('../config/db');
const app = require('./app');
const { child } = require('../config/logger');

const log = child({ component: 'consumer' });

const server = app.listen(env.consumer.port, '0.0.0.0', () => {
  log.info('consumer listening', { port: env.consumer.port, instanceId: env.instanceId });
});

server.on('error', (err) => {
  log.error('consumer server error', { error: err.message });
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('consumer shutdown', { signal });
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', { error: String(err) }));
