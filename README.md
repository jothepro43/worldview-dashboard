# WorldView - Geospatial Intelligence Dashboard

![WorldView Banner](https://img.shields.io/badge/WorldView-Geospatial%20Intelligence-00f0ff?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMGYwZmYiIHN0cm9rZS13aWR0aD0iMiI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMiIgeTE9IjEyIiB4Mj0iMjIiIHkyPSIxMiIvPjxwYXRoIGQ9Ik0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIvPjwvc3ZnPg==)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)](https://nodejs.org)
[![CesiumJS](https://img.shields.io/badge/CesiumJS-1.124-blue)](https://cesium.com)

A browser-based geospatial intelligence dashboard built with **CesiumJS** and **Google Photorealistic 3D Tiles**. Track aircraft, satellites, earthquakes, severe weather, and surveillance cameras in real-time on a 3D globe with military-style HUD controls and post-processing shader effects.

![Screenshot Placeholder](https://via.placeholder.com/1200x600/0a0a0f/00f0ff?text=WorldView+Dashboard+Screenshot)

---

## Features

### Globe & Visualization
- **Photorealistic 3D Globe** - Google Photorealistic 3D Tiles via CesiumJS
- **4 Render Modes** - Normal, Night Vision (NVG), FLIR Thermal, CRT Scanlines
- **Dark HUD Interface** - Military/intelligence aesthetic with glassmorphism panels
- **Location Search** - Search any city or location with geocoding

### Real-Time Data Layers
- **Aircraft Tracking** - Live ADS-B data from OpenSky Network (10s refresh)
  - Civilian aircraft (cyan) and military identification (red)
  - Heading-aligned aircraft icons
  - Click for callsign, altitude, speed, heading details
- **Satellite Tracking** - 2,000+ satellites with real-time orbital computation
  - TLE data from CelesTrak (ISS, Starlink, GPS, active satellites)
  - Real-time position calculation using satellite.js
  - Click to see orbit path, altitude, velocity, period
- **Earthquake Monitoring** - USGS real-time earthquake feed
  - Magnitude-scaled circles with depth-based coloring
  - Pulsing indicators for significant events (M4+)
  - Labels for major earthquakes (M5+)
- **Weather Events** - NASA EONET natural events + NWS severe weather alerts
  - Wildfires, volcanoes, storms, floods, icebergs
  - NWS alert polygons color-coded by severity
- **Surveillance Cameras** - OpenStreetMap Overpass API
  - Viewport-based loading (cameras load as you zoom in)
  - Camera type, operator, and stream URL (when available)

### HUD Controls
- **Live Counters** - Aircraft, Satellites, Events, Cameras
- **Layer Toggles** - Enable/disable each data layer
- **System Status** - UTC time, camera position, altitude
- **Entity Popups** - Click any entity for detailed information

---

## Setup Instructions

### Prerequisites
- [Node.js](https://nodejs.org) v18 or later
- A modern web browser (Chrome, Firefox, Edge)

### 1. Clone the Repository
```bash
git clone https://github.com/jothepro43/worldview-dashboard.git
cd worldview-dashboard
```

### 2. Get API Keys

#### Cesium Ion Token (Required)
1. Create a free account at [cesium.com](https://cesium.com/ion/signup)
2. Go to [Access Tokens](https://cesium.com/ion/tokens)
3. Copy your default token or create a new one

#### Google Maps API Key (Recommended)
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable **Map Tiles API** from the APIs library
4. Go to Credentials > Create Credentials > API Key
5. Copy the API key

### 3. Configure API Keys
Edit `js/app.js` and replace the placeholder values:
```javascript
const CONFIG = {
    cesiumIonToken: 'YOUR_ACTUAL_CESIUM_ION_TOKEN',
    googleMapsApiKey: 'YOUR_ACTUAL_GOOGLE_MAPS_API_KEY'
};
```

### 4. Install Dependencies
```bash
npm install
```

### 5. Start the Server
```bash
npm start
```

### 6. Open the Dashboard
Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

---

## Project Structure

```
worldview-dashboard/
├── index.html            # Main entry point
├── css/
│   └── style.css         # Dark HUD styling with glassmorphism
├── js/
│   ├── app.js            # Main application init & config
│   ├── globe.js          # CesiumJS viewer & Google 3D Tiles
│   ├── shaders.js        # Post-processing shader modes (NVG/FLIR/CRT)
│   ├── hud.js            # HUD controls, search, layer toggles, counters
│   ├── flights.js        # OpenSky Network aircraft tracking
│   ├── satellites.js     # TLE data + satellite.js orbital computation
│   ├── earthquakes.js    # USGS earthquake events
│   ├── weather.js        # NASA EONET + NWS alerts
│   └── cameras.js        # OSM Overpass surveillance cameras
├── server/
│   └── proxy.js          # Node.js Express CORS proxy
├── assets/               # Icon assets (generated via Canvas API)
├── package.json          # Node.js dependencies
└── README.md             # This file
```

---

## API Sources

| Layer | Source | Update Interval |
|-------|--------|----------------|
| Aircraft | [OpenSky Network](https://opensky-network.org/apidoc/) | 10 seconds |
| Satellites | [CelesTrak](https://celestrak.org) + [satellite.js](https://github.com/shashwatak/satellite-js) | 1 second (client-side) |
| Earthquakes | [USGS Earthquake API](https://earthquake.usgs.gov/fdsnws/event/1/) | 5 minutes |
| Natural Events | [NASA EONET v3](https://eonet.gsfc.nasa.gov/docs/v3) | 5 minutes |
| Weather Alerts | [NWS API](https://www.weather.gov/documentation/services-web-api) | 5 minutes |
| Cameras | [OSM Overpass API](https://overpass-api.de/) | On viewport change |
| Geocoding | [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/) | On search |

---

## Shader Modes

| Mode | Description |
|------|-------------|
| **Normal** | Default photorealistic view |
| **NVG (Night Vision)** | Green phosphor tint, film grain noise, vignette |
| **FLIR (Thermal)** | Black-body radiation heat-map palette |
| **CRT (Scanlines)** | Retro monitor with scanlines, barrel distortion, RGB fringing |

---

## Performance Notes

- Aircraft use `BillboardCollection` for efficient batch rendering
- Satellites use `PointPrimitiveCollection` for rendering thousands of points
- Satellite positions are computed client-side with `satellite.js` (no API calls after initial TLE fetch)
- Cameras use viewport-based loading with debouncing to avoid excessive queries
- NWS alerts are limited to 200 for rendering performance

---

## Troubleshooting

- **"YOUR_CESIUM_ION_TOKEN" warning** - You need to set your Cesium Ion token in `js/app.js`
- **Globe shows dark/blank** - The Google 3D Tiles require both a Cesium Ion token and a Google Maps API key with Map Tiles API enabled
- **No aircraft data** - OpenSky Network may rate-limit unauthenticated requests. The proxy server helps with this.
- **CORS errors** - Make sure you're accessing the app through the proxy server (http://localhost:3000), not by opening the HTML file directly
- **Cameras not loading** - Cameras only load when zoomed in below 500km altitude. Pan and zoom to a city.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Credits

- [CesiumJS](https://cesium.com) - 3D globe rendering
- [Google Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles-overview) - Photorealistic terrain
- [satellite.js](https://github.com/shashwatak/satellite-js) - SGP4 orbital propagation
- [OpenSky Network](https://opensky-network.org) - Live ADS-B aircraft data
- [CelesTrak](https://celestrak.org) - Two-Line Element orbital data
- [USGS](https://earthquake.usgs.gov) - Earthquake data
- [NASA EONET](https://eonet.gsfc.nasa.gov) - Natural events
- [NWS](https://www.weather.gov) - Weather alerts
- [OpenStreetMap](https://www.openstreetmap.org) - Camera data & geocoding
