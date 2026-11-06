function computeBackoffMs(attempt, baseMs, maxMs) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = Number(baseMs) * Math.pow(2, n - 1);
  if (!Number.isFinite(raw)) return Number(maxMs);
  return Math.min(Math.round(raw), Number(maxMs));
}

function nextAttemptSeconds(attempt, baseMs, maxMs) {
  return Math.max(1, Math.ceil(computeBackoffMs(attempt, baseMs, maxMs) / 1000));
}

module.exports = { computeBackoffMs, nextAttemptSeconds };
