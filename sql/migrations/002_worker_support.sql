CREATE TABLE consumer_ledger (
  event_id    UUID PRIMARY KEY,
  event_type  TEXT NOT NULL,
  hold_id     UUID,
  sku_id      INT,
  quantity    INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consumer_ledger_sku ON consumer_ledger (sku_id);

ALTER TABLE outbox
  ADD CONSTRAINT uq_outbox_aggregate_version UNIQUE (aggregate_id, aggregate_version, event_type);

CREATE INDEX idx_holds_owner ON holds (owner_id);
