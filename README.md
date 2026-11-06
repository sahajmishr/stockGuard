# StockGuard

Concurrency-safe inventory reservation on Node.js and PostgreSQL: holds that expire on their own, confirm
and cancel that cannot double-apply, an idempotent API, and a transactional outbox that survives a worker
being killed mid-delivery.

**The invariant everything serves:** for every SKU, `available_units + sum(active holds) + sum(confirmed holds) = total_units`,
always, under any concurrency, at any moment. `npm run check` fails if it ever is not true.

## What it does

1. A buyer puts a 5-minute hold on N units. Stock is decremented in the same transaction that creates the hold.
2. The buyer confirms and gets an order, or cancels and the units come back, or does nothing and the reaper
   takes them back when the timer runs out.
3. Every state change writes an event to an outbox table, in the same transaction as the change. A relay
   delivers those events to a consumer over HTTP. The consumer deduplicates, so redelivery is harmless.
4. Any of those steps can be retried with the same idempotency key and produces the same answer.

## Architecture

```
                     +-------------------+
   client  ------->  |  proxy  :8080     |   round-robin, passive health checks
                     +---------+---------+
                          |         |
                   +------v--+   +--v------+
                   | api :8001|  | api :8002|      stateless, no shared memory
                   +------+---+   +---+-----+
                          |           |
                          +-----+-----+
                                |
                        +-------v--------+
                        |   PostgreSQL   |   the only source of truth
                        +---+--------+---+
                            |        |
              +-------------v--+   +-v---------------+
              | reaper (worker)|  | relay (worker)  |     separate processes,
              | claims expired |  | claims outbox   |     exactly one of each
              | holds with     |  | rows with       |
              | SKIP LOCKED    |  | SKIP LOCKED     |
              +----------------+  +--------+--------+
                                           |  HTTP POST /events
                                  +--------v---------+
                                  | consumer  :4001  |   processed_events dedupe
                                  +------------------+
```

Every arrow is a process boundary. Nothing important lives in a process: kill any box and restart it, and
the system continues from the database.

## Quickstart

Needs Node 20+ and a running PostgreSQL 14+.

```powershell
npm install
copy .env.example .env      # then set DB_PASSWORD
npm run migrate
npm run seed
npm run check
```

Four terminals (or four PowerShell tabs):

```powershell
npm run start                       # api on 8001
npm run worker:reaper               # reclaims expired holds
npm run worker:relay                # delivers outbox events
npm run consumer                    # receives them on 4001
```

Try it:

```powershell
curl.exe -s http://127.0.0.1:8001/skus/1
curl.exe -s -X POST http://127.0.0.1:8001/skus/1/holds -H "content-type: application/json" -H "x-user-id: alice" -H "x-idempotency-key: demo-1" -d '{\"quantity\":2}'
curl.exe -s http://127.0.0.1:8001/holds/<hold_id> -H "x-user-id: alice"
curl.exe -s -X POST http://127.0.0.1:8001/holds/<hold_id>/confirm -H "x-user-id: alice"
curl.exe -s http://127.0.0.1:8001/admin/outbox -H "x-admin-token: dev-admin-token"
```

Two instances behind a proxy:

```powershell
$env:PORT="8001"; node server.js
$env:PORT="8002"; $env:INSTANCE_ID="api-b"; node server.js
$env:API_UPSTREAMS="http://127.0.0.1:8001,http://127.0.0.1:8002"; node proxy/server.js
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | name, version, instance id |
| GET | `/health` | liveness, no database involved |
| GET | `/ready` | 200 only when the database answers |
| GET | `/metrics` | Prometheus text format |
| GET | `/skus/:id` | stock for one SKU |
| POST | `/skus/:id/holds` | needs `x-user-id` and `x-idempotency-key` |
| GET | `/holds/:id` | owner only; anyone else gets 404, not 403 |
| POST | `/holds/:id/confirm` | 201 with the order, 200 if already confirmed |
| POST | `/holds/:id/cancel` | 200, idempotent |
| GET | `/admin/outbox` | needs `x-admin-token`: backlog, by state, dead events |
| POST | `/admin/outbox/:id/replay` | puts a dead event back in the queue |

The two different `409`s, and why the difference matters:

- `INSUFFICIENT_STOCK` - a business outcome. The request was valid, there was nothing to sell. Committed,
  not rolled back, and it is idempotent: retrying with the same key returns the same refusal.
- `IDEMPOTENCY_KEY_REUSE_VIOLATION` - you reused a key with a different body. That is a client bug, and
  the stored response belongs to a different request.

A third, `REQUEST_IN_PROGRESS`, appears when two requests with the same key arrive close enough together
that one is still holding the advisory lock. It is a retry hint, not a failure.

## Test layers

Three layers, 168 tests, all executed before delivery.

| Layer | Command | What it proves |
|---|---|---|
| unit | `npm test` | pure functions and middleware: hashing, backoff, reaper planning, validation, auth, error mapping |
| integration | `npm run test:integration` | real Postgres, real HTTP: idempotency, the hold state machine, expiry, outbox, relay, consumer, admin, observability, two processes |
| suites | `npm run test:suites` | the system end to end: full journeys, chaos, recovery, proxy |

```powershell
npm run test:all
```

| File | Tests | Focus |
|---|---|---|
| `tests/unit/hash.test.js` | 6 | canonical request hashing |
| `tests/unit/backoff.test.js` | 5 | retry schedule |
| `tests/unit/reaperPlan.test.js` | 6 | restore grouping and lag |
| `tests/unit/validate.test.js` | 14 | input validation and request ids |
| `tests/unit/adminAuth.test.js` | 6 | token comparison |
| `tests/unit/errorHandler.test.js` | 8 | one error shape, no leaked 500 messages |
| `tests/integration/holdstate.test.js` | 21 | create, confirm, cancel, ownership, races |
| `tests/integration/idempotency.test.js` | 11 | replay, reuse, concurrent retries |
| `tests/integration/expiry.test.js` | 10 | reaper single-restore, batch limits, rollback |
| `tests/integration/outbox.test.js` | 9 | events written in the same transaction |
| `tests/integration/relay.test.js` | 13 | delivery, backoff, dead letters, leases, crash windows |
| `tests/integration/consumer.test.js` | 13 | dedupe, concurrent duplicates, payload rejection |
| `tests/integration/admin.test.js` | 9 | auth, overview, replay, replay safety |
| `tests/integration/failure-injection.test.js` | 7 | injected database failures leave nothing half-written |
| `tests/integration/multiinstance.test.js` | 9 | two OS processes, one database, two reapers, two relays |
| `tests/integration/observability.test.js` | 10 | metrics present, counters move, no ids in labels, JSON logs |
| `tests/suites/system.test.js` | 9 | full journeys, mixed load, outage and healing |
| `tests/suites/recovery.test.js` | 3 | worker killed mid-delivery, consumer outage |
| `tests/suites/proxy.test.js` | 6 | the race through the front door, instance death |

Integration tests truncate between cases, so they must not run in parallel:
`--test-concurrency=1` is in the scripts and should stay there.

## Load tests

`load/race-test.js` (no install, exits non-zero on oversell) and two k6 scripts.

```powershell
node scripts/seed.js
npm run race
node scripts/check-invariants.js
```

See `load/README.md` and `docs/23-benchmark.md`.

Measured on this machine, 100 buyers racing for 1 unit through the API: **1 winner, 99 sold-out, zero
5xx, accounting balanced, invariant OK** - about 0.35 s wall clock for the batch on 2 cores with the pool
at 10. That is a correctness number, not a capacity number. The capacity ladder is Day 23 and its table is
in `docs/23-benchmark.md`, deliberately unfilled until you run it.

## Days 14 to 23, and where each one lives

| Day | Thing | Code | Proof |
|---|---|---|---|
| 14 | Hold expiry via a worker that claims in batches | `src/worker/reaper.js`, `holdRepository.claimExpiredBatch` | `expiry.test.js` |
| 15 | Expiry restores stock exactly once, in one transaction | `reaperService.sweepOnce` | `expiry.test.js` (two sweeps racing, poisoned outbox rollback) |
| 16 | Transactional outbox | `outboxRepository`, `sql/migrations/002` | `outbox.test.js` |
| 17 | Relay with leases, backoff and dead letters | `src/worker/relay.js`, `relayService` | `relay.test.js`, `recovery.test.js` |
| 18 | Idempotent consumer | `consumerService`, `processed_events` | `consumer.test.js` |
| 19 | Admin surface: overview and replay | `adminService`, `adminAuth` | `admin.test.js` |
| 20 | Two instances, a proxy, zero shared state | `proxy/server.js`, `src/config/env.js` | `multiinstance.test.js`, `proxy.test.js`, `docs/20-multi-instance.md` |
| 21 | Reproducible packaging | `Dockerfile`, `compose.yaml`, `.dockerignore` | `docs/21-docker.md` |
| 22 | Structured logs, metrics, alerts, runbook | `src/config/logger.js`, `src/config/metrics.js`, `observability/` | `observability.test.js`, `docs/22-observability.md`, `docs/runbook.md` |
| 23 | Honest measurement | `load/` | `docs/23-benchmark.md` |

## Migrations

Numbered files in `sql/migrations/`, applied in filename order, recorded in `schema_migrations`. Never edit
an applied file, never run SQL by hand in pgAdmin - add `005_something.sql`.

| File | What it adds |
|---|---|
| `001_init.sql` | skus, holds, orders, idempotency_keys, the state enum |
| `002_worker_support.sql` | outbox, processed_events, consumer_ledger, indexes |
| `003_outbox_lease_owner.sql` | lease ownership and delivery ordering |
| `004_order_settlement.sql` | sku, quantity and owner on orders, so an order is auditable |

## Limitations, stated plainly

- **Authentication is a header.** `x-user-id` and `x-admin-token` are demo stand-ins. There is no session,
  no signature, no rotation.
- **Delivery is at-least-once, not exactly once.** The relay can send twice (a crash between send and
  acknowledge). The consumer deduplicates, so the *effect* is once, but the word "exactly-once" would be
  a lie and is not used here.
- **No global ordering across aggregates.** Events per hold are ordered by aggregate version; across holds
  there is no total order.
- **Expiry is best-effort.** A hold can be minutes past its deadline if the reaper is down. The database
  clock decides, not the app clock, so the state is never wrong - only late.
- **Idempotency keys never expire.** The table grows forever. A TTL job is the obvious next step.
- **Single machine.** Two instances on one laptop prove multi-instance *safety*, not distribution. No
  measurement here says anything about a network partition.
- **`compose.yaml` is untested in this delivery.** It was written and reviewed in an environment without a
  Docker daemon. Verify it before you claim it works.
- **The benchmark table is empty on purpose.** Filling it with numbers nobody ran would defeat the point.

## Docs

| File | Contents |
|---|---|
| `docs/20-multi-instance.md` | proxy, state inventory, pool arithmetic |
| `docs/21-docker.md` | exact Windows install, WSL2 caps, the 5433 rule, the honest fallback |
| `docs/22-observability.md` | logs, every metric, the Prometheus/Grafana decision, all three install paths |
| `docs/runbook.md` | three debugging recipes and a 60-second triage |
| `docs/23-benchmark.md` | k6 install, both test shapes, the empty tables, how to fill them |
| `load/README.md` | the run commands |
