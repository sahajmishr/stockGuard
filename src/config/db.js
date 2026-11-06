const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  max: env.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: env.statementTimeoutMs,
  query_timeout: env.statementTimeoutMs,
  application_name: 'stockGuard-api',
});

pool.on('error', (err) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'idle pg client error', error: err.message }),
  );
});

module.exports = pool;
