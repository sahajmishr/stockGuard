const express = require("express");
const pool = require("./config/db");
const { name , version } = require('../package.json');
const { validateSkuParams } = require("./middlewares/validate");
const skuRepository = require("./repositories/sku.repository");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({
    name ,
    version
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

app.get('/skus/:id' , validateSkuParams , async (req , res , next)=>{
 try {
  const skuId = req.validatedId;
 const sku = await skuRepository.findById(skuId);
  if(!sku){
    const error = new Error('sku not found');
    error.status = 404;
    return next(error.message);
  }
  res.status(200).json({success : true , data : sku });
 } catch (error){
  next(error.message);
 }
});

app.get("/ready", checkDatabase);
app.get("/health", (req, res) => {
  res.status(200).json({ status: "running ", message: "server is live " });
});

module.exports = app;
