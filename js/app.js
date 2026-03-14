/* ========================================
   WorldView - Main Application Init
   Orchestrates all modules
   ======================================== */

(() => {
    'use strict';

    // =============================================
    // CONFIGURATION - Replace with your API keys
    // =============================================
    const CONFIG = {
        cesiumIonToken: 'YOUR_CESIUM_ION_TOKEN',
        googleMapsApiKey: 'YOUR_GOOGLE_MAPS_API_KEY'
    };
    // =============================================

    let viewer = null;

    async function boot() {
        console.log('========================================');
        console.log('  WorldView - Geospatial Intelligence');
        console.log('  Phase 1 Initializing...');
        console.log('========================================');

        try {
            // Step 1: Initialize Globe
            WorldViewHUD.setLoadingProgress(10, 'Initializing globe...');
            viewer = await WorldViewGlobe.init(CONFIG);

            if (!viewer) {
                throw new Error('Failed to initialize CesiumJS viewer.');
            }

            // Step 2: Initialize Shaders
            WorldViewHUD.setLoadingProgress(20, 'Loading post-processing shaders...');
            WorldViewShaders.init(viewer);

            // Step 3: Initialize HUD
            WorldViewHUD.setLoadingProgress(30, 'Setting up HUD controls...');
            WorldViewHUD.init(viewer);

            // Connect HUD callbacks
            WorldViewHUD.onShaderChange((mode) => {
                WorldViewShaders.setMode(mode);
            });

            WorldViewHUD.onLayerToggle((layer, active) => {
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
            });

            // Step 4: Initialize data layers
            WorldViewHUD.setLoadingProgress(40, 'Starting aircraft tracking...');
            try {
                WorldViewFlights.init(viewer);
            } catch (err) {
                console.error('[App] Failed to init flights:', err);
            }

            WorldViewHUD.setLoadingProgress(55, 'Loading satellite TLE data...');
            try {
                WorldViewSatellites.init(viewer);
            } catch (err) {
                console.error('[App] Failed to init satellites:', err);
            }

            WorldViewHUD.setLoadingProgress(70, 'Fetching earthquake data...');
            try {
                WorldViewEarthquakes.init(viewer);
            } catch (err) {
                console.error('[App] Failed to init earthquakes:', err);
            }

            WorldViewHUD.setLoadingProgress(80, 'Loading weather events...');
            try {
                WorldViewWeather.init(viewer);
            } catch (err) {
                console.error('[App] Failed to init weather:', err);
            }

            WorldViewHUD.setLoadingProgress(90, 'Initializing camera layer...');
            try {
                WorldViewCameras.init(viewer);
            } catch (err) {
                console.error('[App] Failed to init cameras:', err);
            }

            // Step 5: Complete
            WorldViewHUD.setLoadingProgress(100, 'Systems online.');
            WorldViewHUD.setStatus('ONLINE');

            // Hide loading screen after short delay
            setTimeout(() => {
                WorldViewHUD.hideLoadingScreen();
            }, 800);

            console.log('========================================');
            console.log('  WorldView initialized successfully!');
            console.log('  All systems are online.');
            console.log('========================================');

            // Check for placeholder API keys and warn
            if (CONFIG.cesiumIonToken === 'YOUR_CESIUM_ION_TOKEN') {
                console.warn('\n%c[WARNING] Cesium Ion token not configured!', 'color: #ffaa00; font-size: 14px;');
                console.warn('Get a free token at: https://cesium.com/ion/tokens');
                console.warn('Set it in js/app.js -> CONFIG.cesiumIonToken\n');
            }

            if (CONFIG.googleMapsApiKey === 'YOUR_GOOGLE_MAPS_API_KEY') {
                console.warn('\n%c[WARNING] Google Maps API key not configured!', 'color: #ffaa00; font-size: 14px;');
                console.warn('Get a key at: https://developers.google.com/maps');
                console.warn('Enable Map Tiles API in Google Cloud Console.');
                console.warn('Set it in js/app.js -> CONFIG.googleMapsApiKey\n');
            }

        } catch (err) {
            console.error('[App] Critical initialization error:', err);
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
        boot();
    }
})();
