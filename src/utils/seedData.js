const Symbol = require('../models/Symbol');

// Indian Market Symbols
const indianSymbols = [
  // NSE Indices
  { symbol: 'NIFTY50', displayName: 'NIFTY 50', exchange: 'NSE', category: 'index', lastPrice: 21750, lotSize: 50 },
  { symbol: 'BANKNIFTY', displayName: 'Bank NIFTY', exchange: 'NSE', category: 'index', lastPrice: 46500, lotSize: 25 },
  { symbol: 'NIFTYIT', displayName: 'NIFTY IT', exchange: 'NSE', category: 'index', lastPrice: 35800, lotSize: 25 },
  
  // Large Cap Stocks
  { symbol: 'RELIANCE', displayName: 'Reliance Industries', exchange: 'NSE', category: 'equity', lastPrice: 2450, lotSize: 1 },
  { symbol: 'TCS', displayName: 'Tata Consultancy Services', exchange: 'NSE', category: 'equity', lastPrice: 3850, lotSize: 1 },
  { symbol: 'HDFCBANK', displayName: 'HDFC Bank', exchange: 'NSE', category: 'equity', lastPrice: 1625, lotSize: 1 },
  { symbol: 'INFY', displayName: 'Infosys', exchange: 'NSE', category: 'equity', lastPrice: 1480, lotSize: 1 },
  { symbol: 'ICICIBANK', displayName: 'ICICI Bank', exchange: 'NSE', category: 'equity', lastPrice: 1050, lotSize: 1 },
  { symbol: 'HINDUNILVR', displayName: 'Hindustan Unilever', exchange: 'NSE', category: 'equity', lastPrice: 2520, lotSize: 1 },
  { symbol: 'SBIN', displayName: 'State Bank of India', exchange: 'NSE', category: 'equity', lastPrice: 625, lotSize: 1 },
  { symbol: 'BHARTIARTL', displayName: 'Bharti Airtel', exchange: 'NSE', category: 'equity', lastPrice: 1150, lotSize: 1 },
  { symbol: 'ITC', displayName: 'ITC Limited', exchange: 'NSE', category: 'equity', lastPrice: 445, lotSize: 1 },
  { symbol: 'KOTAKBANK', displayName: 'Kotak Mahindra Bank', exchange: 'NSE', category: 'equity', lastPrice: 1750, lotSize: 1 },
  { symbol: 'LT', displayName: 'Larsen & Toubro', exchange: 'NSE', category: 'equity', lastPrice: 3550, lotSize: 1 },
  { symbol: 'AXISBANK', displayName: 'Axis Bank', exchange: 'NSE', category: 'equity', lastPrice: 1080, lotSize: 1 },
  { symbol: 'WIPRO', displayName: 'Wipro', exchange: 'NSE', category: 'equity', lastPrice: 485, lotSize: 1 },
  { symbol: 'TATAMOTORS', displayName: 'Tata Motors', exchange: 'NSE', category: 'equity', lastPrice: 785, lotSize: 1 },
  { symbol: 'TATASTEEL', displayName: 'Tata Steel', exchange: 'NSE', category: 'equity', lastPrice: 135, lotSize: 1 },
  { symbol: 'MARUTI', displayName: 'Maruti Suzuki', exchange: 'NSE', category: 'equity', lastPrice: 10850, lotSize: 1 },
  { symbol: 'SUNPHARMA', displayName: 'Sun Pharma', exchange: 'NSE', category: 'equity', lastPrice: 1520, lotSize: 1 },
  { symbol: 'ADANIENT', displayName: 'Adani Enterprises', exchange: 'NSE', category: 'equity', lastPrice: 2750, lotSize: 1 },
  
  // MCX Commodities
  { symbol: 'GOLDM', displayName: 'Gold Mini', exchange: 'MCX', category: 'commodity', lastPrice: 62500, lotSize: 100, tradingHours: '09:00-23:30' },
  { symbol: 'SILVERM', displayName: 'Silver Mini', exchange: 'MCX', category: 'commodity', lastPrice: 74500, lotSize: 5, tradingHours: '09:00-23:30' },
  { symbol: 'CRUDEOIL', displayName: 'Crude Oil', exchange: 'MCX', category: 'commodity', lastPrice: 6250, lotSize: 100, tradingHours: '09:00-23:30' },
  { symbol: 'NATURALGAS', displayName: 'Natural Gas', exchange: 'MCX', category: 'commodity', lastPrice: 185, lotSize: 1250, tradingHours: '09:00-23:30' },
  
  // Currency Pairs
  { symbol: 'USDINR', displayName: 'USD/INR', exchange: 'CDS', category: 'currency', lastPrice: 83.15, lotSize: 1000, tradingHours: '09:00-17:00' },
  { symbol: 'EURINR', displayName: 'EUR/INR', exchange: 'CDS', category: 'currency', lastPrice: 90.25, lotSize: 1000, tradingHours: '09:00-17:00' },
  { symbol: 'GBPINR', displayName: 'GBP/INR', exchange: 'CDS', category: 'currency', lastPrice: 105.50, lotSize: 1000, tradingHours: '09:00-17:00' },
  { symbol: 'JPYINR', displayName: 'JPY/INR', exchange: 'CDS', category: 'currency', lastPrice: 0.5575, lotSize: 100000, tradingHours: '09:00-17:00' }
];

const seedSymbols = async () => {
  try {
    const count = await Symbol.countDocuments();
    
    if (count === 0) {
      // Add bid/ask spreads
      const symbolsWithSpread = indianSymbols.map(sym => ({
        ...sym,
        bid: sym.lastPrice * 0.9999,
        ask: sym.lastPrice * 1.0001,
        open: sym.lastPrice,
        high: sym.lastPrice * 1.01,
        low: sym.lastPrice * 0.99,
        close: sym.lastPrice,
        previousClose: sym.lastPrice * 0.998,
        tickSize: sym.category === 'equity' ? 0.05 : 0.01
      }));
      
      await Symbol.insertMany(symbolsWithSpread);
      console.log('✅ Indian market symbols seeded successfully');
      console.log(`   - ${indianSymbols.filter(s => s.category === 'equity').length} Stocks`);
      console.log(`   - ${indianSymbols.filter(s => s.category === 'index').length} Indices`);
      console.log(`   - ${indianSymbols.filter(s => s.category === 'commodity').length} Commodities`);
      console.log(`   - ${indianSymbols.filter(s => s.category === 'currency').length} Currency Pairs`);
    } else {
      console.log('ℹ️  Symbols already exist, skipping seed');
    }
  } catch (error) {
    console.error('❌ Error seeding symbols:', error.message);
  }
};

module.exports = seedSymbols;