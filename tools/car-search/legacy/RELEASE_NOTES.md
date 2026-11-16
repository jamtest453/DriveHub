# Car Search Hub release notes

## 4.12.0 — Saved-car actions, manual adverts and keyword AND/OR

- **Share single saved car:** Native Web Share API where available, otherwise clipboard/prompt fallback with advert title, price and link. Notes are excluded.
- **Manual car URLs:** Add an individual supported-site listing from the Saved cars page, independently of any search; reject search results, unsafe hosts and unrecognised URL shapes, and reuse already known adverts rather than creating duplicates. Opportunistic enrichment uses existing secure browser extraction and eBay Browse API; blocked pages leave an editable record.
- **Editable vehicle details:** New modal and validated API for title, price, year, mileage, colour, gearbox, power, engine, location, VRM, description, image and notes. Explicit owner-supplied fields survive subsequent scans or background enrichment; price edits retain manual price history.
- **Keyword logic:** `C4S OR Carrera 4S, manual` means (C4S OR Carrera 4S) AND manual; a new selector toggles the outer comma-delimited clauses between AND and OR. OR aliases also work with preferred/excluded phrases and do not double-count synonyms in preferred relevance.
- Add Python tests for validation, safe listing URL handling, adding, deduplicating, editing, persistence, scanning and enrichment; extend JS keyword test coverage.
- Existing searches, saved cars and backups remain compatible.

## 4.11.1 — Fix Read URL not responding after Railway deployment

- Give the dashboard's JavaScript and CSS content-hashed versioned URLs and serve the HTML without caching, preventing mixed frontend releases and stale click handlers during deployments.
- Show visible loading, imported-success and error feedback for the Read URL action.
- Convert Auto Trader `aggregatedTrim` text to comma-separated required variant phrases; preserve generation and derivative and explain that some adverts omit generation codes.
- Regress the exact Porsche 911 996 Carrera 4S link supplied by the user, and test fresh cache-busted asset URLs in the homepage response.

## 4.11.0 — Build a car search by pasting a supported site's search URL

- Add a **Paste search URL → Read URL** section to create/edit search criteria, with a review step before saving.
- Parse search query/name, make and model, price, year, mileage, engine, BHP, transmission and colours from recognised URL parameters for Auto Trader, eBay, PistonHeads and Facebook Marketplace.
- Convert recognised parameters into Car Search Hub's ordinary structured criteria and generate cross-site searches when saved. Original URL is neither fetched nor stored.
- Clearly warn about unsupported URL-specific filters, postcode/radius and numeric identifiers rather than guessing.
- Validate source hosts, URL paths and parameter limits server-side; reject individual advert links and unsupported URLs.
- Add offline parsing and API tests covering all supported providers, limits, warnings and security.

## 4.10.0 — Required vs preferred search keywords

- Replace Extra keywords with **Required keywords** and **Preferred keywords** in create/edit search criteria. Keep Exclude keywords as a third independent field.
- Require every comma-separated required phrase to appear in at least one advert title/description within the same deduplicated car group. Exclusions still veto the entire group when any advert mentions an excluded phrase.
- Rank cars by preferred title/description matches without removing nonmatches; add **Best preferred match** to sorting and select it automatically for saved searches with preferred terms.
- Send only the car name to provider search URLs. This prevents optional terms from unintentionally restricting Facebook and other source results; keyword conditions and scoring are performed after adverts have been collected and grouped.
- Migrate legacy extra keywords as preferred, retain snapshots when editing an unchanged car name, and preserve saved cars, notes and price history.
- Add offline Python and Node tests (also now run in CI) for keyword validation, phrase matching, grouped evidence and safe provider queries.

## 4.9.0 — Exclude keywords in saved search criteria

- Add a comma-separated Exclude keywords input to each saved search (e.g. `convertible, wrapped, Cat S`).
- Match full words and phrases, case-insensitively, in advert titles and descriptions. If any provider advert within a grouped vehicle matches, the entire car is excluded from that search.
- Reapply exclusions immediately to historical collected results, counts and map without a rescan; preserve saved cars, other searches, notes, history and raw adverts.
- Validate and persist the field through existing search updates, backups and imports; keep provider queries unchanged to avoid losing source evidence.

## 4.8.0 — High Lane distance sort, combined car details and per-search hidden archive

- Add **Distance: nearest to High Lane** and **Distance: furthest from High Lane** to result sort options, resolving locations without requiring an active distance filter or map view. Unknown locations appear last in both orders.
- Build a complementary, read-only vehicle summary from all matching source listings. Show filled-in specifications, mileage ranges where consistent, conflicting details and their provider attribution, advertised price range and original advert descriptions in the listing modal.
- Keep originals intact: source IDs, per-provider advertised prices, favourites, notes and price history are never replaced by a speculative combined value.
- Make hiding *per saved search*. Remove the global Hidden cars sidebar page; use an expandable, collapsed-by-default **Hidden cars in this search** list below that search's normal results and map, with Hide/Restore controls.
- Hiding in one saved search does not hide an overlapping car in another search or the global saved shortlist. Migrated prior global hide selections to applicable searches without deleting originals.
- Include regression tests for independent per-search hide/restore and migration, nearest/furthest sorting, combined fields and conflicting source values.
- Note: advertised locations approximate settlement centres, not precise vehicle locations; distances are straight-line from High Lane, not driving distances.

## 4.7.0 — Effective saved-search colour matching and Hayes geocoding

- Apply selected exterior-colour criteria to existing snapshot results immediately on the dashboard, not exclusively at provider scan time. Evaluate paint across grouped adverts from multiple sources, and keep non-matching cars out of each search and its overview counts.
- Make confirmed paint the default when colours are selected. Clearly label the opt-in to include unverified exterior colours and don't treat older `strictColour=false` defaults as user consent to add unknowns.
- During future scans, keep source adverts of all paint colours for cross-provider identification and apply search-colour visibility at presentation time; this avoids losing an uncoloured duplicate of a confirmed blue advert. No deletion of older saved car records, notes or histories.
- Parse `Hayes (157 miles)` and rank candidate UK settlements using its distance before a local-type preference. Avoid guessing when distance differences are insufficient; version mileage-hint location-cache keys to retry previous negative lookups.
- Regression tests cover confirmed/unknown colour options, changes to existing searches without scans, source grouping, and geographically distinct Hayes locations with different official settlement categories.
- Provider geography and source distances remain approximations, so ambiguous or absent location information cannot always be resolved reliably.

## 4.6.0 — Colour filtering, distance from High Lane, better locations, right-click and hidden cars

- Filter exterior colours across the full cross-site car group; an unknown advert does not cause a blue car to appear in the Unknown bucket. Reclassify safely identifiable exterior colours for older listings missing paint provenance.
- Add distance filtering based on the public centre of High Lane, Stockport, to the **collected-results-only** filters: straight-line 10–250 mile ranges. On demand, resolve locations from each original source advert through the existing postcode/town geocoder and cache; do not infer exact seller addresses or silently treat driving distance as straight-line distance.
- Normalise extra advertised-location formats, including "town · N miles away", country suffixes, and recognised town/postcode card metadata. Leave genuinely ambiguous locations unknown.
- Right-click and middle-click car cards to open the corresponding original advert in a new tab; preserve left-click in-page modal.
- Add persistent **Hidden cars** section with Hide and Restore actions. Hiding is reversible and keeps all source adverts, notes, favourites, saved statuses, photo hashes and price history; hidden saved cars are not included in shared shortlists.
- Tests for grouped-colour semantics, geocoding, distance, hidden-item API and legacy paint migration.
- Live third-party extraction and geocoding are best effort; straight-line distance differs from driving routes.

## 4.5.0 — Non-AI near-identical photograph matching for cross-site duplicates

- Locally calculate two independent classical image hashes (64-bit DCT pHash and 64-bit dHash) plus average RGB for publicly accessible car thumbnail images. No machine learning, image recognition API, stored original images or paid services.
- Compare hashes across supported car sites. Only pairs with pHash distance ≤3/64, dHash distance ≤5/64, compatible RGB and combined score ≥94% count as exceptional photographic evidence.
- Allow a strong photo match, combined with at least one matching advert signal (price, colour, odometer or location), to merge the same model even when other information such as price is missing or has changed.
- Retain all strong vetoes (conflicting VRM, model, year, gearbox, credible exterior paint or odometer), non-transitive matching, no automatic same-site pairs, and reversible user **Not same car** exclusions.
- Run constrained background thumbnail lookups after app load/scan, cache hash results in the persistent Railway data record, and rehash only when an advert's image changes. Unknown/blocked image data never causes a merge.
- Show a labelled photo-match percentage on cross-site groups formed with exceptionally similar photographs. Preserve original listings, user notes, saved cars, dates and price histories.
- Enforce HTTPS-only recognised photo CDNs, no redirects or private-address fetches, content type and 2.5MB download bounds, image size/texture checks.
- Regression tests cover resized/recompressed duplicates, unrelated/placeholder images, malicious URLs, local storage and false-positive prevention using actual browser-side duplicate logic.

## 4.4.0 — Colour, mileage and location as primary duplicate evidence

- Make the user's three strongest signals—exterior colour, mileage and location—take priority over identical asking prices and generic title similarities.
- Auto-match cross-site adverts with the same known make/model and verified exterior colour, consistent mileage and normalised location, even when prices diverge. Check hard conflicts in registration, known gearbox and vehicle year.
- Accept carefully corroborated two-of-three matches with price/title/year agreement; do not merge merely on matching model, asking price or colour.
- Use modest bounded odometer tolerance for rounded mileages (1.8%, minimum 500, maximum 1,250 miles), and reject known discrepancies exceeding that threshold.
- Fix search-card mileage extraction so seller distance (e.g. `Milton Keynes (120 miles)` or `30 miles away`) is not recorded as vehicle odometer mileage; prevent legacy incorrect distance-as-mileage records from influencing automatic grouping until refreshed.
- Preserve same-site separation, complete-link grouping, manual merging and reversible **Not same car** exclusions.
- Extend actual-browser-code regression tests to cover different asking prices with three matches, ambiguous or missing colours, conflicting paint/odometer/VRM, common-title false positives and non-transitive grouping.
- No changes to scraping, account authentication or original stored car information.

## 4.3.0 — Correct exterior-paint colour matching

- Eliminate the incorrect "first colour word anywhere in advert description" heuristic that confused black interiors, wheels and trim with the vehicle's exterior colour.
- Parse explicitly labelled exterior, body or paint colours from advert cards. Use carefully bounded title-colour recognition when no explicit field is supplied, including common factory names and grey/gray aliases.
- Preserve uncertainty instead of inventing colour from images, ambiguous multi-colour descriptions, or unsupported provider data.
- Add an optional strict-colour checkbox to saved search criteria, excluding adverts without a confirmed exterior colour when selected; keep unknowns visible by default for backward compatibility.
- Make the results-only dropdown rely on trusted paint provenance, with an Unknown/not-confirmed option. Prefer matching source adverts within a grouped cross-listing.
- Reassess previously guessed colours on the next scan, preserve explicitly verified exterior paint and all prices, notes, snapshots and saved cars.
- Add regression tests for factory paint names, interior/trim false positives, strict/unknown semantics, saved-detail enrichment and legacy stored listing correction.

## 4.2.0 — Evidence-weighted cross-site duplicate matching with owner separation

- Match cross-site listings with the same identified make/model and exactly matching price when corroborated by near-identical mileage, the same advertised town with some title overlap or strongly similar titles.
- Retain exact-registration matching across sites even if prices have diverged; never automatically group a different model, conflicting registrations, significantly inconsistent mileage, incompatible gearboxes or years far apart.
- Use colour/transmission only as corroborating signals, not as sole reasons to combine two identically priced cars.
- Require every member of a proposed group to match, preventing chain-merges; do not automatically combine two different adverts from the same website.
- Provide **Not same car** on matched groups and **Allow matching** to reverse the exclusion later. Persist owner corrections separately from manual merges without changing saved cars, notes or price histories.
- Include JavaScript matcher regression tests and authenticated API tests for durable manual separation.
- Real-world duplicates cannot always be confirmed from short advert details alone; conservative unknowns remain separate.

## 4.1.0 — Facebook locations, transmission and saved-car detail enrichment

- Extract unlabelled Facebook Marketplace seller-location lines from individual search cards, including UK towns visible in result thumbnails.
- Add Any / Automatic / Manual search filtering, with Auto Trader's compatible native query parameter and conservative local parsing of DCT/DSG/PDK and explicit manual adverts.
- Queue a bounded missing-detail lookup when a car is newly saved. eBay uses Browse API item details, and Auto Trader, PistonHeads and Facebook use individual listing pages. Preserve all known prices, history and personal notes; provide an in-modal retry and honest unavailable status when a site blocks access.
- Share the saved-car shortlist through native mobile sharing or copyable message with each car's original advert links, without sharing private notes or making the dashboard public.
- Explicitly allow native pinch and trackpad/browser zoom; preserve native map interactions.
- Show an advert thumbnail, price and source labels in the map's car popup.
- Add a distinct, non-destructive filter panel for already collected results: price, year, mileage, engine size and BHP ranges, plus colour and transmission. These filters apply to both list and map, not to source search queries.
- Add Facebook-card runtime fixture tests, transmission and enrichment safety tests, and UI checks.
- Provider coverage remains best-effort and is not guaranteed when adverts omit data or block automated requests.

## 4.0.0 — Facebook status, four columns, accurate map inputs, write-off suppression and modal source previews

- Green **FB marketplace connected** top-bar button only after verifying live Marketplace access from the saved Railway browser session; re-checks after process restart and periodically.
- Responsive one-to-four-column card grid, capped at four on wide screens.
- Resolve advertised locations containing mileage suffixes, choose towns by distance only when distinct, prefer postcode locations across grouped source adverts and explain missing/ambiguous map pins.
- Clicking any site source button on a card opens the detail modal with that source selected. Preserve all cross-site source choices, photos, prices, notes and explicit external original advert links.
- Always request `exclude-writeoff-categories=on` for Auto Trader, even on legacy saved URLs. Suppress visible Cat N/S/C/D and written-off adverts during scans; hide existing visibly marked adverts from the dashboard. The filter cannot replace a full provenance check.
- Remove noisy `Specs unverified` badges and scan warnings without disabling the internal filter-confidence calculation.
- Add tests for distance-labelled locations, ambiguous town disambiguation, cache keys, Auto Trader write-off handling, session revalidation and modal/column behaviour.
- Real-world location coverage and provider write-off filtering still depend on what each advert actually discloses.

## 3.9.0 — Keyword-only source searches and a combined car map

- Auto Trader and PistonHeads now receive the full car-search name plus optional extras in their own `keywords` URL field; remove the fixed make/model inference and PistonHeads numerical ID table.
- Retain Auto Trader postcode, nationwide radius and compatible numeric site filters; apply locally verifiable specifications after extracting adverts.
- Regenerate existing structured URLs on refresh without deleting previous source snapshots, saved cars, notes or price history; retain manually added legacy links.
- Add List / Map switch to the combined deduplicated results, search-specific results and saved cars. Cluster cars sharing a town/postcode-centroid pin; open each car's detail modal and switch its available site adverts.
- Resolve advertised postcodes, outward codes and town names using Postcodes.io/Ordnance Survey Open Names, with persistent Railway location cache. Do not invent coordinates for ambiguous or missing locations; provide expandable unmapped-car list.
- Use Leaflet 1.9.4 and OpenStreetMap map tiles with attribution; geocoding is on demand and limited to short public listing-location values.
- Improve extraction of explicitly labelled advert locations and UK postcodes.
- Add regression tests for provider keyword generation, location ambiguity and map API authentication/cache behaviour.
- Live provider keyword search behaviour and map coverage require real-world validation after deployment.

## 3.8.0 — PistonHeads verified make/model searches + compact result cards

- Repair PistonHeads search generation: use verified provider make-id/model-id for BMW M2, Lotus Evora, Ford Mustang, Jaguar F-Type and Porsche 911 models, rather than treating a keyword query as a make/model selection.
- Keep optional keywords in PistonHeads' text filter while verifying other user filters locally from available listings.
- Wait for PistonHeads advert cards to render and use its public model page if a filtered page renders no cards, labelling results incomplete and never bypassing an explicit block.
- Regenerate old PistonHeads URLs on refresh without resetting source IDs, saved cars or history.
- Two-column, compact cards for larger screens, single-column on phones. Retain images, saving, notes, price changes and per-site source links.
- Add regression tests for verified IDs, source URL migration and search fallback.
- Live PistonHeads collection still requires validation on Railway.

## 3.7.0 — Human-completed Facebook challenges inside Railway

- Keep automatic Facebook credentials submission, then offer interactive completion of Meta's actual security checkpoint on the same Railway browser session.
- Turn the private screenshot into a touch-enabled remote view: tap Facebook buttons/fields, enter a requested verification code or text, press Enter/Tab, scroll and update the view.
- Restrict the server-side control session to Facebook pages, enforce bounds and limited actions, and avoid echoing user-entered codes or page contents.
- Continue to verify live Marketplace access before saving the session and reporting connected.
- Preserve previous car searches, ads, notes and history; no other provider code changes.
- Add tests for remote controls, access control, expiry, and secret-safe responses.
- Live Meta verification/challenge completion remains unverified and subject to provider restrictions.

## 3.6.0 — Use password-field Enter key for Facebook login

- Switch the Railway Chromium login submission from a fixed CSS button selector to the normal Enter key in Facebook's password field.
- Avoid false Playwright button-click timeouts when the login page visibly contains prefilled credentials but does not submit.
- Preserve the browser page when keyboard submission fails; report this separately from an actual Facebook account or Marketplace block.
- Keep the existing wrong-password feedback, verified Marketplace connection check, session reset and 5-minute retry protections.
- Update mocked regression tests for Enter-key submission and timeout handling.
- Live Facebook login and Marketplace scraping still require on-site validation.

## 3.5.0 — Restore Auto Trader searches and allow a clean Facebook connection

- Restore an Auto Trader postcode and UK-wide radius to the generated `/car-search` URLs, with optional `AUTOTRADER_POSTCODE` Railway variable.
- Wait for its JavaScript-generated advert links before treating the page as empty.
- When a filtered search page has no readable adverts, try its public nationwide make/model page for recognised models; mark the scan incomplete and apply locally verifiable filters without dropping old listings.
- Keep Porsche 996/997 adverts titled `Porsche 911` visible when plausible; flag generation as unverified rather than claiming an exact match.
- Add a user-confirmed **Clear old FB session** action. Only the Railway Facebook cookies are cleared, leaving saved cars, notes and search data intact.
- Detect explicit incorrect-password feedback from Facebook's server-side login page. The 5-minute retry safety limit is preserved.
- Add regression tests for URL generation, nationwide fallback, Porsche title matching, Facebook session reset and incorrect credentials.
- Both sites' live extraction remains subject to availability and their rules; no successful real-world scan claimed.

## 3.4.0 — Robust Facebook login submission and diagnostic preview

- Handle alternative ordinary Facebook login submit-button markup.
- Use Playwright's nonblocking navigation option for the login click and separately verify Marketplace access.
- Report click timeouts distinctly and preserve the Facebook page when login submission fails, so the owner can inspect the server browser without submitting credentials again.
- Make the diagnostic preview the first troubleshooting action; do not imply Facebook necessarily issued 2FA or a phone notification.
- Keep retry cooldowns, account secrecy, session verification and prior search/listing data unchanged.
- Add mocked tests for click timeout, missing submit button and private preview after failure.
- Real Facebook login and Railway Marketplace access remain unverified and subject to Meta restrictions.

## 3.3.0 — Clear Facebook retry diagnostics and anonymous block handling

- Explain the 5-minute retry limit as a Car Search Hub safety cooldown, not a Facebook account alert.
- Display the last safe Railway login step, last confirmed outcome and remaining retry seconds.
- Avoid submitting credentials repeatedly during the cooldown.
- Permit one eligible server login even if the initial unauthenticated Marketplace test returns HTTP 403; verify Marketplace again after login.
- Report post-login access blocked/unverified without implying the user's Facebook app should receive a notification.
- Add offline regression tests for cooldown and the blocked-before-login scenario.
- Live Facebook access remains unverified and subject to Meta restrictions.

## 3.2.0 — Verify real Railway Marketplace access before reporting Facebook connected

- Remove the misleading phone-tab Facebook login flow.
- Add an authenticated server-side connection check against actual Marketplace search results; stale `c_user` cookies and empty Marketplace shells never count as a verified connection.
- Give managed sessions on `/data/facebook-session.json` precedence over older `FACEBOOK_STORAGE_STATE` overrides.
- Make login with Railway variables explicit from the dashboard. If Facebook asks for approval, keep the Railway browser open for up to 15 minutes with Recheck, numeric 2FA input, and optional private screenshot preview.
- Save session state only after Marketplace content loads; don't reset existing cars or previous snapshots on access errors.
- Limit automatic login attempts and code submissions; make blocked/unverified status explicit.
- Protect all new connection APIs behind existing dashboard authentication, and add offline tests for stale-cookie, session-priority and no-false-success cases.
- Live Meta approval/Marketplace access is **not guaranteed** from a Railway datacentre.

## 3.1.0 — Optional keywords, Auto Trader query repair, simplified Facebook sign-in

- Search name now serves as the required vehicle query. Keywords are optional and treated as *additional* terms, not another required vehicle name.
- Auto Trader uses native make/model fields where recognised and no longer receives the redundant vehicle name in its keywords filter; generated URL uses standard car search parameters.
- Facebook and eBay append optional keywords to the vehicle name; PistonHeads combines the vehicle name and keywords in its free-text query pending native model-ID lookup.
- Regenerate saved filter-based source URLs on refresh while retaining listing history, link IDs, saved notes and snapshots.
- Replace the interactive screenshot login UI with one-click Facebook sign-in: open the real Facebook login site in a separate tab and start a server-side credential login using Railway Variables.
- Clarify browser-session isolation: server credentials cannot be inserted into a normal Facebook tab, and challenges remain possible.
- Add regression coverage for empty keywords, URL mapping, Auto Trader migration and secured login endpoint.
- Live source functionality remains subject to third-party restrictions and needs real search testing.

## 3.0.0 — Filter-led searches, one car list and interactive Facebook login

- Added validated shared vehicle filters: price, mileage, year, colours, engine size, BHP and keywords, plus selectable providers.
- Generates eBay UK API searches and best-effort Auto Trader, PistonHeads and Facebook search URLs automatically. Unsupported or missing specifications are checked from listing text where available or labelled unverified.
- Retains legacy link-based searches and saved listing/notes/price history; users can migrate existing searches by editing them.
- Clickable vehicle cards open a detail modal with per-site advert tabs, images, listing metadata and original-page links. Manual cross-site merging remains available.
- Added dashboard-based, owner-controlled Facebook browser sign-in with screenshots and click/type/key actions, supporting manual account verification where Facebook allows it. Authenticated cookies persist on /data.
- eBay API requests EXTENDED item summaries for better metadata; page extractor retains card descriptions for local filtering.
- Added CI JavaScript syntax checks and regression tests for filter validation, search generation and protected login endpoints.
- **Limitations:** Headless websites can still block access, site-specific URLs require validation on live results, and eBay mixed-source display may be subject to API terms. Incomplete/unknown vehicle specs remain visible and marked unverified.

## 2.1.0 — eBay Browse API and Facebook login variables

- eBay UK searches now use the official Browse API with Railway `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, cached OAuth client-credentials token, and common saved URL filter translation.
- Preserve source listing IDs so prior eBay saved cars and price history remain linked; report unsupported URL filters and API errors without destroying snapshots.
- Facebook can now use `FACEBOOK_EMAIL` / `FACEBOOK_PASSWORD` Railway variables for a normal login when there is no existing session, and persists cookies on `/data` (not GitHub).
- CAPTCHA, two-factor verification and Meta checkpoints are not bypassed. Retries are limited after a failed login.
- Added integration tests for URL translation, listing normalization, mocked eBay API response and Facebook credential/session handling.
- Live eBay API access and Facebook login are **not validated**: they require your own production credentials and tests on your Railway deployment.

## 2.0.1 — Fix Playwright driver startup on Railway

- Install `libatomic1` in the Docker image. Without it, Playwright’s bundled Node driver exits with `libatomic.so.1: cannot open shared object file`, causing refresh to fail before reading any search links.
- Add Docker build checks for the Playwright driver and system Chromium executable.
- No changes to existing searches, listings or saved notes; `/data` volume remains unchanged.
- Live site scraping still requires separate validation for each provider.

## 2.0.0 — Web dashboard + server-side headless scraping

- Replaced the desktop Chrome extension with a responsive website accessible from mobile or desktop.
- Added FastAPI backend and Playwright/Chromium headless result extraction for Auto Trader, eBay, PistonHeads and Facebook Marketplace.
- Centralised searches, price history, notes, saved cars and scan snapshots on the server with export/import support.
- Added password-protected access, sequential scan jobs, refresh status, stop control and persistent volume support.
- Applied Facebook query-term title filtering before recording Marketplace ads.
- Kept conservative duplicate matching and manual merging.
- Preserved successful snapshots on source errors or partial scans.
- Supplied Docker deployment and local-run instructions.

### Validation
- Unit/API tests passed for URL restrictions, Facebook title filtering, price-history updates and search CRUD.
- Dashboard interaction tested using a mocked API in Chromium.
- In-page extractor tested on synthetic result cards in Chromium.
- Actual live website scraping remains unverified and depends on each site allowing server-side headless browser access.
