/* ========================================
   WorldView - Surveillance Cameras
   OSM Overpass + Traffic Cameras
   ======================================== */

const WorldViewCameras = (() => {
    'use strict';

    let viewer = null;
    let cameraEntities = [];
    let visible = true;
    let cameraCount = 0;
    let lastBounds = null;
    let fetchTimeout = null;
    let isFetching = false;

    const OVERPASS_PROXY = '/api/overpass';
    const OVERPASS_DIRECT = 'https://overpass-api.de/api/interpreter';

    // Debounce: only fetch when camera stops moving for 2 seconds
    const DEBOUNCE_MS = 2000;
    // Only fetch cameras when zoomed in enough
    const MIN_ALTITUDE_FOR_CAMERAS = 500000; // 500km

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Cameras] Initializing camera layer...');

        setupClickHandler();
        setupViewportListener();

        console.log('[Cameras] Camera layer initialized (viewport-based loading).');
    }

    function setupViewportListener() {
        // Listen for camera movement end
        viewer.camera.moveEnd.addEventListener(() => {
            if (!visible) return;

            // Clear any pending fetch
            if (fetchTimeout) clearTimeout(fetchTimeout);

            // Debounce
            fetchTimeout = setTimeout(() => {
                checkAndFetchCameras();
            }, DEBOUNCE_MS);
        });
    }

    function checkAndFetchCameras() {
        if (!visible || isFetching) return;

        // Check altitude - only load cameras when zoomed in
        const pos = WorldViewGlobe.getCameraPosition();
        if (!pos || pos.alt > MIN_ALTITUDE_FOR_CAMERAS) {
            return;
        }

        const bounds = WorldViewGlobe.getViewportBounds();
        if (!bounds) return;

        // Check if bounds changed significantly
        if (lastBounds) {
            const latDiff = Math.abs(bounds.south - lastBounds.south) + Math.abs(bounds.north - lastBounds.north);
            const lonDiff = Math.abs(bounds.west - lastBounds.west) + Math.abs(bounds.east - lastBounds.east);
            if (latDiff < 0.5 && lonDiff < 0.5) {
                return; // Bounds haven't changed enough
            }
        }

        // Limit bounding box size to avoid huge queries
        const latRange = bounds.north - bounds.south;
        const lonRange = bounds.east - bounds.west;
        if (latRange > 5 || lonRange > 5) {
            console.log('[Cameras] Viewport too large for camera query. Zoom in more.');
            return;
        }

        lastBounds = { ...bounds };
        fetchCameras(bounds);
    }

    async function fetchCameras(bounds) {
        if (isFetching) return;
        isFetching = true;

        const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
        const query = `[out:json][timeout:30];(
            node["man_made"="surveillance"](${bbox});
            node["surveillance"="camera"](${bbox});
        );out body;`;

        console.log(`[Cameras] Fetching cameras in bbox: ${bbox}`);

        try {
            let response;
            const params = new URLSearchParams({ data: query });

            try {
                response = await fetch(OVERPASS_PROXY, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params,
                    signal: AbortSignal.timeout(15000)
                });
            } catch {
                response = await fetch(OVERPASS_DIRECT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params,
                    signal: AbortSignal.timeout(30000)
                });
            }

            if (!response.ok) {
                console.warn('[Cameras] Overpass API returned status:', response.status);
                isFetching = false;
                return;
            }

            const data = await response.json();
            if (!data || !data.elements) {
                console.warn('[Cameras] No camera data returned.');
                isFetching = false;
                return;
            }

            renderCameras(data.elements);
            cameraCount = data.elements.length;
            WorldViewHUD.updateCounter('cameras', cameraCount);
            console.log(`[Cameras] Loaded ${data.elements.length} cameras.`);
        } catch (err) {
            console.error('[Cameras] Error fetching camera data:', err);
        }

        isFetching = false;
    }

    function createCameraIcon() {
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 24;
        const ctx = canvas.getContext('2d');

        // Camera body
        ctx.fillStyle = '#00f0ff';
        ctx.fillRect(4, 6, 12, 10);

        // Lens
        ctx.beginPath();
        ctx.moveTo(16, 8);
        ctx.lineTo(22, 5);
        ctx.lineTo(22, 17);
        ctx.lineTo(16, 14);
        ctx.closePath();
        ctx.fillStyle = '#00c0dd';
        ctx.fill();

        // Recording light
        ctx.beginPath();
        ctx.arc(7, 9, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3344';
        ctx.fill();

        return canvas.toDataURL();
    }

    let cameraIcon = null;

    function renderCameras(elements) {
        // Clear old
        clearEntities();

        if (!cameraIcon) {
            cameraIcon = createCameraIcon();
        }

        elements.forEach(element => {
            if (element.type !== 'node' || element.lat == null || element.lon == null) return;

            const tags = element.tags || {};
            const cameraType = tags['surveillance:type'] || tags['camera:type'] || 'Unknown';
            const operator = tags.operator || tags.name || 'Unknown';
            const url = tags.url || tags['contact:webcam'] || tags.image || null;
            const indoor = tags['surveillance:zone'] === 'indoor';

            const entity = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(element.lon, element.lat, 10),
                billboard: {
                    image: cameraIcon,
                    scale: 0.8,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                properties: {
                    type: 'camera',
                    cameraType: cameraType,
                    operator: operator,
                    url: url,
                    indoor: indoor,
                    osmId: element.id
                }
            });
            cameraEntities.push(entity);
        });
    }

    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction((click) => {
            const pickedObject = viewer.scene.pick(click.position);
            if (pickedObject && pickedObject.id && pickedObject.id.properties) {
                const props = pickedObject.id.properties;
                if (props.type && props.type.getValue() === 'camera') {
                    showCameraPopup(props);
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function showCameraPopup(props) {
        const url = props.url ? props.url.getValue() : null;
        const rows = [
            { key: 'TYPE', value: props.cameraType ? props.cameraType.getValue() : 'Unknown', class: 'highlight' },
            { key: 'OPERATOR', value: props.operator ? props.operator.getValue() : 'Unknown' },
            { key: 'ZONE', value: props.indoor && props.indoor.getValue() ? 'INDOOR' : 'OUTDOOR' },
            { key: 'OSM ID', value: props.osmId ? props.osmId.getValue().toString() : 'N/A' },
            { key: 'STREAM', value: url ? 'Available' : 'Not available', class: url ? 'highlight' : '' }
        ];

        if (url) {
            rows.push({ key: 'URL', value: url });
        }

        WorldViewHUD.showPopup('\u25ce SURVEILLANCE CAMERA', rows);
    }

    function clearEntities() {
        cameraEntities.forEach(e => viewer.entities.remove(e));
        cameraEntities = [];
    }

    function setVisible(v) {
        visible = v;
        cameraEntities.forEach(e => e.show = v);
        if (!v) {
            WorldViewHUD.updateCounter('cameras', 0);
        } else {
            WorldViewHUD.updateCounter('cameras', cameraCount);
            // Re-fetch if needed
            lastBounds = null;
            checkAndFetchCameras();
        }
    }

    function destroy() {
        if (fetchTimeout) clearTimeout(fetchTimeout);
        clearEntities();
    }

    return { init, setVisible, destroy };
})();
