const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('../support/helpers');

const projectRoot = path.resolve(__dirname, '../..');
const PROXY_PORT = 8081;

let one;
let two;
let proxy;
let ids;

function spawnNode(script, env) {
  return spawn(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function kill(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}

before(async () => {
  one = spawnNode('server.js', { PORT: '8101' });
  two = spawnNode('server.js', { PORT: '8102' });
  await waitFor('http://127.0.0.1:8101/ready');
  await waitFor('http://127.0.0.1:8102/ready');

  proxy = spawnNode('proxy/server.js', {
    PROXY_PORT: String(PROXY_PORT),
    API_UPSTREAMS: 'http://127.0.0.1:8101,http://127.0.0.1:8102',
    PROXY_CHECK_INTERVAL_MS: '300',
  });
  await waitFor(`http://127.0.0.1:${PROXY_PORT}/proxy/health`);
});

after(async () => {
  await kill(proxy);
  await kill(one);
  await kill(two);
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset({ skuA: 1, skuB: 10, skuC: 10 });
});

function proxyClient() {
  return h.makeClient(`http://127.0.0.1:${PROXY_PORT}`);
}

test('the proxy spreads requests across both instances', async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/`);
    seen.add(res.headers.get('x-upstream'));
  }

  assert.equal(seen.size, 2, 'both instances must serve traffic without sticky sessions');
});

test('the whole race test passes through the proxy', async () => {
  const client = proxyClient();
  const results = await Promise.all(
    Array.from({ length: 40 }, (unused, i) =>
      client.createHold({ skuId: ids.SKU_A, quantity: 1, key: `proxy-race-${i}`, userId: `u${i}` }),
    ),
  );

  const winners = results.filter((r) => r.status === 201);
  assert.equal(winners.length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 39);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
  assert.equal(await h.available(ids.SKU_A), 0);
  await h.assertInvariant();
});

test('idempotent retries through the proxy hit different instances and still return one hold', async () => {
  const client = proxyClient();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => client.createHold({ skuId: ids.SKU_B, quantity: 2, key: 'proxy-idem' })),
  );

  const succeeded = results.filter((r) => r.status === 201);
  const contended = results.filter((r) => r.status === 409 && r.body.error === 'REQUEST_IN_PROGRESS');

  assert.ok(succeeded.length >= 1, 'at least the first request must win');
  assert.equal(succeeded.length + contended.length, results.length, 'nothing else may be returned');
  assert.equal(new Set(succeeded.map((r) => r.body.hold_id)).size, 1, 'all winners share one hold id');
  assert.equal((await h.counts()).holds, 1);
  assert.equal(await h.available(ids.SKU_B), 8);
});

test('a hold created through one instance is readable through the proxy', async () => {
  const client = proxyClient();
  const created = await client.createHold({ skuId: ids.SKU_B, quantity: 1, key: 'proxy-read' });
  const read = await client.getHold(created.body.hold_id);

  assert.equal(read.status, 200);
  assert.equal(read.body.id, created.body.hold_id);
});

test('the proxy stops routing to an instance that dies', async () => {
  await kill(one);

  let recovered = false;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/`);
    if (res.status === 200 && res.headers.get('x-upstream') === 'http://127.0.0.1:8102') {
      recovered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  assert.ok(recovered, 'the proxy must notice the dead instance and use the survivor');

  const client = proxyClient();
  const created = await client.createHold({ skuId: ids.SKU_B, quantity: 1, key: 'after-death' });
  assert.equal(created.status, 201);
});

test('the proxy health endpoint reports what it knows about each instance', async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/proxy/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.upstreams.length, 2);
  assert.ok(body.upstreams.every((u) => typeof u.healthy === 'boolean'));
  assert.ok(body.upstreams.every((u) => typeof u.served === 'number'));
});
