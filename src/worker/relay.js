process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'stockguard-relay';
const env = require('../config/env');
const pool = require('../config/db');
const relayService = require('../services/relayService');
const { child } = require('../config/logger');

const log = child({ component: 'relay-runner', pid: process.pid });

let running = false;
let stopping = false;
let timer = null;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    const result = await relayService.publishBatch();
    if (result.claimed > 0) log.info('batch processed', result);
  } catch (err) {
    log.error('publish threw', { error: err.message });
  } finally {
    running = false;
  }
}

async function start() {
  log.info('relay started', {
    intervalMs: env.relay.intervalMs,
    batchSize: env.relay.batchSize,
    consumerUrl: env.relay.consumerUrl,
  });
  await tick();
  timer = setInterval(tick, env.relay.intervalMs);
  timer.unref?.();
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('relay stopping', { signal });
  if (timer) clearInterval(timer);
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await pool.end();
  log.info('relay stopped');
  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { reason: String(reason) }));

start().catch((err) => {
  log.error('relay failed to start', { error: err.message });
  process.exit(1);
});

module.exports = { tick, start, stop };
