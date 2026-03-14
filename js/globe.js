/* ========================================
   WorldView - CesiumJS Globe + Google 3D Tiles
   ======================================== */

const WorldViewGlobe = (() => {
    'use strict';

    let viewer = null;
    let google3DTileset = null;

    async function init(config) {
        console.log('[Globe] Initializing CesiumJS viewer...');

        // Set Cesium Ion token
        Cesium.Ion.defaultAccessToken = config.cesiumIonToken || 'YOUR_CESIUM_ION_TOKEN';

        // Create viewer with minimal UI
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
            globe: false, // Disable default globe since Google 3D Tiles replace it
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

        // Dark background
        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0a0f');

        // Remove default image layer if any
        viewer.imageryLayers.removeAll();

        // Enable depth testing against terrain
        viewer.scene.globe && (viewer.scene.globe.depthTestAgainstTerrain = true);

        // Load Google Photorealistic 3D Tiles
        try {
            console.log('[Globe] Loading Google Photorealistic 3D Tiles...');
            google3DTileset = await Cesium.createGooglePhotorealistic3DTileset(undefined, {
                showCreditsOnScreen: true
            });
            viewer.scene.primitives.add(google3DTileset);
            console.log('[Globe] Google 3D Tiles loaded successfully.');
        } catch (err) {
            console.warn('[Globe] Could not load Google 3D Tiles. Falling back to standard imagery.', err);
            // Fallback: re-enable globe with basic imagery
            try {
                viewer.scene.globe = new Cesium.Globe(Cesium.Ellipsoid.WGS84);
                viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1117');
                viewer.scene.globe.enableLighting = false;
                const imagery = Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(3845) // Cesium dark imagery
                );
                viewer.imageryLayers.add(imagery);
                console.log('[Globe] Fallback imagery loaded.');
            } catch (fallbackErr) {
                console.warn('[Globe] Fallback imagery also failed:', fallbackErr);
                // Last resort: just show the globe with default
                viewer.scene.globe = new Cesium.Globe(Cesium.Ellipsoid.WGS84);
                viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1117');
            }
        }

        // Set initial camera position - Earth overview
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(-40, 20, 20000000),
            orientation: {
                heading: 0,
                pitch: -Math.PI / 2,
                roll: 0
            }
        });

        // Enable shadows for nice effect
        viewer.scene.sun = new Cesium.Sun();
        viewer.scene.moon = new Cesium.Moon();

        // Performance settings
        viewer.scene.fog.enabled = false;
        viewer.scene.debugShowFramesPerSecond = false;
        viewer.resolutionScale = window.devicePixelRatio > 1 ? 0.8 : 1.0;

        console.log('[Globe] Viewer initialized successfully.');
        return viewer;
    }

    function getViewer() {
        return viewer;
    }

    function flyTo(longitude, latitude, altitude = 1500000) {
        if (!viewer) return;
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
        const carto = viewer.camera.positionCartographic;
        return {
            lat: Cesium.Math.toDegrees(carto.latitude),
            lon: Cesium.Math.toDegrees(carto.longitude),
            alt: carto.height
        };
    }

    function getViewportBounds() {
        if (!viewer) return null;
        const canvas = viewer.scene.canvas;
        const ellipsoid = Cesium.Ellipsoid.WGS84;

        const corners = [
            new Cesium.Cartesian2(0, 0),
            new Cesium.Cartesian2(canvas.width, 0),
            new Cesium.Cartesian2(0, canvas.height),
            new Cesium.Cartesian2(canvas.width, canvas.height)
        ];

        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        let validCorners = 0;

        corners.forEach(corner => {
            const ray = viewer.camera.getPickRay(corner);
            if (!ray) return;
            const position = viewer.scene.globe
                ? viewer.scene.globe.pick(ray, viewer.scene)
                : viewer.scene.pickPosition(corner);
            if (position) {
                const carto = Cesium.Cartographic.fromCartesian(position);
                const lat = Cesium.Math.toDegrees(carto.latitude);
                const lon = Cesium.Math.toDegrees(carto.longitude);
                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
                minLon = Math.min(minLon, lon);
                maxLon = Math.max(maxLon, lon);
                validCorners++;
            }
        });

        if (validCorners < 2) return null;
        return { south: minLat, north: maxLat, west: minLon, east: maxLon };
    }

    return { init, getViewer, flyTo, getCameraPosition, getViewportBounds };
})();
