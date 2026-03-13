// backend/src/routes/auth.js
const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const { protect, adminOnly } = require('../middleware/auth');

// PUBLIC
router.post('/login', authController.login);
router.post('/switch-account', authController.switchAccount);

// PROTECTED
router.get('/me', protect, authController.getMe);
router.post('/logout', protect, authController.logout);
router.post('/change-password', protect, authController.changePassword);

// ADMIN ONLY
router.post('/register', protect, adminOnly, authController.register);

module.exports = router;