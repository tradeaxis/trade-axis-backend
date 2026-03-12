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

    // Calculate period start date
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

    const deals = [];

    // 1. Get closed trades (profits)
    let tradesQuery = supabase
      .from('trades')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('close_time', { ascending: false })
      .limit(parseInt(limit, 10));

    if (startDate) {
      tradesQuery = tradesQuery.gte('close_time', startDate.toISOString());
    }

    const { data: trades, error: tradesError } = await tradesQuery;
    if (!tradesError && trades) {
      trades.forEach(trade => {
        deals.push({
          id: `trade-${trade.id}`,
          type: 'profit',
          dealType: trade.profit >= 0 ? 'profit' : 'loss',
          symbol: trade.symbol,
          description: `${trade.trade_type.toUpperCase()} ${trade.quantity} ${trade.symbol}`,
          amount: parseFloat(trade.profit || 0),
          commission: parseFloat(trade.brokerage || 0),
          time: trade.close_time,
          status: 'completed',
          tradeId: trade.id
        });

        // Add commission as separate deal if exists
        if (trade.brokerage && parseFloat(trade.brokerage) > 0) {
          deals.push({
            id: `commission-${trade.id}`,
            type: 'commission',
            dealType: 'commission',
            symbol: trade.symbol,
            description: `Commission for ${trade.symbol}`,
            amount: -parseFloat(trade.brokerage || 0),
            commission: 0,
            time: trade.close_time,
            status: 'completed',
            tradeId: trade.id
          });
        }
      });
    }

    // 2. Get deposits
    let depositsQuery = supabase
      .from('transactions')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .eq('transaction_type', 'deposit')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit, 10));

    if (startDate) {
      depositsQuery = depositsQuery.gte('created_at', startDate.toISOString());
    }

    const { data: deposits, error: depositsError } = await depositsQuery;
    if (!depositsError && deposits) {
      deposits.forEach(dep => {
        deals.push({
          id: `deposit-${dep.id}`,
          type: 'deposit',
          dealType: 'deposit',
          symbol: null,
          description: `Deposit via ${dep.payment_method || 'Razorpay'}`,
          amount: parseFloat(dep.amount || 0),
          commission: 0,
          time: dep.processed_at || dep.created_at,
          status: dep.status,
          transactionId: dep.id
        });
      });
    }

    // 3. Get withdrawals
    let withdrawalsQuery = supabase
      .from('transactions')
      .select('*')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .in('transaction_type', ['withdraw', 'withdrawal'])
      .order('created_at', { ascending: false })
      .limit(parseInt(limit, 10));

    if (startDate) {
      withdrawalsQuery = withdrawalsQuery.gte('created_at', startDate.toISOString());
    }

    const { data: withdrawals, error: withdrawalsError } = await withdrawalsQuery;
    if (!withdrawalsError && withdrawals) {
      withdrawals.forEach(wth => {
        deals.push({
          id: `withdrawal-${wth.id}`,
          type: 'withdrawal',
          dealType: 'withdrawal',
          symbol: null,
          description: `Withdrawal to bank`,
          amount: -parseFloat(wth.amount || 0),
          commission: 0,
          time: wth.processed_at || wth.created_at,
          status: wth.status,
          transactionId: wth.id
        });
      });
    }

    // Sort all deals by time (newest first)
    deals.sort((a, b) => new Date(b.time) - new Date(a.time));

    // ✅ Calculate running balance
    // Get current account balance
    const { data: account } = await supabase
      .from('accounts')
      .select('balance')
      .eq('id', accountId)
      .single();

    let runningBalance = parseFloat(account?.balance || 0);
    
    // Calculate running balance for each deal (working backwards)
    const dealsWithBalance = deals.map((deal, index) => {
      const balanceAfter = runningBalance;
      runningBalance = runningBalance - deal.amount; // Subtract to go back in time
      return {
        ...deal,
        balance: balanceAfter
      };
    });

    // Summary
    const summary = {
      totalProfit: deals.filter(d => d.type === 'profit' && d.amount > 0).reduce((s, d) => s + d.amount, 0),
      totalLoss: Math.abs(deals.filter(d => d.type === 'profit' && d.amount < 0).reduce((s, d) => s + d.amount, 0)),
      totalDeposits: deals.filter(d => d.type === 'deposit').reduce((s, d) => s + d.amount, 0),
      totalWithdrawals: Math.abs(deals.filter(d => d.type === 'withdrawal').reduce((s, d) => s + d.amount, 0)),
      totalCommission: Math.abs(deals.filter(d => d.type === 'commission').reduce((s, d) => s + d.amount, 0)),
      netPnL: deals.filter(d => d.type === 'profit').reduce((s, d) => s + d.amount, 0),
      currentBalance: parseFloat(account?.balance || 0)
    };

    return res.status(200).json({
      success: true,
      data: {
        deals: dealsWithBalance,
        summary,
        period,
        count: dealsWithBalance.length
      }
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