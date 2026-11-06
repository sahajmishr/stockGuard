process.env.CONSUMER_URL = 'http://127.0.0.1:4517/events';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const consumerService = require('../../src/services/consumerService');
const consumerApp = require('../../src/consumer/app');

let api;
let client;
let ids;
let consumerHttp;
let consumerServer;

let seq = 0;
function nextId() {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function event(overrides = {}) {
  return {
    event_id: nextId(),
    event_type: 'HoldCreated',
    aggregate_id: '00000000-0000-4000-8000-0000000000aa',
    aggregate_version: 1,
    payload: { hold_id: '00000000-0000-4000-8000-0000000000aa', sku_id: 1, quantity: 2, owner_id: 'u1' },
    ...overrides,
  };
}

before(async () => {
  const started = await h.listen();
  api = started.server;
  client = h.makeClient(started.baseUrl);
  const consumerStarted = await h.listen(consumerApp);
  consumerServer = consumerStarted.server;
  consumerHttp = consumerStarted.baseUrl;
});

after(async () => {
  await h.close(api);
  await h.close(consumerServer);
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset();
});

test('a fresh event is applied and recorded in the ledger', async () => {
  const res = await consumerService.handleEvent(event());

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'applied');
  assert.equal((await h.counts()).processed, 1);
  assert.equal((await h.counts()).ledger, 1);
});

test('the same event twice is applied once and reported as a duplicate', async () => {
  const payload = event();
  const first = await consumerService.handleEvent(payload);
  const second = await consumerService.handleEvent(payload);

  assert.equal(first.body.status, 'applied');
  assert.equal(second.body.status, 'duplicate_ignored');
  assert.equal(second.status, 200);
  const counts = await h.counts();
  assert.equal(counts.processed, 1);
  assert.equal(counts.ledger, 1);
});

test('ten concurrent copies of one event still produce one effect', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => consumerService.handleEvent(event({ event_id: '00000000-0000-4000-8000-000000000901' }))),
  );

  const applied = results.filter((r) => r.body.status === 'applied').length;
  assert.equal(applied, 1, 'exactly one delivery may win');
  assert.equal((await h.counts()).ledger, 1);
});

test('different events are both applied', async () => {
  await consumerService.handleEvent(event({ event_id: '00000000-0000-4000-8000-000000000902' }));
  await consumerService.handleEvent(event({ event_id: '00000000-0000-4000-8000-000000000903' }));

  assert.equal((await h.counts()).ledger, 2);
});

test('an event without an event_id is rejected with a problem list', async () => {
  const res = await consumerService.handleEvent({ event_type: 'HoldCreated', payload: {} });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_EVENT');
  assert.ok(res.body.problems.length >= 2);
  assert.equal((await h.counts()).processed, 0);
});

test('a payload that is not an object is rejected', async () => {
  const res = await consumerService.handleEvent(event({ payload: 'nope' }));
  assert.equal(res.status, 400);
});

test('a non numeric quantity is rejected', async () => {
  const res = await consumerService.handleEvent(
    event({ payload: { hold_id: '00000000-0000-4000-8000-0000000000aa', sku_id: 1, quantity: 'two' } }),
  );
  assert.equal(res.status, 400);
  assert.ok(res.body.problems.some((p) => p.includes('quantity')));
});

test('a null body does not throw', async () => {
  const res = await consumerService.handleEvent(null);
  assert.equal(res.status, 400);
});

test('the HTTP endpoint applies an event and answers 200', async () => {
  const res = await fetch(`${consumerHttp}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event({ event_id: '00000000-0000-4000-8000-000000000904' })),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'applied');
});

test('the HTTP endpoint reports duplicates as 200 with duplicate_ignored', async () => {
  const body = JSON.stringify(event({ event_id: '00000000-0000-4000-8000-000000000905' }));
  await fetch(`${consumerHttp}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const res = await fetch(`${consumerHttp}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'duplicate_ignored');
});

test('the HTTP endpoint rejects a bad payload with 400', async () => {
  const res = await fetch(`${consumerHttp}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_type: 'HoldCreated' }),
  });

  assert.equal(res.status, 400);
});

test('the consumer reports ready only when the database answers', async () => {
  const res = await fetch(`${consumerHttp}/health/ready`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'UP');
});

test('a real event end to end lands one ledger row per sku', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_B, quantity: 4, key: 'c-e2e' });
  const { rows } = await h.pool.query(
    "SELECT id, event_type, payload FROM outbox WHERE event_type = 'HoldCreated' AND aggregate_id = $1",
    [holdId],
  );

  const res = await consumerService.handleEvent({
    event_id: rows[0].id,
    event_type: rows[0].event_type,
    aggregate_id: holdId,
    aggregate_version: 1,
    payload: rows[0].payload,
  });

  assert.equal(res.body.status, 'applied');
  const ledger = await h.pool.query('SELECT sku_id, quantity FROM consumer_ledger WHERE event_id = $1', [rows[0].id]);
  assert.equal(ledger.rows[0].sku_id, ids.SKU_B);
  assert.equal(ledger.rows[0].quantity, 4);
});
