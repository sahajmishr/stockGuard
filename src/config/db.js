const{ Pool} = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
 user : process.env.DB_USER,
 host : process.env.DB_HOST,
 database : process.env.DB_NAME,
 password : process.env.DB_PASSWORD,
 port : process.env.DB_PORT,
 max:20,
 idleTimeoutMillis : 30000,
 connectionTimeoutMillis : 20000,
});

// pool.on('connect' , async (client)=>{
//    await client.query('SET statement_timeout = 5000;').catch(err=> console.error('Error setting statement_timeout' , err));
// });

   pool.query('select now()' ,  (err , res)=>{
    if(err){
        console.log("db connection error" , err);
    } else {
        console.log('db connection successfull');
    }
});

module.exports = pool ;