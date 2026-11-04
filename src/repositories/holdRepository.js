const pool = require("../config/db");

const holdRepository = {
  async createHold({ sku_id, owner_id, quantity, interval }, client = pool) {
    const query = `
        INSERT INTO holds( sku_id , owner_id , quantity , expires_at)
        VALUES ($1 , $2 , $3 , NOW()+$4::interval)
        RETURNING id , expires_at ;
        `;
    const { rows } = await client.query(query, [
      sku_id,
      owner_id,
      quantity,
      interval,
    ]);
    return rows[0];
  },
};

module.exports = holdRepository;
