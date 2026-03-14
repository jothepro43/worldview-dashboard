/* ========================================
   WorldView - Aircraft Tracking
   Multi-API Waterfall: OpenSky → ADSB.fi → ADS-B Exchange
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

    // ── Rate-limiting state (OpenSky) ─────────────────────────────────────
    let requestsThisMinute = 0;
    let minuteStartTime = Date.now();
    let consecutiveFailures = 0;
    let backoffUntil = 0;
    let isRateLimited = false;

    // ── Interpolation state ─────────────────────────────────────────────
    let aircraftPositions = new Map();
    let interpolationFrameId = null;
    let lastInterpolationTime = 0;
    let isInterpolating = false;

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

    let civilianIcon = null;
    let militaryIcon = null;

    function checkRateLimit() {
        const now = Date.now();
        if (now - minuteStartTime >= 60000) {
            requestsThisMinute = 0;
            minuteStartTime = now;
        }
        return requestsThisMinute >= 8;
    }

    function recordRequest() { requestsThisMinute++; }

    function getBackoffDelay() {
        const remaining = backoffUntil - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    function applyBackoff() {
        const BASE = 10000;
        const MAX = 80000;
        consecutiveFailures++;
        const delay = Math.min(BASE * Math.pow(2, consecutiveFailures - 1), MAX);
        backoffUntil = Date.now() + delay;
        console.warn(`[Flights] Backoff: waiting ${delay / 1000}s (failure #${consecutiveFailures})`);
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

    function getPollIntervalMs() {
        const alt = getCameraAltitude();
        return (alt != null && alt < 3000000) ? 10000 : 30000;
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

    async function fetchFromOpenSky() {
        const url = buildOpenSkyUrl();
        console.log('[Flights] OpenSky request:', url);
        const headers = {};
        if (isConfigured('openskyUsername') && isConfigured('openskyPassword')) {
            const cfg = getConfig();
            headers['Authorization'] = 'Basic ' + btoa(cfg.openskyUsername + ':' + cfg.openskyPassword);
        }
        recordRequest();
        const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: headers });
        if (response.status === 429) {
            console.warn('[Flights] OpenSky 429 \u2014 rate limited');
            applyBackoff();
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
        const authLabel = (isConfigured('openskyUsername') && isConfigured('openskyPassword'))
            ? 'OpenSky (Auth)' : 'OpenSky (Anon)';
        console.log(`[Flights] ${authLabel}: ${data.states.length} aircraft`);
        return { states: data.states, source: authLabel };
    }

    async function fetchFromADSBfi() {
        const cfg = getConfig();
        if (cfg.adsbfiEnabled === false) {
            console.log('[Flights] ADSB.fi disabled in config');
            return null;
        }
        try {
            const bbox = getViewportBbox();
            let url;
            if (bbox) {
                url = `https://api.adsb.fi/v1/flights?bounds=${bbox.south.toFixed(4)},${bbox.north.toFixed(4)},${bbox.west.toFixed(4)},${bbox.east.toFixed(4)}`;
            } else {
                const center = getCameraCenter();
                url = `https://api.adsb.fi/v1/flights?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}&radius=500`;
            }
            console.log('[Flights] ADSB.fi request:', url);
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
                row[17] = null;
                return row;
            });
    }

    async function fetchAircraft() {
        if (!visible) return;
        const backoffRemaining = getBackoffDelay();
        if (backoffRemaining > 0) {
            console.log(`[Flights] In backoff, skipping OpenSky. Retry in ${Math.ceil(backoffRemaining / 1000)}s.`);
            const fallbackResult = await tryFallbacks();
            if (fallbackResult) { applyResult(fallbackResult); }
            else { setFlightSource('Interpolating'); isInterpolating = true; }
            return;
        }
        if (checkRateLimit()) {
            if (!isRateLimited) {
                isRateLimited = true;
                console.warn('[Flights] Rate limit reached (8 req/min). Trying fallbacks.');
            }
            const fallbackResult = await tryFallbacks();
            if (fallbackResult) { applyResult(fallbackResult); }
            else { setFlightSource('Interpolating'); isInterpolating = true; }
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
                isInterpolating = false;
                applyResult(openskyResult);
                return;
            }
            console.log('[Flights] OpenSky failed, trying fallbacks...');
            applyBackoff();
            const fallbackResult = await tryFallbacks();
            if (fallbackResult) {
                isInterpolating = false;
                applyResult(fallbackResult);
                return;
            }
            console.warn('[Flights] All sources failed. Interpolating existing data.');
            setFlightSource('Interpolating');
            isInterpolating = true;
        } catch (err) {
            console.error('[Flights] Error in fetch waterfall:', err);
            applyBackoff();
            setFlightSource('Interpolating');
            isInterpolating = true;
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

    function renderAircraftInterpolated() {
        if (!viewer || !billboardCollection) return;
        billboardCollection.removeAll();
        labelCollection.removeAll();
        const now = Date.now();
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
            const dtSeconds = (now - rec.timestamp) / 1000;
            const interp = interpolatePosition(rec, dtSeconds);
            const altitude = interp.alt;
            const mil = isMilitary(callsign, category);
            const icon = mil ? militaryIcon : civilianIcon;
            const position = Cesium.Cartesian3.fromDegrees(interp.lon, interp.lat, altitude);
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;
            billboardCollection.add({
                position, image: icon,
                scale: mil ? 0.7 : 0.5, rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: 0,
                id: { type: 'aircraft', icao24, callsign, originCountry, altitude, velocity, trueTrack, verticalRate, isMilitary: mil }
            });
            if (mil && callsign) {
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
    }

    function renderAircraft() {
        if (!viewer || !billboardCollection) return;
        billboardCollection.removeAll();
        labelCollection.removeAll();
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
            const altitude = geoAlt || baroAlt || 10000;
            const mil = isMilitary(callsign, category);
            const icon = mil ? militaryIcon : civilianIcon;
            const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;
            billboardCollection.add({
                position, image: icon,
                scale: mil ? 0.7 : 0.5, rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: 0,
                id: { type: 'aircraft', icao24, callsign, originCountry, altitude, velocity, trueTrack, verticalRate, isMilitary: mil }
            });
            if (mil && callsign) {
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
        const rows = [
            { key: 'CALLSIGN', value: data.callsign || 'N/A', class: data.isMilitary ? 'danger' : 'highlight' },
            { key: 'ICAO24', value: data.icao24 || 'N/A' },
            { key: 'COUNTRY', value: data.originCountry || 'N/A' },
            { key: 'TYPE', value: data.isMilitary ? 'MILITARY' : 'CIVILIAN', class: data.isMilitary ? 'danger' : '' },
            { key: 'ALTITUDE', value: altStr },
            { key: 'SPEED', value: speedStr },
            { key: 'HEADING', value: data.trueTrack != null ? data.trueTrack.toFixed(1) + '\u00B0' : 'N/A' },
            { key: 'VERT RATE', value: data.verticalRate != null ? data.verticalRate.toFixed(1) + ' m/s' : 'N/A', class: data.verticalRate > 0 ? 'highlight' : (data.verticalRate < 0 ? 'warning' : '') },
            { key: 'SOURCE', value: activeSource }
        ];
        const title = data.isMilitary ? '\u26A0 MILITARY AIRCRAFT' : '\u2708 AIRCRAFT';
        WorldViewHUD.showPopup(title, rows);
    }

    let currentPollMs = 10000;

    function startAdaptivePolling() {
        function schedulePoll() {
            const desiredMs = getPollIntervalMs();
            if (desiredMs !== currentPollMs) {
                console.log(`[Flights] Poll interval changed: ${currentPollMs / 1000}s \u2192 ${desiredMs / 1000}s`);
                currentPollMs = desiredMs;
                if (pollInterval) clearInterval(pollInterval);
                pollInterval = setInterval(fetchAircraft, currentPollMs);
            }
        }
        fetchAircraft();
        pollInterval = setInterval(fetchAircraft, currentPollMs);
        setInterval(schedulePoll, 5000);
    }

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Flights] Initializing aircraft tracking (multi-API waterfall)...');
        console.log('[Flights] Scene primitives available:', !!viewer.scene.primitives);
        const cfg = getConfig();
        const hasAuth = isConfigured('openskyUsername') && isConfigured('openskyPassword');
        console.log(`[Flights] OpenSky auth: ${hasAuth ? 'YES (Basic Auth)' : 'NO (anonymous)'}`);
        console.log(`[Flights] ADSB.fi: ${cfg.adsbfiEnabled !== false ? 'ENABLED' : 'DISABLED'}`);
        console.log(`[Flights] ADS-B Exchange: ${isConfigured('adsbExchangeApiKey') ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
        civilianIcon = createAircraftIcon('#00d4ff', 32);
        militaryIcon = createAircraftIcon('#ff3344', 32);
        billboardCollection = new Cesium.BillboardCollection();
        viewer.scene.primitives.add(billboardCollection);
        labelCollection = new Cesium.LabelCollection();
        viewer.scene.primitives.add(labelCollection);
        setupClickHandler();
        startAdaptivePolling();
        startInterpolationLoop();
        console.log('[Flights] Aircraft tracking started (adaptive polling + interpolation).');
    }

    function setVisible(v) {
        visible = v;
        if (billboardCollection) billboardCollection.show = v;
        if (labelCollection) labelCollection.show = v;
        if (!v) { WorldViewHUD.updateCounter('aircraft', 0); }
    }

    function destroy() {
        if (pollInterval) clearInterval(pollInterval);
        stopInterpolationLoop();
        if (billboardCollection) { viewer.scene.primitives.remove(billboardCollection); }
        if (labelCollection) { viewer.scene.primitives.remove(labelCollection); }
    }

    return { init, setVisible, destroy };
})();
