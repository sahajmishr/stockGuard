import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8001';
const MODE = __ENV.MODE || 'hot';
const SKU_COUNT = Number(__ENV.SKU_COUNT || 20);
const STAGES = (__ENV.STAGES || '10,25,50,100,250').split(',').map(Number);
const STAGE_SECONDS = Number(__ENV.STAGE_SECONDS || 60);
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 50);
const MAX_VUS = Number(__ENV.MAX_VUS || 400);

const winners = new Counter('stockguard_winners');
const soldOut = new Counter('stockguard_sold_out');
const unexpected = new Counter('stockguard_unexpected_status');
const winnerLatency = new Trend('stockguard_winner_latency', true);
const rejectedLatency = new Trend('stockguard_rejected_latency', true);

const scenarioName = `sustained_${MODE}`;

function randomIntBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const options = {
  scenarios: {
    [scenarioName]: {
      executor: 'ramping-arrival-rate',
      startRate: STAGES[0],
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: STAGES.map((rate) => ({ target: rate, duration: `${STAGE_SECONDS}s` })),
    },
  },
  thresholds: {
    'http_req_duration{expected_response:true}': ['p(95)<200'],
    'stockguard_unexpected_status': ['count==0'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const skuId = MODE === 'hot' ? 1 : randomIntBetween(1, SKU_COUNT);
  const payload = JSON.stringify({ quantity: 1 });
  const params = {
    headers: {
      'content-type': 'application/json',
      'x-user-id': `k6-${__VU}-${__ITER}`,
      'x-idempotency-key': `sustained-${MODE}-${__VU}-${__ITER}-${Date.now()}`,
    },
    tags: { name: 'POST /skus/:id/holds', sku_mode: MODE },
  };

  const res = http.post(`${BASE_URL}/skus/${skuId}/holds`, payload, params);

  if (res.status === 201) {
    winners.add(1);
    winnerLatency.add(res.timings.duration);
  } else if (res.status === 409) {
    soldOut.add(1);
    rejectedLatency.add(res.timings.duration);
  } else {
    unexpected.add(1);
  }

  check(res, {
    'answer is 201 or 409': (r) => r.status === 201 || r.status === 409,
    'never a 500': (r) => r.status < 500,
  });
}

export function handleSummary(data) {
  const metric = (name, kind) => {
    const m = data.metrics[name];
    if (!m) return 0;
    return kind === 'count' ? m.values.count : m.values[kind] || 0;
  };
  const line = {
    mode: MODE,
    stages: STAGES,
    stage_seconds: STAGE_SECONDS,
    completed_iterations: metric('iterations', 'count'),
    winners: metric('stockguard_winners', 'count'),
    sold_out: metric('stockguard_sold_out', 'count'),
    unexpected_status: metric('stockguard_unexpected_status', 'count'),
    dropped_iterations: metric('dropped_iterations', 'count'),
    p50_all: metric('http_req_duration', 'med'),
    p95_all: metric('http_req_duration', 'p(95)'),
    p99_all: metric('http_req_duration', 'p(99)'),
    p95_winners: metric('stockguard_winner_latency', 'p(95)'),
    p95_rejected: metric('stockguard_rejected_latency', 'p(95)'),
  };
  console.log(JSON.stringify(line));
  return {
    stdout: `\n${JSON.stringify(line, null, 2)}\n`,
    [`evidence/sustained-${MODE}-${Date.now()}.json`]: JSON.stringify(data, null, 2),
  };
}
