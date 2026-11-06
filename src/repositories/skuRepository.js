const pool = require('../config/db');

const skuRepository = {
  async findById(id, client = pool) {
    const { rows } = await client.query(
      'SELECT id, total_units, available_units FROM skus WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  },

  async findAll(client = pool) {
    const { rows } = await client.query(
      'SELECT id, total_units, available_units FROM skus ORDER BY id',
    );
    return rows;
  },

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

  async incrementSku({ sku_id, quantity }, client = pool) {
    const { rows } = await client.query(
      `UPDATE skus
          SET available_units = available_units + $1
        WHERE id = $2
      RETURNING id, total_units, available_units`,
      [quantity, sku_id],
    );
    return rows[0] ?? null;
  },
};

module.exports = skuRepository;
