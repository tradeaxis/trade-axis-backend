// backend/src/routes/admin.js
const express = require('express');
const router = express.Router();

const { protect, adminOnly } = require('../middleware/auth');
const adminController = require('../controllers/adminController');

// All routes in this file require authentication and admin role
router.use(protect);
router.use(adminOnly);

// Users
router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.patch('/users/:id/active', adminController.setUserActive);
router.delete('/users/:id', adminController.deleteUser);
router.post('/users/:id/reset-password', adminController.resetPassword);

// Trading settings
router.get('/leverage-options', adminController.getLeverageOptions);
router.patch('/users/:id/leverage', adminController.updateUserLeverage);
router.patch('/users/:id/brokerage', adminController.updateBrokerageRate);
router.patch('/users/:id/max-saved-accounts', adminController.updateMaxSavedAccounts);
router.patch('/users/:id/closing-mode', adminController.toggleClosingMode);

// ✅ FIXED: Add balance route (no need for extra middleware - already applied above)
router.post('/users/:id/add-balance', adminController.addBalanceToAccount);

// Withdrawals
router.get('/withdrawals', adminController.listWithdrawals);
router.post('/withdrawals/:id/approve', adminController.approveWithdrawal);
router.post('/withdrawals/:id/reject', adminController.rejectWithdrawal);

// Kite
router.get('/kite/login-url', adminController.getKiteLoginUrl);
router.post('/kite/session', adminController.createKiteSession);
router.post('/kite/sync-symbols', adminController.syncKiteSymbols);
router.post('/kite/start-stream', adminController.startKiteStream);
router.post('/kite/stop-stream', adminController.stopKiteStream);
router.get('/kite/status', adminController.kiteStatus);

module.exports = router;