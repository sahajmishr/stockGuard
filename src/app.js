const express = require("express");
const pool = require("./config/db");
const { name, version } = require("../package.json");
const { validateSkuParams, validateSkuId } = require("./middlewares/validate");
const { demoAuthMiddleware } = require("./middlewares/auth");
const skuRepository = require("./repositories/skuRepository");
const holdService = require("./services/holdService");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  console.log(req.ip);
  res.status(200).json({
    name,
    version,
  });
});

const checkDatabase = async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ status: "UP", database: "UP" });
  } catch (error) {
    console.error("database check failed:", error.message);
    return res.status(503).json({ status: "DOWN", database: "DOWN" });
  }
};

app.get("/skus/:id", validateSkuParams, async (req, res, next) => {
  try {
    const skuId = req.validatedId;
    const sku = await skuRepository.findById(skuId);
    if (!sku) {
      const error = new Error("sku not found");
      error.status = 404;
      return next(error.message);
    }
    res.status(200).json({ success: true, data: sku });
  } catch (error) {
    next(error.message);
  }
});

app.post(
  "/skus/:id/holds",
  demoAuthMiddleware ,
  validateSkuParams, validateSkuId , 
  async (req, res, next) => {
    const owner_id = req.userId;
    const sku_id = req.validatedId;
    const { quantity } = req.body;
   
    try {
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({
          error: "validation_Error",
          message: "quantity should be a whole .. dont try to  be smart ",
        });
      }

      const updateRecord = await holdService.createNewHold({
        sku_id,
        owner_id,
        quantity,
      });

      if (!updateRecord) {
        const error = new Error("INTERNAL_SERVER_ERROR");
        error.status = 500;
        return next(error.message);
      }
      return res.status(201).json({
        hold_id: updateRecord.id,
        sku_id: sku_id,
        quantity: quantity,
        expiring_at: updateRecord.expires_at,
        // whatIGot: updateRecord
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/ready", checkDatabase);
app.get("/health", (req, res) => {
  res.status(200).json({ status: "running ", message: "server is live " });
});

module.exports = app;
