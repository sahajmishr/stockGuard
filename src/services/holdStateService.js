const { error } = require('node:console');
const pool = require('../config/db');
const { httpError } = require('../middlewares/errorHandler');
const { confirmHoldRepo, diagnoseHold , cancelHold } = require('../repositories/holdRepository');
const { findOrderByHoldId , createOrders } = require('../repositories/orderRepository');
const { insertInOutbox } = require('../repositories/outboxrepository');
const { incrementSku } = require('../repositories/skuRepository');

const holdStateService = {

    async confirmHold({hold_id , user_id}){

     const client = await pool.connect();
     try{
        const ConfirmRes = await confirmHoldRepo({hold_id , user_id} , client );

        if(ConfirmRes.rows.length === 0 ){
            const diagnoseRes = await diagnoseHold(hold_id , client);

            if(diagnoseRes.rows.length === 0 || diagnoseRes.rows[0].owner_id !== user_id){
                await client.query('ROLLBACK');
                throw httpError( 404 , "HOLD_NOT_FOUND" , " hold record not found ");
            }
            const existingState = diagnoseRes.rows[0].state ;

            if( existingState === 'confirmed'){
                const orderRes = await findOrderByHoldId(hold_id);
                await client.query('ROLLBACK');
                return {status : 200 , body : orderRes.rows[0]};

            }
            if(existingState === 'cancelled'){
                await client.query('ROLLBACK');
                throw httpError(409 , 'INVALID_STATE_TRANSITION' , 'Cannot confirm a cancelled order');

            }
             await client.query('ROLLBACK');
         throw httpError(409, "HOLD_EXPIRED", 'cannot confirm an expired hold' );
         
        }

        const confirmedHold = ConfirmRes.rows[0];
        const hold_idConfirm = confirmedHold.id;
        const orderInsertRes = await createOrders(hold_idConfirm , client);
        const generatedOrder = orderInsertRes.rows[0];
        const generatedOrderId = String(generatedOrder.id) ;
        const payload =  JSON.stringify({
            order_id: generatedOrder.id,
            hold_id: confirmedHold.id,
            sku_id: confirmedHold.sku_id,
            quantity: confirmedHold.quantity,
            actor_id: user_id
        });

          await insertInOutbox(generatedOrderId , payload);

          await client.query('COMMIT');
          return { status : 201 , body : generatedOrder};


     }catch(error){
      await client.query('ROLLBACK');
      throw error ;
     } finally {
        client.release();
     }
    },

    async cancelHold({hold_id , user_id}){
     const client = await pool.connect();
     try{
      
        await client.query('BEGIN');
        const cancelRes = await cancelHold( {hold_id , user_id} , client);

        if( cancelRes.rows.length === 0 ){
            const diagnoseRes = await diagnoseHold(hold_id , client);
           if (diagnoseRes.rows.length === 0 ||  diagnoseRes.rows[0].actor_id !== user_id) {
              await client.query('ROLLBACK');
              throw httpError(404, 'HOLD_NOT_FOUND' ,"Hold record not found.");

             }
        if (existingState === 'cancelled') {
         
         await client.query('ROLLBACK');
          return { status: 200, body: { message: "Hold already cancelled (idempotent no-op)." } };
        }
        
        await client.query('ROLLBACK');
        throw httpError(409, "INVALID_STATE_TRANSITION","Cannot cancel a confirmed hold.");
      }

      const cancelledHold = cancelRes.rows[0];
      const quantity = cancelledHold.quantity ;
      const sku_id = cancelledHold.sku_id;
      const cancelHoldId = String(cancelledHold.id);
      const payload = JSON.stringify({ hold_id: cancelledHold.id, sku_id: cancelledHold.sku_id, quantity: cancelledHold.quantity });
       await  incrementSku( {sku_id , quantity} , client);
       await insertInOutbox(cancelHoldId , payload);

       await client.query('COMMIT');
       return{ status : 200 , body : { message : " hold successfully cancelled"}};
     }catch{
      await client.query('ROLLBACK');
      throw error ;
     }finally{
        client.release();
     }
    }

};
module.exports = holdStateService;