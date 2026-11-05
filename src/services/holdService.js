const pool = require('../config/db');
const env = require('../config/env');
const { httpError } = require('../middlewares/errorHandler');
const skuRepository = require('../repositories/skuRepository');
const holdRepository = require('../repositories/holdRepository');

const holdService = {
  async createNewHold({ sku_id, owner_id, quantity }) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const updated = await skuRepository.decrementStock({ sku_id, quantity }, client);

      if (!updated) {
        // throw, don't rollback here — the catch block is the only rollback site
        throw httpError(409, 'INSUFFICIENT_STOCK', 'not enough stock for this sku');
      }

      const hold = await holdRepository.createHold(
        { sku_id, owner_id, quantity, ttlMinutes: env.holdTtlMinutes },
        client,
      );

      await client.query('COMMIT');
      return hold;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // never let a rollback failure hide the real error
        console.error(
          JSON.stringify({ level: 'error', msg: 'rollback failed', error: rollbackErr.message }),
        );
      }
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = holdService;