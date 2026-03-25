// backend/src/utils/manualSeedCommodities.js
// Run this if Kite API instrument fetch is not available
// Usage: node -e "require('./src/utils/manualSeedCommodities').run()"

const { supabase } = require('../config/supabase');

// ═══════════════════════════════════════════
//  MANUALLY ADD MISSING COMMODITY SYMBOLS
//  You MUST fill in the correct kite_instrument_token
//  from: https://api.kite.trade/instruments/MCX (CSV)
// ═══════════════════════════════════════════

const MISSING_SYMBOLS = [
  // ── Gold Mini ──
  {
    symbol: 'GOLDM25JULFUT',
    display_name: 'Gold Mini JUL 25 Futures',
    exchange: 'MCX',
    category: 'commodity_futures',
    segment: 'MCX',
    instrument_type: 'FUT',
    underlying: 'GOLDM',
    lot_size: 1,
    tick_size: 1,
    expiry_date: '2025-07-05',
    trading_hours: '09:00-23:30',
    kite_instrument_token: null, // ← FILL THIS from Kite instrument dump
  },
  // ── Gold Micro / Guinea ──
  {
    symbol: 'GOLDGUINEA25JULFUT',
    display_name: 'Gold Guinea JUL 25 Futures',
    exchange: 'MCX',
    category: 'commodity_futures',
    segment: 'MCX',
    instrument_type: 'FUT',
    underlying: 'GOLDGUINEA',
    lot_size: 1,
    tick_size: 1,
    expiry_date: '2025-07-15',
    trading_hours: '09:00-23:30',
    kite_instrument_token: null, // ← FILL THIS
  },
  // ── Gold Petal ──
  {
    symbol: 'GOLDPETAL25JULFUT',
    display_name: 'Gold Petal JUL 25 Futures',
    exchange: 'MCX',
    category: 'commodity_futures',
    segment: 'MCX',
    instrument_type: 'FUT',
    underlying: 'GOLDPETAL',
    lot_size: 1,
    tick_size: 1,
    expiry_date: '2025-07-15',
    trading_hours: '09:00-23:30',
    kite_instrument_token: null, // ← FILL THIS
  },
  // ── Silver Mini ──
  {
    symbol: 'SILVERM25JULFUT',
    display_name: 'Silver Mini JUL 25 Futures',
    exchange: 'MCX',
    category: 'commodity_futures',
    segment: 'MCX',
    instrument_type: 'FUT',
    underlying: 'SILVERM',
    lot_size: 1,
    tick_size: 1,
    expiry_date: '2025-07-04',
    trading_hours: '09:00-23:30',
    kite_instrument_token: null, // ← FILL THIS
  },
  // ── Silver Micro ──
  {
    symbol: 'SILVERMIC25JULFUT',
    display_name: 'Silver Micro JUL 25 Futures',
    exchange: 'MCX',
    category: 'commodity_futures',
    segment: 'MCX',
    instrument_type: 'FUT',
    underlying: 'SILVERMIC',
    lot_size: 1,
    tick_size: 1,
    expiry_date: '2025-07-04',
    trading_hours: '09:00-23:30',
    kite_instrument_token: null, // ← FILL THIS
  },
  // ── Gift Nifty ──
  {
    symbol: 'GIFTNIFTY25JULFUT',
    display_name: 'Gift Nifty JUL 25 Futures',
    exchange: 'NSE',
    category: 'index_futures',
    segment: 'BFO',
    instrument_type: 'FUT',
    underlying: 'GIFTNIFTY',
    lot_size: 25,
    tick_size: 0.5,
    expiry_date: '2025-07-31',
    trading_hours: '09:00-23:30',
    kite_instrument_token: null, // ← FILL THIS
  },
];

async function run() {
  console.log('📝 Manual seed: Adding missing commodity/index symbols...\n');

  for (const sym of MISSING_SYMBOLS) {
    if (!sym.kite_instrument_token) {
      console.log(`⚠️  SKIPPED ${sym.symbol} — kite_instrument_token is null. Fill it first!`);
      continue;
    }

    const payload = {
      ...sym,
      is_active: true,
      last_price: 0,
      bid: 0,
      ask: 0,
      open_price: 0,
      high_price: 0,
      low_price: 0,
      previous_close: 0,
      change_value: 0,
      change_percent: 0,
      volume: 0,
    };

    const { error } = await supabase
      .from('symbols')
      .upsert(payload, { onConflict: 'symbol' });

    if (error) {
      console.log(`❌ ${sym.symbol}: ${error.message}`);
    } else {
      console.log(`✅ ${sym.symbol} (token: ${sym.kite_instrument_token})`);
    }
  }

  console.log('\n🔄 Now restart the Kite stream to pick up new tokens.');
  console.log('   Or call: kiteStreamService.refreshSubscriptions()');
}

module.exports = { run, MISSING_SYMBOLS };