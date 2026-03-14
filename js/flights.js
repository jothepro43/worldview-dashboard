/* ========================================
   WorldView - Aircraft Tracking
   FIX 2: Credit-aware adaptive polling
   FIX 4: Category color-coding (OpenSky extended=1, field 17)
   FIX 5: Waterfall priority: OpenSky → ADSB.fi (proxied) → ADS-B Exchange
          Continuous interpolation between API updates
   ======================================== */

const WorldViewFlights = (() => {
    'use strict';

    let viewer = null;
    let billboardCollection = null;
    let labelCollection = null;
    let aircraftData = [];
    let pollInterval = null;
    let visible = true;

    // ── Active source tracking for HUD ──────────────────────────────────────
    let activeSource = 'INITIALIZING';

    // ── Rate-limiting / credit state ─────────────────────────────────────
    let consecutiveFailures = 0;
    let backoffUntil = 0;
    let isRateLimited = false;
    let rateLimitRemaining = null;       // from X-Rate-Limit-Remaining header
    let rateLimitRetryAfterMs = 0;       // from X-Rate-Limit-Retry-After-Seconds header
    let lastCreditCost = 0;              // estimated credit cost of last request
    let dailyCreditsUsed = 0;            // running tally this session

    // ── FIX 2: User-configurable refresh intervals ──────────────────────
    // Stored in localStorage for persistence across page reloads
    const POLL_KEY = 'worldview-aircraft-poll-ms';
    const POLL_MODE_KEY = 'worldview-aircraft-poll-mode'; // 'auto' or 'manual'
    let userPollMs = parseInt(localStorage.getItem(POLL_KEY), 10) || 0;
    let pollMode = localStorage.getItem(POLL_MODE_KEY) || 'auto';

    // ── Interpolation state ─────────────────────────────────────────────
    let aircraftPositions = new Map();
    let interpolationFrameId = null;
    let lastInterpolationTime = 0;

    // ── FIX 4: Category color-coding ────────────────────────────────────
    // OpenSky extended=1 category field (index 17):
    //   0  = No info
    //   1  = No ADS-B emitter category info
    //   2  = Light (< 15500 lbs)
    //   3  = Small (15500–75000 lbs)
    //   4  = Large (75000–300000 lbs)
    //   5  = High Vortex Large (B757)
    //   6  = Heavy (> 300000 lbs)
    //   7  = High Performance (> 5g, > 400 kts)
    //   8  = Rotorcraft
    //   9  = Glider / Sailplane
    //  10  = Lighter-than-air
    //  11  = Parachutist / Skydiver
    //  12  = Ultralight / Hang-glider / Paraglider
    //  13  = Reserved
    //  14  = Unmanned Aerial Vehicle (UAV/Drone)
    //  15  = Space / Trans-atmospheric vehicle
    //  16  = Surface Emergency Vehicle
    //  17  = Surface Service Vehicle
    //  18  = Point Obstacle (includes tethered balloons)
    //  19  = Cluster Obstacle
    //  20  = Line Obstacle

    const CATEGORY_COLORS = {
        7:  '#ff3344',  // High Performance → red
        8:  '#ff8800',  // Rotorcraft → orange
        14: '#ffdd00',  // UAV/Drone → yellow
    };
    const DEFAULT_AIRCRAFT_COLOR = '#00d4ff'; // cyan for all others

    // FIX 4: Category filter visibility
    const categoryVisibility = {
        'high-perf': true,
        'rotorcraft': true,
        'uav': true,
        'civilian': true,
        'military': true
    };

    const categoryCounts = {
        'high-perf': 0,
        'rotorcraft': 0,
        'uav': 0,
        'civilian': 0,
        'military': 0
    };

    const MILITARY_PREFIXES = [
        'RCH', 'DUKE', 'EVAC', 'REACH', 'KING', 'PEDRO', 'JOLLY',
        'KNIFE', 'TOPCAT', 'VADER', 'DOOM', 'VIPER', 'HAWK', 'EAGLE',
        'BONE', 'GHOST', 'REAPER', 'WEASEL', 'RAPTOR', 'RAIDER',
        'TALON', 'COBRA', 'DEMON', 'FURY', 'TITAN', 'RAVEN',
        'NAF', 'CNV', 'CFC', 'RRR', 'AIO', 'IAM', 'MMF',
        'PAT', 'PLF', 'GAF', 'BAF', 'FAF', 'HVK', 'RFF',
        'SPAR', 'SAM', 'EXEC', 'GRZLY', 'FORGE', 'ATLAS'
    ];

    function isMilitary(callsign, category) {
        if (category === 7) return true;
        if (!callsign) return false;
        const cs = callsign.trim().toUpperCase();
        return MILITARY_PREFIXES.some(prefix => cs.startsWith(prefix));
    }

    // FIX 4: Determine color and filter-category for an aircraft
    function getAircraftStyle(callsign, category) {
        const mil = isMilitary(callsign, category);
        if (mil) {
            return { color: '#ff3344', filterCat: 'military', isMilitary: true };
        }
        if (category === 7) {
            return { color: CATEGORY_COLORS[7], filterCat: 'high-perf', isMilitary: false };
        }
        if (category === 8) {
            return { color: CATEGORY_COLORS[8], filterCat: 'rotorcraft', isMilitary: false };
        }
        if (category === 14) {
            return { color: CATEGORY_COLORS[14], filterCat: 'uav', isMilitary: false };
        }
        return { color: DEFAULT_AIRCRAFT_COLOR, filterCat: 'civilian', isMilitary: false };
    }

    function getConfig() {
        return (typeof window !== 'undefined' && window.WorldViewConfig) ? window.WorldViewConfig : {};
    }

    function isConfigured(key) {
        const cfg = getConfig();
        const val = cfg[key];
        if (val === undefined || val === null || val === false) return false;
        if (typeof val === 'string' && val.startsWith('YOUR_')) return false;
        if (typeof val === 'string' && val.trim() === '') return false;
        return true;
    }

    function setFlightSource(source) {
        activeSource = source;
        console.log(`[Flights] Source: ${source}`);
        const el = document.getElementById('flight-source-status');
        if (el) el.textContent = source;
    }

    // ── Icon cache: keyed by hex color string ───────────────────────────
    const iconCache = new Map();

    function getAircraftIcon(hexColor, size) {
        const key = hexColor + '_' + size;
        if (iconCache.has(key)) return iconCache.get(key);
        const icon = createAircraftIcon(hexColor, size);
        iconCache.set(key, icon);
        return icon;
    }

    function createAircraftIcon(color, size) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const cx = size / 2;
        const cy = size / 2;
        const s = size * 0.4;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.15, -s * 0.4);
        ctx.lineTo(s * 0.8, -s * 0.1);
        ctx.lineTo(s * 0.8, s * 0.1);
        ctx.lineTo(s * 0.15, 0);
        ctx.lineTo(s * 0.35, s * 0.7);
        ctx.lineTo(s * 0.35, s * 0.85);
        ctx.lineTo(s * 0.1, s * 0.6);
        ctx.lineTo(0, s * 0.7);
        ctx.lineTo(-s * 0.1, s * 0.6);
        ctx.lineTo(-s * 0.35, s * 0.85);
        ctx.lineTo(-s * 0.35, s * 0.7);
        ctx.lineTo(-s * 0.15, 0);
        ctx.lineTo(-s * 0.8, s * 0.1);
        ctx.lineTo(-s * 0.8, -s * 0.1);
        ctx.lineTo(-s * 0.15, -s * 0.4);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.restore();
        return canvas.toDataURL();
    }

    // ── Credit cost estimation (FIX 2) ──────────────────────────────────
    // Based on bounding box area in square degrees:
    //   0–25 sq deg = 1 credit, 25–100 = 2, 100–400 = 3, >400/global = 4
    function estimateCreditCost(bbox) {
        if (!bbox) return 4; // global = 4 credits
        const area = Math.abs(bbox.north - bbox.south) * Math.abs(bbox.east - bbox.west);
        if (area <= 25) return 1;
        if (area <= 100) return 2;
        if (area <= 400) return 3;
        return 4;
    }

    function getBackoffDelay() {
        const remaining = backoffUntil - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    function applyBackoff(retryAfterSeconds) {
        if (retryAfterSeconds && retryAfterSeconds > 0) {
            // Use server-provided retry-after
            backoffUntil = Date.now() + (retryAfterSeconds * 1000);
            console.warn(`[Flights] Backoff: server says retry in ${retryAfterSeconds}s`);
        } else {
            const BASE = 10000;
            const MAX = 80000;
            consecutiveFailures++;
            const delay = Math.min(BASE * Math.pow(2, consecutiveFailures - 1), MAX);
            backoffUntil = Date.now() + delay;
            console.warn(`[Flights] Backoff: waiting ${delay / 1000}s (failure #${consecutiveFailures})`);
        }
    }

    function resetBackoff() { consecutiveFailures = 0; backoffUntil = 0; }

    function getCameraAltitude() {
        try {
            if (typeof WorldViewGlobe !== 'undefined' && WorldViewGlobe.getCameraPosition) {
                const pos = WorldViewGlobe.getCameraPosition();
                return pos ? pos.alt : Infinity;
            }
        } catch (e) { /* ignore */ }
        return Infinity;
    }

    function getViewportBbox() {
        try {
            if (typeof WorldViewGlobe !== 'undefined' && WorldViewGlobe.getViewportBounds) {
                return WorldViewGlobe.getViewportBounds();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getCameraCenter() {
        try {
            if (typeof WorldViewGlobe !== 'undefined' && WorldViewGlobe.getCameraPosition) {
                const pos = WorldViewGlobe.getCameraPosition();
                if (pos && pos.lat != null && pos.lon != null) return pos;
            }
        } catch (e) { /* ignore */ }
        return { lat: 0, lon: 0, alt: Infinity };
    }

    // ── FIX 2: Adaptive poll interval based on credit cost ──────────────
    function getAutoPollIntervalMs() {
        const alt = getCameraAltitude();
        const bbox = (alt != null && alt < 3000000) ? getViewportBbox() : null;
        const cost = estimateCreditCost(bbox);
        // Higher cost → slower polling to conserve credits
        if (cost <= 1) return 10000;  // 10s for small viewports
        if (cost <= 2) return 15000;  // 15s
        if (cost <= 3) return 20000;  // 20s
        return 30000;                 // 30s for global
    }

    function getEffectivePollMs() {
        if (pollMode === 'manual' && userPollMs > 0) return userPollMs;
        return getAutoPollIntervalMs();
    }

    function buildOpenSkyUrl() {
        const alt = getCameraAltitude();
        const useViewport = (alt != null && alt < 3000000);
        let bbox = null;
        if (useViewport) { bbox = getViewportBbox(); }
        if (bbox) {
            const { south, north, west, east } = bbox;
            return `/api/opensky?lamin=${south.toFixed(4)}&lomin=${west.toFixed(4)}&lamax=${north.toFixed(4)}&lomax=${east.toFixed(4)}`;
        }
        return '/api/opensky';
    }

    // ── FIX 5: Waterfall priority — OpenSky → ADSB.fi (proxied) → ADS-B Exchange ──

    async function fetchFromOpenSky() {
        const url = buildOpenSkyUrl();
        console.log('[Flights] OpenSky request:', url);

        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(12000) });

            // Read rate-limit headers forwarded by proxy (FIX 2)
            const remaining = response.headers.get('x-rate-limit-remaining');
            const retryAfter = response.headers.get('x-rate-limit-retry-after-seconds');
            if (remaining != null) rateLimitRemaining = parseInt(remaining, 10);
            if (retryAfter != null) rateLimitRetryAfterMs = parseInt(retryAfter, 10) * 1000;

            if (response.status === 429) {
                console.warn('[Flights] OpenSky 429 — rate limited');
                const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : 0;
                applyBackoff(retrySeconds);
                isRateLimited = true;
                return null;
            }
            if (!response.ok) {
                console.warn('[Flights] OpenSky returned status:', response.status);
                return null;
            }
            const data = await response.json();
            if (!data || !data.states || data.states.length === 0) {
                console.warn('[Flights] OpenSky returned no states');
                return null;
            }
            const authLabel = data._authMode === 'OAuth2' ? 'OpenSky (OAuth2)' : 'OpenSky (Anon)';

            // Track credit cost (FIX 2)
            const bbox = getViewportBbox();
            lastCreditCost = estimateCreditCost(bbox);
            dailyCreditsUsed += lastCreditCost;
            updateCreditDisplay();

            console.log(`[Flights] ${authLabel}: ${data.states.length} aircraft`);
            return { states: data.states, source: authLabel };
        } catch (err) {
            console.error('[Flights] OpenSky error:', err.message);
            return null;
        }
    }

    // FIX 3/5: ADSB.fi via server proxy (avoids CORS)
    async function fetchFromADSBfi() {
        const cfg = getConfig();
        if (cfg.adsbfiEnabled === false) {
            console.log('[Flights] ADSB.fi disabled in config');
            return null;
        }
        try {
            const center = getCameraCenter();
            const url = `/api/adsbfi?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}&radius=250`;
            console.log('[Flights] ADSB.fi request (proxied):', url);
            const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
            if (!response.ok) {
                console.warn('[Flights] ADSB.fi returned status:', response.status);
                return null;
            }
            const data = await response.json();
            const acArray = data.aircraft || data.ac;
            if (!acArray || acArray.length === 0) {
                console.warn('[Flights] ADSB.fi returned no aircraft');
                return null;
            }
            const states = normalizeADSBData(acArray);
            console.log(`[Flights] ADSB.fi: ${states.length} aircraft`);
            return { states, source: 'Fallback: ADSB.fi' };
        } catch (err) {
            console.error('[Flights] ADSB.fi error:', err.message);
            return null;
        }
    }

    async function fetchFromADSBExchange() {
        if (!isConfigured('adsbExchangeApiKey')) {
            console.log('[Flights] ADS-B Exchange API key not configured');
            return null;
        }
        try {
            const center = getCameraCenter();
            const lat = center.lat.toFixed(4);
            const lon = center.lon.toFixed(4);
            const url = `/api/adsbx?lat=${lat}&lon=${lon}&dist=250`;
            console.log('[Flights] ADS-B Exchange request:', url);
            const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
            if (!response.ok) {
                console.warn('[Flights] ADS-B Exchange returned status:', response.status);
                return null;
            }
            const data = await response.json();
            const acArray = data.ac || data.aircraft;
            if (!acArray || acArray.length === 0) {
                console.warn('[Flights] ADS-B Exchange returned no aircraft');
                return null;
            }
            const states = normalizeADSBData(acArray);
            console.log(`[Flights] ADS-B Exchange: ${states.length} aircraft`);
            return { states, source: 'Fallback: ADS-B Exchange' };
        } catch (err) {
            console.error('[Flights] ADS-B Exchange error:', err.message);
            return null;
        }
    }

    function normalizeADSBData(acArray) {
        return acArray
            .filter(ac => ac.lat != null && ac.lon != null)
            .map(ac => {
                const altMeters = (ac.alt_baro != null && ac.alt_baro !== 'ground')
                    ? parseFloat(ac.alt_baro) * 0.3048 : null;
                const velocityMS = ac.gs != null ? parseFloat(ac.gs) * 0.514444 : null;
                const vertRateMS = ac.baro_rate != null ? parseFloat(ac.baro_rate) / 196.85 : null;
                const onGround = ac.alt_baro === 'ground';
                const row = new Array(18).fill(null);
                row[0] = ac.hex || ac.icao || '';
                row[1] = ac.flight ? ac.flight.trim() : '';
                row[2] = '';
                row[5] = parseFloat(ac.lon);
                row[6] = parseFloat(ac.lat);
                row[7] = altMeters;
                row[8] = onGround;
                row[9] = velocityMS;
                row[10] = ac.track != null ? parseFloat(ac.track) : null;
                row[11] = vertRateMS;
                row[13] = altMeters;
                row[17] = null; // ADSB.fi doesn't have OpenSky-style category
                return row;
            });
    }

    // ── FIX 5: Main fetch with waterfall ────────────────────────────────
    async function fetchAircraft() {
        if (!visible) return;

        const backoffRemaining = getBackoffDelay();
        if (backoffRemaining > 0) {
            console.log(`[Flights] In backoff, skipping OpenSky. Retry in ${Math.ceil(backoffRemaining / 1000)}s.`);
            const fallbackResult = await tryFallbacks();
            if (fallbackResult) { applyResult(fallbackResult); }
            // FIX 5: Don't set source to 'Interpolating' — interpolation loop handles rendering continuously
            return;
        }

        try {
            const openskyResult = await fetchFromOpenSky();
            if (openskyResult) {
                resetBackoff();
                if (isRateLimited) {
                    isRateLimited = false;
                    if (typeof WorldViewHUD !== 'undefined' && WorldViewHUD.setStatus) {
                        WorldViewHUD.setStatus('ONLINE');
                    }
                }
                applyResult(openskyResult);
                return;
            }

            console.log('[Flights] OpenSky failed, trying fallbacks...');
            applyBackoff();
            const fallbackResult = await tryFallbacks();
            if (fallbackResult) {
                applyResult(fallbackResult);
                return;
            }

            console.warn('[Flights] All sources failed. Interpolating existing data.');
            setFlightSource('Interpolating');
        } catch (err) {
            console.error('[Flights] Error in fetch waterfall:', err);
            applyBackoff();
            setFlightSource('Interpolating');
        }
    }

    async function tryFallbacks() {
        const adsbfiResult = await fetchFromADSBfi();
        if (adsbfiResult) return adsbfiResult;
        const adsbxResult = await fetchFromADSBExchange();
        if (adsbxResult) return adsbxResult;
        return null;
    }

    function applyResult(result) {
        aircraftData = result.states;
        updatePositionStore(result.states);
        renderAircraft();
        setFlightSource(result.source);
        const count = aircraftData.filter(s => s[6] != null && s[5] != null && !s[8]).length;
        WorldViewHUD.updateCounter('aircraft', count);
        console.log(`[Flights] Updated: ${count} airborne aircraft (${result.source}).`);
    }

    function updatePositionStore(states) {
        const now = Date.now();
        states.forEach(state => {
            const icao24 = state[0];
            const lon = state[5];
            const lat = state[6];
            const alt = state[13] || state[7] || 10000;
            const velocity = state[9];
            const heading = state[10];
            if (icao24 == null || lon == null || lat == null) return;
            aircraftPositions.set(icao24, {
                lat, lon, alt,
                velocity: velocity || 0,
                heading: heading || 0,
                timestamp: now
            });
        });
    }

    // ── FIX 5: Continuous interpolation ─────────────────────────────────
    function interpolatePosition(rec, dtSeconds) {
        if (!rec || rec.velocity <= 0 || dtSeconds <= 0) {
            return { lat: rec.lat, lon: rec.lon, alt: rec.alt };
        }
        const headingRad = rec.heading * Math.PI / 180;
        const v = rec.velocity;
        const dt = dtSeconds;
        const dx = v * Math.sin(headingRad) * dt;
        const dy = v * Math.cos(headingRad) * dt;
        const latRad = rec.lat * Math.PI / 180;
        const newLat = rec.lat + (dy / 110540);
        const newLon = rec.lon + (dx / (111320 * Math.cos(latRad)));
        return { lat: newLat, lon: newLon, alt: rec.alt };
    }

    // FIX 5: The interpolation loop now runs continuously, not just as a fallback.
    // Between API fetches, aircraft positions are smoothly updated every second.
    function startInterpolationLoop() {
        if (interpolationFrameId !== null) return;
        function loop() {
            interpolationFrameId = requestAnimationFrame(loop);
            const now = Date.now();
            if (now - lastInterpolationTime < 1000) return;
            lastInterpolationTime = now;
            if (!visible || !billboardCollection || aircraftPositions.size === 0) return;
            renderAircraftInterpolated();
        }
        interpolationFrameId = requestAnimationFrame(loop);
    }

    function stopInterpolationLoop() {
        if (interpolationFrameId !== null) {
            cancelAnimationFrame(interpolationFrameId);
            interpolationFrameId = null;
        }
    }

    // FIX 4 + FIX 5: Interpolated render with category color-coding and filtering
    function renderAircraftInterpolated() {
        if (!viewer || !billboardCollection) return;
        billboardCollection.removeAll();
        labelCollection.removeAll();
        const now = Date.now();

        // Reset counts
        Object.keys(categoryCounts).forEach(k => { categoryCounts[k] = 0; });

        aircraftData.forEach(state => {
            const icao24 = state[0];
            const callsign = state[1] ? state[1].trim() : '';
            const originCountry = state[2] || '';
            const onGround = state[8];
            const velocity = state[9];
            const trueTrack = state[10];
            const verticalRate = state[11];
            const category = state[17];

            if (onGround) return;

            const rec = aircraftPositions.get(icao24);
            if (!rec || rec.lat == null || rec.lon == null) return;

            // FIX 4: Style and filter
            const style = getAircraftStyle(callsign, category);

            // Count regardless of visibility for the filter panel
            if (categoryCounts.hasOwnProperty(style.filterCat)) {
                categoryCounts[style.filterCat]++;
            }

            // Check filter visibility
            if (!categoryVisibility[style.filterCat]) return;

            const dtSeconds = (now - rec.timestamp) / 1000;
            const interp = interpolatePosition(rec, dtSeconds);
            const altitude = interp.alt;

            const icon = getAircraftIcon(style.color, 32);
            const scale = style.isMilitary ? 0.7 : 0.5;
            const position = Cesium.Cartesian3.fromDegrees(interp.lon, interp.lat, altitude);
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;

            billboardCollection.add({
                position, image: icon,
                scale: scale, rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: 0,
                id: { type: 'aircraft', icao24, callsign, originCountry, altitude, velocity, trueTrack, verticalRate, isMilitary: style.isMilitary, category, filterCat: style.filterCat }
            });

            if (style.isMilitary && callsign) {
                labelCollection.add({
                    position, text: callsign,
                    font: '10px Share Tech Mono',
                    fillColor: Cesium.Color.fromCssColorString('#ff3344'),
                    outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: 0, scale: 1.0
                });
            }
        });

        // Update filter panel counts
        updateAircraftFilterCounts();
    }

    // FIX 4: Same category logic for direct (non-interpolated) render
    function renderAircraft() {
        if (!viewer || !billboardCollection) return;
        billboardCollection.removeAll();
        labelCollection.removeAll();

        // Reset counts
        Object.keys(categoryCounts).forEach(k => { categoryCounts[k] = 0; });

        aircraftData.forEach(state => {
            const icao24 = state[0];
            const callsign = state[1] ? state[1].trim() : '';
            const originCountry = state[2] || '';
            const longitude = state[5];
            const latitude = state[6];
            const baroAlt = state[7];
            const onGround = state[8];
            const velocity = state[9];
            const trueTrack = state[10];
            const verticalRate = state[11];
            const geoAlt = state[13];
            const category = state[17];

            if (longitude == null || latitude == null || onGround) return;

            // FIX 4: Style and filter
            const style = getAircraftStyle(callsign, category);

            if (categoryCounts.hasOwnProperty(style.filterCat)) {
                categoryCounts[style.filterCat]++;
            }

            if (!categoryVisibility[style.filterCat]) return;

            const altitude = geoAlt || baroAlt || 10000;
            const icon = getAircraftIcon(style.color, 32);
            const scale = style.isMilitary ? 0.7 : 0.5;
            const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;

            billboardCollection.add({
                position, image: icon,
                scale: scale, rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: 0,
                id: { type: 'aircraft', icao24, callsign, originCountry, altitude, velocity, trueTrack, verticalRate, isMilitary: style.isMilitary, category, filterCat: style.filterCat }
            });

            if (style.isMilitary && callsign) {
                labelCollection.add({
                    position, text: callsign,
                    font: '10px Share Tech Mono',
                    fillColor: Cesium.Color.fromCssColorString('#ff3344'),
                    outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: 0, scale: 1.0
                });
            }
        });

        updateAircraftFilterCounts();
    }

    // ── FIX 4: Aircraft filter panel wiring ─────────────────────────────
    function initAircraftFilterPanel() {
        const panel = document.getElementById('hud-aircraft-filters');
        if (!panel) return;

        panel.querySelectorAll('input[type="checkbox"][data-ac-cat]').forEach(checkbox => {
            checkbox.addEventListener('change', function () {
                const cat = this.getAttribute('data-ac-cat');
                if (cat && categoryVisibility.hasOwnProperty(cat)) {
                    categoryVisibility[cat] = this.checked;
                    renderAircraft();
                }
            });
        });
    }

    function updateAircraftFilterCounts() {
        Object.keys(categoryCounts).forEach(cat => {
            const el = document.getElementById('ac-count-' + cat);
            if (el) el.textContent = categoryCounts[cat];
        });
    }

    // ── FIX 2: Credit display in HUD ────────────────────────────────────
    function updateCreditDisplay() {
        const costEl = document.getElementById('opensky-credit-cost');
        if (costEl) costEl.textContent = lastCreditCost;
        const remainingEl = document.getElementById('opensky-credits-remaining');
        if (remainingEl) {
            remainingEl.textContent = rateLimitRemaining != null ? rateLimitRemaining : '--';
        }
        const usedEl = document.getElementById('opensky-credits-used');
        if (usedEl) usedEl.textContent = dailyCreditsUsed;
    }

    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
            const pickedObject = viewer.scene.pick(click.position);
            if (pickedObject && pickedObject.primitive && pickedObject.primitive.id) {
                const id = pickedObject.primitive.id;
                if (id.type === 'aircraft') { showAircraftPopup(id); }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showAircraftPopup(data) {
        const metric = WorldViewHUD.isMetric();
        let altStr = 'N/A';
        if (data.altitude != null) {
            if (metric) { altStr = Math.round(data.altitude).toLocaleString() + ' m'; }
            else { altStr = Math.round(data.altitude * 3.28084).toLocaleString() + ' ft'; }
        }
        let speedStr = 'N/A';
        if (data.velocity != null) {
            if (metric) { speedStr = (data.velocity * 3.6).toFixed(0) + ' km/h'; }
            else {
                const knots = (data.velocity * 1.94384).toFixed(0);
                const mph = (data.velocity * 2.23694).toFixed(0);
                speedStr = knots + ' kts (' + mph + ' mph)';
            }
        }

        // FIX 4: Category label for popup
        const catLabels = {
            'military': 'MILITARY', 'high-perf': 'HIGH PERFORMANCE',
            'rotorcraft': 'ROTORCRAFT', 'uav': 'UAV/DRONE', 'civilian': 'CIVILIAN'
        };
        const catLabel = catLabels[data.filterCat] || (data.isMilitary ? 'MILITARY' : 'CIVILIAN');

        const rows = [
            { key: 'CALLSIGN', value: data.callsign || 'N/A', class: data.isMilitary ? 'danger' : 'highlight' },
            { key: 'ICAO24', value: data.icao24 || 'N/A' },
            { key: 'COUNTRY', value: data.originCountry || 'N/A' },
            { key: 'TYPE', value: catLabel, class: data.isMilitary ? 'danger' : '' },
            { key: 'ALTITUDE', value: altStr },
            { key: 'SPEED', value: speedStr },
            { key: 'HEADING', value: data.trueTrack != null ? data.trueTrack.toFixed(1) + '\u00B0' : 'N/A' },
            { key: 'VERT RATE', value: data.verticalRate != null ? data.verticalRate.toFixed(1) + ' m/s' : 'N/A', class: data.verticalRate > 0 ? 'highlight' : (data.verticalRate < 0 ? 'warning' : '') },
            { key: 'SOURCE', value: activeSource }
        ];
        const title = data.isMilitary ? '\u26A0 MILITARY AIRCRAFT' : '\u2708 AIRCRAFT';
        WorldViewHUD.showPopup(title, rows);
    }

    // ── FIX 2: Refresh controls ─────────────────────────────────────────
    function setupRefreshControls() {
        // Aircraft refresh interval selector
        const acSelect = document.getElementById('aircraft-refresh-select');
        if (acSelect) {
            // Restore saved state
            if (pollMode === 'manual' && userPollMs > 0) {
                acSelect.value = String(userPollMs);
            } else {
                acSelect.value = 'auto';
            }

            acSelect.addEventListener('change', function () {
                const val = this.value;
                if (val === 'auto') {
                    pollMode = 'auto';
                    userPollMs = 0;
                    localStorage.setItem(POLL_MODE_KEY, 'auto');
                    localStorage.removeItem(POLL_KEY);
                } else {
                    pollMode = 'manual';
                    userPollMs = parseInt(val, 10);
                    localStorage.setItem(POLL_MODE_KEY, 'manual');
                    localStorage.setItem(POLL_KEY, String(userPollMs));
                }
                restartPolling();
                console.log(`[Flights] Refresh interval changed: ${pollMode === 'auto' ? 'AUTO' : (userPollMs / 1000) + 's'}`);
            });
        }

        // Manual refresh button
        const refreshBtn = document.getElementById('aircraft-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                console.log('[Flights] Manual refresh triggered');
                fetchAircraft();
            });
        }
    }

    // ── Polling management ──────────────────────────────────────────────
    let currentPollMs = 10000;
    let adaptiveCheckInterval = null;

    function restartPolling() {
        if (pollInterval) clearInterval(pollInterval);
        currentPollMs = getEffectivePollMs();
        pollInterval = setInterval(fetchAircraft, currentPollMs);
        // Update HUD display
        const intervalEl = document.getElementById('aircraft-poll-interval');
        if (intervalEl) intervalEl.textContent = (currentPollMs / 1000) + 's';
        console.log(`[Flights] Poll interval set to ${currentPollMs / 1000}s`);
    }

    function startAdaptivePolling() {
        fetchAircraft();
        restartPolling();

        // In auto mode, re-check optimal interval every 5s
        adaptiveCheckInterval = setInterval(() => {
            if (pollMode !== 'auto') return;
            const desired = getAutoPollIntervalMs();
            if (desired !== currentPollMs) {
                console.log(`[Flights] Auto-adjusting poll: ${currentPollMs / 1000}s → ${desired / 1000}s`);
                restartPolling();
            }
        }, 5000);
    }

    // ── Init ────────────────────────────────────────────────────────────
    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Flights] Initializing aircraft tracking (waterfall + interpolation)...');
        console.log('[Flights] Scene primitives available:', !!viewer.scene.primitives);

        const cfg = getConfig();
        const hasOAuth = isConfigured('openskyClientId') && isConfigured('openskyClientSecret');
        console.log(`[Flights] OpenSky auth: ${hasOAuth ? 'YES (OAuth2)' : 'NO (anonymous)'}`);
        console.log(`[Flights] ADSB.fi: ${cfg.adsbfiEnabled !== false ? 'ENABLED (proxied)' : 'DISABLED'}`);
        console.log(`[Flights] ADS-B Exchange: ${isConfigured('adsbExchangeApiKey') ? 'CONFIGURED' : 'NOT CONFIGURED'}`);

        billboardCollection = new Cesium.BillboardCollection();
        viewer.scene.primitives.add(billboardCollection);
        labelCollection = new Cesium.LabelCollection();
        viewer.scene.primitives.add(labelCollection);

        setupClickHandler();
        initAircraftFilterPanel();
        setupRefreshControls();
        startAdaptivePolling();
        startInterpolationLoop();

        console.log('[Flights] Aircraft tracking started (adaptive polling + continuous interpolation).');
    }

    function setVisible(v) {
        visible = v;
        if (billboardCollection) billboardCollection.show = v;
        if (labelCollection) labelCollection.show = v;
        if (!v) { WorldViewHUD.updateCounter('aircraft', 0); }
        // Show/hide aircraft filter panel
        const panel = document.getElementById('hud-aircraft-filters');
        if (panel) {
            if (v) panel.classList.remove('hidden');
            else panel.classList.add('hidden');
        }
    }

    function destroy() {
        if (pollInterval) clearInterval(pollInterval);
        if (adaptiveCheckInterval) clearInterval(adaptiveCheckInterval);
        stopInterpolationLoop();
        if (billboardCollection) { viewer.scene.primitives.remove(billboardCollection); }
        if (labelCollection) { viewer.scene.primitives.remove(labelCollection); }
    }

    return { init, setVisible, destroy };
})();
