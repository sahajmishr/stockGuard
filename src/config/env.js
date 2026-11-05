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
  port: int('PORT', 8001, 1, 65535),

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
};

if (problems.length) {
  console.error('Invalid configuration:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

Object.freeze(env.db);
Object.freeze(env);
module.exports = env;