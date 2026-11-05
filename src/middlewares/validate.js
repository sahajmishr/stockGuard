const { app } = require("../app");
const pool = require("../config/db");
const { checkSku } = require("../repositories/skuRepository");

const validateSkuParams = (req, res, next) => {
  const { id } = req.params;

  const parsedId = parseInt(id, 10);

  if (isNaN(parsedId) || parsedId <= 0) {
    res.status(400).json({ message: " tum chor ho " });
  }
  req.validatedId = parsedId;
  next();
};

const validateSkuId = async (req, res, next) => {
  const { id } = req.validatedId;
  try {
    const is_sku = await checkSku(id);
    if (!is_sku || is_sku.length === 0) {
      const error = new Error("SKU NOT FOUND ");
      error.status = 404;
      throw error;
    }
    next();
  } catch (error) {
    const statusCode = error.status || 500;
    return res.status(statusCode).json({ message: error.message });
  }
};
module.exports = { validateSkuParams, validateSkuId };
