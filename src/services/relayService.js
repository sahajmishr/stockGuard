const pool = require('../config/db');
const env = require('../config/env');
const outboxRepository = require('../repositories/outboxRepository');
const { nextAttemptSeconds } = require('../utils/backoff');
const metrics = require('../config/metrics');
const { child } = require('../config/logger');

const log = child({ component: 'relay' });

async function claimBatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await outboxRepository.claimBatch(
      {
        batchSize: env.relay.batchSize,
        leaseSeconds: env.relay.leaseSeconds,
        leaseOwner: env.instanceId,
      },
      client,
    );
    await client.query('COMMIT');
    return batch;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error('claim rollback failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

async function deliver(event) {
  const startedAt = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.relay.requestTimeoutMs);

  try {
    const res = await fetch(env.relay.consumerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event_id: event.id,
        event_type: event.event_type,
        aggregate_id: event.aggregate_id,
        aggregate_version: event.aggregate_version,
        payload: event.payload,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`consumer responded ${res.status} ${text.slice(0, 200)}`);
    }

    await outboxRepository.markPublished(event.id);
    metrics.relayDelivered.inc();
    return { delivered: true };
  } catch (err) {
    const attempt = Number(event.retry_count) + 1;
    const backoffSeconds = nextAttemptSeconds(
      attempt,
      env.relay.baseBackoffMs,
      env.relay.maxBackoffMs,
    );
    const updated = await outboxRepository.markFailed({
      id: event.id,
      maxAttempts: env.relay.maxAttempts,
      backoffSeconds,
      error: err.message,
    });
    metrics.relayFailed.inc();
    if (updated && updated.state === 'dead') {
      metrics.relayDead.inc();
      log.warn('event moved to dead', { eventId: event.id, error: err.message, attempt });
    } else {
      log.warn('delivery failed, will retry', {
        eventId: event.id,
        error: err.message,
        attempt,
        retryInSeconds: backoffSeconds,
      });
    }
    return { delivered: false, error: err.message };
  } finally {
    clearTimeout(timer);
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    metrics.relayDeliveryDuration.observe(seconds);
  }
}

const relayService = {
  async publishBatch() {
    const batch = await claimBatch();

    if (batch.length === 0) {
      metrics.outboxBacklog.set(await outboxRepository.backlog());
      return { claimed: 0, delivered: 0, failed: 0 };
    }

    let delivered = 0;
    let failed = 0;

    for (const event of batch) {
      const result = await deliver(event);
      if (result.delivered) delivered += 1;
      else failed += 1;
    }

    metrics.outboxBacklog.set(await outboxRepository.backlog());
    return { claimed: batch.length, delivered, failed };
  },
};

module.exports = relayService;
module.exports.claimBatch = claimBatch;
module.exports.deliver = deliver;
