// backend/src/services/kiteStreamService.js
const { KiteTicker } = require('kiteconnect');
const { supabase } = require('../config/supabase');
const kiteService = require('./kiteService');

class KiteStreamService {
  constructor() {
    this.ticker = null;
    this.io = null;
    this.running = false;
    this.tokenToSymbols = new Map();
    this.lastTickAt = null;

    this.priceCache = new Map();

    this.dirtySymbols = new Set();
    this.dbFlushInterval = null;
    this.DB_FLUSH_MS = 5000;
  }

  isRunning() {
    return this.running;
  }

  getPrice(symbol) {
    return this.priceCache.get(String(symbol).toUpperCase()) || null;
  }

  getPrices(symbols) {
    const out = {};
    for (const s of symbols) {
      const k = String(s).toUpperCase();
      const c = this.priceCache.get(k);
      if (c) out[k] = c;
    }
    return out;
  }

  async buildTokenMap() {
    const { data, error } = await supabase
      .from('symbols')
      .select('symbol, kite_instrument_token')
      .eq('is_active', true)
      .not('kite_instrument_token', 'is', null);

    if (error) throw error;

    const map = new Map();
    for (const row of data || []) {
      const token = Number(row.kite_instrument_token);
      if (!map.has(token)) map.set(token, []);
      map.get(token).push(row.symbol);
    }
    this.tokenToSymbols = map;
    return map;
  }

  async start(io) {
    this.io = io;

    await kiteService.init();
    if (!kiteService.isSessionReady()) {
      console.log('ℹ️ Kite session not ready. Stream not started.');
      return { started: false, reason: 'kite session not ready' };
    }

    await this.buildTokenMap();

    const tokens = Array.from(this.tokenToSymbols.keys());
    if (tokens.length === 0) {
      console.log('ℹ️ No kite instrument tokens found.');
      return { started: false, reason: 'no tokens' };
    }

    const apiKey = process.env.KITE_API_KEY;
    const accessToken = kiteService.accessToken;

    this.ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
    this.running = true;

    const mode = String(process.env.KITE_TICK_MODE || 'full').toLowerCase();

    this.ticker.on('connect', () => {
      console.log(`✅ KiteTicker connected. Subscribing ${tokens.length} tokens [${mode}]`);
      this.ticker.subscribe(tokens);
      this.ticker.setMode(mode, tokens);
    });

    this.ticker.on('ticks', (ticks) => {
      this.lastTickAt = new Date().toISOString();
      this.handleTicks(ticks);
    });

    this.ticker.on('error', (err) => {
      console.error('❌ KiteTicker error:', err?.message || err);
    });

    this.ticker.on('close', () => {
      console.log('❌ KiteTicker closed');
      this.running = false;
    });

    this.ticker.on('reconnect', () => {
      console.log('🔄 KiteTicker reconnecting...');
      this.running = true;
    });

    this.ticker.connect();
    this.startDBFlush();

    return { started: true, tokens: tokens.length, mode };
  }

  async stop() {
    try {
      if (this.dbFlushInterval) {
        clearInterval(this.dbFlushInterval);
        this.dbFlushInterval = null;
      }
      await this.flushToDB();
      if (this.ticker) {
        this.ticker.disconnect();
        this.ticker = null;
      }
    } finally {
      this.running = false;
    }
    return { stopped: true };
  }

  handleTicks(ticks) {
    if (!ticks || ticks.length === 0) return;

    for (const t of ticks) {
      const token = Number(t.instrument_token);
      const symbols = this.tokenToSymbols.get(token);
      if (!symbols || symbols.length === 0) continue;

      const last = Number(t.last_price || 0);
      if (last <= 0) continue;

      const ohlc = t.ohlc || {};
      const prevClose = Number(ohlc.close || 0);
      const chgVal = prevClose ? last - prevClose : 0;
      const chgPct = prevClose ? (chgVal / prevClose) * 100 : 0;

      let bid = last;
      let ask = last;
      if (t.depth?.buy?.length && t.depth.buy[0].price > 0) {
        bid = Number(t.depth.buy[0].price);
      }
      if (t.depth?.sell?.length && t.depth.sell[0].price > 0) {
        ask = Number(t.depth.sell[0].price);
      }

      const priceData = {
        last,
        bid,
        ask,
        open: Number(ohlc.open || last),
        high: Number(ohlc.high || last),
        low: Number(ohlc.low || last),
        prevClose: prevClose || last,
        change: parseFloat(chgVal.toFixed(2)),
        changePct: parseFloat(chgPct.toFixed(2)),
        volume: Number(t.volume_traded || t.volume || 0),
        timestamp: Date.now(),
      };

      for (const s of symbols) {
        this.priceCache.set(s, priceData);
        this.dirtySymbols.add(s);

        this.io?.to(`symbol:${s}`).emit('price:update', {
          symbol: s,
          bid,
          ask,
          last,
          open: priceData.open,
          high: priceData.high,
          low: priceData.low,
          change: priceData.change,
          changePercent: priceData.changePct,
          volume: priceData.volume,
          timestamp: priceData.timestamp,
          source: 'kite',
        });
      }
    }
  }

  startDBFlush() {
    if (this.dbFlushInterval) clearInterval(this.dbFlushInterval);

    this.dbFlushInterval = setInterval(() => {
      this.flushToDB().catch((err) =>
        console.error('DB flush error:', err.message)
      );
    }, this.DB_FLUSH_MS);

    console.log(`💾 DB price flush every ${this.DB_FLUSH_MS / 1000}s`);
  }

  async flushToDB() {
    if (this.dirtySymbols.size === 0) return;

    const toFlush = [...this.dirtySymbols];
    this.dirtySymbols.clear();
    const now = new Date().toISOString();

    const groups = new Map();
    for (const sym of toFlush) {
      const p = this.priceCache.get(sym);
      if (!p) continue;
      const key = `${p.last}|${p.bid}|${p.ask}`;
      if (!groups.has(key)) groups.set(key, { price: p, symbols: [] });
      groups.get(key).symbols.push(sym);
    }

    const promises = [];
    for (const [, { price, symbols }] of groups) {
      promises.push(
        supabase
          .from('symbols')
          .update({
            last_price: price.last,
            bid: price.bid,
            ask: price.ask,
            open_price: price.open,
            high_price: price.high,
            low_price: price.low,
            previous_close: price.prevClose,
            change_value: price.change,
            change_percent: price.changePct,
            volume: price.volume,
            last_update: now,
          })
          .in('symbol', symbols)
      );
    }

    await Promise.all(promises);
  }

  status() {
    return {
      running: this.running,
      lastTickAt: this.lastTickAt,
      tokenCount: this.tokenToSymbols?.size || 0,
      cachedPrices: this.priceCache.size,
      pendingDBWrites: this.dirtySymbols.size,
    };
  }

  /**
   * Rebuild token map and resubscribe — call after syncing new instruments
   */
  async refreshSubscriptions() {
    if (!this.ticker || !this.running) {
      console.log('ℹ️ Ticker not running, skip refresh');
      return { refreshed: false };
    }

    const oldCount = this.tokenToSymbols.size;
    await this.buildTokenMap();
    const newCount = this.tokenToSymbols.size;

    const tokens = Array.from(this.tokenToSymbols.keys());
    const mode = String(process.env.KITE_TICK_MODE || 'full').toLowerCase();

    this.ticker.subscribe(tokens);
    this.ticker.setMode(mode, tokens);

    console.log(`🔄 Refreshed subscriptions: ${oldCount} → ${newCount} tokens`);
    return { refreshed: true, oldCount, newCount };
  }
}

module.exports = new KiteStreamService();