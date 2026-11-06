const pool = require('../config/db');
const env = require('../config/env');
const { httpError } = require('../middlewares/errorHandler');
const holdRepository = require('../repositories/holdRepository');
const skuRepository = require('../repositories/skuRepository');
const outboxRepository = require('../repositories/outboxRepository');
const { buildRestorePlan, summariseLag } = require('../utils/reaperPlan');
const metrics = require('../config/metrics');
const { child } = require('../config/logger');

const log = child({ component: 'reaper' });

const reaperService = {
  async sweepOnce({ batchSize = env.reaper.batchSize } = {}) {
    const startedAt = process.hrtime.bigint();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const expiredRows = await holdRepository.claimExpiredBatch({ batchSize }, client);

      if (expiredRows.length === 0) {
        await client.query('COMMIT');
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        metrics.reaperBatchSize.observe(0);
        metrics.reaperSweepDuration.observe(seconds);
        return { expired: 0, skus: 0, unitsRestored: 0, durationSeconds: seconds, maxLagSeconds: 0 };
      }

      const plan = buildRestorePlan(expiredRows);

      for (const restore of plan.restores) {
        const updated = await skuRepository.incrementSku(restore, client);
        if (!updated) {
          throw httpError(500, 'SKU_MISSING', `sku ${restore.sku_id} vanished during restore`);
        }
      }

      for (const row of expiredRows) {
        await outboxRepository.insertEvent(
          {
            eventType: 'HoldExpired',
            aggregateId: row.id,
            aggregateVersion: 2,
            payload: {
              hold_id: row.id,
              sku_id: row.sku_id,
              quantity: row.quantity,
              owner_id: row.owner_id,
            },
          },
          client,
        );
      }

      await client.query('COMMIT');

      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const lag = summariseLag(expiredRows);

      metrics.reaperBatchSize.observe(expiredRows.length);
      metrics.reaperSweepDuration.observe(seconds);
      metrics.holdsExpired.inc(expiredRows.length);
      for (const row of expiredRows) metrics.expiryLag.observe(Number(row.lag_seconds ?? 0));

      const result = {
        expired: expiredRows.length,
        skus: plan.skuCount,
        unitsRestored: plan.totalUnits,
        durationSeconds: seconds,
        maxLagSeconds: lag.maxLagSeconds,
      };

      log.info('sweep complete', result);
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error('rollback failed', { error: rollbackErr.message });
      }
      log.error('sweep failed', { error: err.message });
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = reaperService;
