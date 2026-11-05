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
};

module.exports = holdRepository;