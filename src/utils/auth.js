// backend/src/utils/auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/supabase');

// Hash password
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(12);
  return await bcrypt.hash(password, salt);
};

// Compare password
const comparePassword = async (enteredPassword, hashedPassword) => {
  return await bcrypt.compare(enteredPassword, hashedPassword);
};

// Generate JWT token
const generateToken = (userId, loginId) => {
  return jwt.sign(
    { id: userId, loginId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '30d' }
  );
};

// Verify JWT token
const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

// Generate account number
const generateAccountNumber = (isDemo) => {
  const prefix = isDemo ? 'DEM' : 'TAX';
  const random = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}${random}`;
};

// ✅ NEW: Generate Login ID (TA1000, TA1001, etc.)
const generateLoginId = async () => {
  try {
    // Get and increment the counter
    const { data, error } = await supabase
      .rpc('generate_login_id');
    
    if (error) {
      // Fallback: use timestamp-based ID
      console.error('RPC error, using fallback:', error);
      const ts = Date.now().toString(36).toUpperCase();
      return `TA${ts}`;
    }
    
    return data;
  } catch (e) {
    // Fallback: manual counter update
    console.error('Generate login ID error:', e);
    
    try {
      // Manual approach
      const { data: counter, error: fetchError } = await supabase
        .from('system_counters')
        .select('counter_value')
        .eq('counter_name', 'login_id')
        .single();
      
      if (fetchError || !counter) {
        // Create counter if doesn't exist
        await supabase
          .from('system_counters')
          .upsert({ counter_name: 'login_id', counter_value: 1001 });
        return 'TA1001';
      }
      
      const nextValue = counter.counter_value + 1;
      await supabase
        .from('system_counters')
        .update({ counter_value: nextValue })
        .eq('counter_name', 'login_id');
      
      return `TA${nextValue}`;
    } catch (fallbackError) {
      // Ultimate fallback
      const ts = Date.now().toString().slice(-6);
      return `TA${ts}`;
    }
  }
};

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  generateAccountNumber,
  generateLoginId, // ✅ NEW
};