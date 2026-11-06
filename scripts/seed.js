const pool = require('../src/config/db');

async function main() {
  const specs = [
    { total: 100, available: 100 },
    { total: 50, available: 50 },
    { total: 1, available: 1 },
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE TABLE consumer_ledger, processed_events, outbox, idempotency_keys, orders, holds, skus RESTART IDENTITY CASCADE',
    );
    for (const spec of specs) {
      await client.query('INSERT INTO skus (total_units, available_units) VALUES ($1, $2)', [
        spec.total,
        spec.available,
      ]);
    }
    await client.query('COMMIT');
    console.log('seeded 3 skus');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    pool.end().finally(() => process.exit(1));
  });
