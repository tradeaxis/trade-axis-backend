const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  // References
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: true
  },
  
  // Transaction Type
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'transfer'],
    required: true
  },
  
  // Amount (in INR)
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  
  // Payment Details
  paymentMethod: {
    type: String,
    enum: ['upi', 'netbanking', 'debit_card', 'credit_card', 'bank_transfer'],
    required: true
  },
  
  // UPI/Bank Details
  paymentDetails: {
    upiId: String,
    bankName: String,
    accountNumber: String,
    ifscCode: String,
    transactionId: String
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  
  // Reference Number
  reference: {
    type: String,
    unique: true
  },
  
  // Balance Tracking
  balanceBefore: Number,
  balanceAfter: Number,
  
  // Processing
  processedAt: Date,
  failureReason: String

}, {
  timestamps: true
});

// Generate reference number
transactionSchema.pre('save', function(next) {
  if (!this.reference) {
    const prefix = this.type === 'deposit' ? 'DEP' : 'WTH';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.reference = `${prefix}${timestamp}${random}`;
  }
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);