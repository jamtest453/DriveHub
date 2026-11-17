# DriveHub v142.32

## v142.32 — Relative price-to-mileage ratings and sort

- Car Search result cards now show a compact price indicator: Great price, Good price, Fair price, High price, Poor price or Not rated.
- Scores compare deduplicated cars of the same model/trim, similar year (within one year) and compatible transmissions. Asking price counts 60% and mileage 40%; lower price and lower mileage are better. At least three comparable cars with reliable prices, years and mileages are required for a qualitative price label.
- The result sort menu has a new **Best price vs mileage** option using exactly the same relative ranking. If fewer than three comparable cars exist, the sort still works using a simple mileage-adjusted asking-price index, but no confident qualitative badge is assigned.
- Ratings use the currently displayed listings, not a live independent market valuation; inspect specifications, history, condition and provenance before buying. No car data or filters are modified.

# DriveHub v142.31

## v142.31 — Streamlined refresh labels, reliable map locations and tablet navigation

- Removed the duplicate saved-search-progress indicator. Searches continue to show Refreshing… directly on the active Refresh now button while its scan runs.
- Listing cards no longer append the “multiple locations” qualifier to the advertised place. Map and distance lookups now strip this display-only label and source mileage annotations, using clean town/postcode values from original adverts. When duplicate adverts have different places, the map can still select a usable source location.
- The shared top navigation is aligned to the right on tablet widths, including Car Search’s compact section selector. Auto margins keep controls right-aligned when space permits without breaking horizontal scrolling on smaller screens.
- Existing saved searches, cars, notes and scan history remain unchanged.

## v142.30 — Reliable search refreshes, quicker navigation and editable results

- Photo-derived exterior colour estimation is removed. Only manually entered paint or colour evidence from adverts/titles is used for display, filters and duplicate matching. Existing saved photo guesses are cleared on state load/import. Non-AI image fingerprints still support duplicate matching.
- Any tracked advert, saved or unsaved, can now be edited directly from its result card or detail view. The edited car stays in its current search and does not become a Saved car unless explicitly saved. Manual corrections survive later scans.
- On the Searches page, a targeted Refresh now button shows Refreshing and the active provider until the server scan finishes. Other refresh buttons are disabled during a scan and update automatically on completion.
- Source scans have bounded timeouts and a Chromium close failure can no longer leave a refresh permanently busy. Individual source errors appear in the search's report while remaining sources continue.
- Navigation caches state-derived grouping, avoids rebuilding the global header on each scan poll and defers location-based card repainting. Background photo fingerprints are persisted without publishing a new full-state revision for every single thumbnail.
- Existing searches, bookmarks, scan history and notes remain intact.

## v142.29 — Searches dashboard and inline listing distance

- Car Search's global header now has three fixed sections: Overview, Searches and Saved cars. Individual saved-search names no longer fill the header or mobile selector.
- Searches opens a dedicated page for every saved search, showing the latest check time, deduplicated vehicles found and updates since the last scan (new listings and price changes). Refresh now scans only that search; Open results takes you directly to that search's full results. The results page has a Back to all searches button.
- Listing cards now show a known approximate straight-line distance from High Lane within the clickable location, e.g. Hayes (157 miles). Missing distances are resolved asynchronously without changing the advertised location, and the separate distance chip is removed.
- Existing searches, scan history, saved cars, notes and filter settings remain unchanged.

## v142.28 — Compact Car Search cards and single-row tool navigation

- Search sources are now inside a collapsed-by-default expandable panel for each saved search, retaining their expanded state while refreshing that same search.
- Car listing cards give more space to the complete photo without aggressive cropping. The information beneath each image is tighter, with repeated title specifications and repeated provider labels removed; all preview, location-map, save, hide and merge actions remain accessible.
- The shared DriveHub header holds the tool title and actions on one line. The logo is the only Home shortcut in the shared navigation, rather than another Home icon in the tool links.
- New car searches include vehicles with unknown exterior colour by default. Existing search preferences are preserved. Non-AI paint estimation now needs stronger pixel agreement and at least 86% confidence; old weak image guesses no longer count as known colours in listing filters.
- No saved data migrations or provider credential changes. Added static regressions for the changed controls and threshold.

## v142.27 — Tool navigation in the global header and smarter car searches

- Car Search's Overview, Saved cars and individual saved-search navigation now appears in DriveHub's shared header instead of a left sidebar. The header also provides Facebook connection, Settings and New search; on small screens a saved-search selector avoids overcrowding.
- The same header shows each selected tool's own navigation on mobile as well as desktop, keeping the DriveHub Home icon clickable throughout. Removed Car Search's redundant Open full screen option.
- Auto Trader searches now identify the manufacturer from the start of a search name and use a recognised model where available, falling back to the remaining keywords when there is no model match.
- PistonHeads searches use public make pages and verified make/model page paths where known; unknown models use keywords rather than guessed make/model IDs. eBay and Facebook retain their full-text query behaviour.
- Existing saved searches regenerate provider URLs on their next scan without changing their saved listings, notes or snapshot identities.
- No changes to the saved database schema, photo-colour analysis or existing scan credentials. Added regression coverage for make/model matching and header interactions.

# v142.26 — Car photo colours, location maps and one DriveHub header

- Detect likely exterior paint colour from the listing image using deterministic Pillow HSV image sampling alongside existing photo fingerprints; **no AI or external recognition API**. A conservative confidence threshold rejects ambiguous images. Manual, explicit advert and title colours take precedence; photo-derived colour is labelled as an estimate.
- Listing cards now show a clickable green map pin next to the advertised location. The regional map modal uses the existing secure location resolver and Leaflet maps, zoomed out to show surrounding towns; never claims to show the exact car address.
- A single light DriveHub header is rendered from the shared chrome code on Home, MyGarage, Valuation, Road Finder and Car Search, including mobile layouts. The DriveHub icon is a Home control that returns to the main gateway.
- Photo-colour estimates are stored in the same persistent listing records and can be backfilled for existing photo hashes without clearing user edits or downloading untrusted photo hosts.
- Tests: 211 Car Search Python tests plus the full DriveHub check suite. Existing data volumes, scanner drivers and Railway variables are unchanged.

## v142.25 Car Search fullscreen + unified DriveHub design

- Car Search now occupies the full browser workspace: its tool container has explicit viewport-sized grid rows, and its internal iframe fills the remaining space on desktop and mobile instead of using the default small embedded-frame dimensions.
- The original Car Search interface uses DriveHub branding, green/teal colours, Figtree and Caprasimo fonts, integrated buttons/cards/forms and logo. All search data and browser scraping logic are unchanged.
- The standalone launcher now links to this live DriveHub service rather than the deleted Car Finder domain.

## v142.24 Original Car Search Hub restored within DriveHub

- Restored the complete backed-up **Car Search Hub v4.12** source under `tools/car-search/legacy/`, including its original FastAPI backend, Playwright/Chromium scanner, four site integrations, Facebook session management, eBay API, vehicle enrichment, colour and mileage safeguards, geocoding/distance results, photo hashing, deduplication, maps, AND/OR keywords, saved-car manual editing and sharing, and all 206 original Python tests.
- DriveHub stays **one GitHub repo, one Railway service and one public domain**. Its Node server routes `/car-search-app/` to a local Python process bound only to `127.0.0.1:3213`. The original saved data file stays on the existing DriveHub volume at `/data/car-search-hub.json`.
- `Dockerfile` includes Python, Node and headless Chromium. `scripts/start-drivehub.sh` starts both processes and maps `CAR_SEARCH_PASSWORD` to the original Python login. **A strong `CAR_SEARCH_PASSWORD` must be set in Railway for production.**
- The Car Search frontend, API, auth session and safe provider URL extraction retain their original behaviour. The user-facing `/search/` gateway continues to use DriveHub styling.
- The original source remains intact in a separate folder for auditability. Both DriveHub tests and the full original Car Finder tests are run during release verification.
- Live provider access still depends on site restrictions and configured credentials; passing offline tests does not guarantee Facebook/Auto Trader scraping access.


## v142.23 Native Car Search (single DriveHub service)

- **Car Search is now fully within this repository and Railway DriveHub service.** The `/car-search-app/` route serves its own frontend and API; it no longer forwards to another Railway domain. No separate car-finder repository or deployment is required.
- Persistent car data is stored at `/data/car-search-hub.json` using the existing DriveHub Railway volume. Set `CAR_SEARCH_PASSWORD` in Railway to secure saved cars and private notes (without it, the app has no login and its data is publicly accessible). The app reports that warning.
- Core tools: saved searches and generated provider links; refresh with source-specific warning reporting; new and changed listings; cross-site duplicate grouping, manual merge/separate; saved cars, private notes, manual listing URL entry and edit protection; search URL import; required AND/OR keywords, exclusions and preferred terms; colours, location/distance where the town is known, results sorting and filtering; export/import backups and share controls.
- **Important difference from v4.12:** Original Python/Playwright scanning and Facebook login were not included in the previous DriveHub ZIP. This rebuilt native Node service uses server-side HTML extraction instead. Many car websites restrict automated HTML access; these sources explicitly report restrictions and retain previously collected results rather than claiming scans succeeded. It does not yet reproduce the original photo fingerprinting or full geocoded map.
- Tests cover new native backend endpoints, authentication, persistence, keyword logic and parser behaviour.

## v142.22 Car Search tool integration

- **Car Search** is now a first-class DriveHub tool beside MyGarage, Valuation and Road Finder, available at `/search/` from the main gateway (desktop/mobile).
- Its existing Python service remains responsible for all scans, searches, saved cars, notes, account login and persistent storage. DriveHub runs a **fixed same-origin reverse proxy** under `/car-search-app/`; the Car Search tool is shown within the DriveHub tool shell. **No car data migration** is performed, and the existing Car Search service remains available independently.
- The proxy isolates the Car Search session cookie to `/car-search-app/`, forwards only that cookie upstream, rewrites the Car Search API routes and leaves DriveHub's API namespace untouched. DriveHub's frame/content-security policy permits only this same-origin tool view.
- Existing Railway service URL is the default; set `CAR_SEARCH_HUB_URL=https://YOUR-CAR-SEARCH-SERVICE` in DriveHub if you move the Car Search backend. DriveHub itself does **not** need Playwright or Python installed. The Car Search service must remain available for live functionality.
- The standalone/offline launcher and Capacitor shell show the Car Search card; because scans require a server, that card opens the hosted DriveHub/Car Search tool when connected, rather than pretending searches are offline-capable.
- Adds integration tests for routes, cookie handling, proxy isolation, cache policy, and upstream API behaviour. Existing tools remain unchanged.

## v142.21 MyGarage mobile MOT history containment

- Fixes the full MOT history screen widening beyond the phone viewport on narrow displays.
- The intentionally wide mileage chart now scrolls within its own card rather than forcing the MOT history grid wider than the screen.
- Adds shrink constraints to MOT history cards, result rows and headings, plus safe wrapping for long advisory/test metadata.
- Adds a regression check for mobile MOT history containment.


## v142.21 MyGarage Timeline today section

- MyGarage Timeline now splits events into **Upcoming → Today → Past events**, so anything dated on the device's current day is no longer mixed into either side of the timeline.
- The Today group uses the same local-day calculation as DriveHub due-date logic, avoiding UTC-midnight misclassification around local timezone boundaries.
- Timeline CSV/PDF exports now label current-day entries as **Today** as well.
- Adds a regression check covering the Today bucket, its ordering between Upcoming and Past, and its visual treatment.

## v142.19 Android OTA foundation

- Adds a **Capacitor 8 Android shell scaffold** under `android-shell/` so DriveHub remains one web codebase rather than becoming a separate Android rewrite.
- Android ships a generated known-good local web build and can receive later HTML/CSS/JS/assets from DriveHub's own **self-hosted OTA endpoint** without a Play Store release. Native plugins, permissions and Android code still use normal Play releases.
- Adds stable/beta OTA channels, semantic web-release versions, checksum metadata, optional Encryption V2 `session_key` support and a `minimumNativeVersionCode` compatibility gate.
- The shared runtime routes API calls from the native-local bundle back to the hosted DriveHub backend and only acknowledges an OTA bundle after a successful page load/grace period, preserving updater rollback protection.
- Native MyGarage deliberately skips browser service-worker/Web Push registration; the existing Browser and Email channels remain web features while a proper Android **App** notification channel can be added natively.
- Adds `build:android-web`, `test:android` and `promote:android-ota` tooling plus regression coverage for update discovery, no-downgrade behaviour, CORS, native-version gating and update-path safety.
- Hosted `/` now serves the lightweight gateway rather than transferring the ~1.6 MB standalone launcher on every fresh Home visit. The generated root `index.html` remains the self-contained offline/file launcher.
- MyGarage's browser service-worker precache now includes the actual `app.bundle.js` plus shared runtime/chrome assets, closing the first-offline-reload gap found during the v142.18 review.

The permanent Android package ID is still to be confirmed before the first Play Store release. The Gradle Android project itself is generated on the development machine with `cd android-shell && npm install && npm run android:add`.

## v142.18 navigation & load hardening

- Edit vehicle screens now reserve the fixed desktop navigation height plus 28px of breathing room, preventing the page title/back control from colliding with the DriveHub header.
- Adds a release-gate navigation/load regression suite covering cold entry to Home, MyGarage, Valuation and Road Finder, trailing-slash redirects, same-origin asset availability, cache headers and hosted integration status.
- Hosted Home cards now have real `/garage/`, `/valuation/` and `/roads/` hrefs before JavaScript runs, while the standalone launcher still intercepts them into embedded tools.
- Home refreshes recent-tool continuity, car/saved-valuation/cache counts and live readiness after Back/Forward Cache restores, so browser Back no longer reveals stale gateway information.
- Shared desktop navigation resynchronises after BFCache restores and orientation changes.
- MyGarage shell, service worker, app bundle and registration URLs are now version-locked to v142.18; v142.16 still carried v142.14 cache keys.
- Road Finder now has an explicit boot failure state if Leaflet fails to load, avoiding an otherwise blank page when the mapping library CDN is unavailable.
- The release gate verifies the 900px wide-tablet breakpoint stays aligned between shared chrome and Road Finder JavaScript/CSS.


## v142.16 stacked DriveHub home

- The DriveHub main page now presents MyGarage, Valuation and Road Finder as **full-width stacked cards** rather than a two-column grid.
- On wider screens each card uses a compact horizontal layout: tool icon, description, then live status/action. This uses the available width while making the three primary tools easier to scan.
- Mobile keeps the familiar vertical card layout, so the change does not make narrow screens cramped.
- The gateway canvas is slightly wider on desktop to give the stacked cards comfortable text measure and status space.

## v142.15 hosted navigation + wider-tablet layout

- The desktop DriveHub shell now starts at **900px** instead of 1025px, so landscape and wider tablets use the top navigation and desktop Road Finder workspace.
- On a hosted DriveHub deployment, Home now opens **`/garage/`, `/valuation/` and `/roads/` directly**. The `srcdoc` iframe launcher is retained only for the true `file://` standalone build.
- This removes the fragile hosted embedding path behind Road Finder occasionally opening blank until refresh and Valuation incorrectly claiming that the live DriveHub service was unavailable.
- Standalone Road Finder also receives an explicit iframe-visible event and revalidates its panels and Leaflet/MapLibre map size when revealed.
- Valuation now derives the live API URL from the actual DriveHub host origin, including a parent-origin fallback when embedded.

## v142.14 genuine Web Push

- Browser notifications are now real **Web Push**, not an on-open/catch-up check. DriveHub registers a service worker, creates a VAPID-backed `PushSubscription`, and syncs the same reminder schedule used by Email to the Cloudflare relay.
- The Cloudflare cron can therefore deliver MOT, tax, insurance, service and custom reminders even when DriveHub is completely closed.
- Browser and Email remain individually selectable beneath the global **Notifications** switch. The disabled **App — coming later** channel remains reserved for native Android delivery.
- Each browser/device has its own push subscription and random relay token, so a user can enable notifications on several devices independently.
- Turning the Browser channel off deletes that device from the relay and unsubscribes it from PushManager. Turning the global Notifications switch off keeps the subscription but sends an empty schedule.
- The MyGarage service worker now handles `push` events and displays native notifications. Expired push endpoints are deactivated automatically by the Worker.
- The root DriveHub launcher can broker PushManager subscription for embedded MyGarage, while direct `/garage/` use subscribes through the MyGarage service worker itself.
- iPhone/iPad users are told to add DriveHub/MyGarage to the Home Screen before enabling Browser notifications.
- `cloudflare/notification-relay/` now includes the Web Push dependency, D1 push tables, VAPID setup instructions and the shared Email + Push scheduler.

### Cloudflare secrets added for Web Push

```text
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

Existing `RELAY_SECRET`, `RESEND_API_KEY` and `EMAIL_FROM` settings continue to be used. The VAPID private key never reaches the browser.


## v142.12 valuation environment fix

- Fixed live Valuation being misclassified as local-file mode when the tool is embedded in DriveHub's `srcdoc` launcher.
- Valuation now resolves the outer DriveHub page protocol, so an HTTPS-hosted launcher can call `/api/valuation` normally.
- Local-file mode and a static hosted deployment with no live API now produce different, accurate recovery messages.
- Valuation JS/CSS cache key bumped to `14212`.


## v142.11 MyGarage canvas polish

- MyGarage now uses a warm off-white application background (`#f6f4ef`) instead of the previous green-tinted canvas. Green remains reserved for DriveHub accents, actions and statuses.
- The PWA background and MyGarage asset/service-worker cache keys are updated so the new canvas appears immediately in hosted installs.

## v142.10 consolidation — trust and explanation

- Valuation now explains **why** its confidence is High, Medium or Low using sample size, match quality, generation matching and any relaxed criteria.
- Mileage normalisation is surfaced in valuation evidence, including the target mileage, comparable-market average and the inferred value effect per 10,000 miles when the model is reliable.
- Saved valuation detail now shows the latest valuation-history checks rather than retaining history invisibly.
- Valuations opened from MyGarage have a direct **Open in MyGarage** next action, including in the standalone launcher.
- Road Finder route cards now include a compact **Why this route** explanation derived from rated-road coverage, route profile and the strongest included roads.
- Valuation success/info feedback prefers the shared DriveHub status surface, continuing the v142 move away from tool-specific transient UI.
- Cache/version keys are bumped to `14210` and the full standalone parity gate remains part of `npm run check`.


### v142.8 MyGarage logo-path fix

- Fixes MyGarage logos that were still rendered later by `app.bundle.js` as `icons/drivehub-192.png` inside the standalone launcher.
- The standalone builder now rewrites **all** MyGarage DriveHub logo references inside both the initial HTML and bundled JavaScript to embedded data URIs.
- Hosted `/garage/icons/drivehub-192.png` remains available and is smoke-tested as a normal PNG response.
- Adds a standalone parity regression that fails if any literal `icons/drivehub-192.png` reference survives in the embedded MyGarage payload.
- Bumps shared/tool/service-worker cache keys to v142.8 so a stale v142.7 shell cannot keep the broken reference alive.


### v142.4 standalone MyGarage recovery

- Wide-screen navigation is rendered as a dedicated `.drivehub-desktop-nav`.
- Tool-owned `.bottom-nav` elements remain unchanged and are only hidden above 1024px.
- Desktop nav controls proxy the original tool actions and mirror active/count state through a MutationObserver.
- This removes the CSS collision that could corrupt MyGarage/Valuation/Road Finder layouts when shared and tool-specific nav rules targeted the same element.
- The standalone launcher embeds the same isolated shared shell.

## Consolidation release — continuity and recovery

DriveHub v142.4 fixed a standalone-launcher regression that could terminate MyGarage's inline JavaScript inside the vehicle-share HTML template. That caused reminder/event template expressions such as `${editing?...}` to appear as visible page content. The static builder now inserts launcher helpers only before the final document `</body>`, and a parity test protects this boundary.

### Desktop navigation now behaves like an application shell

- The shared wide-screen DriveHub bar remains the navigation pattern above 1024px.
- The **DriveHub + current tool** identity at the left is now an actual Home control rather than decorative branding.
- Home is still available in the tool navigation itself, so the behaviour stays obvious and accessible.
- Mobile and tablet retain the existing bottom navigation.

### Shared recovery / empty-state pattern

- Adds a reusable DriveHub state hierarchy (`.dh-state`) for quiet empty states, warnings and recoverable errors.
- The pattern provides a consistent icon, title, explanation and primary/secondary actions without forcing the three tools to share their internal layouts.
- Road Finder and Valuation now use the pattern for the places where recovery matters most.

### Road Finder: errors are actionable

- A failed road/route search no longer ends with only a transient status message.
- Results now show a persistent recovery card with **Try again** and **Edit search** actions.
- No-road and no-route states also take the user straight back to Search rather than leaving them at a dead end.
- Restored processed-result caches are explicitly marked in the current search state and the desktop overview says **Cached**, making instant repeat searches understandable rather than mysterious.

### Valuation: saved prices now become useful history

- Refreshing a saved valuation preserves the previous market snapshot instead of discarding it.
- Saved cards now show movement since the prior check, e.g. **↑ £450** or **↓ £300**, with the date of the comparison.
- The opened saved valuation shows the same movement context beside the current market estimate.
- Up to 12 previous refresh snapshots are retained on each saved valuation for future trend/history work.
- Market failures now create a persistent recoverable error state with **Try again** and **Dismiss**, in addition to the existing brief toast.

### Better cross-tool continuity

- MyGarage car overviews now include a dedicated **Find a great road** handoff into Road Finder, alongside the existing MyGarage → Valuation handoff.
- DriveHub remembers the most recently opened tool.
- The Home screen exposes a compact **Continue in…** action so returning to DriveHub does not always mean starting again from the tool chooser.
- The recent-tool behaviour works in hosted mode and through the self-contained launcher.

### Existing v142 resilience remains in place

- Shared online/offline feedback across all three tools.
- One shared DriveHub activity/status surface for working, success, error and info feedback.
- Bounded Road Finder routing/map-data requests and cached results.
- Valuation request timeout.
- Google Drive request and identity/configuration timeouts in MyGarage.
- Current MyGarage service-worker cache versioning.

### Standalone parity

`npm run build:static` continues to rebuild the DriveHub gateway and all three embedded tools. The v142.3 navigation, recovery states, MyGarage → Road Finder handoff, saved-valuation movement and recent-tool continuity are therefore included in the single-file `index.html` as well as the hosted version.

### Tests

The release gate covers:

- shared desktop navigation and clickable DriveHub identity;
- common recovery-state styling;
- recent-tool Home continuity;
- MyGarage → Valuation and MyGarage → Road Finder handoffs;
- Valuation refresh history, price movement and retry state;
- Road Finder recoverable search failures and visible cache reuse;
- all existing MyGarage, Valuation, Road Finder, routing, mobile/desktop UI and Road Score regression suites.

### v142.9 Valuation hero layout fix
- Removes the obsolete two-column header grid left behind after the Valuation back button was removed.
- Gives the Valuation intro a normal desktop reading width so the title and description no longer wrap into a 44px column.
