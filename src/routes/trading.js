// backend/src/routes/trading.js
const express = require('express');
const router = express.Router();
const tradingController = require('../controllers/tradingController');
const { protect } = require('../middleware/auth');

router.use(protect);

// ============ POSITIONS ============
router.get('/positions/:accountId', tradingController.getPositions);
router.post('/order', tradingController.placeOrder);
router.post('/close-all', tradingController.closeAllPositions);
router.post('/close/:tradeId', tradingController.closePosition);
router.post('/partial-close/:tradeId', tradingController.partialClose);
router.put('/modify/:tradeId', tradingController.modifyPosition);
router.post('/add-quantity/:tradeId', tradingController.addQuantity); // ✅ NEW

// ============ PENDING ORDERS ============
router.delete('/pending-orders/all', tradingController.cancelAllPendingOrders);
router.get('/pending-orders/:accountId', tradingController.getPendingOrders);
router.put('/pending-order/:orderId', tradingController.modifyPendingOrder);
router.delete('/pending-order/:orderId', tradingController.cancelPendingOrder);

// ============ HISTORY ============
router.get('/history', tradingController.getTradeHistory);
router.get('/stats', tradingController.getTradeStats);

module.exports = router;