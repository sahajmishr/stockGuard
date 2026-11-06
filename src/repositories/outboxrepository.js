const pool = require('../config/db');

const CLAIMABLE = `
  (state = 'pending' AND next_attempt_at <= now())
  OR (state = 'leased' AND lease_expires_at <= now())
`;

const outboxRepository = {
  async insertEvent({ eventType, aggregateId, aggregateVersion, payload }, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO outbox (event_type, aggregate_id, aggregate_version, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id, event_type, aggregate_id, aggregate_version, payload, created_at`,
      [eventType, aggregateId, aggregateVersion, payload],
    );
    return rows[0];
  },

  async claimBatch({ batchSize, leaseSeconds, leaseOwner = null }, client = pool) {
    const { rows } = await client.query(
      `UPDATE outbox
          SET state = 'leased',
              lease_owner = $3,
              lease_expires_at = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM outbox
           WHERE ${CLAIMABLE}
           ORDER BY created_at, aggregate_version, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_type, aggregate_id, aggregate_version, payload, retry_count, created_at`,
      [batchSize, leaseSeconds, leaseOwner],
    );
    rows.sort((a, b) => {
      const byTime = new Date(a.created_at) - new Date(b.created_at);
      if (byTime !== 0) return byTime;
      const byVersion = Number(a.aggregate_version) - Number(b.aggregate_version);
      if (byVersion !== 0) return byVersion;
      return String(a.aggregate_id).localeCompare(String(b.aggregate_id));
    });
    return rows;
  },

  async markPublished(id, client = pool) {
    const { rows } = await client.query(
      `UPDATE outbox
          SET state = 'published', published_at = now(), lease_expires_at = NULL, lease_owner = NULL, last_error = NULL
        WHERE id = $1
        RETURNING id`,
      [id],
    );
    return rows[0] ?? null;
  },

  async markFailed({ id, maxAttempts, backoffSeconds, error }, client = pool) {
    const { rows } = await client.query(
      `UPDATE outbox
          SET retry_count = retry_count + 1,
              state = CASE WHEN retry_count + 1 >= $2 THEN 'dead'::outbox_state ELSE 'pending'::outbox_state END,
              next_attempt_at = now() + make_interval(secs => $3),
              last_error = $4,
              lease_expires_at = NULL,
              lease_owner = NULL
        WHERE id = $1
        RETURNING id, state, retry_count, next_attempt_at, last_error`,
      [id, maxAttempts, backoffSeconds, error == null ? null : String(error).slice(0, 500)],
    );
    return rows[0] ?? null;
  },

  async countsByState(client = pool) {
    const { rows } = await client.query(
      `SELECT state, count(*)::int AS count FROM outbox GROUP BY state ORDER BY state`,
    );
    return rows;
  },

  async backlog(client = pool) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS pending FROM outbox
        WHERE state = 'pending' OR (state = 'leased' AND lease_expires_at <= now())`,
    );
    return rows[0].pending;
  },

  async listByState({ state, limit, offset }, client = pool) {
    const { rows } = await client.query(
      `SELECT id, event_type, aggregate_id, aggregate_version, state, retry_count,
              next_attempt_at, last_error, created_at, published_at, lease_expires_at
         FROM outbox
        WHERE state = $1
        ORDER BY created_at
        LIMIT $2 OFFSET $3`,
      [state, limit, offset],
    );
    return rows;
  },

  async findById(id, client = pool) {
    const { rows } = await client.query(
      `SELECT id, event_type, aggregate_id, aggregate_version, payload, state,
              retry_count, next_attempt_at, last_error, created_at, published_at
         FROM outbox WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async requeue(id, client = pool) {
    const { rows } = await client.query(
      `UPDATE outbox
          SET state = 'pending',
              retry_count = 0,
              next_attempt_at = now(),
              lease_expires_at = NULL,
              lease_owner = NULL,
              last_error = NULL,
              published_at = NULL
        WHERE id = $1
        RETURNING id, event_type, state, retry_count`,
      [id],
    );
    return rows[0] ?? null;
  },
};

module.exports = outboxRepository;
