/* ========================================
   WorldView - Surveillance Cameras
   OSM Overpass (stream-URL only) + Windy Webcams API
   MJPEG/HLS proxied through server/proxy.js
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
    const WINDY_PROXY = '/api/windy-webcams';

    const DEBOUNCE_MS = 2000;
    const MIN_ALTITUDE_FOR_CAMERAS = 500000;

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

    function createCameraIcon(fillColor) {
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 24;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = fillColor;
        ctx.fillRect(4, 6, 12, 10);
        ctx.beginPath();
        ctx.moveTo(16, 8);
        ctx.lineTo(22, 5);
        ctx.lineTo(22, 17);
        ctx.lineTo(16, 14);
        ctx.closePath();
        ctx.fillStyle = fillColor === '#00ff88' ? '#00cc66' : '#00c0dd';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(7, 9, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3344';
        ctx.fill();
        return canvas.toDataURL();
    }

    let osmCameraIcon = null;
    let windyCameraIcon = null;

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        console.log('[Cameras] Initializing camera layer...');
        osmCameraIcon = createCameraIcon('#00f0ff');
        windyCameraIcon = createCameraIcon('#00ff88');
        setupClickHandler();
        setupViewportListener();
        setupFeedModalClose();
        console.log('[Cameras] Camera layer initialized (viewport-based loading).');
        console.log(`[Cameras] Windy Webcams: ${isConfigured('windyWebcamApiKey') ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
    }

    function setupViewportListener() {
        viewer.camera.moveEnd.addEventListener(() => {
            if (!visible) return;
            if (fetchTimeout) clearTimeout(fetchTimeout);
            fetchTimeout = setTimeout(() => { checkAndFetchCameras(); }, DEBOUNCE_MS);
        });
    }

    function checkAndFetchCameras() {
        if (!visible || isFetching) return;
        const pos = WorldViewGlobe.getCameraPosition();
        if (!pos || pos.alt > MIN_ALTITUDE_FOR_CAMERAS) return;
        const bounds = WorldViewGlobe.getViewportBounds();
        if (!bounds) return;
        if (lastBounds) {
            const latDiff = Math.abs(bounds.south - lastBounds.south) + Math.abs(bounds.north - lastBounds.north);
            const lonDiff = Math.abs(bounds.west - lastBounds.west) + Math.abs(bounds.east - lastBounds.east);
            if (latDiff < 0.5 && lonDiff < 0.5) return;
        }
        const latRange = bounds.north - bounds.south;
        const lonRange = bounds.east - bounds.west;
        if (latRange > 5 || lonRange > 5) {
            console.log('[Cameras] Viewport too large for camera query. Zoom in more.');
            return;
        }
        lastBounds = { ...bounds };
        fetchAllCameras(bounds);
    }

    async function fetchAllCameras(bounds) {
        if (isFetching) return;
        isFetching = true;
        const allCameras = [];
        const [osmCameras, windyCameras, gdotCameras] = await Promise.all([
            fetchOSMCameras(bounds),
            fetchWindyWebcams(bounds),
            fetch511GACameras(bounds)
        ]);
        if (osmCameras) allCameras.push(...osmCameras);
        if (windyCameras) allCameras.push(...windyCameras);
        if (gdotCameras) allCameras.push(...gdotCameras);
        renderCameras(allCameras);
        cameraCount = allCameras.length;
        WorldViewHUD.updateCounter('cameras', cameraCount);
        console.log(`[Cameras] Total: ${allCameras.length} live-feed cameras (OSM: ${osmCameras ? osmCameras.length : 0}, Windy: ${windyCameras ? windyCameras.length : 0}, GDOT: ${gdotCameras ? gdotCameras.length : 0}).`);
        isFetching = false;
    }

    async function fetch511GACameras(bounds) {
        // Simple bounding box check to see if we should query Georgia
        // Georgia approx bounds: Lat 30.3-35.0, Lon -85.6 to -80.8
        if (bounds.north < 30.0 || bounds.south > 35.5 || bounds.east < -86.0 || bounds.west > -80.0) {
            return [];
        }

        try {
            // Fetch more cameras (increased limit to 2000 to catch all available)
            const response = await fetch('/api/gdot-cameras?start=0&length=2000');
            if (!response.ok) {
                console.warn('[Cameras] GDOT API returned error:', response.status);
                return [];
            }
            
            const data = await response.json();
            if (!data || !data.data || !Array.isArray(data.data)) {
                console.warn('[Cameras] GDOT API returned unexpected format:', data);
                return [];
            }

            console.log(`[Cameras] GDOT returned ${data.data.length} raw camera records.`);

            return data.data.map(cam => {
                // GDOT uses WKT for location: "POINT (-84.388 33.749)"
                let lat = 0, lon = 0;
                if (cam.latLng && cam.latLng.geography && cam.latLng.geography.wellKnownText) {
                    const wkt = cam.latLng.geography.wellKnownText;
                    const parts = wkt.replace('POINT (', '').replace(')', '').split(' ');
                    lon = parseFloat(parts[0]);
                    lat = parseFloat(parts[1]);
                }

                // Check bounds
                if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) {
                    return null;
                }

                // Get best image/stream
                let streamUrl = null;
                let isVideo = false;
                if (cam.images && cam.images.length > 0) {
                    const img = cam.images[0];
                    if (img.videoUrl && img.videoType === 'hls') {
                        streamUrl = img.videoUrl;
                        isVideo = true;
                    } else if (img.imageUrl) {
                        streamUrl = 'https://511ga.org' + img.imageUrl;
                    }
                }

                if (!streamUrl) return null;

                return {
                    source: 'gdot',
                    lat: lat,
                    lon: lon,
                    streamUrl: streamUrl,
                    streamType: isVideo ? 'hls' : 'image',
                    cameraType: 'Traffic Cam',
                    operator: 'GDOT',
                    description: cam.location || cam.roadway,
                    originalUrl: 'https://511ga.org/map' // Fallback for "Open External"
                };
            }).filter(c => c !== null);

        } catch (err) {
            console.warn('[Cameras] GDOT fetch failed:', err);
            return [];
        }
    }

    async function fetchOSMCameras(bounds) {
        // Expand query to catch more potential cameras (traffic, tourism, attractions)
        const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
        const query = `
            [out:json][timeout:25];
            (
              node["man_made"="surveillance"]["contact:webcam"](${bbox});
              node["man_made"="surveillance"]["url"](${bbox});
              node["man_made"="surveillance"]["webcam"](${bbox});
              node["surveillance"="camera"]["contact:webcam"](${bbox});
              node["surveillance"="camera"]["url"](${bbox});
              node["surveillance"="camera"]["webcam"](${bbox});
              node["tourism"="viewpoint"]["url"](${bbox});
              node["tourism"="attraction"]["url"](${bbox});
              node["traffic_monitoring"="outdoor"]["url"](${bbox});
            );
            out body;
            >;
            out skel qt;
        `;
        console.log(`[Cameras] OSM query for stream-URL cameras in bbox: ${bbox}`);
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
                return null;
            }
            const data = await response.json();
            if (!data || !data.elements) {
                console.warn('[Cameras] No OSM camera data returned.');
                return null;
            }
            const filtered = data.elements.filter(el => {
                if (el.type !== 'node' || el.lat == null || el.lon == null) return false;
                const tags = el.tags || {};
                const streamUrl = tags['contact:webcam'] || tags.url || tags.webcam || null;
                return streamUrl && isStreamUrl(streamUrl);
            });
            return filtered.map(el => {
                const tags = el.tags || {};
                const streamUrl = tags['contact:webcam'] || tags.url || tags.webcam;
                return {
                    source: 'osm', lat: el.lat, lon: el.lon,
                    streamUrl: streamUrl,
                    streamType: detectStreamType(streamUrl),
                    cameraType: tags['surveillance:type'] || tags['camera:type'] || 'Webcam',
                    operator: tags.operator || tags.name || 'Unknown',
                    indoor: tags['surveillance:zone'] === 'indoor',
                    osmId: el.id
                };
            });
        } catch (err) {
            console.error('[Cameras] OSM fetch error:', err);
            return null;
        }
    }

    async function fetchWindyWebcams(bounds) {
        if (!isConfigured('windyWebcamApiKey')) return null;
        try {
            const params = new URLSearchParams({
                nearby: `${((bounds.south + bounds.north) / 2).toFixed(4)},${((bounds.west + bounds.east) / 2).toFixed(4)},250`,
                limit: '50',
                include: 'player,location'
            });
            const url = `${WINDY_PROXY}?${params.toString()}`;
            console.log('[Cameras] Windy Webcams request via proxy');
            const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
            if (!response.ok) {
                console.warn('[Cameras] Windy Webcams returned status:', response.status);
                return null;
            }
            const data = await response.json();
            const webcams = data.webcams || data.result?.webcams || [];
            if (webcams.length === 0) {
                console.log('[Cameras] Windy returned 0 webcams in this area.');
                return null;
            }
            return webcams
                .filter(wc => {
                    const loc = wc.location || wc.position || {};
                    const lat = loc.latitude || loc.lat;
                    const lon = loc.longitude || loc.lon;
                    if (lat == null || lon == null) return false;
                    return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
                })
                .map(wc => {
                    const loc = wc.location || wc.position || {};
                    const lat = loc.latitude || loc.lat;
                    const lon = loc.longitude || loc.lon;
                    const playerUrl = wc.player?.day?.embed || wc.player?.lifetime?.embed || wc.player?.month?.embed || null;
                    return {
                        source: 'windy', lat: lat, lon: lon,
                        streamUrl: playerUrl, streamType: 'iframe',
                        cameraType: 'Webcam',
                        operator: wc.title || 'Windy Webcam',
                        indoor: false, windyId: wc.id || wc.webcamId
                    };
                });
        } catch (err) {
            console.error('[Cameras] Windy Webcams error:', err);
            return null;
        }
    }

    function isStreamUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const lower = url.toLowerCase();
        if (lower.includes('.mjpg') || lower.includes('.mjpeg') || lower.includes('mjpg')) return true;
        if (lower.includes('.m3u8') || lower.includes('hls')) return true;
        if (lower.startsWith('rtsp://') || lower.startsWith('rtmp://')) return true;
        if (lower.includes('webcam') || lower.includes('camera') || lower.includes('stream') || lower.includes('live')) return true;
        if (lower.startsWith('http://') || lower.startsWith('https://')) return true;
        return false;
    }

    function detectStreamType(url) {
        if (!url) return 'unknown';
        const lower = url.toLowerCase();
        if (lower.includes('.mjpg') || lower.includes('.mjpeg') || lower.includes('mjpg')) return 'mjpeg';
        if (lower.includes('.m3u8')) return 'hls';
        if (lower.startsWith('rtsp://') || lower.startsWith('rtmp://')) return 'rtsp';
        return 'iframe';
    }

    function renderCameras(cameras) {
        clearEntities();
        cameras.forEach(cam => {
            if (cam.lat == null || cam.lon == null) return;
            const icon = cam.source === 'windy' ? windyCameraIcon : (cam.source === 'gdot' ? osmCameraIcon : osmCameraIcon);
            const entity = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, 10),
                billboard: {
                    image: icon, scale: 0.8,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                    disableDepthTestDistance: 0,
                    color: cam.source === 'gdot' ? Cesium.Color.ORANGE : Cesium.Color.WHITE
                },
                properties: {
                    type: 'camera', source: cam.source,
                    cameraType: cam.cameraType, operator: cam.operator,
                    streamUrl: cam.streamUrl, streamType: cam.streamType,
                    indoor: cam.indoor, osmId: cam.osmId || null,
                    windyId: cam.windyId || null,
                    lat: cam.lat, lon: cam.lon,
                    originalUrl: cam.originalUrl || null // Pass this through
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
        const streamUrl = props.streamUrl ? props.streamUrl.getValue() : null;
        const streamType = props.streamType ? props.streamType.getValue() : 'unknown';
        const source = props.source ? props.source.getValue() : 'unknown';
        const originalUrl = props.originalUrl ? props.originalUrl.getValue() : streamUrl; // Fallback to streamUrl
        let lat = props.lat ? props.lat.getValue() : null;
        let lon = props.lon ? props.lon.getValue() : null;
        const rows = [
            { key: 'TYPE', value: props.cameraType ? props.cameraType.getValue() : 'Unknown', class: 'highlight' },
            { key: 'OPERATOR', value: props.operator ? props.operator.getValue() : 'Unknown' },
            { key: 'SOURCE', value: source === 'windy' ? 'Windy Webcams' : (source === 'gdot' ? 'GDOT 511' : 'OpenStreetMap') },
            { key: 'ZONE', value: props.indoor && props.indoor.getValue() ? 'INDOOR' : 'OUTDOOR' },
            { key: 'STREAM', value: streamUrl ? streamType.toUpperCase() : 'Not available', class: streamUrl ? 'highlight' : '' }
        ];
        if (streamUrl) {
            rows.push({ key: 'URL', value: streamUrl.length > 50 ? streamUrl.substring(0, 50) + '...' : streamUrl });
        }
        const capturedLat = lat;
        const capturedLon = lon;
        const capturedUrl = streamUrl;
        const capturedType = streamType;
        const capturedOriginal = originalUrl;
        rows.push({
            type: 'button', label: 'VIEW FEED',
            onclick: () => { openFeedViewer(capturedUrl, capturedType, capturedLat, capturedLon, capturedOriginal); }
        });
        WorldViewHUD.showPopup('\u25CE SURVEILLANCE CAMERA', rows);
    }

    function openFeedViewer(url, streamType, lat, lon, originalUrl) {
        const modal = document.getElementById('camera-feed-modal');
        const iframeContainer = document.getElementById('feed-iframe-container');
        const iframe = document.getElementById('feed-iframe');
        const svContainer = document.getElementById('feed-streetview-container');
        const svImg = document.getElementById('feed-streetview-img');
        const unavailEl = document.getElementById('feed-unavailable');
        const loadingEl = document.getElementById('feed-loading');
        const statusEl = document.getElementById('feed-modal-status');
        const externalBtn = document.getElementById('feed-open-external');

        if (!modal) return;
        
        iframeContainer.classList.add('hidden');
        svContainer.classList.add('hidden');
        unavailEl.classList.add('hidden');
        loadingEl.classList.remove('hidden');
        iframe.src = '';
        svImg.src = '';
        
        const existingMjpeg = iframeContainer.querySelector('.mjpeg-feed-img');
        if (existingMjpeg) existingMjpeg.remove();
        const existingVideo = iframeContainer.querySelector('.hls-feed-video');
        if (existingVideo) existingVideo.remove();

        // Setup external button
        if (externalBtn) {
            const targetUrl = originalUrl || url;
            if (targetUrl) {
                externalBtn.style.display = 'flex';
                externalBtn.onclick = () => window.open(targetUrl, '_blank');
            } else {
                externalBtn.style.display = 'none';
            }
        }
        
        modal.classList.remove('hidden');

        if (url && streamType === 'mjpeg') {
            statusEl.textContent = 'MJPEG STREAM: ' + url.substring(0, 60) + (url.length > 60 ? '...' : '');
            loadingEl.classList.add('hidden');
            const proxyUrl = '/api/proxy-stream?url=' + encodeURIComponent(url);
            const mjpegImg = document.createElement('img');
            mjpegImg.className = 'mjpeg-feed-img';
            mjpegImg.style.cssText = 'width:100%;height:100%;object-fit:contain;';
            mjpegImg.src = proxyUrl;
            mjpegImg.onerror = () => {
                mjpegImg.remove();
                tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
            };
            iframeContainer.classList.remove('hidden');
            iframeContainer.appendChild(mjpegImg);
        } else if (url && streamType === 'hls') {
            statusEl.textContent = 'HLS STREAM: ' + url.substring(0, 60) + (url.length > 60 ? '...' : '');
            loadingEl.classList.add('hidden');
            const proxyUrl = '/api/proxy-stream?url=' + encodeURIComponent(url);
            const video = document.createElement('video');
            video.className = 'hls-feed-video';
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;';
            video.controls = true;
            video.autoplay = true;
            video.muted = true;
            iframeContainer.classList.remove('hidden');
            iframeContainer.appendChild(video);
            if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                const hls = new Hls();
                hls.loadSource(proxyUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.ERROR, (event, data) => {
                    console.warn('[Cameras] HLS.js error:', data);
                    video.remove();
                    tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = proxyUrl;
                video.onerror = () => {
                    video.remove();
                    tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
                };
            } else {
                video.remove();
                statusEl.textContent = 'HLS not supported \u2014 trying iframe...';
                loadIframePlayer(url, iframeContainer, iframe, loadingEl, statusEl, lat, lon, svContainer, svImg, unavailEl);
            }
        } else if (url) {
            loadIframePlayer(url, iframeContainer, iframe, loadingEl, statusEl, lat, lon, svContainer, svImg, unavailEl);
        } else if (lat != null && lon != null) {
            statusEl.textContent = 'NO STREAM URL \u2014 LOADING STREET VIEW...';
            tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
        } else {
            loadingEl.classList.add('hidden');
            unavailEl.classList.remove('hidden');
            statusEl.textContent = 'NO FEED DATA AVAILABLE';
        }
    }

    function loadIframePlayer(url, iframeContainer, iframe, loadingEl, statusEl, lat, lon, svContainer, svImg, unavailEl, openExternalBtn) {
        statusEl.textContent = 'SOURCE: ' + url.substring(0, 60) + (url.length > 60 ? '...' : '');
        iframeContainer.classList.remove('hidden');
        loadingEl.classList.add('hidden');
        
        // Setup external button if available
        if (openExternalBtn) {
            openExternalBtn.onclick = () => window.open(url, '_blank');
            openExternalBtn.style.display = 'flex'; // Show it
        }

        iframe.onerror = () => {
            console.warn('[Cameras] Feed iframe failed to load:', url);
            iframeContainer.classList.add('hidden');
            tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl);
        };
        let iframeLoadTimeout = setTimeout(() => {
            console.log('[Cameras] Feed iframe timeout \u2014 showing as-is.');
        }, 8000);
        iframe.onload = () => {
            clearTimeout(iframeLoadTimeout);
            loadingEl.classList.add('hidden');
            console.log('[Cameras] Feed iframe loaded.');
        };
        iframe.src = url;
    }

    function tryStreetView(lat, lon, svContainer, svImg, unavailEl, loadingEl, statusEl) {
        if (lat == null || lon == null) {
            loadingEl.classList.add('hidden');
            unavailEl.classList.remove('hidden');
            statusEl.textContent = 'NO LOCATION DATA AVAILABLE';
            return;
        }
        const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${lat},${lon}&heading=0&pitch=0&fov=90&key=`;
        statusEl.textContent = `STREET VIEW: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        svImg.onload = () => {
            loadingEl.classList.add('hidden');
            svContainer.classList.remove('hidden');
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

    function setupFeedModalClose() {
        const closeBtn = document.getElementById('feed-modal-close');
        if (closeBtn) { closeBtn.addEventListener('click', closeFeedViewer); }
        const modal = document.getElementById('camera-feed-modal');
        if (modal) {
            const backdrop = modal.querySelector('.feed-modal-backdrop');
            if (backdrop) { backdrop.addEventListener('click', closeFeedViewer); }
        }
    }

    function closeFeedViewer() {
        const modal = document.getElementById('camera-feed-modal');
        const iframe = document.getElementById('feed-iframe');
        if (modal) modal.classList.add('hidden');
        if (iframe) iframe.src = '';
        if (modal) {
            const mjpeg = modal.querySelector('.mjpeg-feed-img');
            if (mjpeg) mjpeg.remove();
            const hlsVideo = modal.querySelector('.hls-feed-video');
            if (hlsVideo) { hlsVideo.pause(); hlsVideo.src = ''; hlsVideo.remove(); }
        }
    }

    function clearEntities() {
        cameraEntities.forEach(e => viewer.entities.remove(e));
        cameraEntities = [];
    }

    function setVisible(v) {
        visible = v;
        cameraEntities.forEach(e => e.show = v);
        if (!v) { WorldViewHUD.updateCounter('cameras', 0); }
        else {
            WorldViewHUD.updateCounter('cameras', cameraCount);
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
