// backend/src/services/weeklySettlementService.js
const { supabase } = require('../config/supabase');

class WeeklySettlementService {
  async runSettlement() {
    const now = new Date();
    console.log('🧾 Weekly settlement started at', now.toISOString());

    const settleDemo = String(process.env.SETTLE_DEMO || 'false') === 'true';

    // Get all open trades + account info + user brokerage
    const { data: trades, error } = await supabase
      .from('trades')
      .select('*, accounts!inner(id, user_id, is_demo, balance, margin, leverage)')
      .eq('status', 'open');

    if (error) {
      console.error('Settlement: fetch trades error:', error.message);
      return { success: false, message: error.message };
    }

    if (!trades || trades.length === 0) {
      console.log('ℹ️ No open trades to settle.');
      return { success: true, settled: 0 };
    }

    // Filter demo if needed
    const openTrades = settleDemo ? trades : trades.filter(t => !t.accounts?.is_demo);

    let settledCount = 0;
    const settlementWeek = new Date().toISOString().slice(0, 10);
    const closeTime = new Date().toISOString();

    for (const trade of openTrades) {
      try {
        // Get settlement price from symbols table
        const { data: symRow, error: symErr } = await supabase
          .from('symbols')
          .select('last_price, bid, ask')
          .eq('symbol', trade.symbol)
          .limit(1);

        const symbolData = symRow?.[0];
        if (!symbolData) continue;

        // Use last known price for settlement
        const closePrice =
          Number(symbolData.last_price || 0) ||
          Number(trade.current_price || 0) ||
          Number(trade.open_price || 0);

        if (!closePrice) continue;

        const qty = Number(trade.quantity || 0);
        const direction = trade.trade_type === 'buy' ? 1 : -1;
        const openPrice = Number(trade.open_price || 0);

        // Calculate P&L for RECORD KEEPING ONLY (not credited to balance)
        const gross = (closePrice - openPrice) * direction * qty;
        const entryCommission = Number(trade.buy_brokerage || trade.brokerage || 0);
        const netPnL = gross - entryCommission;

        // 1) Close the old trade — P&L recorded but NOT credited to balance
        const { error: closeErr } = await supabase
          .from('trades')
          .update({
            close_price: closePrice,
            profit: netPnL,
            status: 'closed',
            close_time: closeTime,
            updated_at: closeTime,
            is_settlement_close: true,
            settlement_week: settlementWeek,
            comment: `Weekly settlement close. P&L: ${netPnL.toFixed(2)} (not credited - offline settlement)`,
          })
          .eq('id', trade.id);

        if (closeErr) throw closeErr;

        // 2) Release old margin from account (but DO NOT change balance)
        const acc = trade.accounts;
        const oldMargin = Number(trade.margin || 0);
        const currentBalance = Number(acc.balance || 0); // Balance stays SAME
        const newMarginAfterClose = Math.max(0, Number(acc.margin || 0) - oldMargin);

        // 3) Reopen trade at SAME close price, SAME direction, SAME qty, SAME SL/TP
        //    NO commission, P&L starts at 0
        const leverage = Number(acc.leverage || 5);
        const marginRequired = (closePrice * qty) / leverage;

        const reopenData = {
          user_id: trade.user_id,
          account_id: trade.account_id,
          symbol: trade.symbol,
          exchange: trade.exchange || 'NSE',
          trade_type: trade.trade_type,
          quantity: qty,
          open_price: closePrice,
          current_price: closePrice,
          stop_loss: Number(trade.stop_loss || 0),
          take_profit: Number(trade.take_profit || 0),
          margin: marginRequired,

          // NO commission on reopen
          brokerage: 0,
          buy_brokerage: 0,
          sell_brokerage: 0,

          // P&L starts at 0
          profit: 0,

          status: 'open',
          comment: `Weekly settlement reopen from ${trade.id}`,
          open_time: closeTime,
          updated_at: closeTime,
          settled_from_trade_id: trade.id,
          settlement_week: settlementWeek,
        };

        const { data: newTrade, error: reopenErr } = await supabase
          .from('trades')
          .insert(reopenData)
          .select()
          .single();

        if (reopenErr) throw reopenErr;

        // 4) Update account:
        //    - Balance: NO CHANGE (settlement is offline)
        //    - Margin: release old + reserve new
        //    - Equity: same as balance (since new trade P&L is 0)
        //    - Profit: 0 (fresh start)
        const finalMargin = newMarginAfterClose + marginRequired;
        const finalFreeMargin = currentBalance - finalMargin;

        const { error: accErr } = await supabase
          .from('accounts')
          .update({
            // balance: NOT CHANGED — this is the key difference
            margin: finalMargin,
            free_margin: finalFreeMargin,
            equity: currentBalance, // equity = balance since P&L is now 0
            profit: 0,
            updated_at: closeTime,
          })
          .eq('id', trade.account_id);

        if (accErr) throw accErr;

        // 5) Record settlement entry (for admin reference)
        try {
          await supabase
            .from('weekly_settlements')
            .insert({
              user_id: trade.user_id,
              account_id: trade.account_id,
              old_trade_id: trade.id,
              new_trade_id: newTrade.id,
              settlement_date: settlementWeek,
              symbol: trade.symbol,
              trade_type: trade.trade_type,
              quantity: qty,
              open_price: openPrice,
              close_price: closePrice,
              profit_loss: netPnL,
              commission: entryCommission,
              balance_before: currentBalance,
              balance_after: currentBalance, // same — no credit/debit
              settlement_type: 'offline', // admin settles cash offline
            });
        } catch (e) {
          // Table may not exist — that's okay
          console.warn('Settlement record insert warning:', e.message);
        }

        settledCount++;
        console.log(`  ✅ ${trade.symbol} ${trade.trade_type} x${qty} | P&L: ₹${netPnL.toFixed(2)} (recorded, not credited)`);

      } catch (e) {
        console.error('Settlement error for trade', trade.id, e.message);
      }
    }

    console.log(`✅ Weekly settlement completed. Settled: ${settledCount}`);
    console.log(`   Balance unchanged for all users. P&L recorded for offline settlement.`);
    return { success: true, settled: settledCount };
  }
}

module.exports = new WeeklySettlementService();