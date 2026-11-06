const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSkuParams,
  validateHoldId,
  validateHoldBody,
  validateIdempotencyHeader,
  requestIdMiddleware,
} = require('../../src/middlewares/validate');

function run(middleware, req) {
  let error = null;
  let passed = false;
  const res = { status: () => res, json: () => res, setHeader: () => {} };
  middleware(req, res, (err) => {
    if (err) error = err;
    else passed = true;
  });
  return { error, passed, req };
}

test('validateSkuParams accepts a plain integer id', () => {
  const { error, passed, req } = run(validateSkuParams, { params: { id: '42' } });
  assert.equal(error, null);
  assert.ok(passed);
  assert.equal(req.validatedId, 42);
});

test('validateSkuParams rejects non numeric ids', () => {
  for (const id of ['abc', '1abc', '12.5', '', '-1', '0', ' 1']) {
    const { error, passed } = run(validateSkuParams, { params: { id } });
    assert.equal(passed, false, `id "${id}" must not pass`);
    assert.equal(error.status, 400, `id "${id}" must be a 400`);
    assert.equal(error.code, 'INVALID_SKU_ID');
  }
});

test('validateSkuParams rejects ids beyond safe integer', () => {
  const { error } = run(validateSkuParams, { params: { id: '99999999999999999999' } });
  assert.equal(error.status, 400);
});

test('validateHoldId accepts a uuid and rejects anything else', () => {
  const good = run(validateHoldId, { params: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } });
  assert.equal(good.error, null);
  assert.equal(good.req.holdId, '3f2504e0-4f89-41d3-9a0c-0305e82c3301');

  for (const id of ['abc', '1', '3f2504e0-4f89-41d3-9a0c-0305e82c330', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
    const bad = run(validateHoldId, { params: { id } });
    assert.equal(bad.error.status, 400, `id "${id}" must be a 400`);
    assert.equal(bad.error.code, 'INVALID_HOLD_ID');
  }
});

test('validateHoldBody accepts integers within range', () => {
  for (const quantity of [1, 2, 500, 1000]) {
    const { error, passed } = run(validateHoldBody, { body: { quantity } });
    assert.equal(error, null);
    assert.ok(passed);
  }
});

test('validateHoldBody rejects everything else', () => {
  for (const quantity of [0, -1, 1.5, '2', null, undefined, 1001, NaN]) {
    const { error } = run(validateHoldBody, { body: { quantity } });
    assert.equal(error.status, 400, `quantity ${String(quantity)} must be rejected`);
    assert.equal(error.code, 'INVALID_QUANTITY');
  }
});

test('validateHoldBody survives a missing body', () => {
  const { error } = run(validateHoldBody, {});
  assert.equal(error.status, 400);
});

test('validateIdempotencyHeader requires the header', () => {
  const missing = run(validateIdempotencyHeader, { headers: {} });
  assert.equal(missing.error.status, 400);
  assert.equal(missing.error.code, 'MISSING_IDEMPOTENCY_KEY');
});

test('validateIdempotencyHeader accepts both header spellings', () => {
  const a = run(validateIdempotencyHeader, { headers: { 'x-idempotency-key': 'abc-123' } });
  assert.equal(a.error, null);
  assert.equal(a.req.idempotencyKey, 'abc-123');

  const b = run(validateIdempotencyHeader, { headers: { 'idempotency-key': 'abc-123' } });
  assert.equal(b.error, null);
});

test('validateIdempotencyHeader rejects illegal characters and overlong keys', () => {
  const bad = run(validateIdempotencyHeader, { headers: { 'x-idempotency-key': 'has space' } });
  assert.equal(bad.error.code, 'INVALID_IDEMPOTENCY_KEY');

  const long = run(validateIdempotencyHeader, { headers: { 'x-idempotency-key': 'a'.repeat(300) } });
  assert.equal(long.error.status, 400);
});

test('requestIdMiddleware generates an id and echoes it in the response header', () => {
  const headers = {};
  const req = { headers: {} };
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  requestIdMiddleware(req, res, () => {});
  assert.ok(req.id);
  assert.equal(headers['x-request-id'], req.id);
});

test('requestIdMiddleware honours an incoming request id', () => {
  const req = { headers: { 'x-request-id': 'trace-abc' } };
  const res = { setHeader: () => {} };
  requestIdMiddleware(req, res, () => {});
  assert.equal(req.id, 'trace-abc');
});

test('requestIdMiddleware ignores an absurdly long incoming id', () => {
  const req = { headers: { 'x-request-id': 'a'.repeat(500) } };
  const res = { setHeader: () => {} };
  requestIdMiddleware(req, res, () => {});
  assert.notEqual(req.id, 'a'.repeat(500));
  assert.equal(req.id.length, 36);
});
