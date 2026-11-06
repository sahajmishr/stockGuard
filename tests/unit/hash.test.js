const { test } = require('node:test');
const assert = require('node:assert/strict');
const computeCanonicalHash = require('../../src/utils/hash');

test('same payload produces the same hash', () => {
  const a = computeCanonicalHash({ sku_id: 1, quantity: 2 });
  const b = computeCanonicalHash({ sku_id: 1, quantity: 2 });
  assert.equal(a, b);
});

test('hash ignores key order of the input object', () => {
  const a = computeCanonicalHash({ quantity: 2, sku_id: 1 });
  const b = computeCanonicalHash({ sku_id: 1, quantity: 2 });
  assert.equal(a, b);
});

test('hash treats numeric strings and numbers as equal', () => {
  const a = computeCanonicalHash({ sku_id: '1', quantity: '2' });
  const b = computeCanonicalHash({ sku_id: 1, quantity: 2 });
  assert.equal(a, b);
});

test('a different quantity changes the hash', () => {
  const a = computeCanonicalHash({ sku_id: 1, quantity: 1 });
  const b = computeCanonicalHash({ sku_id: 1, quantity: 2 });
  assert.notEqual(a, b);
});

test('a different sku changes the hash', () => {
  const a = computeCanonicalHash({ sku_id: 1, quantity: 1 });
  const b = computeCanonicalHash({ sku_id: 2, quantity: 1 });
  assert.notEqual(a, b);
});

test('hash is a 64 character hex string', () => {
  const h = computeCanonicalHash({ sku_id: 1, quantity: 1 });
  assert.match(h, /^[0-9a-f]{64}$/);
});
