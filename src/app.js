const express = require("express");
const pool = require("./config/db");
const { name, version } = require("../package.json");
const {
  validateSkuParams,
  validateSkuExists,
  validateHoldBody,
  validateIdempotencyHeader,
} = require("./middlewares/validate");
const { demoAuthMiddleware } = require("./middlewares/auth");
const { errorHandler, httpError } = require("./middlewares/errorHandler");
const skuRepository = require("./repositories/skuRepository");
const holdService = require("./services/holdService");
const holdStateService = require("./services/holdStateService");


const app = express();

app.use(express.json({ limit: "16kb" }));

app.get("/", (req, res) => {
  // console.log(req.ip);
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
    console.error(JSON.stringify({ level: "warn", msg: "readiness check failed", error: error.message }));
    return res.status(503).json({ status: "DOWN", database: "DOWN" });
  }
};

app.get("/skus/:id", validateSkuParams, async (req, res, next) => {
  try {
    const skuId = req.validatedId;
    const sku = await skuRepository.findById(skuId);
    if (!sku) return next(httpError(404, "SKU_NOT_FOUND", "no such sku"));
    return res.status(200).json({ success: true, data: sku });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/skus/:id/holds",
  validateIdempotencyHeader,
  demoAuthMiddleware,
  validateSkuParams,
  validateSkuExists,
  validateHoldBody,
  async (req, res, next) => {
     const idempotencyKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'];
      
    try {
      const result = await holdService.createNewHold({
        sku_id: req.validatedId,
        owner_id: req.userId,
        quantity: req.body.quantity,
        idempotencyKey : idempotencyKey,
        operation : "create_hold"
      });
       return res.status(result.code).json(result.body);
      // return res.status(201).json({
      //   hold_id: hold.id,
      //   sku_id: hold.sku_id,
      //   quantity: hold.quantity,
      //   state: hold.state,
      //   created_at: hold.created_at,
      //   expires_at: hold.expires_at,
        
      // });
    } catch (error) {
      return next(error);
    }
  },
);



app.post('/holds/:id/confirm' ,
   demoAuthMiddleware , async (req , res , next)=>{
    try{
       const result = await holdStateService.confirmHold({
        hold_id : req.params.id,
        user_id : req.userId
      }
      );
      return res.status(result.status).json(result.body);
    }catch(error){
      return next(error);

    }

   }

  );




app.post('/holds/:id/cancel', demoAuthMiddleware, async (req, res, next) => {
  try {
    const result = await holdStateService.cancelHold({
      hold_id: req.params.id,
      user_id: req.userId
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
});


app.get("/ready", checkDatabase);
app.get("/health", (req, res) => {
  res.status(200).json({ status: "running ", message: "server is live " });
});


app.use((req, res, next) => {
  next(httpError(404, "ROUTE_NOT_FOUND", "no such endpoint"));
});

// MUST be last. MUST have 4 params, or Express won't recognise it as an error handler.
app.use(errorHandler);

module.exports = app;
