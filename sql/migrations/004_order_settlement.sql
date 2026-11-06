ALTER TABLE orders ADD COLUMN IF NOT EXISTS sku_id INT REFERENCES skus(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INT CHECK (quantity > 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64);

UPDATE orders o
   SET sku_id = h.sku_id,
       quantity = h.quantity,
       owner_id = h.owner_id
  FROM holds h
 WHERE h.id = o.hold_id
   AND (o.sku_id IS NULL OR o.quantity IS NULL OR o.owner_id IS NULL);

ALTER TABLE orders ALTER COLUMN sku_id SET NOT NULL;
ALTER TABLE orders ALTER COLUMN quantity SET NOT NULL;
ALTER TABLE orders ALTER COLUMN owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders (sku_id);
CREATE INDEX IF NOT EXISTS idx_orders_owner ON orders (owner_id);
