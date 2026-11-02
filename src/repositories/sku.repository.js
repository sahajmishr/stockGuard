const pool = require('../config/db');

const skuRepository = {
    async findById(id){
        const query = 'SELECT * FROM skus WHERE id = $1;';
        const values = [id];
        const { rows } = await pool.query(query , values);
        return rows[0]  || null ;
    }


};
module.exports = skuRepository;
