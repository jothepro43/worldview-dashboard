/* ========================================
   WorldView - Satellite Tracking
   TLE data + satellite.js orbital computation
   ======================================== */

const WorldViewSatellites = (() => {
    'use strict';

    let viewer = null;
    let pointCollection = null;
    let orbitEntities = [];
    let satelliteRecords = []; // { name, satrec, group, noradId, category, color (rgb array), satColor (Cesium.Color), pixelSize }
    let animationFrameId = null;
    let visible = true;
    let selectedSatellite = null;

    // FIX 6: Category visibility and counts
    const categoryVisibility = {
        military: true,
        starlink: true,
        gps: true,
        imaging: true,
        iss: true,
        debris: true,
        commercial: true
    };

    const categoryCounts = {
        military: 0,
        starlink: 0,
        gps: 0,
        imaging: 0,
        iss: 0,
        debris: 0,
        commercial: 0
    };

    // TLE data sources — FIX 3: use CelesTrak GP format which is more reliable
    const TLE_SOURCES = [
        { url: '/api/tle/stations', direct: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle', group: 'station', color: [0, 255, 200] },
        { url: '/api/tle/gps-ops', direct: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle', group: 'gps', color: [100, 200, 255] },
        { url: '/api/tle/starlink', direct: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle', group: 'starlink', color: [180, 180, 255] },
        { url: '/api/tle/active', direct: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle', group: 'active', color: [0, 255, 136] }
    ];

    // Limit for performance
    const MAX_SATELLITES_PER_GROUP = {
        station: 100,
        gps: 50,
        starlink: 500,
        active: 2000
    };

    // =============================================
    // FIX 5: Satellite Classification
    // =============================================

    /**
     * Classify a satellite by name and group.
     * Returns { category, color (Cesium.Color), pixelSize }
     */
    function classifySatellite(name, group) {
        const n = (name || '').toUpperCase();

        // ISS — check first so it overrides other matches
        if (n === 'ISS (ZARYA)' || n.includes('ISS')) {
            return {
                category: 'iss',
                color: Cesium.Color.WHITE,
                pixelSize: 10
            };
        }

        // Debris / rocket bodies
        if (n.includes('DEB') || n.includes('R/B') || n.includes('DEBRIS')) {
            return {
                category: 'debris',
                color: Cesium.Color.fromCssColorString('#888888'),
                pixelSize: 4
            };
        }

        // Starlink
        if (n.includes('STARLINK')) {
            return {
                category: 'starlink',
                color: Cesium.Color.fromCssColorString('#bb44ff'),
                pixelSize: 6
            };
        }

        // GPS
        if (n.includes('GPS') || n.includes('NAVSTAR') || group === 'gps') {
            return {
                category: 'gps',
                color: Cesium.Color.fromCssColorString('#ffdd00'),
                pixelSize: 6
            };
        }

        // Military
        const militaryKeywords = [
            'USA-', 'NROL', 'LACROSSE', 'MENTOR', 'ORION', 'TRUMPET', 'VORTEX',
            'MAGNUM', 'KEYHOLE', 'MISTY', 'NOSS', 'SDS', 'MILSTAR', 'AEHF', 'WGS',
            'SBIRS', 'DSP', 'MUOS', 'GSSAP', 'NEMESIS', 'COSMOS'
        ];
        for (const kw of militaryKeywords) {
            if (n.includes(kw)) {
                return {
                    category: 'military',
                    color: Cesium.Color.fromCssColorString('#ff3344'),
                    pixelSize: 6
                };
            }
        }

        // Imaging / Earth Observation
        const imagingKeywords = [
            'LANDSAT', 'SENTINEL', 'WORLDVIEW', 'PLEIADES', 'SPOT', 'KOMPSAT',
            'RADARSAT', 'TERRA', 'AQUA', 'SUOMI', 'JPSS', 'NOAA', 'GOES',
            'HIMAWARI', 'METEOSAT'
        ];
        for (const kw of imagingKeywords) {
            if (n.includes(kw)) {
                return {
                    category: 'imaging',
                    color: Cesium.Color.fromCssColorString('#ff8800'),
                    pixelSize: 6
                };
            }
        }

        // Commercial / Other (default)
        return {
            category: 'commercial',
            color: Cesium.Color.fromCssColorString('#00ddff'),
            pixelSize: 6
        };
    }

    // =============================================
    // FIX 6: Filter Panel Wiring
    // =============================================

    function initFilterPanel() {
        // Wire up checkbox change events
        const panel = document.getElementById('hud-sat-filters');
        if (!panel) return;

        panel.querySelectorAll('input[type="checkbox"][data-sat-cat]').forEach(checkbox => {
            checkbox.addEventListener('change', function () {
                const cat = this.getAttribute('data-sat-cat');
                if (cat && categoryVisibility.hasOwnProperty(cat)) {
                    categoryVisibility[cat] = this.checked;
                    // Re-render immediately
                    updatePositions();
                }
            });
        });
    }

    function updateCategoryCountDisplay() {
        Object.keys(categoryCounts).forEach(cat => {
            const el = document.getElementById('sat-count-' + cat);
            if (el) el.textContent = categoryCounts[cat];
        });
    }

    function resetCategoryCounts() {
        Object.keys(categoryCounts).forEach(k => { categoryCounts[k] = 0; });
    }

    function showFilterPanel() {
        const panel = document.getElementById('hud-sat-filters');
        if (panel) panel.classList.remove('hidden');
    }

    function hideFilterPanel() {
        const panel = document.getElementById('hud-sat-filters');
        if (panel) panel.classList.add('hidden');
    }

    // =============================================
    // Core init
    // =============================================

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Satellites] Initializing satellite tracking...');
        console.log('[Satellites] satellite.js available:', typeof satellite !== 'undefined');

        if (typeof satellite === 'undefined') {
            console.error('[Satellites] CRITICAL: satellite.js library not loaded! Satellite tracking disabled.');
            return;
        }

        pointCollection = new Cesium.PointPrimitiveCollection();
        viewer.scene.primitives.add(pointCollection);

        // Setup click handler
        setupClickHandler();

        // FIX 6: Initialize filter panel checkboxes
        initFilterPanel();

        // Fetch TLE data
        fetchAllTLEs();

        console.log('[Satellites] Satellite tracking initialized.');
    }

    async function fetchAllTLEs() {
        let totalLoaded = 0;

        // Reset category counts before loading
        resetCategoryCounts();

        for (const source of TLE_SOURCES) {
            try {
                console.log(`[Satellites] Fetching TLE: ${source.group} from ${source.url}...`);
                let response;
                let usedDirect = false;

                try {
                    response = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
                    if (!response.ok) {
                        throw new Error(`Proxy returned ${response.status}`);
                    }
                    console.log(`[Satellites] Proxy response for ${source.group}: ${response.status}`);
                } catch (proxyErr) {
                    console.log(`[Satellites] Proxy failed for ${source.group} (${proxyErr.message}), trying direct...`);
                    usedDirect = true;
                    try {
                        response = await fetch(source.direct, { signal: AbortSignal.timeout(20000) });
                        console.log(`[Satellites] Direct response for ${source.group}: ${response.status}`);
                    } catch (directErr) {
                        console.error(`[Satellites] Direct also failed for ${source.group}:`, directErr.message);
                        continue;
                    }
                }

                if (!response || !response.ok) {
                    console.warn(`[Satellites] Failed to fetch ${source.group}: ${response ? response.status : 'no response'}`);
                    continue;
                }

                const text = await response.text();
                console.log(`[Satellites] ${source.group} raw data length: ${text.length} chars (${usedDirect ? 'direct' : 'proxy'})`);

                if (text.length < 50) {
                    console.warn(`[Satellites] ${source.group} data too short, skipping.`);
                    continue;
                }

                const records = parseTLE(text, source.group, source.color);
                const limit = MAX_SATELLITES_PER_GROUP[source.group] || 500;
                const limited = records.slice(0, limit);
                satelliteRecords.push(...limited);
                totalLoaded += limited.length;

                // Tally category counts
                limited.forEach(rec => {
                    if (categoryCounts.hasOwnProperty(rec.category)) {
                        categoryCounts[rec.category]++;
                    }
                });

                console.log(`[Satellites] Loaded ${limited.length} from ${source.group} (${records.length} total available).`);
                WorldViewHUD.updateCounter('satellites', totalLoaded);
            } catch (err) {
                console.error(`[Satellites] Error fetching ${source.group}:`, err);
            }
        }

        console.log(`[Satellites] Total satellites loaded: ${satelliteRecords.length}`);

        if (satelliteRecords.length === 0) {
            console.warn('[Satellites] WARNING: No satellites loaded from any source!');
        }

        // Update filter panel counts
        updateCategoryCountDisplay();

        // Start animation loop
        startUpdateLoop();
    }

    function parseTLE(text, group, color) {
        const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const records = [];

        for (let i = 0; i < lines.length - 2; i++) {
            // TLE format: Name line, then Line 1 (starts with '1'), then Line 2 (starts with '2')
            if (lines[i + 1] && lines[i + 1].startsWith('1 ') && lines[i + 2] && lines[i + 2].startsWith('2 ')) {
                const name = lines[i].trim();
                const tleLine1 = lines[i + 1];
                const tleLine2 = lines[i + 2];

                try {
                    const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
                    if (satrec) {
                        const noradId = tleLine1.substring(2, 7).trim();

                        // FIX 5: Classify satellite by name and group
                        const classification = classifySatellite(name, group);

                        records.push({
                            name: name,
                            satrec: satrec,
                            group: group,
                            noradId: noradId,
                            color: color,           // original rgb array (kept for orbit line color)
                            category: classification.category,
                            satColor: classification.color,
                            pixelSize: classification.pixelSize,
                            tleLine1: tleLine1,
                            tleLine2: tleLine2
                        });
                    }
                } catch (e) {
                    // Skip invalid TLEs
                }
                i += 2; // Skip the TLE lines
            }
        }

        return records;
    }

    function computePosition(satrec, date) {
        try {
            const positionAndVelocity = satellite.propagate(satrec, date);
            const positionEci = positionAndVelocity.position;
            const velocityEci = positionAndVelocity.velocity;

            if (!positionEci || typeof positionEci === 'boolean') return null;

            const gmst = satellite.gstime(date);
            const positionGd = satellite.eciToGeodetic(positionEci, gmst);

            const longitude = satellite.degreesLong(positionGd.longitude);
            const latitude = satellite.degreesLat(positionGd.latitude);
            const altitude = positionGd.height * 1000; // km to m

            // Compute velocity magnitude in km/s
            let speed = 0;
            if (velocityEci && typeof velocityEci !== 'boolean') {
                speed = Math.sqrt(
                    velocityEci.x * velocityEci.x +
                    velocityEci.y * velocityEci.y +
                    velocityEci.z * velocityEci.z
                );
            }

            return { longitude, latitude, altitude, speed };
        } catch (e) {
            return null;
        }
    }

    function updatePositions() {
        if (!visible || !pointCollection) return;

        pointCollection.removeAll();
        const now = new Date();

        satelliteRecords.forEach((rec, index) => {
            // FIX 6: Skip satellites whose category is hidden
            if (!categoryVisibility[rec.category]) return;

            const pos = computePosition(rec.satrec, now);
            if (!pos || isNaN(pos.latitude) || isNaN(pos.longitude)) return;

            // Clamp altitude
            const alt = Math.max(pos.altitude, 100000); // At least 100km

            const position = Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, alt);

            // FIX 5: Use classified color and pixel size
            const color = rec.satColor || Cesium.Color.fromCssColorString('#00ddff');
            const pixelSize = rec.pixelSize || 5;

            // FIX 2: disableDepthTestDistance: 0 so satellites behind Earth are hidden
            pointCollection.add({
                position: position,
                pixelSize: pixelSize,
                color: color,
                outlineColor: color.withAlpha(0.3),
                outlineWidth: 1,
                disableDepthTestDistance: 0,
                id: {
                    type: 'satellite',
                    index: index,
                    name: rec.name,
                    noradId: rec.noradId,
                    group: rec.group,
                    category: rec.category,
                    altitude: alt / 1000, // back to km
                    speed: pos.speed,
                    inclination: rec.satrec.inclo ? Cesium.Math.toDegrees(rec.satrec.inclo) : null
                }
            });
        });
    }

    function startUpdateLoop() {
        let lastUpdate = 0;
        const UPDATE_INTERVAL_MS = 1000; // Update every 1 second

        function animate(timestamp) {
            if (timestamp - lastUpdate >= UPDATE_INTERVAL_MS) {
                updatePositions();
                lastUpdate = timestamp;
            }
            animationFrameId = requestAnimationFrame(animate);
        }

        animationFrameId = requestAnimationFrame(animate);
    }

    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
            const pickedObject = viewer.scene.pick(click.position);
            if (pickedObject && pickedObject.primitive && pickedObject.primitive.id) {
                const id = pickedObject.primitive.id;
                if (id.type === 'satellite') {
                    showSatellitePopup(id);
                    drawOrbit(id.index);
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showSatellitePopup(data) {
        // Compute orbital period from mean motion
        const rec = satelliteRecords[data.index];
        let period = 'N/A';
        if (rec && rec.satrec.no) {
            // Mean motion is in radians per minute
            const meanMotionRevPerDay = rec.satrec.no * 1440 / (2 * Math.PI);
            if (meanMotionRevPerDay > 0) {
                period = (1440 / meanMotionRevPerDay).toFixed(1) + ' min';
            }
        }

        const rows = [
            { key: 'NAME', value: data.name || 'Unknown', class: 'highlight' },
            { key: 'NORAD ID', value: data.noradId || 'N/A' },
            { key: 'GROUP', value: data.group ? data.group.toUpperCase() : 'N/A' },
            { key: 'TYPE', value: data.category ? data.category.toUpperCase() : 'N/A' },
            { key: 'ALTITUDE', value: data.altitude ? data.altitude.toFixed(1) + ' km' : 'N/A' },
            { key: 'VELOCITY', value: data.speed ? data.speed.toFixed(2) + ' km/s' : 'N/A' },
            { key: 'PERIOD', value: period },
            { key: 'INCLINATION', value: data.inclination != null ? data.inclination.toFixed(2) + '°' : 'N/A' }
        ];

        WorldViewHUD.showPopup('◉ SATELLITE', rows);
    }

    function drawOrbit(index) {
        // Remove previous orbit
        clearOrbit();

        const rec = satelliteRecords[index];
        if (!rec) return;

        selectedSatellite = index;

        // Compute orbit path (one full period)
        const now = new Date();
        const positions = [];
        const meanMotionRevPerDay = rec.satrec.no * 1440 / (2 * Math.PI);
        const periodMinutes = meanMotionRevPerDay > 0 ? 1440 / meanMotionRevPerDay : 90;
        const steps = 180;
        const stepMs = (periodMinutes * 60 * 1000) / steps;

        for (let i = 0; i <= steps; i++) {
            const time = new Date(now.getTime() + i * stepMs);
            const pos = computePosition(rec.satrec, time);
            if (pos && !isNaN(pos.latitude) && !isNaN(pos.longitude)) {
                positions.push(pos.longitude, pos.latitude, Math.max(pos.altitude, 100000));
            }
        }

        if (positions.length >= 6) {
            // Use the satellite's classified color for the orbit line
            const orbitColor = rec.satColor
                ? rec.satColor.withAlpha(0.6)
                : Cesium.Color.fromBytes(rec.color[0], rec.color[1], rec.color[2], 150);

            const entity = viewer.entities.add({
                polyline: {
                    positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
                    width: 1.5,
                    material: new Cesium.ColorMaterialProperty(orbitColor),
                    arcType: Cesium.ArcType.NONE
                }
            });
            orbitEntities.push(entity);
        }
    }

    function clearOrbit() {
        orbitEntities.forEach(e => viewer.entities.remove(e));
        orbitEntities = [];
        selectedSatellite = null;
    }

    function setVisible(v) {
        visible = v;
        if (pointCollection) pointCollection.show = v;
        orbitEntities.forEach(e => e.show = v);

        // FIX 6: Show/hide filter panel based on satellite layer visibility
        if (v) {
            showFilterPanel();
            WorldViewHUD.updateCounter('satellites', satelliteRecords.length);
        } else {
            hideFilterPanel();
            WorldViewHUD.updateCounter('satellites', 0);
        }
    }

    function destroy() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        clearOrbit();
        if (pointCollection) {
            viewer.scene.primitives.remove(pointCollection);
        }
    }

    return { init, setVisible, destroy, classifySatellite };
})();