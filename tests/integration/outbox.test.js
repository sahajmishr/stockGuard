const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');

let server;
let client;
let ids;

before(async () => {
  const started = await h.listen();
  server = started.server;
  client = h.makeClient(started.baseUrl);
});

after(async () => {
  await h.close(server);
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset();
});

async function eventsFor(holdId) {
  const { rows } = await h.pool.query(
    'SELECT event_type, aggregate_version, payload, state FROM outbox WHERE aggregate_id = $1 ORDER BY aggregate_version',
    [holdId],
  );
  return rows;
}

test('creating a hold writes exactly one HoldCreated event in the same transaction', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, quantity: 2, key: 'k1' });

  const events = await eventsFor(holdId);

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'HoldCreated');
  assert.equal(events[0].aggregate_version, 1);
  assert.equal(events[0].state, 'pending');
  assert.equal(events[0].payload.hold_id, holdId);
  assert.equal(events[0].payload.sku_id, ids.SKU_A);
  assert.equal(events[0].payload.quantity, 2);
  assert.equal(events[0].payload.owner_id, 'u1');
});

test('confirming a hold appends a version 2 event', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'k2' });
  await client.confirm(holdId);

  const events = await eventsFor(holdId);

  assert.deepEqual(
    events.map((e) => [e.event_type, e.aggregate_version]),
    [['HoldCreated', 1], ['HoldConfirmed', 2]],
  );
});

test('cancelling a hold appends a HoldCancelled event', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'k3' });
  await client.cancel(holdId);

  const events = await eventsFor(holdId);
  assert.deepEqual(
    events.map((e) => [e.event_type, e.aggregate_version]),
    [['HoldCreated', 1], ['HoldCancelled', 2]],
  );
});

test('a failed create writes no event at all', async () => {
  const res = await client.createHold({ skuId: ids.SKU_C, quantity: 5, key: 'k4' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'INSUFFICIENT_STOCK');
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE event_type = 'HoldCreated'");
  assert.equal(rows[0].n, 0);
});

test('a rejected transition writes no event', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'k5' });
  await client.confirm(holdId);
  const res = await client.cancel(holdId);

  assert.equal(res.status, 409);
  const events = await eventsFor(holdId);
  assert.equal(events.length, 2, 'the rejected cancel must not leave an event behind');
});

test('a replayed request writes no second event', async () => {
  const first = await client.createHold({ skuId: ids.SKU_A, key: 'k6' });
  await client.createHold({ skuId: ids.SKU_A, key: 'k6' });

  const events = await eventsFor(first.body.hold_id);
  assert.equal(events.length, 1);
});

test('the unique constraint rejects a duplicate event version', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'k7' });

  await assert.rejects(
    () =>
      h.pool.query(
        `INSERT INTO outbox (event_type, aggregate_id, aggregate_version, payload)
         VALUES ('HoldCreated', $1, 1, '{}'::jsonb)`,
        [holdId],
      ),
    (err) => err.code === '23505',
  );
});

test('every event carries the fields the consumer needs', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_B, quantity: 3, key: 'k8' });
  const events = await eventsFor(holdId);
  const payload = events[0].payload;

  for (const field of ['hold_id', 'sku_id', 'quantity', 'owner_id']) {
    assert.ok(field in payload, `payload is missing ${field}`);
  }
  assert.equal(payload.sku_id, ids.SKU_B);
  assert.equal(payload.quantity, 3);
});

test('events start life pending with no attempts recorded', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'k9' });
  const [event] = await eventsFor(holdId);

  assert.equal(event.state, 'pending');
  const { rows } = await h.pool.query(
    'SELECT retry_count, next_attempt_at, lease_expires_at FROM outbox WHERE aggregate_id = $1',
    [holdId],
  );
  assert.equal(rows[0].retry_count, 0);
  assert.ok(rows[0].next_attempt_at instanceof Date);
  assert.ok(rows[0].next_attempt_at.getTime() <= Date.now() + 1000, 'a fresh event must be immediately claimable');
  assert.equal(rows[0].lease_expires_at, null);
});
