// backend/src/routes/watchlists.js
const express = require('express');
const router = express.Router();
const watchlistController = require('../controllers/watchlistController');
const { protect } = require('../middleware/auth');

// All routes require authentication
router.use(protect);

// ============ WATCHLISTS ============
// Get all watchlists
router.get('/', watchlistController.getWatchlists);

// Create watchlist
router.post('/', watchlistController.createWatchlist);

// Rename watchlist
router.put('/:watchlistId', watchlistController.renameWatchlist);

// Delete watchlist
router.delete('/:watchlistId', watchlistController.deleteWatchlist);

// Set default watchlist
router.put('/:watchlistId/set-default', watchlistController.setDefaultWatchlist);

// ============ SYMBOLS ============
// Get watchlist symbols
router.get('/:watchlistId/symbols', watchlistController.getWatchlistSymbols);

// Add symbol
router.post('/:watchlistId/symbols', watchlistController.addSymbol);

// Remove symbol
router.delete('/:watchlistId/symbols/:symbol', watchlistController.removeSymbol);

// Reorder symbols
router.put('/:watchlistId/symbols/reorder', watchlistController.reorderSymbols);

module.exports = router;