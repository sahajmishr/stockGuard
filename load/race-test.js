const pool = require('../src/config/db');
const { checkInvariants } = require('../scripts/check-invariants');

const config = {
  baseUrl: process.env.RACE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8001}`,
  buyers: Number(process.env.RACE_BUYERS ?? 200),
  skuId: Number(process.env.RACE_SKU ?? 1),
  totalUnits: Number(process.env.RACE_UNITS ?? 1),
  batchPrint: 25,
};

async function setupSku() {
  const { rows } = await pool.query(
    `UPDATE skus SET total_units = $2, available_units = $2 WHERE id = $1 RETURNING id, total_units`,
    [config.skuId, config.totalUnits],
  );
  if (rows.length === 0) throw new Error(`sku ${config.skuId} does not exist, run npm run seed first`);
  await pool.query("DELETE FROM holds WHERE sku_id = $1", [config.skuId]);
  return rows[0];
}

async function buyer(index) {
  const startedAt = process.hrtime.bigint();
  try {
    const res = await fetch(`${config.baseUrl}/skus/${config.skuId}/holds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': `buyer-${index}`,
        'x-idempotency-key': `race-${Date.now()}-${index}`,
      },
      body: JSON.stringify({ quantity: 1 }),
    });
    const body = await res.json().catch(() => ({}));
    return {
      index,
      status: res.status,
      error: body.error ?? null,
      ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
    };
  } catch (err) {
    return { index, status: 0, error: `network: ${err.message}`, ms: 0 };
  }
}

function summarise(results) {
  const byStatus = {};
  const byError = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.error) byError[r.error] = (byError[r.error] ?? 0) + 1;
  }
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
  return {
    requests: results.length,
    byStatus,
    byError,
    p50Ms: Number(pct(50).toFixed(1)),
    p95Ms: Number(pct(95).toFixed(1)),
    p99Ms: Number(pct(99).toFixed(1)),
    maxMs: Number((latencies[latencies.length - 1] ?? 0).toFixed(1)),
  };
}

async function main() {
  const sku = await setupSku();
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'race starting',
      baseUrl: config.baseUrl,
      buyers: config.buyers,
      skuId: sku.id,
      units: sku.total_units,
    }),
  );

  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: config.buyers }, (unused, i) => buyer(i)),
  );
  const elapsedMs = Date.now() - startedAt;

  const summary = summarise(results);
  const winners = results.filter((r) => r.status === 201).length;
  const serverErrors = results.filter((r) => r.status >= 500).length;
  const unsold = results.filter((r) => r.status === 409 && r.error === 'INSUFFICIENT_STOCK').length;

  const { rows: stock } = await pool.query(
    `SELECT total_units, available_units FROM skus WHERE id = $1`,
    [config.skuId],
  );
  const { rows: held } = await pool.query(
    `SELECT coalesce(sum(quantity), 0)::int AS held FROM holds WHERE sku_id = $1 AND state = 'active'`,
    [config.skuId],
  );
  const { rows: orderRows } = await pool.query('SELECT count(*)::int AS n FROM orders');

  const invariants = await checkInvariants();

  const verdict = {
    winners,
    expectedWinners: Math.min(config.totalUnits, config.buyers),
    oversold: winners > config.totalUnits,
    unsoldLosers: unsold,
    serverErrors,
    available: stock[0].available_units,
    activeHeld: held[0].held,
    totalUnits: stock[0].total_units,
    orders: orderRows[0].n,
    invariantsOk: invariants.ok,
    accountingBalances:
      Number(stock[0].available_units) + Number(held[0].held) === Number(stock[0].total_units),
    elapsedMs,
    throughputPerSecond: Number(((config.buyers / elapsedMs) * 1000).toFixed(1)),
    latency: {
      p50Ms: summary.p50Ms,
      p95Ms: summary.p95Ms,
      p99Ms: summary.p99Ms,
      maxMs: summary.maxMs,
    },
    byStatus: summary.byStatus,
    byError: summary.byError,
  };

  console.log(JSON.stringify({ level: 'info', msg: 'race finished', ...verdict }, null, 2));

  const failed =
    verdict.oversold ||
    verdict.serverErrors > 0 ||
    !verdict.invariantsOk ||
    !verdict.accountingBalances ||
    winners !== verdict.expectedWinners;

  if (failed) {
    console.error(JSON.stringify({ level: 'error', msg: 'race FAILED' }));
    await pool.end();
    process.exit(1);
  }

  console.log(JSON.stringify({ level: 'info', msg: 'race PASSED' }));
  await pool.end();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'race crashed', error: err.message }));
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
