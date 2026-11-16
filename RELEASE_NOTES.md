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
