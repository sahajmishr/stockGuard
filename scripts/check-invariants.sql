-- CHECK 1: drift per SKU. Every row must be 0.
SELECT
  s.id AS sku_id,
  s.total_units,
  s.available_units,
  COALESCE(h.active_units, 0)    AS active_held,
  COALESCE(h.confirmed_units, 0) AS confirmed_held,
  (s.available_units
     + COALESCE(h.active_units, 0)
     + COALESCE(h.confirmed_units, 0)
     - s.total_units) AS drift
FROM skus s
LEFT JOIN (
  SELECT sku_id,
         SUM(quantity) FILTER (WHERE state = 'active')    AS active_units,
         SUM(quantity) FILTER (WHERE state = 'confirmed') AS confirmed_units
  FROM holds
  GROUP BY sku_id
) h ON h.sku_id = s.id
ORDER BY s.id;

-- CHECK 2: no negative availability (should be 0 rows; the CHECK constraint is the real guard)
SELECT id, available_units FROM skus WHERE available_units < 0;

-- CHECK 3: active holds whose time is up but which are still 'active'.
-- This is NOT a failure. It is your expiry backlog / lag, measured on Day 14.
SELECT count(*) AS stale_active_holds FROM holds
WHERE state = 'active' AND expires_at <= now();

-- CHECK 4 (enable on Day 11): one order per confirmed hold, and no orphans.
-- SELECT count(*) FROM orders;
-- SELECT count(*) FROM holds WHERE state = 'confirmed';

-- CHECK 5 (enable on Day 16): exactly one terminal event per terminal hold, no duplicate versions.
-- SELECT aggregate_id, aggregate_version, event_type, count(*)
-- FROM outbox GROUP BY 1,2,3 HAVING count(*) > 1;