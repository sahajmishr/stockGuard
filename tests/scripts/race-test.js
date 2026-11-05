const {Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const TARGET_URL = 'http://localhost:8001/skus/6/holds';
const CONCURRENT_REQUESTS = 10000; // worked fine for even 10000 users concurrently hehehhhehehhe ;
const pool = new Pool({
   user : process.env.DB_USER,
 host : process.env.DB_HOST,
 database : process.env.DB_NAME,
 password : process.env.DB_PASSWORD,
 port : process.env.DB_PORT,
 max:10,
 idleTimeoutMillis : 30000,
 connectionTimeoutMillis : 20000, 
});

// async function resetState(){
//     console.log('resetting database holds');
//     const client = await pool.connect();
//     try{
//         await client.query('BEGIN');
//         await client.query('TRUNCATE TABLE orders , holds CASCADE ;');
//         await client.query(`
//       INSERT INTO skus ( total_units, available_units) 
//       VALUES ( 100, 1)
//       ON CONFLICT (id) DO UPDATE 
//       SET total_units = 100, available_units = 1;
//     `);
//     await client.query('COMMIT');
    
//     }catch(err){
//         await client.query('ROLLBACK');
//         throw err;
//     }finally{
//         client.release();
//     }
// }

async function runRaceTest() {
  console.log('🚀 Preparing to run the fire test...');

  // Note the arguments signature: (_, index) -> element is ignored, index is second
  const requestPromises = Array.from({ length: CONCURRENT_REQUESTS }).map((_, index) => {
    return fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', // REQUIRED for the server to parse the body
        'x-user-id': `test-${index}`       // Now correctly generates test-0, test-1, etc.
      },
      body: JSON.stringify({
        quantity: 1 
      })
    })
    .then((res) => ({ status: res.status, ok: res.ok }))
    .catch((err) => ({ status: 'FETCH_ERROR', error: err.message })); // Fixed: Do not reference 'res' here
  });

  console.log('🔥 Firing all requests...');
  const responses = await Promise.all(requestPromises);

  const metrics = { '201': 0, '409': 0, '400': 0 , '404': 0 , '401': 0 , '500': 0 , 'Others': 0 }; // Consistent capital 'O'
  responses.forEach(res => {
    if (res?.status === 201) metrics['201']++;
    else if (res?.status === 409) metrics['409']++;
    else if(res?.status === 500) metrics['500']++;
     else if(res?.status === 400) metrics['400']++;
      else if(res?.status === 401) metrics['401']++;
       else if(res?.status === 404) metrics['404']++;
    else {
      metrics['Others']++;
      // Log errors if any requests failed completely
      if (res.status === 'FETCH_ERROR') console.error('Underlying error:', res.error);
    }
  });

  console.log('\n📊 HTTP Response Distribution Grid:');
  console.table(metrics);
  
  // Only call if pool is defined globally, otherwise remove this line
  if (typeof pool !== 'undefined') {
    await pool.end();
  }
}

runRaceTest().catch(console.error);

