const express = require('express');
const pool = require('./config/db');
const env = require('./config/env');
const metrics = require('./config/metrics');
const { logger } = require('./config/logger');
const { name, version } = require('../package.json');
const {
  validateSkuParams,
  validateSkuExists,
  validateHoldBody,
  validateHoldId,
  validateOutboxId,
  validateIdempotencyHeader,
  requestIdMiddleware,
} = require('./middlewares/validate');
const { demoAuthMiddleware } = require('./middlewares/auth');
const { adminAuthMiddleware } = require('./middlewares/adminAuth');
const { errorHandler, httpError } = require('./middlewares/errorHandler');
const skuRepository = require('./repositories/skuRepository');
const holdService = require('./services/holdService');
const holdStateService = require('./services/holdStateService');
const adminService = require('./services/adminService');

const app = express();

app.use(express.json({ limit: '16kb' }));
app.use(requestIdMiddleware);

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = req.route ? req.route.path : 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    metrics.httpRequestsTotal.inc(labels);
    metrics.httpDuration.observe(labels, seconds);
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(seconds * 1000),
      instanceId: env.instanceId,
    });
  });
  next();
});

app.get('/', (req, res) => {
  res.status(200).json({ name, version, instance: env.instanceId });
});

const checkDatabase = async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ status: 'UP', database: 'UP' });
  } catch (error) {
    logger.warn('readiness check failed', { error: error.message });
    return res.status(503).json({ status: 'DOWN', database: 'DOWN' });
  }
};

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'running', message: 'server is live' });
});

app.get('/ready', checkDatabase);

app.get('/metrics', async (req, res, next) => {
  try {
    metrics.observePool(pool);
    res.setHeader('content-type', metrics.registry.contentType);
    return res.status(200).send(await metrics.registry.metrics());
  } catch (error) {
    return next(error);
  }
});

app.get('/skus/:id', validateSkuParams, async (req, res, next) => {
  try {
    const sku = await skuRepository.findById(req.validatedId);
    if (!sku) return next(httpError(404, 'SKU_NOT_FOUND', 'no such sku'));
    return res.status(200).json({ success: true, data: sku });
  } catch (error) {
    return next(error);
  }
});

app.post(
  '/skus/:id/holds',
  validateIdempotencyHeader,
  demoAuthMiddleware,
  validateSkuParams,
  validateSkuExists,
  validateHoldBody,
  async (req, res, next) => {
    try {
      const result = await holdService.createNewHold({
        sku_id: req.validatedId,
        owner_id: req.userId,
        quantity: req.body.quantity,
        idempotencyKey: req.idempotencyKey,
        operation: 'create_hold',
      });
      return res.status(result.code).json(result.body);
    } catch (error) {
      return next(error);
    }
  },
);

app.get('/holds/:id', demoAuthMiddleware, validateHoldId, async (req, res, next) => {
  try {
    const hold = await holdService.getHold({ hold_id: req.holdId, user_id: req.userId });
    return res.status(200).json(hold);
  } catch (error) {
    return next(error);
  }
});

app.post('/holds/:id/confirm', demoAuthMiddleware, validateHoldId, async (req, res, next) => {
  try {
    const result = await holdStateService.confirmHold({
      hold_id: req.holdId,
      user_id: req.userId,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
});

app.post('/holds/:id/cancel', demoAuthMiddleware, validateHoldId, async (req, res, next) => {
  try {
    const result = await holdStateService.cancelHold({
      hold_id: req.holdId,
      user_id: req.userId,
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
});

app.get('/admin/outbox', adminAuthMiddleware, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.deadLimit) || 20, 1), 200);
    return res.status(200).json(await adminService.getOutboxOverview({ deadLimit: limit }));
  } catch (error) {
    return next(error);
  }
});

app.post(
  '/admin/outbox/:id/replay',
  adminAuthMiddleware,
  validateOutboxId,
  async (req, res, next) => {
    try {
      return res.status(200).json(await adminService.replayEvent(req.eventId));
    } catch (error) {
      return next(error);
    }
  },
);

app.use((req, res, next) => {
  next(httpError(404, 'ROUTE_NOT_FOUND', 'no such endpoint'));
});

app.use(errorHandler);

module.exports = app;
