const client = require('prom-client');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'stockguard_' });

const httpRequestsTotal = new client.Counter({
  name: 'stockguard_http_requests_total',
  help: 'HTTP requests by route and status',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: 'stockguard_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [registry],
});

const holdsCreated = new client.Counter({
  name: 'stockguard_holds_created_total',
  help: 'Holds successfully created',
  registers: [registry],
});

const holdsConfirmed = new client.Counter({
  name: 'stockguard_holds_confirmed_total',
  help: 'Holds confirmed',
  registers: [registry],
});

const holdsCancelled = new client.Counter({
  name: 'stockguard_holds_cancelled_total',
  help: 'Holds cancelled',
  registers: [registry],
});

const holdsExpired = new client.Counter({
  name: 'stockguard_holds_expired_total',
  help: 'Holds expired by the reaper',
  registers: [registry],
});

const reaperBatchSize = new client.Histogram({
  name: 'stockguard_reaper_batch_size',
  help: 'Rows transitioned per sweep',
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

const reaperSweepDuration = new client.Histogram({
  name: 'stockguard_reaper_sweep_duration_seconds',
  help: 'Duration of one sweep',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [registry],
});

const expiryLag = new client.Histogram({
  name: 'stockguard_expiry_lag_seconds',
  help: 'Seconds between expires_at and actual reaping',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
  registers: [registry],
});

const outboxBacklog = new client.Gauge({
  name: 'stockguard_outbox_backlog',
  help: 'Outbox rows waiting to be published',
  registers: [registry],
});

const relayDelivered = new client.Counter({
  name: 'stockguard_relay_delivered_total',
  help: 'Events delivered successfully',
  registers: [registry],
});

const relayFailed = new client.Counter({
  name: 'stockguard_relay_failed_total',
  help: 'Delivery attempts that failed',
  registers: [registry],
});

const relayDead = new client.Counter({
  name: 'stockguard_relay_dead_total',
  help: 'Events moved to the dead state',
  registers: [registry],
});

const relayDeliveryDuration = new client.Histogram({
  name: 'stockguard_relay_delivery_duration_seconds',
  help: 'Duration of one delivery attempt',
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

const consumerProcessed = new client.Counter({
  name: 'stockguard_consumer_processed_total',
  help: 'Events whose effect was applied',
  labelNames: ['event_type'],
  registers: [registry],
});

const consumerDuplicates = new client.Counter({
  name: 'stockguard_consumer_duplicates_total',
  help: 'Duplicate deliveries ignored',
  labelNames: ['event_type'],
  registers: [registry],
});

const dbPoolClients = new client.Gauge({
  name: 'stockguard_db_pool_clients',
  help: 'Pool clients by state',
  labelNames: ['state'],
  registers: [registry],
});

function observePool(pool) {
  dbPoolClients.set({ state: 'total' }, pool.totalCount);
  dbPoolClients.set({ state: 'idle' }, pool.idleCount);
  dbPoolClients.set({ state: 'waiting' }, pool.waitingCount);
}

module.exports = {
  registry,
  httpRequestsTotal,
  httpDuration,
  holdsCreated,
  holdsConfirmed,
  holdsCancelled,
  holdsExpired,
  reaperBatchSize,
  reaperSweepDuration,
  expiryLag,
  outboxBacklog,
  relayDelivered,
  relayFailed,
  relayDead,
  relayDeliveryDuration,
  consumerProcessed,
  consumerDuplicates,
  dbPoolClients,
  observePool,
};
