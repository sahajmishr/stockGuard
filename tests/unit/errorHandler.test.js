const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler, httpError } = require('../../src/middlewares/errorHandler');

function capture(err, { headersSent = false } = {}) {
  const out = { status: null, body: null };
  const res = {
    headersSent,
    status(code) {
      out.status = code;
      return res;
    },
    json(body) {
      out.body = body;
      return res;
    },
  };
  let forwarded = null;
  errorHandler(err, { id: 'req-1', method: 'GET', originalUrl: '/x' }, res, (e) => {
    forwarded = e;
  });
  return { out, forwarded };
}

test('httpError builds a status, a code and a message', () => {
  const err = httpError(409, 'INSUFFICIENT_STOCK', 'nope');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'INSUFFICIENT_STOCK');
  assert.equal(err.message, 'nope');
});

test('a thrown httpError keeps its status and code', () => {
  const { out } = capture(httpError(404, 'SKU_NOT_FOUND', 'no such sku'));
  assert.equal(out.status, 404);
  assert.equal(out.body.error, 'SKU_NOT_FOUND');
  assert.equal(out.body.message, 'no such sku');
  assert.equal(out.body.requestId, 'req-1');
});

test('postgres 22P02 becomes a 400 instead of a 500', () => {
  const err = new Error('invalid input syntax for type integer');
  err.code = '22P02';
  const { out } = capture(err);
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'INVALID_INPUT');
});

test('postgres 23505 becomes a 409', () => {
  const err = new Error('duplicate key value violates unique constraint');
  err.code = '23505';
  const { out } = capture(err);
  assert.equal(out.status, 409);
});

test('postgres 57014 becomes a 503', () => {
  const err = new Error('canceling statement due to statement timeout');
  err.code = '57014';
  const { out } = capture(err);
  assert.equal(out.status, 503);
});

test('a malformed JSON body becomes a 400 with INVALID_JSON', () => {
  const err = new SyntaxError('Unexpected token');
  err.type = 'entity.parse.failed';
  err.status = 400;
  const { out } = capture(err);
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'INVALID_JSON');
});

test('an unknown error becomes a 500 and never leaks its message or stack', () => {
  const err = new Error('connection string password=hunter2 exploded');
  const { out } = capture(err);
  assert.equal(out.status, 500);
  assert.equal(out.body.error, 'INTERNAL_ERROR');
  assert.equal(out.body.message, 'internal error');
  assert.ok(!JSON.stringify(out.body).includes('hunter2'));
  assert.equal(out.body.stack, undefined);
});

test('a response that already started is forwarded instead of rewritten', () => {
  const err = new Error('late failure');
  const { forwarded, out } = capture(err, { headersSent: true });
  assert.equal(forwarded, err);
  assert.equal(out.status, null);
});
