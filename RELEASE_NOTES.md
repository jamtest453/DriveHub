# v142.24 — Restore original full Car Search Hub within DriveHub

- Restored every source file from the backed-up Car Finder project, not a simplified reimplementation. All original features and original tests are included under `tools/car-search/legacy/`.
- Native Node Car Search replacement retired; DriveHub now hosts the full Python Playwright scanner and original dashboard as a **local loopback sidecar** inside the same container. No second Railway project, repo, service or domain is required.
- Keeps existing `/data/car-search-hub.json` storage and cookie isolation; login password comes from `CAR_SEARCH_PASSWORD`.
- Deployment uses the root `Dockerfile` (Node, Python, Chromium), with both apps started by `scripts/start-drivehub.sh`.
- Scanning external sites still depends on credentials and website access policies; source and test parity do not certify live site bookability.

# v142.23 — Native Car Search inside DriveHub

## v142.23 Native Car Search (single DriveHub service)

- **Car Search is now fully within this repository and Railway DriveHub service.** The `/car-search-app/` route serves its own frontend and API; it no longer forwards to another Railway domain. No separate car-finder repository or deployment is required.
- Persistent car data is stored at `/data/car-search-hub.json` using the existing DriveHub Railway volume. Set `CAR_SEARCH_PASSWORD` in Railway to secure saved cars and private notes (without it, the app has no login and its data is publicly accessible). The app reports that warning.
- Core tools: saved searches and generated provider links; refresh with source-specific warning reporting; new and changed listings; cross-site duplicate grouping, manual merge/separate; saved cars, private notes, manual listing URL entry and edit protection; search URL import; required AND/OR keywords, exclusions and preferred terms; colours, location/distance where the town is known, results sorting and filtering; export/import backups and share controls.
- **Important difference from v4.12:** Original Python/Playwright scanning and Facebook login were not included in the previous DriveHub ZIP. This rebuilt native Node service uses server-side HTML extraction instead. Many car websites restrict automated HTML access; these sources explicitly report restrictions and retain previously collected results rather than claiming scans succeeded. It does not yet reproduce the original photo fingerprinting or full geocoded map.
- Tests cover new native backend endpoints, authentication, persistence, keyword logic and parser behaviour.

# DriveHub release notes

## v142.22 — Car Search integration (16 November 2026)

### Added

- Car Search is now a fourth DriveHub tool, accessible from the DriveHub homepage at `/search/`.
- A responsive DriveHub shell embeds the existing Car Search Hub experience through a private same-origin reverse proxy (`/car-search-app/`). Search results, deduplication, saving, notes, sharing, manual edits and the scan workflow remain in the existing Python service.
- DriveHub reports Car Search service readiness and remembers it as the most recently visited tool.
- Android's bundled web UI includes the new tool and opens the hosted DriveHub tool to access its live server; the single-file offline launcher includes a direct online fallback.
- A readable release history page is available at `/release-notes.html`.

### Safety and compatibility

- No existing DriveHub or Car Search data or accounts are migrated or modified.
- The proxy only targets the fixed configured upstream. It does not forward unrelated DriveHub cookies, scopes the Car Search session cookie to its proxy path, and maintains a separate API route space.
- Car Search requires a network connection and the existing Python/Playwright service; the DriveHub Node service does not run scans itself.
- The default upstream is `https://car-finder-production-3d1ce777.up.railway.app/`. Override with the `CAR_SEARCH_HUB_URL` environment variable on DriveHub if needed.
- Existing tools continue to function independently. Car Search signs in using its current password (no automatic single sign-on).

### Validation

- `npm run check` passed: shared shell, MyGarage, Valuation, Road Finder, static launcher, navigation, Android and Car Search proxy integration tests.
- Car Search proxy tests use a local fake server to verify URL paths, JavaScript API rewriting, request isolation, session cookies, CSP framing and cross-origin rejection. Real production authentication and scanning were not exercised.

### Installation

Apply the changed-file patch over the **same DriveHub v142.21 project** as the supplied ZIP, preserving the relative paths. Deploy the updated DriveHub project as before. Your existing Car Search Hub service must stay deployed. No database or environment migration is required with the default Car Search URL.
