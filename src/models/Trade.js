const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
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
  
  // Trade Identification
  ticket: {
    type: Number,
    unique: true
  },
  
  // Instrument
  symbol: {
    type: String,
    required: true,
    uppercase: true
  },
  exchange: {
    type: String,
    enum: ['NSE', 'BSE', 'MCX', 'CDS'],
    required: true
  },
  
  // Trade Type
  type: {
    type: String,
    enum: ['buy', 'sell'],
    required: true
  },
  orderType: {
    type: String,
    enum: ['market', 'limit', 'stop_loss', 'stop_limit'],
    default: 'market'
  },
  
  // Quantity & Price
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  openPrice: {
    type: Number,
    required: true
  },
  closePrice: {
    type: Number
  },
  currentPrice: {
    type: Number
  },
  
  // Risk Management
  stopLoss: {
    type: Number,
    default: 0
  },
  takeProfit: {
    type: Number,
    default: 0
  },
  
  // Profit & Loss (in INR)
  profit: {
    type: Number,
    default: 0
  },
  
  // Charges
  brokerage: {
    type: Number,
    default: 0
  },
  taxes: {
    type: Number,
    default: 0
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'open', 'closed', 'cancelled'],
    default: 'pending'
  },
  
  // Timestamps
  openTime: {
    type: Date,
    default: Date.now
  },
  closeTime: Date,
  
  // Comments
  comment: {
    type: String,
    maxlength: 200
  }

}, {
  timestamps: true
});

// Auto-generate ticket number
tradeSchema.pre('save', async function(next) {
  if (!this.ticket) {
    const lastTrade = await this.constructor.findOne().sort({ ticket: -1 });
    this.ticket = lastTrade ? lastTrade.ticket + 1 : 1000001;
  }
  next();
});

// Method: Calculate profit
tradeSchema.methods.calculateProfit = function(currentPrice) {
  if (this.status !== 'open') return this.profit;
  
  const direction = this.type === 'buy' ? 1 : -1;
  const priceDiff = (currentPrice - this.openPrice) * direction;
  
  this.currentPrice = currentPrice;
  this.profit = priceDiff * this.quantity - this.brokerage - this.taxes;
  
  return this.profit;
};

module.exports = mongoose.model('Trade', tradeSchema);