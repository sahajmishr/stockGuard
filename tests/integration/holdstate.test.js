/**
 * StockGuard — Day 11 tests: confirm / cancel
 *
 * Save as: tests/integration/holdstate.test.js
 * Run:     node --test --test-concurrency=1 tests/integration/
 *
 * Real app, real HTTP, real PostgreSQL. No mocks.
 * Every test resets the DB first and asserts the accounting invariant last.
 *
 * Philosophy: assert strictly on DATABASE STATE, leniently on exact status codes
 * where the spec allows two defensible answers. A 200 with two orders is a failure
 * that looks green; that is what these tests are for.
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
const OTHER_USER = 'u2';

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

async function api(path, { method = 'GET', userId = USER, body } = {}) {
  const headers = {};
  if (userId) headers['x-user-id'] = userId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function createHold({ quantity = 1, key, userId = USER, skuId } = {}) {
  const sku = skuId ?? SKU_A;
  const k = key ?? `k-${Math.random().toString(36).slice(2)}`;
  const r = await fetch(`${baseUrl}/skus/${sku}/holds`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': userId,
      'x-idempotency-key': k,
    },
    body: JSON.stringify({ quantity }),
  });
  const body = await r.json().catch(() => null);
  assert.equal(
    r.status,
    201,
    `setup: create hold failed with ${r.status} ${JSON.stringify(body)}. Fix the create-hold path before running this file.`,
  );
  return body.hold_id;
}

const confirm = (holdId, userId = USER) =>
  api(`/holds/${holdId}/confirm`, { method: 'POST', userId });
const cancel = (holdId, userId = USER) =>
  api(`/holds/${holdId}/cancel`, { method: 'POST', userId });

async function holdState(holdId) {
  const { rows } = await pool.query('SELECT state, quantity, sku_id FROM holds WHERE id = $1', [
    holdId,
  ]);
  return rows[0] ?? null;
}

async function available() {
  const { rows } = await pool.query('SELECT available_units FROM skus WHERE id = $1', [SKU_A]);
  return rows[0].available_units;
}

async function orderCount(holdId) {
  if (holdId) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE hold_id = $1', [
      holdId,
    ]);
    return rows[0].n;
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
  return rows[0].n;
}

async function eventCount(holdId) {
  if (holdId) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE payload->>'hold_id' = $1`,
      [holdId],
    );
    return rows[0].n;
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
  return rows[0].n;
}

async function assertInvariant() {
  const result = await checkInvariants();
  assert.ok(result.ok, `accounting invariant violated:\n  ${result.failures.join('\n  ')}`);
}

/** Move a hold into the past while keeping CHECK (expires_at > created_at) satisfied. */
async function makeHoldExpired(holdId) {
  await pool.query(
    `UPDATE holds
        SET created_at = now() - interval '10 minutes',
            expires_at = now() - interval '5 minutes'
      WHERE id = $1`,
    [holdId],
  );
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
// C1–C4 — confirm
// ---------------------------------------------------------------------------

test('C1: confirm creates one order and moves the hold to confirmed', async () => {
  await reset();
  const holdId = await createHold({ quantity: 2 });
  assert.equal(await available(), 8, 'setup: stock should be 8 after a hold of 2');

  const res = await confirm(holdId);

  assert.ok(
    res.status === 200 || res.status === 201,
    `confirm returned ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.ok(res.body?.id || res.body?.order_id, 'response must carry the order id');

  const hold = await holdState(holdId);
  assert.equal(hold.state, 'confirmed', 'hold must be confirmed');
  assert.equal(await orderCount(holdId), 1, 'exactly one order');

  await assertInvariant();
});

test('C2: confirm does NOT decrement stock a second time', async () => {
  await reset();
  const holdId = await createHold({ quantity: 2 });
  const before = await available();

  await confirm(holdId);

  const after = await available();
  assert.equal(
    after,
    before,
    `stock changed on confirm: ${before} -> ${after}. The units were already taken at hold time; ` +
      'confirm only converts a reservation into a purchase. Decrementing twice is the classic oversell bug.',
  );

  await assertInvariant();
});

test('C3: confirm writes exactly one outbox event', async () => {
  await reset();
  const holdId = await createHold({ quantity: 1 });
  assert.equal(await eventCount(holdId), 0, 'a hold creation must not write this event yet');

  await confirm(holdId);

  assert.equal(
    await eventCount(holdId),
    1,
    'confirm must write exactly one outbox row (in the same transaction as the state change)',
  );
  assert.equal(await eventCount(), 1, 'no extra outbox rows');

  await assertInvariant();
});

test('C4: confirming twice yields one order and a documented repeat', async () => {
  await reset();
  const holdId = await createHold({ quantity: 1 });

  const first = await confirm(holdId);
  assert.ok(first.status === 200 || first.status === 201);

  const second = await confirm(holdId);

  assert.ok(
    second.status === 200 || second.status === 201,
    `a repeat of a completed transition should return the documented same result, got ${second.status}`,
  );
  assert.equal(await orderCount(holdId), 1, 'a repeat must not create a second order');
  assert.equal(await eventCount(holdId), 1, 'a repeat must not create a second event');
  assert.equal((await holdState(holdId)).state, 'confirmed');

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// C5–C8 — confirm rejections
// ---------------------------------------------------------------------------

test('C5: a non-owner cannot confirm', async () => {
  await reset();
  const holdId = await createHold({ quantity: 2 });

  const res = await confirm(holdId, OTHER_USER);

  assert.equal(res.status, 404, `expected 404 (do not reveal another user's hold), got ${res.status}`);
  assert.equal((await holdState(holdId)).state, 'active', 'state must not change');
  assert.equal(await orderCount(holdId), 0, 'no order may be created');
  assert.equal(await available(), 8, 'stock must not change');

  await assertInvariant();
});

test('C6: confirming an expired (but not yet reaped) hold is rejected, no oversell', async () => {
  await reset();
  const holdId = await createHold({ quantity: 3 });
  await makeHoldExpired(holdId);

  const res = await confirm(holdId);

  assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(
    (await holdState(holdId)).state,
    'active',
    'a rejected confirm must NOT change the state (the reaper owns that transition)',
  );
  assert.equal(await orderCount(holdId), 0, 'no order for an expired hold');
  assert.equal(await available(), 7, 'confirm must not restore stock either — that is the reaper job');

  await assertInvariant();
});

test('C7: confirming a cancelled hold is rejected', async () => {
  await reset();
  const holdId = await createHold({ quantity: 1 });
  await cancel(holdId);

  const res = await confirm(holdId);

  assert.equal(res.status, 409, `expected 409, got ${res.status}`);
  assert.equal((await holdState(holdId)).state, 'cancelled', 'state must stay cancelled');
  assert.equal(await orderCount(holdId), 0);

  await assertInvariant();
});

test('C8: confirming an unknown hold is 404', async () => {
  await reset();
  const res = await confirm('00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  await assertInvariant();
});

// ---------------------------------------------------------------------------
// C9–C12 — cancel
// ---------------------------------------------------------------------------

test('C9: cancel restores the units exactly once', async () => {
  await reset();
  const holdId = await createHold({ quantity: 4 });
  assert.equal(await available(), 6);

  const res = await cancel(holdId);

  assert.ok(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal((await holdState(holdId)).state, 'cancelled');
  assert.equal(await available(), 10, 'all 4 units must return');
  assert.equal(await eventCount(holdId), 1, 'one cancellation event');

  await assertInvariant();
});

test('C10: cancelling twice restores the units ONCE', async () => {
  await reset();
  const holdId = await createHold({ quantity: 4 });

  const first = await cancel(holdId);
  assert.equal(first.status, 200);
  assert.equal(await available(), 10);

  const second = await cancel(holdId);

  assert.ok(
    second.status === 200 || second.status === 409,
    `a repeat cancel must be a documented no-op (200) or a conflict (409), got ${second.status}`,
  );
  assert.equal(
    await available(),
    10,
    'DOUBLE RESTORE: the second cancel added units again. available_units is now impossible.',
  );
  assert.equal(await eventCount(holdId), 1, 'a repeat cancel must not create a second event');

  await assertInvariant();
});

test('C11: a non-owner cannot cancel', async () => {
  await reset();
  const holdId = await createHold({ quantity: 2 });

  const res = await cancel(holdId, OTHER_USER);

  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal((await holdState(holdId)).state, 'active', 'state must not change');
  assert.equal(await available(), 8, 'stock must not change');

  await assertInvariant();
});

test('C12: cancelling a confirmed hold is rejected and does not restore units', async () => {
  await reset();
  const holdId = await createHold({ quantity: 2 });
  await confirm(holdId);

  const res = await cancel(holdId);

  assert.equal(res.status, 409, `expected 409, got ${res.status}`);
  assert.equal((await holdState(holdId)).state, 'confirmed');
  assert.equal(await available(), 8, 'a confirmed purchase keeps its units');

  await assertInvariant();
});

// ---------------------------------------------------------------------------
// C13–C14 — validation and the invariant
// ---------------------------------------------------------------------------

test('C13: a non-UUID hold id is a 400 JSON error, not a 500', async () => {
  await reset();
  for (const badId of ['abc', '1', 'nope-nope']) {
    const res = await confirm(badId);
    assert.equal(res.status, 400, `confirm(${badId}) returned ${res.status}`);
    assert.ok(res.body, 'must be JSON, not an HTML error page');
    assert.equal(typeof res.body.error, 'string', 'must use the standard {error, message} shape');
  }
  await assertInvariant();
});

test('C14: the accounting invariant still holds after the whole file', async () => {
  await assertInvariant();
});
