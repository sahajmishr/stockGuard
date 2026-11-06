const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../support/helpers');
const reaperService = require('../../src/services/reaperService');
const metrics = require('../../src/config/metrics');

let api;
let client;
let ids;

before(async () => {
  const started = await h.listen();
  api = started.server;
  client = h.makeClient(started.baseUrl);
});

after(async () => {
  await h.close(api);
  await h.pool.end();
});

beforeEach(async () => {
  ids = await h.reset();
});

function clientBase() {
  return api.address() ? `http://127.0.0.1:${api.address().port}` : '';
}

test('every metric the roadmap asks for is exported', async () => {
  const text = await (await fetch(`${clientBase()}/metrics`)).text();

  const required = [
    'stockguard_http_requests_total',
    'http_request_duration_seconds',
    'stockguard_holds_created_total',
    'stockguard_holds_confirmed_total',
    'stockguard_holds_cancelled_total',
    'stockguard_holds_expired_total',
    'stockguard_reaper_batch_size',
    'stockguard_reaper_sweep_duration_seconds',
    'stockguard_expiry_lag_seconds',
    'stockguard_outbox_backlog',
    'stockguard_relay_delivered_total',
    'stockguard_relay_failed_total',
    'stockguard_relay_dead_total',
    'stockguard_db_pool_clients',
  ];

  for (const name of required) {
    assert.ok(text.includes(name), `missing metric ${name}`);
  }
});

test('request counters move when requests happen', async () => {
  const before = Number(
    (await (await fetch(`${clientBase()}/metrics`)).text()).match(
      /stockguard_http_requests_total\{method="POST",route="\/skus\/:id\/holds",status="201"\} (\d+)/,
    )?.[1] ?? 0,
  );

  await client.createHold({ skuId: ids.SKU_A, key: 'obs-1' });

  const after = Number(
    (await (await fetch(`${clientBase()}/metrics`)).text()).match(
      /stockguard_http_requests_total\{method="POST",route="\/skus\/:id\/holds",status="201"\} (\d+)/,
    )?.[1] ?? 0,
  );

  assert.equal(after, before + 1);
});

test('the route label is the pattern, never the raw url', async () => {
  await client.createHold({ skuId: ids.SKU_A, key: 'obs-2' });
  const text = await (await fetch(`${clientBase()}/metrics`)).text();

  const routeLabels = [...text.matchAll(/route="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(routeLabels.length > 0);
  for (const route of routeLabels) {
    assert.ok(!/\d{2,}/.test(route), `route label "${route}" looks like a raw url and would explode cardinality`);
    assert.ok(!route.includes('0000-0000'), `route label "${route}" contains an id`);
  }
});

test('a business outcome counter moves once per business event', async () => {
  const read = async () => {
    const text = await (await fetch(`${clientBase()}/metrics`)).text();
    return Number(text.match(/stockguard_holds_expired_total (\d+)/)?.[1] ?? 0);
  };

  const before = await read();
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'obs-3' });
  await h.expireHold(holdId);
  await reaperService.sweepOnce();

  assert.equal(await read(), before + 1);
});

test('the reaper exports how long a sweep took and how late it ran', async () => {
  const holdId = await h.createHoldOrThrow(client, { skuId: ids.SKU_A, key: 'obs-4' });
  await h.pool.query(
    `UPDATE holds
        SET created_at = now() - interval '10 minutes',
            expires_at = now() - interval '45 seconds'
      WHERE id = $1`,
    [holdId],
  );

  await reaperService.sweepOnce();

  const text = await (await fetch(`${clientBase()}/metrics`)).text();
  assert.match(text, /stockguard_reaper_batch_size_count \d+/);
  assert.match(text, /stockguard_reaper_sweep_duration_seconds_sum [\d.e-]+/);
  assert.match(text, /stockguard_expiry_lag_seconds_\w+ [\d.e-]+/);
});

test('the outbox backlog gauge reflects the queue', async () => {
  await client.createHold({ skuId: ids.SKU_A, key: 'obs-5' });
  await client.createHold({ skuId: ids.SKU_A, key: 'obs-6' });
  await client.outbox();

  const text = await (await fetch(`${clientBase()}/metrics`)).text();
  const backlog = Number(text.match(/stockguard_outbox_backlog (\d+)/)?.[1]);
  assert.equal(backlog, 2);
});

test('the pool gauge reports idle and waiting clients', async () => {
  const text = await (await fetch(`${clientBase()}/metrics`)).text();
  assert.match(text, /stockguard_db_pool_clients\{state="idle"\} \d+/);
  assert.match(text, /stockguard_db_pool_clients\{state="waiting"\} \d+/);
});

test('logs are single line json with a timestamp and a level', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    await client.createHold({ skuId: ids.SKU_A, key: 'obs-7' });
  } finally {
    console.log = original;
  }

  const parsed = lines.filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
  assert.ok(parsed.length > 0, 'the api must log something for a request');
  for (const line of parsed) {
    assert.ok(line.ts, 'every log line needs a timestamp');
    assert.ok(line.level);
    assert.ok(line.msg);
  }
});

test('health and ready answer without touching the business tables', async () => {
  const health = await fetch(`${clientBase()}/health`);
  const ready = await fetch(`${clientBase()}/ready`);

  assert.equal(health.status, 200);
  assert.equal(ready.status, 200);
});

test('the metrics registry does not leak the database password', async () => {
  const text = await (await fetch(`${clientBase()}/metrics`)).text();
  assert.ok(!text.includes('postgres:postgres'));
  assert.ok(!text.includes('PGPASSWORD'));
});
