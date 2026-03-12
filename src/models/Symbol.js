const mongoose = require('mongoose');

const symbolSchema = new mongoose.Schema({
  // Symbol Info
  symbol: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  displayName: {
    type: String,
    required: true
  },
  description: String,
  
  // Exchange Info
  exchange: {
    type: String,
    enum: ['NSE', 'BSE', 'MCX', 'CDS'], // CDS = Currency Derivatives
    required: true
  },
  category: {
    type: String,
    enum: ['equity', 'index', 'commodity', 'currency', 'fno'], // fno = Futures & Options
    required: true
  },
  
  // Pricing
  lastPrice: {
    type: Number,
    default: 0
  },
  bid: {
    type: Number,
    default: 0
  },
  ask: {
    type: Number,
    default: 0
  },
  open: {
    type: Number,
    default: 0
  },
  high: {
    type: Number,
    default: 0
  },
  low: {
    type: Number,
    default: 0
  },
  close: {
    type: Number,
    default: 0
  },
  previousClose: {
    type: Number,
    default: 0
  },
  
  // Change
  change: {
    type: Number,
    default: 0
  },
  changePercent: {
    type: Number,
    default: 0
  },
  
  // Volume
  volume: {
    type: Number,
    default: 0
  },
  
  // Trading Info
  lotSize: {
    type: Number,
    default: 1
  },
  tickSize: {
    type: Number,
    default: 0.05 // Standard tick size for NSE
  },
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  isTradeable: {
    type: Boolean,
    default: true
  },
  
  // Trading Hours (IST)
  tradingHours: {
    type: String,
    default: '09:15-15:30' // NSE/BSE timing
  },
  
  lastUpdate: {
    type: Date,
    default: Date.now
  }

}, {
  timestamps: true
});

// Index for faster queries
symbolSchema.index({ symbol: 1, exchange: 1 });
symbolSchema.index({ category: 1 });

module.exports = mongoose.model('Symbol', symbolSchema);