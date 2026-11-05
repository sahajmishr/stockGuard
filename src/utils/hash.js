const crypto =  require('crypto');

function computeCanonicalHash(body){
    const { quantity} = body ;
    const normalized = {
        quantity : Number(quantity)
    };

    const canonicalString = JSON.stringify(normalized);
    return crypto.createHash('sha256').update(canonicalString).digest('hex');

}

module.exports = computeCanonicalHash ;