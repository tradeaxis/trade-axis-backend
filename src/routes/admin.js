const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, adminOnly } = require('../middleware/auth');

// ✅ Combined admin middleware
const adminAuth = [protect, adminOnly];

// ================= USER ROUTES =================
router.get('/users', adminAuth, adminController.listUsers);
router.post('/users', adminAuth, adminController.createUser);
router.patch('/users/:id/active', adminAuth, adminController.setUserActive);
router.post('/users/:id/reset-password', adminAuth, adminController.resetPassword);
router.patch('/users/:id/leverage', adminAuth, adminController.updateUserLeverage);
router.patch('/users/:id/brokerage', adminAuth, adminController.updateBrokerageRate);
router.patch('/users/:id/max-saved-accounts', adminAuth, adminController.updateMaxSavedAccounts);
router.patch('/users/:id/closing-mode', adminAuth, adminController.toggleClosingMode);
router.post('/users/:id/add-balance', adminAuth, adminController.addBalanceToAccount);
router.delete('/users/:id', adminAuth, adminController.deleteUser);

// ✅ Open positions for admin manual close
router.get('/open-positions', adminAuth, adminController.getAllOpenPositions);

// ================= WITHDRAWAL ROUTES =================
router.get('/withdrawals', adminAuth, adminController.listWithdrawals);
router.post('/withdrawals/:id/approve', adminAuth, adminController.approveWithdrawal);
router.post('/withdrawals/:id/reject', adminAuth, adminController.rejectWithdrawal);

// ================= MARKET / KITE ROUTES =================
router.get('/kite/login-url', adminAuth, adminController.getKiteLoginUrl);
router.post('/kite/create-session', adminAuth, adminController.createKiteSession);
router.post('/kite/sync-symbols', adminAuth, adminController.syncKiteSymbols);
router.post('/kite/start-stream', adminAuth, adminController.startKiteStream);
router.post('/kite/stop-stream', adminAuth, adminController.stopKiteStream);
router.get('/kite/status', adminAuth, adminController.kiteStatus);

// ================= HOLIDAY / MANUAL CLOSE =================
router.get('/market-holiday', adminAuth, adminController.getMarketHoliday);
router.post('/market-holiday', adminAuth, adminController.setMarketHoliday);
router.post('/close-position', adminAuth, adminController.adminClosePosition);

module.exports = router;