process.env.CONSUMER_URL = 'http://127.0.0.1:4517/events';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const fake = require('../support/fakeConsumer');
const relayService = require('../../src/services/relayService');
const consumerService = require('../../src/services/consumerService');
const env = require('../../src/config/env');

let server;
let client;
let ids;

before(async () => {
  server = await fake.start(4517);
  const started = await h.listen();
  client = h.makeClient(started.baseUrl);
  h.servers = [started.server];
});

after(async () => {
  await h.close(h.servers[0]);
  await new Promise((resolve) => server.close(resolve));
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset({ skuA: 60, skuB: 60, skuC: 1 });
  fake.reset();
});

async function outboxRow(id) {
  const { rows } = await h.pool.query('SELECT * FROM outbox WHERE id = $1', [id]);
  return rows[0];
}

async function onlyEvent() {
  const { rows } = await h.pool.query('SELECT id FROM outbox ORDER BY created_at LIMIT 1');
  return outboxRow(rows[0].id);
}

async function makeEvent(key = 'r1') {
  await h.createHoldOrThrow(client, { skuId: ids.SKU_A, quantity: 1, key });
  const { rows } = await h.pool.query("SELECT id FROM outbox WHERE event_type = 'HoldCreated' ORDER BY created_at DESC LIMIT 1");
  return rows[0].id;
}

test('a delivered event is marked published and the consumer sees the envelope', async () => {
  const eventId = await makeEvent();

  const result = await relayService.publishBatch();

  assert.equal(result.delivered, 1);
  assert.equal((await outboxRow(eventId)).state, 'published');
  const sent = fake.received()[0];
  assert.equal(sent.event_id, eventId);
  assert.equal(sent.event_type, 'HoldCreated');
  assert.equal(sent.aggregate_version, 1);
  assert.ok(sent.payload);
});

test('a published event is never claimed again', async () => {
  await makeEvent();
  await relayService.publishBatch();
  const second = await relayService.publishBatch();

  assert.equal(second.claimed, 0);
  assert.equal(fake.received().length, 1);
});

test('a failing consumer leaves the event pending with a backoff and an error', async () => {
  fake.setMode('fail');
  const eventId = await makeEvent();

  const result = await relayService.publishBatch();

  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  const row = await outboxRow(eventId);
  assert.equal(row.state, 'pending');
  assert.equal(row.retry_count, 1);
  assert.ok(row.last_error.includes('500'));
  assert.ok(row.next_attempt_at.getTime() > Date.now(), 'the retry must be scheduled in the future');
  assert.equal(row.lease_expires_at, null);
});

test('the backoff grows with each attempt', async () => {
  fake.setMode('fail');
  const eventId = await makeEvent();
  const gaps = [];

  for (let i = 0; i < 4; i += 1) {
    await h.pool.query('UPDATE outbox SET next_attempt_at = now() WHERE id = $1', [eventId]);
    await relayService.publishBatch();
    const row = await outboxRow(eventId);
    gaps.push(row.next_attempt_at.getTime() - Date.now());
  }

  for (let i = 1; i < gaps.length; i += 1) {
    assert.ok(gaps[i] > gaps[i - 1], `attempt ${i + 1} must wait longer than attempt ${i}`);
  }
});

test('an event that exhausts its attempts is moved to dead, not deleted', async () => {
  fake.setMode('fail');
  const eventId = await makeEvent();

  for (let i = 0; i < env.relay.maxAttempts; i += 1) {
    await h.pool.query('UPDATE outbox SET next_attempt_at = now() WHERE id = $1', [eventId]);
    await relayService.publishBatch();
  }

  const row = await outboxRow(eventId);
  assert.equal(row.state, 'dead');
  assert.equal(row.retry_count, env.relay.maxAttempts);
  assert.ok(row.last_error);
  assert.ok(row.payload, 'a dead event must keep its payload for replay');
});

test('a consumer that answers 400 is treated as a failure, not a success', async () => {
  fake.setHandler(() => 400);
  const eventId = await makeEvent();

  await relayService.publishBatch();

  assert.equal((await outboxRow(eventId)).state, 'pending');
});

test('an expired lease lets another relay pick the event up', async () => {
  const eventId = await makeEvent();
  await h.pool.query(
    `UPDATE outbox
        SET state = 'leased',
            lease_expires_at = now() - interval '1 minute',
            lease_owner = 'crashed-relay'
      WHERE id = $1`,
    [eventId],
  );

  const result = await relayService.publishBatch();

  assert.equal(result.claimed, 1);
  assert.equal((await outboxRow(eventId)).state, 'published');
});

test('a live lease blocks a second relay from taking the same event', async () => {
  const eventId = await makeEvent();
  const first = await relayService.claimBatch();
  const second = await relayService.claimBatch();

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal((await outboxRow(eventId)).state, 'leased');
  await relayService.deliver(first[0]);
});

test('during delivery the claim is committed, so other transactions can read it', async () => {
  const eventId = await makeEvent();
  let observed = null;
  fake.setHandler(async () => {
    const { rows } = await h.pool.query('SELECT state FROM outbox WHERE id = $1', [eventId]);
    observed = rows[0].state;
    return 200;
  });

  await relayService.publishBatch();

  assert.equal(observed, 'leased', 'the relay must not hold a transaction open across the HTTP call');
  assert.equal((await outboxRow(eventId)).state, 'published');
});

test('a relay that crashes after sending causes a redelivery, and the effect still happens once', async () => {
  fake.setHandler(async (body) => {
    await consumerService.handleEvent(body);
    return 200;
  });
  const eventId = await makeEvent();
  await relayService.publishBatch();
  assert.equal((await h.counts()).ledger, 1);

  await h.pool.query(
    `UPDATE outbox SET state = 'leased', lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [eventId],
  );
  await relayService.publishBatch();

  const counts = await h.counts();
  assert.equal(counts.ledger, 1, 'the duplicate delivery must not double the effect');
  assert.equal(counts.processed, 1, 'the consumer ledger must hold exactly one row per event');
});

test('batch size limits how many events one pass takes', async () => {
  for (let i = 0; i < env.relay.batchSize + 3; i += 1) {
    await h.createHoldOrThrow(client, { skuId: ids.SKU_A, quantity: 1, key: `batch-${i}` });
  }

  const first = await relayService.publishBatch();
  assert.equal(first.claimed, env.relay.batchSize);

  let drained = first.claimed;
  for (let i = 0; i < 3; i += 1) {
    const next = await relayService.publishBatch();
    drained += next.claimed;
    if (next.claimed === 0) break;
  }
  assert.equal(drained, env.relay.batchSize + 3);
});

test('events for one hold are delivered in version order', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'order-1' });
  await client.confirm(holdId);

  await relayService.publishBatch();

  const versions = fake.received().map((e) => e.aggregate_version);
  assert.deepEqual(versions, [1, 2]);
  assert.deepEqual(
    fake.received().map((e) => e.event_type),
    ['HoldCreated', 'HoldConfirmed'],
  );
});

test('a consumer that is down leaves the event retryable instead of losing it', async () => {
  const eventId = await makeEvent();
  await new Promise((resolve) => server.close(resolve));

  try {
    const result = await relayService.publishBatch();

    assert.equal(result.failed, 1);
    const row = await outboxRow(eventId);
    assert.equal(row.state, 'pending');
    assert.ok(row.retry_count >= 1);
    assert.ok(/ECONNREFUSED|fetch failed|socket/i.test(row.last_error), `unexpected error text: ${row.last_error}`);
  } finally {
    server = await fake.start(4517);
  }

  fake.reset();
  await h.pool.query('UPDATE outbox SET next_attempt_at = now() WHERE id = $1', [eventId]);
  const recovered = await relayService.publishBatch();
  assert.equal(recovered.delivered, 1, 'the event must go out once the consumer is back');
  assert.equal((await outboxRow(eventId)).state, 'published');
});
