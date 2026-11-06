function buildRestorePlan(rows) {
  const bySku = new Map();
  let totalUnits = 0;

  for (const row of rows) {
    const quantity = Number(row.quantity);
    const skuId = Number(row.sku_id);
    bySku.set(skuId, (bySku.get(skuId) ?? 0) + quantity);
    totalUnits += quantity;
  }

  const restores = [...bySku.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sku_id, quantity]) => ({ sku_id, quantity }));

  return { restores, totalUnits, skuCount: restores.length };
}

function summariseLag(rows) {
  if (!rows.length) return { maxLagSeconds: 0, avgLagSeconds: 0 };
  let max = 0;
  let sum = 0;
  for (const row of rows) {
    const lag = Number(row.lag_seconds ?? 0);
    sum += lag;
    if (lag > max) max = lag;
  }
  return { maxLagSeconds: max, avgLagSeconds: sum / rows.length };
}

module.exports = { buildRestorePlan, summariseLag };
