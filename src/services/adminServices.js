const { httpError } = require('../middlewares/errorHandler');
const outboxRepository = require('../repositories/outboxRepository');
const holdRepository = require('../repositories/holdRepository');
const orderRepository = require('../repositories/orderRepository');
const processedEventsRepository = require('../repositories/processedEventsRepository');
const metrics = require('../config/metrics');

const adminService = {
  async getOutboxOverview({ deadLimit = 20 } = {}) {
    const [counts, backlog, dead, holds, orders, processed] = await Promise.all([
      outboxRepository.countsByState(),
      outboxRepository.backlog(),
      outboxRepository.listByState({ state: 'dead', limit: deadLimit, offset: 0 }),
      holdRepository.countByState(),
      orderRepository.count(),
      processedEventsRepository.count(),
    ]);

    const byState = counts.reduce((acc, row) => {
      acc[row.state] = row.count;
      return acc;
    }, {});

    metrics.outboxBacklog.set(backlog);

    return {
      backlog,
      by_state: byState,
      dead: dead.map((row) => ({
        id: row.id,
        event_type: row.event_type,
        aggregate_id: row.aggregate_id,
        retry_count: row.retry_count,
        last_error: row.last_error,
        created_at: row.created_at,
      })),
      holds_by_state: holds.reduce((acc, row) => {
        acc[row.state] = row.count;
        return acc;
      }, {}),
      orders: orders,
      processed_events: processed,
    };
  },

  async replayEvent(id) {
    const event = await outboxRepository.findById(id);
    if (!event) throw httpError(404, 'EVENT_NOT_FOUND', 'no such outbox event');

    const requeued = await outboxRepository.requeue(id);
    return {
      id: requeued.id,
      event_type: requeued.event_type,
      previous_state: event.state,
      state: requeued.state,
      retry_count: requeued.retry_count,
    };
  },
};

module.exports = adminService;
