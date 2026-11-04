const pool = require("../config/db");

const skuRepository = {
  async findById(id) {
    const query = "SELECT * FROM skus WHERE id = $1;";
    const values = [id];
    const { rows } = await pool.query(query, values);
    return rows[0] || null;
  },

  async decrementStock({ sku_id, quantity }, client = pool) {
    const query = `
        UPDATE skus SET available_units = available_units - $1 WHERE id = $2 AND available_units>= $1 RETURNING available_units;
        `;

    const { rows } = await client.query(query, [quantity, sku_id]);

    return rows;
  },

  async checkSku(sku_id){
    const query = ` SELECT * FROM skus WHERE id = $1 ;`;
    const values = [sku_id];
    const{ rows } = await pool.query( query , values);
    return rows ;
  }
};
module.exports = skuRepository;
