// backend/src/services/marketDataService.js
const { supabase } = require('../config/supabase');
const kiteService = require('./kiteService');
const kiteStreamService = require('./kiteStreamService');

class MarketDataService {
  constructor() {
    this.metaCache = new Map();
    this.META_TTL = 60000; // 60s for static symbol metadata
  }

  /**
   * ✅ Get quote: memory cache first → DB fallback
   * NO simulation anywhere
   */
  async getQuote(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;

    // 1. Live price from kiteStreamService memory (instant)
    const live = kiteStreamService.getPrice(sym);

    // 2. Static metadata (lot_size, tick_size, display_name, etc.)
    let meta = this.metaCache.get(sym);
    if (!meta || Date.now() - meta.ts > this.META_TTL) {
      const { data, error } = await supabase
        .from('symbols')
        .select('*')
        .eq('symbol', sym)
        .single();

      if (error || !data) return null;
      meta = { d: data, ts: Date.now() };
      this.metaCache.set(sym, meta);
    }

    const d = meta.d;

    return {
      symbol: d.symbol,
      displayName: d.display_name,
      exchange: d.exchange,
      category: d.category,

      lastPrice: live ? live.last : Number(d.last_price || 0),
      bid: live ? live.bid : Number(d.bid || d.last_price || 0),
      ask: live ? live.ask : Number(d.ask || d.last_price || 0),

      open: live ? live.open : Number(d.open_price ?? d.open ?? 0),
      high: live ? live.high : Number(d.high_price ?? d.high ?? 0),
      low: live ? live.low : Number(d.low_price ?? d.low ?? 0),
      previousClose: live ? live.prevClose : Number(d.previous_close ?? 0),

      change: live ? live.change : Number(d.change_value || 0),
      changePercent: live ? live.changePct : Number(d.change_percent || 0),
      volume: live ? live.volume : Number(d.volume || 0),

      lotSize: Number(d.lot_size || 1),
      tickSize: Number(d.tick_size || 0.05),
      tradingHours: d.trading_hours || null,

      timestamp: live ? live.timestamp : Date.now(),
      source: live ? 'kite' : 'db',
    };
  }

  async getQuotes(symbols) {
    const out = {};
    for (const s of symbols || []) {
      const q = await this.getQuote(s);
      if (q) out[String(s).toUpperCase()] = q;
    }
    return out;
  }

  /** Candles from Kite historical API only */
  async getCandles(symbol, timeframe = '15m', count = 300) {
    try {
      const candles = await kiteService.getHistoricalCandles(
        String(symbol).toUpperCase(),
        timeframe,
        Number(count) || 300
      );
      return candles || [];
    } catch (e) {
      console.error('getCandles error:', e.message);
      return [];
    }
  }
}

module.exports = new MarketDataService();