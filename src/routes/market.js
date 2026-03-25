const express = require('express');
const router = express.Router();

const marketController = require('../controllers/marketController');
const authModule = require('../middleware/auth');

// Resolve middleware safely no matter how auth.js exports it
const authMiddleware =
  typeof authModule === 'function'
    ? authModule
    : authModule.auth ||
      authModule.authenticate ||
      authModule.protect ||
      authModule.verifyToken ||
      authModule.default ||
      ((req, res, next) => next());

// Public market routes
router.get('/symbols', marketController.getSymbols);
router.get('/quote/:symbol', marketController.getQuote);
router.get('/candles/:symbol', marketController.getCandles);
router.get('/search', marketController.searchSymbols);

// Protected/admin sync route
router.post('/sync-instruments', authMiddleware, marketController.syncInstruments);

module.exports = router;