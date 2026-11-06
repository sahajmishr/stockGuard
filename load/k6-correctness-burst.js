import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8001';
const SKU_ID = Number(__ENV.SKU_ID || 1);
const VUS = Number(__ENV.VUS || 100);

const winners = new Counter('stockguard_winners');
const soldOut = new Counter('stockguard_sold_out');
const unexpected = new Counter('stockguard_unexpected_status');

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: VUS,
      maxDuration: '60s',
    },
  },
  thresholds: {
    'stockguard_unexpected_status': ['count==0'],
    'http_req_failed': ['rate==0'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const payload = JSON.stringify({ quantity: 1 });
  const params = {
    headers: {
      'content-type': 'application/json',
      'x-user-id': `k6-${__VU}-${__ITER}`,
      'x-idempotency-key': `burst-${__VU}-${__ITER}-${Date.now()}`,
    },
    tags: { name: 'POST /skus/:id/holds' },
  };

  const res = http.post(`${BASE_URL}/skus/${SKU_ID}/holds`, payload, params);

  if (res.status === 201) winners.add(1);
  else if (res.status === 409) soldOut.add(1);
  else unexpected.add(1);

  check(res, {
    'answer is 201 or 409': (r) => r.status === 201 || r.status === 409,
    'never a 500': (r) => r.status < 500,
    'body is json': (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
  });
}

export function handleSummary(data) {
  const w = data.metrics.stockguard_winners ? data.metrics.stockguard_winners.values.count : 0;
  const s = data.metrics.stockguard_sold_out ? data.metrics.stockguard_sold_out.values.count : 0;
  const u = data.metrics.stockguard_unexpected_status ? data.metrics.stockguard_unexpected_status.values.count : 0;
  console.log(`winners=${w} sold_out=${s} unexpected=${u} expected_winners=1`);
  return {
    stdout: `\nwinners=${w} sold_out=${s} unexpected_status=${u}\n`,
    [`evidence/burst-${Date.now()}.json`]: JSON.stringify(data, null, 2),
  };
}
