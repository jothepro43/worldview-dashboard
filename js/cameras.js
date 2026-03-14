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
        setupFeedModalClose();

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
        console.log(`[Cameras] Camera alt: ${WorldViewGlobe.getCameraPosition()?.alt?.toFixed(0)}m, min for fetch: ${MIN_ALTITUDE_FOR_CAMERAS}m`);

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
                    disableDepthTestDistance: 0
                },
                properties: {
                    type: 'camera',
                    cameraType: cameraType,
                    operator: operator,
                    url: url,
                    indoor: indoor,
                    osmId: element.id,
                    lat: element.lat,
                    lon: element.lon
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

    // FIX 1: Show popup with VIEW FEED button
    function showCameraPopup(props) {
        const url = props.url ? props.url.getValue() : null;

        // Extract lat/lon — stored directly in properties, or fall back to entity position
        let lat = props.lat ? props.lat.getValue() : null;
        let lon = props.lon ? props.lon.getValue() : null;

        // Fallback: extract from Cartesian3 entity position if lat/lon not stored
        if ((lat == null || lon == null) && pickedEntityPosition) {
            try {
                const carto = Cesium.Cartographic.fromCartesian(pickedEntityPosition);
                lat = Cesium.Math.toDegrees(carto.latitude);
                lon = Cesium.Math.toDegrees(carto.longitude);
            } catch (e) { /* ignore */ }
        }

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

        // FIX 1: Add VIEW FEED button row
        const capturedLat = lat;
        const capturedLon = lon;
        const capturedUrl = url;
        rows.push({
            type: 'button',
            label: 'VIEW FEED',
            onclick: () => {
                openFeedViewer(capturedUrl, capturedLat, capturedLon);
            }
        });

        WorldViewHUD.showPopup('◎ SURVEILLANCE CAMERA', rows);
    }

    // Keep track of last clicked entity position as fallback
    let pickedEntityPosition = null;

    // FIX 1: Open the feed viewer modal
    function openFeedViewer(url, lat, lon) {
        const modal = document.getElementById('camera-feed-modal');
        const iframeContainer = document.getElementById('feed-iframe-container');
        const iframe = document.getElementById('feed-iframe');
        const svContainer = document.getElementById('feed-streetview-container');
        const svImg = document.getElementById('feed-streetview-img');
        const unavailEl = document.getElementById('feed-unavailable');
        const loadingEl = document.getElementById('feed-loading');
        const statusEl = document.getElementById('feed-modal-status');

        if (!modal) return;

        // Reset all containers
        iframeContainer.classList.add('hidden');
        svContainer.classList.add('hidden');
        unavailEl.classList.add('hidden');
        loadingEl.classList.remove('hidden');
        iframe.src = '';
        svImg.src = '';

        // Show modal
        modal.classList.remove('hidden');

        if (url) {
            // Try to load the camera's URL in an iframe
            statusEl.textContent = 'SOURCE: ' + url.substring(0, 60) + (url.length > 60 ? '...' : '');

            iframeContainer.classList.remove('hidden');
            loadingEl.classList.add('hidden');

            // Listen for load errors on the iframe
            iframe.onerror = () => {
                console.warn('[Cameras] Feed iframe failed to load:', url);
                iframeContainer.classList.add('hidden');
                tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
            };

            // Set a timeout — if the iframe doesn't signal load in 8s, try street view
            let iframeLoadTimeout = setTimeout(() => {
                // iframe.contentDocument is null for cross-origin, which is normal
                // We cannot reliably detect load failures for cross-origin iframes,
                // so we just leave the iframe showing (it either loaded or shows a browser error)
                console.log('[Cameras] Feed iframe timeout — showing as-is.');
            }, 8000);

            iframe.onload = () => {
                clearTimeout(iframeLoadTimeout);
                loadingEl.classList.add('hidden');
                console.log('[Cameras] Feed iframe loaded.');
            };

            iframe.src = url;

        } else if (lat != null && lon != null) {
            // No URL — try Street View
            statusEl.textContent = 'NO STREAM URL — LOADING STREET VIEW...';
            tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
        } else {
            // Nothing available
            loadingEl.classList.add('hidden');
            unavailEl.classList.remove('hidden');
            statusEl.textContent = 'NO FEED DATA AVAILABLE';
        }
    }

    // FIX 1: Attempt to load a Street View static image
    function tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl) {
        if (lat == null || lon == null) {
            loadingEl.classList.add('hidden');
            unavailEl.classList.remove('hidden');
            statusEl.textContent = 'NO LOCATION DATA AVAILABLE';
            return;
        }

        // Build Street View static API URL (key may be absent — handled gracefully)
        const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${lat},${lon}&heading=0&pitch=0&fov=90&key=`;

        statusEl.textContent = `STREET VIEW: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;

        svImg.onload = () => {
            loadingEl.classList.add('hidden');
            svContainer.classList.remove('hidden');
            // The Street View API returns a gray image (not an HTTP error) when there's no imagery.
            // We show it as-is; the user sees what's available.
            statusEl.textContent = `STREET VIEW @ ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
            console.log('[Cameras] Street View image loaded.');
        };

        svImg.onerror = () => {
            loadingEl.classList.add('hidden');
            unavailEl.classList.remove('hidden');
            statusEl.textContent = 'STREET VIEW UNAVAILABLE';
            console.warn('[Cameras] Street View image failed to load.');
        };

        svImg.src = svUrl;
    }

    // FIX 1: Wire up the modal close button
    function setupFeedModalClose() {
        const closeBtn = document.getElementById('feed-modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeFeedViewer);
        }

        // Close on backdrop click
        const modal = document.getElementById('camera-feed-modal');
        if (modal) {
            const backdrop = modal.querySelector('.feed-modal-backdrop');
            if (backdrop) {
                backdrop.addEventListener('click', closeFeedViewer);
            }
        }
    }

    function closeFeedViewer() {
        const modal = document.getElementById('camera-feed-modal');
        const iframe = document.getElementById('feed-iframe');
        if (modal) modal.classList.add('hidden');
        // Stop iframe playback
        if (iframe) iframe.src = '';
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