// backend/src/utils/syncKiteInstruments.js
const { supabase } = require('../config/supabase');
const kiteService = require('../services/kiteService');

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Patterns for instruments we MUST have
const REQUIRED_PATTERNS = [
  { match: (ts, name, exch) => exch === 'MCX' && /^GOLD\d{2}[A-Z]{3}FUT$/i.test(ts) && !/^GOLDM/i.test(ts) && !/^GOLDGUINEA/i.test(ts) && !/^GOLDPETAL/i.test(ts), underlying: 'GOLD', prefix: 'Gold', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^GOLDM\d/i.test(ts) && !/^GOLDMIC/i.test(ts), underlying: 'GOLDM', prefix: 'Gold Mini', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^GOLDGUINEA/i.test(ts), underlying: 'GOLDGUINEA', prefix: 'Gold Guinea', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^GOLDPETAL/i.test(ts), underlying: 'GOLDPETAL', prefix: 'Gold Petal', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^SILVER\d{2}[A-Z]{3}FUT$/i.test(ts) && !/^SILVERM/i.test(ts) && !/^SILVERMIC/i.test(ts), underlying: 'SILVER', prefix: 'Silver', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^SILVERM\d/i.test(ts) && !/^SILVERMIC/i.test(ts), underlying: 'SILVERM', prefix: 'Silver Mini', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^SILVERMIC/i.test(ts), underlying: 'SILVERMIC', prefix: 'Silver Micro', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^CRUDEOIL/i.test(ts), underlying: 'CRUDEOIL', prefix: 'Crude Oil', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^NATURALGAS/i.test(ts), underlying: 'NATURALGAS', prefix: 'Natural Gas', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^COPPER/i.test(ts), underlying: 'COPPER', prefix: 'Copper', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^ZINC/i.test(ts), underlying: 'ZINC', prefix: 'Zinc', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^ALUMINIUM/i.test(ts), underlying: 'ALUMINIUM', prefix: 'Aluminium', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^LEAD/i.test(ts), underlying: 'LEAD', prefix: 'Lead', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^NICKEL/i.test(ts), underlying: 'NICKEL', prefix: 'Nickel', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^COTTON/i.test(ts), underlying: 'COTTON', prefix: 'Cotton', category: 'commodity_futures' },
  { match: (ts, name, exch) => exch === 'MCX' && /^MENTHAOIL/i.test(ts), underlying: 'MENTHAOIL', prefix: 'Mentha Oil', category: 'commodity_futures' },
  { match: (ts, name, exch) => /GIFT.*NIFTY|NIFTY.*GIFT/i.test(ts) || /GIFT.*NIFTY/i.test(name), underlying: 'GIFTNIFTY', prefix: 'Gift Nifty', category: 'index_futures' },
];

const COMMODITY_UNDERLYINGS = ['GOLD','GOLDM','GOLDGUINEA','GOLDPETAL','SILVER','SILVERM','SILVERMIC','CRUDEOIL','NATURALGAS','COPPER','ZINC','ALUMINIUM','LEAD','NICKEL','COTTON','MENTHAOIL'];
const INDEX_UNDERLYINGS = ['GIFTNIFTY'];
const ALL_UNDERLYINGS = [...COMMODITY_UNDERLYINGS, ...INDEX_UNDERLYINGS];

async function syncKiteInstruments() {
  console.log('🔄 Starting Kite instrument sync...');

  try {
    await kiteService.init();
    if (!kiteService.isSessionReady()) {
      console.log('❌ Kite session not ready. Cannot sync.');
      return { success: false, upserted: 0, reason: 'session not ready' };
    }

    const kite = kiteService.getKiteInstance();
    if (!kite) {
      console.log('❌ Kite instance not available.');
      return { success: false, upserted: 0, reason: 'no kite instance' };
    }

    console.log('📡 Fetching instruments...');
    const fetches = await Promise.allSettled([
      kite.getInstruments('MCX'),
      kite.getInstruments('NFO'),
      kite.getInstruments('BFO'),
      kite.getInstruments('NSE'),
    ]);

    const allInstruments = [];
    const labels = ['MCX', 'NFO', 'BFO', 'NSE'];
    fetches.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`  ${labels[i]}: ${r.value.length} instruments`);
        allInstruments.push(...r.value);
      } else {
        console.warn(`  ${labels[i]}: FAILED - ${r.reason?.message || 'unknown'}`);
      }
    });

    if (allInstruments.length === 0) {
      console.log('❌ No instruments fetched.');
      return { success: false, upserted: 0, reason: 'no instruments fetched' };
    }

    const { data: existing } = await supabase
      .from('symbols')
      .select('symbol, kite_instrument_token');

    const existingMap = new Map();
    for (const s of existing || []) {
      existingMap.set(s.symbol, s.kite_instrument_token);
    }

    const now = new Date();
    const toUpsert = [];

    for (const inst of allInstruments) {
      if (String(inst.instrument_type).toUpperCase() !== 'FUT') continue;
      if (inst.expiry && new Date(inst.expiry) < now) continue;

      const ts = String(inst.tradingsymbol || '').toUpperCase();
      const name = String(inst.name || '').toUpperCase();
      const exch = String(inst.exchange || '').toUpperCase();
      const token = Number(inst.instrument_token);

      if (!ts || !token) continue;

      let matched = null;
      for (const p of REQUIRED_PATTERNS) {
        if (p.match(ts, name, exch)) {
          matched = p;
          break;
        }
      }

      if (!matched) continue;
      if (existingMap.get(ts) === token) continue;

      const expiryDate = inst.expiry ? new Date(inst.expiry) : null;
      const expiryMonth = expiryDate ? MONTHS[expiryDate.getMonth()] : '';
      const expiryYear = expiryDate ? String(expiryDate.getFullYear()).slice(-2) : '';
      const displayName = expiryDate
        ? `${matched.prefix} ${expiryMonth} ${expiryYear} Futures`
        : `${matched.prefix} Futures`;

      toUpsert.push({
        symbol: ts,
        display_name: displayName,
        exchange: exch === 'NFO' ? 'NSE' : exch === 'BFO' ? 'BSE' : exch,
        category: matched.category,
        segment: exch,
        instrument_type: 'FUT',
        underlying: matched.underlying,
        kite_instrument_token: token,
        kite_tradingsymbol: ts,
        kite_exchange: exch,
        lot_size: 1,
        tick_size: Number(inst.tick_size || 0.05),
        original_lot_size: Number(inst.lot_size || 1),
        expiry_date: expiryDate ? expiryDate.toISOString().split('T')[0] : null,
        is_active: true,
        trading_hours: exch === 'MCX' ? '09:00-23:30' : '09:15-15:30',
        last_update: new Date().toISOString(),
      });
    }

    console.log(`📝 Instruments to upsert: ${toUpsert.length}`);

    if (toUpsert.length > 0) {
      for (const s of toUpsert) {
        const action = existingMap.has(s.symbol) ? 'UPDATE' : 'INSERT';
        console.log(`  ${action}: ${s.symbol} → token ${s.kite_instrument_token} (${s.display_name})`);
      }

      for (let i = 0; i < toUpsert.length; i += 50) {
        const batch = toUpsert.slice(i, i + 50);
        const { error } = await supabase
          .from('symbols')
          .upsert(batch, { onConflict: 'symbol' });

        if (error) {
          console.error(`  ❌ Batch error:`, error.message);
        } else {
          console.log(`  ✅ Batch: ${batch.length} symbols upserted`);
        }
      }
    }

    await fixNullTokens(allInstruments);
    await createRollingAliases(allInstruments);

    console.log('✅ Instrument sync complete!');
    return { success: true, upserted: toUpsert.length };
  } catch (error) {
    console.error('❌ Sync error:', error);
    return { success: false, upserted: 0, reason: error.message };
  }
}

async function fixNullTokens(allInstruments) {
  const { data: nullTokens } = await supabase
    .from('symbols')
    .select('symbol')
    .eq('is_active', true)
    .is('kite_instrument_token', null);

  if (!nullTokens || nullTokens.length === 0) return;

  console.log(`🔧 Fixing ${nullTokens.length} symbols with null tokens...`);

  const now = new Date();
  const instMap = new Map();
  for (const inst of allInstruments) {
    if (String(inst.instrument_type).toUpperCase() !== 'FUT') continue;
    if (inst.expiry && new Date(inst.expiry) < now) continue;
    instMap.set(String(inst.tradingsymbol).toUpperCase(), inst);
  }

  let fixed = 0;
  for (const sym of nullTokens) {
    const inst = instMap.get(sym.symbol);
    if (inst) {
      await supabase
        .from('symbols')
        .update({ kite_instrument_token: Number(inst.instrument_token) })
        .eq('symbol', sym.symbol);
      console.log(`  ✅ Fixed ${sym.symbol} → ${inst.instrument_token}`);
      fixed++;
    }
  }
  console.log(`  Fixed ${fixed} of ${nullTokens.length}`);
}

async function createRollingAliases(allInstruments) {
  const now = new Date();
  const byUnderlying = new Map();

  for (const inst of allInstruments) {
    if (String(inst.instrument_type).toUpperCase() !== 'FUT') continue;
    if (inst.expiry && new Date(inst.expiry) < now) continue;
    const name = String(inst.name || '').toUpperCase();
    if (!ALL_UNDERLYINGS.includes(name)) continue;
    if (!byUnderlying.has(name)) byUnderlying.set(name, []);
    byUnderlying.get(name).push(inst);
  }

  const seriesNames = ['I', 'II', 'III'];
  const seriesLabels = ['Near Month', 'Next Month', 'Far Month'];
  const aliases = [];

  for (const [underlying, instruments] of byUnderlying) {
    const sorted = instruments.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
    const picks = sorted.slice(0, 3);

    for (let i = 0; i < picks.length; i++) {
      const inst = picks[i];
      const aliasSymbol = `${underlying}-${seriesNames[i]}`;
      const exch = String(inst.exchange || '').toUpperCase();
      const month = MONTHS[new Date(inst.expiry).getMonth()];
      const year = String(new Date(inst.expiry).getFullYear()).slice(-2);
      const isCommodity = COMMODITY_UNDERLYINGS.includes(underlying);

      aliases.push({
        symbol: aliasSymbol,
        display_name: `${underlying} ${seriesLabels[i]} (${month}${year})`,
        exchange: exch === 'NFO' ? 'NSE' : exch === 'BFO' ? 'BSE' : exch,
        category: isCommodity ? 'commodity_futures' : 'index_futures',
        segment: exch,
        instrument_type: 'FUT',
        underlying,
        series: seriesNames[i],
        kite_instrument_token: Number(inst.instrument_token),
        kite_tradingsymbol: String(inst.tradingsymbol).toUpperCase(),
        kite_exchange: exch,
        lot_size: 1,
        tick_size: Number(inst.tick_size || 0.05),
        original_lot_size: Number(inst.lot_size || 1),
        expiry_date: inst.expiry ? new Date(inst.expiry).toISOString().split('T')[0] : null,
        is_active: true,
        trading_hours: isCommodity ? '09:00-23:30' : '09:15-15:30',
        last_update: new Date().toISOString(),
      });
    }
  }

  if (aliases.length > 0) {
    console.log(`📝 Creating ${aliases.length} rolling aliases...`);
    const { error } = await supabase
      .from('symbols')
      .upsert(aliases, { onConflict: 'symbol' });

    if (error) {
      console.error('  ❌ Alias upsert error:', error.message);
    } else {
      console.log(`  ✅ ${aliases.length} aliases created/updated`);
    }
  }
}

module.exports = { syncKiteInstruments };