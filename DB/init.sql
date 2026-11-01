-- 1. SKUs Table
CREATE TABLE skus (
    id SERIAL PRIMARY KEY,
    total_units INT NOT NULL CHECK (total_units >= 0),
    available_units INT NOT NULL CHECK (available_units >= 0)
);

-- 2. Holds Table
CREATE TYPE hold_state AS ENUM ('active', 'confirmed', 'cancelled', 'expired');

CREATE TABLE holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku_id INT NOT NULL REFERENCES skus(id),
    owner_id VARCHAR(255) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    state hold_state NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT chk_terminal_state CHECK (
        (state = 'active' AND expires_at > created_at) OR 
        (state IN ('confirmed', 'cancelled', 'expired'))
    )
);

-- Index for Expiry Reaper
CREATE INDEX idx_holds_expiry_sweep ON holds (state, expires_at) WHERE state = 'active';

-- 3. Orders Table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hold_id UUID NOT NULL UNIQUE REFERENCES holds(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Idempotency Keys Table
CREATE TYPE idempotency_status AS ENUM ('processing', 'completed');

CREATE TABLE idempotency_keys (
    client_id VARCHAR(255) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL, -- SHA-256 hash of canonical payload
    status idempotency_status NOT NULL,
    response_code INT,
    response_body JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (client_id, idempotency_key)
);

-- 5. Outbox Table
CREATE TYPE outbox_state AS ENUM ('unpublished', 'leased', 'published', 'failed');

CREATE TABLE outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_version INT NOT NULL,
    payload JSONB NOT NULL,
    state outbox_state NOT NULL DEFAULT 'unpublished',
    lease_expires_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_relay ON outbox (state, lease_expires_at) WHERE state IN ('unpublished', 'leased');

-- 6. Consumer Processed Events (Deduplication Log)
CREATE TABLE processed_events (
    event_id UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
