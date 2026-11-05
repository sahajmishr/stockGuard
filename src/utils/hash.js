const crypto =  require('crypto');

function computeCanonicalHash({ sku_id, quantity }) {
  const canonicalString = JSON.stringify({ quantity: Number(quantity), sku_id: Number(sku_id) });
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

module.exports = computeCanonicalHash ;