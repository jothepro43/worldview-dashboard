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

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Flights] Initializing aircraft tracking...');

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

        console.log('[Flights] Aircraft tracking started (10s polling).');
    }

    async function fetchAircraft() {
        if (!visible) return;

        try {
            // Try proxy first, then direct
            let url = '/api/opensky';
            let response;
            try {
                response = await fetch(url, { signal: AbortSignal.timeout(8000) });
            } catch {
                url = 'https://opensky-network.org/api/states/all';
                response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            }

            if (!response.ok) {
                console.warn('[Flights] API returned status:', response.status);
                return;
            }

            const data = await response.json();
            if (!data || !data.states) {
                console.warn('[Flights] No aircraft data received.');
                return;
            }

            aircraftData = data.states;
            renderAircraft();

            const count = aircraftData.filter(s => s[6] != null && s[5] != null && !s[8]).length;
            WorldViewHUD.updateCounter('aircraft', count);
            console.log(`[Flights] Updated: ${count} airborne aircraft.`);
        } catch (err) {
            console.error('[Flights] Error fetching aircraft data:', err);
        }
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

            // Skip aircraft without position or on ground
            if (longitude == null || latitude == null || onGround) return;

            const altitude = geoAlt || baroAlt || 10000;
            const mil = isMilitary(callsign, category);
            const icon = mil ? militaryIcon : civilianIcon;

            const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);

            // Rotation based on heading
            const rotation = trueTrack != null ? -Cesium.Math.toRadians(trueTrack) : 0;

            const billboard = billboardCollection.add({
                position: position,
                image: icon,
                scale: mil ? 0.7 : 0.5,
                rotation: rotation,
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                id: {
                    type: 'aircraft',
                    icao24: icao24,
                    callsign: callsign,
                    originCountry: originCountry,
                    altitude: altitude,
                    velocity: velocity,
                    trueTrack: trueTrack,
                    verticalRate: verticalRate,
                    isMilitary: mil
                }
            });

            // Show labels for military aircraft
            if (mil && callsign) {
                labelCollection.add({
                    position: position,
                    text: callsign,
                    font: '10px Share Tech Mono',
                    fillColor: Cesium.Color.fromCssColorString('#ff3344'),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    scale: 1.0
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
                if (id.type === 'aircraft') {
                    showAircraftPopup(id);
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showAircraftPopup(data) {
        const rows = [
            { key: 'CALLSIGN', value: data.callsign || 'N/A', class: data.isMilitary ? 'danger' : 'highlight' },
            { key: 'ICAO24', value: data.icao24 || 'N/A' },
            { key: 'COUNTRY', value: data.originCountry || 'N/A' },
            { key: 'TYPE', value: data.isMilitary ? 'MILITARY' : 'CIVILIAN', class: data.isMilitary ? 'danger' : '' },
            { key: 'ALTITUDE', value: data.altitude ? Math.round(data.altitude).toLocaleString() + ' m' : 'N/A' },
            { key: 'SPEED', value: data.velocity ? (data.velocity * 3.6).toFixed(0) + ' km/h' : 'N/A' },
            { key: 'HEADING', value: data.trueTrack != null ? data.trueTrack.toFixed(1) + '°' : 'N/A' },
            { key: 'VERT RATE', value: data.verticalRate != null ? data.verticalRate.toFixed(1) + ' m/s' : 'N/A', class: data.verticalRate > 0 ? 'highlight' : (data.verticalRate < 0 ? 'warning' : '') }
        ];

        const title = data.isMilitary ? '⚠ MILITARY AIRCRAFT' : '✈ AIRCRAFT';
        WorldViewHUD.showPopup(title, rows);
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
        if (billboardCollection) {
            viewer.scene.primitives.remove(billboardCollection);
        }
        if (labelCollection) {
            viewer.scene.primitives.remove(labelCollection);
        }
    }

    return { init, setVisible, destroy };
})();
