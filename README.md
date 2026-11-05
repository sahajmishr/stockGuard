# StockGuard — concurrency-safe inventory reservation API

Flash-sale inventory reservations backed by PostgreSQL. A hold reserves units for a
configurable TTL; units are never oversold, even under concurrent requests or a process crash.

**Status: Day 6 of 24.** Everything below is verified by the test scripts in `tests/`.

| Capability | State |
|---|---|
| `GET /skus/:id` | ✅ |
| `POST /skus/:id/holds` — conditional-update reservation, DB-clock expiry | ✅ |
| Accounting invariant checker (`npm run check`) | ✅ |
| Idempotent retries (`Idempotency-Key`) | 🚧 Day 8–9 |
| Confirm / cancel, orders | 🚧 Day 11 |
| Expiry reaper (units currently return only on manual intervention) | 🚧 Day 14 |
| Transactional outbox + duplicate-safe consumer | 🚧 Day 16–18 |
| Second API instance behind a proxy | 🚧 Day 20 |

## The invariant

For every SKU: `available_units + (units in active holds) + (units in confirmed holds) = total_units`.

`available_units` is a cache of that subtraction, so it can drift from reality. `npm run check`
computes the drift and exits non-zero if it is ever non-zero. Every test run ends here.

## Quickstart

    npm install
    cp .env.example .env      # fill in DB_* for your local Postgres
    npm run migrate
    npm start                 # http://localhost:8001

    npm run check             # accounting invariant
    npm run race              # correctness burst: N requests, 1 unit

## Known limitations

- `x-user-id` header is a demo stand-in for authentication. There is no real auth.
- Holds expire logically at `expires_at`, but their units are only returned once the reaper
  runs (Day 14). Until then an expired hold still occupies its stock.
- Single machine, single Postgres instance. No performance claims are made yet.