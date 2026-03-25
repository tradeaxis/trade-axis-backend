// backend/src/services/tradingService.js
const { supabase } = require('../config/supabase');

class TradingService {
  // Execute market order
  async executeMarketOrder({
    userId,
    account,
    symbolData,
    type,
    quantity,
    stopLoss = 0,
    takeProfit = 0,
    slippage = 3,
    comment = '',
    magicNumber = 0,
  }) {
    try {
      // Get current price
      const openPrice = type === 'buy' ? parseFloat(symbolData.ask) : parseFloat(symbolData.bid);

      if (!openPrice || openPrice <= 0) {
        return { success: false, message: 'Invalid price. Market may be closed.' };
      }

      // Calculate margin required
      const lotSize = symbolData.lot_size || 1;
      const marginRate = symbolData.margin_rate || 10; // percentage
      const leverage = account.leverage || 5;
      const marginRequired = (openPrice * quantity * lotSize) / leverage;

      // Check free margin
      const freeMargin = parseFloat(account.free_margin || account.balance);
      if (marginRequired > freeMargin) {
        return {
          success: false,
          message: `Insufficient margin. Required: ₹${marginRequired.toFixed(2)}, Available: ₹${freeMargin.toFixed(2)}`,
        };
      }

      // Calculate brokerage
      const brokerageRate = 0.0003; // 0.03%
      const brokerage = openPrice * quantity * lotSize * brokerageRate;

      // Create trade
      const tradeData = {
        user_id: userId,
        account_id: account.id,
        symbol: symbolData.symbol,
        trade_type: type,
        quantity,
        lot_size: lotSize,
        open_price: openPrice,
        current_price: openPrice,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        margin: marginRequired,
        brokerage,
        profit: 0,
        status: 'open',
        comment,
        magic_number: magicNumber,
        open_time: new Date().toISOString(),
      };

      const { data: trade, error: tradeError } = await supabase
        .from('trades')
        .insert(tradeData)
        .select()
        .single();

      if (tradeError) throw tradeError;

      // Update account margin
      const newMargin = parseFloat(account.margin || 0) + marginRequired;
      const newFreeMargin = parseFloat(account.balance) - newMargin;

      await supabase
        .from('accounts')
        .update({
          margin: newMargin,
          free_margin: newFreeMargin,
          updated_at: new Date().toISOString(),
        })
        .eq('id', account.id);

      return {
        success: true,
        trade,
        message: `${type.toUpperCase()} ${quantity} ${symbolData.symbol} @ ${openPrice}`,
      };
    } catch (error) {
      console.error('Execute market order error:', error);
      return { success: false, message: 'Failed to execute order' };
    }
  }

  // Create pending order
  async createPendingOrder({
    userId,
    account,
    symbolData,
    orderType,
    type,
    quantity,
    price,
    stopLoss = 0,
    takeProfit = 0,
    comment = '',
    expiration = 'gtc',
    expirationTime = null,
    magicNumber = 0,
  }) {
    try {
      if (!price || price <= 0) {
        return { success: false, message: 'Invalid price for pending order' };
      }

      const currentPrice = type === 'buy' ? parseFloat(symbolData.ask) : parseFloat(symbolData.bid);

      // Validate price based on order type
      const validationResult = this.validatePendingOrderPrice(orderType, type, price, currentPrice);
      if (!validationResult.valid) {
        return { success: false, message: validationResult.message };
      }

      // Calculate margin required (reserved for pending orders)
      const lotSize = symbolData.lot_size || 1;
      const leverage = account.leverage || 5;
      const marginRequired = (price * quantity * lotSize) / leverage;

      // Check free margin
      const freeMargin = parseFloat(account.free_margin || account.balance);
      if (marginRequired > freeMargin) {
        return {
          success: false,
          message: `Insufficient margin for pending order. Required: ₹${marginRequired.toFixed(2)}`,
        };
      }

      // Create pending order
      const orderData = {
        user_id: userId,
        account_id: account.id,
        symbol: symbolData.symbol,
        order_type: orderType,
        trade_type: type,
        quantity,
        price,
        stop_loss: stopLoss,
        take_profit: takeProfit,
        margin_reserved: marginRequired,
        status: 'pending',
        comment,
        expiration,
        expiration_time: expirationTime,
        magic_number: magicNumber,
        created_at: new Date().toISOString(),
      };

      const { data: order, error: orderError } = await supabase
        .from('pending_orders')
        .insert(orderData)
        .select()
        .single();

      if (orderError) throw orderError;

      return {
        success: true,
        order,
        message: `Pending ${orderType.toUpperCase()} order created at ${price}`,
      };
    } catch (error) {
      console.error('Create pending order error:', error);
      return { success: false, message: 'Failed to create pending order' };
    }
  }

  // Validate pending order price
  validatePendingOrderPrice(orderType, type, price, currentPrice) {
    switch (orderType) {
      case 'buy_limit':
        if (price >= currentPrice) {
          return { valid: false, message: 'Buy Limit price must be below current price' };
        }
        break;
      case 'sell_limit':
        if (price <= currentPrice) {
          return { valid: false, message: 'Sell Limit price must be above current price' };
        }
        break;
      case 'buy_stop':
        if (price <= currentPrice) {
          return { valid: false, message: 'Buy Stop price must be above current price' };
        }
        break;
      case 'sell_stop':
        if (price >= currentPrice) {
          return { valid: false, message: 'Sell Stop price must be below current price' };
        }
        break;
    }
    return { valid: true };
  }

  // Close position
  async closePosition(trade) {
    try {
      // Get current price
      const { data: symbolData, error: symbolError } = await supabase
        .from('symbols')
        .select('bid, ask, lot_size')
        .eq('symbol', trade.symbol)
        .single();

      if (symbolError || !symbolData) {
        return { success: false, message: 'Failed to get current price' };
      }

      // Close price is bid for buy, ask for sell
      const closePrice = trade.trade_type === 'buy' 
        ? parseFloat(symbolData.bid) 
        : parseFloat(symbolData.ask);

      // Calculate P&L
      const direction = trade.trade_type === 'buy' ? 1 : -1;
      const priceDiff = (closePrice - parseFloat(trade.open_price)) * direction;
      const lotSize = trade.lot_size || symbolData.lot_size || 1;
      const grossProfit = priceDiff * trade.quantity * lotSize;
      const netProfit = grossProfit - parseFloat(trade.brokerage || 0);

      // Update trade
      const closeTime = new Date().toISOString();
      const { data: closedTrade, error: updateError } = await supabase
        .from('trades')
        .update({
          close_price: closePrice,
          profit: netProfit,
          status: 'closed',
          close_time: closeTime,
          updated_at: closeTime,
        })
        .eq('id', trade.id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Update account balance and margin
      const { data: account } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', trade.account_id)
        .single();

      if (account) {
        const newBalance = parseFloat(account.balance) + netProfit;
        const newMargin = Math.max(0, parseFloat(account.margin) - parseFloat(trade.margin || 0));
        const newFreeMargin = newBalance - newMargin;

        await supabase
          .from('accounts')
          .update({
            balance: newBalance,
            margin: newMargin,
            free_margin: newFreeMargin,
            updated_at: closeTime,
          })
          .eq('id', account.id);
      }

      return {
        success: true,
        trade: closedTrade,
        message: `Position closed at ${closePrice}. P&L: ${netProfit.toFixed(2)}`,
      };
    } catch (error) {
      console.error('Close position error:', error);
      return { success: false, message: 'Failed to close position' };
    }
  }

  // Partial close position
  async partialClosePosition(trade, closeVolume) {
    try {
      // Get current price
      const { data: symbolData, error: symbolError } = await supabase
        .from('symbols')
        .select('bid, ask, lot_size')
        .eq('symbol', trade.symbol)
        .single();

      if (symbolError || !symbolData) {
        return { success: false, message: 'Failed to get current price' };
      }

      const closePrice = trade.trade_type === 'buy' 
        ? parseFloat(symbolData.bid) 
        : parseFloat(symbolData.ask);

      const totalVolume = parseFloat(trade.quantity);
      const remainingVolume = totalVolume - closeVolume;

      // Calculate P&L for closed portion
      const direction = trade.trade_type === 'buy' ? 1 : -1;
      const priceDiff = (closePrice - parseFloat(trade.open_price)) * direction;
      const lotSize = trade.lot_size || symbolData.lot_size || 1;
      const closedProfit = priceDiff * closeVolume * lotSize;

      // Proportional brokerage and margin
      const closedBrokerage = (parseFloat(trade.brokerage || 0) / totalVolume) * closeVolume;
      const closedMargin = (parseFloat(trade.margin || 0) / totalVolume) * closeVolume;
      const netClosedProfit = closedProfit - closedBrokerage;

      const closeTime = new Date().toISOString();

      // Create closed trade record
      const { data: closedTrade, error: closedError } = await supabase
        .from('trades')
        .insert({
          user_id: trade.user_id,
          account_id: trade.account_id,
          symbol: trade.symbol,
          trade_type: trade.trade_type,
          quantity: closeVolume,
          lot_size: lotSize,
          open_price: trade.open_price,
          close_price: closePrice,
          stop_loss: 0,
          take_profit: 0,
          margin: closedMargin,
          brokerage: closedBrokerage,
          profit: netClosedProfit,
          status: 'closed',
          comment: `Partial close of #${trade.id}`,
          magic_number: trade.magic_number,
          open_time: trade.open_time,
          close_time: closeTime,
        })
        .select()
        .single();

      if (closedError) throw closedError;

      // Update original trade with remaining volume
      const remainingBrokerage = parseFloat(trade.brokerage || 0) - closedBrokerage;
      const remainingMargin = parseFloat(trade.margin || 0) - closedMargin;

      const { data: remainingTrade, error: updateError } = await supabase
        .from('trades')
        .update({
          quantity: remainingVolume,
          margin: remainingMargin,
          brokerage: remainingBrokerage,
          updated_at: closeTime,
        })
        .eq('id', trade.id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Update account
      const { data: account } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', trade.account_id)
        .single();

      if (account) {
        const newBalance = parseFloat(account.balance) + netClosedProfit;
        const newMargin = Math.max(0, parseFloat(account.margin) - closedMargin);
        const newFreeMargin = newBalance - newMargin;

        await supabase
          .from('accounts')
          .update({
            balance: newBalance,
            margin: newMargin,
            free_margin: newFreeMargin,
            updated_at: closeTime,
          })
          .eq('id', account.id);
      }

      return {
        success: true,
        closedTrade,
        remainingTrade,
        message: `Closed ${closeVolume} lots at ${closePrice}. Remaining: ${remainingVolume} lots`,
      };
    } catch (error) {
      console.error('Partial close error:', error);
      return { success: false, message: 'Failed to partial close position' };
    }
  }

  // Check and trigger pending orders (called by background job)
  async checkPendingOrders() {
    try {
      const { isMarketOpen } = require('./marketStatus');

      // Get all pending orders
      const { data: orders, error } = await supabase
        .from('pending_orders')
        .select('*, accounts(*)')
        .eq('status', 'pending');

      if (error || !orders || orders.length === 0) return;

      for (const order of orders) {
        // ── AUTO-CANCEL when market is closed for this symbol ──
        if (!isMarketOpen(order.symbol)) {
          await supabase
            .from('pending_orders')
            .update({
              status: 'cancelled',
              comment: (order.comment || '') + ' [Auto-cancelled: market closed]',
              updated_at: new Date().toISOString(),
            })
            .eq('id', order.id);
          console.log(`❌ Auto-cancelled pending order #${order.id} (${order.symbol}) — market closed`);
          continue;
        }

        // Get current price
        const { data: symbolData } = await supabase
          .from('symbols')
          .select('*')
          .eq('symbol', order.symbol)
          .single();

        if (!symbolData) continue;

        const currentBid = parseFloat(symbolData.bid);
        const currentAsk = parseFloat(symbolData.ask);
        const orderPrice = parseFloat(order.price);

        let shouldTrigger = false;

        switch (order.order_type) {
          case 'buy_limit':
            shouldTrigger = currentAsk <= orderPrice;
            break;
          case 'sell_limit':
            shouldTrigger = currentBid >= orderPrice;
            break;
          case 'buy_stop':
            shouldTrigger = currentAsk >= orderPrice;
            break;
          case 'sell_stop':
            shouldTrigger = currentBid <= orderPrice;
            break;
        }

        if (shouldTrigger) {
          // Execute the order
          const result = await this.executeMarketOrder({
            userId: order.user_id,
            account: order.accounts,
            symbolData,
            type: order.trade_type,
            quantity: order.quantity,
            stopLoss: order.stop_loss,
            takeProfit: order.take_profit,
            comment: `Triggered from pending order #${order.id}`,
            magicNumber: order.magic_number,
          });

          if (result.success) {
            // Update pending order status
            await supabase
              .from('pending_orders')
              .update({
                status: 'triggered',
                triggered_at: new Date().toISOString(),
                trade_id: result.trade.id,
              })
              .eq('id', order.id);

            console.log(`✅ Pending order #${order.id} triggered`);
          }
        }

        // Check expiration
        if (order.expiration === 'today') {
          const orderDate = new Date(order.created_at).toDateString();
          const today = new Date().toDateString();

          if (orderDate !== today) {
            await supabase
              .from('pending_orders')
              .update({
                status: 'expired',
                expired_at: new Date().toISOString(),
              })
              .eq('id', order.id);
          }
        } else if (order.expiration === 'specified' && order.expiration_time) {
          if (new Date() > new Date(order.expiration_time)) {
            await supabase
              .from('pending_orders')
              .update({
                status: 'expired',
                expired_at: new Date().toISOString(),
              })
              .eq('id', order.id);
          }
        }
      }
    } catch (error) {
      console.error('Check pending orders error:', error);
    }
  }

  // Check and trigger SL/TP (called by background job)
  async checkStopLossAndTakeProfit() {
    try {
      // Get all open trades with SL or TP
      const { data: trades, error } = await supabase
        .from('trades')
        .select('*')
        .eq('status', 'open')
        .or('stop_loss.gt.0,take_profit.gt.0');

      if (error || !trades || trades.length === 0) return;

      for (const trade of trades) {
        // Get current price
        const { data: symbolData } = await supabase
          .from('symbols')
          .select('bid, ask')
          .eq('symbol', trade.symbol)
          .single();

        if (!symbolData) continue;

        const currentPrice = trade.trade_type === 'buy' 
          ? parseFloat(symbolData.bid) 
          : parseFloat(symbolData.ask);

        const stopLoss = parseFloat(trade.stop_loss);
        const takeProfit = parseFloat(trade.take_profit);

        let shouldClose = false;
        let closeReason = '';

        // Check Stop Loss
        if (stopLoss > 0) {
          if (trade.trade_type === 'buy' && currentPrice <= stopLoss) {
            shouldClose = true;
            closeReason = 'Stop Loss triggered';
          } else if (trade.trade_type === 'sell' && currentPrice >= stopLoss) {
            shouldClose = true;
            closeReason = 'Stop Loss triggered';
          }
        }

        // Check Take Profit
        if (!shouldClose && takeProfit > 0) {
          if (trade.trade_type === 'buy' && currentPrice >= takeProfit) {
            shouldClose = true;
            closeReason = 'Take Profit triggered';
          } else if (trade.trade_type === 'sell' && currentPrice <= takeProfit) {
            shouldClose = true;
            closeReason = 'Take Profit triggered';
          }
        }

        if (shouldClose) {
          const result = await this.closePosition(trade);
          if (result.success) {
            console.log(`✅ ${closeReason} for trade #${trade.id}`);

            // Notify user via WebSocket (if available)
            // This would be done through the socketHandler
          }
        }
      }
    } catch (error) {
      console.error('Check SL/TP error:', error);
    }
  }
}

module.exports = new TradingService();