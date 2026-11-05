const pool = require('../config/db');

const orderRepository = {

    async findOrderByHoldId( hold_id , client = pool){
       return await client.query(`
           SELECT id , hold_id , created_at FROM orders WHERE hold_id = $1
            ` , [hold_id] );
    },

    async createOrders(hold_idConfirm , client = pool){
        return client.query(`
            INSERT INTO orders(hold_id) VALUES ($1) RETURNING id , hold_id ,created_at `,[hold_idConfirm] )
    }
}

module.exports = orderRepository;