/* ========================================
   WorldView - Aircraft Tracking (OpenSky Network)
   ======================================== */

const WorldViewFlights = (() => {
    'use strict';

    let viewer = null;
    let billboardCollection = null;
    let labelCollection = null;
    let aircraftData = [];
    let pollInterval = null;
    let visible = true;

    // ── Rate-limiting state ─────────────────────────────────────────────────
    let requestsThisMinute = 0;
    let minuteStartTime = Date.now();
    let consecutiveFailures = 0;
    let backoffUntil = 0;
    let isRateLimited = false;

    // ── Interpolation state ─────────────────────────────────────────────────
    // icao24 -> { lat, lon, alt, velocity, heading, timestamp }
    let aircraftPositions = new Map();
    let interpolationFrameId = null;
    let lastInterpolationTime = 0;

    // Military callsign prefixes
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

    // Create airplane icon as a data URL canvas
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

        // Aircraft shape (simplified top-down)
        ctx.beginPath();
        // Fuselage
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.15, -s * 0.4);
        // Right wing
        ctx.lineTo(s * 0.8, -s * 0.1);
        ctx.lineTo(s * 0.8, s * 0.1);
        ctx.lineTo(s * 0.15, 0);
        // Right tail
        ctx.lineTo(s * 0.35, s * 0.7);
        ctx.lineTo(s * 0.35, s * 0.85);
        ctx.lineTo(s * 0.1, s * 0.6);
        // Bottom
        ctx.lineTo(0, s * 0.7);
        // Left tail
        ctx.lineTo(-s * 0.1, s * 0.6);
        ctx.lineTo(-s * 0.35, s * 0.85);
        ctx.lineTo(-s * 0.35, s * 0.7);
        ctx.lineTo(-s * 0.15, 0);
        // Left wing
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

    // ── Rate-limit helpers ──────────────────────────────────────────────────

    /**
     * Refresh the per-minute request counter window and return whether
     * we are currently over the 8-requests-per-minute limit.
     */
    function checkRateLimit() {
        const now = Date.now();
        // Roll the window if a minute has passed
        if (now - minuteStartTime >= 60000) {
            requestsThisMinute = 0;
            minuteStartTime = now;
        }
        return requestsThisMinute >= 8;
    }

    function recordRequest() {
        requestsThisMinute++;
    }

    /**
     * Return the delay in ms we must still wait due to exponential backoff,
     * or 0 if we can proceed.
     */
    function getBackoffDelay() {
        const remaining = backoffUntil - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    function applyBackoff() {
        // Base 10 s, doubles each failure, max 80 s
        const BASE = 10000;
        const MAX = 80000;
        consecutiveFailures++;
        const delay = Math.min(BASE * Math.pow(2, consecutiveFailures - 1), MAX);
        backoffUntil = Date.now() + delay;
        console.warn(`[Flights] Backoff: waiting ${delay / 1000}s (failure #${consecutiveFailures})`);
    }

    function resetBackoff() {
        consecutiveFailures = 0;
        backoffUntil = 0;
    }

    // ── ADS-B Exchange fallback ─────────────────────────────────────────────

    async function fetchFromADSB() {
        try {
            let camPos = null;
            if (typeof WorldViewGlobe !== 'undefined' && WorldViewGlobe.getCameraPosition) {
                camPos = WorldViewGlobe.getCameraPosition();
            }
            const lat = (camPos && camPos.lat != null) ? camPos.lat : 0;
            const lon = (camPos && camPos.lon != null) ? camPos.lon : 0;

            const url = `/api/adsb?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&dist=250`;
            console.log('[Flights] Trying ADS-B Exchange fallback:', url);

            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) {
                console.warn('[Flights] ADS-B fallback returned status:', response.status);
                return null;
            }

            const data = await response.json();
            if (!data || !data.ac) {
                console.warn('[Flights] ADS-B fallback: no aircraft data.');
                return null;
            }

            // Normalise ADS-B Exchange format → OpenSky-like rows
            // OpenSky state vector indices used later:
            // [0]=icao24, [1]=callsign, [2]=originCountry, [5]=lon, [6]=lat,
            // [7]=baroAlt, [8]=onGround, [9]=velocity, [10]=trueTrack,
            // [11]=verticalRate, [13]=geoAlt, [17]=category
            const states = data.ac
                .filter(ac => ac.lat != null && ac.lon != null)
                .map(ac => {
                    const altMeters = (ac.alt_baro != null && ac.alt_baro !== 'ground')
                        ? parseFloat(ac.alt_baro) * 0.3048
                        : null;
                    const velocityMS = ac.gs != null ? parseFloat(ac.gs) * 0.514444 : null;
                    const vertRateMS = ac.baro_rate != null ? parseFloat(ac.baro_rate) / 196.85 : null;
                    const onGround = ac.alt_baro === 'ground';

                    // Build a sparse array matching OpenSky indices
                    const row = new Array(18).fill(null);
                    row[0] = ac.hex || '';
                    row[1] = ac.flight ? ac.flight.trim() : '';
                    row[2] = '';        // no country from ADS-B Exchange
                    row[5] = parseFloat(ac.lon);
                    row[6] = parseFloat(ac.lat);
                    row[7] = altMeters;
                    row[8] = onGround;
                    row[9] = velocityMS;
                    row[10] = ac.track != null ? parseFloat(ac.track) : null;
                    row[11] = vertRateMS;
                    row[13] = altMeters; // use baro alt as geo alt too
                    row[17] = null;
                    return row;
                });

            console.log(`[Flights] ADS-B fallback: ${states.length} aircraft received.`);
            return states;
        } catch (err) {
            console.error('[Flights] ADS-B fallback error:', err);
            return null;
        }
    }

    // ── Viewport helpers ────────────────────────────────────────────────────

    function buildOpenSkyUrl() {
        let bbox = null;
        let useGlobal = true;

        try {
            if (typeof WorldViewGlobe !== 'undefined') {
                const camPos = WorldViewGlobe.getCameraPosition ? WorldViewGlobe.getCameraPosition() : null;
                const alt = camPos ? camPos.alt : Infinity;

                if (alt != null && alt < 5000000) {
                    bbox = WorldViewGlobe.getViewportBounds ? WorldViewGlobe.getViewportBounds() : null;
                    if (bbox) useGlobal = false;
                }
            }
        } catch (e) {
            // Fall back to global if anything goes wrong
        }

        if (useGlobal || !bbox) {
            return '/api/opensky';
        }

        const { south, north, west, east } = bbox;
        return `/api/opensky?lamin=${south.toFixed(4)}&lomin=${west.toFixed(4)}&lamax=${north.toFixed(4)}&lomax=${east.toFixed(4)}`;
    }

    // ── Main fetch ──────────────────────────────────────────────────────────

    async function fetchAircraft() {
        if (!visible) return;

        // Check backoff
        const backoffRemaining = getBackoffDelay();
        if (backoffRemaining > 0) {
            console.log(`[Flights] In backoff, skipping fetch. Retry in ${Math.ceil(backoffRemaining / 1000)}s.`);
            return;
        }

        // Check rate limit
        if (checkRateLimit()) {
            if (!isRateLimited) {
                isRateLimited = true;
                console.warn('[Flights] Rate limit reached (8 req/min). Skipping fetch.');
                if (typeof WorldViewHUD !== 'undefined' && WorldViewHUD.setStatus) {
                    WorldViewHUD.setStatus('RATE LIMITED');
                }
            }
            return;
        }

        try {
            const url = buildOpenSkyUrl();
            let response;

            recordRequest();

            try {
                response = await fetch(url, { signal: AbortSignal.timeout(8000) });
            } catch {
                // Proxy unreachable – try direct OpenSky
                const directUrl = 'https://opensky-network.org/api/states/all';
                response = await fetch(directUrl, { signal: AbortSignal.timeout(15000) });
                recordRequest();
            }

            // Handle 429 → exponential backoff + try ADS-B
            if (response.status === 429) {
                console.warn('[Flights] OpenSky 429 Too Many Requests. Applying backoff.');
                applyBackoff();
                isRateLimited = true;
                if (typeof WorldViewHUD !== 'undefined' && WorldViewHUD.setStatus) {
                    WorldViewHUD.setStatus('RATE LIMITED');
                }
                // Try ADS-B Exchange fallback
                const fallbackStates = await fetchFromADSB();
                if (fallbackStates && fallbackStates.length > 0) {
                    aircraftData = fallbackStates;
                    updatePositionStore(fallbackStates);
                    renderAircraft();
                    const count = fallbackStates.filter(s => s[6] != null && s[5] != null && !s[8]).length;
                    WorldViewHUD.updateCounter('aircraft', count);
                }
                return;
            }

            if (!response.ok) {
                console.warn('[Flights] API returned status:', response.status);
                applyBackoff();
                // Try ADS-B Exchange fallback
                const fallbackStates = await fetchFromADSB();
                if (fallbackStates && fallbackStates.length > 0) {
                    aircraftData = fallbackStates;
                    updatePositionStore(fallbackStates);
                    renderAircraft();
                    const count = fallbackStates.filter(s => s[6] != null && s[5] != null && !s[8]).length;
                    WorldViewHUD.updateCounter('aircraft', count);
                }
                return;
            }

            const data = await response.json();
            if (!data || !data.states) {
                console.warn('[Flights] No aircraft data received – trying ADS-B fallback.');
                const fallbackStates = await fetchFromADSB();
                if (fallbackStates && fallbackStates.length > 0) {
                    aircraftData = fallbackStates;
                    updatePositionStore(fallbackStates);
                    renderAircraft();
                    const count = fallbackStates.filter(s => s[6] != null && s[5] != null && !s[8]).length;
                    WorldViewHUD.updateCounter('aircraft', count);
                }
                return;
            }

            // Success
            resetBackoff();
            if (isRateLimited) {
                isRateLimited = false;
                console.log('[Flights] Rate limit recovered.');
                if (typeof WorldViewHUD !== 'undefined' && WorldViewHUD.setStatus) {
                    WorldViewHUD.setStatus('ONLINE');
                }
            }

            aircraftData = data.states;
            updatePositionStore(data.states);
            renderAircraft();

            const count = aircraftData.filter(s => s[6] != null && s[5] != null && !s[8]).length;
            WorldViewHUD.updateCounter('aircraft', count);
            console.log(`[Flights] Updated: ${count} airborne aircraft.`);

        } catch (err) {
            console.error('[Flights] Error fetching aircraft data:', err);
            applyBackoff();
            // Try ADS-B Exchange fallback
            const fallbackStates = await fetchFromADSB();
            if (fallbackStates && fallbackStates.length > 0) {
                aircraftData = fallbackStates;
                updatePositionStore(fallbackStates);
                renderAircraft();
                const count = fallbackStates.filter(s => s[6] != null && s[5] != null && !s[8]).length;
                WorldViewHUD.updateCounter('aircraft', count);
            }
        }
    }

    // ── Position interpolation ──────────────────────────────────────────────

    /**
     * Store (or update) each aircraft's position info for interpolation.
     */
    function updatePositionStore(states) {
        const now = Date.now();
        states.forEach(state => {
            const icao24 = state[0];
            const lon = state[5];
            const lat = state[6];
            const alt = state[13] || state[7] || 10000;
            const velocity = state[9];  // m/s
            const heading = state[10]; // degrees true
            if (icao24 == null || lon == null || lat == null) return;

            aircraftPositions.set(icao24, {
                lat,
                lon,
                alt,
                velocity: velocity || 0,
                heading: heading || 0,
                timestamp: now
            });
        });
    }

    /**
     * Given a stored position record, advance it by dt seconds using
     * dead-reckoning from velocity + heading.
     */
    function interpolatePosition(rec, dtSeconds) {
        if (!rec || rec.velocity <= 0 || dtSeconds <= 0) {
            return { lat: rec.lat, lon: rec.lon, alt: rec.alt };
        }
        const headingRad = rec.heading * Math.PI / 180;
        const v = rec.velocity; // m/s
        const dt = dtSeconds;

        const dx = v * Math.sin(headingRad) * dt; // metres east
        const dy = v * Math.cos(headingRad) * dt; // metres north

        const latRad = rec.lat * Math.PI / 180;
        const newLat = rec.lat + (dy / 110540);
        const newLon = rec.lon + (dx / (111320 * Math.cos(latRad)));

        return { lat: newLat, lon: newLon, alt: rec.alt };
    }

    /**
     * Animation loop: re-render billboards every ~1 second using
     * interpolated positions, without hitting the network.
     */
    function startInterpolationLoop() {
        if (interpolationFrameId !== null) return; // already running

        function loop() {
            interpolationFrameId = requestAnimationFrame(loop);

            const now = Date.now();
            if (now - lastInterpolationTime < 1000) return; // 1-second throttle
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

    /**
     * Re-render using dead-reckoned positions (called every ~1s by the loop).
     */
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

            // Get stored position (may have been updated by fresh data)
            const rec = aircraftPositions.get(icao24);
            if (!rec || rec.lat == null || rec.lon == null) return;

            // Interpolate forward from stored timestamp
            const dtSeconds = (now - rec.timestamp) / 1000;
            const interp = interpolatePosition(rec, dtSeconds);

            const altitude = interp.alt;
            const mil = isMilitary(callsign, category);
            const icon = mil ? militaryIcon : civilianIcon;

            const position = Cesium.Cartesian3.fromDegrees(interp.lon, interp.lat, altitude);
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;

            billboardCollection.add({
                position,
                image: icon,
                scale: mil ? 0.7 : 0.5,
                rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: 0,
                id: {
                    type: 'aircraft',
                    icao24,
                    callsign,
                    originCountry,
                    altitude,
                    velocity,
                    trueTrack,
                    verticalRate,
                    isMilitary: mil
                }
            });

            if (mil && callsign) {
                labelCollection.add({
                    position,
                    text: callsign,
                    font: '10px Share Tech Mono',
                    fillColor: Cesium.Color.fromCssColorString('#ff3344'),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: 0,
                    scale: 1.0
                });
            }
        });
    }

    // ── Initial render (snaps to real positions on new data) ────────────────

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

            // Skip aircraft without position or on ground
            if (longitude == null || latitude == null || onGround) return;

            const altitude = geoAlt || baroAlt || 10000;
            const mil = isMilitary(callsign, category);
            const icon = mil ? militaryIcon : civilianIcon;

            const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);

            // Rotation based on heading
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;

            billboardCollection.add({
                position,
                image: icon,
                scale: mil ? 0.7 : 0.5,
                rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: 0,
                id: {
                    type: 'aircraft',
                    icao24,
                    callsign,
                    originCountry,
                    altitude,
                    velocity,
                    trueTrack,
                    verticalRate,
                    isMilitary: mil
                }
            });

            // Show labels for military aircraft
            if (mil && callsign) {
                labelCollection.add({
                    position,
                    text: callsign,
                    font: '10px Share Tech Mono',
                    fillColor: Cesium.Color.fromCssColorString('#ff3344'),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: 0,
                    scale: 1.0
                });
            }
        });
    }

    // ── Click handler / popup ───────────────────────────────────────────────

    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
            const pickedObject = viewer.scene.pick(click.position);
            if (pickedObject && pickedObject.primitive && pickedObject.primitive.id) {
                const id = pickedObject.primitive.id;
                if (id.type === 'aircraft') {
                    showAircraftPopup(id);
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showAircraftPopup(data) {
        // FIX 3: Respect unit preference from HUD
        const metric = WorldViewHUD.isMetric();

        let altStr = 'N/A';
        if (data.altitude != null) {
            if (metric) {
                altStr = Math.round(data.altitude).toLocaleString() + ' m';
            } else {
                const altFt = Math.round(data.altitude * 3.28084);
                altStr = altFt.toLocaleString() + ' ft';
            }
        }

        let speedStr = 'N/A';
        if (data.velocity != null) {
            if (metric) {
                speedStr = (data.velocity * 3.6).toFixed(0) + ' km/h';
            } else {
                // Convert m/s to knots (1 m/s = 1.94384 kts) and mph (1 m/s = 2.23694 mph)
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
            { key: 'HEADING', value: data.trueTrack != null ? data.trueTrack.toFixed(1) + '°' : 'N/A' },
            { key: 'VERT RATE', value: data.verticalRate != null ? data.verticalRate.toFixed(1) + ' m/s' : 'N/A', class: data.verticalRate > 0 ? 'highlight' : (data.verticalRate < 0 ? 'warning' : '') }
        ];

        const title = data.isMilitary ? '⚠ MILITARY AIRCRAFT' : '✈ AIRCRAFT';
        WorldViewHUD.showPopup(title, rows);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Flights] Initializing aircraft tracking...');
        console.log('[Flights] Scene primitives available:', !!viewer.scene.primitives);

        // Pre-create icons
        civilianIcon = createAircraftIcon('#00d4ff', 32);
        militaryIcon = createAircraftIcon('#ff3344', 32);

        // Create billboard and label collections for performance
        billboardCollection = new Cesium.BillboardCollection();
        viewer.scene.primitives.add(billboardCollection);

        labelCollection = new Cesium.LabelCollection();
        viewer.scene.primitives.add(labelCollection);

        // Setup click handler
        setupClickHandler();

        // Start polling
        fetchAircraft();
        pollInterval = setInterval(fetchAircraft, 10000);

        // Start interpolation animation loop
        startInterpolationLoop();

        console.log('[Flights] Aircraft tracking started (10s polling + interpolation).');
    }

    function setVisible(v) {
        visible = v;
        if (billboardCollection) billboardCollection.show = v;
        if (labelCollection) labelCollection.show = v;
        if (!v) {
            WorldViewHUD.updateCounter('aircraft', 0);
        }
    }

    function destroy() {
        if (pollInterval) clearInterval(pollInterval);
        stopInterpolationLoop();
        if (billboardCollection) {
            viewer.scene.primitives.remove(billboardCollection);
        }
        if (labelCollection) {
            viewer.scene.primitives.remove(labelCollection);
        }
    }

    return { init, setVisible, destroy };
})();