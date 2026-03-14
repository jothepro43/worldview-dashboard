/* ========================================
   WorldView - CORS Proxy Server
   Node.js Express server for API proxying
   ======================================== */

const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;

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

// OpenSky Network (supports optional bbox query params forwarded verbatim)
app.get('/api/opensky', (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    const url = qs
        ? `https://opensky-network.org/api/states/all?${qs}`
        : 'https://opensky-network.org/api/states/all';

    // Forward Basic Auth header if present (flights.js sends it)
    const headers = {};
    if (req.headers.authorization) {
        headers['Authorization'] = req.headers.authorization;
    }

    proxyRequest(url, req, res, { headers });
});

// ADS-B Exchange (adsb.lol) \u2013 free community fallback
app.get('/api/adsb', (req, res) => {
    const lat  = parseFloat(req.query.lat)  || 0;
    const lon  = parseFloat(req.query.lon)  || 0;
    const dist = parseInt(req.query.dist, 10) || 250;
    const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
    proxyRequest(url, req, res);
});

// ADS-B Exchange (RapidAPI) \u2013 uses API key from CONFIG
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

// \u2500\u2500 Windy Webcams API (proxied \u2014 attaches API key) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500 MJPEG / HLS Stream Proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Proxies a remote MJPEG or HLS stream through the server to avoid
// CORS issues in the browser. The client passes ?url=<encoded-stream-url>.

app.get('/api/proxy-stream', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Validate URL \u2014 only allow http/https
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
    console.log(`  GET  /api/opensky         -> OpenSky Network (bbox + auth supported)`);
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
