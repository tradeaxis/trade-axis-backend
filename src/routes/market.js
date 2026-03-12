// backend/src/routes/market.js
const express = require('express');
const router = express.Router();
const marketController = require('../controllers/marketController');
const { protect } = require('../middleware/auth');

// Public routes (no auth needed for market data)
router.get('/symbols', marketController.getSymbols);
router.get('/symbols/search', marketController.searchSymbols);
router.get('/quote/:symbol', marketController.getQuote);
router.get('/candles/:symbol', marketController.getCandles);

module.exports = router;