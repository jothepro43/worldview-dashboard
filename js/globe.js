/* ========================================
   WorldView - CesiumJS Globe + Google 3D Tiles
   ======================================== */

const WorldViewGlobe = (() => {
    'use strict';

    let viewer = null;
    let google3DTileset = null;
    let hasGlobe = false; // Track whether a globe/tileset is active

    async function init(config) {
        console.log('[Globe] Initializing CesiumJS viewer...');
        console.log('[Globe] Cesium version:', Cesium.VERSION);

        // Set Cesium Ion token
        if (config.cesiumIonToken && config.cesiumIonToken !== 'YOUR_CESIUM_ION_TOKEN') {
            Cesium.Ion.defaultAccessToken = config.cesiumIonToken;
            console.log('[Globe] Cesium Ion token configured.');
        } else {
            console.warn('[Globe] WARNING: No Cesium Ion token set! Some features will not work.');
            console.warn('[Globe] Get a free token at: https://cesium.com/ion/tokens');
        }

        // Set Google Maps API key for CesiumJS
        if (config.googleMapsApiKey && config.googleMapsApiKey !== 'YOUR_GOOGLE_MAPS_API_KEY') {
            Cesium.GoogleMaps.defaultApiKey = config.googleMapsApiKey;
            console.log('[Globe] Google Maps API key configured.');
        } else {
            console.warn('[Globe] WARNING: No Google Maps API key set! 3D Tiles will not load.');
            console.warn('[Globe] Get a key at: https://developers.google.com/maps/documentation/tile');
        }

        // Create viewer with minimal UI
        // Start WITHOUT globe — we'll add Google 3D Tiles or fall back
        console.log('[Globe] Creating Cesium Viewer...');
        try {
            viewer = new Cesium.Viewer('cesiumContainer', {
                baseLayerPicker: false,
                geocoder: false,
                homeButton: false,
                sceneModePicker: false,
                selectionIndicator: false,
                infoBox: false,
                timeline: false,
                animation: false,
                navigationHelpButton: false,
                navigationInstructionsInitiallyVisible: false,
                fullscreenButton: false,
                vrButton: false,
                globe: false, // Disable default globe — Google 3D Tiles replaces it
                skyBox: false,
                skyAtmosphere: false,
                orderIndependentTranslucency: true,
                contextOptions: {
                    webgl: {
                        alpha: true
                    }
                },
                msaaSamples: 2
            });
            console.log('[Globe] Viewer created successfully.');
        } catch (viewerErr) {
            console.error('[Globe] FATAL: Failed to create Cesium Viewer:', viewerErr);
            throw viewerErr;
        }

        // Dark background
        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0a0f');

        // IMPORTANT: When globe:false, viewer.imageryLayers does NOT exist.
        // Only call removeAll() if imageryLayers is defined.
        if (viewer.imageryLayers) {
            console.log('[Globe] Removing default imagery layers...');
            viewer.imageryLayers.removeAll();
        } else {
            console.log('[Globe] No imagery layers to remove (globe:false mode).');
        }

        // Load Google Photorealistic 3D Tiles
        try {
            console.log('[Globe] Attempting to load Google Photorealistic 3D Tiles...');
            google3DTileset = await Cesium.createGooglePhotorealistic3DTileset(undefined, {
                showCreditsOnScreen: true
            });
            viewer.scene.primitives.add(google3DTileset);
            hasGlobe = true;
            console.log('[Globe] Google Photorealistic 3D Tiles loaded successfully!');
        } catch (err) {
            console.warn('[Globe] Could not load Google 3D Tiles:', err.message || err);
            console.log('[Globe] Falling back to standard Cesium globe with imagery...');

            // Fallback: re-enable globe with basic imagery
            try {
                const globe = new Cesium.Globe(Cesium.Ellipsoid.WGS84);
                globe.baseColor = Cesium.Color.fromCssColorString('#0d1117');
                globe.enableLighting = false;
                globe.showGroundAtmosphere = false;
                viewer.scene.globe = globe;
                hasGlobe = true;
                console.log('[Globe] Fallback globe created.');

                // Try loading Cesium Ion dark imagery
                try {
                    const provider = await Cesium.IonImageryProvider.fromAssetId(3845);
                    viewer.imageryLayers.addImageryProvider(provider);
                    console.log('[Globe] Cesium Ion dark imagery loaded.');
                } catch (imageryErr) {
                    console.warn('[Globe] Cesium Ion imagery failed, trying OSM...', imageryErr.message);
                    // Fallback to OpenStreetMap
                    try {
                        const osmProvider = new Cesium.OpenStreetMapImageryProvider({
                            url: 'https://tile.openstreetmap.org/'
                        });
                        viewer.imageryLayers.addImageryProvider(osmProvider);
                        console.log('[Globe] OpenStreetMap imagery loaded as fallback.');
                    } catch (osmErr) {
                        console.warn('[Globe] All imagery fallbacks failed:', osmErr.message);
                    }
                }
            } catch (fallbackErr) {
                console.error('[Globe] CRITICAL: Could not create fallback globe:', fallbackErr);
                // Absolute last resort — create bare globe
                try {
                    viewer.scene.globe = new Cesium.Globe(Cesium.Ellipsoid.WGS84);
                    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1117');
                    hasGlobe = true;
                    console.log('[Globe] Bare globe created as last resort.');
                } catch (lastErr) {
                    console.error('[Globe] Even bare globe creation failed:', lastErr);
                }
            }
        }

        // Set initial camera position - Earth overview
        console.log('[Globe] Setting initial camera position...');
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(-40, 20, 20000000),
            orientation: {
                heading: 0,
                pitch: -Math.PI / 2,
                roll: 0
            }
        });

        // Enable sun and moon (safe regardless of globe state)
        try {
            viewer.scene.sun = new Cesium.Sun();
            viewer.scene.moon = new Cesium.Moon();
        } catch (celestialErr) {
            console.warn('[Globe] Could not set sun/moon:', celestialErr.message);
        }

        // Performance settings — fog only exists if globe exists
        if (viewer.scene.globe) {
            viewer.scene.globe.depthTestAgainstTerrain = true;
            viewer.scene.fog.enabled = false;
            console.log('[Globe] Globe depth testing and fog configured.');
        } else {
            console.log('[Globe] No globe object — skipping globe-specific settings.');
        }

        viewer.scene.debugShowFramesPerSecond = false;
        viewer.resolutionScale = window.devicePixelRatio > 1 ? 0.8 : 1.0;

        console.log('[Globe] \u2713 Viewer initialization complete.');
        console.log(`[Globe] Has globe/tileset: ${hasGlobe}`);
        console.log(`[Globe] Scene primitives count: ${viewer.scene.primitives.length}`);
        return viewer;
    }

    function getViewer() {
        return viewer;
    }

    function flyTo(longitude, latitude, altitude = 1500000) {
        if (!viewer) return;
        console.log(`[Globe] Flying to: ${latitude.toFixed(4)}, ${longitude.toFixed(4)} @ ${(altitude/1000).toFixed(0)}km`);
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
            duration: 2.0,
            orientation: {
                heading: 0,
                pitch: Cesium.Math.toRadians(-60),
                roll: 0
            }
        });
    }

    function getCameraPosition() {
        if (!viewer) return null;
        try {
            const carto = viewer.camera.positionCartographic;
            return {
                lat: Cesium.Math.toDegrees(carto.latitude),
                lon: Cesium.Math.toDegrees(carto.longitude),
                alt: carto.height
            };
        } catch (e) {
            return null;
        }
    }

    function getViewportBounds() {
        if (!viewer) return null;

        try {
            const canvas = viewer.scene.canvas;
            const corners = [
                new Cesium.Cartesian2(0, 0),
                new Cesium.Cartesian2(canvas.width, 0),
                new Cesium.Cartesian2(0, canvas.height),
                new Cesium.Cartesian2(canvas.width, canvas.height)
            ];

            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            let validCorners = 0;

            corners.forEach(corner => {
                try {
                    const ray = viewer.camera.getPickRay(corner);
                    if (!ray) return;

                    let position = null;
                    // Try globe pick first, then scene pick
                    if (viewer.scene.globe) {
                        position = viewer.scene.globe.pick(ray, viewer.scene);
                    }
                    if (!position) {
                        position = viewer.scene.pickPosition(corner);
                    }

                    if (position) {
                        const carto = Cesium.Cartographic.fromCartesian(position);
                        if (carto) {
                            const lat = Cesium.Math.toDegrees(carto.latitude);
                            const lon = Cesium.Math.toDegrees(carto.longitude);
                            minLat = Math.min(minLat, lat);
                            maxLat = Math.max(maxLat, lat);
                            minLon = Math.min(minLon, lon);
                            maxLon = Math.max(maxLon, lon);
                            validCorners++;
                        }
                    }
                } catch (e) {
                    // Skip this corner
                }
            });

            if (validCorners < 2) {
                // Fallback: compute bounds from camera position
                const pos = getCameraPosition();
                if (pos) {
                    const spread = Math.max(0.5, pos.alt / 111000); // degrees based on altitude
                    return {
                        south: pos.lat - spread,
                        north: pos.lat + spread,
                        west: pos.lon - spread,
                        east: pos.lon + spread
                    };
                }
                return null;
            }
            return { south: minLat, north: maxLat, west: minLon, east: maxLon };
        } catch (e) {
            console.warn('[Globe] Error computing viewport bounds:', e.message);
            return null;
        }
    }

    return { init, getViewer, flyTo, getCameraPosition, getViewportBounds };
})();
