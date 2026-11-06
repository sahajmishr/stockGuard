const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('../support/helpers');
const fake = require('../support/fakeConsumer');
const spawnHelper = require('../support/spawn');

const projectRoot = path.resolve(__dirname, '../..');
const CONSUMER_PORT = 4519;

let api;
let client;
let ids;
let fakeServer;

before(async () => {
  fakeServer = await fake.start(CONSUMER_PORT);
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

async function waitFor(check, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function claimableCount() {
  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS n FROM outbox
      WHERE (state = 'pending' AND next_attempt_at <= now())
         OR (state = 'leased' AND lease_expires_at <= now())`,
  );
  return rows[0].n;
}

test('a relay killed mid delivery loses nothing and hands the event to the next relay', async () => {
  fake.setHandler(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return 200;
  });
  await client.createHold({ skuId: ids.SKU_A, quantity: 2, key: 'kill-1' });

  const child = spawn(process.execPath, ['src/worker/relay.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CONSUMER_URL: `http://127.0.0.1:${CONSUMER_PORT}/events`,
      RELAY_LEASE_SECONDS: '2',
      RELAY_INTERVAL_MS: '100',
      RELAY_REQUEST_TIMEOUT_MS: '60000',
    },
    stdio: 'ignore',
  });

  const claimed = await waitFor(async () => {
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state = 'leased'");
    return rows[0].n === 1;
  });
  assert.ok(claimed, 'the worker must have taken a lease before it dies');

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const afterKill = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state = 'leased'");
  assert.equal(afterKill.rows[0].n, 1, 'the dead worker leaves its lease behind');

  const handover = await waitFor(async () => (await claimableCount()) === 1);
  assert.ok(handover, 'the expired lease must make the event claimable again');

  fake.setHandler(async () => 200);
  const recovered = await spawnHelper.runToCompletion({
    script: 'scripts/relay-once.js',
    env: { CONSUMER_URL: `http://127.0.0.1:${CONSUMER_PORT}/events` },
  });

  assert.equal(recovered.code, 0, recovered.stderr);
  const published = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state = 'published'");
  assert.equal(published.rows[0].n, 1, 'the event must end up published exactly once');
  const deliveries = fake.received();
  assert.ok(deliveries.length >= 1);
  assert.equal(new Set(deliveries.map((d) => d.event_id)).size, 1, 'every attempt carries the same event id');
  assert.equal((await h.counts()).processed ?? 0, 0, 'this fake consumer does not record effects');
});

test('a consumer outage leaves the backlog queued and drains when it returns', async () => {
  for (let i = 0; i < 3; i += 1) {
    await client.createHold({ skuId: ids.SKU_B, quantity: 1, key: `drain-${i}` });
  }

  const down = await spawnHelper.runToCompletion({
    script: 'scripts/relay-once.js',
    env: { CONSUMER_URL: 'http://127.0.0.1:4599/events', RELAY_MAX_ATTEMPTS: '100' },
  });
  assert.equal(down.code, 0, down.stderr);

  const stillPending = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state = 'pending'");
  assert.equal(stillPending.rows[0].n, 3, 'a dead consumer must not swallow events');

  await h.pool.query('UPDATE outbox SET next_attempt_at = now()');
  const relay = await spawnHelper.runToCompletion({
    script: 'scripts/relay-once.js',
    env: { CONSUMER_URL: `http://127.0.0.1:${CONSUMER_PORT}/events` },
  });

  assert.equal(relay.code, 0, relay.stderr);
  const published = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state = 'published'");
  assert.equal(published.rows[0].n, 3);
  assert.equal(fake.received().length, 3);
  await h.assertInvariant();
});

test('the consumer ledger survives a relay restart mid batch', async () => {
  const fakeHandler = async (body) => {
    const consumerService = require('../../src/services/consumerService');
    return (await consumerService.handleEvent(body)).status;
  };
  fake.setHandler(fakeHandler);

  for (let i = 0; i < 4; i += 1) {
    await client.createHold({ skuId: ids.SKU_A, quantity: 1, key: `restart-${i}` });
  }

  const first = await spawnHelper.runToCompletion({
    script: 'scripts/relay-once.js',
    env: { CONSUMER_URL: `http://127.0.0.1:${CONSUMER_PORT}/events`, RELAY_BATCH_SIZE: '2' },
  });
  assert.equal(first.code, 0, first.stderr);

  const second = await spawnHelper.runToCompletion({
    script: 'scripts/relay-once.js',
    env: { CONSUMER_URL: `http://127.0.0.1:${CONSUMER_PORT}/events`, RELAY_BATCH_SIZE: '2' },
  });
  assert.equal(second.code, 0, second.stderr);

  const counts = await h.counts();
  assert.equal(counts.published, 4);
  assert.equal(counts.ledger, 4, 'each event must be applied exactly once across both passes');
  await h.assertInvariant();
});
