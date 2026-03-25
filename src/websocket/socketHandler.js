// backend/src/websocket/socketHandler.js
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/supabase');
const marketDataService = require('../services/marketDataService');
const kiteStreamService = require('../services/kiteStreamService');
const tradingService = require('../services/tradingService');
const { isMarketOpen, isAnyMarketOpen } = require('../services/marketStatus');

// ✅ Stop-out level — auto-close when margin level falls below this %
const STOP_OUT_LEVEL = 10; // 10%

class SocketHandler {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map();
    this.userSubscriptions = new Map();
    this.pnlUpdateInterval = null;
    this.pnlDbCounter = 0;

    // ✅ Track which trades are currently being closed to prevent duplicate closures
    this.closingTrades = new Set();

    this.initialize();
  }

  initialize() {
    this.io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) return next(new Error('Authentication required'));

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const { data: user, error } = await supabase
          .from('users')
          .select('id, email, first_name, last_name, role')
          .eq('id', decoded.id)
          .single();

        if (error || !user) return next(new Error('User not found'));

        socket.userId = user.id;
        socket.user = user;
        next();
      } catch {
        next(new Error('Invalid token'));
      }
    });

    this.io.on('connection', (socket) => this.handleConnection(socket));

    this.startPnLUpdates();
    console.log('📈 Simulation REMOVED — prices come only from Kite stream');
  }

  handleConnection(socket) {
    console.log(`✅ WS: ${socket.user.email}`);

    this.connectedUsers.set(socket.userId, socket);
    socket.join(`user:${socket.userId}`);

    socket.emit('connected', {
      message: 'Connected to Trade Axis',
      user: socket.user,
      kiteStream: kiteStreamService.isRunning(),
      timestamp: new Date().toISOString(),
    });

    socket.on('subscribe:symbols', (s) => this.handleSubscribe(socket, s));
    socket.on('unsubscribe:symbols', (s) => this.handleUnsubscribe(socket, s));
    socket.on('subscribe:account', (id) => {
      socket.join(`account:${id}`);
      socket.emit('account:subscribed', { accountId: id });
    });
    socket.on('get:quote', (sym) => this.handleGetQuote(socket, sym));
    socket.on('ping', () => socket.emit('pong', { timestamp: Date.now() }));
    socket.on('disconnect', () => this.handleDisconnect(socket));

    this.sendInitialData(socket);
  }

  async sendInitialData(socket) {
    try {
      const [{ data: accounts }, { data: trades }] = await Promise.all([
        supabase
          .from('accounts')
          .select('*')
          .eq('user_id', socket.userId)
          .eq('is_active', true),
        supabase
          .from('trades')
          .select('*')
          .eq('user_id', socket.userId)
          .eq('status', 'open'),
      ]);

      socket.emit('accounts:update', accounts || []);
      socket.emit('trades:update', trades || []);
    } catch (err) {
      console.error('Initial data error:', err.message);
    }
  }

  handleSubscribe(socket, symbols) {
    if (!Array.isArray(symbols)) symbols = [symbols];

    const subs = this.userSubscriptions.get(socket.userId) || new Set();
    const snapshot = [];

    symbols.forEach((sym) => {
      const s = String(sym).toUpperCase();
      subs.add(s);
      socket.join(`symbol:${s}`);

      const cached = kiteStreamService.getPrice(s);
      if (cached) {
        snapshot.push({
          symbol: s,
          bid: cached.bid,
          ask: cached.ask,
          last: cached.last,
          open: cached.open,
          high: cached.high,
          low: cached.low,
          change: cached.change,
          changePercent: cached.changePct,
          volume: cached.volume,
          timestamp: cached.timestamp,
          source: 'kite',
        });
      }
    });

    this.userSubscriptions.set(socket.userId, subs);

    if (snapshot.length > 0) {
      socket.emit('prices:snapshot', snapshot);
    }

    socket.emit('subscribed', {
      symbols: Array.from(subs),
      message: `Subscribed to ${symbols.length} symbols`,
    });
  }

  handleUnsubscribe(socket, symbols) {
    if (!Array.isArray(symbols)) symbols = [symbols];
    const subs = this.userSubscriptions.get(socket.userId);
    if (subs) {
      symbols.forEach((sym) => {
        const s = String(sym).toUpperCase();
        subs.delete(s);
        socket.leave(`symbol:${s}`);
      });
    }
    socket.emit('unsubscribed', { symbols });
  }

  async handleGetQuote(socket, symbol) {
    try {
      const quote = await marketDataService.getQuote(symbol);
      socket.emit('quote', quote);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  }

  handleDisconnect(socket) {
    console.log(`❌ WS: ${socket.user.email} disconnected`);
    this.connectedUsers.delete(socket.userId);
    this.userSubscriptions.delete(socket.userId);
  }

  startPnLUpdates() {
    this.pnlUpdateInterval = setInterval(async () => {
      try {
        // ✅ Skip P&L updates when ALL markets are closed
        if (!isAnyMarketOpen()) {
          return;
        }

        // 1. Single query for all open trades
        const { data: openTrades, error } = await supabase
          .from('trades')
          .select('*, accounts!inner(user_id, balance, margin)')
          .eq('status', 'open');

        if (error || !openTrades || openTrades.length === 0) return;

        // 2. Unique symbols needed
        const uniqueSymbols = [...new Set(openTrades.map((t) => t.symbol))];

        // 3. Get prices from memory (instant)
        const prices = {};
        const missing = [];
        for (const sym of uniqueSymbols) {
          const c = kiteStreamService.getPrice(sym);
          if (c) {
            prices[sym] = { bid: c.bid, ask: c.ask, last: c.last };
          } else {
            missing.push(sym);
          }
        }

        // 4. Fallback: one batch query for uncached symbols
        if (missing.length > 0) {
          const { data: rows } = await supabase
            .from('symbols')
            .select('symbol, bid, ask, last_price')
            .in('symbol', missing);

          for (const r of rows || []) {
            prices[r.symbol] = {
              bid: Number(r.bid || r.last_price || 0),
              ask: Number(r.ask || r.last_price || 0),
              last: Number(r.last_price || 0),
            };
          }
        }

        // 5. Calculate everything in memory
        const tradeUpdates = [];
        const accountPnL = {};
        const slTpTriggers = [];

        for (const trade of openTrades) {
          const p = prices[trade.symbol];
          if (!p) continue;

          const currentPrice =
            trade.trade_type === 'buy'
              ? p.bid || p.last
              : p.ask || p.last;

          if (!currentPrice || currentPrice <= 0) continue;

          const direction = trade.trade_type === 'buy' ? 1 : -1;
          const openPrice = parseFloat(trade.open_price || 0);
          const quantity = parseFloat(trade.quantity || 0);
          const brokerage = parseFloat(trade.brokerage || 0);
          const priceDiff = (currentPrice - openPrice) * direction;
          const netPnL = priceDiff * quantity - brokerage;

          tradeUpdates.push({
            id: trade.id,
            currentPrice,
            profit: netPnL,
            userId: trade.accounts.user_id,
            accountId: trade.account_id,
            symbol: trade.symbol,
            tradeType: trade.trade_type,
            openPrice,
            quantity,
          });

          if (!accountPnL[trade.account_id]) {
            accountPnL[trade.account_id] = {
              userId: trade.accounts.user_id,
              balance: parseFloat(trade.accounts.balance || 0),
              margin: parseFloat(trade.accounts.margin || 0),
              totalPnL: 0,
              trades: [],
            };
          }
          accountPnL[trade.account_id].totalPnL += netPnL;
          // ✅ Track trades per account for stop-out ordering
          accountPnL[trade.account_id].trades.push({
            ...trade,
            _currentPrice: currentPrice,
            _netPnL: netPnL,
          });

          // ✅ SL / TP check — skip if already being closed
          if (this.closingTrades.has(trade.id)) continue;

          const sl = parseFloat(trade.stop_loss || 0);
          const tp = parseFloat(trade.take_profit || 0);

          if (sl > 0) {
            if (
              (trade.trade_type === 'buy' && currentPrice <= sl) ||
              (trade.trade_type === 'sell' && currentPrice >= sl)
            ) {
              slTpTriggers.push({ trade, reason: 'Stop Loss' });
              continue;
            }
          }
          if (tp > 0) {
            if (
              (trade.trade_type === 'buy' && currentPrice >= tp) ||
              (trade.trade_type === 'sell' && currentPrice <= tp)
            ) {
              slTpTriggers.push({ trade, reason: 'Take Profit' });
            }
          }
        }

        // 6. Emit P&L to users
        const byUser = {};
        for (const u of tradeUpdates) {
          if (!byUser[u.userId]) byUser[u.userId] = [];
          byUser[u.userId].push(u);
        }

        for (const [userId, trades] of Object.entries(byUser)) {
          this.io.to(`user:${userId}`).emit('trades:pnl:batch', {
            trades: trades.map((t) => ({
              tradeId: t.id,
              symbol: t.symbol,
              tradeType: t.tradeType,
              openPrice: t.openPrice,
              currentPrice: t.currentPrice,
              quantity: t.quantity,
              profit: t.profit,
              timestamp: Date.now(),
            })),
            timestamp: Date.now(),
          });

          for (const t of trades) {
            this.io.to(`user:${userId}`).emit('trade:pnl', {
              tradeId: t.id,
              symbol: t.symbol,
              currentPrice: t.currentPrice,
              profit: parseFloat(t.profit.toFixed(2)),
              timestamp: Date.now(),
            });
          }
        }

        // 7. Emit account updates
        for (const [accountId, d] of Object.entries(accountPnL)) {
          const equity = d.balance + d.totalPnL;
          const freeMargin = equity - d.margin;
          const marginLevel = d.margin > 0 ? (equity / d.margin) * 100 : 0;
          const payload = {
            accountId,
            balance: d.balance,
            equity,
            profit: d.totalPnL,
            freeMargin,
            margin: d.margin,
            marginLevel,
            timestamp: Date.now(),
          };
          this.io.to(`user:${d.userId}`).emit('account:update', payload);
          this.io.to(`account:${accountId}`).emit('account:update', payload);
        }

        // 8. DB writes every 10s
        this.pnlDbCounter++;
        if (this.pnlDbCounter % 5 === 0) {
          Promise.all(
            tradeUpdates.map((t) =>
              supabase
                .from('trades')
                .update({ current_price: t.currentPrice, profit: t.profit })
                .eq('id', t.id)
            )
          ).catch((e) => console.error('P&L trade DB err:', e.message));

          Promise.all(
            Object.entries(accountPnL).map(([id, d]) => {
              const eq = d.balance + d.totalPnL;
              return supabase
                .from('accounts')
                .update({ profit: d.totalPnL, equity: eq, free_margin: eq - d.margin })
                .eq('id', id);
            })
          ).catch((e) => console.error('P&L account DB err:', e.message));
        }

        // 9. Execute SL/TP closures
        for (const { trade, reason } of slTpTriggers) {
          // ✅ Guard: skip if already closing
          if (this.closingTrades.has(trade.id)) continue;
          this.closingTrades.add(trade.id);

          try {
            const result = await tradingService.closePosition(trade);
            if (result.success) {
              const uid = trade.accounts?.user_id || trade.user_id;
              console.log(`✅ ${reason} → trade #${trade.id} (${trade.symbol})`);
              this.io.to(`user:${uid}`).emit('trade:closed', {
                tradeId: trade.id,
                symbol: trade.symbol,
                reason,
                profit: result.trade?.profit,
                timestamp: Date.now(),
              });
            }
          } catch (e) {
            console.error(`SL/TP close err #${trade.id}:`, e.message);
          } finally {
            this.closingTrades.delete(trade.id);
          }
        }

        // 10. Check pending orders every 10s
        if (this.pnlDbCounter % 5 === 0) {
          tradingService.checkPendingOrders().catch(() => {});
        }

        // ═══════════════════════════════════════════════════════════
        // 11. ✅ STOP-OUT / MARGIN CALL CHECK (every 10s cycle)
        //
        // Formula: Margin Level (%) = (Equity / Used Margin) × 100
        //
        // If margin level < STOP_OUT_LEVEL (e.g. 10%):
        //   - liquidation_type === 'liquidate' → close most-losing position
        //   - liquidation_type === 'illiquidate' → do nothing (positions continue)
        // ═══════════════════════════════════════════════════════════
        if (this.pnlDbCounter % 5 === 0) {
          await this.checkStopOut(accountPnL);
        }
      } catch (err) {
        console.error('P&L loop error:', err.message);
      }
    }, 2000);

    console.log('💹 P&L loop started (2s emit, 10s DB write, stop-out check every 10s)');
  }

  // ═══════════════════════════════════════════════════════════
  //  STOP-OUT / MARGIN CALL LOGIC
  // ═══════════════════════════════════════════════════════════
  async checkStopOut(accountPnL) {
    try {
      // Collect unique user IDs that have open trades
      const userIds = [...new Set(Object.values(accountPnL).map((d) => d.userId))];
      if (userIds.length === 0) return;

      // Batch-fetch user liquidation settings
      const { data: usersData } = await supabase
        .from('users')
        .select('id, liquidation_type, login_id')
        .in('id', userIds);

      const userLiquidationMap = {};
      (usersData || []).forEach((u) => {
        userLiquidationMap[u.id] = {
          liquidationType: u.liquidation_type || 'liquidate',
          loginId: u.login_id || '—',
        };
      });

      for (const [accountId, d] of Object.entries(accountPnL)) {
        const equity = d.balance + d.totalPnL;
        const margin = d.margin;

        // No margin used — no stop-out possible
        if (margin <= 0) continue;

        const marginLevel = (equity / margin) * 100;

        // Only trigger if margin level is below stop-out level
        if (marginLevel >= STOP_OUT_LEVEL) continue;

        const userInfo = userLiquidationMap[d.userId];
        if (!userInfo) continue;

        // ✅ ILLIQUIDATE accounts: do NOT auto-close, just warn
        if (userInfo.liquidationType === 'illiquidate') {
          // Emit margin warning to user but don't close
          this.io.to(`user:${d.userId}`).emit('margin:warning', {
            accountId,
            marginLevel: parseFloat(marginLevel.toFixed(2)),
            equity: parseFloat(equity.toFixed(2)),
            margin: parseFloat(margin.toFixed(2)),
            message: `⚠️ Margin level at ${marginLevel.toFixed(1)}% — below ${STOP_OUT_LEVEL}% but account is illiquidate (no auto-close)`,
            timestamp: Date.now(),
          });
          console.log(
            `⚠️ [ILLIQUIDATE] ${userInfo.loginId} — Margin level ${marginLevel.toFixed(1)}% < ${STOP_OUT_LEVEL}% — NOT closing (illiquidate account)`
          );
          continue;
        }

        // ✅ LIQUIDATE accounts: auto-close the most losing position
        console.log(
          `🔴 [STOP-OUT] ${userInfo.loginId} — Margin level ${marginLevel.toFixed(1)}% < ${STOP_OUT_LEVEL}% — closing most losing position`
        );

        // Emit margin call warning to user
        this.io.to(`user:${d.userId}`).emit('margin:warning', {
          accountId,
          marginLevel: parseFloat(marginLevel.toFixed(2)),
          equity: parseFloat(equity.toFixed(2)),
          margin: parseFloat(margin.toFixed(2)),
          message: `🔴 STOP OUT: Margin level ${marginLevel.toFixed(1)}% — auto-closing most losing position`,
          timestamp: Date.now(),
        });

        // Find the most losing trade for this account
        const accountTrades = (d.trades || [])
          .filter((t) => !this.closingTrades.has(t.id))
          .sort((a, b) => a._netPnL - b._netPnL); // Most negative first

        if (accountTrades.length === 0) continue;

        const worstTrade = accountTrades[0];

        // Guard: don't double-close
        if (this.closingTrades.has(worstTrade.id)) continue;
        this.closingTrades.add(worstTrade.id);

        try {
          const result = await tradingService.closePosition(worstTrade);
          if (result.success) {
            console.log(
              `✅ STOP-OUT closed trade #${worstTrade.id} (${worstTrade.symbol}) for ${userInfo.loginId} — P&L: ${result.trade?.profit?.toFixed(2)}`
            );

            this.io.to(`user:${d.userId}`).emit('trade:closed', {
              tradeId: worstTrade.id,
              symbol: worstTrade.symbol,
              reason: `Stop Out (Margin Level ${marginLevel.toFixed(1)}%)`,
              profit: result.trade?.profit,
              timestamp: Date.now(),
            });

            // Also emit a notification-style event
            this.io.to(`user:${d.userId}`).emit('stopout:executed', {
              accountId,
              tradeId: worstTrade.id,
              symbol: worstTrade.symbol,
              marginLevel: parseFloat(marginLevel.toFixed(2)),
              profit: result.trade?.profit,
              message: `Stop-out executed: ${worstTrade.symbol} closed at margin level ${marginLevel.toFixed(1)}%`,
              timestamp: Date.now(),
            });
          } else {
            console.error(
              `❌ STOP-OUT failed for trade #${worstTrade.id}: ${result.message}`
            );
          }
        } catch (e) {
          console.error(`❌ STOP-OUT error for trade #${worstTrade.id}:`, e.message);
        } finally {
          this.closingTrades.delete(worstTrade.id);
        }
      }
    } catch (err) {
      console.error('Stop-out check error:', err.message);
    }
  }

  stop() {
    if (this.pnlUpdateInterval) clearInterval(this.pnlUpdateInterval);
    this.closingTrades.clear();
    console.log('WebSocket intervals stopped');
  }
}

module.exports = SocketHandler;