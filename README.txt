GRABB - OFFLINE WEB ARCHIVER
============================

What it does
------------
- Fetches and saves the original public HTML response unchanged.
- Downloads publicly accessible CSS, JavaScript, images, fonts, icons, media,
  manifests, preload resources, and assets referenced from HTML or CSS.
- Identifies common video/audio containers and HLS/DASH playlists by URL,
  response headers, download filename, and file signature; preserves a matching
  extension and records the detected format in the resource manifest.
- Preserves remote directory structure under offline-ready-copy/assets where
  practical.
- Creates a separate offline-ready HTML copy with local resource paths rewritten.
- Saves a browser-rendered DOM snapshot when Playwright is installed and usable.
- Generates reports/resource-manifest.json with downloaded, skipped, failed,
  redirected, external, and runtime/API-related resources.
- Generates reports/completeness-report.md explaining what may not work offline.
- Builds a ZIP containing original-source, rendered-dom, offline-ready-copy, and
  reports.

Important limitations
---------------------
Never treat an archive as perfect unless you verify it. Public URLs do not expose
server-side code, databases, build systems, private APIs, authenticated files, or
all runtime data. Client-side apps may keep fetching live API data after the page
loads. Some hosts block automated requests, require cookies, or return different
content to browsers and servers.

The original source is kept separate from the modified offline copy:
- original-source/index.html is the server response body as received.
- offline-ready-copy/index.html is rewritten so downloaded assets can load from
  local files.
- rendered-dom/rendered.html is a browser DOM snapshot, not the original source.

Security notes
--------------
Use only on websites you own or are authorized to inspect. The extractor:
- allows only HTTP and HTTPS URLs;
- rejects URLs containing credentials;
- blocks localhost, private-network, link-local, multicast, and similar targets;
- validates redirects before following them;
- applies request timeouts and file-size limits;
- does not bypass logins, paywalls, bot protections, or access controls.
- Media files have a 250 MB per-file limit, 250-file limit, and 120-second
  request timeout; the archive also has a 1 GB combined downloaded-resource limit.

JavaScript-rendered pages
-------------------------
The extractor will try to use Playwright if it is installed:

  npm install playwright
  npx playwright install chromium

If Playwright is not installed, extraction still works, and the report records
that browser rendering was skipped.

Run locally
-----------
1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run: npm install
4. Run: npm start
5. Open: http://localhost:3000

Output
------
Archives are written under the local exports folder and exposed through the
Download ZIP link in the UI. Review reports/completeness-report.md and
reports/resource-manifest.json before relying on the offline copy.
