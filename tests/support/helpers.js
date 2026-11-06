const pool = require('../../src/config/db');
const app = require('../../src/app');
const { checkInvariants } = require('../../scripts/check-invariants');

function listen(instance = app) {
  return new Promise((resolve) => {
    const server = instance.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function reset({ skuA = 10, skuB = 10, skuC = 1 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE TABLE consumer_ledger, processed_events, outbox, idempotency_keys, orders, holds, skus RESTART IDENTITY CASCADE',
    );
    const { rows } = await client.query(
      `INSERT INTO skus (total_units, available_units)
       VALUES ($1, $1), ($2, $2), ($3, $3) RETURNING id`,
      [skuA, skuB, skuC],
    );
    await client.query('COMMIT');
    return { SKU_A: rows[0].id, SKU_B: rows[1].id, SKU_C: rows[2].id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function makeClient(baseUrl) {
  async function call(path, { method = 'GET', userId = 'u1', key, admin, payload } = {}) {
    const headers = { 'x-user-id': userId };
    if (key) headers['x-idempotency-key'] = key;
    if (admin) headers['x-admin-token'] = admin;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (userId === null) delete headers['x-user-id'];

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  return {
    call,
    createHold: ({ skuId, quantity = 1, key, userId = 'u1' }) =>
      call(`/skus/${skuId}/holds`, { method: 'POST', payload: { quantity }, key, userId }),
    confirm: (holdId, userId = 'u1') =>
      call(`/holds/${holdId}/confirm`, { method: 'POST', userId }),
    cancel: (holdId, userId = 'u1') => call(`/holds/${holdId}/cancel`, { method: 'POST', userId }),
    getHold: (holdId, userId = 'u1') => call(`/holds/${holdId}`, { userId }),
    outbox: (admin = 'dev-admin-token') => call('/admin/outbox', { admin }),
    replay: (eventId, admin = 'dev-admin-token') =>
      call(`/admin/outbox/${eventId}/replay`, { method: 'POST', admin }),
  };
}

async function createHoldOrThrow(client, args) {
  const res = await client.createHold(args);
  if (res.status !== 201) {
    throw new Error(`setup failed: create hold returned ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.hold_id;
}

async function available(skuId) {
  const { rows } = await pool.query('SELECT available_units FROM skus WHERE id = $1', [skuId]);
  return rows[0].available_units;
}

async function holdState(holdId) {
  const { rows } = await pool.query('SELECT state FROM holds WHERE id = $1', [holdId]);
  return rows[0]?.state ?? null;
}

async function counts() {
  const q = async (sql) => (await pool.query(sql)).rows[0].n;
  return {
    holds: await q('SELECT count(*)::int AS n FROM holds'),
    orders: await q('SELECT count(*)::int AS n FROM orders'),
    outbox: await q('SELECT count(*)::int AS n FROM outbox'),
    published: await q("SELECT count(*)::int AS n FROM outbox WHERE state = 'published'"),
    dead: await q("SELECT count(*)::int AS n FROM outbox WHERE state = 'dead'"),
    idem: await q('SELECT count(*)::int AS n FROM idempotency_keys'),
    processed: await q('SELECT count(*)::int AS n FROM processed_events'),
    ledger: await q('SELECT count(*)::int AS n FROM consumer_ledger'),
  };
}

async function expireHold(holdId) {
  await pool.query(
    `UPDATE holds
        SET created_at = now() - interval '10 minutes',
            expires_at = now() - interval '5 minutes'
      WHERE id = $1`,
    [holdId],
  );
}

async function assertInvariant() {
  const result = await checkInvariants();
  if (!result.ok) {
    throw new Error(`accounting invariant violated:\n  ${result.failures.join('\n  ')}`);
  }
  return result;
}

module.exports = {
  pool,
  app,
  listen,
  close,
  reset,
  makeClient,
  createHoldOrThrow,
  available,
  holdState,
  counts,
  expireHold,
  assertInvariant,
};
