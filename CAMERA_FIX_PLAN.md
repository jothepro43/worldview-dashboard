# Camera Feed Analysis & Fix Plan

## 1. Analysis of Errors

### Error 1: Refused to display 'https://511ga.org/' in a frame
**Message**: `Refused to display 'https://511ga.org/' in a frame because it set 'X-Frame-Options' to 'sameorigin'.`
**Cause**: The website (511ga.org) explicitly blocks being embedded in an iframe on other domains for security.
**Implication**: We cannot display this feed directly in an iframe.
**Solution**: We need a server-side proxy to fetch the content or stream and serve it to our frontend, stripping the restrictive headers, OR we need to detect this and fall back to a direct link (opening in new tab). Since `proxy.js` already handles MJPEG/HLS streams, we might be able to proxy the page content, but modern sites often use complex JS which breaks when proxied.
**Better Solution**: If it's a video stream (HLS/MJPEG), find the direct stream URL. If it's a webpage, we can't easily embed it. We should detect this failure and offer an "Open in New Tab" button.

### Error 2: OpenSky Warnings
**Message**: `[Flights] OpenSky returned no states` / `[Flights] OpenSky failed, trying fallbacks...` / `[Flights] Backoff: waiting 10s`
**Cause**: 
1. OpenSky query returned 0 aircraft (`states` array is null or empty) -> This is normal for sparse areas.
2. The code treats "no states" as a failure/error in some paths, triggering backoff.
**Fix**: Distinguish between "API Error" (500/429) and "Empty Result" (200 OK but 0 planes). Empty result should NOT trigger backoff.

### Error 3: Sandbox Warning
**Message**: `An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.`
**Cause**: We are setting `sandbox="allow-scripts allow-same-origin"` on the iframe.
**Fix**: This is a security warning. If we trust the content, it's "fine", but ideally we'd remove one. However, many players need both. We can ignore this for now as it's just a warning, but being aware is good.

## 2. Plan to "Get More Camera Feeds"

The user noted "fewer public feeds than I thought".
**Current Sources**:
1. **OSM (OpenStreetMap)**: Queries for nodes with `man_made=surveillance` or `contact:webcam`.
2. **Windy Webcams**: Uses Windy API (requires key).

**To increase availability**:
1. **Broaden OSM Query**:
   - Currently queries: `node["man_made"="surveillance"]...`
   - **Improvement**: Query for `node["tourism"="viewpoint"]`, `node["tourism"="attraction"]` which often have `image` or `url` tags.
   - **Improvement**: Check `way` and `relation` elements too, not just `node`.
2. **Add New Sources**:
   - **Traffic Cameras**: Many DOTs (like 511ga.org) have open APIs. We'd need specific integrations for major ones, or a generic "Traffic Camera" aggregator API if one exists (most are paid).
   - **Airport Webcams**: Often listed in specific databases.

## 3. Implementation Steps

1. **Fix OpenSky Backoff Logic**:
   - Modify `js/flights.js` to handle empty results (0 planes) as *success*, not failure.
   - Only trigger backoff on actual network errors or 429s.

2. **Handle Iframe Refusals**:
   - In `js/cameras.js`, listening to `iframe.onerror` is good but often doesn't catch `X-Frame-Options` blocks (browser security hides the error detail).
   - **Strategy**: Add a "Open in New Tab" button to the camera modal as a fallback for all cameras. If the iframe is blank/blocked, the user can still view it.

3. **Expand Camera Search**:
   - Update `fetchOSMCameras` in `js/cameras.js` to include more tags (`tourism=viewpoint`, `image`, `url`).

4. **Address 511ga.org specific issue**:
   - Since we can't frame it, we must detect if the URL is a "page" vs "stream".
   - If it's a page, we might just have to link to it.

## 4. Execution

Let's start by fixing the OpenSky warning (it's noisy and affects tracking) and then improve the Camera handling.
