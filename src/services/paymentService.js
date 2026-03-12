const Razorpay = require('razorpay');
const crypto = require('crypto');
const { supabase } = require('../config/supabase');

class PaymentService {
  constructor() {
    const hasKeys = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    this.mode = process.env.PAYMENTS_MODE || (hasKeys ? 'razorpay' : 'mock');

    this.razorpay =
      this.mode === 'razorpay' && hasKeys
        ? new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
          })
        : null;
  }

  getRazorpayKey() {
    // Only expose key if Razorpay is actually enabled
    if (this.mode !== 'razorpay') return null;
    return process.env.RAZORPAY_KEY_ID || null;
  }

  generateReference(type) {
    const prefix = type === 'deposit' ? 'DEP' : 'WTH';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}${timestamp}${random}`;
  }

  // -----------------------
  // MOCK DEPOSIT (no gateway)
  // -----------------------
  async mockDeposit(userId, accountId, amount) {
    // Get account
    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accErr || !account) throw new Error('Account not found');
    if (account.is_demo) throw new Error('Cannot deposit to demo account');

    const newBalance = parseFloat(account.balance) + parseFloat(amount);

    // Create transaction (use allowed payment_method value to match your DB constraint)
    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .insert([
        {
          user_id: userId,
          account_id: accountId,
          transaction_type: 'deposit',
          amount: amount,
          payment_method: 'bank_transfer', // keep compatible with your existing CHECK constraint
          status: 'completed',
          reference: this.generateReference('deposit'),
          balance_before: account.balance,
          balance_after: newBalance,
          processed_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (txnErr) throw txnErr;

    // Update account
    await supabase
      .from('accounts')
      .update({
        balance: newBalance,
        equity: newBalance + parseFloat(account.profit || 0),
        free_margin: newBalance + parseFloat(account.profit || 0) - parseFloat(account.margin || 0),
      })
      .eq('id', accountId);

    return {
      mock: true,
      transaction: txn,
      newBalance,
    };
  }

  // -----------------------
  // CREATE DEPOSIT ORDER
  // (Razorpay OR Mock)
  // -----------------------
  async createDepositOrder(userId, accountId, amount) {
    if (amount < 100) throw new Error('Minimum deposit is ₹100');
    if (amount > 1000000) throw new Error('Maximum deposit is ₹10,00,000');

    // If no keys / mock mode => instantly credit
    if (this.mode !== 'razorpay' || !this.razorpay) {
      const result = await this.mockDeposit(userId, accountId, amount);
      return {
        mock: true,
        completed: true,
        ...result,
      };
    }

    // Razorpay mode (when you add keys later)
    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accErr || !account) throw new Error('Account not found');
    if (account.is_demo) throw new Error('Cannot deposit to demo account');

    const order = await this.razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `deposit_${Date.now()}`,
      notes: { userId, accountId, type: 'deposit' },
    });

    // IMPORTANT: Your DB constraint may not allow payment_method='razorpay' yet.
    // Keep it 'bank_transfer' for now. Later (when funded), update constraint.
    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .insert([
        {
          user_id: userId,
          account_id: accountId,
          transaction_type: 'deposit',
          amount: amount,
          payment_method: 'bank_transfer',
          payment_transaction_id: order.id,
          status: 'pending',
          reference: this.generateReference('deposit'),
          balance_before: account.balance,
        },
      ])
      .select()
      .single();

    if (txnErr) throw txnErr;

    return {
      mock: false,
      orderId: order.id,
      amount,
      currency: 'INR',
      transactionId: txn.id,
      reference: txn.reference,
    };
  }

  verifyPaymentSignature(orderId, paymentId, signature) {
    const text = `${orderId}|${paymentId}`;
    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(text)
      .digest('hex');
    return generated === signature;
  }

  async confirmDeposit(orderId, paymentId, signature) {
    if (this.mode !== 'razorpay' || !this.razorpay) {
      throw new Error('Razorpay not configured. Using mock payments right now.');
    }

    const ok = this.verifyPaymentSignature(orderId, paymentId, signature);
    if (!ok) throw new Error('Invalid payment signature');

    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('payment_transaction_id', orderId)
      .single();

    if (txnErr || !txn) throw new Error('Transaction not found');
    if (txn.status === 'completed') return txn;

    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', txn.account_id)
      .single();

    if (accErr || !account) throw new Error('Account not found');

    const newBalance = parseFloat(account.balance) + parseFloat(txn.amount);

    await supabase
      .from('accounts')
      .update({
        balance: newBalance,
        equity: newBalance + parseFloat(account.profit || 0),
        free_margin: newBalance + parseFloat(account.profit || 0) - parseFloat(account.margin || 0),
      })
      .eq('id', txn.account_id);

    const { data: updated, error: upErr } = await supabase
      .from('transactions')
      .update({
        status: 'completed',
        balance_after: newBalance,
        processed_at: new Date().toISOString(),
      })
      .eq('id', txn.id)
      .select()
      .single();

    if (upErr) throw upErr;
    return updated;
  }

  // Withdrawals can remain “request” based now; keep your earlier logic if you want.
  async createWithdrawalRequest(userId, accountId, amount, bankDetails) {
    if (amount < 100) throw new Error('Minimum withdrawal is ₹100');

    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (accErr || !account) throw new Error('Account not found');
    if (account.is_demo) throw new Error('Cannot withdraw from demo account');

    if (amount > parseFloat(account.free_margin)) {
      throw new Error(`Insufficient funds. Available: ₹${account.free_margin}`);
    }

    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .insert([
        {
          user_id: userId,
          account_id: accountId,
          transaction_type: 'withdrawal',
          amount,
          payment_method: 'bank_transfer',
          bank_name: bankDetails.bankName,
          account_number_masked: `XXXX${bankDetails.accountNumber.slice(-4)}`,
          ifsc_code: bankDetails.ifscCode,
          status: 'pending',
          reference: this.generateReference('withdrawal'),
          balance_before: account.balance,
        },
      ])
      .select()
      .single();

    if (txnErr) throw txnErr;

    return txn;
  }
}

module.exports = new PaymentService();