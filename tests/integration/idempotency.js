/**
 * StockGuard — Day 9/10 integration tests (idempotency)
 *
 * Save as: tests/integration/idempotency.test.js
 * Run:     node --test tests/integration/
 *
 * Boots the REAL app in-process on a random port and talks real HTTP to it.
 * Real PostgreSQL. No mocks — mock tests cannot prove locking behaviour.
 *
 * Every test resets the database first, and every test checks the accounting
 * invariant at the end. If a test is green but the invariant is broken, the test
 * is wrong.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../src/config/db');
const app = require('../../src/app');
const { checkInvariants } = require('../../scripts/check-invariants');

let server;
let baseUrl;
let SKU_A;
let SKU_B;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function reset({ skuA = 10, skuB = 10 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE TABLE idempotency_keys, orders, holds, skus RESTART IDENTITY CASCADE',
    );
    const { rows } = await client.query(
      `INSERT INTO skus (total_units, available_units) VALUES ($1, $1), ($2, $2) RETURNING id`,
      [skuA, skuB],
    );
    await client.query('COMMIT');
    SKU_A = rows[0].id;
    SKU_B = rows[1].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function verifyReset(expectedA, expectedB) {
  const { rows } = await pool.query('SELECT id, available_units FROM skus ORDER BY id');
  assert.equal(rows.length, 2, 'reset must leave exactly 2 SKUs');
  assert.equal(rows[0].available_units, expectedA, 'reset: sku A availability');
  assert.equal(rows[1].available_units, expectedB, 'reset: sku B availability');
}

function postHold({ skuId, quantity = 1, key, user = 'u1' }) {
  const headers = { 'content-type': 'application/json', 'x-user-id': user };
  if (key !== undefined) headers['x-idempotency-key'] = key;
  return fetch(`${baseUrl}/skus/${skuId}/holds`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ quantity }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function dbState(skuId) {
  const sku = await pool.query('SELECT available_units FROM skus WHERE id = $1', [skuId]);
  const holds = await pool.query(
    `SELECT count(*)::int AS rows, COALESCE(SUM(quantity), 0)::int AS units
       FROM holds WHERE sku_id = $1 AND state = 'active'`,
    [skuId],
  );
  const idem = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys');
  const allHolds = await pool.query('SELECT count(*)::int AS n FROM holds');
  return {
    available: sku.rows[0].available_units,
    activeHoldRows: holds.rows[0].rows,
    activeHoldUnits: holds.rows[0].units,
    allHoldRows: allHolds.rows[0].n,
    idemRows: idem.rows[0].n,
  };
}

async function assertInvariant() {
  const result = await checkInvariants();
  assert.ok(result.ok, `accounting invariant violated:\n  ${result.failures.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ---------------------------------------------------------------------------
// T1 / T2 — the happy path
// ---------------------------------------------------------------------------

test('T1: 201 returns a real body, not {}', async () => {
  await reset();
  await verifyReset(10, 10);

  const res = await postHold({ skuId: SKU_A, quantity: 2, key: 'k-t1' });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body, 'body must not be null');
  assert.notEqual(
    JSON.stringify(res.body),
    '{}',
    'BUG 1: body is empty — the route is reading properties off the wrong object',
  );

  assert.ok(res.body.hold_id, 'body.hold_id missing');
  assert.equal(res.body.sku_id, SKU_A);
  assert.equal(res.body.quantity, 2);
  assert.equal(res.body.state, 'active');
  assert.ok(res.body.expires_at, 'body.expires_at missing');
  assert.ok(res.body.created_at, 'body.created_at missing');

  // expires_at must be ~ HOLD_TTL_MINUTES in the future (DB clock, not the app clock)
  const minutes = (new Date(res.body.expires_at) - Date.now()) / 60000;
  assert.ok(minutes > 0 && minutes <= 1440, `implausible TTL: ${minutes} minutes`);

  await assertInvariant();
});

test('T2: a successful hold changes exactly three things', async () => {
  await reset();
  const res = await postHold({ skuId: SKU_A, quantity: 3, key: 'k-t2' });
  assert.equal(res.status, 201);

  const s = await dbState(SKU_A);
  assert.equal(s.available, 7, 'available_units must drop by exactly 3');
  assert.equal(s.activeHoldRows, 1, 'exactly one hold row');
  assert.equal(s.activeHoldUnits, 3, 'held units must equal the quantity');
  assert.equal(s.idemRows, 1, 'exactly one idempotency row');
  assert.equal(s.allHoldRows, 1);

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// T3 / T4 — replay and key reuse
// ---------------------------------------------------------------------------

test('T3: same key + same payload returns the identical saved response', async () => {
  await reset();
  const first = await postHold({ skuId: SKU_A, quantity: 2, key: 'k-t3' });
  assert.equal(first.status, 201, 'first request should succeed');

  const second = await postHold({ skuId: SKU_A, quantity: 2, key: 'k-t3' });

  assert.equal(
    second.status,
    first.status,
    `BUG 2: retry returned ${second.status} instead of replaying ${first.status}. ` +
      `Body: ${JSON.stringify(second.body)}`,
  );
  assert.deepEqual(
    second.body,
    first.body,
    'BUG 2: replayed body differs from the original. A replay must be byte-identical.',
  );

  const s = await dbState(SKU_A);
  assert.equal(s.available, 8, 'retry must NOT decrement again');
  assert.equal(s.allHoldRows, 1, 'retry must NOT create a second hold');
  assert.equal(s.idemRows, 1, 'retry must NOT add an idempotency row');

  await assertInvariant();
});

test('T4: same key + different payload -> 409, original untouched', async () => {
  await reset();
  const first = await postHold({ skuId: SKU_A, quantity: 1, key: 'k-t4' });
  assert.equal(first.status, 201);

  const second = await postHold({ skuId: SKU_A, quantity: 5, key: 'k-t4' });

  assert.equal(second.status, 409, `expected 409, got ${second.status}`);
  assert.equal(
    second.body?.error,
    'IDEMPOTENCY_KEY_REUSE_VIOLATION',
    `expected the reuse code, got ${JSON.stringify(second.body)}`,
  );
  assert.notDeepEqual(second.body, first.body, 'must not replay the original response');

  const s = await dbState(SKU_A);
  assert.equal(s.available, 9, 'a rejected reuse must not touch stock');
  assert.equal(s.allHoldRows, 1, 'a rejected reuse must not create a hold');

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// T5 / T6 — terminal 409 vs validation error
// ---------------------------------------------------------------------------

test('T5: insufficient stock is stored and replayed identically', async () => {
  await reset({ skuA: 1, skuB: 1 });
  await verifyReset(1, 1);

  const first = await postHold({ skuId: SKU_A, quantity: 5, key: 'k-t5' });
  assert.equal(first.status, 409, `expected 409, got ${first.status}`);
  assert.equal(first.body?.error, 'INSUFFICIENT_STOCK');

  let s = await dbState(SKU_A);
  assert.equal(s.available, 1, 'a rejected hold must not change stock');
  assert.equal(s.allHoldRows, 0, 'a rejected hold must not create a hold');
  assert.equal(s.idemRows, 1, 'the terminal 409 must be SAVED under the key');

  const second = await postHold({ skuId: SKU_A, quantity: 5, key: 'k-t5' });
  assert.equal(second.status, 409, 'retry must replay 409');
  assert.deepEqual(
    second.body,
    first.body,
    'BUG 6: the replayed 409 body differs from the live one. Same outcome = same bytes.',
  );

  s = await dbState(SKU_A);
  assert.equal(s.idemRows, 1, 'replay must not add a key row');
  assert.equal(s.available, 1);

  await assertInvariant();
});

test('T6: a validation error does NOT consume the key', async () => {
  await reset();

  const bad = await postHold({ skuId: SKU_A, quantity: 0, key: 'k-t6' });
  assert.equal(bad.status, 400, `expected 400, got ${bad.status}`);

  const s1 = await dbState(SKU_A);
  assert.equal(s1.idemRows, 0, 'a pre-transaction validation error must not write a key row');

  // same key, now valid — must succeed, not report a reuse violation
  const good = await postHold({ skuId: SKU_A, quantity: 1, key: 'k-t6' });
  assert.equal(
    good.status,
    201,
    `expected 201 after fixing the body, got ${good.status}: ${JSON.stringify(good.body)}`,
  );

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// T7 — the silent one
// ---------------------------------------------------------------------------

test('T7: the same key on a DIFFERENT sku must not replay the first sku hold', async () => {
  await reset();

  const onA = await postHold({ skuId: SKU_A, quantity: 1, key: 'k-t7' });
  assert.equal(onA.status, 201);

  const onB = await postHold({ skuId: SKU_B, quantity: 1, key: 'k-t7' });

  const s = await dbState(SKU_B);

  // Either outcome is spec-legal; silently replaying SKU A's hold is not.
  const isReuseRejection = onB.status === 409 && onB.body?.error === 'IDEMPOTENCY_KEY_REUSE_VIOLATION';
  const isRealReservationForB =
    onB.status === 201 && onB.body?.sku_id === SKU_B && s.activeHoldRows === 1;

  assert.ok(
    isReuseRejection || isRealReservationForB,
    `BUG 5: the same key on SKU ${SKU_B} returned ${onB.status} ` +
      `with sku_id=${onB.body?.sku_id} — it replayed SKU ${SKU_A}'s hold. ` +
      'The hash must cover sku_id.',
  );

  if (isReuseRejection) {
    assert.equal(s.activeHoldRows, 0, 'a rejected reuse must leave SKU B untouched');
    assert.equal(s.available, 10, 'a rejected reuse must not touch SKU B stock');
  }

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// T8 — header contract
// ---------------------------------------------------------------------------

test('T8: missing idempotency key -> 400 JSON', async () => {
  await reset();
  const res = await postHold({ skuId: SKU_A, quantity: 1 }); // no key

  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  assert.ok(res.body, 'must be JSON, not HTML');
  assert.equal(typeof res.body.error, 'string', 'must use the standard {error, message} shape');

  const s = await dbState(SKU_A);
  assert.equal(s.allHoldRows, 0);
  assert.equal(s.available, 10);

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// T9 / T10 — concurrency
// ---------------------------------------------------------------------------

test('T9: 10 concurrent requests with the SAME key -> one hold, one decrement', async () => {
  await reset();

  const results = await Promise.all(
    Array.from({ length: 10 }, () => postHold({ skuId: SKU_A, quantity: 1, key: 'k-t9' })),
  );

  const statuses = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  const successes = results.filter((r) => r.status === 201);

  assert.ok(successes.length >= 1, `no request succeeded: ${JSON.stringify(statuses)}`);
  // every non-2xx must be 409 (in-progress or replay-relevant), never 500
  for (const r of results) {
    assert.ok(
      r.status === 201 || r.status === 409,
      `unexpected status ${r.status}: ${JSON.stringify(r.body)}`,
    );
    if (r.status === 409) {
      assert.notEqual(
        r.body?.error,
        'DUPLICATE',
        'BUG 2: got a raw unique-violation instead of a replay. checkIdempotencyRecord is returning a Result, not a row.',
      );
    }
  }

  // if more than one succeeded, they must all be the SAME saved response
  if (successes.length > 1) {
    for (const s of successes) assert.deepEqual(s.body, successes[0].body, 'replays must be identical');
  }

  const s = await dbState(SKU_A);
  assert.equal(s.allHoldRows, 1, `10 concurrent identical requests created ${s.allHoldRows} holds`);
  assert.equal(s.available, 9, 'stock must be decremented exactly once');
  assert.equal(s.idemRows, 1, 'exactly one idempotency row');

  await assertInvariant();
});

test('T10: 100 distinct keys race for 1 unit -> exactly one winner', async () => {
  await reset({ skuA: 1, skuB: 10 });
  await verifyReset(1, 10);

  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      postHold({ skuId: SKU_A, quantity: 1, key: `race-${i}`, user: `user-${i}` }),
    ),
  );

  const statuses = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});

  assert.equal(
    statuses[201] || 0,
    1,
    `expected exactly one 201, got ${statuses[201] || 0}. Full distribution: ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    statuses[409] || 0,
    99,
    `expected 99 rejections, got ${statuses[409] || 0}. Full distribution: ${JSON.stringify(statuses)}`,
  );
  assert.equal(statuses[500] || 0, 0, 'no 500s allowed');
  assert.equal(statuses.undefined || 0, 0, 'no network errors or empty responses allowed');

  const s = await dbState(SKU_A);
  assert.equal(s.available, 0);
  assert.equal(s.allHoldRows, 1);
  assert.equal(
    s.idemRows,
    100,
    'every key must be recorded exactly once: 1 success + 99 terminal rejections',
  );

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// T11 — the invariant, standalone
// ---------------------------------------------------------------------------

test('T11: accounting invariant holds across the whole suite', async () => {
  await assertInvariant();
});
