/* ========================================
   WorldView - Weather Events
   NASA EONET + NWS Alerts
   ======================================== */

const WorldViewWeather = (() => {
    'use strict';

    let viewer = null;
    let eonetEntities = [];
    let nwsEntities = [];
    let pollInterval = null;
    let visible = true;
    let eonetCount = 0;
    let nwsCount = 0;

    const EONET_API = '/api/eonet';
    const EONET_DIRECT = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open';
    const NWS_API = '/api/nws';
    const NWS_DIRECT = 'https://api.weather.gov/alerts/active';

    // EONET category icons and colors
    const EONET_STYLES = {
        'Wildfires': { icon: '\ud83d\udd25', color: '#ff6600', label: 'WILDFIRE' },
        'Volcanoes': { icon: '\ud83c\udf0b', color: '#ff2200', label: 'VOLCANO' },
        'Severe Storms': { icon: '\ud83c\udf00', color: '#4488ff', label: 'STORM' },
        'Floods': { icon: '\ud83d\udca7', color: '#2266ff', label: 'FLOOD' },
        'Sea and Lake Ice': { icon: '\u2744\ufe0f', color: '#aaddff', label: 'ICE' },
        'Earthquakes': { icon: '\ud83c\udf0d', color: '#ff4422', label: 'QUAKE' },
        'Drought': { icon: '\u2600\ufe0f', color: '#cc8800', label: 'DROUGHT' },
        'Landslides': { icon: '\u26a0', color: '#996633', label: 'LANDSLIDE' },
        'Temperature Extremes': { icon: '\ud83c\udf21', color: '#ff8800', label: 'TEMP' }
    };

    // NWS severity colors — FIX 1: reduced alpha values for fills
    const NWS_SEVERITY_COLORS = {
        'Extreme': Cesium.Color.fromCssColorString('#ff3344').withAlpha(0.12),
        'Severe': Cesium.Color.fromCssColorString('#ff8800').withAlpha(0.10),
        'Moderate': Cesium.Color.fromCssColorString('#ffcc00').withAlpha(0.08),
        'Minor': Cesium.Color.fromCssColorString('#00cc44').withAlpha(0.06),
        'Unknown': Cesium.Color.fromCssColorString('#888888').withAlpha(0.05)
    };

    // NWS severity outline colors — FIX 1: 1px solid border only
    const NWS_SEVERITY_OUTLINES = {
        'Extreme': Cesium.Color.fromCssColorString('#ff3344').withAlpha(0.6),
        'Severe': Cesium.Color.fromCssColorString('#ff8800').withAlpha(0.5),
        'Moderate': Cesium.Color.fromCssColorString('#ffcc00').withAlpha(0.4),
        'Minor': Cesium.Color.fromCssColorString('#00cc44').withAlpha(0.3),
        'Unknown': Cesium.Color.fromCssColorString('#888888').withAlpha(0.2)
    };

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Weather] Initializing weather event tracking...');

        setupClickHandler();
        fetchEONET();
        fetchNWS();
        pollInterval = setInterval(() => {
            fetchEONET();
            fetchNWS();
        }, 300000); // 5 minutes

        console.log('[Weather] Weather tracking started (5 min refresh).');
    }

    // --- NASA EONET ---
    async function fetchEONET() {
        if (!visible) return;

        try {
            console.log('[Weather] Fetching EONET events...');
            let response;
            try {
                response = await fetch(EONET_API, { signal: AbortSignal.timeout(8000) });
                console.log('[Weather] EONET proxy response status:', response.status);
            } catch (proxyErr) {
                console.log('[Weather] EONET proxy failed, trying direct...', proxyErr.message);
                response = await fetch(EONET_DIRECT, { signal: AbortSignal.timeout(15000) });
                console.log('[Weather] EONET direct response status:', response.status);
            }

            if (!response.ok) {
                console.warn('[Weather] EONET API returned status:', response.status);
                return;
            }

            const data = await response.json();
            if (!data || !data.events) {
                console.warn('[Weather] No EONET event data. Response keys:', Object.keys(data || {}));
                return;
            }

            renderEONET(data.events);
            eonetCount = data.events.length;
            updateEventCounter();
            console.log(`[Weather] Loaded ${data.events.length} EONET events.`);
        } catch (err) {
            console.error('[Weather] Error fetching EONET data:', err);
        }
    }

    function renderEONET(events) {
        // Clear old
        eonetEntities.forEach(e => viewer.entities.remove(e));
        eonetEntities = [];

        events.forEach(event => {
            const categoryTitle = event.categories && event.categories[0] ? event.categories[0].title : 'Unknown';
            const style = EONET_STYLES[categoryTitle] || { icon: '\u26a0', color: '#ffaa00', label: 'EVENT' };

            // Get latest geometry
            if (!event.geometry || event.geometry.length === 0) return;
            const latestGeo = event.geometry[event.geometry.length - 1];

            if (latestGeo.type === 'Point' && latestGeo.coordinates) {
                const lon = latestGeo.coordinates[0];
                const lat = latestGeo.coordinates[1];

                if (lon == null || lat == null) return;

                // FIX 1: Reduced marker size — pixelSize 6 (was 10), label scale 0.7
                // FIX 2: disableDepthTestDistance: 0 so markers are hidden behind globe
                const entity = viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(lon, lat, 5000),
                    point: {
                        pixelSize: 6,
                        color: Cesium.Color.fromCssColorString(style.color),
                        outlineColor: Cesium.Color.fromCssColorString(style.color).withAlpha(0.5),
                        outlineWidth: 1,
                        disableDepthTestDistance: 0,
                        heightReference: Cesium.HeightReference.NONE
                    },
                    label: {
                        text: style.label,
                        font: '9px Share Tech Mono',
                        fillColor: Cesium.Color.fromCssColorString(style.color),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, -12),
                        disableDepthTestDistance: 0,
                        scale: 0.7,
                        scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 1.5e7, 0.3)
                    },
                    properties: {
                        type: 'eonet',
                        title: event.title || 'Unknown',
                        category: categoryTitle,
                        date: latestGeo.date || 'N/A',
                        source: event.sources && event.sources[0] ? event.sources[0].url : 'N/A',
                        eventId: event.id || 'N/A'
                    }
                });
                eonetEntities.push(entity);
            }
        });
    }

    // --- NWS Alerts ---
    async function fetchNWS() {
        if (!visible) return;

        try {
            console.log('[Weather] Fetching NWS alerts...');
            let response;
            try {
                response = await fetch(NWS_API, {
                    signal: AbortSignal.timeout(8000),
                    headers: { 'User-Agent': 'WorldView-Dashboard/1.0' }
                });
                console.log('[Weather] NWS proxy response status:', response.status);
            } catch (proxyErr) {
                console.log('[Weather] NWS proxy failed, trying direct...', proxyErr.message);
                response = await fetch(NWS_DIRECT, {
                    signal: AbortSignal.timeout(15000),
                    headers: {
                        'User-Agent': 'WorldView-Dashboard/1.0',
                        'Accept': 'application/geo+json'
                    }
                });
                console.log('[Weather] NWS direct response status:', response.status);
            }

            if (!response.ok) {
                console.warn('[Weather] NWS API returned status:', response.status);
                return;
            }

            const data = await response.json();
            if (!data || !data.features) {
                console.warn('[Weather] No NWS alert data. Response keys:', Object.keys(data || {}));
                return;
            }

            // Limit to first 200 alerts for performance
            const alerts = data.features.slice(0, 200);
            renderNWS(alerts);
            nwsCount = alerts.length;
            updateEventCounter();
            console.log(`[Weather] Loaded ${alerts.length} NWS alerts.`);
        } catch (err) {
            console.error('[Weather] Error fetching NWS data:', err);
        }
    }

    function renderNWS(alerts) {
        // Clear old
        nwsEntities.forEach(e => viewer.entities.remove(e));
        nwsEntities = [];

        alerts.forEach(alert => {
            const props = alert.properties;
            const severity = props.severity || 'Unknown';
            const fillColor = NWS_SEVERITY_COLORS[severity] || NWS_SEVERITY_COLORS['Unknown'];
            const outlineColor = NWS_SEVERITY_OUTLINES[severity] || NWS_SEVERITY_OUTLINES['Unknown'];

            const geometry = alert.geometry;
            if (!geometry) return;

            try {
                if (geometry.type === 'Polygon' && geometry.coordinates) {
                    const coords = geometry.coordinates[0]; // outer ring
                    if (!coords || coords.length < 3) return;

                    const positions = [];
                    coords.forEach(c => {
                        positions.push(c[0], c[1]);
                    });

                    // FIX 1: outlineWidth 1 (was 2), alpha reduced in color defs above
                    const entity = viewer.entities.add({
                        polygon: {
                            hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                            material: fillColor,
                            outline: true,
                            outlineColor: outlineColor,
                            outlineWidth: 1,
                            height: 0,
                            classificationType: Cesium.ClassificationType.BOTH
                        },
                        properties: {
                            type: 'nws',
                            headline: props.headline || 'Weather Alert',
                            description: props.description ? props.description.substring(0, 300) : 'N/A',
                            severity: severity,
                            certainty: props.certainty || 'N/A',
                            effective: props.effective || 'N/A',
                            expires: props.expires || 'N/A',
                            event: props.event || 'N/A'
                        }
                    });
                    nwsEntities.push(entity);
                } else if (geometry.type === 'MultiPolygon' && geometry.coordinates) {
                    geometry.coordinates.forEach(polygon => {
                        const coords = polygon[0];
                        if (!coords || coords.length < 3) return;

                        const positions = [];
                        coords.forEach(c => {
                            positions.push(c[0], c[1]);
                        });

                        // FIX 1: outlineWidth 1 (was 2)
                        const entity = viewer.entities.add({
                            polygon: {
                                hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                                material: fillColor,
                                outline: true,
                                outlineColor: outlineColor,
                                outlineWidth: 1,
                                height: 0,
                                classificationType: Cesium.ClassificationType.BOTH
                            },
                            properties: {
                                type: 'nws',
                                headline: props.headline || 'Weather Alert',
                                description: props.description ? props.description.substring(0, 300) : 'N/A',
                                severity: severity,
                                certainty: props.certainty || 'N/A',
                                effective: props.effective || 'N/A',
                                expires: props.expires || 'N/A',
                                event: props.event || 'N/A'
                            }
                        });
                        nwsEntities.push(entity);
                    });
                }
            } catch (err) {
                // Skip malformed geometry
            }
        });
    }

    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
            const pickedObject = viewer.scene.pick(click.position);
            if (pickedObject && pickedObject.id && pickedObject.id.properties) {
                const props = pickedObject.id.properties;
                const type = props.type ? props.type.getValue() : null;

                if (type === 'eonet') {
                    showEONETPopup(props);
                } else if (type === 'nws') {
                    showNWSPopup(props);
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showEONETPopup(props) {
        const rows = [
            { key: 'EVENT', value: props.title ? props.title.getValue() : 'Unknown', class: 'highlight' },
            { key: 'CATEGORY', value: props.category ? props.category.getValue() : 'N/A' },
            { key: 'DATE', value: props.date ? props.date.getValue() : 'N/A' },
            { key: 'EVENT ID', value: props.eventId ? props.eventId.getValue() : 'N/A' },
            { key: 'SOURCE', value: props.source ? props.source.getValue() : 'N/A' }
        ];

        WorldViewHUD.showPopup('\ud83c\udf0d NATURAL EVENT', rows);
    }

    function showNWSPopup(props) {
        const severity = props.severity ? props.severity.getValue() : 'Unknown';
        let sevClass = '';
        if (severity === 'Extreme') sevClass = 'danger';
        else if (severity === 'Severe') sevClass = 'warning';

        const rows = [
            { key: 'ALERT', value: props.headline ? props.headline.getValue() : 'Weather Alert', class: 'highlight' },
            { key: 'EVENT', value: props.event ? props.event.getValue() : 'N/A' },
            { key: 'SEVERITY', value: severity, class: sevClass },
            { key: 'CERTAINTY', value: props.certainty ? props.certainty.getValue() : 'N/A' },
            { key: 'EFFECTIVE', value: props.effective ? new Date(props.effective.getValue()).toUTCString() : 'N/A' },
            { key: 'EXPIRES', value: props.expires ? new Date(props.expires.getValue()).toUTCString() : 'N/A' },
            { key: 'DETAILS', value: props.description ? props.description.getValue() : 'N/A' }
        ];

        WorldViewHUD.showPopup('\u26c8 WEATHER ALERT', rows);
    }

    function updateEventCounter() {
        const quakeCount = (typeof WorldViewEarthquakes !== 'undefined') ? WorldViewEarthquakes.getCount() : 0;
        WorldViewHUD.updateCounter('events', quakeCount + eonetCount + nwsCount);
    }

    function getCount() {
        return eonetCount + nwsCount;
    }

    function setVisible(v) {
        visible = v;
        eonetEntities.forEach(e => e.show = v);
        nwsEntities.forEach(e => e.show = v);
        if (!v) {
            const quakeCount = (typeof WorldViewEarthquakes !== 'undefined') ? WorldViewEarthquakes.getCount() : 0;
            WorldViewHUD.updateCounter('events', quakeCount);
        } else {
            updateEventCounter();
        }
    }

    function destroy() {
        if (pollInterval) clearInterval(pollInterval);
        eonetEntities.forEach(e => viewer.entities.remove(e));
        nwsEntities.forEach(e => viewer.entities.remove(e));
        eonetEntities = [];
        nwsEntities = [];
    }

    return { init, setVisible, destroy, getCount };
})();
