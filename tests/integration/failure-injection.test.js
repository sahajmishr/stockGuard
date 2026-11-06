/**
 * StockGuard — Day 12 tests: failure injection
 *
 * Save as: tests/integration/failure-injection.test.js
 * Run:     node --test --test-concurrency=1 tests/integration/
 *
 * HOW THE FAILURE IS INJECTED
 * ---------------------------
 * Not with an `if (process.env.INJECT_FAIL)` hook in your service — that puts test
 * code in the production path and lets you "prove" things by disabling the thing
 * you're proving. Instead we install a Postgres TRIGGER that raises an exception on
 * INSERT into a chosen table. Your application code has no idea it is being tested.
 *
 * That is the only honest way to test a rollback: the failure arrives from the
 * database, exactly as a real constraint violation or deadlock would.
 *
 * What each test proves is NOT "the error was handled". It is:
 *   "when the transaction failed, the database is indistinguishable from a state
 *    in which the request was never made."
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../src/config/db');
const app = require('../../src/app');
const { checkInvariants } = require('../../scripts/check-invariants');

let server;
let baseUrl;
let SKU_A;

const USER = 'u1';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function reset({ skuA = 10 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE TABLE outbox, idempotency_keys, orders, holds, skus RESTART IDENTITY CASCADE',
    );
    const { rows } = await client.query(
      'INSERT INTO skus (total_units, available_units) VALUES ($1, $1) RETURNING id',
      [skuA],
    );
    await client.query('COMMIT');
    SKU_A = rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Install a BEFORE INSERT trigger that always raises. Table name comes from our own literal. */
async function injectFailureOn(table) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION inject_failure() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected failure: cannot insert into %', TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`DROP TRIGGER IF EXISTS inject_fail ON ${table}`);
  await pool.query(
    `CREATE TRIGGER inject_fail BEFORE INSERT ON ${table}
       FOR EACH ROW EXECUTE FUNCTION inject_failure()`,
  );
}

async function removeFailureOn(table) {
  await pool.query(`DROP TRIGGER IF EXISTS inject_fail ON ${table}`);
}

async function removeAllInjection() {
  for (const t of ['holds', 'orders', 'outbox']) await removeFailureOn(t);
}

async function api(path, { method = 'GET', userId = USER, body, key } = {}) {
  const headers = {};
  if (userId) headers['x-user-id'] = userId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-idempotency-key'] = key;
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const createHoldRequest = ({ quantity = 1, key }) =>
  api(`/skus/${SKU_A}/holds`, { method: 'POST', body: { quantity }, key });

async function createHoldOrThrow(args) {
  const res = await createHoldRequest(args);
  assert.equal(res.status, 201, `setup: create hold returned ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.hold_id;
}

async function snapshot() {
  const sku = await pool.query('SELECT available_units FROM skus WHERE id = $1', [SKU_A]);
  const holds = await pool.query('SELECT count(*)::int AS n FROM holds');
  const orders = await pool.query('SELECT count(*)::int AS n FROM orders');
  const outbox = await pool.query('SELECT count(*)::int AS n FROM outbox');
  const idem = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys');
  return {
    available: sku.rows[0].available_units,
    holds: holds.rows[0].n,
    orders: orders.rows[0].n,
    outbox: outbox.rows[0].n,
    idem: idem.rows[0].n,
  };
}

async function holdState(holdId) {
  const { rows } = await pool.query('SELECT state FROM holds WHERE id = $1', [holdId]);
  return rows[0]?.state ?? null;
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
  await removeAllInjection();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ---------------------------------------------------------------------------
// F1 — the transaction boundary in confirm
// ---------------------------------------------------------------------------

test('F1: confirm fails at the order insert -> the hold stays active', async () => {
  await reset();
  const holdId = await createHoldOrThrow({ quantity: 2, key: 'f1' });
  const before = await snapshot();
  assert.equal(before.available, 8, 'setup: 10 - 2');
  assert.equal(before.orders, 0);

  await injectFailureOn('orders');
  const res = await api(`/holds/${holdId}/confirm`, { method: 'POST' });
  await removeFailureOn('orders');

  assert.ok(res.status >= 400, `a failed confirm must not report success, got ${res.status}`);

  const after = await snapshot();

  // The whole point: the database must look like the request never happened.
  assert.equal(
    await holdState(holdId),
    'active',
    'PARTIAL WRITE: the hold was confirmed even though the transaction failed. ' +
      'This is what a missing BEGIN produces — the UPDATE auto-committed before the failure.',
  );
  assert.equal(after.orders, 0, 'no order must exist');
  assert.equal(after.outbox, 0, 'no event may escape a rolled-back transaction');
  assert.equal(after.available, 8, 'stock must be untouched');

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// F2 — business change and event are atomic
// ---------------------------------------------------------------------------

test('F2: confirm fails at the outbox insert -> neither the order nor the state change survives', async () => {
  await reset();
  const holdId = await createHoldOrThrow({ quantity: 1, key: 'f2' });

  await injectFailureOn('outbox');
  const res = await api(`/holds/${holdId}/confirm`, { method: 'POST' });
  await removeFailureOn('outbox');

  assert.ok(res.status >= 400, `expected a failure status, got ${res.status}`);

  const after = await snapshot();
  assert.equal(
    await holdState(holdId),
    'active',
    'PARTIAL WRITE: hold confirmed but no event was written',
  );
  assert.equal(
    after.orders,
    0,
    'the order was created in a separate transaction. The business change and its event ' +
      'must commit together or not at all. (Check that `client` is passed to insertInOutbox.)',
  );
  assert.equal(after.outbox, 0);

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// F3 / F4 — create-hold rollback and key consumption
// ---------------------------------------------------------------------------

test('F3: create-hold fails at the hold insert -> no hold, no stock change, no idempotency row', async () => {
  await reset();

  await injectFailureOn('holds');
  const res = await createHoldRequest({ quantity: 3, key: 'f3' });
  await removeFailureOn('holds');

  assert.ok(res.status >= 400, `expected a failure status, got ${res.status}`);

  const after = await snapshot();
  assert.equal(after.holds, 0, 'no hold may exist');
  assert.equal(after.available, 10, 'the decrement must have been rolled back');
  assert.equal(
    after.idem,
    0,
    'PHANTOM KEY: a key row survived a rolled-back reservation. Idempotency state must ' +
      'commit with the reservation, never before it.',
  );

  await assertInvariant();
});

test('F4: a rolled-back attempt must NOT consume the idempotency key', async () => {
  await reset();

  await injectFailureOn('holds');
  const failed = await createHoldRequest({ quantity: 2, key: 'f4' });
  await removeFailureOn('holds');
  assert.ok(failed.status >= 400, 'setup: the injected run must fail');

  // Same key, same payload, now with a healthy database.
  const retried = await createHoldRequest({ quantity: 2, key: 'f4' });

  assert.equal(
    retried.status,
    201,
    `the retry got ${retried.status} ${JSON.stringify(retried.body)}. A failed attempt must leave ` +
      'the key unused, so the client can legitimately try again.',
  );
  assert.equal((await snapshot()).available, 8);

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// F5 / F6 — connection hygiene
// ---------------------------------------------------------------------------

test('F5: 50 failed requests do not exhaust the pool', async () => {
  await reset();

  await injectFailureOn('holds');
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => createHoldRequest({ quantity: 1, key: `f5-${i}` })),
  );
  await removeFailureOn('holds');

  for (const r of results) assert.ok(r.status >= 400, `expected failures, got ${r.status}`);

  // If a client was released while still inside an aborted transaction, or never
  // released at all, this next request is the one that breaks.
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200, 'the service must still be ready after 50 failures');

  const recovered = await createHoldRequest({ quantity: 1, key: 'f5-recover' });
  assert.equal(
    recovered.status,
    201,
    `after 50 failures a valid request returned ${recovered.status} ${JSON.stringify(recovered.body)}. ` +
      'This is the "works for 20 requests then breaks" bug: a leaked or aborted connection.',
  );

  await assertInvariant();
});

test('F6: a business 409 does not poison the connection it used', async () => {
  await reset({ skuA: 1 });

  const first = await createHoldOrThrow({ quantity: 1, key: 'f6-a' });
  assert.ok(first);

  // Sold out -> 409, which still used a pooled connection.
  const soldOut = await createHoldRequest({ quantity: 1, key: 'f6-b' });
  assert.equal(soldOut.status, 409, `expected 409, got ${soldOut.status}`);

  // Immediately make a request that must succeed. If the previous connection went
  // back to the pool still inside an aborted transaction, this fails.
  await pool.query(
  'UPDATE skus SET total_units = total_units + 5, available_units = available_units + 5 WHERE id = $1',
  [SKU_A],
);
  const next = await createHoldRequest({ quantity: 1, key: 'f6-c' });
  assert.equal(
    next.status,
    201,
    `the request after a 409 returned ${next.status} ${JSON.stringify(next.body)}`,
  );

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// F7 — crash after commit, before the response
// ---------------------------------------------------------------------------

test('F7: a retry after a committed-but-unseen response replays the committed result', async () => {
  await reset();

  // This is "the process died after COMMIT but before the HTTP response reached the
  // client" — simulated from the outside, because that is exactly what the client
  // experiences: it never saw the answer.
  const original = await createHoldRequest({ quantity: 2, key: 'f7' });
  assert.equal(original.status, 201);

  const retry = await createHoldRequest({ quantity: 2, key: 'f7' });

  assert.equal(retry.status, 201, `retry returned ${retry.status}`);
  assert.deepEqual(
    retry.body,
    original.body,
    'the retry must receive the committed result, byte for byte — that is the whole point ' +
      'of putting idempotency state in the same transaction as the reservation.',
  );

  const after = await snapshot();
  assert.equal(after.holds, 1, 'one hold, not two');
  assert.equal(after.available, 8, 'one decrement, not two');

  await assertInvariant();
});
