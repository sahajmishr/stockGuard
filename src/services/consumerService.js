const pool = require('../config/db');
const processedEventsRepository = require('../repositories/processedEventsRepository');
const metrics = require('../config/metrics');
const { child } = require('../config/logger');

const log = child({ component: 'consumer' });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertEventShape(body) {
  const problems = [];
  if (!body || typeof body !== 'object') problems.push('body must be a JSON object');
  else {
    if (typeof body.event_id !== 'string' || !UUID_PATTERN.test(body.event_id)) {
      problems.push('event_id must be a uuid');
    }
    if (body.aggregate_version !== undefined && !Number.isInteger(Number(body.aggregate_version))) {
      problems.push('aggregate_version must be an integer');
    }
    if (typeof body.event_type !== 'string' || body.event_type.length === 0) problems.push('event_type required');
    if (body.payload === null || typeof body.payload !== 'object') problems.push('payload required');
    else {
      if (!Number.isInteger(Number(body.payload.quantity))) problems.push('payload.quantity must be an integer');
      if (body.payload.hold_id != null && !UUID_PATTERN.test(String(body.payload.hold_id))) {
        problems.push('payload.hold_id must be a uuid');
      }
      if (body.payload.sku_id != null && !Number.isInteger(Number(body.payload.sku_id))) {
        problems.push('payload.sku_id must be an integer');
      }
    }
  }
  return problems;
}

const consumerService = {
  async handleEvent(body) {
    const problems = assertEventShape(body);
    if (problems.length) return { status: 400, body: { error: 'INVALID_EVENT', problems } };

    const { event_id, event_type, payload } = body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const claimed = await processedEventsRepository.claim(
        { eventId: event_id, eventType: event_type },
        client,
      );

      if (!claimed) {
        await client.query('COMMIT');
        metrics.consumerDuplicates.inc({ event_type });
        return { status: 200, body: { status: 'duplicate_ignored', event_id } };
      }

      await processedEventsRepository.recordEffect(
        {
          eventId: event_id,
          eventType: event_type,
          holdId: payload.hold_id ?? null,
          skuId: payload.sku_id ?? null,
          quantity: Number(payload.quantity),
        },
        client,
      );

      await client.query('COMMIT');
      metrics.consumerProcessed.inc({ event_type });
      return { status: 200, body: { status: 'applied', event_id } };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error('consumer rollback failed', { error: rollbackErr.message });
      }
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = consumerService;
