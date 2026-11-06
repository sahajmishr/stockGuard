const pool = require('../config/db');

const orderRepository = {
  async findOrderByHoldId(hold_id, client = pool) {
    const { rows } = await client.query(
      'SELECT id, hold_id, created_at FROM orders WHERE hold_id = $1',
      [hold_id],
    );
    return rows[0] ?? null;
  },

  async createOrders(hold, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO orders (hold_id, sku_id, quantity, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, hold_id, sku_id, quantity, owner_id, created_at`,
      [hold.id, hold.sku_id, hold.quantity, hold.owner_id],
    );
    return rows[0];
  },

  async count(client = pool) {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM orders');
    return rows[0].n;
  },
};

module.exports = orderRepository;
