const { httpError } = require('./errorHandler');
const skuRepository = require('../repositories/skuRepository');

const DIGITS_ONLY = /^\d+$/;


const validateSkuParams = (req, res, next) => {
  const { id } = req.params;

  if (!DIGITS_ONLY.test(id)) {
    return next(httpError(400, 'INVALID_SKU_ID', 'sku id must be a positive integer'));
  }

  const parsedId = Number(id);
  if (!Number.isSafeInteger(parsedId) || parsedId <= 0) {
    return next(httpError(400, 'INVALID_SKU_ID', 'sku id must be a positive integer'));
  }

  req.validatedId = parsedId;
  return next();
};


const validateSkuExists = async (req, res, next) => {
  try {
    const sku = await skuRepository.findById(req.validatedId);
    if (!sku) return next(httpError(404, 'SKU_NOT_FOUND', 'no such sku'));
    req.sku = sku;
    return next();
  } catch (err) {
    return next(err);
  }
};

const MAX_QUANTITY = 1000;

const validateHoldBody = (req, res, next) => {
  const { quantity } = req.body ?? {};

  if (!Number.isInteger(quantity) || quantity < 1) {
    return next(httpError(400, 'INVALID_QUANTITY', 'quantity must be a whole number >= 1'));
  }
  if (quantity > MAX_QUANTITY) {
    return next(httpError(400, 'INVALID_QUANTITY', `quantity must be <= ${MAX_QUANTITY}`));
  }

  return next();
};

const validateIdempotencyHeader = (req , res , next )=>{
  const idempotencykey = req.headers['x-idempotency-key'];
  if(!idempotencykey){
    return next(httpError(400 , 'MISSING IDEMPOTENCY KEY ' , 'provide it yrr '))
    return res.status(400).json({ httpError : ' missing idempotency key '});
  }
  req.idempotencyKey = idempotencykey ;
 return next();
};

module.exports = { validateSkuParams, validateSkuExists, validateHoldBody , validateIdempotencyHeader };