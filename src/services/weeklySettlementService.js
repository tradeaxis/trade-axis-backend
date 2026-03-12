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
      .select('*, accounts!inner(id, user_id, is_demo, balance, margin, leverage), users!inner(id, brokerage_rate)')
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

    for (const trade of openTrades) {
      try {
        // Get settlement price from symbols table
        const { data: symRow, error: symErr } = await supabase
          .from('symbols')
          .select('last_price')
          .eq('symbol', trade.symbol)
          .single();

        if (symErr || !symRow) continue;

        const closePrice = Number(symRow.last_price || 0) || Number(trade.current_price || 0) || Number(trade.open_price || 0);
        if (!closePrice) continue;

        const qty = Number(trade.quantity || 0);
        const lotSize = 1; // simulation rule
        const direction = trade.trade_type === 'buy' ? 1 : -1;

        const openPrice = Number(trade.open_price || 0);
        const gross = (closePrice - openPrice) * direction * qty * lotSize;

        const brokerageRate = Number(trade.users?.brokerage_rate || 0.0003);

        // commission:
        // - buy side already in trade.buy_brokerage (or trade.brokerage)
        // - settlement close charges sell side brokerage
        // - reopen charges NO commission (as per your instruction)
        const buyBrokerage = Number(trade.buy_brokerage || trade.brokerage || 0);
        const sellBrokerage = closePrice * qty * lotSize * brokerageRate;
        const totalCommission = buyBrokerage + sellBrokerage;

        const netProfit = gross - totalCommission;

        const closeTime = new Date().toISOString();
        const settlementWeek = new Date().toISOString().slice(0, 10); // store date string

        // 1) Close the old trade
        const { data: closedTrade, error: closeErr } = await supabase
          .from('trades')
          .update({
            close_price: closePrice,
            profit: netProfit,
            sell_brokerage: sellBrokerage,
            brokerage: totalCommission,
            status: 'closed',
            close_time: closeTime,
            updated_at: closeTime,
            is_settlement_close: true,
            settlement_week: settlementWeek,
            comment: 'Weekly settlement close',
          })
          .eq('id', trade.id)
          .select()
          .single();

        if (closeErr) throw closeErr;

        // 2) Release old margin + credit P&L into account balance
        const acc = trade.accounts;
        const oldMargin = Number(trade.margin || 0);
        const newBalanceAfterClose = Number(acc.balance || 0) + netProfit;
        const newMarginAfterClose = Math.max(0, Number(acc.margin || 0) - oldMargin);

        // 3) Reopen trade at same price, same direction/qty/SL/TP (NO commission)
        const leverage = Number(acc.leverage || 5);
        const marginRequired = (closePrice * qty * lotSize) / (leverage || 5);

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

          // ✅ NO commission on reopen
          brokerage: 0,
          buy_brokerage: 0,
          sell_brokerage: 0,

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

        // 4) Update account with reopened margin (allow negative free margin if needed)
        const finalMargin = newMarginAfterClose + marginRequired;
        const finalFreeMargin = newBalanceAfterClose - finalMargin;
        const finalEquity = newBalanceAfterClose; // floating will be updated by pnl loop

        const { error: accErr } = await supabase
          .from('accounts')
          .update({
            balance: newBalanceAfterClose,
            margin: finalMargin,
            free_margin: finalFreeMargin,
            equity: finalEquity,
            profit: 0,
            updated_at: closeTime,
          })
          .eq('id', trade.account_id);

        if (accErr) throw accErr;

        // 5) Record settlement entry
        await supabase
          .from('weekly_settlements')
          .insert({
            user_id: trade.user_id,
            account_id: trade.account_id,
            old_trade_id: trade.id,
            new_trade_id: newTrade.id,
            settlement_date: settlementWeek,
            symbol: trade.symbol,
            close_price: closePrice,
            profit_loss: netProfit,
            commission: totalCommission,
          });

        settledCount++;
      } catch (e) {
        console.error('Settlement error for trade', trade.id, e.message);
      }
    }

    console.log('✅ Weekly settlement completed. Settled:', settledCount);
    return { success: true, settled: settledCount };
  }
}

module.exports = new WeeklySettlementService();