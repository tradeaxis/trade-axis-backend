const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  // Reference to User
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Account Details
  accountNumber: {
    type: String,
    unique: true
  },
  accountType: {
    type: String,
    enum: ['demo', 'standard', 'premium'],
    default: 'standard'
  },
  
  // Balance (in INR)
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  equity: {
    type: Number,
    default: 0
  },
  margin: {
    type: Number,
    default: 0
  },
  freeMargin: {
    type: Number,
    default: 0
  },
  profit: {
    type: Number,
    default: 0
  },
  
  // Trading Settings
  leverage: {
    type: Number,
    default: 5, // Lower leverage for Indian markets
    enum: [1, 2, 3, 5, 10]
  },
  currency: {
    type: String,
    default: 'INR'
  },
  
  // Account Status
  isDemo: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Statistics
  statistics: {
    totalTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 },
    losingTrades: { type: Number, default: 0 },
    totalProfit: { type: Number, default: 0 },
    totalLoss: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 }
  }

}, {
  timestamps: true
});

// Generate unique account number before saving
accountSchema.pre('save', async function(next) {
  if (!this.accountNumber) {
    const prefix = this.isDemo ? 'DEM' : 'TAX';
    const random = Math.floor(100000 + Math.random() * 900000);
    this.accountNumber = `${prefix}${random}`;
  }
  next();
});

// Method: Calculate equity
accountSchema.methods.calculateEquity = function() {
  this.equity = this.balance + this.profit;
  this.freeMargin = this.equity - this.margin;
  return this;
};

module.exports = mongoose.model('Account', accountSchema);