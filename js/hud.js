/* ========================================
   WorldView - HUD Controls, Search, Layers, Counters
   ======================================== */

const WorldViewHUD = (() => {
    'use strict';

    let viewer = null;
    const layerStates = {
        aircraft: true,
        satellites: true,
        earthquakes: true,
        weather: true,
        cameras: true
    };

    const counters = {
        aircraft: 0,
        satellites: 0,
        events: 0,
        cameras: 0
    };

    let onLayerToggleCallback = null;
    let onShaderChangeCallback = null;

    // FIX 3: Unit preference — default metric (KM), persisted to localStorage
    let useMetric = localStorage.getItem('worldview-units') !== 'imperial';

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[HUD] Initializing HUD controls...');

        setupLayerToggles();
        setupShaderButtons();
        setupSearch();
        setupPopupClose();
        setupUnitToggle();
        startClockUpdate();
        startCameraInfoUpdate();

        console.log('[HUD] HUD initialized.');
    }

    // --- Layer Toggles ---
    function setupLayerToggles() {
        const buttons = document.querySelectorAll('.layer-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const layer = btn.getAttribute('data-layer');
                layerStates[layer] = !layerStates[layer];
                btn.classList.toggle('active', layerStates[layer]);

                console.log(`[HUD] Layer '${layer}' ${layerStates[layer] ? 'ON' : 'OFF'}`);

                if (onLayerToggleCallback) {
                    onLayerToggleCallback(layer, layerStates[layer]);
                }
            });
        });
    }

    function onLayerToggle(callback) {
        onLayerToggleCallback = callback;
    }

    function isLayerActive(layer) {
        return layerStates[layer] !== false;
    }

    // --- Shader Buttons ---
    function setupShaderButtons() {
        const buttons = document.querySelectorAll('.shader-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const shader = btn.getAttribute('data-shader');

                buttons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                console.log(`[HUD] Shader mode: ${shader}`);

                if (onShaderChangeCallback) {
                    onShaderChangeCallback(shader);
                }
            });
        });
    }

    function onShaderChange(callback) {
        onShaderChangeCallback = callback;
    }

    // --- Search ---
    function setupSearch() {
        const input = document.getElementById('search-input');
        if (!input) return;

        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const query = input.value.trim();
                if (!query) return;

                console.log(`[HUD] Searching for: ${query}`);
                input.blur();

                try {
                    // Use Cesium Ion geocoder service
                    const resource = await Cesium.IonGeocoderService.fromUrl(
                        'https://api.cesium.com/v1/geocode'
                    ).catch(() => null);

                    // Fallback: use OpenStreetMap Nominatim
                    const response = await fetch(
                        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
                        { headers: { 'User-Agent': 'WorldView-Dashboard/1.0' } }
                    );
                    const results = await response.json();

                    if (results && results.length > 0) {
                        const result = results[0];
                        const lon = parseFloat(result.lon);
                        const lat = parseFloat(result.lat);
                        console.log(`[HUD] Found: ${result.display_name} (${lat}, ${lon})`);
                        WorldViewGlobe.flyTo(lon, lat, 500000);
                    } else {
                        console.warn('[HUD] No results found for:', query);
                    }
                } catch (err) {
                    console.error('[HUD] Search error:', err);
                    // Try a simpler geocoding approach
                    try {
                        const resp = await fetch(
                            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`
                        );
                        const data = await resp.json();
                        if (data && data.length > 0) {
                            WorldViewGlobe.flyTo(parseFloat(data[0].lon), parseFloat(data[0].lat), 500000);
                        }
                    } catch (e2) {
                        console.error('[HUD] Fallback search also failed:', e2);
                    }
                }
            }
        });
    }

    // --- Popup ---
    function setupPopupClose() {
        const closeBtn = document.getElementById('popup-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', hidePopup);
        }
    }

    function showPopup(title, data) {
        const popup = document.getElementById('entity-popup');
        const titleEl = document.getElementById('popup-title');
        const bodyEl = document.getElementById('popup-body');

        if (!popup || !titleEl || !bodyEl) return;

        titleEl.textContent = title;
        bodyEl.innerHTML = '';

        data.forEach(item => {
            const row = document.createElement('div');

            // Support special 'button' row type
            if (item.type === 'button') {
                row.className = 'popup-row popup-btn-row';
                const btn = document.createElement('button');
                btn.className = 'popup-action-btn';
                btn.textContent = item.label;
                if (item.onclick) {
                    btn.addEventListener('click', item.onclick);
                }
                row.appendChild(btn);
                bodyEl.appendChild(row);
                return;
            }

            row.className = 'popup-row';

            const key = document.createElement('span');
            key.className = 'popup-key';
            key.textContent = item.key;

            const val = document.createElement('span');
            val.className = 'popup-val';
            if (item.class) val.classList.add(item.class);
            val.textContent = item.value;

            row.appendChild(key);
            row.appendChild(val);
            bodyEl.appendChild(row);
        });

        popup.classList.remove('hidden');
    }

    function hidePopup() {
        const popup = document.getElementById('entity-popup');
        if (popup) popup.classList.add('hidden');
    }

    // --- Counters ---
    function updateCounter(type, count) {
        counters[type] = count;
        const el = document.getElementById(`${type}-count`);
        if (el) {
            el.textContent = count.toLocaleString();
        }
    }

    function getCounter(type) {
        return counters[type] || 0;
    }

    // --- Clock ---
    function startClockUpdate() {
        function updateClock() {
            const now = new Date();
            const utc = now.toISOString().substr(11, 8) + 'Z';
            const el = document.getElementById('utc-time');
            if (el) el.textContent = utc;
        }
        updateClock();
        setInterval(updateClock, 1000);
    }

    // --- FIX 3: Unit Toggle ---
    function setupUnitToggle() {
        const btn = document.getElementById('unit-toggle');
        if (!btn) return;

        // Set initial visual state
        updateUnitToggleUI(btn);

        btn.addEventListener('click', () => {
            useMetric = !useMetric;
            localStorage.setItem('worldview-units', useMetric ? 'metric' : 'imperial');
            updateUnitToggleUI(btn);
            console.log(`[HUD] Units switched to: ${useMetric ? 'KM (metric)' : 'MI (imperial)'}`);
        });
    }

    function updateUnitToggleUI(btn) {
        if (!btn) btn = document.getElementById('unit-toggle');
        if (!btn) return;
        btn.textContent = useMetric ? 'KM' : 'MI';
        btn.classList.toggle('active', !useMetric); // highlight when imperial (non-default)
    }

    // Public method: returns true if metric (KM) mode is active
    function isMetric() {
        return useMetric;
    }

    // --- Camera Info ---
    function startCameraInfoUpdate() {
        function updateCameraInfo() {
            const pos = WorldViewGlobe.getCameraPosition();
            if (!pos) return;

            const latEl = document.getElementById('cam-lat');
            const lonEl = document.getElementById('cam-lon');
            const altEl = document.getElementById('cam-alt');

            if (latEl) latEl.textContent = pos.lat.toFixed(4) + '\u00b0';
            if (lonEl) lonEl.textContent = pos.lon.toFixed(4) + '\u00b0';

            if (altEl) {
                if (useMetric) {
                    // Metric: show in km or m
                    if (pos.alt > 1000000) {
                        altEl.textContent = (pos.alt / 1000).toFixed(0) + ' km';
                    } else if (pos.alt > 1000) {
                        altEl.textContent = (pos.alt / 1000).toFixed(1) + ' km';
                    } else {
                        altEl.textContent = pos.alt.toFixed(0) + ' m';
                    }
                } else {
                    // Imperial: show in miles or feet
                    const altMiles = pos.alt / 1609.34;
                    const altFeet = pos.alt * 3.28084;
                    if (altMiles > 1) {
                        altEl.textContent = altMiles.toFixed(1) + ' mi';
                    } else {
                        altEl.textContent = Math.round(altFeet).toLocaleString() + ' ft';
                    }
                }
            }
        }
        setInterval(updateCameraInfo, 500);
    }

    // --- Loading Screen ---
    function setLoadingProgress(percent, text) {
        const bar = document.getElementById('loading-progress');
        const label = document.getElementById('loading-text');
        if (bar) bar.style.width = percent + '%';
        if (label) label.textContent = text;
    }

    function hideLoadingScreen() {
        const screen = document.getElementById('loading-screen');
        if (screen) {
            screen.classList.add('fade-out');
            setTimeout(() => {
                screen.style.display = 'none';
            }, 1000);
        }
    }

    function setStatus(text) {
        const el = document.getElementById('status-text');
        if (el) el.textContent = text;
    }

    return {
        init,
        onLayerToggle,
        onShaderChange,
        isLayerActive,
        showPopup,
        hidePopup,
        updateCounter,
        getCounter,
        setLoadingProgress,
        hideLoadingScreen,
        setStatus,
        isMetric
    };
})();
