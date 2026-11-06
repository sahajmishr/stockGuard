const pool = require('../config/db');
const { httpError } = require('../middlewares/errorHandler');
const { confirmHoldRepo, diagnoseHold, cancelHold: cancelHoldRepo } = require('../repositories/holdRepository');
const { findOrderByHoldId, createOrders } = require('../repositories/orderRepository');
const { insertEvent } = require('../repositories/outboxRepository');
const { incrementSku } = require('../repositories/skuRepository');
const metrics = require('../config/metrics');
const { child } = require('../config/logger');

const log = child({ component: 'holdstate' });

const holdStateService = {
  async confirmHold({ hold_id, user_id }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const confirmRes = await confirmHoldRepo({ hold_id, user_id }, client);

      if (confirmRes.length === 0) {
        const diagnoseRes = await diagnoseHold(hold_id, client);

        if (diagnoseRes.length === 0 || diagnoseRes[0].owner_id !== user_id) {
          await client.query('ROLLBACK');
          throw httpError(404, 'HOLD_NOT_FOUND', 'no such hold');
        }

        const existingState = diagnoseRes[0].state;

        if (existingState === 'confirmed') {
          const order = await findOrderByHoldId(hold_id, client);
          await client.query('ROLLBACK');
          return { status: 200, body: order };
        }

        if (existingState === 'cancelled') {
          await client.query('ROLLBACK');
          throw httpError(409, 'INVALID_STATE_TRANSITION', 'cannot confirm a cancelled hold');
        }

        await client.query('ROLLBACK');
        throw httpError(409, 'HOLD_EXPIRED', 'cannot confirm an expired hold');
      }

      const confirmedHold = confirmRes[0];
      const order = await createOrders(confirmedHold, client);

      await insertEvent(
        {
          eventType: 'HoldConfirmed',
          aggregateId: confirmedHold.id,
          aggregateVersion: 2,
          payload: {
            order_id: order.id,
            hold_id: confirmedHold.id,
            sku_id: confirmedHold.sku_id,
            quantity: confirmedHold.quantity,
            actor_id: user_id,
          },
        },
        client,
      );

      await client.query('COMMIT');
      metrics.holdsConfirmed.inc();
      return { status: 201, body: order };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error('rollback failed', { error: rollbackErr.message });
      }
      throw err;
    } finally {
      client.release();
    }
  },

  async cancelHold({ hold_id, user_id }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cancelRes = await cancelHoldRepo({ hold_id, user_id }, client);

      if (cancelRes.length === 0) {
        const diagnoseRes = await diagnoseHold(hold_id, client);

        if (diagnoseRes.length === 0 || diagnoseRes[0].owner_id !== user_id) {
          await client.query('ROLLBACK');
          throw httpError(404, 'HOLD_NOT_FOUND', 'no such hold');
        }

        const existingState = diagnoseRes[0].state;

        if (existingState === 'cancelled') {
          await client.query('ROLLBACK');
          return { status: 200, body: { message: 'hold already cancelled' } };
        }

        await client.query('ROLLBACK');
        throw httpError(409, 'INVALID_STATE_TRANSITION', 'cannot cancel a confirmed hold');
      }

      const cancelledHold = cancelRes[0];
      const restored = await incrementSku(
        { sku_id: cancelledHold.sku_id, quantity: cancelledHold.quantity },
        client,
      );

      if (!restored) {
        throw httpError(500, 'SKU_MISSING', 'sku missing during cancel restore');
      }

      await insertEvent(
        {
          eventType: 'HoldCancelled',
          aggregateId: cancelledHold.id,
          aggregateVersion: 2,
          payload: {
            hold_id: cancelledHold.id,
            sku_id: cancelledHold.sku_id,
            quantity: cancelledHold.quantity,
            actor_id: user_id,
          },
        },
        client,
      );

      await client.query('COMMIT');
      metrics.holdsCancelled.inc();
      return { status: 200, body: { message: 'hold successfully cancelled' } };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error('rollback failed', { error: rollbackErr.message });
      }
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = holdStateService;
