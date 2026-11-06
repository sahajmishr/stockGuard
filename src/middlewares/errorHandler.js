

const PG_ERRORS = {
  '22P02': { status: 400, code: 'INVALID_INPUT' },
  '22001': { status: 400, code: 'VALUE_TOO_LONG' },
  '22003': { status: 400, code: 'VALUE_OUT_OF_RANGE' },
  '23505': { status: 409, code: 'DUPLICATE' },
  '23514': { status: 409, code: 'CONSTRAINT_FAILED' },
  '40001': { status: 503, code: 'RETRY_LATER' },
  '57014': { status: 503, code: 'TIMEOUT' },
};

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'internal error';

  if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'request body is not valid JSON';
  } else if (err.status) {

    status = err.status;
    code = err.code || 'ERROR';
    message = err.message;
  } else if (PG_ERRORS[err.code]) {

    ({ status, code } = PG_ERRORS[err.code]);
    message = 'the request could not be completed';
  }

  if (status >= 500) {

    console.error(
      JSON.stringify({
        level: 'error',
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status,
        code,
        message: err.message,
        stack: err.stack,
      }),
    );
  }

  return res.status(status).json({ error: code, message, requestId: req.id ?? null });
}

module.exports = { errorHandler, httpError };
