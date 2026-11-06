const pool = require('../src/config/db');
const reaperService = require('../src/services/reaperService');

reaperService
  .sweepOnce()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    return pool.end();
  })
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
