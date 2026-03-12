// Handle uncaught errors — prevent server crash
process.on('uncaughtException', (err) => {
  console.error('🚨 UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 UNHANDLED REJECTION:', reason);
});

// backend/src/server.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cron = require('node-cron');

const { testConnection } = require('./config/supabase');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const marketRoutes = require('./routes/market');
const tradingRoutes = require('./routes/trading');
const watchlistRoutes = require('./routes/watchlists');

const SocketHandler = require('./websocket/socketHandler');

const kiteService = require('./services/kiteService');
const kiteStreamService = require('./services/kiteStreamService');
const weeklySettlementService = require('./services/weeklySettlementService');

const app = express();
const server = http.createServer(app);

const isDev = process.env.NODE_ENV === 'development';

/* =========================================================
   CORS CONFIG
   ========================================================= */

// FRONTEND_URL can be comma-separated in Railway:
// FRONTEND_URL=http://localhost:5173,http://localhost,capacitor://localhost
const envOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
  'https://tradeaxis-cf3.pages.dev',
];

const ALLOWED_ORIGINS = Array.from(new Set([...defaultOrigins, ...envOrigins]));

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // mobile apps, curl, postman
  return ALLOWED_ORIGINS.includes(origin);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    console.log('❌ Blocked by CORS:', origin);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

/* =========================================================
   SOCKET.IO
   ========================================================= */

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      console.log('❌ Socket blocked by CORS:', origin);
      return callback(new Error(`Socket not allowed by CORS: ${origin}`));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const socketHandler = new SocketHandler(io);

app.set('io', io);
app.set('socketHandler', socketHandler);

/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(compression());

if (isDev) {
  app.use(morgan('dev'));
}

/* =========================================================
   ROUTES
   ========================================================= */

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/watchlists', watchlistRoutes);

// Health check
app.get('/health', async (req, res) => {
  const dbConnected = await testConnection();

  res.json({
    success: true,
    message: 'Trade Axis API',
    database: dbConnected ? 'connected' : 'disconnected',
    websocket: 'active',
    connectedClients: io.engine.clientsCount,
    kite: kiteStreamService.status(),
    timestamp: new Date().toISOString(),
  });
});

// Version check
app.get('/api/version', (req, res) => {
  res.json({
    version: '1.0.0',
    minVersion: '1.0.0',
  });
});

app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'Trade Axis API v1.0',
    endpoints: {
      auth: '/api/auth',
      admin: '/api/admin',
      accounts: '/api/accounts',
      transactions: '/api/transactions',
      market: '/api/market',
      trading: '/api/trading',
      watchlists: '/api/watchlists',
    },
    allowedOrigins: ALLOWED_ORIGINS,
  });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('🔥 Express error:', err.message);
  if (isDev && err.stack) {
    console.error(err.stack);
  }

  res.status(500).json({
    success: false,
    message: err.message || 'Server error',
  });
});

/* =========================================================
   SERVER START
   ========================================================= */

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  const dbConnected = await testConnection();

  if (!dbConnected) {
    console.error('❌ Database connection failed');
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', async () => {
    console.log('');
    console.log('🚀 ══════════════════════════════════════════════════════════');
    console.log('   TRADE AXIS SERVER (HTTP + WebSocket)');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`   📍 HTTP: http://0.0.0.0:${PORT}`);
    console.log(`   ⚡ WS : ws://0.0.0.0:${PORT}`);
    console.log(`   🌍 ENV: ${process.env.NODE_ENV}`);
    console.log(`   ✅ Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');

    // Weekly settlement cron (Saturday 01:00 IST)
    const cronExpr = process.env.SETTLEMENT_CRON || '0 1 * * 6';
    const tz = process.env.SETTLEMENT_TIMEZONE || 'Asia/Kolkata';

    cron.schedule(
      cronExpr,
      async () => {
        console.log('⏰ Running scheduled weekly settlement...');
        await weeklySettlementService.runSettlement();
      },
      { timezone: tz }
    );

    console.log(`⏰ Weekly settlement scheduled: "${cronExpr}" (${tz})`);

    // Self-ping for platforms that sleep
    const selfUrl =
      process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.RENDER_EXTERNAL_URL || '';

    if (selfUrl) {
      setInterval(() => {
        fetch(`${selfUrl}/health`)
          .then(() => console.log('🏓 Self-ping OK'))
          .catch(() => {});
      }, 14 * 60 * 1000);

      console.log(`🏓 Self-ping enabled: ${selfUrl}/health`);
    }

    // Kite auto-start
    if (String(process.env.KITE_AUTO_START || 'true') === 'true') {
      try {
        await kiteService.init();

        if (kiteService.isSessionReady()) {
          const result = await kiteStreamService.start(io);
          console.log('✅ Kite stream auto-start result:', result);
        } else {
          console.log('ℹ️ Kite session not ready. Admin must create session daily.');
        }
      } catch (e) {
        console.log('ℹ️ Kite stream not started:', e.message);
      }
    }
  });
};

/* =========================================================
   SHUTDOWN
   ========================================================= */

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  socketHandler.stop?.();
  try {
    await kiteStreamService.stop();
  } catch {}
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  socketHandler.stop?.();
  try {
    await kiteStreamService.stop();
  } catch {}
  server.close(() => process.exit(0));
});

startServer();