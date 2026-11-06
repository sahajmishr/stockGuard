const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const spawnHelper = require('../support/spawn');

let one;
let two;
let ids;

before(async () => {
  one = await spawnHelper.start({ script: 'server.js', port: 8101 });
  two = await spawnHelper.start({ script: 'server.js', port: 8102 });
});

after(async () => {
  await one.stop();
  await two.stop();
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset({ skuA: 1, skuB: 10, skuC: 10 });
});

function clientOn(instance) {
  return h.makeClient(instance.base);
}

test('both instances report themselves as ready', async () => {
  for (const instance of [one, two]) {
    const res = await fetch(`${instance.base}/ready`);
    assert.equal(res.status, 200);
  }
});

test('two instances each carry their own instance id', async () => {
  const a = await (await fetch(`${one.base}/`)).json();
  const b = await (await fetch(`${two.base}/`)).json();
  assert.ok(a.instance);
  assert.ok(b.instance);
  assert.notEqual(a.instance, b.instance);
});

test('fifty buyers racing for one unit through two instances produce one winner', async () => {
  const clients = [clientOn(one), clientOn(two)];
  const results = await Promise.all(
    Array.from({ length: 50 }, (unused, i) =>
      clients[i % 2].createHold({ skuId: ids.SKU_A, quantity: 1, key: `race-${i}`, userId: `u${i}` }),
    ),
  );

  const winners = results.filter((r) => r.status === 201);
  const losers = results.filter((r) => r.status === 409 && r.body.error === 'INSUFFICIENT_STOCK');

  assert.equal(winners.length, 1, 'exactly one buyer may win the last unit');
  assert.equal(losers.length, 49);
  assert.equal(results.filter((r) => r.status >= 500).length, 0, 'no request may end in a 500');
  assert.equal(await h.available(ids.SKU_A), 0);
  await h.assertInvariant();
});

test('nothing was oversold even though the two instances never talked to each other', async () => {
  const clients = [clientOn(one), clientOn(two)];
  await Promise.all(
    Array.from({ length: 20 }, (unused, i) =>
      clients[i % 2].createHold({ skuId: ids.SKU_A, quantity: 1, key: `over-${i}`, userId: `u${i}` }),
    ),
  );

  const { rows } = await h.pool.query(
    `SELECT s.total_units, s.available_units,
            coalesce(sum(h.quantity) FILTER (WHERE h.state = 'active'), 0) AS held
       FROM skus s LEFT JOIN holds h ON h.sku_id = s.id
      WHERE s.id = $1 GROUP BY s.id`,
    [ids.SKU_A],
  );
  assert.equal(Number(rows[0].available_units) + Number(rows[0].held), Number(rows[0].total_units));
});

test('one idempotency key used on both instances creates one hold', async () => {
  const a = await clientOn(one).createHold({ skuId: ids.SKU_B, quantity: 2, key: 'cross-instance' });
  const b = await clientOn(two).createHold({ skuId: ids.SKU_B, quantity: 2, key: 'cross-instance' });

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.hold_id, b.body.hold_id);
  assert.equal((await h.counts()).holds, 1);
  assert.equal(await h.available(ids.SKU_B), 8);
});

test('a hold created on one instance is visible on the other', async () => {
  const created = await clientOn(one).createHold({ skuId: ids.SKU_B, quantity: 1, key: 'visible' });
  const seen = await clientOn(two).getHold(created.body.hold_id);

  assert.equal(seen.status, 200);
  assert.equal(seen.body.id, created.body.hold_id);
});

test('confirming on one instance after creating on the other works once', async () => {
  const created = await clientOn(one).createHold({ skuId: ids.SKU_B, quantity: 1, key: 'handover' });
  const confirmed = await clientOn(two).confirm(created.body.hold_id);
  const again = await clientOn(one).confirm(created.body.hold_id);

  assert.equal(confirmed.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, confirmed.body.id);
  assert.equal((await h.counts()).orders, 1);
});

test('two reaper processes sweeping at once expire each hold exactly once', async () => {
  ids = await h.reset({ skuA: 1, skuB: 20, skuC: 10 });
  for (let i = 0; i < 20; i += 1) {
    const holdId = await h.createHoldOrThrow(clientOn(one), { skuId: ids.SKU_B, quantity: 1, key: `exp-${i}` });
    await h.expireHold(holdId);
  }
  assert.equal(await h.available(ids.SKU_B), 0);

  const [a, b] = await Promise.all([
    spawnHelper.runToCompletion({ script: 'scripts/reap-once.js', env: { REAPER_BATCH_SIZE: '50' } }),
    spawnHelper.runToCompletion({ script: 'scripts/reap-once.js', env: { REAPER_BATCH_SIZE: '50' } }),
  ]);

  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);

  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM holds WHERE state = 'expired'");
  assert.equal(rows[0].n, 20);
  assert.equal(await h.available(ids.SKU_B), 20, 'every unit must come back exactly once');
  await h.assertInvariant();
});

test('two relay processes delivering at once publish each event once', async () => {
  for (let i = 0; i < 10; i += 1) {
    await h.createHoldOrThrow(clientOn(one), { skuId: ids.SKU_B, quantity: 1, key: `rel-${i}` });
  }

  const [a, b] = await Promise.all([
    spawnHelper.runToCompletion({ script: 'scripts/relay-once.js' }),
    spawnHelper.runToCompletion({ script: 'scripts/relay-once.js' }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);

  const { rows } = await h.pool.query("SELECT state, count(*)::int AS n FROM outbox GROUP BY state");
  const byState = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  assert.equal(byState.published, 10);
  assert.equal(byState.pending ?? 0, 0, 'no event may be left behind');
  assert.equal(byState.leased ?? 0, 0, 'no lease may be left dangling');
});
