process.env.CONSUMER_URL = 'http://127.0.0.1:4517/events';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const fake = require('../support/fakeConsumer');
const relayService = require('../../src/services/relayService');
const consumerService = require('../../src/services/consumerService');

let api;
let client;
let ids;
let fakeServer;

before(async () => {
  fakeServer = await fake.start(4517);
  const started = await h.listen();
  api = started.server;
  client = h.makeClient(started.baseUrl);
});

after(async () => {
  await h.close(api);
  await new Promise((resolve) => fakeServer.close(resolve));
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset();
  fake.reset();
});

async function killEvent(eventId) {
  await h.pool.query(
    `UPDATE outbox
        SET state = 'dead', retry_count = 5, last_error = 'consumer exploded'
      WHERE id = $1`,
    [eventId],
  );
}

test('the admin endpoints reject a missing token', async () => {
  const overview = await fetch(`${api.address() ? '' : ''}`, {}).catch(() => null);
  assert.ok(overview === null || true);
  const res = await client.call('/admin/outbox', {});
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'ADMIN_UNAUTHORIZED');
});

test('the admin endpoints reject a wrong token', async () => {
  const res = await client.outbox('wrong-token');
  assert.equal(res.status, 403);
});

test('the overview counts events by state and joins hold and order totals', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'a1' });
  await client.confirm(await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'a2' }));
  await relayService.publishBatch();
  await h.pool.query("UPDATE holds SET state = 'cancelled' WHERE id = $1", [holdId]);

  const res = await client.outbox();

  assert.equal(res.status, 200);
  assert.equal(res.body.by_state.published, 3);
  assert.equal(res.body.backlog, 0);
  assert.equal(res.body.orders, 1);
  assert.equal(res.body.holds_by_state.cancelled, 1);
  assert.equal(res.body.holds_by_state.confirmed, 1);
  assert.deepEqual(res.body.dead, []);
});

test('the overview lists dead events with the reason they died', async () => {
  await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'a3' });
  const { rows } = await h.pool.query('SELECT id, event_type FROM outbox LIMIT 1');
  await killEvent(rows[0].id);

  const res = await client.outbox();

  assert.equal(res.body.dead.length, 1);
  assert.equal(res.body.dead[0].id, rows[0].id);
  assert.equal(res.body.dead[0].event_type, 'HoldCreated');
  assert.equal(res.body.dead[0].last_error, 'consumer exploded');
  assert.equal(res.body.by_state.dead, 1);
});

test('replaying a dead event puts it back in the queue', async () => {
  await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'a4' });
  const { rows } = await h.pool.query('SELECT id FROM outbox LIMIT 1');
  await killEvent(rows[0].id);

  const res = await client.replay(rows[0].id);

  assert.equal(res.status, 200);
  assert.equal(res.body.previous_state, 'dead');
  assert.equal(res.body.state, 'pending');
  assert.equal(res.body.retry_count, 0);

  const delivered = await relayService.publishBatch();
  assert.equal(delivered.delivered, 1);
  const state = await h.pool.query('SELECT state FROM outbox WHERE id = $1', [rows[0].id]);
  assert.equal(state.rows[0].state, 'published');
});

test('replaying an unknown event is a 404, not a crash', async () => {
  const res = await client.replay('00000000-0000-4000-8000-000000000000');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'EVENT_NOT_FOUND');
});

test('replaying a published event sends it again and the consumer ignores the repeat', async () => {
  fake.setHandler(async (body) => {
    await consumerService.handleEvent(body);
    return 200;
  });
  await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'a5' });
  await relayService.publishBatch();
  const { rows } = await h.pool.query('SELECT id FROM outbox LIMIT 1');

  const res = await client.replay(rows[0].id);
  assert.equal(res.status, 200);
  assert.equal(res.body.previous_state, 'published');

  await relayService.publishBatch();

  assert.equal(fake.received().length, 2, 'the relay must actually send it a second time');
  assert.equal((await h.counts()).ledger, 1, 'the consumer must not apply it twice');
});

test('replay clears the previous error so the event looks fresh', async () => {
  await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'a6' });
  const { rows } = await h.pool.query('SELECT id FROM outbox LIMIT 1');
  await killEvent(rows[0].id);

  await client.replay(rows[0].id);

  const after = await h.pool.query('SELECT last_error, lease_expires_at, next_attempt_at FROM outbox WHERE id = $1', [
    rows[0].id,
  ]);
  assert.equal(after.rows[0].last_error, null);
  assert.equal(after.rows[0].lease_expires_at, null);
  assert.ok(after.rows[0].next_attempt_at.getTime() <= Date.now() + 1000);
});

test('the admin surface never exposes a 500 for a bad id', async () => {
  const res = await client.replay('not-a-uuid');
  assert.equal(res.status, 400);
  assert.notEqual(res.status, 500);
});
