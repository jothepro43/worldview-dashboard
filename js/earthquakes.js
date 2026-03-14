/* ========================================
   WorldView - Earthquake Events (USGS)
   ======================================== */

const WorldViewEarthquakes = (() => {
    'use strict';

    let viewer = null;
    let earthquakeEntities = [];
    let pollInterval = null;
    let visible = true;
    let earthquakeCount = 0;

    const USGS_API = '/api/earthquakes';
    const USGS_DIRECT = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Earthquakes] Initializing earthquake tracking...');

        setupClickHandler();
        fetchEarthquakes();
        pollInterval = setInterval(fetchEarthquakes, 300000); // 5 minutes

        console.log('[Earthquakes] Earthquake tracking started (5 min refresh).');
    }

    async function fetchEarthquakes() {
        if (!visible) return;

        try {
            let response;
            try {
                response = await fetch(USGS_API, { signal: AbortSignal.timeout(8000) });
            } catch {
                response = await fetch(USGS_DIRECT, { signal: AbortSignal.timeout(15000) });
            }

            if (!response.ok) {
                console.warn('[Earthquakes] API returned status:', response.status);
                return;
            }

            const data = await response.json();
            if (!data || !data.features) {
                console.warn('[Earthquakes] No earthquake data.');
                return;
            }

            renderEarthquakes(data.features);
            earthquakeCount = data.features.length;
            updateEventCounter();
            console.log(`[Earthquakes] Loaded ${data.features.length} earthquakes.`);
        } catch (err) {
            console.error('[Earthquakes] Error fetching earthquake data:', err);
        }
    }

    function getDepthColor(depth) {
        if (depth < 70) {
            // Shallow - red/orange
            return Cesium.Color.fromCssColorString('#ff4422').withAlpha(0.7);
        } else if (depth < 300) {
            // Intermediate - yellow/amber
            return Cesium.Color.fromCssColorString('#ffaa00').withAlpha(0.7);
        } else {
            // Deep - green/blue
            return Cesium.Color.fromCssColorString('#00cc88').withAlpha(0.7);
        }
    }

    function getMagnitudeRadius(magnitude) {
        // Scale: M1 = 5000m, M5 = 50000m, M8+ = 200000m
        const mag = Math.max(magnitude || 0, 0.5);
        return Math.pow(mag, 2.2) * 3000;
    }

    function renderEarthquakes(features) {
        // Remove old entities
        clearEntities();

        features.forEach(feature => {
            const props = feature.properties;
            const coords = feature.geometry.coordinates;
            const longitude = coords[0];
            const latitude = coords[1];
            const depth = coords[2]; // km
            const magnitude = props.mag;
            const place = props.place || 'Unknown';
            const time = props.time;
            const tsunami = props.tsunami;
            const url = props.url;

            if (longitude == null || latitude == null) return;

            const color = getDepthColor(depth);
            const radius = getMagnitudeRadius(magnitude);

            // Main circle
            const entity = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 0),
                ellipse: {
                    semiMajorAxis: radius,
                    semiMinorAxis: radius,
                    material: color,
                    outline: true,
                    outlineColor: color.withAlpha(0.9),
                    outlineWidth: 1,
                    height: 0,
                    classificationType: Cesium.ClassificationType.BOTH
                },
                properties: {
                    type: 'earthquake',
                    place: place,
                    magnitude: magnitude,
                    depth: depth,
                    time: time,
                    tsunami: tsunami,
                    url: url
                }
            });
            earthquakeEntities.push(entity);

            // Pulsing outer ring for significant quakes (M4+)
            if (magnitude >= 4) {
                const pulseEntity = viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 0),
                    ellipse: {
                        semiMajorAxis: radius * 1.5,
                        semiMinorAxis: radius * 1.5,
                        material: color.withAlpha(0.2),
                        outline: true,
                        outlineColor: color.withAlpha(0.5),
                        outlineWidth: 2,
                        height: 0,
                        classificationType: Cesium.ClassificationType.BOTH
                    }
                });
                earthquakeEntities.push(pulseEntity);
            }

            // Label for significant quakes (M5+)
            if (magnitude >= 5) {
                const labelEntity = viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 10000),
                    label: {
                        text: `M${magnitude.toFixed(1)}`,
                        font: '12px Orbitron',
                        fillColor: Cesium.Color.fromCssColorString('#ff4422'),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -10),
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scale: 1.0
                    }
                });
                earthquakeEntities.push(labelEntity);
            }
        });
    }

    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
            const pickedObject = viewer.scene.pick(click.position);
            if (pickedObject && pickedObject.id && pickedObject.id.properties) {
                const props = pickedObject.id.properties;
                if (props.type && props.type.getValue() === 'earthquake') {
                    showEarthquakePopup(props);
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showEarthquakePopup(props) {
        const magnitude = props.magnitude ? props.magnitude.getValue() : 'N/A';
        const depth = props.depth ? props.depth.getValue() : 'N/A';
        const place = props.place ? props.place.getValue() : 'Unknown';
        const time = props.time ? new Date(props.time.getValue()).toUTCString() : 'N/A';
        const tsunami = props.tsunami ? props.tsunami.getValue() : 0;

        let depthCategory = 'N/A';
        if (typeof depth === 'number') {
            if (depth < 70) depthCategory = 'SHALLOW';
            else if (depth < 300) depthCategory = 'INTERMEDIATE';
            else depthCategory = 'DEEP';
        }

        const rows = [
            { key: 'LOCATION', value: place, class: 'highlight' },
            { key: 'MAGNITUDE', value: typeof magnitude === 'number' ? 'M' + magnitude.toFixed(1) : magnitude, class: magnitude >= 5 ? 'danger' : (magnitude >= 3 ? 'warning' : '') },
            { key: 'DEPTH', value: typeof depth === 'number' ? depth.toFixed(1) + ' km' : depth },
            { key: 'DEPTH CLASS', value: depthCategory },
            { key: 'TIME (UTC)', value: time },
            { key: 'TSUNAMI', value: tsunami ? 'YES - WARNING' : 'No', class: tsunami ? 'danger' : '' }
        ];

        WorldViewHUD.showPopup('\u25c8 EARTHQUAKE', rows);
    }

    function clearEntities() {
        earthquakeEntities.forEach(e => viewer.entities.remove(e));
        earthquakeEntities = [];
    }

    function updateEventCounter() {
        // Combine with weather events count
        const weatherCount = (typeof WorldViewWeather !== 'undefined') ? WorldViewWeather.getCount() : 0;
        WorldViewHUD.updateCounter('events', earthquakeCount + weatherCount);
    }

    function getCount() {
        return earthquakeCount;
    }

    function setVisible(v) {
        visible = v;
        earthquakeEntities.forEach(e => e.show = v);
        if (!v) {
            const weatherCount = (typeof WorldViewWeather !== 'undefined') ? WorldViewWeather.getCount() : 0;
            WorldViewHUD.updateCounter('events', weatherCount);
        } else {
            updateEventCounter();
        }
    }

    function destroy() {
        if (pollInterval) clearInterval(pollInterval);
        clearEntities();
    }

    return { init, setVisible, destroy, getCount };
})();
