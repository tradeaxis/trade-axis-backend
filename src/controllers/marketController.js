// backend/src/controllers/marketController.js
const { supabase } = require('../config/supabase');
const kiteService = require('../services/kiteService');
const kiteStreamService = require('../services/kiteStreamService');

const ALLOWED_CATEGORIES = [
  'index_futures',
  'stock_futures',
  'sensex_futures',
  'commodity_futures',
];

/** Get all futures symbols */
exports.getSymbols = async (req, res) => {
  try {
    const { category, search, limit = 5000 } = req.query;

    let allSymbols = [];
    const batchSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from('symbols')
        .select('*')
        .eq('is_active', true)
        .eq('instrument_type', 'FUT')
        .order('underlying', { ascending: true })
        .order('expiry_date', { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (category && ALLOWED_CATEGORIES.includes(category)) {
        query = query.eq('category', category);
      } else {
        query = query.in('category', ALLOWED_CATEGORIES);
      }

      if (search && search.trim()) {
        const term = search.trim();
        query = supabase
          .from('symbols')
          .select('*')
          .eq('is_active', true)
          .eq('instrument_type', 'FUT')
          .in('category', ALLOWED_CATEGORIES)
          .or(
            `symbol.ilike.%${term}%,display_name.ilike.%${term}%,underlying.ilike.%${term}%`
          )
          .order('underlying', { ascending: true })
          .order('expiry_date', { ascending: true })
          .range(offset, offset + batchSize - 1);
      }

      const { data: batch, error } = await query;
      if (error) throw error;

      if (batch && batch.length > 0) {
        allSymbols = allSymbols.concat(batch);
        offset += batchSize;
        if (batch.length < batchSize || allSymbols.length >= parseInt(limit))
          hasMore = false;
      } else {
        hasMore = false;
      }
      if (offset >= 10000) hasMore = false;
    }

    if (allSymbols.length > parseInt(limit)) {
      allSymbols = allSymbols.slice(0, parseInt(limit));
    }

    res.json({
      success: true,
      symbols: allSymbols,
      source: 'zerodha',
      total: allSymbols.length,
    });
  } catch (error) {
    console.error('getSymbols error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Get quote with live price from memory cache */
exports.getQuote = async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!symbol)
      return res.status(400).json({ success: false, message: 'Symbol required' });

    const sym = symbol.toUpperCase();

    const { data: dbSym, error } = await supabase
      .from('symbols')
      .select('*')
      .eq('symbol', sym)
      .single();

    if (error || !dbSym) {
      return res.status(404).json({ success: false, message: 'Symbol not found' });
    }

    // ✅ Overlay live price from memory cache
    const live = kiteStreamService.getPrice(sym);

    const quote = {
      ...dbSym,
      last_price: live ? live.last : dbSym.last_price,
      bid: live ? live.bid : dbSym.bid || dbSym.last_price,
      ask: live ? live.ask : dbSym.ask || dbSym.last_price,
      open_price: live ? live.open : dbSym.open_price,
      high_price: live ? live.high : dbSym.high_price,
      low_price: live ? live.low : dbSym.low_price,
      change_value: live ? live.change : dbSym.change_value,
      change_percent: live ? live.changePct : dbSym.change_percent,
    };

    res.json({
      success: true,
      quote,
      source: live ? 'kite_live' : 'database',
    });
  } catch (error) {
    console.error('getQuote error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Historical candles — Kite only, no simulation */
exports.getCandles = async (req, res) => {
  try {
    const { symbol } = req.params;
    const { timeframe = '15m', count = 300 } = req.query;

    const candles = await kiteService.getHistoricalCandles(
      symbol,
      timeframe,
      parseInt(count)
    );

    res.json({
      success: true,
      candles: candles || [],
      source: candles && candles.length > 0 ? 'kite' : 'none',
    });
  } catch (error) {
    console.error('getCandles error:', error);
    res.json({ success: true, candles: [], source: 'error' });
  }
};

/** Search symbols */
exports.searchSymbols = async (req, res) => {
  try {
    const { q, limit = 100 } = req.query;
    if (!q || q.trim().length < 1) {
      return res.json({ success: true, symbols: [] });
    }

    const term = q.trim();

    const { data: symbols, error } = await supabase
      .from('symbols')
      .select('*')
      .eq('is_active', true)
      .eq('instrument_type', 'FUT')
      .in('category', ALLOWED_CATEGORIES)
      .or(
        `symbol.ilike.%${term}%,display_name.ilike.%${term}%,underlying.ilike.%${term}%`
      )
      .order('underlying', { ascending: true })
      .order('expiry_date', { ascending: true })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ success: true, symbols: symbols || [], total: symbols?.length || 0 });
  } catch (error) {
    console.error('searchSymbols error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};