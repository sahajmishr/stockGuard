const env = require('./env');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: env.serviceName,
    msg,
  };
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields)) line[key] = fields[key];
  }
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(out);
  else console.log(out);
}

function child(base) {
  return {
    debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...base, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
  };
}

module.exports = {
  logger: child({}),
  child,
};
