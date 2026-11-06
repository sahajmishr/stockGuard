ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_owner text;

CREATE INDEX IF NOT EXISTS idx_outbox_delivery_order
  ON outbox (created_at, aggregate_version)
  WHERE state IN ('pending', 'leased');