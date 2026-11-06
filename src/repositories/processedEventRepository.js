const pool = require('../config/db');

const processedEventsRepository = {
  async claim({ eventId, eventType }, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO processed_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, eventType],
    );
    return rows[0] ?? null;
  },

  async recordEffect({ eventId, eventType, holdId, skuId, quantity }, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO consumer_ledger (event_id, event_type, hold_id, sku_id, quantity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING event_id`,
      [eventId, eventType, holdId, skuId, quantity],
    );
    return rows[0];
  },

  async soldUnits(client = pool) {
    const { rows } = await client.query(
      `SELECT sku_id,
              COALESCE(SUM(CASE WHEN event_type = 'HoldConfirmed' THEN quantity ELSE 0 END), 0)::int AS confirmed_units,
              COALESCE(SUM(CASE WHEN event_type = 'HoldCancelled' THEN quantity ELSE 0 END), 0)::int AS cancelled_units,
              COALESCE(SUM(CASE WHEN event_type = 'HoldExpired'   THEN quantity ELSE 0 END), 0)::int AS expired_units,
              count(*)::int AS events_applied
         FROM consumer_ledger
        GROUP BY sku_id
        ORDER BY sku_id`,
    );
    return rows;
  },

  async count(client = pool) {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM processed_events');
    return rows[0].n;
  },
};

module.exports = processedEventsRepository;
