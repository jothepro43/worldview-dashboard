# Assets Directory

This directory contains icon assets used by the WorldView dashboard.

Icons are dynamically generated via Canvas API in the JavaScript modules:
- Aircraft icons: Generated in `js/flights.js` using Canvas 2D
- Camera icons: Generated in `js/cameras.js` using Canvas 2D
- Satellite points: Rendered via CesiumJS PointPrimitiveCollection
- Earthquake markers: Rendered via CesiumJS Entity ellipses
- Weather icons: Rendered via CesiumJS Entity labels/points

To add custom static icon assets, place PNG/SVG files here and reference them in the respective JS modules.
