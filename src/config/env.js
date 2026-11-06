const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const problems = [];

function str(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') problems.push(`${name} is required`);
  return v;
}

function int(name, fallback, min, max) {
  const raw = process.env[name] ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) problems.push(`${name} must be an integer (got "${raw}")`);
  else if (n < min || n > max) problems.push(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  serviceName: process.env.SERVICE_NAME || 'stockguard-api',
  logLevel: process.env.LOG_LEVEL || 'info',
  port: int('PORT', 8001, 1, 65535),
  instanceId:
    process.env.INSTANCE_ID ||
    `${str('SERVICE_NAME', 'stockguard-api').replace('stockguard-', '')}-${process.pid}`,

  db: {
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 5432, 1, 65535),
    user: str('DB_USER', 'postgres'),
    password: process.env.DB_PASSWORD ?? '',
    database: str('DB_NAME', 'stockguard'),
    poolMax: int('DB_POOL_MAX', 20, 1, 100),
  },

  holdTtlMinutes: int('HOLD_TTL_MINUTES', 5, 1, 1440),
  statementTimeoutMs: int('STATEMENT_TIMEOUT_MS', 5000, 100, 60000),

  reaper: {
    batchSize: int('REAPER_BATCH_SIZE', 100, 1, 5000),
    intervalMs: int('REAPER_INTERVAL_MS', 1000, 50, 600000),
  },

  relay: {
    batchSize: int('RELAY_BATCH_SIZE', 20, 1, 1000),
    leaseSeconds: int('RELAY_LEASE_SECONDS', 30, 1, 3600),
    maxAttempts: int('RELAY_MAX_ATTEMPTS', 5, 1, 100),
    baseBackoffMs: int('RELAY_BASE_BACKOFF_MS', 1000, 10, 600000),
    maxBackoffMs: int('RELAY_MAX_BACKOFF_MS', 60000, 100, 3600000),
    requestTimeoutMs: int('RELAY_REQUEST_TIMEOUT_MS', 5000, 100, 60000),
    intervalMs: int('RELAY_INTERVAL_MS', 500, 50, 600000),
    consumerUrl: str('CONSUMER_URL', 'http://127.0.0.1:4001/events'),
  },

  consumer: {
    port: int('CONSUMER_PORT', 4001, 1, 65535),
    poolMax: int('CONSUMER_DB_POOL_MAX', 10, 1, 100),
  },

  adminToken: str('ADMIN_TOKEN', 'dev-admin-token'),
};

if (problems.length) {
  console.error('Invalid configuration:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

Object.freeze(env.db);
Object.freeze(env.reaper);
Object.freeze(env.relay);
Object.freeze(env.consumer);
Object.freeze(env);
module.exports = env;
