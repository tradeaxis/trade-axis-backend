// backend/src/utils/findTokens.js
// Usage: node -e "require('./src/utils/findTokens').run()"

const kiteService = require('../services/kiteService');

async function run() {
  await kiteService.init();
  if (!kiteService.isSessionReady()) {
    console.log('❌ Kite session not ready');
    return;
  }

  const kite = kiteService.getKiteInstance();

  // Search terms
  const searchTerms = ['GOLDM', 'GOLDGUINEA', 'GOLDPETAL', 'SILVERM', 'SILVERMIC', 'GIFTNIFTY', 'GIFT_NIFTY'];

  console.log('🔍 Searching for instrument tokens...\n');

  // Fetch MCX instruments
  try {
    const mcx = await kite.getInstruments('MCX');
    const now = new Date();

    console.log('═══ MCX FUTURES (not expired) ═══');
    for (const inst of mcx) {
      if (inst.instrument_type !== 'FUT') continue;
      if (inst.expiry && new Date(inst.expiry) < now) continue;

      const ts = String(inst.tradingsymbol).toUpperCase();
      const name = String(inst.name || '').toUpperCase();

      for (const term of searchTerms) {
        if (ts.includes(term) || name.includes(term)) {
          console.log(`  ${inst.tradingsymbol} | token: ${inst.instrument_token} | lot: ${inst.lot_size} | expiry: ${inst.expiry} | name: ${inst.name}`);
          break;
        }
      }
    }
  } catch (e) {
    console.log('MCX error:', e.message);
  }

  // Fetch BFO instruments (Gift Nifty)
  try {
    const bfo = await kite.getInstruments('BFO');
    const now = new Date();

    console.log('\n═══ BFO FUTURES (Gift Nifty) ═══');
    for (const inst of bfo) {
      if (inst.instrument_type !== 'FUT') continue;
      if (inst.expiry && new Date(inst.expiry) < now) continue;

      const ts = String(inst.tradingsymbol).toUpperCase();
      const name = String(inst.name || '').toUpperCase();

      if (ts.includes('NIFTY') || ts.includes('GIFT') || name.includes('NIFTY') || name.includes('GIFT')) {
        console.log(`  ${inst.tradingsymbol} | token: ${inst.instrument_token} | lot: ${inst.lot_size} | expiry: ${inst.expiry} | name: ${inst.name}`);
      }
    }
  } catch (e) {
    console.log('BFO error:', e.message);
  }

  // Fetch NFO instruments (also check for Gift Nifty)
  try {
    const nfo = await kite.getInstruments('NFO');
    const now = new Date();

    console.log('\n═══ NFO - Gift Nifty search ═══');
    for (const inst of nfo) {
      if (inst.instrument_type !== 'FUT') continue;
      if (inst.expiry && new Date(inst.expiry) < now) continue;

      const ts = String(inst.tradingsymbol).toUpperCase();
      if (ts.includes('GIFT')) {
        console.log(`  ${inst.tradingsymbol} | token: ${inst.instrument_token} | lot: ${inst.lot_size} | expiry: ${inst.expiry}`);
      }
    }
  } catch (e) {
    console.log('NFO error:', e.message);
  }

  console.log('\n✅ Copy the instrument_token values and paste them into manualSeedCommodities.js');
}

module.exports = { run };