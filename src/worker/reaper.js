process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'stockguard-reaper';
const env = require('../config/env');
const pool = require('../config/db');
const reaperService = require('../services/reaperService');
const { child } = require('../config/logger');

const log = child({ component: 'reaper-runner', pid: process.pid });

let running = false;
let stopping = false;
let timer = null;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    await reaperService.sweepOnce();
  } catch (err) {
    log.error('sweep threw', { error: err.message });
  } finally {
    running = false;
  }
}

async function start() {
  log.info('reaper started', { intervalMs: env.reaper.intervalMs, batchSize: env.reaper.batchSize });
  await tick();
  timer = setInterval(tick, env.reaper.intervalMs);
  timer.unref?.();
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('reaper stopping', { signal });
  if (timer) clearInterval(timer);
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await pool.end();
  log.info('reaper stopped');
  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { reason: String(reason) }));

start().catch((err) => {
  log.error('reaper failed to start', { error: err.message });
  process.exit(1);
});

module.exports = { tick, start, stop };
