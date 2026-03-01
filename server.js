/**
 * eBay Vintage Dashboard - Backend API Server
 * Backend: Railway.app  |  Frontend: Hostinger shared hosting
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app = express();

// ─── STARTUP DIAGNOSTICS ────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 DEFJAMSLAM eBay Dashboard starting...');
console.log('Node version :', process.version);
console.log('PORT         :', process.env.PORT || '3000 (default)');
console.log('CORS_ORIGIN  :', process.env.CORS_ORIGIN || '* (open)');
console.log('FRONTEND_URL :', process.env.FRONTEND_URL || '(not set)');
console.log('CLIENT_ID set:', !!process.env.EBAY_CLIENT_ID);
console.log('SECRET set   :', !!process.env.EBAY_CLIENT_SECRET);
console.log('RU_NAME set  :', !!process.env.EBAY_RU_NAME);
console.log('SANDBOX      :', process.env.EBAY_SANDBOX);
console.log('REFRESH set  :', !!process.env.EBAY_REFRESH_TOKEN);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ─── CORS ────────────────────────────────────────────────────
const rawOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim().replace(/\/$/, ''));
const openCors   = rawOrigins.includes('*');

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || openCors || rawOrigins.includes(origin)) return cb(null, true);
    console.warn('CORS blocked:', origin);
    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
}));

app.use(express.json());

// ─── eBay CONFIG ─────────────────────────────────────────────
const EBAY = {
  clientId    : process.env.EBAY_CLIENT_ID     || '',
  clientSecret: process.env.EBAY_CLIENT_SECRET || '',
  ruName      : process.env.EBAY_RU_NAME       || '',
  sandbox     : process.env.EBAY_SANDBOX === 'true',
};

const API  = EBAY.sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const AUTH = EBAY.sandbox ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';

// ─── TOKEN STORE ─────────────────────────────────────────────
const tokens = {
  access   : null,
  refresh  : process.env.EBAY_REFRESH_TOKEN || null,
  expiresAt: 0,
};

function b64creds() {
  return Buffer.from(EBAY.clientId + ':' + EBAY.clientSecret).toString('base64');
}

async function refreshAccess() {
  if (!tokens.refresh) throw new Error('No refresh token — visit /auth/ebay first');
  const { data } = await axios.post(
    API + '/identity/v1/oauth2/token',
    'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokens.refresh),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + b64creds() } }
  );
  tokens.access    = data.access_token;
  tokens.expiresAt = Date.now() + data.expires_in * 1000 - 60000;
  console.log('✅ Token refreshed, expires in', data.expires_in, 's');
  return tokens.access;
}

async function validToken() {
  if (!tokens.access || Date.now() >= tokens.expiresAt) return refreshAccess();
  return tokens.access;
}

// ─── HEALTH & ROOT ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('/', (_req, res) => res.json({
  app      : 'DEFJAMSLAM eBay Dashboard API',
  status   : 'running ✅',
  ebayReady: !!(EBAY.clientId && EBAY.clientSecret && EBAY.ruName),
  hasToken : !!tokens.refresh,
  authUrl  : '/auth/ebay',
}));

// ─── OAUTH ───────────────────────────────────────────────────
app.get('/auth/ebay', (_req, res) => {
  if (!EBAY.clientId || !EBAY.ruName) {
    return res.status(500).json({ error: 'EBAY_CLIENT_ID or EBAY_RU_NAME not set in Railway variables' });
  }
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.account',
  ].join(' ');
  const url = AUTH + '/oauth2/authorize?client_id=' + EBAY.clientId +
    '&redirect_uri=' + encodeURIComponent(EBAY.ruName) +
    '&response_type=code&scope=' + encodeURIComponent(scopes);
  res.redirect(url);
});

app.get('/auth/ebay/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error, description: req.query.error_description });
  if (!code)  return res.status(400).json({ error: 'No code from eBay' });
  try {
    const { data } = await axios.post(
      API + '/identity/v1/oauth2/token',
      'grant_type=authorization_code&code=' + encodeURIComponent(code) + '&redirect_uri=' + encodeURIComponent(EBAY.ruName),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + b64creds() } }
    );
    tokens.access    = data.access_token;
    tokens.refresh   = data.refresh_token;
    tokens.expiresAt = Date.now() + data.expires_in * 1000 - 60000;
    console.log('🎉 OAuth success!');
    console.log('👉 Add to Railway variables: EBAY_REFRESH_TOKEN=' + tokens.refresh);
    const front = (process.env.FRONTEND_URL || 'https://ebay.noahsdatahub.com').replace(/\/$/, '');
    res.redirect(front + '/?auth=success');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).json({ error: 'OAuth failed', detail: err.response?.data || err.message });
  }
});

app.get('/auth/status', (_req, res) => res.json({
  connected      : !!tokens.access && Date.now() < tokens.expiresAt,
  hasRefreshToken: !!tokens.refresh,
  expiresAt      : tokens.expiresAt || null,
}));

// ─── API ROUTES ───────────────────────────────────────────────
function apiErr(res, err) {
  console.error('API error:', err.response?.data || err.message);
  res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
}

app.get('/api/dashboard/stats', async (_req, res) => {
  try {
    const h = { Authorization: 'Bearer ' + await validToken() };
    const [finRes, ordRes] = await Promise.allSettled([
      axios.get(API + '/sell/finances/v1/transaction?limit=200&transactionType=SALE', { headers: h }),
      axios.get(API + '/sell/fulfillment/v1/order?limit=50', { headers: h }),
    ]);
    const txList = finRes.status === 'fulfilled' ? (finRes.value.data.transactions || []) : [];
    const orders = ordRes.status === 'fulfilled' ? ordRes.value.data : { orders: [], total: 0 };
    const rev  = txList.reduce((s, t) => s + parseFloat(t.amount?.value || 0), 0);
    const fees = txList.reduce((s, t) => s + parseFloat(t.totalFeeAmount?.value || 0), 0);
    res.json({
      totalRevenue: rev.toFixed(2), totalFees: fees.toFixed(2),
      netProfit: (rev - fees).toFixed(2), totalOrders: orders.total || 0,
      recentTransactions: txList.slice(0, 10),
      recentOrders: (orders.orders || []).slice(0, 10),
    });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/orders', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const { data } = await axios.get(API + '/sell/fulfillment/v1/order?limit=' + limit + '&offset=' + offset,
      { headers: { Authorization: 'Bearer ' + await validToken() } });
    res.json(data);
  } catch (err) { apiErr(res, err); }
});

app.get('/api/finances', async (req, res) => {
  try {
    const { limit = 100, offset = 0, transactionType = 'SALE' } = req.query;
    const { data } = await axios.get(API + '/sell/finances/v1/transaction?limit=' + limit + '&offset=' + offset + '&transactionType=' + transactionType,
      { headers: { Authorization: 'Bearer ' + await validToken() } });
    res.json(data);
  } catch (err) { apiErr(res, err); }
});

app.get('/api/listings', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const { data } = await axios.get(API + '/sell/inventory/v1/inventory_item?limit=' + limit + '&offset=' + offset,
      { headers: { Authorization: 'Bearer ' + await validToken() } });
    res.json(data);
  } catch (err) { apiErr(res, err); }
});

// ─── CATCH-ALL ────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

// ─── START ────────────────────────────────────────────────────
// IMPORTANT: Do NOT add PORT as a Railway variable — Railway injects it automatically
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Server listening on 0.0.0.0:' + PORT);
  if (!EBAY.clientId)     console.warn('⚠️  EBAY_CLIENT_ID not set');
  if (!EBAY.clientSecret) console.warn('⚠️  EBAY_CLIENT_SECRET not set');
  if (!EBAY.ruName)       console.warn('⚠️  EBAY_RU_NAME not set');
  if (!tokens.refresh)    console.warn('⚠️  No refresh token — visit /auth/ebay to connect');
});
