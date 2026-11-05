const env = require('./src/config/env'); // loads + validates .env. MUST be first.
const app = require('./src/app');
const pool = require('./src/config/db');

const server = app.listen(env.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: `api listening on ${env.port}` }));
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', msg: `${signal} received, shutting down` }));

  const force = setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', msg: 'forced exit after 10s' }));
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(async () => {
    try {
      await pool.end();
      console.log(JSON.stringify({ level: 'info', msg: 'shutdown complete' }));
      process.exit(0);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'pool close failed', error: err.message }));
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C — what you actually use on Windows
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection', reason: String(reason) }));
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'uncaughtException', error: err.message, stack: err.stack }));
  shutdown('uncaughtException');
});