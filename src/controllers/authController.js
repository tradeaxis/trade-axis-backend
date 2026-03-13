// backend/src/controllers/authController.js
const { supabase } = require('../config/supabase');
const jwt = require('jsonwebtoken');
const { hashPassword, comparePassword, generateToken, generateAccountNumber, generateLoginId } = require('../utils/auth');
const register = async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const loginId = await generateLoginId();
    const hashedPassword = await hashPassword(password);

    const { data: user, error: userError } = await supabase
      .from('users')
      .insert([{
        login_id: loginId,
        email: email.toLowerCase(),
        password_hash: hashedPassword,
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        is_verified: false,
        is_active: true,
        role: 'user',
        max_saved_accounts: -1,
        closing_mode: false,
      }])
      .select('id, login_id, email, first_name, last_name, phone, role, is_verified, max_saved_accounts, closing_mode')
      .single();

    if (userError) throw userError;

    const demoAccountNumber = generateAccountNumber(true);
    const { data: demoAccount, error: demoError } = await supabase
      .from('accounts')
      .insert([{
        user_id: user.id,
        account_number: demoAccountNumber,
        account_type: 'demo',
        balance: 100000, equity: 100000, free_margin: 100000,
        leverage: 5, currency: 'INR', is_demo: true, is_active: true
      }])
      .select().single();

    if (demoError) console.error('Demo account creation error:', demoError);

    const liveAccountNumber = generateAccountNumber(false);
    const { data: liveAccount, error: liveError } = await supabase
      .from('accounts')
      .insert([{
        user_id: user.id,
        account_number: liveAccountNumber,
        account_type: 'standard',
        balance: 0, equity: 0, free_margin: 0,
        leverage: 5, currency: 'INR', is_demo: false, is_active: true
      }])
      .select().single();

    if (liveError) console.error('Live account creation error:', liveError);

    const token = generateToken(user.id, user.login_id);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: {
          id: user.id, loginId: user.login_id, email: user.email,
          firstName: user.first_name, lastName: user.last_name, phone: user.phone,
          role: user.role, isVerified: user.is_verified,
          maxSavedAccounts: user.max_saved_accounts, closingMode: user.closing_mode,
        },
        accounts: [demoAccount, liveAccount].filter(Boolean),
        token,
        tempLoginId: loginId,
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Registration failed', error: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: 'Login ID and password are required' });
    }

    let user;
    const normalizedInput = loginId.trim();
    const isLoginId = /^TA\d+$/i.test(normalizedInput);
    
    if (isLoginId) {
      const { data, error } = await supabase
        .from('users').select('*')
        .eq('login_id', normalizedInput.toUpperCase()).single();
      user = data;
      if (error && error.code !== 'PGRST116') console.error(error);
    } else {
      const { data, error } = await supabase
        .from('users').select('*')
        .eq('email', normalizedInput.toLowerCase()).single();
      user = data;
      if (error && error.code !== 'PGRST116') console.error(error);
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid Login ID or password' });
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid Login ID or password' });
    }

    if (!user.is_active) {
      return res.status(401).json({ success: false, message: 'Your account has been deactivated' });
    }

    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const { data: accounts } = await supabase
      .from('accounts').select('*').eq('user_id', user.id).eq('is_active', true);

    const token = generateToken(user.id, user.login_id);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id, loginId: user.login_id, email: user.email,
          firstName: user.first_name, lastName: user.last_name, phone: user.phone,
          role: user.role, isVerified: user.is_verified, kycStatus: user.kyc_status,
          maxSavedAccounts: user.max_saved_accounts || -1,
          closingMode: user.closing_mode || false,
        },
        accounts: accounts,
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed', error: error.message });
  }
};

const getMe = async (req, res) => {
  try {
    const { data: accounts } = await supabase
      .from('accounts').select('*').eq('user_id', req.user.id).eq('is_active', true);

    const { data: userData } = await supabase
      .from('users')
      .select('login_id, max_saved_accounts, closing_mode, brokerage_rate')
      .eq('id', req.user.id).single();

    const { data: fullUser } = await supabase
      .from('users')
      .select('login_id, max_saved_accounts, closing_mode, brokerage_rate, must_change_password, first_name, last_name')
      .eq('id', req.user.id).single();

    res.status(200).json({
      success: true,
      data: {
        user: {
          ...req.user,
          loginId: fullUser?.login_id,
          firstName: fullUser?.first_name,
          lastName: fullUser?.last_name,
          maxSavedAccounts: fullUser?.max_saved_accounts ?? -1,
          closingMode: fullUser?.closing_mode ?? false,
          brokerageRate: fullUser?.brokerage_rate ?? 0.0006,
          mustChangePassword: fullUser?.must_change_password ?? false,
        },
        accounts: accounts
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ FIXED: saved account switching should keep working until user manually removes/logout
const switchAccount = async (req, res) => {
  try {
    const { loginId, email, token: savedToken } = req.body;

    const identifier = String(loginId || email || '').trim();

    if (!identifier || !savedToken) {
      return res.status(400).json({
        success: false,
        message: 'Login ID (or email) and token required'
      });
    }

    let decoded = null;

    try {
      // ✅ IMPORTANT:
      // Ignore JWT expiry for saved-account switching, but still verify signature
      decoded = jwt.verify(savedToken, process.env.JWT_SECRET, {
        ignoreExpiration: true,
      });
    } catch (err) {
      console.error('Switch account token verify error:', err.message);
      return res.status(401).json({
        success: false,
        message: 'Saved session invalid. Please login to this account again.'
      });
    }

    const decodedUserId = decoded?.id || decoded?.userId || decoded?._id || null;

    let user = null;

    // First try by token user id
    if (decodedUserId) {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', decodedUserId)
        .maybeSingle();

      if (!error && data) {
        user = data;
      }
    }

    // Fallback by identifier
    if (!user) {
      const identifierUpper = identifier.toUpperCase();
      const identifierLower = identifier.toLowerCase();

      if (/^TA/i.test(identifierUpper)) {
        const { data } = await supabase
          .from('users')
          .select('*')
          .eq('login_id', identifierUpper)
          .maybeSingle();

        if (data) user = data;
      }

      if (!user) {
        const { data } = await supabase
          .from('users')
          .select('*')
          .eq('email', identifierLower)
          .maybeSingle();

        if (data) user = data;
      }
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Account not found'
      });
    }

    const identifierUpper = identifier.toUpperCase();
    const identifierLower = identifier.toLowerCase();

    const matchesLoginId =
      String(user.login_id || '').toUpperCase() === identifierUpper;

    const matchesEmail =
      String(user.email || '').toLowerCase() === identifierLower;

    if (!matchesLoginId && !matchesEmail) {
      return res.status(401).json({
        success: false,
        message: 'Account mismatch'
      });
    }

    // Extra protection: token must belong to same user if token had id
    if (decodedUserId && user.id !== decodedUserId) {
      return res.status(401).json({
        success: false,
        message: 'Saved session does not belong to this account'
      });
    }

    if (!user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Account has been deactivated'
      });
    }

    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    const { data: accounts, error: accountsError } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true);

    if (accountsError) {
      console.error('Switch account accounts fetch error:', accountsError);
      throw accountsError;
    }

    const newToken = generateToken(user.id, user.login_id);

    res.status(200).json({
      success: true,
      message: 'Switched account successfully',
      data: {
        user: {
          id: user.id,
          loginId: user.login_id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          phone: user.phone,
          role: user.role,
          isVerified: user.is_verified,
          kycStatus: user.kyc_status,
          maxSavedAccounts: user.max_saved_accounts ?? -1,
          closingMode: user.closing_mode ?? false,
          mustChangePassword: user.must_change_password ?? false,
        },
        accounts: accounts || [],
        token: newToken
      }
    });
  } catch (error) {
    console.error('Switch account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to switch account',
      error: error.message
    });
  }
};

const logout = (req, res) => {
  res.status(200).json({ success: true, message: 'Logged out successfully' });
};

const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, message: 'New password must be different from current password' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isValid = await comparePassword(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const newHash = await hashPassword(newPassword);

    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        password_hash: newHash,
        must_change_password: false,
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
};

module.exports = { register, login, getMe, logout, switchAccount, changePassword };