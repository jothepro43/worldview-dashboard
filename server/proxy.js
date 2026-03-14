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
                // URL-encoded form data
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

// OpenSky Network
app.get('/api/opensky', (req, res) => {
    proxyRequest('https://opensky-network.org/api/states/all', req, res);
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
    console.log(`  GET  /api/opensky      -> OpenSky Network`);
    console.log(`  GET  /api/tle/:group   -> CelesTrak TLE`);
    console.log(`  GET  /api/earthquakes  -> USGS Earthquakes`);
    console.log(`  GET  /api/eonet        -> NASA EONET`);
    console.log(`  GET  /api/nws          -> NWS Alerts`);
    console.log(`  POST /api/overpass     -> Overpass API`);
    console.log(`  GET  /api/health       -> Health Check`);
    console.log('');
});

module.exports = app;
