const { httpError } = require('./errorHandler');

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const demoAuthMiddleware = (req, res, next) => {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return next(httpError(401, 'UNAUTHORIZED', 'missing x-user-id header (demo stand-in for auth)'));
  }

  if (!USER_ID_RE.test(userId)) {
    return next(httpError(400, 'INVALID_USER_ID', 'x-user-id must be 1-64 chars of A-Z a-z 0-9 _ -'));
  }

  req.userId = userId;
  return next();
};

module.exports = { demoAuthMiddleware };