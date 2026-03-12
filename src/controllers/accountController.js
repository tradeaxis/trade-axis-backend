const { supabase } = require('../config/supabase');
const { generateAccountNumber } = require('../utils/auth');

// @desc    Get all user accounts
// @route   GET /api/accounts
const getAccounts = async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.status(200).json({
      success: true,
      count: accounts.length,
      data: accounts
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get single account
// @route   GET /api/accounts/:id
const getAccount = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: account, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found'
      });
    }

    // Get recent trades for this account
    const { data: recentTrades } = await supabase
      .from('trades')
      .select('*')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(10);

    res.status(200).json({
      success: true,
      data: {
        account,
        recentTrades: recentTrades || []
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Create new account
// @route   POST /api/accounts
const createAccount = async (req, res) => {
  try {
    const { accountType, leverage, isDemo } = req.body;

    // Check account limits
    const { data: existingAccounts, error: countError } = await supabase
      .from('accounts')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('is_demo', isDemo || false);

    if (countError) throw countError;

    const maxAccounts = isDemo ? 3 : 5;
    if (existingAccounts.length >= maxAccounts) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${maxAccounts} ${isDemo ? 'demo' : 'live'} accounts allowed`
      });
    }

    // Generate account number
    const accountNumber = generateAccountNumber(isDemo || false);

    // Create account
    const { data: account, error } = await supabase
      .from('accounts')
      .insert([
        {
          user_id: req.user.id,
          account_number: accountNumber,
          account_type: accountType || 'standard',
          balance: isDemo ? 100000 : 0,
          equity: isDemo ? 100000 : 0,
          free_margin: isDemo ? 100000 : 0,
          leverage: leverage || 5,
          currency: 'INR',
          is_demo: isDemo || false,
          is_active: true
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: `${isDemo ? 'Demo' : 'Live'} account created successfully`,
      data: account
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Update account settings
// @route   PUT /api/accounts/:id
const updateAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { leverage } = req.body;

    // Check if account exists and belongs to user
    const { data: account, error: fetchError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found'
      });
    }

    // Check for open trades before changing leverage
    if (leverage && leverage !== account.leverage) {
      const { data: openTrades } = await supabase
        .from('trades')
        .select('id')
        .eq('account_id', id)
        .eq('status', 'open');

      if (openTrades && openTrades.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot change leverage with open positions'
        });
      }
    }

    // Update account
    const { data: updatedAccount, error } = await supabase
      .from('accounts')
      .update({
        leverage: leverage || account.leverage
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Account updated successfully',
      data: updatedAccount
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Reset demo account
// @route   POST /api/accounts/:id/reset
const resetDemoAccount = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if account exists and is demo
    const { data: account, error: fetchError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('is_demo', true)
      .single();

    if (fetchError || !account) {
      return res.status(404).json({
        success: false,
        message: 'Demo account not found'
      });
    }

    // Close all open trades
    await supabase
      .from('trades')
      .update({
        status: 'closed',
        close_time: new Date().toISOString()
      })
      .eq('account_id', id)
      .eq('status', 'open');

    // Reset account balance and statistics
    const { data: resetAccount, error } = await supabase
      .from('accounts')
      .update({
        balance: 100000,
        equity: 100000,
        margin: 0,
        free_margin: 100000,
        profit: 0,
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        total_profit: 0,
        total_loss: 0,
        win_rate: 0
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Demo account reset successfully',
      data: resetAccount
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get account summary/statistics
// @route   GET /api/accounts/:id/summary
const getAccountSummary = async (req, res) => {
  try {
    const { id } = req.params;

    // Get account
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (accountError || !account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found'
      });
    }

    // Get trade statistics
    const { data: trades } = await supabase
      .from('trades')
      .select('profit, status')
      .eq('account_id', id)
      .eq('status', 'closed');

    // Calculate statistics
    let totalProfit = 0;
    let totalLoss = 0;
    let winningTrades = 0;
    let losingTrades = 0;

    if (trades) {
      trades.forEach(trade => {
        if (trade.profit > 0) {
          totalProfit += parseFloat(trade.profit);
          winningTrades++;
        } else {
          totalLoss += Math.abs(parseFloat(trade.profit));
          losingTrades++;
        }
      });
    }

    const totalTrades = winningTrades + losingTrades;
    const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) : 0;

    res.status(200).json({
      success: true,
      data: {
        account: {
          accountNumber: account.account_number,
          accountType: account.account_type,
          balance: account.balance,
          equity: account.equity,
          margin: account.margin,
          freeMargin: account.free_margin,
          leverage: account.leverage,
          currency: account.currency
        },
        statistics: {
          totalTrades,
          winningTrades,
          losingTrades,
          totalProfit: totalProfit.toFixed(2),
          totalLoss: totalLoss.toFixed(2),
          netProfit: (totalProfit - totalLoss).toFixed(2),
          winRate: parseFloat(winRate)
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  getAccounts,
  getAccount,
  createAccount,
  updateAccount,
  resetDemoAccount,
  getAccountSummary
};