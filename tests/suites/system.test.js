process.env.CONSUMER_URL = 'http://127.0.0.1:4518/events';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const fake = require('../support/fakeConsumer');
const relayService = require('../../src/services/relayService');
const reaperService = require('../../src/services/reaperService');
const consumerService = require('../../src/services/consumerService');

let api;
let client;
let ids;
let consumerServer;

before(async () => {
  consumerServer = await fake.start(4518);
  fake.setHandler(async (body) => {
    const result = await consumerService.handleEvent(body);
    return result.status;
  });
  const started = await h.listen();
  api = started.server;
  client = h.makeClient(started.baseUrl);
});

after(async () => {
  await h.close(api);
  await new Promise((resolve) => consumerServer.close(resolve));
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset({ skuA: 30, skuB: 30, skuC: 1 });
  fake.reset();
  fake.setHandler(async (body) => (await consumerService.handleEvent(body)).status);
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    const result = await relayService.publishBatch();
    if (result.claimed === 0) return;
  }
}

test('the full purchase journey walks every stage of the system', async () => {
  const created = await client.createHold({ skuId: ids.SKU_A, quantity: 5, key: 'journey-1' });
  assert.equal(created.status, 201);
  const holdId = created.body.hold_id;
  assert.equal(await h.available(ids.SKU_A), 25);

  await settle();
  assert.equal(
    (await h.pool.query('SELECT count(*)::int AS n FROM outbox WHERE state = $1', ['published'])).rows[0].n,
    1,
  );
  assert.equal((await h.counts()).ledger, 1);

  const confirmed = await client.confirm(holdId);
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.quantity, 5);
  assert.equal(confirmed.body.sku_id, ids.SKU_A);

  await settle();
  assert.equal((await h.counts()).ledger, 2, 'the consumer saw the create and the confirm');

  const order = await h.pool.query('SELECT * FROM orders WHERE hold_id = $1', [holdId]);
  assert.equal(order.rows.length, 1);
  assert.equal(order.rows[0].sku_id, ids.SKU_A);
  assert.equal(await h.available(ids.SKU_A), 25, 'a confirmed hold keeps its units');
  await h.assertInvariant();
});

test('the abandoned purchase journey ends with the units back on the shelf', async () => {
  const created = await client.createHold({ skuId: ids.SKU_A, quantity: 5, key: 'journey-2' });
  const holdId = created.body.hold_id;
  await settle();

  await h.expireHold(holdId);
  const sweep = await reaperService.sweepOnce();
  assert.equal(sweep.expired, 1);
  assert.equal(await h.available(ids.SKU_A), 30);

  await settle();
  assert.equal((await h.counts()).ledger, 2, 'the consumer saw the create and the expiry');
  assert.equal(await h.holdState(holdId), 'expired');
  await h.assertInvariant();
});

test('the changed mind journey restores the units and tells the consumer', async () => {
  const created = await client.createHold({ skuId: ids.SKU_B, quantity: 4, key: 'journey-3' });
  const cancelled = await client.cancel(created.body.hold_id);

  assert.equal(cancelled.status, 200);
  await settle();

  const types = fake.received().map((e) => e.event_type);
  assert.deepEqual(types, ['HoldCreated', 'HoldCancelled']);
  assert.equal(await h.available(ids.SKU_B), 30);
  await h.assertInvariant();
});

test('a hundred mixed operations leave the books balanced', async () => {
  const holds = [];
  for (let i = 0; i < 40; i += 1) {
    const res = await client.createHold({
      skuId: i % 2 === 0 ? ids.SKU_A : ids.SKU_B,
      quantity: 1 + (i % 3),
      key: `mix-${i}`,
      userId: `u${i % 7}`,
    });
    if (res.status === 201) holds.push(res.body.hold_id);
  }

  let confirmed = 0;
  let cancelled = 0;
  let expired = 0;

  for (let i = 0; i < holds.length; i += 1) {
    if (i % 3 === 0) {
      if ((await client.confirm(holds[i], `u${i % 7}`)).status === 201) confirmed += 1;
    } else if (i % 3 === 1) {
      if ((await client.cancel(holds[i], `u${i % 7}`)).status === 200) cancelled += 1;
    } else {
      await h.expireHold(holds[i]);
      expired += 1;
    }
  }

  const sweep = await reaperService.sweepOnce({ batchSize: 100 });
  assert.equal(sweep.expired, expired);
  await settle();

  assert.equal((await h.counts()).orders, confirmed);
  await h.assertInvariant();

  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS n FROM holds WHERE state IN ('active', 'confirmed')`,
  );
  assert.equal(rows[0].n, confirmed, 'only confirmed holds may still be counted against stock');
});

test('a consumer outage delays the ledger but never the sale', async () => {
  let consumerUp = false;
  fake.setHandler(async (body) => {
    if (!consumerUp) return 503;
    return (await consumerService.handleEvent(body)).status;
  });

  const created = await client.createHold({ skuId: ids.SKU_A, quantity: 2, key: 'outage-1' });
  assert.equal(created.status, 201, 'the sale must succeed even with the consumer down');
  assert.equal(await h.available(ids.SKU_A), 28);

  await relayService.publishBatch();
  assert.equal((await h.counts()).ledger, 0);
  const backlog = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state = 'pending'");
  assert.equal(backlog.rows[0].n, 1, 'the event waits in the outbox instead of being lost');

  consumerUp = true;
  await h.pool.query('UPDATE outbox SET next_attempt_at = now()');
  await settle();

  assert.equal((await h.counts()).ledger, 1);
  assert.equal((await h.counts()).published, 1);
});

test('replaying a dead event after a long outage heals the ledger', async () => {
  fake.setHandler(async () => 500);
  await client.createHold({ skuId: ids.SKU_A, quantity: 1, key: 'heal-1' });

  for (let i = 0; i < 6; i += 1) {
    await h.pool.query('UPDATE outbox SET next_attempt_at = now()');
    await relayService.publishBatch();
  }
  assert.equal((await h.counts()).dead, 1);

  fake.setHandler(async (body) => (await consumerService.handleEvent(body)).status);
  const { rows } = await h.pool.query("SELECT id FROM outbox WHERE state = 'dead'");
  const replay = await client.replay(rows[0].id);
  assert.equal(replay.status, 200);

  await settle();
  assert.equal((await h.counts()).ledger, 1);
  assert.equal((await h.counts()).published, 1);
});

test('the reaper crashing mid sweep leaves the system consistent and recoverable', async () => {
  const holdId = await client.createHold({ skuId: ids.SKU_A, quantity: 3, key: 'crash-1' }).then((r) => r.body.hold_id);
  await h.expireHold(holdId);

  await h.pool.query(`
    CREATE OR REPLACE FUNCTION poison_sweep() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'reaper died here'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER poison_sweep_trigger BEFORE INSERT ON outbox
      FOR EACH ROW EXECUTE FUNCTION poison_sweep();
  `);

  try {
    await assert.rejects(() => reaperService.sweepOnce(), /reaper died here/);
  } finally {
    await h.pool.query('DROP TRIGGER poison_sweep_trigger ON outbox');
    await h.pool.query('DROP FUNCTION poison_sweep()');
  }

  assert.equal(await h.available(ids.SKU_A), 27, 'the restore must be rolled back with the event');

  const retry = await reaperService.sweepOnce();
  assert.equal(retry.expired, 1, 'a restarted reaper must finish the job');
  assert.equal(await h.available(ids.SKU_A), 30);
  await h.assertInvariant();
});

test('duplicating every delivery changes nothing', async () => {
  const holdId = await client.createHold({ skuId: ids.SKU_B, quantity: 3, key: 'dupe-1' }).then((r) => r.body.hold_id);
  await client.confirm(holdId);
  await settle();

  const before = await h.counts();

  const { rows } = await h.pool.query('SELECT id FROM outbox WHERE state = $1', ['published']);
  for (const row of rows) {
    await h.pool.query('UPDATE outbox SET state = $1, next_attempt_at = now() WHERE id = $2', [
      'pending',
      row.id,
    ]);
  }
  await settle();

  const after = await h.counts();
  assert.equal(after.ledger, before.ledger, 'the ledger must not grow');
  assert.equal(after.processed, before.processed);
  assert.equal(after.orders, before.orders);
  await h.assertInvariant();
});

test('the whole run ends with nothing stuck in flight', async () => {
  for (let i = 0; i < 5; i += 1) {
    await client.createHold({ skuId: ids.SKU_A, quantity: 1, key: `final-${i}` });
  }
  await settle();

  const stuck = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE state IN ('pending', 'leased')");
  assert.equal(stuck.rows[0].n, 0);
  const stale = await h.pool.query(
    "SELECT count(*)::int AS n FROM holds WHERE state = 'active' AND expires_at <= now()",
  );
  assert.equal(stale.rows[0].n, 0);
  await h.assertInvariant();
});
