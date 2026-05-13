const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { initSocket } = require('./socket');
const { connectDB } = require('./config/database');
const { connectRedis } = require('./config/redis');
const logger = require('./utils/logger');

// ── Routes ────────────────────────────────────────────────────────────────
const authRoutes       = require('./routes/auth.routes');
const userRoutes       = require('./routes/user.routes');
const handymanRoutes   = require('./routes/handyman.routes');
const jobRoutes        = require('./routes/job.routes');
const negotiationRoutes= require('./routes/negotiation.routes');
const paymentRoutes    = require('./routes/payment.routes');
const ratingRoutes     = require('./routes/rating.routes');
const adminRoutes      = require('./routes/admin.routes');
const notificationRoutes = require('./routes/notification.routes');

const app    = express();
const server = http.createServer(app);

// ── Middleware ────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://app.handyconnect.ca', 'https://admin.handyconnect.ca']
    : '*',
  credentials: true
}));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Stripe webhook needs raw body — register BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});
app.use('/api/', limiter);

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/handymen',      handymanRoutes);
app.use('/api/jobs',          jobRoutes);
app.use('/api/negotiations',  negotiationRoutes);
app.use('/api/payments',      paymentRoutes);
app.use('/api/ratings',       ratingRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/notifications', notificationRoutes);

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  env: process.env.NODE_ENV,
  timestamp: new Date().toISOString()
}));

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.url}`);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Socket.io (real-time: chat, location, notifications) ─────────────────
initSocket(server);

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
async function start() {
  await connectDB();
  await connectRedis();
  server.listen(PORT, () => {
    logger.info(`HandyConnect API running on port ${PORT} [${process.env.NODE_ENV}]`);
  });
}

start().catch(err => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = { app, server };
