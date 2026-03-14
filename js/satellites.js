/* ========================================
   WorldView - Satellite Tracking
   TLE data + satellite.js orbital computation
   ======================================== */

const WorldViewSatellites = (() => {
    'use strict';

    let viewer = null;
    let pointCollection = null;
    let orbitEntities = [];
    let satelliteRecords = []; // { name, satrec, group, noradId }
    let animationFrameId = null;
    let visible = true;
    let selectedSatellite = null;

    // TLE data sources
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

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Satellites] Initializing satellite tracking...');
        console.log('[Satellites] satellite.js available:', typeof satellite !== 'undefined');

        pointCollection = new Cesium.PointPrimitiveCollection();
        viewer.scene.primitives.add(pointCollection);

        // Setup click handler
        setupClickHandler();

        // Fetch TLE data
        fetchAllTLEs();

        console.log('[Satellites] Satellite tracking initialized.');
    }

    async function fetchAllTLEs() {
        let totalLoaded = 0;

        for (const source of TLE_SOURCES) {
            try {
                console.log(`[Satellites] Fetching TLE: ${source.group}...`);
                let response;
                try {
                    response = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
                } catch {
                    response = await fetch(source.direct, { signal: AbortSignal.timeout(20000) });
                }

                if (!response.ok) {
                    console.warn(`[Satellites] Failed to fetch ${source.group}: ${response.status}`);
                    continue;
                }

                const text = await response.text();
                const records = parseTLE(text, source.group, source.color);
                const limit = MAX_SATELLITES_PER_GROUP[source.group] || 500;
                const limited = records.slice(0, limit);
                satelliteRecords.push(...limited);
                totalLoaded += limited.length;

                console.log(`[Satellites] Loaded ${limited.length} from ${source.group} (${records.length} total available).`);
                WorldViewHUD.updateCounter('satellites', totalLoaded);
            } catch (err) {
                console.error(`[Satellites] Error fetching ${source.group}:`, err);
            }
        }

        console.log(`[Satellites] Total satellites loaded: ${satelliteRecords.length}`);

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
                        records.push({
                            name: name,
                            satrec: satrec,
                            group: group,
                            noradId: noradId,
                            color: color,
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
            const pos = computePosition(rec.satrec, now);
            if (!pos || isNaN(pos.latitude) || isNaN(pos.longitude)) return;

            // Clamp altitude
            const alt = Math.max(pos.altitude, 100000); // At least 100km

            const position = Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, alt);

            let pixelSize = 2;
            let color;

            switch (rec.group) {
                case 'station':
                    pixelSize = 6;
                    color = Cesium.Color.fromBytes(0, 255, 200, 255);
                    break;
                case 'gps':
                    pixelSize = 4;
                    color = Cesium.Color.fromBytes(100, 200, 255, 255);
                    break;
                case 'starlink':
                    pixelSize = 2;
                    color = Cesium.Color.fromBytes(180, 180, 255, 180);
                    break;
                default:
                    pixelSize = 2;
                    color = Cesium.Color.fromBytes(0, 255, 136, 200);
                    break;
            }

            pointCollection.add({
                position: position,
                pixelSize: pixelSize,
                color: color,
                outlineColor: Cesium.Color.fromBytes(rec.color[0], rec.color[1], rec.color[2], 80),
                outlineWidth: 1,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                id: {
                    type: 'satellite',
                    index: index,
                    name: rec.name,
                    noradId: rec.noradId,
                    group: rec.group,
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
            { key: 'ALTITUDE', value: data.altitude ? data.altitude.toFixed(1) + ' km' : 'N/A' },
            { key: 'VELOCITY', value: data.speed ? data.speed.toFixed(2) + ' km/s' : 'N/A' },
            { key: 'PERIOD', value: period },
            { key: 'INCLINATION', value: data.inclination != null ? data.inclination.toFixed(2) + '\u00b0' : 'N/A' }
        ];

        WorldViewHUD.showPopup('\u25c9 SATELLITE', rows);
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
            const entity = viewer.entities.add({
                polyline: {
                    positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
                    width: 1.5,
                    material: new Cesium.ColorMaterialProperty(
                        Cesium.Color.fromBytes(rec.color[0], rec.color[1], rec.color[2], 150)
                    ),
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
        if (!v) {
            WorldViewHUD.updateCounter('satellites', 0);
        } else {
            WorldViewHUD.updateCounter('satellites', satelliteRecords.length);
        }
    }

    function destroy() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        clearOrbit();
        if (pointCollection) {
            viewer.scene.primitives.remove(pointCollection);
        }
    }

    return { init, setVisible, destroy };
})();
