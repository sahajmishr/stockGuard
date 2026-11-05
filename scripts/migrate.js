const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

const DIR = path.join(__dirname, '..', 'sql', 'migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const done = new Set(rows.map((r) => r.filename));
  const pending = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql') && !done.has(f))
    .sort();

  if (pending.length === 0) {
    console.log('nothing to apply');
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('FAILED', file, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

main()
  .then(() => pool.end())
  .catch(() => pool.end().finally(() => process.exit(1)));