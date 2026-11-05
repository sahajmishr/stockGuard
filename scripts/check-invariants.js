const pool = require('../src/config/db');

// Exported so Day 10's tests can call it in afterEach without spawning a process.
async function checkInvariants() {
  const drift = await pool.query(`
    SELECT s.id AS sku_id, s.total_units, s.available_units,
           COALESCE(h.active_units, 0)    AS active_held,
           COALESCE(h.confirmed_units, 0) AS confirmed_held,
           (s.available_units + COALESCE(h.active_units, 0)
            + COALESCE(h.confirmed_units, 0) - s.total_units) AS drift
    FROM skus s
    LEFT JOIN (
      SELECT sku_id,
             SUM(quantity) FILTER (WHERE state = 'active')    AS active_units,
             SUM(quantity) FILTER (WHERE state = 'confirmed') AS confirmed_units
      FROM holds GROUP BY sku_id
    ) h ON h.sku_id = s.id
    ORDER BY s.id`);

  const negative = await pool.query(
    'SELECT id, available_units FROM skus WHERE available_units < 0',
  );

  const stale = await pool.query(
    "SELECT count(*)::int AS n FROM holds WHERE state = 'active' AND expires_at <= now()",
  );

  const failures = [];

  for (const r of drift.rows) {
    if (Number(r.drift) !== 0) {
      failures.push(
        `drift on sku ${r.sku_id}: available=${r.available_units} active=${r.active_held} ` +
          `confirmed=${r.confirmed_held} total=${r.total_units} => drift=${r.drift}`,
      );
    }
  }
  if (negative.rowCount > 0) {
    failures.push(`negative available_units on: ${negative.rows.map((r) => r.id).join(', ')}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    driftRows: drift.rows,
    staleActiveHolds: stale.rows[0].n,
  };
}

async function main() {
  const result = await checkInvariants();

  console.log('\n--- per-SKU accounting ---');
  console.table(
    result.driftRows.map((r) => ({
      sku: r.sku_id,
      total: r.total_units,
      available: r.available_units,
      activeHeld: r.active_held,
      confirmedHeld: r.confirmed_held,
      drift: r.drift,
    })),
  );
  console.log(`stale active holds (expiry backlog, not a failure): ${result.staleActiveHolds}`);

  if (!result.ok) {
    console.error('\nINVARIANT VIOLATED:');
    for (const f of result.failures) console.error('  - ' + f);
    return 1;
  }
  console.log('\nINVARIANTS OK\n');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch((err) => {
      console.error(err);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { checkInvariants };