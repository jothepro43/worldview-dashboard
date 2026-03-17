/* ========================================
   WorldView - Main Application Init
   Orchestrates all modules
   ======================================== */

(() => {
    'use strict';

    // =============================================
    // MASTER CONFIGURATION — All API Keys
    // =============================================
    const CONFIG = {
        // These will be loaded asynchronously from server
        cesiumIonToken: 'YOUR_CESIUM_ION_TOKEN',
        googleMapsApiKey: 'YOUR_GOOGLE_MAPS_API_KEY',
        openskyClientId: 'YOUR_OPENSKY_CLIENT_ID',
        openskyClientSecret: 'YOUR_OPENSKY_CLIENT_SECRET',
        adsbfiEnabled: true,
        adsbExchangeApiKey: 'YOUR_ADSBEXCHANGE_API_KEY',
        windyWebcamApiKey: 'YOUR_WINDY_WEBCAM_API_KEY',
        acledApiKey: 'YOUR_ACLED_API_KEY',
        acledEmail: 'YOUR_ACLED_EMAIL'
    };

    // Make CONFIG globally accessible so other modules can read it
    window.WorldViewConfig = CONFIG;
    // =============================================

    let viewer = null;

    /**
     * Helper: Load config from server environment variables
     */
    async function loadConfigFromServer() {
        try {
            console.log('[App] Loading configuration from server...');
            const response = await fetch('/api/config');
            if (response.ok) {
                const envConfig = await response.json();
                
                // Merge server config into client config
                if (envConfig.cesiumIonToken) CONFIG.cesiumIonToken = envConfig.cesiumIonToken;
                if (envConfig.googleMapsApiKey) CONFIG.googleMapsApiKey = envConfig.googleMapsApiKey;
                // Note: secrets like openskyClientSecret stay on server
                if (envConfig.adsbfiEnabled !== undefined) CONFIG.adsbfiEnabled = envConfig.adsbfiEnabled;
                
                // These might be used directly or just indicate configuration exists
                if (envConfig.openskyClientId === 'configured') CONFIG.openskyClientId = 'configured_on_server';
                if (envConfig.openskyClientSecret === 'configured') CONFIG.openskyClientSecret = 'configured_on_server';
                
                console.log('[App] Configuration loaded from server environment.');
            }
        } catch (err) {
            console.warn('[App] Failed to load config from server, using local defaults:', err);
        }
    }

    /**
     * Helper: returns true if a config value is set (not a YOUR_* placeholder).
     */
    function isConfigured(key) {
        const val = CONFIG[key];
        if (val === undefined || val === null || val === false) return false;
        if (typeof val === 'string' && val.startsWith('YOUR_')) return false;
        if (typeof val === 'string' && val.trim() === '') return false;
        return true;
    }

    async function boot() {
        const t0 = performance.now();
        console.log('%c========================================', 'color: #00f0ff');
        console.log('%c  WorldView - Geospatial Intelligence', 'color: #00f0ff; font-weight: bold; font-size: 14px');
        console.log('%c  Phase 1 Initializing...', 'color: #00ff88');
        console.log('%c========================================', 'color: #00f0ff');
        console.log('[App] Boot started at', new Date().toISOString());

        // Load env config first
        await loadConfigFromServer();

        // ── Config diagnostics ──────────────────────────────────────────────
        console.log('%c[Config] API Key Status:', 'color: #ffaa00; font-weight: bold');
        const configKeys = [
            ['cesiumIonToken', 'Cesium Ion'],
            ['googleMapsApiKey', 'Google Maps'],
            ['openskyClientId', 'OpenSky (Client ID)'],
            ['openskyClientSecret', 'OpenSky (Client Secret)'],
            ['adsbfiEnabled', 'ADSB.fi'],
            ['adsbExchangeApiKey', 'ADS-B Exchange'],
            ['windyWebcamApiKey', 'Windy Webcams'],
            ['acledApiKey', 'ACLED'],
            ['acledEmail', 'ACLED Email']
        ];
        configKeys.forEach(([key, label]) => {
            const ok = isConfigured(key);
            const icon = ok ? '\u2713' : '\u2717';
            const color = ok ? 'color: #00ff88' : 'color: #ff3344';
            console.log(`%c  ${icon} ${label}`, color);
        });

        // Verify dependencies are loaded
        if (typeof Cesium === 'undefined') {
            console.error('[App] FATAL: CesiumJS is not loaded! Check your internet connection and script tag.');
            return;
        }
        console.log('[App] CesiumJS loaded:', Cesium.VERSION);

        if (typeof satellite === 'undefined') {
            console.warn('[App] WARNING: satellite.js is not loaded. Satellite tracking will be disabled.');
        } else {
            console.log('[App] satellite.js loaded.');
        }

        // Verify HUD module exists
        if (typeof WorldViewHUD === 'undefined') {
            console.error('[App] FATAL: WorldViewHUD module not found. Check script loading order.');
            return;
        }

        try {
            // Step 1: Initialize Globe
            console.log('[App] Step 1/6: Initializing globe...');
            WorldViewHUD.setLoadingProgress(10, 'Initializing globe...');
            viewer = await WorldViewGlobe.init(CONFIG);

            if (!viewer) {
                throw new Error('WorldViewGlobe.init() returned null/undefined. Globe failed to initialize.');
            }
            console.log(`[App] Globe initialized in ${(performance.now() - t0).toFixed(0)}ms`);

            // Step 2: Initialize Shaders
            console.log('[App] Step 2/6: Loading shaders...');
            WorldViewHUD.setLoadingProgress(20, 'Loading post-processing shaders...');
            try {
                WorldViewShaders.init(viewer);
                console.log('[App] Shaders initialized.');
            } catch (shaderErr) {
                console.error('[App] Shader init failed (non-fatal):', shaderErr);
            }

            // Step 3: Initialize HUD
            console.log('[App] Step 3/6: Setting up HUD...');
            WorldViewHUD.setLoadingProgress(30, 'Setting up HUD controls...');
            WorldViewHUD.init(viewer);

            // Connect HUD callbacks
            WorldViewHUD.onShaderChange((mode) => {
                console.log(`[App] Shader mode changed to: ${mode}`);
                WorldViewShaders.setMode(mode);
            });

            WorldViewHUD.onLayerToggle((layer, active) => {
                console.log(`[App] Layer toggle: ${layer} -> ${active ? 'ON' : 'OFF'}`);
                try {
                    switch (layer) {
                        case 'aircraft':
                            WorldViewFlights.setVisible(active);
                            break;
                        case 'satellites':
                            WorldViewSatellites.setVisible(active);
                            break;
                        case 'earthquakes':
                            WorldViewEarthquakes.setVisible(active);
                            break;
                        case 'weather':
                            WorldViewWeather.setVisible(active);
                            break;
                        case 'cameras':
                            WorldViewCameras.setVisible(active);
                            break;
                    }
                } catch (toggleErr) {
                    console.error(`[App] Error toggling layer ${layer}:`, toggleErr);
                }
            });
            console.log('[App] HUD initialized and callbacks wired.');

            // Step 4: Initialize data layers (each wrapped in try/catch so one failure doesn't block others)
            console.log('[App] Step 4/6: Starting data layers...');

            WorldViewHUD.setLoadingProgress(40, 'Starting aircraft tracking...');
            try {
                WorldViewFlights.init(viewer);
                console.log('[App] \u2713 Flights layer initialized.');
            } catch (err) {
                console.error('[App] \u2717 Flights init failed:', err);
            }

            WorldViewHUD.setLoadingProgress(55, 'Loading satellite TLE data...');
            try {
                WorldViewSatellites.init(viewer);
                console.log('[App] \u2713 Satellites layer initialized.');
            } catch (err) {
                console.error('[App] \u2717 Satellites init failed:', err);
            }

            WorldViewHUD.setLoadingProgress(70, 'Fetching earthquake data...');
            try {
                WorldViewEarthquakes.init(viewer);
                console.log('[App] \u2713 Earthquakes layer initialized.');
            } catch (err) {
                console.error('[App] \u2717 Earthquakes init failed:', err);
            }

            WorldViewHUD.setLoadingProgress(80, 'Loading weather events...');
            try {
                WorldViewWeather.init(viewer);
                console.log('[App] \u2713 Weather layer initialized.');
            } catch (err) {
                console.error('[App] \u2717 Weather init failed:', err);
            }

            WorldViewHUD.setLoadingProgress(90, 'Initializing camera layer...');
            try {
                WorldViewCameras.init(viewer);
                console.log('[App] \u2713 Cameras layer initialized.');
            } catch (err) {
                console.error('[App] \u2717 Cameras init failed:', err);
            }

            // FIX 9: Wire up labels toggle button
            const labelsToggle = document.getElementById('labels-toggle');
            if (labelsToggle) {
                labelsToggle.addEventListener('click', function() {
                    const labelsOn = WorldViewGlobe.toggleLabels();
                    if (labelsOn === undefined) return;
                    this.classList.toggle('active', labelsOn);
                    this.textContent = labelsOn ? 'EN LABELS' : 'NO LABELS';
                });
                // Hide button if Google 3D Tiles are active
                if (!WorldViewGlobe.hasFallbackGlobe()) {
                    labelsToggle.style.display = 'none';
                }
            }

            // Step 5: Complete
            const bootTime = ((performance.now() - t0) / 1000).toFixed(2);
            WorldViewHUD.setLoadingProgress(100, `Systems online. Boot: ${bootTime}s`);
            WorldViewHUD.setStatus('ONLINE');

            // Hide loading screen after short delay
            setTimeout(() => {
                WorldViewHUD.hideLoadingScreen();
            }, 800);

            console.log('%c========================================', 'color: #00ff88');
            console.log(`%c  WorldView initialized in ${bootTime}s`, 'color: #00ff88; font-weight: bold');
            console.log('%c  All systems online.', 'color: #00ff88');
            console.log('%c========================================', 'color: #00ff88');

            // Step 6: Config warnings (only for critical keys)
            if (!isConfigured('cesiumIonToken')) {
                console.warn(
                    '\n%c[CONFIG] Cesium Ion token not set!',
                    'color: #ffaa00; font-size: 14px; font-weight: bold'
                );
                console.warn('  1. Create free account: https://cesium.com/ion/signup');
                console.warn('  2. Copy token from: https://cesium.com/ion/tokens');
                console.warn('  3. Paste in js/app.js \u2192 CONFIG.cesiumIonToken\n');
            }

            if (!isConfigured('googleMapsApiKey')) {
                console.warn(
                    '\n%c[CONFIG] Google Maps API key not set!',
                    'color: #ffaa00; font-size: 14px; font-weight: bold'
                );
                console.warn('  1. Go to: https://console.cloud.google.com');
                console.warn('  2. Enable \"Map Tiles API\"');
                console.warn('  3. Create API key under Credentials');
                console.warn('  4. Paste in js/app.js \u2192 CONFIG.googleMapsApiKey\n');
            }

            if (!isConfigured('openskyClientId') || !isConfigured('openskyClientSecret')) {
                console.warn(
                    '\n%c[CONFIG] OpenSky OAuth2 credentials not set!',
                    'color: #ffaa00; font-size: 14px; font-weight: bold'
                );
                console.warn('  1. Register at: https://opensky-network.org/login');
                console.warn('  2. Get OAuth2 client credentials');
                console.warn('  3. Set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET env vars on the server');
                console.warn('  4. Or paste in js/app.js \u2192 CONFIG.openskyClientId / openskyClientSecret\n');
            }

        } catch (err) {
            console.error('%c[App] CRITICAL ERROR during initialization:', 'color: #ff3344; font-size: 14px', err);
            console.error('[App] Error stack:', err.stack);
            WorldViewHUD.setLoadingProgress(100, 'ERROR: ' + err.message);
            WorldViewHUD.setStatus('ERROR');

            // Still try to hide loading screen after a delay
            setTimeout(() => {
                WorldViewHUD.hideLoadingScreen();
            }, 3000);
        }
    }

    // Boot when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        // Give browser a moment to settle
        setTimeout(boot, 100);
    }
})();
