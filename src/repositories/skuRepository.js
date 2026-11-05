const pool = require('../config/db');

const skuRepository = {
  async findById(id) {
    const { rows } = await pool.query(
      'SELECT id, total_units, available_units FROM skus WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  },

  // The heart of the project. Condition and write in ONE statement.
  // Returns the updated row, or null when there was not enough stock.
  async decrementStock({ sku_id, quantity }, client = pool) {
    const { rows } = await client.query(
      `UPDATE skus
          SET available_units = available_units - $1
        WHERE id = $2
          AND available_units >= $1
      RETURNING id, total_units, available_units`,
      [quantity, sku_id],
    );
    return rows[0] ?? null;
  },
};

module.exports = skuRepository;