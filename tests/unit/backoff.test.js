const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeBackoffMs, nextAttemptSeconds } = require('../../src/utils/backoff');

test('backoff doubles each attempt', () => {
  assert.equal(computeBackoffMs(1, 1000, 60000), 1000);
  assert.equal(computeBackoffMs(2, 1000, 60000), 2000);
  assert.equal(computeBackoffMs(3, 1000, 60000), 4000);
  assert.equal(computeBackoffMs(4, 1000, 60000), 8000);
});

test('backoff is capped at the maximum', () => {
  assert.equal(computeBackoffMs(20, 1000, 60000), 60000);
});

test('backoff never returns less than the base', () => {
  assert.equal(computeBackoffMs(0, 1000, 60000), 1000);
  assert.equal(computeBackoffMs(-5, 1000, 60000), 1000);
  assert.equal(computeBackoffMs(1, 250, 60000), 250);
});

test('backoff handles junk input without NaN', () => {
  assert.ok(Number.isFinite(computeBackoffMs('x', 1000, 60000)));
  assert.ok(Number.isFinite(computeBackoffMs(null, 1000, 60000)));
});

test('nextAttemptSeconds is a whole number of seconds, at least 1', () => {
  assert.equal(nextAttemptSeconds(1, 1000, 60000), 1);
  assert.equal(nextAttemptSeconds(2, 1000, 60000), 2);
  assert.equal(nextAttemptSeconds(1, 50, 60000), 1);
  assert.equal(nextAttemptSeconds(5, 1000, 60000), 16);
});
