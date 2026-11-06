const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRestorePlan, summariseLag } = require('../../src/utils/reaperPlan');

test('groups rows by sku and sums the quantities', () => {
  const plan = buildRestorePlan([
    { sku_id: 1, quantity: 2 },
    { sku_id: 1, quantity: 3 },
    { sku_id: 2, quantity: 5 },
  ]);
  assert.equal(plan.skuCount, 2);
  assert.equal(plan.totalUnits, 10);
  assert.deepEqual(plan.restores, [
    { sku_id: 1, quantity: 5 },
    { sku_id: 2, quantity: 5 },
  ]);
});

test('restores are sorted by sku id so concurrent workers lock in the same order', () => {
  const plan = buildRestorePlan([
    { sku_id: 9, quantity: 1 },
    { sku_id: 3, quantity: 1 },
    { sku_id: 7, quantity: 1 },
  ]);
  assert.deepEqual(
    plan.restores.map((r) => r.sku_id),
    [3, 7, 9],
  );
});

test('the same rows in a different arrival order produce the same plan', () => {
  const a = buildRestorePlan([
    { sku_id: 2, quantity: 1 },
    { sku_id: 1, quantity: 4 },
  ]);
  const b = buildRestorePlan([
    { sku_id: 1, quantity: 4 },
    { sku_id: 2, quantity: 1 },
  ]);
  assert.deepEqual(a.restores, b.restores);
});

test('an empty batch produces an empty plan', () => {
  const plan = buildRestorePlan([]);
  assert.equal(plan.skuCount, 0);
  assert.equal(plan.totalUnits, 0);
  assert.deepEqual(plan.restores, []);
});

test('summariseLag reports zero for an empty batch', () => {
  assert.deepEqual(summariseLag([]), { maxLagSeconds: 0, avgLagSeconds: 0 });
});

test('summariseLag computes max and average', () => {
  const lag = summariseLag([{ lag_seconds: 1 }, { lag_seconds: 3 }, { lag_seconds: 5 }]);
  assert.equal(lag.maxLagSeconds, 5);
  assert.equal(lag.avgLagSeconds, 3);
});
