/* ========================================
   WorldView - CORS Proxy Server
   Node.js Express server for API proxying
   ======================================== */

const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Load environment variables from .env file
require('dotenv').config();

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
     * Returns a valid Auth header value (or null for anonymous).
     * Prefers OAuth2 (Bearer) if configured, falls back to Basic Auth.
     */
    async getAuthHeader() {
        const clientId = process.env.OPENSKY_CLIENT_ID;
        const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
        const username = process.env.OPENSKY_USERNAME;
        const password = process.env.OPENSKY_PASSWORD;

        // 1. Try OAuth2
        if (clientId && !clientId.startsWith('YOUR_') && clientSecret && !clientSecret.startsWith('YOUR_')) {
            try {
                const token = await this.getToken(); 
                if (token) return `Bearer ${token}`;
                console.warn('[TokenManager] OAuth2 token fetch failed, falling back to Basic Auth if available.');
            } catch (err) {
                console.warn('[TokenManager] OAuth2 error:', err.message);
            }
        }

        // 2. Try Basic Auth
        if (username && !username.startsWith('YOUR_') && password && !password.startsWith('YOUR_')) {
            const base64 = Buffer.from(`${username}:${password}`).toString('base64');
            console.log('[TokenManager] Using Basic Auth for OpenSky');
            return `Basic ${base64}`;
        }

        console.log('[TokenManager] No valid credentials found, using Anonymous access');
        return null; // Anonymous
    }

    /**
     * Returns a valid Bearer token, refreshing if needed.
     * Returns null if credentials are not configured or fetch fails.
     */
    async getToken() {
        const clientId = process.env.OPENSKY_CLIENT_ID || '';
        const clientSecret = process.env.OPENSKY_CLIENT_SECRET || '';

        if (!clientId || clientId.startsWith('YOUR_') || !clientSecret || clientSecret.startsWith('YOUR_')) {
            return null;
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

// =============================================
// FIX 4: Request Throttling & Caching Manager
// Prevents 429 rate limit errors by:
// 1. Throttling requests to respect API limits
// 2. Caching responses to avoid redundant calls
// 3. Queuing requests during rate limit windows
// =============================================

class RateLimitManager {
    constructor() {
        this.requestQueues = {};      // Per-endpoint request queues
        this.lastRequestTime = {};    // Track last request time per endpoint
        this.responseCache = {};      // Cache responses with TTL
        this.rateLimitState = {};     // Track rate limit state
    }

    /**
     * Get cache key from request parameters
     */
    getCacheKey(endpoint, params) {
        const sortedParams = Object.keys(params)
            .sort()
            .map(k => `${k}=${params[k]}`)
            .join('&');
        return `${endpoint}:${sortedParams}`;
    }

    /**
     * Check if cached response is still valid
     */
    getFromCache(endpoint, params, maxAgeSecs = 60) {
        const key = this.getCacheKey(endpoint, params);
        const cached = this.responseCache[key];
        if (!cached) return null;

        const ageMs = Date.now() - cached.timestamp;
        if (ageMs > maxAgeSecs * 1000) {
            delete this.responseCache[key];
            return null;
        }
        return cached.data;
    }

    /**
     * Store response in cache
     */
    setCache(endpoint, params, data, ttlSecs = 60) {
        const key = this.getCacheKey(endpoint, params);
        this.responseCache[key] = {
            data,
            timestamp: Date.now()
        };
        // Auto-cleanup old entries
        if (Object.keys(this.responseCache).length > 100) {
            this.pruneCache();
        }
    }

    /**
     * Remove old cache entries
     */
    pruneCache() {
        const now = Date.now();
        const maxAgeSecs = 120;
        Object.keys(this.responseCache).forEach(key => {
            const ageMs = now - this.responseCache[key].timestamp;
            if (ageMs > maxAgeSecs * 1000) {
                delete this.responseCache[key];
            }
        });
    }

    /**
     * Check if we should throttle this request
     */
    shouldThrottle(endpoint, minIntervalMs = 500) {
        const now = Date.now();
        const lastTime = this.lastRequestTime[endpoint] || 0;
        const timeSinceLastRequest = now - lastTime;
        return timeSinceLastRequest < minIntervalMs;
    }

    /**
     * Record that a request was made
     */
    recordRequest(endpoint) {
        this.lastRequestTime[endpoint] = Date.now();
    }

    /**
     * Update rate limit state from response headers
     */
    updateRateLimitState(endpoint, rateLimitRemaining, rateLimitRetryAfter) {
        this.rateLimitState[endpoint] = {
            remaining: parseInt(rateLimitRemaining, 10) || null,
            retryAfterSecs: parseInt(rateLimitRetryAfter, 10) || null,
            lastUpdate: Date.now()
        };
    }

    /**
     * Check if we're at or near the rate limit
     */
    isRateLimited(endpoint, warningThreshold = 10) {
        const state = this.rateLimitState[endpoint];
        if (!state) return false;
        return state.remaining !== null && state.remaining < warningThreshold;
    }
}

const rateLimitManager = new RateLimitManager();

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
// FIX 4: Added caching and throttling to prevent 429 errors
app.get('/api/opensky', async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    // FIX 1: Append &extended=1 to get category field (index 17)
    const extendedParam = qs ? `${qs}&extended=1` : 'extended=1';
    const url = `https://opensky-network.org/api/states/all?${extendedParam}`;

    // FIX 4: Check cache first (60 second TTL)
    const cacheKey = rateLimitManager.getCacheKey('/api/opensky', req.query);
    const cachedData = rateLimitManager.getFromCache('/api/opensky', req.query, 60);
    if (cachedData) {
        console.log('[Proxy] OpenSky cache hit');
        return res.json({ ...cachedData, _cached: true });
    }

    // FIX 4: Check if we're hitting rate limit too hard
    // Only throttle if cache wasn't hit AND we have recent request
    // This allows fallback sources and different queries to proceed
    if (rateLimitManager.shouldThrottle('/api/opensky', 2000)) {
        console.warn('[Proxy] OpenSky throttled - too many requests in short time');
        return res.status(429).json({
            error: 'Rate limited locally',
            status: 429,
            message: 'Server is throttling requests to protect API quota. Please wait before retrying.'
        });
    }

    async function makeRequest(isRetry) {
        const headers = {};
        
        // Use updated auth logic (OAuth2 -> Basic -> Anonymous)
        const authHeader = await openSkyTokenManager.getAuthHeader();
        if (authHeader) {
            headers['Authorization'] = authHeader;
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

            // FIX 4: Update rate limit state
            if (rateLimitRemaining || rateLimitRetryAfter) {
                rateLimitManager.updateRateLimitState('/api/opensky', rateLimitRemaining, rateLimitRetryAfter);
            }

            // 401 — token expired or invalid: invalidate and retry once
            if (response.status === 401 && !isRetry) {
                console.warn('[Proxy] OpenSky 401 — invalidating token and retrying...');
                openSkyTokenManager.invalidate();
                return makeRequest(true);
            }

            // 429 — rate limited: forward the retry-after info
            if (response.status === 429) {
                console.warn('[Proxy] OpenSky 429 — rate limited (upstream)');
                const retryBody = { error: 'Rate limited', status: 429 };
                if (rateLimitRetryAfter) retryBody.retryAfterSeconds = parseInt(rateLimitRetryAfter, 10);
                // FIX 4: Record this attempt for throttling
                rateLimitManager.recordRequest('/api/opensky');
                return res.status(429).json(retryBody);
            }

            if (!response.ok) {
                console.warn(`[Proxy] OpenSky returned ${response.status}`);
                return res.status(response.status).json({ error: `OpenSky returned ${response.status}` });
            }

            const data = await response.json();
            // Include auth mode info for client-side source display
            data._authMode = authHeader ? (authHeader.startsWith('Bearer') ? 'OAuth2' : 'Basic') : 'Anonymous';

            // FIX 4: Cache the successful response
            rateLimitManager.setCache('/api/opensky', req.query, data, 60);
            rateLimitManager.recordRequest('/api/opensky');

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
// FIX 4: Added caching and throttling to prevent 429 errors
app.get('/api/adsbfi', async (req, res) => {
    const lat = parseFloat(req.query.lat) || 0;
    const lon = parseFloat(req.query.lon) || 0;
    const radius = parseInt(req.query.radius, 10) || 250;
    const bounds = req.query.bounds || '';

    // FIX 4: Check cache first (90 second TTL - ADSB.fi data doesn't change as frequently)
    const cacheKey = rateLimitManager.getCacheKey('/api/adsbfi', req.query);
    const cachedData = rateLimitManager.getFromCache('/api/adsbfi', req.query, 90);
    if (cachedData) {
        console.log('[Proxy] ADSBFI cache hit');
        return res.json({ ...cachedData, _cached: true });
    }

    // FIX 4: Check if we're hitting rate limit too hard
    // Allow ~2 requests per 3 seconds minimum
    if (rateLimitManager.shouldThrottle('/api/adsbfi', 3000)) {
        console.warn('[Proxy] ADSBFI throttled - too many requests in short time');
        return res.status(429).json({
            error: 'Rate limited locally',
            status: 429,
            message: 'Server is throttling requests to protect API quota. Please wait before retrying.'
        });
    }

    let url;
    if (bounds) {
        // bounds format: south,north,west,east
        // Note: ADSB.fi v2 API primarily uses lat/lon/dist. 
        // If bounds support is needed, we'd calculate center/radius here.
        // For now, fallback to center point logic or ignore bounds.
        console.warn('[Proxy] ADSB.fi bounds query not fully supported, using center point if available');
    }
    
    // Default: lat/lon/dist based query
    url = `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json'
            },
            timeout: 30000
        });

        if (!response.ok) {
            console.warn(`[Proxy] ADSBFI returned ${response.status} for ${url}`);
            // FIX 4: Record this attempt for throttling
            rateLimitManager.recordRequest('/api/adsbfi');
            return res.status(response.status).json({ error: `ADSBFI returned ${response.status}` });
        }

        const data = await response.json();

        // FIX 4: Cache the successful response
        rateLimitManager.setCache('/api/adsbfi', req.query, data, 90);
        rateLimitManager.recordRequest('/api/adsbfi');

        res.json(data);
    } catch (err) {
        console.error(`[Proxy] ADSBFI Error for ${url}:`, err.message);
        res.status(502).json({ error: 'ADSBFI proxy error', message: err.message });
    }
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

// 511GA (Georgia DOT) Camera API Proxy
app.get('/api/gdot-cameras', async (req, res) => {
    const { start = 0, length = 100 } = req.query;
    // DataTables-like parameters required by the 511GA endpoint
    const body = `draw=1&columns%5B0%5D%5Bdata%5D=cameras&start=${start}&length=${length}`;
    
    console.log(`[Proxy] Fetching GDOT cameras (start: ${start}, length: ${length})`);

    try {
        const response = await fetch('https://511ga.org/List/GetData/Cameras', {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://511ga.org/map',
                'Origin': 'https://511ga.org',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body,
            timeout: 15000
        });
        
        if (!response.ok) {
            const text = await response.text();
            console.error(`[Proxy] GDOT API Error: ${response.status} - ${text.substring(0, 100)}`);
            return res.status(response.status).json({ error: `GDOT returned ${response.status}` });
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[Proxy] GDOT proxy error:', err.message);
        res.status(502).json({ error: 'GDOT proxy error', message: err.message });
    }
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

// --- Configuration Endpoint ---
// Returns non-sensitive configuration to the frontend
app.get('/api/config', (req, res) => {
    res.json({
        cesiumIonToken: process.env.CESIUM_ION_TOKEN || '',
        googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
        openskyClientId: process.env.OPENSKY_CLIENT_ID ? 'configured' : '', // Don't expose secret
        adsbExchangeApiKey: process.env.ADSBX_API_KEY ? 'configured' : '', // Don't expose secret
        windyWebcamApiKey: process.env.WINDY_WEBCAM_API_KEY ? 'configured' : '', // Don't expose secret
        adsbfiEnabled: process.env.ADSBFI_ENABLED !== 'false'
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
