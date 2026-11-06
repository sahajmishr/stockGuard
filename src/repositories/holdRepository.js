const pool = require('../config/db');

const holdRepository = {
  async createHold({ sku_id, owner_id, quantity, ttlMinutes }, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO holds (sku_id, owner_id, quantity, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))
       RETURNING id, sku_id, owner_id, quantity, state, created_at, expires_at`,
      [sku_id, owner_id, quantity, ttlMinutes],
    );
    return rows[0];
  },

  async findById(hold_id, client = pool) {
    const { rows } = await client.query(
      `SELECT id, sku_id, owner_id, quantity, state, created_at, expires_at
         FROM holds WHERE id = $1`,
      [hold_id],
    );
    return rows[0] ?? null;
  },

  async confirmHoldRepo({ hold_id, user_id }, client = pool) {
    const { rows } = await client.query(
      `UPDATE holds
          SET state = 'confirmed', updated_at = now()
        WHERE id = $1
          AND owner_id = $2
          AND state = 'active'
          AND expires_at > now()
      RETURNING id, sku_id, quantity, owner_id, state`,
      [hold_id, user_id],
    );
    return rows;
  },

  async cancelHold({ hold_id, user_id }, client = pool) {
    const { rows } = await client.query(
      `UPDATE holds
          SET state = 'cancelled', updated_at = now()
        WHERE id = $1
          AND owner_id = $2
          AND state = 'active'
      RETURNING id, sku_id, quantity, owner_id, state`,
      [hold_id, user_id],
    );
    return rows;
  },

  async diagnoseHold(hold_id, client = pool) {
    const { rows } = await client.query(
      'SELECT owner_id, state, expires_at FROM holds WHERE id = $1',
      [hold_id],
    );
    return rows;
  },

  async claimExpiredBatch({ batchSize }, client = pool) {
    const { rows } = await client.query(
      `UPDATE holds
          SET state = 'expired', updated_at = now()
        WHERE id IN (
          SELECT id FROM holds
           WHERE state = 'active' AND expires_at <= now()
           ORDER BY expires_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, sku_id, quantity, owner_id,
                  EXTRACT(EPOCH FROM (now() - expires_at))::float8 AS lag_seconds`,
      [batchSize],
    );
    return rows;
  },

  async countByState(client = pool) {
    const { rows } = await client.query(
      'SELECT state, count(*)::int AS count FROM holds GROUP BY state ORDER BY state',
    );
    return rows;
  },

  async staleActiveCount(client = pool) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM holds WHERE state = 'active' AND expires_at <= now()`,
    );
    return rows[0].n;
  },
};

module.exports = holdRepository;
