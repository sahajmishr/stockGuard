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

  async confirmHoldRepo({hold_id , user_id} , client =pool){
      return await client.query(`
      UPDATE holds SET state = 'confirmed'
      WHERE id = $1 AND
      owner_id = $2 AND
      state = 'active' AND 
       expires_at > NOW() 
       RETURNING id , sku_id , quantity , state ` ,
      [hold_id , user_id]);
  },

  async diagnoseHold(hold_id , client= pool){
   return await client.query(`
    SELECT owner_id , state FROM holds WHERE id = $1
    `,[hold_id]);

  }, 
   
  async cancelHold({hold_id , user_id} , client = pool ){
 return await client.query(
        `UPDATE holds 
         SET state = 'cancelled' 
         WHERE id = $1 
           AND actor_id = $2 
           AND state = 'active'
         RETURNING id, sku_id, quantity`,
        [hold_id, user_id]
      );

  },
  

};

module.exports = holdRepository;