-- 1. SKUs
CREATE TABLE skus (
  id              INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  total_units     INT NOT NULL CHECK (total_units >= 0),
  available_units INT NOT NULL CHECK (available_units >= 0),
  -- availability can never exceed the total: free invariant
  CONSTRAINT chk_units_within_total CHECK (available_units <= total_units),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Holds
CREATE TYPE hold_state AS ENUM ('active', 'confirmed', 'cancelled', 'expired');

CREATE TABLE holds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id     INT NOT NULL REFERENCES skus(id),
  owner_id   VARCHAR(64) NOT NULL,
  quantity   INT NOT NULL CHECK (quantity > 0),
  state      hold_state NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- DB clock by DEFAULT. The app may override the interval for TTL; it must never supply the clock.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- refresh is a storage concern; termination is a business concern. Both are seen by any later process.
  CONSTRAINT chk_expiry_after_creation CHECK (expires_at > created_at)
);

-- Postgres does NOT index the referencing side of a FK. Your invariant query filters on sku_id.
CREATE INDEX idx_holds_sku ON holds (sku_id);
-- Partial index: 'state = active' is in the predicate, so repeating it as a key column is dead weight.
CREATE INDEX idx_holds_expiry_sweep ON holds (expires_at) WHERE state = 'active';

-- 3. Orders  (one per hold — enforced by the database, not by your code)
CREATE TABLE orders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id    UUID NOT NULL UNIQUE REFERENCES holds(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Idempotency keys
-- NO status enum. NO 'processing' state. The row commits WITH the reservation and already holds
-- its saved response. A 'processing' row would need a second commit, which creates a window where
-- the key exists and the hold does not — and a crash there strands the key forever.
CREATE TABLE idempotency_keys (
  actor_id      VARCHAR(64) NOT NULL,
  operation     VARCHAR(64) NOT NULL,      -- e.g. 'create_hold'; missing from the old schema
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash  TEXT NOT NULL,             -- TEXT, not CHAR(n): no padding/trailing-space quirks
  response_code INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

-- 5. Outbox
CREATE TYPE outbox_state AS ENUM ('pending', 'leased', 'published', 'dead');

CREATE TABLE outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        VARCHAR(100) NOT NULL,
  aggregate_id      VARCHAR(255) NOT NULL,
  aggregate_version INT NOT NULL,
  payload           JSONB NOT NULL,
  state             outbox_state NOT NULL DEFAULT 'pending',
  lease_expires_at  TIMESTAMPTZ,
  retry_count       INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- backoff scheduling
  last_error        TEXT,                                 -- inspectable failures
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at      TIMESTAMPTZ
);

CREATE INDEX idx_outbox_relay ON outbox (next_attempt_at)
  WHERE state IN ('pending', 'leased');

-- 6. Consumer dedup log
CREATE TABLE processed_events (
  event_id     UUID PRIMARY KEY,
  event_type   TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);