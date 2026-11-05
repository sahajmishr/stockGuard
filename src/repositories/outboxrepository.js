const pool = require('../config/db');

const outboxRepository = {
 async insertInOutbox({generatedOrderId , payload } , client = pool){
 await client.query(`
    INSERT INTO outbox (event_type , aggregate_id , aggregate_version , payload) VALUES($1 , $2, $3 ,$4)
    ` [
        'ORDER_PLACED',
        generatedOrderId,
        1,
        payload 
    ]);
 } 

}

module.exports= outboxRepository;