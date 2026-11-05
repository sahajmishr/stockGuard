// Correctness burst: N requests race for limited stock. Asserts on DATABASE state, not vibes.
// Usage: node tests/scripts/race-test.js [skuId] [concurrent] [availableUnits]
const pool = require('../../src/config/db');
const { checkInvariants } = require('../../scripts/check-invariants');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8001';
const SKU_ID = Number(process.argv[2] || 1);
const CONCURRENCY = Number(process.argv[3] || 100);
const START_UNITS = Number(process.argv[4] || 1);

async function reset() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE orders, holds RESTART IDENTITY CASCADE');
    await client.query(
      `INSERT INTO skus (total_units, available_units)
       VALUES ($1, $1)
       ON CONFLICT (id) DO UPDATE SET total_units = $1, available_units = $1`,
      [START_UNITS],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// A reset you don't verify is a reset you don't have.
async function verifyReset() {
  const sku = await pool.query('SELECT available_units FROM skus WHERE id = $1', [SKU_ID]);
  const holds = await pool.query('SELECT count(*)::int AS n FROM holds WHERE sku_id = $1', [SKU_ID]);
  const avail = sku.rows[0]?.available_units;
  if (avail !== START_UNITS || holds.rows[0].n !== 0) {
    throw new Error(
      `reset failed: available_units=${avail} (wanted ${START_UNITS}), holds=${holds.rows[0].n} (wanted 0)`,
    );
  }
}

async function main() {
  await reset();
  await verifyReset();

  const pre = await checkInvariants();
  if (!pre.ok) {
    console.error('invariants already broken BEFORE the run — fix the reset first');
    console.error(pre.failures);
    return 1;
  }

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetch(`${BASE_URL}/skus/${SKU_ID}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': `race-${i}` },
        body: JSON.stringify({ quantity: 1 }),
      })
        .then((r) => ({ status: r.status }))
        .catch((err) => ({ status: 'FETCH_ERROR', error: err.message })),
    ),
  );
  const elapsedMs = Date.now() - started;

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const post = await pool.query(
    `SELECT available_units FROM skus WHERE id = $1`,
    [SKU_ID],
  );
  const active = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(quantity), 0)::int AS units
       FROM holds WHERE sku_id = $1 AND state = 'active'`,
    [SKU_ID],
  );
  const inv = await checkInvariants();

  const finalAvail = post.rows[0].available_units;
  const activeUnits = active.rows[0].units;

  console.log('\n=== race test ===');
  console.log({ concurrency: CONCURRENCY, startUnits: START_UNITS, elapsedMs });
  console.log('statuses:', counts);
  console.log({ finalAvailableUnits: finalAvail, activeHoldRows: active.rows[0].n, activeHoldUnits: activeUnits });
  console.log('expiry backlog (stale active holds):', inv.staleActiveHolds);

  const failures = [];
  if (counts[201] !== START_UNITS) failures.push(`winners=${counts[201]} expected=${START_UNITS}`);
  if (finalAvail !== 0) failures.push(`final available=${finalAvail} expected=0`);
  if (activeUnits !== START_UNITS) failures.push(`active hold units=${activeUnits} expected=${START_UNITS}`);
  const unexpected = Object.entries(counts)
    .filter(([s]) => !['201', '409'].includes(s))
    .map(([s, n]) => `${s}:${n}`);
  if (unexpected.length) failures.push(`unexpected statuses: ${unexpected.join(', ')}`);
  if (!inv.ok) failures.push(...inv.failures);

  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  - ' + f);
    return 1;
  }
  console.log('\nPASSED: exactly one winner per unit, no oversell, invariants hold.\n');
  return 0;
}

main()
  .then((code) => pool.end().then(() => process.exit(code)))
  .catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });