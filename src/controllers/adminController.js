// backend/src/controllers/adminController.js
const { supabase } = require('../config/supabase');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const kiteService = require('../services/kiteService');
const kiteStreamService = require('../services/kiteStreamService');

// ============ HELPER: Generate Random Password ============
const generateTempPassword = () => {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
};

// ============ USER FUNCTIONS ============

exports.listUsers = async (req, res) => {
  try {
    const { q, limit = 500 } = req.query;

    let query = supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (q && q.trim()) {
      const searchTerm = q.trim().toLowerCase();
      query = query.or(`email.ilike.%${searchTerm}%,first_name.ilike.%${searchTerm}%,last_name.ilike.%${searchTerm}%,login_id.ilike.%${searchTerm}%`);
    }

    const { data: users, error } = await query;

    if (error) {
      console.error('listUsers query error:', error);
      throw error;
    }

    const usersWithAccounts = await Promise.all(
      (users || []).map(async (user) => {
        const { data: accounts } = await supabase
          .from('accounts')
          .select('id, account_number, is_demo, balance, equity, margin, free_margin, leverage')
          .eq('user_id', user.id);

        return {
          id: user.id,
          login_id: user.login_id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          phone: user.phone,
          role: user.role || 'user',
          is_active: user.is_active !== false,
          leverage: user.leverage || 5,
          brokerage_rate: user.brokerage_rate || 0.0003,
          max_saved_accounts: user.max_saved_accounts || 3,
          closing_mode: user.closing_mode || false,
          created_at: user.created_at,
          accounts: accounts || [],
        };
      })
    );

    res.json({ success: true, data: usersWithAccounts });
  } catch (error) {
    console.error('listUsers error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { 
      loginId,
      password, 
      firstName, 
      lastName, 
      phone, 
      email,
      role = 'user',
      leverage = 300,
      brokerageRate = 0.0006,
      maxSavedAccounts = 10,
      demoBalance = 100000,
      createDemo = true,
      createLive = true,
    } = req.body;

    if (!loginId || !loginId.trim()) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    if (!createDemo && !createLive) {
      return res.status(400).json({ success: false, message: 'Select at least one account type' });
    }

    const cleanLoginId = loginId.trim().toUpperCase();

    // Check if loginId already exists
    const { data: existingById } = await supabase
      .from('users')
      .select('id')
      .eq('login_id', cleanLoginId)
      .maybeSingle();

    if (existingById) {
      return res.status(400).json({ success: false, message: `User ID "${cleanLoginId}" already exists. Choose a different one.` });
    }

    // Also check user_id column
    const { data: existingByUserId } = await supabase
      .from('users')
      .select('id')
      .eq('user_id', cleanLoginId)
      .maybeSingle();

    if (existingByUserId) {
      return res.status(400).json({ success: false, message: `User ID "${cleanLoginId}" already exists. Choose a different one.` });
    }

    // If email provided, check uniqueness
    const userEmail = email ? email.toLowerCase().trim() : `${cleanLoginId.toLowerCase()}@tradeaxis.local`;
    
    if (email) {
      const { data: existingEmail } = await supabase
        .from('users')
        .select('id')
        .eq('email', userEmail)
        .maybeSingle();

      if (existingEmail) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
      }
    }

    // Default password is TA2626
    const userPassword = password || 'TA1234';
    const hashedPassword = await bcrypt.hash(userPassword, 12);

    // must_change_password = true means first login will prompt password change
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([{
        user_id: cleanLoginId,
        login_id: cleanLoginId,
        email: userEmail,
        password_hash: hashedPassword,
        first_name: String(firstName || cleanLoginId).trim().substring(0, 50),
        last_name: String(lastName || '').trim().substring(0, 50),
        phone: String(phone || '').trim().substring(0, 15),
        role: (role || 'user').substring(0, 20),
        is_verified: false,
        is_active: true,
        max_saved_accounts: Number(maxSavedAccounts) || 10,
        closing_mode: false,
        must_change_password: true,
      }])
      .select()
      .single();

    if (userError) {
      console.error('Create user error:', JSON.stringify(userError));
      return res.status(500).json({ 
        success: false, 
        message: `Database error: ${userError.message}` 
      });
    }

    // Update optional fields separately (in case columns don't exist yet)
    try {
      await supabase
        .from('users')
        .update({
          leverage: Number(leverage) || 300,
          brokerage_rate: Number(brokerageRate) || 0.0006,
        })
        .eq('id', user.id);
    } catch (e) {
      // silent — columns may not exist
    }

    // Create accounts
    const { generateAccountNumber } = require('../utils/auth');

    if (createDemo) {
      const accNum = generateAccountNumber(true);
      const { error: demoErr } = await supabase
        .from('accounts')
        .insert([{
          user_id: user.id,
          account_number: accNum.substring(0, 20),
          account_type: 'demo',
          is_demo: true,
          balance: Number(demoBalance) || 100000,
          equity: Number(demoBalance) || 100000,
          margin: 0,
          free_margin: Number(demoBalance) || 100000,
          leverage: Number(leverage) || 300,
          currency: 'INR',
          is_active: true,
        }]);
      if (demoErr) console.error('Demo account error:', demoErr);
    }

    if (createLive) {
      const accNum = generateAccountNumber(false);
      const { error: liveErr } = await supabase
        .from('accounts')
        .insert([{
          user_id: user.id,
          account_number: accNum.substring(0, 20),
          account_type: 'standard',
          is_demo: false,
          balance: 0,
          equity: 0,
          margin: 0,
          free_margin: 0,
          leverage: Number(leverage) || 300,
          currency: 'INR',
          is_active: true,
        }]);
      if (liveErr) console.error('Live account error:', liveErr);
    }

    res.json({ 
      success: true, 
      data: {
        user,
        loginId: cleanLoginId,
        tempPassword: userPassword === 'TA1234' ? 'TA1234' : null,
      },
      message: `User ${cleanLoginId} created successfully` 
    });
  } catch (error) {
    console.error('createUser full error:', error);
    res.status(500).json({ success: false, message: `Server error: ${error.message}` });
  }
};

exports.setUserActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const { error } = await supabase
      .from('users')
      .update({ is_active: isActive })
      .eq('id', id);

    if (error) {
      console.error('setUserActive error:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    res.json({ success: true, message: `User ${isActive ? 'activated' : 'deactivated'}` });
  } catch (error) {
    console.error('setUserActive error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    const tempPassword = newPassword || generateTempPassword();

    if (tempPassword.length < 4) {
      return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
    }

    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    const { error } = await supabase
      .from('users')
      .update({ password_hash: hashedPassword })
      .eq('id', id);

    if (error) throw error;

    res.json({ 
      success: true, 
      data: { tempPassword },
      message: 'Password reset successfully' 
    });
  } catch (error) {
    console.error('resetPassword error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getLeverageOptions = async (req, res) => {
  res.json({
    success: true,
    options: [1, 2, 5, 10, 20, 25, 50, 100, 200, 300, 500, 1000],
  });
};

exports.updateUserLeverage = async (req, res) => {
  try {
    const { id } = req.params;
    const { leverage, accountId } = req.body;

    if (!leverage || isNaN(Number(leverage))) {
      return res.status(400).json({ success: false, message: 'Valid leverage value is required' });
    }

    const leverageNum = Number(leverage);

    if (accountId) {
      const { error: accountError } = await supabase
        .from('accounts')
        .update({ leverage: leverageNum })
        .eq('id', accountId);

      if (accountError) {
        console.error('Update account leverage error:', accountError);
        return res.status(500).json({ 
          success: false, 
          message: `Failed to update account leverage: ${accountError.message}` 
        });
      }
    } else {
      const { error: accountError } = await supabase
        .from('accounts')
        .update({ leverage: leverageNum })
        .eq('user_id', id);

      if (accountError) {
        console.error('Update accounts leverage error:', accountError);
        return res.status(500).json({ 
          success: false, 
          message: `Failed to update accounts leverage: ${accountError.message}` 
        });
      }

      try {
        await supabase
          .from('users')
          .update({ leverage: leverageNum })
          .eq('id', id);
      } catch (userErr) {
        console.warn('User leverage column may not exist:', userErr.message);
      }
    }

    res.json({ success: true, message: `Leverage updated to 1:${leverageNum}` });
  } catch (error) {
    console.error('updateUserLeverage error:', error);
    res.status(500).json({ success: false, message: `Server error: ${error.message}` });
  }
};

exports.updateBrokerageRate = async (req, res) => {
  try {
    const { id } = req.params;
    const { brokerageRate } = req.body;

    const { error } = await supabase
      .from('users')
      .update({ brokerage_rate: Number(brokerageRate) })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Brokerage rate updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateMaxSavedAccounts = async (req, res) => {
  try {
    const { id } = req.params;
    const { maxSavedAccounts } = req.body;

    const { error } = await supabase
      .from('users')
      .update({ max_saved_accounts: Number(maxSavedAccounts) })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Max saved accounts updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.toggleClosingMode = async (req, res) => {
  try {
    const { id } = req.params;
    const { closingMode } = req.body;

    const { error } = await supabase
      .from('users')
      .update({ closing_mode: closingMode })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: `Closing mode ${closingMode ? 'enabled' : 'disabled'}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addBalanceToAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { accountId, amount, accountType = 'live', note = 'Admin deposit' } = req.body;

    if (!amount || amount === 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const isReduction = amount < 0;
    const absAmount = Math.abs(amount);

    let account;

    if (accountId) {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', accountId)
        .single();

      if (error || !data) {
        return res.status(404).json({ success: false, message: 'Account not found' });
      }
      account = data;
    } else {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', id)
        .eq('is_demo', accountType === 'demo')
        .single();

      if (error || !data) {
        return res.status(404).json({ success: false, message: 'Account not found' });
      }
      account = data;
    }

    const currentBalance = parseFloat(account.balance || 0);

    // For reductions, validate sufficient balance
    if (isReduction && absAmount > currentBalance) {
      return res.status(400).json({
        success: false,
        message: `Cannot reduce ₹${absAmount}. Current balance is ₹${currentBalance.toFixed(2)}`,
      });
    }

    const newBalance = currentBalance + parseFloat(amount); // amount is negative for reductions
    const newEquity = parseFloat(account.equity || 0) + parseFloat(amount);
    const newFreeMargin = newEquity - parseFloat(account.margin || 0);

    const { error: updateError } = await supabase
      .from('accounts')
      .update({
        balance: newBalance,
        equity: newEquity,
        free_margin: newFreeMargin,
      })
      .eq('id', account.id);

    if (updateError) throw updateError;

    await supabase.from('transactions').insert({
      user_id: id,
      account_id: account.id,
      type: isReduction ? 'withdrawal' : 'deposit',
      amount: absAmount,
      status: 'completed',
      description: note || (isReduction ? 'Admin reduction' : 'Admin deposit'),
    });

    res.json({
      success: true,
      message: isReduction
        ? `₹${absAmount} reduced from account. New balance: ₹${newBalance.toFixed(2)}`
        : `₹${absAmount} added to account. New balance: ₹${newBalance.toFixed(2)}`,
      newBalance,
    });
  } catch (error) {
    console.error('addBalanceToAccount error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============ DELETE USER ============
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id, email, login_id')
      .eq('id', id)
      .single();

    if (findError || !user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Close all open trades first
    try {
      await supabase
        .from('trades')
        .update({ status: 'closed', close_time: new Date().toISOString() })
        .eq('user_id', id)
        .eq('status', 'open');
    } catch (e) {
      console.warn('Close trades error:', e.message);
    }

    // Delete pending orders
    try {
      await supabase.from('pending_orders').delete().eq('user_id', id);
    } catch (e) { /* table may not exist */ }

    // Delete transactions
    try {
      await supabase.from('transactions').delete().eq('user_id', id);
    } catch (e) {
      console.warn('Delete transactions error:', e.message);
    }

    // Delete trades
    try {
      await supabase.from('trades').delete().eq('user_id', id);
    } catch (e) {
      console.warn('Delete trades error:', e.message);
    }

    // Delete accounts
    try {
      await supabase.from('accounts').delete().eq('user_id', id);
    } catch (e) {
      console.warn('Delete accounts error:', e.message);
    }

    // Delete user
    const { error: deleteError } = await supabase
      .from('users')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('Delete user error:', deleteError);
      return res.status(500).json({ success: false, message: `Failed to delete user: ${deleteError.message}` });
    }

    res.json({ 
      success: true, 
      message: `User ${user.login_id || user.email} deleted successfully` 
    });
  } catch (error) {
    console.error('deleteUser error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============ WITHDRAWAL FUNCTIONS ============

exports.listWithdrawals = async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from('transactions')
      .select(`
        *,
        users:user_id (email, first_name, last_name, login_id),
        accounts:account_id (account_number, is_demo)
      `)
      .eq('type', 'withdrawal')
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('listWithdrawals error:', error);
      throw error;
    }

    const withdrawals = (data || []).map(w => ({
      ...w,
      user_email: w.users?.email || '',
      user_name: w.users ? `${w.users.first_name || ''} ${w.users.last_name || ''}`.trim() : '',
      user_login_id: w.users?.login_id || '',
      account_number: w.accounts?.account_number || '',
      is_demo: w.accounts?.is_demo || false,
    }));

    res.json({ success: true, data: withdrawals });
  } catch (error) {
    console.error('listWithdrawals error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.approveWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body;

    const { data: txn, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();

    if (findError || !txn) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (txn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Transaction is not pending' });
    }

    const { error: updateError } = await supabase
      .from('transactions')
      .update({
        status: 'completed',
        admin_note: adminNote || 'Approved by admin',
        processed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) throw updateError;

    res.json({ success: true, message: 'Withdrawal approved' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.rejectWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body;

    const { data: txn, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();

    if (findError || !txn) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (txn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Transaction is not pending' });
    }

    const { data: account } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', txn.account_id)
      .single();

    if (account) {
      const newBalance = parseFloat(account.balance || 0) + parseFloat(txn.amount || 0);
      const newEquity = parseFloat(account.equity || 0) + parseFloat(txn.amount || 0);

      await supabase
        .from('accounts')
        .update({
          balance: newBalance,
          equity: newEquity,
          free_margin: newEquity - parseFloat(account.margin || 0),
        })
        .eq('id', txn.account_id);
    }

    const { error: updateError } = await supabase
      .from('transactions')
      .update({
        status: 'rejected',
        admin_note: adminNote || 'Rejected by admin',
        processed_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) throw updateError;

    res.json({ success: true, message: 'Withdrawal rejected and amount refunded' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============ PENDING ORDER STUBS ============
exports.modifyPendingOrder = async (req, res) => {
  res.json({ success: true, message: 'Not implemented' });
};

exports.cancelPendingOrder = async (req, res) => {
  res.json({ success: true, message: 'Not implemented' });
};

exports.cancelAllPendingOrders = async (req, res) => {
  res.json({ success: true, message: 'Not implemented' });
};

// ============ KITE CONNECT FUNCTIONS ============

exports.getKiteLoginUrl = async (req, res) => {
  try {
    await kiteService.init();

    if (!kiteService.isConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Kite API key/secret not configured in .env',
        instructions: [
          '1. Get API credentials from https://developers.kite.trade',
          '2. Add KITE_API_KEY and KITE_API_SECRET to backend/.env',
          '3. Restart the server',
        ],
      });
    }

    const loginUrl = kiteService.getLoginURL();

    res.json({
      success: true,
      loginUrl,
      instructions: [
        '1. Click the login URL and login with your Zerodha credentials',
        '2. After login, you will be redirected to a URL with request_token parameter',
        '3. Copy the request_token value from the URL',
        '4. Use the "Set Token" button to save it',
      ],
    });
  } catch (error) {
    console.error('getKiteLoginUrl error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createKiteSession = async (req, res) => {
  try {
    const { requestToken } = req.body;

    if (!requestToken) {
      return res.status(400).json({
        success: false,
        message: 'requestToken is required',
      });
    }

    const session = await kiteService.generateSession(requestToken.trim());

    res.json({
      success: true,
      message: 'Kite session created successfully! Token valid until tomorrow 6 AM IST.',
      userId: session.userId,
      createdAt: session.createdAt,
    });
  } catch (error) {
    console.error('createKiteSession error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.syncKiteSymbols = async (req, res) => {
  try {
    await kiteService.init();

    if (!kiteService.isSessionReady()) {
      return res.status(400).json({
        success: false,
        message: 'Kite session not ready. Please create session first.',
      });
    }

    const result = await kiteService.syncSymbolsToDB();

    res.json({
      success: true,
      message: `Synced ${result.count} symbols from ${result.underlyings} underlyings`,
      ...result,
    });
  } catch (error) {
    console.error('syncKiteSymbols error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.startKiteStream = async (req, res) => {
  try {
    const io = req.app.get('io');

    if (!io) {
      return res.status(500).json({ success: false, message: 'Socket.IO not available' });
    }

    const result = await kiteStreamService.start(io);

    if (result.started) {
      res.json({
        success: true,
        message: `Kite stream started with ${result.tokens} symbols`,
        ...result,
      });
    } else {
      res.status(400).json({
        success: false,
        message: `Stream not started: ${result.reason}`,
        ...result,
      });
    }
  } catch (error) {
    console.error('startKiteStream error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.stopKiteStream = async (req, res) => {
  try {
    const result = await kiteStreamService.stop();
    res.json({ success: true, message: 'Kite stream stopped', ...result });
  } catch (error) {
    console.error('stopKiteStream error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.kiteStatus = async (req, res) => {
  try {
    await kiteService.init();

    const streamStatus = kiteStreamService.status();
    const sessionReady = kiteService.isSessionReady();
    const configured = kiteService.isConfigured();

    let profileValid = false;
    let profile = null;

    if (sessionReady && kiteService.kc) {
      try {
        profile = await kiteService.kc.getProfile();
        profileValid = true;
      } catch (err) {
        profileValid = false;
      }
    }

    res.json({
      success: true,
      configured,
      sessionReady,
      profileValid,
      profile: profile
        ? {
            userName: profile.user_name,
            email: profile.email,
            userId: profile.user_id,
          }
        : null,
      stream: streamStatus,
    });
  } catch (error) {
    console.error('kiteStatus error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============ MARKET HOLIDAY TOGGLE ============
exports.setMarketHoliday = async (req, res) => {
  try {
    const { isHoliday, message } = req.body;
    const { setHoliday, getHolidayStatus } = require('../services/marketStatus');

    setHoliday(!!isHoliday, message || '');

    const status = getHolidayStatus();
    res.json({
      success: true,
      data: status,
      message: status.isHoliday
        ? `Market holiday enabled: ${status.message}`
        : 'Market holiday disabled. Normal trading resumed.',
    });
  } catch (error) {
    console.error('setMarketHoliday error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMarketHoliday = async (req, res) => {
  try {
    const { getHolidayStatus, isMarketOpen } = require('../services/marketStatus');
    const status = getHolidayStatus();

    res.json({
      success: true,
      data: {
        ...status,
        marketOpen: isMarketOpen(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============ ADMIN MANUAL CLOSE POSITION ============
exports.adminClosePosition = async (req, res) => {
  try {
    const { tradeId, closePrice: manualPrice, reason } = req.body;

    if (!tradeId) {
      return res.status(400).json({ success: false, message: 'Trade ID is required' });
    }

    // Get the trade
    const { data: trade, error: tradeError } = await supabase
      .from('trades')
      .select('*, accounts!inner(user_id, balance, margin)')
      .eq('id', tradeId)
      .eq('status', 'open')
      .single();

    if (tradeError || !trade) {
      return res.status(404).json({ success: false, message: 'Trade not found or already closed' });
    }

    // Get user brokerage rate
    const { data: userData } = await supabase
      .from('users')
      .select('brokerage_rate')
      .eq('id', trade.accounts.user_id)
      .single();

    const brokerageRate = userData?.brokerage_rate || 0.0003;

    // Determine close price
    let closePrice;
    if (manualPrice && Number(manualPrice) > 0) {
      closePrice = Number(manualPrice);
    } else {
      // Use live price
      const kiteStreamService = require('../services/kiteStreamService');
      const livePrice = kiteStreamService.getPrice(trade.symbol);
      if (livePrice) {
        closePrice = trade.trade_type === 'buy' ? livePrice.bid : livePrice.ask;
      } else {
        closePrice = parseFloat(trade.current_price || trade.open_price);
      }
    }

    if (!closePrice || closePrice <= 0) {
      return res.status(400).json({ success: false, message: 'Cannot determine close price' });
    }

    const tradeQuantity = parseFloat(trade.quantity);
    const direction = trade.trade_type === 'buy' ? 1 : -1;
    const priceDiff = (closePrice - parseFloat(trade.open_price)) * direction;
    const grossProfit = priceDiff * tradeQuantity;
    
    const sellBrokerage = closePrice * tradeQuantity * brokerageRate;
    const buyBrokerage = parseFloat(trade.buy_brokerage || trade.brokerage || 0);
    const totalBrokerage = buyBrokerage + sellBrokerage;
    const netProfit = grossProfit - totalBrokerage;

    const closeTime = new Date().toISOString();

    // Close the trade
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
        comment: `Admin close: ${reason || 'Manual close by admin'}`,
      })
      .eq('id', tradeId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Update account
    const newBalance = parseFloat(trade.accounts.balance) + netProfit;
    const newMargin = Math.max(0, parseFloat(trade.accounts.margin) - parseFloat(trade.margin || 0));

    await supabase
      .from('accounts')
      .update({
        balance: newBalance,
        margin: newMargin,
        free_margin: newBalance - newMargin,
        updated_at: closeTime,
      })
      .eq('id', trade.account_id);

    res.json({
      success: true,
      data: closedTrade,
      message: `Admin closed ${trade.symbol} ${trade.trade_type.toUpperCase()} x${tradeQuantity} @ ₹${closePrice.toFixed(2)}. P&L: ₹${netProfit.toFixed(2)}`,
    });
  } catch (error) {
    console.error('adminClosePosition error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};