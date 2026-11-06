const crypto = require('crypto');
const env = require('../config/env');
const { httpError } = require('./errorHandler');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const adminAuthMiddleware = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token) return next(httpError(401, 'ADMIN_UNAUTHORIZED', 'missing x-admin-token header'));
  if (!safeEqual(token, env.adminToken)) {
    return next(httpError(403, 'ADMIN_FORBIDDEN', 'invalid admin token'));
  }
  return next();
};

module.exports = { adminAuthMiddleware, safeEqual };
