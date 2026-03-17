// backend/src/controllers/tradingController.js
const { supabase } = require('../config/supabase');
const kiteStreamService = require('../services/kiteStreamService');
const { isMarketOpen, getHolidayStatus } = require('../services/marketStatus');


// ============ GET POSITIONS ============
exports.getPositions = async (req, res) => {
  try {
    const { accountId } = req.params;
    const userId = req.user.id;

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .order('open_time', { ascending: false });

    if (error) throw error;

    res.json({ success: true, data: trades || [] });
  } catch (error) {
    console.error('Get positions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch positions' });
  }
};

// ============ GET PENDING ORDERS ============
exports.getPendingOrders = async (req, res) => {
  try {
    const { accountId } = req.params;
    const userId = req.user.id;

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const { data: orders, error } = await supabase
      .from('pending_orders')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      console.log('Pending orders table may not exist:', error.message);
      return res.json({ success: true, data: [] });
    }

    res.json({ success: true, data: orders || [] });
  } catch (error) {
    console.error('Get pending orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pending orders' });
  }
};

// ============ PLACE ORDER ============
exports.placeOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      accountId, symbol, type, orderType = 'market', quantity,
      price = 0, stopLoss = 0, takeProfit = 0, slippage = 3, comment = '',
    } = req.body;

    if (!accountId || !symbol || !type || !quantity) {
      return res.status(400).json({ success: false, message: 'Missing required fields: accountId, symbol, type, quantity' });
    }

    if (quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be greater than 0' });
    }

    // ════════════════════════════════════════
    //  MARKET HOURS CHECK
    // ════════════════════════════════════════
    if (!isMarketOpen()) {
      const holiday = getHolidayStatus();
      const reason = holiday.isHoliday
        ? `Market Holiday: ${holiday.message || 'Market is closed today by admin.'}`
        : 'Market is closed. Orders can only be placed between 9:15 AM and 3:30 PM IST, Monday to Friday.';
      return res.status(400).json({
        success: false,
        message: reason,
      });
    }

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('closing_mode, brokerage_rate')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    const closingMode = userData?.closing_mode || false;
    const userBrokerageRate = userData?.brokerage_rate || 0.0003;

    if (closingMode && type === 'buy') {
      return res.status(403).json({
        success: false,
        message: 'Your account is in closing mode. You can only close existing positions (sell). Contact admin for assistance.',
      });
    }

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const { data: symbolData, error: symbolError } = await supabase
      .from('symbols')
      .select('*')
      .eq('symbol', symbol.toUpperCase())
      .single();

    if (symbolError || !symbolData) {
      return res.status(404).json({ success: false, message: 'Symbol not found' });
    }

    // ════════════════════════════════════════
    //  PENDING ORDER TYPES (Buy Limit, Sell Limit, Buy Stop, Sell Stop)
    // ════════════════════════════════════════
    if (orderType !== 'market' && orderType !== 'instant') {
      // Validate pending order type
      const validPendingTypes = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'];
      if (!validPendingTypes.includes(orderType)) {
        return res.status(400).json({ success: false, message: `Invalid order type: ${orderType}` });
      }

      if (!price || price <= 0) {
        return res.status(400).json({ success: false, message: 'Price is required for limit/stop orders' });
      }

      // Get current market price for validation
      const kiteStreamService = require('../services/kiteStreamService');
      const livePrice = kiteStreamService.getPrice(symbol.toUpperCase());
      const currentBid = livePrice?.bid || parseFloat(symbolData.bid || symbolData.last_price || 0);
      const currentAsk = livePrice?.ask || parseFloat(symbolData.ask || symbolData.last_price || 0);
      const cmp = type === 'buy' ? currentAsk : currentBid;

      // Buy Limit: price must be ≤ 0.5% below CMP
      if (orderType === 'buy_limit' && price > cmp * 0.995) {
        return res.status(400).json({
          success: false,
          message: `Buy Limit price must be at least 0.5% below current price. Max: ₹${(cmp * 0.995).toFixed(2)}`,
        });
      }

      // Sell Limit: price must be ≥ 0.5% above CMP
      if (orderType === 'sell_limit' && price < cmp * 1.005) {
        return res.status(400).json({
          success: false,
          message: `Sell Limit price must be at least 0.5% above current price. Min: ₹${(cmp * 1.005).toFixed(2)}`,
        });
      }

      // Create pending order
      try {
        const pendingOrderData = {
          user_id: userId,
          account_id: accountId,
          symbol: symbolData.symbol,
          exchange: symbolData.exchange || 'NSE',
          order_type: orderType,
          trade_type: type,
          quantity: parseFloat(quantity),
          price: parseFloat(price),
          stop_loss: parseFloat(stopLoss) || 0,
          take_profit: parseFloat(takeProfit) || 0,
          status: 'pending',
          comment,
          created_at: new Date().toISOString(),
        };

        const { data: pendingOrder, error: poError } = await supabase
          .from('pending_orders')
          .insert(pendingOrderData)
          .select()
          .single();

        if (poError) {
          console.error('Pending order insert error:', poError);
          return res.status(400).json({ success: false, message: 'Failed to create pending order. Table may not exist.' });
        }

        return res.json({
          success: true,
          data: pendingOrder,
          pending: true,
          message: `${orderType.replace('_', ' ').toUpperCase()} order placed at ₹${parseFloat(price).toFixed(2)}`,
        });
      } catch (pendErr) {
        console.error('Pending order error:', pendErr);
        return res.status(400).json({ success: false, message: 'Pending orders not supported yet. Use market orders.' });
      }
    }

    // ════════════════════════════════════════
    //  MARKET ORDER EXECUTION
    // ════════════════════════════════════════

    // Use live price from memory cache
    const kiteStreamService = require('../services/kiteStreamService');
    const livePrice = kiteStreamService.getPrice(symbol.toUpperCase());

    let openPrice;
    if (livePrice) {
      openPrice = type === 'buy' ? livePrice.ask : livePrice.bid;
    } else {
      openPrice = type === 'buy'
        ? parseFloat(symbolData.ask || symbolData.last_price)
        : parseFloat(symbolData.bid || symbolData.last_price);
    }

    if (!openPrice || openPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid price. Market may be closed.' });
    }

    const lotSize = 1;
    const leverage = account.leverage || 5;
    const marginRequired = (openPrice * parseFloat(quantity) * lotSize) / leverage;

    const freeMargin = parseFloat(account.free_margin || account.balance);
    if (marginRequired > freeMargin) {
      return res.status(400).json({
        success: false,
        message: `Insufficient margin. Required: ₹${marginRequired.toFixed(2)}, Available: ₹${freeMargin.toFixed(2)}`,
      });
    }

    const brokerageRate = userBrokerageRate;
    // Commission on entry for BOTH buy and sell orders
    const entryBrokerage = openPrice * parseFloat(quantity) * lotSize * brokerageRate;
    const buyBrokerage = entryBrokerage; // "buy_brokerage" column stores entry-side brokerage regardless of direction

    // ════════════════════════════════════════
    //  POSITION MERGING — Same symbol + same direction → merge
    // ════════════════════════════════════════
    const { data: existingTrades } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('symbol', symbolData.symbol)
      .eq('trade_type', type)
      .eq('status', 'open');

    if (existingTrades && existingTrades.length > 0) {
      // Merge into existing position
      const existing = existingTrades[0];
      const oldQty = parseFloat(existing.quantity);
      const oldPrice = parseFloat(existing.open_price);
      const addQty = parseFloat(quantity);
      const newQty = oldQty + addQty;
      const newAvgPrice = ((oldPrice * oldQty) + (openPrice * addQty)) / newQty;

      const additionalMargin = marginRequired;
      const additionalBrokerage = buyBrokerage;
      const newTotalMargin = parseFloat(existing.margin || 0) + additionalMargin;
      const newBuyBrokerage = parseFloat(existing.buy_brokerage || existing.brokerage || 0) + additionalBrokerage;

      // Recalculate P&L with new average
      const currentPrice = parseFloat(existing.current_price || openPrice);
      const direction = type === 'buy' ? 1 : -1;
      const newProfit = ((currentPrice - newAvgPrice) * direction * newQty * lotSize) - newBuyBrokerage;

      const now = new Date().toISOString();

      const { data: updatedTrade, error: updateError } = await supabase
        .from('trades')
        .update({
          quantity: newQty,
          open_price: newAvgPrice,
          margin: newTotalMargin,
          brokerage: newBuyBrokerage,
          buy_brokerage: newBuyBrokerage,
          profit: newProfit,
          current_price: currentPrice,
          stop_loss: parseFloat(stopLoss) || parseFloat(existing.stop_loss) || 0,
          take_profit: parseFloat(takeProfit) || parseFloat(existing.take_profit) || 0,
          comment: `${existing.comment || ''} [+${addQty}@${openPrice.toFixed(2)}]`.trim(),
          updated_at: now,
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Update account margins
      const newAccountMargin = parseFloat(account.margin || 0) + additionalMargin;
      const newFreeMargin = parseFloat(account.balance) - newAccountMargin;

      await supabase
        .from('accounts')
        .update({
          margin: newAccountMargin,
          free_margin: Math.max(0, newFreeMargin),
          updated_at: now,
        })
        .eq('id', accountId);

      return res.json({
        success: true,
        data: updatedTrade,
        merged: true,
        message: `Merged into existing position. New qty: ${newQty}, Avg price: ₹${newAvgPrice.toFixed(2)}`,
      });
    }

    // ════════════════════════════════════════
    //  NO EXISTING POSITION — Create new trade
    // ════════════════════════════════════════
    const tradeData = {
      user_id: userId,
      account_id: accountId,
      symbol: symbolData.symbol,
      exchange: symbolData.exchange || 'NSE',
      trade_type: type,
      quantity: parseFloat(quantity),
      open_price: openPrice,
      current_price: openPrice,
      stop_loss: parseFloat(stopLoss) || 0,
      take_profit: parseFloat(takeProfit) || 0,
      margin: marginRequired,
      brokerage: buyBrokerage,
      buy_brokerage: buyBrokerage,
      sell_brokerage: 0,

      // ✅ immediately reflect entry commission in floating P&L
      profit: -buyBrokerage,

      status: 'open',
      comment,
      open_time: new Date().toISOString(),
    };

    const { data: trade, error: tradeError } = await supabase
      .from('trades')
      .insert(tradeData)
      .select()
      .single();

    if (tradeError) {
      console.error('Supabase insert trade error:', tradeError);
      return res.status(400).json({ success: false, message: tradeError.message || 'Failed to create trade', details: tradeError });
    }

    const newMargin = parseFloat(account.margin || 0) + marginRequired;
    const newFreeMargin = parseFloat(account.balance) - newMargin;

    await supabase
      .from('accounts')
      .update({ margin: newMargin, free_margin: newFreeMargin, updated_at: new Date().toISOString() })
      .eq('id', accountId);

    res.json({ success: true, data: trade, message: `${type.toUpperCase()} order executed at ${openPrice}` });
  } catch (error) {
    console.error('Place order error:', error);
    res.status(500).json({ success: false, message: 'Failed to place order' });
  }
};

// ============ CLOSE POSITION ============
exports.closePosition = async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { accountId, closeQuantity } = req.body;
    const userId = req.user.id;

    // ✅ Better validation with specific messages
    if (!tradeId) {
      return res.status(400).json({ success: false, message: 'Trade ID is required' });
    }
    if (!accountId) {
      return res.status(400).json({ success: false, message: 'Account ID is required' });
    }

    // Block close when market is off (unless admin override via header)
    const isAdminClose = req.headers['x-admin-close'] === 'true';
    if (!isMarketOpen() && !isAdminClose) {
      const holiday = getHolidayStatus();
      const reason = holiday.isHoliday
        ? `Market Holiday: ${holiday.message || 'Market is closed today.'}`
        : 'Market is closed. Positions cannot be closed outside trading hours.';
      return res.status(400).json({ success: false, message: reason });
    }

    // Verify trade ownership
    const { data: trade, error: tradeError } = await supabase
      .from('trades')
      .select('*, accounts!inner(user_id, balance, margin)')
      .eq('id', tradeId)
      .eq('status', 'open')
      .single();

    if (tradeError || !trade) {
      console.error('Trade lookup error:', tradeError?.message, 'tradeId:', tradeId);
      return res.status(404).json({ success: false, message: 'Trade not found or already closed' });
    }

    if (trade.accounts.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Get user brokerage rate
    const { data: userData } = await supabase
      .from('users')
      .select('brokerage_rate')
      .eq('id', userId)
      .single();

    const brokerageRate = userData?.brokerage_rate || 0.0003;

    // ✅ FIXED: Use .limit(1) instead of .single() to avoid crash on duplicates
    const { data: symbolRows, error: symbolError } = await supabase
      .from('symbols')
      .select('bid, ask, lot_size')
      .eq('symbol', trade.symbol)
      .limit(1);

    const symbolData = symbolRows?.[0] || null;

    // ✅ FIXED: Fallback to trade's current/open price if symbol not found
    // ✅ Use live price from memory cache first
    const kiteStreamService = require('../services/kiteStreamService');
    const livePrice = kiteStreamService.getPrice(trade.symbol);

    let closePrice;
    if (livePrice) {
      closePrice = trade.trade_type === 'buy' ? livePrice.bid : livePrice.ask;
    } else if (symbolError || !symbolData) {
      console.warn(`Symbol "${trade.symbol}" not found, using trade current_price`);
      closePrice = parseFloat(trade.current_price || trade.open_price);
    } else {
      closePrice = trade.trade_type === 'buy' 
        ? parseFloat(symbolData.bid || symbolData.ask || trade.current_price || trade.open_price) 
        : parseFloat(symbolData.ask || symbolData.bid || trade.current_price || trade.open_price);
    }
    // ✅ Validate close price
    if (!closePrice || isNaN(closePrice) || closePrice <= 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot determine close price for ${trade.symbol}. Market data unavailable.`,
      });
    }

    // Handle partial close
    const tradeQuantity = parseFloat(trade.quantity);
    const quantityToClose = closeQuantity ? Math.min(parseFloat(closeQuantity), tradeQuantity) : tradeQuantity;
    const isFullClose = quantityToClose >= tradeQuantity;

    // Calculate P&L
    const direction = trade.trade_type === 'buy' ? 1 : -1;
    const priceDiff = (closePrice - parseFloat(trade.open_price)) * direction;
    const lotSize = 1;
    const grossProfit = priceDiff * quantityToClose * lotSize;
    
    const sellBrokerage = closePrice * quantityToClose * lotSize * brokerageRate;
    const buyBrokerageProportional = (parseFloat(trade.buy_brokerage || trade.brokerage || 0) / tradeQuantity) * quantityToClose;
    const totalBrokerage = buyBrokerageProportional + sellBrokerage;
    const netProfit = grossProfit - totalBrokerage;

    const closeTime = new Date().toISOString();

    if (isFullClose) {
      const { data: closedTrade, error: updateError } = await supabase
        .from('trades')
        .update({
          close_price: closePrice,
          profit: netProfit,
          sell_brokerage: sellBrokerage,
          brokerage: totalBrokerage,
          status: 'closed',
          close_time: closeTime,
          updated_at: closeTime,
        })
        .eq('id', tradeId)
        .select()
        .single();

      if (updateError) throw updateError;

      const newBalance = parseFloat(trade.accounts.balance) + netProfit;
      const newMargin = Math.max(0, parseFloat(trade.accounts.margin) - parseFloat(trade.margin || 0));
      const newFreeMargin = newBalance - newMargin;

      await supabase
        .from('accounts')
        .update({ balance: newBalance, margin: newMargin, free_margin: newFreeMargin, updated_at: closeTime })
        .eq('id', accountId);

      res.json({
        success: true,
        data: closedTrade,
        message: `Position closed at ${closePrice}. P&L: ₹${netProfit.toFixed(2)}`,
      });
    } else {
      const remainingQuantity = tradeQuantity - quantityToClose;
      const remainingBuyBrokerage = (parseFloat(trade.buy_brokerage || trade.brokerage || 0) / tradeQuantity) * remainingQuantity;
      const remainingMargin = (parseFloat(trade.margin || 0) / tradeQuantity) * remainingQuantity;

      await supabase
        .from('trades')
        .update({
          quantity: remainingQuantity,
          margin: remainingMargin,
          buy_brokerage: remainingBuyBrokerage,
          brokerage: remainingBuyBrokerage,
          updated_at: closeTime,
        })
        .eq('id', tradeId);

      const newBalance = parseFloat(trade.accounts.balance) + netProfit;
      const closedMargin = (parseFloat(trade.margin || 0) / tradeQuantity) * quantityToClose;
      const newMargin = Math.max(0, parseFloat(trade.accounts.margin) - closedMargin);
      const newFreeMargin = newBalance - newMargin;

      await supabase
        .from('accounts')
        .update({ balance: newBalance, margin: newMargin, free_margin: newFreeMargin, updated_at: closeTime })
        .eq('id', accountId);

      res.json({
        success: true,
        message: `Partially closed ${quantityToClose} of ${tradeQuantity}. P&L: ₹${netProfit.toFixed(2)}. Remaining: ${remainingQuantity}`,
        data: { closedQuantity: quantityToClose, remainingQuantity, profit: netProfit },
      });
    }
  } catch (error) {
    console.error('Close position error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to close position' });
  }
};

// ============ PARTIAL CLOSE ============
exports.partialClose = async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { accountId, volume } = req.body;

    if (!tradeId || !accountId || !volume) {
      return res.status(400).json({ success: false, message: 'Trade ID, Account ID, and volume are required' });
    }

    req.body.closeQuantity = volume;
    return exports.closePosition(req, res);
  } catch (error) {
    console.error('Partial close error:', error);
    res.status(500).json({ success: false, message: 'Failed to partial close position' });
  }
};

// ============ MODIFY POSITION ============
exports.modifyPosition = async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { stopLoss, takeProfit } = req.body;
    const userId = req.user.id;

    if (!tradeId) {
      return res.status(400).json({ success: false, message: 'Trade ID is required' });
    }

    const { data: trade, error: tradeError } = await supabase
      .from('trades')
      .select('*, accounts!inner(user_id)')
      .eq('id', tradeId)
      .eq('status', 'open')
      .single();

    if (tradeError || !trade) {
      return res.status(404).json({ success: false, message: 'Trade not found or already closed' });
    }

    if (trade.accounts.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { data: updatedTrade, error: updateError } = await supabase
      .from('trades')
      .update({
        stop_loss: parseFloat(stopLoss) || 0,
        take_profit: parseFloat(takeProfit) || 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', tradeId)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({ success: true, data: updatedTrade, message: 'Position modified successfully' });
  } catch (error) {
    console.error('Modify position error:', error);
    res.status(500).json({ success: false, message: 'Failed to modify position' });
  }
};

// ============ CLOSE ALL POSITIONS ============
exports.closeAllPositions = async (req, res) => {
  try {
    const { accountId, filterType = 'all', tradeIds = [] } = req.body;
    const userId = req.user.id;

    if (!accountId) {
      return res.status(400).json({ success: false, message: 'Account ID is required' });
    }

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const { data: userData } = await supabase
      .from('users')
      .select('brokerage_rate')
      .eq('id', userId)
      .single();

    const brokerageRate = userData?.brokerage_rate || 0.0003;

    let query = supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'open');

    if (tradeIds.length > 0) {
      query = query.in('id', tradeIds);
    }

    const { data: trades, error: tradesError } = await query;
    if (tradesError) throw tradesError;

    if (!trades || trades.length === 0) {
      return res.status(400).json({ success: false, message: 'No open positions to close' });
    }

    let tradesToClose = trades;
    if (filterType === 'profitable') {
      tradesToClose = trades.filter((t) => parseFloat(t.profit || 0) > 0);
    } else if (filterType === 'losing') {
      tradesToClose = trades.filter((t) => parseFloat(t.profit || 0) < 0);
    }

    if (tradesToClose.length === 0) {
      return res.status(400).json({ success: false, message: `No ${filterType} positions to close` });
    }

    const closeTime = new Date().toISOString();
    let totalProfit = 0;
    let totalMarginFreed = 0;

    for (const trade of tradesToClose) {
      // ✅ Use .limit(1) instead of .single()
      const { data: symbolRows } = await supabase
        .from('symbols')
        .select('bid, ask, lot_size')
        .eq('symbol', trade.symbol)
        .limit(1);

      const symbolData = symbolRows?.[0];

      // ✅ Use live price from memory cache
      const kiteStreamService = require('../services/kiteStreamService');
      const liveP = kiteStreamService.getPrice(trade.symbol);

      let closePrice;
      if (liveP) {
        closePrice = trade.trade_type === 'buy' ? liveP.bid : liveP.ask;
      } else if (!symbolData) {
        closePrice = parseFloat(trade.current_price || trade.open_price);
      } else {
        closePrice = trade.trade_type === 'buy' 
          ? parseFloat(symbolData.bid || trade.current_price || trade.open_price) 
          : parseFloat(symbolData.ask || trade.current_price || trade.open_price);
      }

      if (!closePrice || isNaN(closePrice)) continue;

      const direction = trade.trade_type === 'buy' ? 1 : -1;
      const priceDiff = (closePrice - parseFloat(trade.open_price)) * direction;
      const lotSize = 1;
      const grossProfit = priceDiff * trade.quantity * lotSize;
      
      const sellBrokerage = closePrice * trade.quantity * lotSize * brokerageRate;
      const buyBrokerage = parseFloat(trade.buy_brokerage || trade.brokerage || 0);
      const totalBrokerage = buyBrokerage + sellBrokerage;
      const netProfit = grossProfit - totalBrokerage;

      totalProfit += netProfit;
      totalMarginFreed += parseFloat(trade.margin || 0);

      await supabase
        .from('trades')
        .update({
          close_price: closePrice,
          profit: netProfit,
          sell_brokerage: sellBrokerage,
          brokerage: totalBrokerage,
          status: 'closed',
          close_time: closeTime,
        })
        .eq('id', trade.id);
    }

    const newBalance = parseFloat(account.balance) + totalProfit;
    const newMargin = Math.max(0, parseFloat(account.margin) - totalMarginFreed);
    await supabase
      .from('accounts')
      .update({ balance: newBalance, margin: newMargin, free_margin: newBalance - newMargin, updated_at: closeTime })
      .eq('id', accountId);

    res.json({
      success: true,
      data: { closedCount: tradesToClose.length, totalProfit },
      message: `Closed ${tradesToClose.length} position(s). Total P&L: ₹${totalProfit.toFixed(2)}`,
    });
  } catch (error) {
    console.error('Close all positions error:', error);
    res.status(500).json({ success: false, message: 'Failed to close positions' });
  }
};

exports.modifyPendingOrder = async (req, res) => {
  res.json({ success: true, message: 'Not implemented' });
};

exports.cancelPendingOrder = async (req, res) => {
  res.json({ success: true, message: 'Not implemented' });
};

exports.cancelAllPendingOrders = async (req, res) => {
  res.json({ success: true, message: 'Not implemented' });
};

exports.getTradeHistory = async (req, res) => {
  try {
    const { accountId, period, symbol, limit = 100 } = req.query;
    const userId = req.user.id;

    if (!accountId) {
      return res.status(400).json({ success: false, message: 'Account ID is required' });
    }

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    let query = supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'closed')
      .order('close_time', { ascending: false })
      .limit(parseInt(limit));

    if (symbol) {
      query = query.eq('symbol', symbol.toUpperCase());
    }

    if (period) {
      const now = new Date();
      let startDate;

      switch (period) {
        case 'today':
          startDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case 'week':
          startDate = new Date(now.setDate(now.getDate() - 7));
          break;
        case 'month':
          startDate = new Date(now.setMonth(now.getMonth() - 1));
          break;
        case '3months':
          startDate = new Date(now.setMonth(now.getMonth() - 3));
          break;
        default:
          startDate = new Date(now.setMonth(now.getMonth() - 3));
      }

      if (startDate) {
        query = query.gte('close_time', startDate.toISOString());
      }
    } else {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      query = query.gte('close_time', threeMonthsAgo.toISOString());
    }

    const { data: trades, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: trades || [] });
  } catch (error) {
    console.error('Get trade history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch trade history' });
  }
};

exports.getTradeStats = async (req, res) => {
  try {
    const { accountId, period = 'all' } = req.query;
    const userId = req.user.id;

    if (!accountId) {
      return res.status(400).json({ success: false, message: 'Account ID is required' });
    }

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'closed');

    if (error) throw error;

    const allTrades = trades || [];
    const winningTrades = allTrades.filter((t) => parseFloat(t.profit || 0) > 0);
    const losingTrades = allTrades.filter((t) => parseFloat(t.profit || 0) < 0);

    const totalProfit = winningTrades.reduce((sum, t) => sum + parseFloat(t.profit || 0), 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + parseFloat(t.profit || 0), 0));
    const totalCommission = allTrades.reduce((sum, t) => sum + parseFloat(t.brokerage || 0), 0);

    const stats = {
      totalTrades: allTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: allTrades.length > 0 ? (winningTrades.length / allTrades.length) * 100 : 0,
      totalProfit,
      totalLoss,
      netPnL: totalProfit - totalLoss,
      totalCommission,
      profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Get trade stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch trade statistics' });
  }
};

// ============ ADD QUANTITY TO EXISTING POSITION ============
exports.addQuantity = async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { accountId, quantity } = req.body;
    const userId = req.user.id;

    if (!tradeId || !accountId || !quantity || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Trade ID, Account ID, and valid quantity are required',
      });
    }

    // Check closing mode
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('closing_mode, brokerage_rate')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    if (userData?.closing_mode) {
      return res.status(403).json({
        success: false,
        message: 'Your account is in closing mode. You cannot add to positions.',
      });
    }

    const brokerageRate = userData?.brokerage_rate || 0.0003;

    // Get the existing trade
    const { data: trade, error: tradeError } = await supabase
      .from('trades')
      .select('*, accounts!inner(user_id, balance, margin, free_margin, leverage)')
      .eq('id', tradeId)
      .eq('status', 'open')
      .single();

    if (tradeError || !trade) {
      return res.status(404).json({
        success: false,
        message: 'Trade not found or already closed',
      });
    }

    if (trade.accounts.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Get current market price
    const { data: symbolRows } = await supabase
      .from('symbols')
      .select('bid, ask, last_price')
      .eq('symbol', trade.symbol)
      .limit(1);

    const symbolData = symbolRows?.[0];
    if (!symbolData) {
      return res.status(400).json({
        success: false,
        message: `Market data unavailable for ${trade.symbol}`,
      });
    }

    // New fill price (same logic as opening — buy at ask, sell at bid)
    const addPrice = trade.trade_type === 'buy'
      ? parseFloat(symbolData.ask || symbolData.last_price)
      : parseFloat(symbolData.bid || symbolData.last_price);

    if (!addPrice || addPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid price. Market may be closed.',
      });
    }

    const addQty = parseFloat(quantity);
    const oldQty = parseFloat(trade.quantity);
    const oldPrice = parseFloat(trade.open_price);
    const leverage = trade.accounts.leverage || 5;
    const lotSize = 1;

    // Calculate additional margin
    const additionalMargin = (addPrice * addQty * lotSize) / leverage;
    const freeMargin = parseFloat(trade.accounts.free_margin || 0);

    if (additionalMargin > freeMargin) {
      return res.status(400).json({
        success: false,
        message: `Insufficient margin. Required: ₹${additionalMargin.toFixed(2)}, Available: ₹${freeMargin.toFixed(2)}`,
      });
    }

    // Calculate new average open price
    const newQty = oldQty + addQty;
    const newAvgPrice = ((oldPrice * oldQty) + (addPrice * addQty)) / newQty;

    // Calculate additional brokerage (buy-side for adds)
    const additionalBrokerage = addPrice * addQty * lotSize * brokerageRate;
    const newBuyBrokerage = parseFloat(trade.buy_brokerage || trade.brokerage || 0) + additionalBrokerage;
    const newTotalMargin = parseFloat(trade.margin || 0) + additionalMargin;

    // Recalculate current P&L with new average price
    const currentPrice = parseFloat(trade.current_price || addPrice);
    const direction = trade.trade_type === 'buy' ? 1 : -1;
    const newProfit = ((currentPrice - newAvgPrice) * direction * newQty * lotSize) - newBuyBrokerage;

    const now = new Date().toISOString();

    // Update trade
    const { data: updatedTrade, error: updateError } = await supabase
      .from('trades')
      .update({
        quantity: newQty,
        open_price: newAvgPrice,
        margin: newTotalMargin,
        brokerage: newBuyBrokerage,
        buy_brokerage: newBuyBrokerage,
        profit: newProfit,
        current_price: currentPrice,
        comment: `${trade.comment || ''} [+${addQty}@${addPrice.toFixed(2)}]`.trim(),
        updated_at: now,
      })
      .eq('id', tradeId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Update account margin
    const newAccountMargin = parseFloat(trade.accounts.margin || 0) + additionalMargin;
    const newFreeMargin = parseFloat(trade.accounts.balance || 0) - newAccountMargin;

    await supabase
      .from('accounts')
      .update({
        margin: newAccountMargin,
        free_margin: Math.max(0, newFreeMargin),
        updated_at: now,
      })
      .eq('id', accountId);

    res.json({
      success: true,
      data: updatedTrade,
      message: `Added ${addQty} to position at ₹${addPrice.toFixed(2)}. New qty: ${newQty}, Avg price: ₹${newAvgPrice.toFixed(2)}`,
    });
  } catch (error) {
    console.error('Add quantity error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to add quantity',
    });
  }
};