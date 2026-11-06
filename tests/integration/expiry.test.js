const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const reaperService = require('../../src/services/reaperService');

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

function makeExpired(skuId, quantity = 1, userId = 'u1') {
  return h
    .createHoldOrThrow(client, { skuId, quantity, key: `exp-${Math.random()}`, userId })
    .then((holdId) => h.expireHold(holdId).then(() => holdId));
}

test('the reaper expires a stale hold, restores the units and writes one event', async () => {
  const holdId = await makeExpired(ids.SKU_A, 3);
  assert.equal(await h.available(ids.SKU_A), 7);

  const result = await reaperService.sweepOnce();

  assert.equal(result.expired, 1);
  assert.equal(result.skus, 1);
  assert.equal(result.unitsRestored, 3);
  assert.equal(await h.holdState(holdId), 'expired');
  assert.equal(await h.available(ids.SKU_A), 10);

  const { rows } = await h.pool.query(
    "SELECT event_type, aggregate_version FROM outbox WHERE aggregate_id = $1 AND event_type = 'HoldExpired'",
    [holdId],
  );
  assert.deepEqual(rows, [{ event_type: 'HoldExpired', aggregate_version: 2 }]);
  await h.assertInvariant();
});

test('a second sweep on the same batch does nothing', async () => {
  await makeExpired(ids.SKU_A, 4);
  const first = await reaperService.sweepOnce();
  const second = await reaperService.sweepOnce();

  assert.equal(first.expired, 1);
  assert.equal(second.expired, 0);
  assert.equal(second.unitsRestored, 0);
  assert.equal(await h.available(ids.SKU_A), 10);
  await h.assertInvariant();
});

test('units are restored exactly once even when two sweeps race', async () => {
  await makeExpired(ids.SKU_A, 5);
  await makeExpired(ids.SKU_B, 2);

  const [a, b] = await Promise.all([reaperService.sweepOnce(), reaperService.sweepOnce()]);

  assert.equal(a.expired + b.expired, 2);
  assert.equal(a.unitsRestored + b.unitsRestored, 7);
  assert.equal(await h.available(ids.SKU_A), 10);
  assert.equal(await h.available(ids.SKU_B), 10);
  await h.assertInvariant();
});

test('a batch never exceeds the requested size and drains across sweeps', async () => {
  for (let i = 0; i < 5; i += 1) await makeExpired(ids.SKU_A, 1);

  const sizes = [];
  for (let i = 0; i < 4; i += 1) {
    sizes.push((await reaperService.sweepOnce({ batchSize: 2 })).expired);
  }

  assert.deepEqual(sizes, [2, 2, 1, 0]);
  assert.equal(await h.available(ids.SKU_A), 10);
  await h.assertInvariant();
});

test('a batch spanning several skus restores each sku by the right amount', async () => {
  await makeExpired(ids.SKU_A, 2);
  await makeExpired(ids.SKU_A, 1);
  await makeExpired(ids.SKU_B, 6);
  await makeExpired(ids.SKU_C, 1);

  const result = await reaperService.sweepOnce();

  assert.equal(result.expired, 4);
  assert.equal(result.skus, 3);
  assert.equal(result.unitsRestored, 10);
  assert.equal(await h.available(ids.SKU_A), 10);
  assert.equal(await h.available(ids.SKU_B), 10);
  assert.equal(await h.available(ids.SKU_C), 1);
  await h.assertInvariant();
});

test('confirmed and cancelled holds are never touched by the reaper', async () => {
  const confirmed = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'c1' });
  const cancelled = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'c2' });
  await client.confirm(confirmed);
  await client.cancel(cancelled);
  await h.pool.query(
    `UPDATE holds
        SET created_at = now() - interval '10 minutes',
            expires_at = now() - interval '5 minutes'
      WHERE id = ANY($1::uuid[])`,
    [[confirmed, cancelled]],
  );

  const result = await reaperService.sweepOnce();

  assert.equal(result.expired, 0);
  assert.equal(await h.holdState(confirmed), 'confirmed');
  assert.equal(await h.holdState(cancelled), 'cancelled');
  assert.equal(await h.available(ids.SKU_A), 9);
  await h.assertInvariant();
});

test('a hold that has not reached its deadline is left alone', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, quantity: 1, key: 'fresh' });

  const result = await reaperService.sweepOnce();

  assert.equal(result.expired, 0);
  assert.equal(await h.holdState(holdId), 'active');
  assert.equal(await h.available(ids.SKU_A), 9);
});

test('a sweep interrupted halfway rolls back everything, stock and state included', async () => {
  await makeExpired(ids.SKU_A, 3);
  await makeExpired(ids.SKU_B, 3);

  await h.pool.query(`
    CREATE OR REPLACE FUNCTION poison_outbox() RETURNS trigger AS $$
    BEGIN
      IF NEW.aggregate_id::uuid = (SELECT id FROM holds WHERE sku_id = ${ids.SKU_A} AND state = 'expired' LIMIT 1) THEN
        RAISE EXCEPTION 'simulated crash while writing the outbox row';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER poison_outbox_trigger BEFORE INSERT ON outbox
      FOR EACH ROW EXECUTE FUNCTION poison_outbox();
  `);

  try {
    await assert.rejects(() => reaperService.sweepOnce(), /simulated crash/);
  } finally {
    await h.pool.query('DROP TRIGGER poison_outbox_trigger ON outbox');
    await h.pool.query('DROP FUNCTION poison_outbox()');
  }

  assert.equal(await h.available(ids.SKU_A), 7, 'stock for A must be unchanged after the rollback');
  assert.equal(await h.available(ids.SKU_B), 7, 'stock for B must be unchanged after the rollback');
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM holds WHERE state = 'expired'");
  assert.equal(rows[0].n, 0, 'no hold may be left half expired');
  const events = await h.pool.query("SELECT count(*)::int AS n FROM outbox WHERE event_type = 'HoldExpired'");
  assert.equal(events.rows[0].n, 0, 'no expiry event may survive the rollback');
  await h.assertInvariant();
});

test('the sweep reports how late it was', async () => {
  const holdId = await makeExpired(ids.SKU_A, 1);
  await h.pool.query(
    `UPDATE holds SET expires_at = now() - interval '30 seconds' WHERE id = $1`,
    [holdId],
  );

  const result = await reaperService.sweepOnce();

  assert.ok(result.maxLagSeconds >= 29, `expected lag of at least 29s, got ${result.maxLagSeconds}`);
  assert.ok(result.durationSeconds >= 0);
});

test('an empty sweep is cheap and reports zero', async () => {
  const result = await reaperService.sweepOnce();
  assert.deepEqual(
    { expired: result.expired, skus: result.skus, unitsRestored: result.unitsRestored },
    { expired: 0, skus: 0, unitsRestored: 0 },
  );
});
