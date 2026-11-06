const express = require('express');
const pool = require('../config/db');
const consumerService = require('../services/consumerService');
const { errorHandler } = require('../middlewares/errorHandler');

const app = express();

app.use(express.json({ limit: '64kb' }));

app.get('/health', (req, res) => res.status(200).json({ status: 'running' }));

app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ status: 'UP' });
  } catch (error) {
    return res.status(503).json({ status: 'DOWN' });
  }
});

app.post('/events', async (req, res, next) => {
  try {
    const result = await consumerService.handleEvent(req.body);
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
});

app.use(errorHandler);

module.exports = app;
