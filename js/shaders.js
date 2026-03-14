/* ========================================
   WorldView - Post-Processing Shader Modes
   Night Vision, FLIR Thermal, CRT Scanlines
   ======================================== */

const WorldViewShaders = (() => {
    'use strict';

    let viewer = null;
    let activeShader = 'normal';
    let nvgStage = null;
    let flirStage = null;
    let crtStage = null;

    // Night Vision (NVG) - Green tint with grain and vignette
    const NVG_FRAGMENT_SHADER = `
        uniform sampler2D colorTexture;
        uniform float time;
        in vec2 v_textureCoordinates;

        // Pseudo-random noise
        float rand(vec2 co) {
            return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            vec4 color = texture(colorTexture, v_textureCoordinates);

            // Convert to luminance
            float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));

            // Green tint with slight blue
            vec3 nvg = vec3(lum * 0.1, lum * 1.2, lum * 0.15);

            // Film grain noise (animated)
            float grain = rand(v_textureCoordinates * 500.0 + vec2(time * 7.0, time * 13.0)) * 0.12;
            nvg += vec3(grain * 0.1, grain * 0.15, grain * 0.05);

            // Vignette
            vec2 uv = v_textureCoordinates;
            float vignette = 1.0 - smoothstep(0.4, 1.0, length(uv - 0.5) * 1.3);
            nvg *= vignette;

            // Slight brightness boost
            nvg *= 1.3;

            out_FragColor = vec4(nvg, 1.0);
        }
    `;

    // FLIR Thermal - Heat map palette
    const FLIR_FRAGMENT_SHADER = `
        uniform sampler2D colorTexture;
        in vec2 v_textureCoordinates;

        vec3 heatmap(float t) {
            // Black -> Blue -> Magenta -> Red -> Yellow -> White
            vec3 c;
            if (t < 0.2) {
                c = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.8), t / 0.2);
            } else if (t < 0.4) {
                c = mix(vec3(0.0, 0.0, 0.8), vec3(0.8, 0.0, 0.8), (t - 0.2) / 0.2);
            } else if (t < 0.6) {
                c = mix(vec3(0.8, 0.0, 0.8), vec3(1.0, 0.2, 0.0), (t - 0.4) / 0.2);
            } else if (t < 0.8) {
                c = mix(vec3(1.0, 0.2, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.6) / 0.2);
            } else {
                c = mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 1.0, 1.0), (t - 0.8) / 0.2);
            }
            return c;
        }

        void main() {
            // Slight blur by sampling neighbors
            vec2 texelSize = 1.0 / vec2(textureSize(colorTexture, 0));
            vec4 color = vec4(0.0);
            for (int x = -1; x <= 1; x++) {
                for (int y = -1; y <= 1; y++) {
                    color += texture(colorTexture, v_textureCoordinates + vec2(float(x), float(y)) * texelSize);
                }
            }
            color /= 9.0;

            // Luminance
            float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));

            // Apply thermal palette
            vec3 thermal = heatmap(clamp(lum, 0.0, 1.0));

            out_FragColor = vec4(thermal, 1.0);
        }
    `;

    // CRT Scanlines - Retro monitor effect
    const CRT_FRAGMENT_SHADER = `
        uniform sampler2D colorTexture;
        uniform float time;
        in vec2 v_textureCoordinates;

        vec2 barrelDistortion(vec2 uv) {
            vec2 centered = uv - 0.5;
            float r2 = dot(centered, centered);
            float distortion = 1.0 + r2 * 0.15 + r2 * r2 * 0.05;
            return centered * distortion + 0.5;
        }

        void main() {
            // Barrel distortion
            vec2 uv = barrelDistortion(v_textureCoordinates);

            // Out of bounds check
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
                out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            // RGB fringing (chromatic aberration)
            float aberration = 0.002;
            vec2 dir = normalize(uv - 0.5) * aberration;
            float r = texture(colorTexture, uv + dir).r;
            float g = texture(colorTexture, uv).g;
            float b = texture(colorTexture, uv - dir).b;
            vec3 color = vec3(r, g, b);

            // Scanlines
            float scanline = sin(uv.y * 800.0) * 0.08;
            color -= scanline;

            // Moving scanline bar
            float bar = smoothstep(0.0, 0.02, abs(fract(uv.y - time * 0.05) - 0.5));
            color *= 0.85 + 0.15 * bar;

            // Vignette
            float vignette = 1.0 - smoothstep(0.45, 0.95, length(uv - 0.5) * 1.2);
            color *= vignette;

            // Slight green tint for CRT feel
            color *= vec3(0.95, 1.0, 0.92);

            // Brightness
            color *= 1.1;

            out_FragColor = vec4(color, 1.0);
        }
    `;

    let startTime = Date.now();

    function init(cesiumViewer) {
        viewer = cesiumViewer;
        startTime = Date.now();
        console.log('[Shaders] Initializing post-processing stages...');
        console.log('[Shaders] PostProcessStages available:', !!viewer.scene.postProcessStages);

        try {
            // Create NVG stage
            nvgStage = new Cesium.PostProcessStage({
                name: 'nvg',
                fragmentShader: NVG_FRAGMENT_SHADER,
                uniforms: {
                    time: function() {
                        return (Date.now() - startTime) / 1000.0;
                    }
                }
            });
            nvgStage.enabled = false;
            viewer.scene.postProcessStages.add(nvgStage);

            // Create FLIR stage
            flirStage = new Cesium.PostProcessStage({
                name: 'flir',
                fragmentShader: FLIR_FRAGMENT_SHADER
            });
            flirStage.enabled = false;
            viewer.scene.postProcessStages.add(flirStage);

            // Create CRT stage
            crtStage = new Cesium.PostProcessStage({
                name: 'crt',
                fragmentShader: CRT_FRAGMENT_SHADER,
                uniforms: {
                    time: function() {
                        return (Date.now() - startTime) / 1000.0;
                    }
                }
            });
            crtStage.enabled = false;
            viewer.scene.postProcessStages.add(crtStage);

            console.log('[Shaders] All post-processing stages created.');
        } catch (err) {
            console.error('[Shaders] Error creating post-process stages:', err);
        }
    }

    function setMode(mode) {
        if (!viewer) return;

        activeShader = mode;

        // Disable all
        if (nvgStage) nvgStage.enabled = false;
        if (flirStage) flirStage.enabled = false;
        if (crtStage) crtStage.enabled = false;

        switch (mode) {
            case 'nvg':
                if (nvgStage) nvgStage.enabled = true;
                console.log('[Shaders] Night Vision mode activated.');
                break;
            case 'flir':
                if (flirStage) flirStage.enabled = true;
                console.log('[Shaders] FLIR Thermal mode activated.');
                break;
            case 'crt':
                if (crtStage) crtStage.enabled = true;
                console.log('[Shaders] CRT Scanlines mode activated.');
                break;
            default:
                console.log('[Shaders] Normal mode (no post-processing).');
                break;
        }
    }

    function getActiveMode() {
        return activeShader;
    }

    return { init, setMode, getActiveMode };
})();
