/**
 * eBay Vintage Dashboard - Backend API Server
 * Handles OAuth token management & eBay API proxying
 * Backend: Railway.app  |  Frontend: Hostinger shared hosting
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();

// CORS — allows your Hostinger domain to call this Railway backend
// Set CORS_ORIGIN in Railway variables to your Hostinger domain, e.g. https://yourdomain.com
const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Railway health checks, curl, etc.)
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));

app.use(express.json());
// Serve static files only if running locally (Railway won't use this)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CONFIG — Replace with your eBay Developer credentials
// ============================================================
const EBAY_CONFIG = {
  clientId:     process.env.EBAY_CLIENT_ID     || 'YOUR_CLIENT_ID',
  clientSecret: process.env.EBAY_CLIENT_SECRET || 'YOUR_CLIENT_SECRET',
  ruName:       process.env.EBAY_RU_NAME       || 'YOUR_RU_NAME',
  // Set to false when ready for production
  sandbox: process.env.EBAY_SANDBOX === 'true' || false,
};

const BASE_URL = EBAY_CONFIG.sandbox
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com';

const AUTH_URL = EBAY_CONFIG.sandbox
  ? 'https://auth.sandbox.ebay.com'
  : 'https://auth.ebay.com';

// In-memory token store (use Redis/DB in production)
let tokenStore = {
  accessToken: null,
  refreshToken: process.env.EBAY_REFRESH_TOKEN || null,
  expiresAt: null,
};

// ============================================================
// OAUTH HELPERS
// ============================================================
function getBase64Credentials() {
  return Buffer.from(`${EBAY_CONFIG.clientId}:${EBAY_CONFIG.clientSecret}`).toString('base64');
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) {
    throw new Error('No refresh token available. Complete OAuth flow first.');
  }

  const response = await axios.post(
    `${BASE_URL}/identity/v1/oauth2/token`,
    `grant_type=refresh_token&refresh_token=${tokenStore.refreshToken}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${getBase64Credentials()}`,
      },
    }
  );

  tokenStore.accessToken = response.data.access_token;
  tokenStore.expiresAt = Date.now() + (response.data.expires_in * 1000) - 60000;
  console.log('✅ Access token refreshed');
  return tokenStore.accessToken;
}

async function getValidToken() {
  if (!tokenStore.accessToken || Date.now() >= tokenStore.expiresAt) {
    return await refreshAccessToken();
  }
  return tokenStore.accessToken;
}

// ============================================================
// OAUTH ROUTES
// ============================================================

// Step 1: Redirect user to eBay login
app.get('/auth/ebay', (req, res) => {
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.account',
  ].join(' ');

  const authUrl = `${AUTH_URL}/oauth2/authorize?client_id=${EBAY_CONFIG.clientId}&redirect_uri=${encodeURIComponent(EBAY_CONFIG.ruName)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  res.redirect(authUrl);
});

// Step 2: eBay redirects here with auth code
app.get('/auth/ebay/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No authorization code received' });

  try {
    const response = await axios.post(
      `${BASE_URL}/identity/v1/oauth2/token`,
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(EBAY_CONFIG.ruName)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${getBase64Credentials()}`,
        },
      }
    );

    tokenStore.accessToken = response.data.access_token;
    tokenStore.refreshToken = response.data.refresh_token;
    tokenStore.expiresAt = Date.now() + (response.data.expires_in * 1000) - 60000;

    // Redirect back to your Hostinger frontend after auth
    const frontendUrl = process.env.FRONTEND_URL || 'https://your-hostinger-domain.com';
    console.log('🎉 OAuth complete! Refresh token:', tokenStore.refreshToken);
    console.log('👉 Add EBAY_REFRESH_TOKEN=' + tokenStore.refreshToken + ' to your Railway variables');

    res.redirect(`${frontendUrl}/?auth=success`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).json({ error: 'OAuth failed', details: err.response?.data });
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    connected: !!tokenStore.accessToken && Date.now() < (tokenStore.expiresAt || 0),
    hasRefreshToken: !!tokenStore.refreshToken,
    expiresAt: tokenStore.expiresAt,
  });
});

// ============================================================
// eBay API ROUTES
// ============================================================

// Get seller transactions / orders
app.get('/api/orders', async (req, res) => {
  try {
    const token = await getValidToken();
    const { limit = 50, offset = 0, filter } = req.query;

    let url = `${BASE_URL}/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}&orderingContext=BUYER_CHECKOUT`;
    if (filter) url += `&filter=${filter}`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Orders error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// Get financial transactions (payouts, sales)
app.get('/api/finances', async (req, res) => {
  try {
    const token = await getValidToken();
    const { limit = 100, offset = 0, transactionType = 'SALE' } = req.query;

    const url = `${BASE_URL}/sell/finances/v1/transaction?limit=${limit}&offset=${offset}&transactionType=${transactionType}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Finances error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// Get active listings
app.get('/api/listings', async (req, res) => {
  try {
    const token = await getValidToken();
    const { limit = 100, offset = 0 } = req.query;

    const url = `${BASE_URL}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Listings error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// Get seller analytics / traffic
app.get('/api/analytics/traffic', async (req, res) => {
  try {
    const token = await getValidToken();
    const { dimensionKey = 'LISTING', metricKey = 'CLICK_THROUGH_RATE,IMPRESSION_COUNT,LISTING_IMPRESSION_SEARCH_RESULTS_PAGE', dateRange } = req.query;

    const url = `${BASE_URL}/sell/analytics/v1/traffic_report?dimension=${dimensionKey}&metric=${metricKey}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Analytics error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// Aggregate dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const token = await getValidToken();

    // Fetch last 30 days of transactions
    const financeUrl = `${BASE_URL}/sell/finances/v1/transaction?limit=200&transactionType=SALE`;
    const ordersUrl = `${BASE_URL}/sell/fulfillment/v1/order?limit=50`;

    const [finRes, ordRes] = await Promise.allSettled([
      axios.get(financeUrl, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(ordersUrl, { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    const transactions = finRes.status === 'fulfilled' ? finRes.value.data : { transactions: [] };
    const orders = ordRes.status === 'fulfilled' ? ordRes.value.data : { orders: [] };

    // Compute aggregate stats
    const txList = transactions.transactions || [];
    const totalRevenue = txList.reduce((sum, t) => sum + parseFloat(t.amount?.value || 0), 0);
    const fees = txList.reduce((sum, t) => sum + parseFloat(t.totalFeeAmount?.value || 0), 0);
    const netProfit = totalRevenue - fees;

    res.json({
      totalRevenue: totalRevenue.toFixed(2),
      totalFees: fees.toFixed(2),
      netProfit: netProfit.toFixed(2),
      totalOrders: orders.total || 0,
      recentTransactions: txList.slice(0, 10),
      recentOrders: (orders.orders || []).slice(0, 10),
    });
  } catch (err) {
    console.error('Stats error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HEALTH CHECK — Railway uses this to confirm app is running
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
app.get('/', (req, res) => res.json({ status: 'DEFJAMSLAM eBay Dashboard API running ✅' }));

// ============================================================
// START SERVER — must bind to 0.0.0.0 for Railway
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 eBay Dashboard API running on port ${PORT}`);
  console.log(`🔑 To connect eBay: visit /auth/ebay`);
  console.log(`🌍 CORS allowed origins: ${process.env.CORS_ORIGIN || '*'}`);
});
