const pool = require('../config/db');
const env = require('../config/env');
const { httpError } = require('../middlewares/errorHandler');
const skuRepository = require('../repositories/skuRepository');
const holdRepository = require('../repositories/holdRepository');
const idempotencyRepository = require('../repositories/idempotencyRepository');
const outboxRepository = require('../repositories/outboxRepository');
const computeCanonicalHash = require('../utils/hash');
const metrics = require('../config/metrics');
const { child } = require('../config/logger');

const log = child({ component: 'hold' });

const holdService = {
  async createNewHold({ sku_id, owner_id, quantity, idempotencyKey, operation }) {
    const client = await pool.connect();
    const currentHash = computeCanonicalHash({ sku_id, quantity });

    try {
      await client.query('BEGIN');

      const lockKeyString = `${owner_id}:${operation}:${idempotencyKey}`;
      const lockRes = await client.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
        [lockKeyString],
      );

      if (!lockRes.rows[0].acquired) {
        await client.query('ROLLBACK');
        throw httpError(409, 'REQUEST_IN_PROGRESS', 'an identical request is being processed, retry shortly');
      }

      const storedRecord = await idempotencyRepository.checkIdempotencyRecord(
        { owner_id, operation, idempotencykey: idempotencyKey },
        client,
      );

      if (storedRecord) {
        if (storedRecord.request_hash === currentHash) {
          await client.query('ROLLBACK');
          return { isReplay: true, code: storedRecord.response_code, body: storedRecord.response_body };
        }
        await client.query('ROLLBACK');
        throw httpError(
          409,
          'IDEMPOTENCY_KEY_REUSE_VIOLATION',
          'this key was already used with a different payload',
        );
      }

      const updated = await skuRepository.decrementStock({ sku_id, quantity }, client);

      if (!updated) {
        const errorResponseStatus = 409;
        const errorResponseBody = { error: 'INSUFFICIENT_STOCK', message: 'not enough stock for this sku' };

        await idempotencyRepository.createIdempotencyErrorRow(
          {
            actorId: owner_id,
            operation,
            idempotencyKey,
            currentHash,
            errorResponseStatus,
            errorResponseBody,
          },
          client,
        );

        await client.query('COMMIT');
        return { isReplay: false, code: errorResponseStatus, body: errorResponseBody };
      }

      const hold = await holdRepository.createHold(
        { sku_id, owner_id, quantity, ttlMinutes: env.holdTtlMinutes },
        client,
      );

      await outboxRepository.insertEvent(
        {
          eventType: 'HoldCreated',
          aggregateId: hold.id,
          aggregateVersion: 1,
          payload: {
            hold_id: hold.id,
            sku_id: hold.sku_id,
            owner_id: hold.owner_id,
            quantity: hold.quantity,
            expires_at: hold.expires_at,
          },
        },
        client,
      );

      const successResponseStatus = 201;
      const successResponseBody = {
        hold_id: hold.id,
        sku_id: hold.sku_id,
        quantity: hold.quantity,
        state: hold.state,
        created_at: hold.created_at,
        expires_at: hold.expires_at,
      };

      await idempotencyRepository.createIdempotencySuccessRow(
        {
          actorId: owner_id,
          operation,
          idempotencyKey,
          currentHash,
          successResponseStatus,
          successResponseBody,
        },
        client,
      );

      await client.query('COMMIT');
      metrics.holdsCreated.inc();
      return { isReplay: false, code: successResponseStatus, body: successResponseBody };
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

  async getHold({ hold_id, user_id }) {
    const hold = await holdRepository.findById(hold_id);
    if (!hold) throw httpError(404, 'HOLD_NOT_FOUND', 'no such hold');
    if (hold.owner_id !== user_id) throw httpError(404, 'HOLD_NOT_FOUND', 'no such hold');
    return {
      id: hold.id,
      sku_id: hold.sku_id,
      quantity: hold.quantity,
      state: hold.state,
      created_at: hold.created_at,
      expires_at: hold.expires_at,
    };
  },
};

module.exports = holdService;
