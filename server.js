require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================
const EBAY_SANDBOX = process.env.EBAY_SANDBOX === 'true';
const BASE_URL = EBAY_SANDBOX
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com';
const AUTH_URL = EBAY_SANDBOX
  ? 'https://auth.sandbox.ebay.com'
  : 'https://auth.ebay.com';

const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const RU_NAME = process.env.EBAY_RU_NAME;

// In-memory token store
let tokenStore = {
  accessToken: null,
  refreshToken: process.env.EBAY_REFRESH_TOKEN || null,
  expiresAt: null,
};

// ============================================================
// TOKEN MANAGEMENT
// ============================================================
async function getAccessToken() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    `${AUTH_URL}/oauth2/token`,
    qs.stringify({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return response.data.access_token;
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) {
    throw new Error('No refresh token available. Please authenticate via /auth/ebay');
  }
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    `${AUTH_URL}/oauth2/token`,
    qs.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenStore.refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  tokenStore.accessToken = response.data.access_token;
  tokenStore.expiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
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
app.get('/auth/ebay', (req, res) => {
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  ].join(' ');

  const authUrl = `${AUTH_URL}/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(RU_NAME)}&scope=${encodeURIComponent(scopes)}`;
  res.redirect(authUrl);
});

app.get('/auth/ebay/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'No authorization code received' });
  }

  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await axios.post(
      `${AUTH_URL}/oauth2/token`,
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: RU_NAME,
      }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    tokenStore.accessToken = response.data.access_token;
    tokenStore.refreshToken = response.data.refresh_token;
    tokenStore.expiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

    console.log('\n🔑 REFRESH TOKEN (save this to your Railway variables):');
    console.log('EBAY_REFRESH_TOKEN=' + tokenStore.refreshToken);
    console.log('\n');

    // Redirect to Hostinger frontend
    const frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:3000';
    res.redirect(frontendUrl + '?auth=success');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed', details: err.response?.data });
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!(tokenStore.accessToken && Date.now() < tokenStore.expiresAt),
    hasRefreshToken: !!tokenStore.refreshToken,
    expiresAt: tokenStore.expiresAt,
  });
});

// ============================================================
// API PROXY ROUTES
// ============================================================

// Get orders
app.get('/api/orders', async (req, res) => {
  try {
    const token = await getValidToken();
    const { limit = 50, offset = 0, filter } = req.query;

    let url = `${BASE_URL}/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}`;
    if (filter) url += `&filter=${filter}`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Orders error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Get financial transactions
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
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Get listings
app.get('/api/listings', async (req, res) => {
  try {
    const token = await getValidToken();
    const { limit = 50, offset = 0 } = req.query;

    const url = `${BASE_URL}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Listings error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Get traffic analytics
app.get('/api/analytics/traffic', async (req, res) => {
  try {
    const token = await getValidToken();
    const url = `${BASE_URL}/sell/analytics/v1/traffic_report?dimension=DAY&metric=CLICK_THROUGH_RATE&metric=LISTING_IMPRESSION_STORE&metric=LISTING_VIEWS_SOURCE_TYPE`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json(response.data);
  } catch (err) {
    console.error('Analytics error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Aggregate dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const token = await getValidToken();

    const [orders, transactions] = await Promise.all([
      axios.get(`${BASE_URL}/sell/fulfillment/v1/order?limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.data).catch(() => ({ orders: [], total: 0 })),
      axios.get(`${BASE_URL}/sell/finances/v1/transaction?limit=200&transactionType=SALE`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.data).catch(() => ({ transactions: [] })),
    ]);

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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sandbox: EBAY_SANDBOX, authenticated: !!tokenStore.accessToken });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 eBay Dashboard running on http://localhost:${PORT}`);
  console.log(`🔑 To connect eBay: visit http://localhost:${PORT}/auth/ebay`);
});
