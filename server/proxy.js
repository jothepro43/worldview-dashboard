/* ========================================
   WorldView - CORS Proxy Server
   Node.js Express server for API proxying
   ======================================== */

const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// FIX 1: OpenSky OAuth2 Token Manager
// Single shared instance — docs explicitly warn
// against instantiating per-call.
// Token endpoint: OpenID Connect client_credentials
// Token lifetime: 30 min (1800s), refresh 30s before
// =============================================

class OpenSkyTokenManager {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = 0; // epoch ms
        this.refreshPromise = null;
        this.TOKEN_REFRESH_MARGIN = 30; // seconds before expiry to refresh
        this.TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
    }

    /**
     * Returns a valid Bearer token, refreshing if needed.
     * Returns null if credentials are not configured.
     */
    async getToken() {
        const clientId = process.env.OPENSKY_CLIENT_ID || '';
        const clientSecret = process.env.OPENSKY_CLIENT_SECRET || '';

        if (!clientId || clientId.startsWith('YOUR_') || !clientSecret || clientSecret.startsWith('YOUR_')) {
            return null; // No credentials — anonymous mode
        }

        const now = Date.now();
        // If token is still valid (with margin), return it
        if (this.accessToken && now < this.tokenExpiry - (this.TOKEN_REFRESH_MARGIN * 1000)) {
            return this.accessToken;
        }

        // Prevent multiple concurrent refreshes
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = this._fetchToken(clientId, clientSecret);
        try {
            const token = await this.refreshPromise;
            return token;
        } finally {
            this.refreshPromise = null;
        }
    }

    async _fetchToken(clientId, clientSecret) {
        try {
            console.log('[TokenManager] Requesting new OAuth2 token...');
            const params = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret
            });

            const response = await fetch(this.TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
                timeout: 10000
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error(`[TokenManager] Token request failed: ${response.status} — ${errText}`);
                this.accessToken = null;
                this.tokenExpiry = 0;
                return null;
            }

            const data = await response.json();
            this.accessToken = data.access_token;
            // expires_in is in seconds — typically 1800 (30 min)
            const expiresIn = data.expires_in || 1800;
            this.tokenExpiry = Date.now() + (expiresIn * 1000);
            console.log(`[TokenManager] Token acquired, expires in ${expiresIn}s`);
            return this.accessToken;
        } catch (err) {
            console.error('[TokenManager] Token fetch error:', err.message);
            this.accessToken = null;
            this.tokenExpiry = 0;
            return null;
        }
    }

    /**
     * Force invalidate the current token (e.g. on 401 response).
     */
    invalidate() {
        console.log('[TokenManager] Token invalidated');
        this.accessToken = null;
        this.tokenExpiry = 0;
    }
}

// Single shared instance
const openSkyTokenManager = new OpenSkyTokenManager();

// --- Static files ---
app.use(express.static(path.join(__dirname, '..')));

// --- CORS headers ---
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- Proxy helper ---
async function proxyRequest(targetUrl, req, res, options = {}) {
    try {
        const headers = { ...options.headers };

        const fetchOptions = {
            method: req.method || 'GET',
            headers: headers,
            timeout: 30000
        };

        // Forward body for POST requests
        if (req.method === 'POST' && req.body) {
            if (typeof req.body === 'string') {
                fetchOptions.body = req.body;
            } else {
                const params = new URLSearchParams(req.body);
                fetchOptions.body = params.toString();
                fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }
        }

        console.log(`[Proxy] ${req.method} ${targetUrl}`);
        const response = await fetch(targetUrl, fetchOptions);

        if (!response.ok) {
            console.warn(`[Proxy] Upstream returned ${response.status} for ${targetUrl}`);
            return res.status(response.status).json({ error: `Upstream returned ${response.status}` });
        }

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('json') || contentType.includes('geojson')) {
            const data = await response.json();
            res.json(data);
        } else {
            const text = await response.text();
            res.set('Content-Type', contentType || 'text/plain');
            res.send(text);
        }
    } catch (err) {
        console.error(`[Proxy] Error for ${targetUrl}:`, err.message);
        res.status(502).json({ error: 'Proxy error', message: err.message });
    }
}

// --- Body parser for POST requests ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- API Routes ---

// ── OpenSky Network (OAuth2 Bearer Token + rate-limit header forwarding) ──
// FIX 1: Uses OAuth2 client_credentials flow instead of Basic Auth.
//         On 401, invalidates token and retries once.
//         Forwards X-Rate-Limit-* headers to the client for credit tracking.
app.get('/api/opensky', async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    // FIX 1: Append &extended=1 to get category field (index 17)
    const extendedParam = qs ? `${qs}&extended=1` : 'extended=1';
    const url = `https://opensky-network.org/api/states/all?${extendedParam}`;

    async function makeRequest(isRetry) {
        const headers = {};
        const token = await openSkyTokenManager.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(url, { headers, timeout: 15000 });

            // Forward rate-limit headers to client for credit tracking (FIX 2)
            const rateLimitRemaining = response.headers.get('x-rate-limit-remaining');
            const rateLimitRetryAfter = response.headers.get('x-rate-limit-retry-after-seconds');
            if (rateLimitRemaining != null) {
                res.set('X-Rate-Limit-Remaining', rateLimitRemaining);
            }
            if (rateLimitRetryAfter != null) {
                res.set('X-Rate-Limit-Retry-After-Seconds', rateLimitRetryAfter);
            }

            // 401 — token expired or invalid: invalidate and retry once
            if (response.status === 401 && !isRetry) {
                console.warn('[Proxy] OpenSky 401 — invalidating token and retrying...');
                openSkyTokenManager.invalidate();
                return makeRequest(true);
            }

            // 429 — rate limited: forward the retry-after info
            if (response.status === 429) {
                console.warn('[Proxy] OpenSky 429 — rate limited');
                const retryBody = { error: 'Rate limited', status: 429 };
                if (rateLimitRetryAfter) retryBody.retryAfterSeconds = parseInt(rateLimitRetryAfter, 10);
                return res.status(429).json(retryBody);
            }

            if (!response.ok) {
                console.warn(`[Proxy] OpenSky returned ${response.status}`);
                return res.status(response.status).json({ error: `OpenSky returned ${response.status}` });
            }

            const data = await response.json();
            // Include auth mode info for client-side source display
            data._authMode = token ? 'OAuth2' : 'Anonymous';
            res.json(data);
        } catch (err) {
            console.error('[Proxy] OpenSky fetch error:', err.message);
            res.status(502).json({ error: 'OpenSky proxy error', message: err.message });
        }
    }

    await makeRequest(false);
});

// ── FIX 3: ADSB.fi CORS Proxy ──────────────────────────────────────────────
// ADSB.fi is free and requires no auth, but browser direct calls fail due to
// CORS. This route proxies requests to avoid that.
app.get('/api/adsbfi', (req, res) => {
    const lat = parseFloat(req.query.lat) || 0;
    const lon = parseFloat(req.query.lon) || 0;
    const radius = parseInt(req.query.radius, 10) || 250;
    const bounds = req.query.bounds || '';

    let url;
    if (bounds) {
        // bounds format: south,north,west,east
        url = `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`;
        // ADSB.fi v2 uses lat/lon/dist format
    }
    // Default: lat/lon/dist based query
    url = `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`;

    proxyRequest(url, req, res, {
        headers: {
            'Accept': 'application/json'
        }
    });
});

// ADS-B Exchange (adsb.lol) – free community fallback
app.get('/api/adsb', (req, res) => {
    const lat  = parseFloat(req.query.lat)  || 0;
    const lon  = parseFloat(req.query.lon)  || 0;
    const dist = parseInt(req.query.dist, 10) || 250;
    const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
    proxyRequest(url, req, res);
});

// ADS-B Exchange (RapidAPI) – uses API key from CONFIG
app.get('/api/adsbx', (req, res) => {
    const lat  = parseFloat(req.query.lat)  || 0;
    const lon  = parseFloat(req.query.lon)  || 0;
    const dist = parseInt(req.query.dist, 10) || 250;

    // Read API key from environment or fall back to a placeholder
    const apiKey = process.env.ADSBX_API_KEY || '';

    if (!apiKey || apiKey.startsWith('YOUR_')) {
        return res.status(503).json({ error: 'ADS-B Exchange API key not configured on server' });
    }

    const url = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${lat}/lon/${lon}/dist/${dist}/`;
    proxyRequest(url, req, res, {
        headers: {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'adsbexchange-com1.p.rapidapi.com'
        }
    });
});

// CelesTrak TLE data
app.get('/api/tle/:group', (req, res) => {
    const group = req.params.group;
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
    proxyRequest(url, req, res);
});

// USGS Earthquakes
app.get('/api/earthquakes', (req, res) => {
    proxyRequest('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', req, res);
});

// NASA EONET
app.get('/api/eonet', (req, res) => {
    proxyRequest('https://eonet.gsfc.nasa.gov/api/v3/events?status=open', req, res);
});

// NWS Alerts
app.get('/api/nws', (req, res) => {
    proxyRequest('https://api.weather.gov/alerts/active', req, res, {
        headers: {
            'User-Agent': 'WorldView-Dashboard/1.0 (contact@worldview.dev)',
            'Accept': 'application/geo+json'
        }
    });
});

// Overpass API (POST)
app.post('/api/overpass', (req, res) => {
    const fetchOverpass = async () => {
        try {
            const params = new URLSearchParams(req.body);
            console.log('[Proxy] POST /api/overpass');

            const response = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
                timeout: 60000
            });

            if (!response.ok) {
                return res.status(response.status).json({ error: `Overpass returned ${response.status}` });
            }

            const data = await response.json();
            res.json(data);
        } catch (err) {
            console.error('[Proxy] Overpass error:', err.message);
            res.status(502).json({ error: 'Overpass proxy error', message: err.message });
        }
    };
    fetchOverpass();
});

// ── Windy Webcams API (proxied — attaches API key) ────────────────────────

app.get('/api/windy-webcams', (req, res) => {
    const apiKey = process.env.WINDY_WEBCAM_API_KEY || '';

    if (!apiKey || apiKey.startsWith('YOUR_')) {
        return res.status(503).json({ error: 'Windy Webcam API key not configured on server' });
    }

    // Forward all query params to Windy API v3
    const qs = new URLSearchParams(req.query).toString();
    const url = `https://api.windy.com/webcams/api/v3/webcams?${qs}`;

    proxyRequest(url, req, res, {
        headers: {
            'x-windy-api-key': apiKey
        }
    });
});

// ── MJPEG / HLS Stream Proxy ────────────────────────────────────────────────
//
// Proxies a remote MJPEG or HLS stream through the server to avoid
// CORS issues in the browser. The client passes ?url=<encoded-stream-url>.

app.get('/api/proxy-stream', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Validate URL — only allow http/https
    let parsed;
    try {
        parsed = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: 'Only http/https URLs are allowed' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    console.log(`[Proxy] Stream proxy: ${targetUrl}`);

    try {
        const response = await fetch(targetUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'WorldView-Dashboard/1.0'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `Upstream returned ${response.status}` });
        }

        // Forward content-type and pipe the stream
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'no-cache');
        res.set('Connection', 'keep-alive');

        // For MJPEG streams (multipart/x-mixed-replace), we need to pipe the body
        // For HLS (.m3u8), we can just forward the text response
        if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
            const text = await response.text();
            res.send(text);
        } else {
            // Pipe binary stream data (MJPEG, etc.)
            const { Readable } = require('stream');
            const nodeStream = Readable.fromWeb(response.body);
            nodeStream.pipe(res);

            // Clean up on client disconnect
            req.on('close', () => {
                nodeStream.destroy();
            });
        }
    } catch (err) {
        console.error(`[Proxy] Stream proxy error for ${targetUrl}:`, err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Stream proxy error', message: err.message });
        }
    }
});

// --- Health check ---
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('  WorldView Proxy Server');
    console.log(`  Running on http://localhost:${PORT}`);
    console.log('========================================\n');
    console.log('API Endpoints:');
    console.log(`  GET  /api/opensky         -> OpenSky Network (OAuth2 Bearer + extended=1)`);
    console.log(`  GET  /api/adsbfi          -> ADSB.fi (CORS proxy, no auth)`);
    console.log(`  GET  /api/adsb            -> ADS-B (adsb.lol fallback)`);
    console.log(`  GET  /api/adsbx           -> ADS-B Exchange (RapidAPI, key required)`);
    console.log(`  GET  /api/tle/:group      -> CelesTrak TLE`);
    console.log(`  GET  /api/earthquakes     -> USGS Earthquakes`);
    console.log(`  GET  /api/eonet           -> NASA EONET`);
    console.log(`  GET  /api/nws             -> NWS Alerts`);
    console.log(`  POST /api/overpass        -> Overpass API`);
    console.log(`  GET  /api/windy-webcams   -> Windy Webcams (key required)`);
    console.log(`  GET  /api/proxy-stream    -> MJPEG/HLS stream proxy`);
    console.log(`  GET  /api/health          -> Health Check`);
    console.log('');
});

module.exports = app;
