const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adminAuthMiddleware, safeEqual } = require('../../src/middlewares/adminAuth');

function run(headers) {
  let error = null;
  let passed = false;
  const res = { status: () => res, json: () => res };
  adminAuthMiddleware({ headers }, res, (err) => {
    if (err) error = err;
    else passed = true;
  });
  return { error, passed };
}

test('safeEqual compares equal strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('safeEqual rejects different strings of equal length', () => {
  assert.equal(safeEqual('abc', 'abd'), false);
});

test('safeEqual rejects different lengths without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('adminAuthMiddleware rejects a missing token with 401', () => {
  const { error, passed } = run({});
  assert.equal(passed, false);
  assert.equal(error.status, 401);
  assert.equal(error.code, 'ADMIN_UNAUTHORIZED');
});

test('adminAuthMiddleware rejects a wrong token with 403', () => {
  const { error, passed } = run({ 'x-admin-token': 'nope' });
  assert.equal(passed, false);
  assert.equal(error.status, 403);
  assert.equal(error.code, 'ADMIN_FORBIDDEN');
});

test('adminAuthMiddleware accepts the configured token', () => {
  const { adminToken } = require('../../src/config/env');
  const { error, passed } = run({ 'x-admin-token': adminToken });
  assert.equal(error, null);
  assert.ok(passed);
});
