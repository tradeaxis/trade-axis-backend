// backend/src/services/kiteService.js
const { KiteConnect } = require('kiteconnect');
const { DateTime } = require('luxon');
const { supabase } = require('../config/supabase');

class KiteService {
  constructor() {
    this.apiKey = process.env.KITE_API_KEY;
    this.apiSecret = process.env.KITE_API_SECRET;
    this.kc = null;
    this.accessToken = null;
    this.initialized = false;
  }

  isConfigured() {
    return !!(this.apiKey && this.apiSecret);
  }

  async init() {
    if (this.initialized) return;
    
    if (!this.isConfigured()) {
      console.log('ℹ️ Kite not configured. Using simulated prices.');
      this.initialized = true;
      return;
    }

    try {
      this.kc = new KiteConnect({ api_key: this.apiKey });
      this.accessToken = await this.getAccessTokenFromDB();

      if (this.accessToken) {
        this.kc.setAccessToken(this.accessToken);
        console.log('✅ Kite access token loaded from DB.');
      } else {
        console.log('ℹ️ Kite access token not set yet.');
      }
    } catch (error) {
      console.error('❌ Kite init error:', error.message);
    }

    this.initialized = true;
  }

  async getAccessTokenFromDB() {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'kite_access_token')
        .single();

      if (error) return null;
      const token = (data?.value || '').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  async saveAccessTokenToDB(token) {
    try {
      const now = new Date().toISOString();
      
      const { data: existing } = await supabase
        .from('app_settings')
        .select('id')
        .eq('key', 'kite_access_token')
        .single();

      if (existing) {
        await supabase
          .from('app_settings')
          .update({ value: token, updated_at: now })
          .eq('key', 'kite_access_token');
      } else {
        await supabase
          .from('app_settings')
          .insert({ key: 'kite_access_token', value: token, updated_at: now });
      }
      
      console.log('✅ Kite access token saved to DB');
    } catch (err) {
      console.error('❌ Failed to save Kite token:', err.message);
    }
  }

  isSessionReady() {
    return !!(this.kc && this.accessToken);
  }

  getLoginURL() {
    if (!this.kc) {
      if (this.isConfigured()) {
        this.kc = new KiteConnect({ api_key: this.apiKey });
      } else {
        return null;
      }
    }
    return this.kc.getLoginURL();
  }

  async generateSession(requestToken) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Kite API credentials not configured in .env');
    }

    if (!requestToken) {
      throw new Error('Request token is required');
    }

    const cleanToken = requestToken.trim().replace(/['"]/g, '');

    if (!cleanToken) {
      throw new Error('Invalid request token');
    }

    this.kc = new KiteConnect({ api_key: this.apiKey });

    console.log('🔄 Generating Kite session...');
    console.log('   API Key:', this.apiKey);
    console.log('   API Secret length:', this.apiSecret?.length);
    console.log('   Token (first 10 chars):', cleanToken.substring(0, 10) + '...');

    try {
      const session = await this.kc.generateSession(cleanToken, this.apiSecret);
      
      if (!session || !session.access_token) {
        throw new Error('Invalid session response from Kite');
      }

      this.accessToken = session.access_token;
      this.kc.setAccessToken(this.accessToken);
      this.initialized = true;

      await this.saveAccessTokenToDB(this.accessToken);

      console.log('✅ Kite session created successfully');
      console.log('   User ID:', session.user_id);

      return {
        accessToken: this.accessToken,
        userId: session.user_id,
        userName: session.user_name,
        email: session.email,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error('❌ Kite generateSession error:', error.message);
      
      if (error.message.includes('Invalid `request_token`')) {
        throw new Error('Invalid or expired request token. Tokens expire in ~2 minutes. Please login again.');
      }
      if (error.message.includes('checksum')) {
        throw new Error('Invalid API secret. Please verify KITE_API_SECRET in .env matches your Kite app settings.');
      }
      if (error.message.includes('used')) {
        throw new Error('This request token has already been used. Please login again.');
      }

      throw new Error(`Kite session failed: ${error.message}`);
    }
  }

  getMonthName(date) {
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return months[new Date(date).getMonth()];
  }

  createShortDisplayName(instrument) {
    const name = String(instrument.name || '').toUpperCase();
    const expiry = instrument.expiry;

    if (!expiry) return `${name} FUT`;

    const month = this.getMonthName(expiry);
    const year = new Date(expiry).getFullYear().toString().slice(-2);

    return `${name} ${month}${year} FUT`;
  }

  async fetchFuturesInstruments() {
    await this.init();
    if (!this.isSessionReady()) {
      throw new Error('Kite session not ready. Please login first.');
    }

    console.log('📊 Fetching instruments from Kite...');

    const [nfo, mcx, bfo] = await Promise.all([
      this.kc.getInstruments('NFO').catch(() => []),
      this.kc.getInstruments('MCX').catch(() => []),
      this.kc.getInstruments('BFO').catch(() => []),
    ]);

    console.log(`   NFO: ${nfo.length}, MCX: ${mcx.length}, BFO: ${bfo.length}`);

    const all = [...nfo, ...mcx, ...bfo];

    // Filter FUT only (no options)
    return all.filter((i) => String(i.instrument_type).toUpperCase() === 'FUT');
  }

  /**
   * Sync ALL FUT instruments to Supabase.
   * ✅ IMPORTANT: lot_size = 1 (1 lot = 1 share for this platform)
   */
  async syncSymbolsToDB() {
    const instruments = await this.fetchFuturesInstruments();

    console.log(`📊 Fetched ${instruments.length} FUT instruments from Kite`);

    if (instruments.length === 0) {
      throw new Error('No futures instruments found. Session may have expired.');
    }

    const indexSet = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
    const sensexSet = new Set(['SENSEX', 'BANKEX']);
    const byUnderlying = new Map();
    const rows = [];

    // 1) Create a row for EACH actual contract
    for (const inst of instruments) {
      const tradingsymbol = String(inst.tradingsymbol).toUpperCase();
      const underlying = String(inst.name || '').toUpperCase();
      const exchange = String(inst.exchange || '').toUpperCase();

      if (!underlying) continue;

      // Determine category
      let category = 'stock_futures';
      if (exchange === 'MCX') category = 'commodity_futures';
      else if (sensexSet.has(underlying)) category = 'sensex_futures';
      else if (indexSet.has(underlying)) category = 'index_futures';

      const displayName = this.createShortDisplayName(inst);
      const expiryDate = inst.expiry
        ? new Date(inst.expiry).toISOString().slice(0, 10)
        : null;

      rows.push({
        symbol: tradingsymbol,
        display_name: displayName,
        exchange: exchange === 'NFO' ? 'NSE' : exchange === 'BFO' ? 'BSE' : 'MCX',
        category,
        segment: exchange,
        instrument_type: 'FUT',
        lot_size: 1, // ✅ 1 LOT = 1 SHARE
        tick_size: Number(inst.tick_size || 0.05),
        kite_exchange: exchange,
        kite_tradingsymbol: tradingsymbol,
        kite_instrument_token: inst.instrument_token,
        expiry_date: expiryDate,
        underlying,
        series: null,
        is_active: true,
        last_update: new Date().toISOString(),
        // Store original lot size for reference
        original_lot_size: Number(inst.lot_size || 1),
      });

      if (!byUnderlying.has(underlying)) byUnderlying.set(underlying, []);
      byUnderlying.get(underlying).push(inst);
    }

    // 2) Create rolling aliases: UNDERLYING-I / II / III
    const seriesNames = ['I', 'II', 'III'];
    const seriesLabels = ['Near Month', 'Next Month', 'Far Month'];

    for (const [underlying, list] of byUnderlying.entries()) {
      const sorted = [...list].sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
      const now = new Date();
      const active = sorted.filter((i) => new Date(i.expiry) >= now);
      const picks = active.slice(0, 3);

      for (let idx = 0; idx < picks.length; idx++) {
        const inst = picks[idx];
        const series = seriesNames[idx];
        const aliasSymbol = `${underlying}-${series}`;
        const exchange = String(inst.exchange || '').toUpperCase();

        let category = 'stock_futures';
        if (exchange === 'MCX') category = 'commodity_futures';
        else if (sensexSet.has(underlying)) category = 'sensex_futures';
        else if (indexSet.has(underlying)) category = 'index_futures';

        const month = this.getMonthName(inst.expiry);
        const year = new Date(inst.expiry).getFullYear().toString().slice(-2);

        rows.push({
          symbol: aliasSymbol,
          display_name: `${underlying} ${seriesLabels[idx]} (${month}${year})`,
          exchange: exchange === 'NFO' ? 'NSE' : exchange === 'BFO' ? 'BSE' : 'MCX',
          category,
          segment: exchange,
          instrument_type: 'FUT',
          lot_size: 1, // ✅ 1 LOT = 1 SHARE
          tick_size: Number(inst.tick_size || 0.05),
          kite_exchange: exchange,
          kite_tradingsymbol: String(inst.tradingsymbol).toUpperCase(),
          kite_instrument_token: inst.instrument_token,
          expiry_date: inst.expiry ? new Date(inst.expiry).toISOString().slice(0, 10) : null,
          underlying,
          series,
          is_active: true,
          last_update: new Date().toISOString(),
          original_lot_size: Number(inst.lot_size || 1),
        });
      }
    }

    console.log(`📝 Upserting ${rows.length} symbols (${byUnderlying.size} underlyings)...`);

    // Mark existing FUT symbols as inactive
    await supabase
      .from('symbols')
      .update({ is_active: false })
      .eq('instrument_type', 'FUT');

    // Upsert in chunks
    const chunkSize = 500;
    let upsertedCount = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase
        .from('symbols')
        .upsert(chunk, { onConflict: 'symbol' });

      if (error) {
        console.error('❌ syncSymbolsToDB chunk error:', error.message);
        throw error;
      }
      upsertedCount += chunk.length;
    }

    console.log(`✅ Synced ${upsertedCount} symbols (lot_size=1) from ${byUnderlying.size} underlyings`);

    return {
      count: upsertedCount,
      underlyings: byUnderlying.size,
      contracts: instruments.length,
      aliases: upsertedCount - instruments.length,
    };
  }

  async getHistoricalCandles(appSymbol, timeframe = '15m', count = 300) {
    await this.init();
    if (!this.isSessionReady()) return null;

    const { data: sym, error } = await supabase
      .from('symbols')
      .select('kite_instrument_token')
      .eq('symbol', String(appSymbol).toUpperCase())
      .single();

    if (error || !sym?.kite_instrument_token) return null;

    const intervalMap = {
      '1m': 'minute',
      '5m': '5minute',
      '15m': '15minute',
      '30m': '30minute',
      '1h': '60minute',
      '4h': '60minute',
      '1d': 'day',
      '1w': 'day',
      '1M': 'day',
    };

    const interval = intervalMap[timeframe] || '15minute';
    const now = DateTime.now().setZone('Asia/Kolkata');
    let from;

    switch (timeframe) {
      case '1m':
      case '5m':
        from = now.minus({ days: 5 });
        break;
      case '15m':
      case '30m':
        from = now.minus({ days: 15 });
        break;
      case '1h':
      case '4h':
        from = now.minus({ days: 60 });
        break;
      case '1d':
        from = now.minus({ days: 365 });
        break;
      default:
        from = now.minus({ days: 30 });
    }

    try {
      const raw = await this.kc.getHistoricalData(
        sym.kite_instrument_token,
        interval,
        from.toJSDate(),
        now.toJSDate(),
        false
      );

      return (raw || []).slice(-count).map((c) => ({
        time: Math.floor(new Date(c.date).getTime() / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      }));
    } catch (err) {
      console.error('getHistoricalCandles error:', err.message);
      return null;
    }
  }
}

module.exports = new KiteService();