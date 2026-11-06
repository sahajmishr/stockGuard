const pool = require('../src/config/db');
const relayService = require('../src/services/relayService');

relayService
  .publishBatch()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    return pool.end();
  })
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
