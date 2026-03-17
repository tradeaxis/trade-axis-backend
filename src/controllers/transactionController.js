// backend/src/controllers/transactionController.js
const { supabase } = require('../config/supabase');
const paymentService = require('../services/paymentService');

// GET /api/transactions/razorpay-key (public)
const getRazorpayKey = (req, res) => {
  return res.status(200).json({
    success: true,
    key: paymentService.getRazorpayKey(),
  });
};

// POST /api/transactions/deposit/create (protected)
const createDeposit = async (req, res) => {
  try {
    const { accountId, amount } = req.body;

    const order = await paymentService.createDepositOrder(
      req.user.id,
      accountId,
      Number(amount)
    );

    return res.status(200).json({
      success: true,
      data: order,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/transactions/deposit/verify (protected)
const verifyDeposit = async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;

    const transaction = await paymentService.confirmDeposit(
      orderId,
      paymentId,
      signature
    );

    return res.status(200).json({
      success: true,
      message: 'Deposit successful',
      data: transaction,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/transactions/withdraw (protected)
const withdraw = async (req, res) => {
  try {
    const { accountId, amount, bankName, accountNumber, ifscCode, accountHolderName } = req.body;

    const txn = await paymentService.createWithdrawalRequest(
      req.user.id,
      accountId,
      Number(amount),
      { bankName, accountNumber, ifscCode, accountHolderName }
    );

    return res.status(200).json({
      success: true,
      message: 'Withdrawal request submitted',
      data: txn,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/transactions (protected)
const getTransactions = async (req, res) => {
  try {
    const { accountId, type, status, limit = 50 } = req.query;

    let query = supabase
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit, 10));

    if (accountId) query = query.eq('account_id', accountId);
    if (type) query = query.eq('transaction_type', type);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/transactions/:id (protected)
const getTransaction = async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ NEW: GET /api/transactions/deals (protected)
// Returns combined deals: closed trades (profit), deposits, withdrawals, commissions
const getDeals = async (req, res) => {
  try {
    const { accountId, period = 'month', limit = 200 } = req.query;
    const userId = req.user.id;

    if (!accountId) {
      return res.status(400).json({ success: false, message: 'accountId is required' });
    }

    const now = new Date();
    let startDate = null;

    switch (period) {
      case 'today':
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      case '3months':
        startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 3);
        break;
      case '6months':
        startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 6);
        break;
      case 'year':
        startDate = new Date(now);
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate = null;
    }

    const allDeals = [];

    // Get account balance
    const { data: account } = await supabase
      .from('accounts')
      .select('balance')
      .eq('id', accountId)
      .single();

    // 1) TRADES - include OPEN + CLOSED so entry commission shows immediately
    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .order('open_time', { ascending: false })
      .limit(1000);

    if (tradesError) throw tradesError;

    const filteredTrades = (trades || []).filter((trade) => {
      if (!startDate) return true;
      const openOk = trade.open_time && new Date(trade.open_time) >= startDate;
      const closeOk = trade.close_time && new Date(trade.close_time) >= startDate;
      return openOk || closeOk;
    });

    filteredTrades.forEach((trade) => {
      const qty = Number(trade.quantity || 0);
      const entryCommission = Number(trade.buy_brokerage || trade.brokerage || 0);

      // Entry row
      allDeals.push({
        id: `entry-${trade.id}`,
        source: 'trade',
        side: 'entry',
        type: trade.trade_type, // buy / sell
        dealLabel: trade.trade_type === 'buy' ? 'Buy In' : 'Sell In',
        symbol: trade.symbol,
        quantity: qty,
        price: Number(trade.open_price || 0),
        amount: 0,
        profit: 0,
        commission: entryCommission,
        time: trade.open_time,
        status: 'completed',
        tradeId: trade.id,
      });

      // Exit row only if closed
      if (trade.status === 'closed' && trade.close_time) {
        const exitCommission = Number(trade.sell_brokerage || 0);

        allDeals.push({
          id: `exit-${trade.id}`,
          source: 'trade',
          side: 'exit',
          type: trade.trade_type === 'buy' ? 'sell' : 'buy',
          dealLabel: trade.trade_type === 'buy' ? 'Sell Out' : 'Buy Out',
          symbol: trade.symbol,
          quantity: qty,
          price: Number(trade.close_price || 0),
          amount: Number(trade.profit || 0),
          profit: Number(trade.profit || 0),
          commission: exitCommission,
          time: trade.close_time,
          status: 'completed',
          tradeId: trade.id,
        });
      }
    });

    // 2) Deposits / Withdrawals
    const { data: txns, error: txnsError } = await supabase
      .from('transactions')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (txnsError) throw txnsError;

    const filteredTxns = (txns || []).filter((txn) => {
      if (!startDate) return true;
      return txn.created_at && new Date(txn.created_at) >= startDate;
    });

    filteredTxns.forEach((txn) => {
      if (txn.transaction_type === 'deposit' && txn.status === 'completed') {
        allDeals.push({
          id: `deposit-${txn.id}`,
          source: 'transaction',
          side: 'deposit',
          type: 'deposit',
          dealLabel: 'Deposit',
          symbol: null,
          quantity: null,
          price: null,
          amount: Number(txn.amount || 0),
          profit: 0,
          commission: 0,
          time: txn.processed_at || txn.created_at,
          status: txn.status,
          transactionId: txn.id,
        });
      }

      if (['withdraw', 'withdrawal'].includes(txn.transaction_type)) {
        allDeals.push({
          id: `withdrawal-${txn.id}`,
          source: 'transaction',
          side: 'withdrawal',
          type: 'withdrawal',
          dealLabel: 'Withdrawal',
          symbol: null,
          quantity: null,
          price: null,
          amount: -Number(txn.amount || 0),
          profit: 0,
          commission: 0,
          time: txn.processed_at || txn.created_at,
          status: txn.status,
          transactionId: txn.id,
        });
      }
    });

    // Sort latest first
    allDeals.sort((a, b) => new Date(b.time) - new Date(a.time));

    const deals = allDeals.slice(0, parseInt(limit, 10));

    const exitDeals = allDeals.filter((d) => d.source === 'trade' && d.side === 'exit');

    const summary = {
      totalProfit: exitDeals.filter((d) => d.amount > 0).reduce((s, d) => s + d.amount, 0),
      totalLoss: Math.abs(exitDeals.filter((d) => d.amount < 0).reduce((s, d) => s + d.amount, 0)),
      totalDeposits: allDeals.filter((d) => d.type === 'deposit').reduce((s, d) => s + d.amount, 0),
      totalWithdrawals: Math.abs(allDeals.filter((d) => d.type === 'withdrawal').reduce((s, d) => s + d.amount, 0)),
      totalCommission: allDeals.reduce((s, d) => s + Number(d.commission || 0), 0),
      netPnL: exitDeals.reduce((s, d) => s + d.amount, 0),
      currentBalance: Number(account?.balance || 0),
    };

    return res.status(200).json({
      success: true,
      data: {
        deals,
        summary,
        period,
        count: deals.length,
      },
    });
  } catch (error) {
    console.error('getDeals error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getRazorpayKey,
  createDeposit,
  verifyDeposit,
  withdraw,
  getTransactions,
  getTransaction,
  getDeals, // ✅ NEW
};