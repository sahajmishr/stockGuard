const pool = require('../config/db');
const skuRepository = require('../repositories/skuRepository');
const holdRepository = require('../repositories/holdRepository');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const holdService  = {
    async createNewHold({sku_id , owner_id , quantity}){

      const holdTtlMinutes = process.env.HOLD_TTL_MINUTES || '5' ;
      const interval = `${holdTtlMinutes} minutes ` ;
      
      const client =  await pool.connect();
      
      try{
      await client.query('BEGIN');

      const updateRows = await skuRepository.decrementStock({ sku_id , quantity} , client);

      if(updateRows.length === 0){
        await client.query('ROLLBACK');
        const error = new Error('INSUFFICIENT_STOCK');
        error.status = 409 ;
        throw error ;

      }

      const holdRecord = await holdRepository.createHold({sku_id , owner_id , quantity , interval} , client);
      
      await client.query('COMMIT');

      return holdRecord ;


      } catch(error){
        if(error.message!== 'INSUFFICIENT_STOCK'){
            await client.query('ROLLBACK');
        }
        throw error.message ;
      } finally{
        client.release();
      }


    }  
};

module.exports = holdService ;