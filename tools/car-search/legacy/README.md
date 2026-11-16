# Car Search Hub — unified vehicle search (v4.12)

**A self-hosted, mobile-friendly website**, not a Chrome extension. A Python/FastAPI server uses **Playwright + headless Chromium** to open saved car-search URLs and extract listing cards. Results are stored centrally in one JSON database, so your searches, shortlist and notes are available on any device with access to your server.

Supported sources: **Auto Trader and PistonHeads via Playwright; eBay UK via its Browse API; Facebook Marketplace via an authenticated Playwright session (best effort)**.

## v4.12 — Save individual adverts, edit vehicle details and AND/OR keywords

- **Share each saved car:** Every saved car card and its details view now has an individual **Share** button. On supported devices it uses the native share sheet; otherwise it copies the title, asking price and original advert URL. Private notes are never shared.
- **Add a car from an individual listing URL:** In **Saved cars**, select **Add car by URL** and paste a direct advert from Auto Trader, eBay, PistonHeads or Facebook Marketplace. No search is required. Enter any known details and select **Add to saved cars**; the app immediately saves the listing and tries to enrich missing details from the original advert. Some websites can block automatic details, so entries are editable even when enrichment is unavailable. Re-pasting the same advert uses the existing record rather than adding a duplicate.
- **Edit details of any saved car:** Update title, price, mileage, year, registration, location, exterior colour, transmission, engine, BHP, image URL, description and notes. Explicit manual values are persisted with the record and **take precedence over later scans and enrichment**. Manual price changes are recorded in price history. The existing source URL remains intact; backups include user edits.
- **Required AND/OR keywords:** Comma-separated groups normally use **AND**. Inside each group, enter `OR` or `|` for alternatives, such as `C4S OR Carrera 4S, manual` = (C4S OR Carrera 4S) AND manual. A new dropdown optionally changes the outer relationship to **OR**, so any comma-separated group may match. Required terms continue to match complete case-insensitive words/phrases across all adverts for the same vehicle. Preferred phrases can also use OR alternatives; synonyms score only once.
- **Safe advert URLs:** Only HTTPS individual-advert paths on supported sites are accepted; search pages and unsupported hosts are rejected. The app never publishes stored private notes or listing information outside the owner's chosen share action.

## v4.11.1 — Fix inert Read URL button after deployment

- The deployed HTML and its JavaScript are now linked with content-derived version strings, while the HTML is served with a `no-store` cache directive. This prevents a freshly deployed form being paired with older cached browser code that has no Read URL click listener.
- The importer provides a visible reading state, a success notification and an error notification.
- The exact Auto Trader Porsche 911 search URL with `aggregatedTrim=996 Carrera 4S` is covered by regression tests. That trim is now imported as **required keywords** `996, Carrera 4S` instead of being discarded, with a warning that some adverts omit the model-generation code. Other imported fields include a £30,000 maximum price, 100,000 maximum mileage and manual transmission; `body-type=Coupe` and local postcode remain unsupported and explicitly flagged.

## v4.11 — Create a structured search from a website URL

- **Paste a car search URL:** In **Add search**, paste an Auto Trader, eBay, PistonHeads or Facebook Marketplace results URL and choose **Read URL**. The server reads its parameters without visiting the website, then populates the ordinary editable search form. Review and select **Save vehicle search** to generate links for all selected providers.
- **Mapped criteria:** Searches can import car name/search keywords, named make/model, price and mileage limits, model years, engine size, BHP, exterior colours, transmission and human-readable trim phrases when represented by recognised URL parameters.
- **Missing or untranslatable parameters are shown:** Search postcode/radius and provider-specific options such as fuel, body style and numeric make/model identifiers are not silently treated as filters. A numeric-ID-only PistonHeads URL can be imported for review but needs a manually entered car name. Unsupported parameters are listed in the import preview.
- **No invented equivalence:** Generated search URLs use the Car Search Hub's existing normal UK-wide provider searches; supported criteria are checked by its local scanning and group filters. The original URL is **not** saved or fetched. Site-specific filters can differ in precision, and unknown listing details are not guaranteed.
- **Safe and non-destructive:** Invalid links, non-HTTPS/unsupported hosts, credentials and single-advert URLs are rejected. Importing fills the form but doesn't create or refresh a search until explicitly saved. Existing searches, saved cars, notes and price histories are unchanged.

## v4.10 — Required and preferred keyword search modes

- **Required keywords:** Comma-separated words or phrases; all must appear somewhere in the original title or description of at least one advert for the same deduplicated car. Matching is case-insensitive and treats punctuation as a separator. Missing a required phrase removes that car from the search's list and map.
- **Preferred keywords:** Comma-separated words or phrases; they **never filter cars out**. In the saved search, **Best preferred match** is the default sort whenever preferred terms are specified. Title matches score 2, description matches 1, and multiple provider mentions of the same phrase do not artificially multiply the score. You can switch to recently found, price, year or distance sorting at any time.
- **Broader collection across sites:** Provider searches use the vehicle search name only. Extra terms are **not** sent to Facebook, Auto Trader, eBay or PistonHeads, where they previously restricted results even when meant to be optional. Required, excluded and preferred phrases are applied or scored locally after adverts from different sites are grouped.
- **Existing searches migrate safely:** Previous **Extra keywords** become **Preferred keywords**, including on stored searches not yet edited. Editing the search reuses the existing per-site snapshot where the vehicle search name is unchanged; previous saved cars, advert history, manual matching and notes remain in place. The new keyword filters affect collected results immediately without a rescan, although refreshing sources is recommended to collect vehicles previously missed by narrower provider queries.
- **Validation:** Each required or preferred list accepts up to 500 characters and 30 comma/semicolon/newline-separated phrases of at most 80 characters. Exclusions retain their existing behaviour and limits.

## v4.9 — Exclude words and phrases from individual saved searches

- **Exclude keywords:** Each saved search has an optional comma-separated `Exclude keywords` field, for example `convertible, wrapped, Cat S`. Each item is matched case-insensitively as a complete word or phrase in an advert's title or description. Punctuation between words is treated as a separator (e.g. `non sport` matches `non-sport`), but `cat` does not match `Caterham`.
- **Any provider, one vehicle:** If any source advert in a deduplicated vehicle group contains an excluded term, that whole vehicle is removed from that search's normal list, map and count. The same car can still appear in another saved search with different criteria or in the independent Saved cars list.
- **Immediate, reversible filtering:** Editing excluded keywords re-filters already collected results with no refresh required. Provider search URLs and scan ingestion are unchanged, so removing an exclusion restores matching previously collected adverts, and data, notes, hidden-list state and price history are preserved.
- **Validation:** Up to 500 characters, 30 terms and 80 characters per term; terms can be separated by commas, semicolons or line breaks in imported backups.

## v4.8 — Sort by distance, combine duplicate-advert details and hide per search

- **Nearest/furthest sorting:** The results sort menu now offers distance ascending or descending from the public centre of High Lane, Stockport. It reuses the location resolver and coordinate cache from the existing distance filter, requests missing coordinates in the background, and places adverts with unknown locations **last in either direction**. Distances are approximate **straight-line miles**, not driving distances; filtering and original search criteria remain independent.
- **More complete grouped cars:** Each grouped car gets a **read-only combined vehicle record** assembled from all linked source adverts. Known year, mileage, exterior paint, engine size, power, transmission, location and registration can come from different sites. Lead image and descriptive text can come from another advert when the selected one lacks them. List cards use combined details, and the modal adds a dedicated **Combined vehicle details** section, per-field source attribution, advert price ranges and each distinct source description.
- **Conflicting details are disclosed:** Known discrepancies, such as different registrations, colours or significantly different odometer readings, appear as a disagreement with their source values instead of a guessed value. Mild mileage variation within existing deduplication tolerance is presented as an odometer range. Original listings, individual prices, history and notes are never overwritten.
- **Hidden cars belong to each saved search:** The global sidebar **Hidden cars** link is removed. Each saved search has a **Hidden cars in this search** section *below* its normal results and map, **collapsed by default**. Hide/restore actions apply only to that search, not another overlapping search or your global Saved cars shortlist. Once hidden, a newly discovered advert grouped with the same car is also hidden within that search. The section can restore the vehicle and retains older hidden adverts even when they disappear from a current scan.
- **Backward compatibility:** Previously globally hidden adverts are assigned to every saved search whose snapshot included the advert. Existing saved notes, manual grouping decisions, photos, checks and prices are retained. The new hidden-by-search mapping persists on the same Railway volume and in exports.
- **Limitations:** Combining data improves completeness but cannot authenticate factual statements from sellers. Locations and distances are approximate, and conflicting values should be checked against each original advert.

## v4.7 — Saved-search exterior colour reliability and Hayes location resolution

- **Saved search colours now work immediately:** Choosing Blue, Grey or another colour in **Edit search criteria** filters the already-collected cars as soon as the change is saved, without requiring a new scan. A colour match is determined across all source adverts grouped as the same car; an uncoloured Facebook listing can remain alongside the matching blue Auto Trader listing, but unrelated red or unknown cars do not pass.
- **Unknown colour is opt-in:** Previously the saved search allowed unknown exterior colours by default, making colour restrictions appear ineffective. Now selected exterior colours mean **confirmed matches only**. The checkbox is labelled **Also include cars whose exterior colour is unknown**, and is off unless explicitly selected. Older searches are migrated to the new confirmed-only meaning safely, even where their legacy `strictColour=false` was just the old default. The separate results-only colour filter continues to work independently.
- **Retain adverts from each website:** During future refreshes, the server retains source adverts across all exterior colours rather than dropping them before cross-site grouping. The user-facing search filter determines what is shown. This means one website's missing paint data cannot prevent a genuinely matching car from being identified via another source. Previously omitted listings can appear after the next successful refresh.
- **Hayes (157 miles) and similar place labels:** The town parser correctly separates Hayes from the mileage label. The geocoder now considers distance from its configured source-search postcode **across all exact UK settlements of that name**, before favouring a settlement type (e.g. a London suburban area rather than an unrelated village). It requires a sufficiently distinct match and leaves genuinely ambiguous results unplaced rather than selecting an incorrect town. Distance-hint map cache keys are updated to retry previously unlocated adverts.
- **Preservation and limits:** Search snapshots, manual matching, hidden list, saved cars, notes and price history remain intact. Location pins indicate approximate town centres, never exact seller addresses. Published advert distance may refer to a different search postcode or road mileage, so an ambiguous Hayes is still left unmapped when the clues are insufficient.

## v4.6 — Hidden car archive, reliable colour filtering and High Lane distance

- **Results-only colour filter:** Determines whether a **whole deduplicated car group** has a confirmed exterior colour on any associated website. If one site says Blue and another omits colour, the group matches Blue but **not** "Unknown / not confirmed". Multiple sites can contribute complementary information. Legacy colour guesses without provenance are safely reclassified using recognised exterior paint in listing titles when state loads; generic black leather or wheel descriptions are never accepted as body paint.
- **Distance from High Lane:** A new results-filter dropdown includes 10, 20, 30, 50, 75, 100, 150 and 250 miles. The application resolves public advertised locations using the existing Postcodes.io map service and its local persistent cache, with the approximate village centre of **High Lane, Stockport (53.36397, -2.06781)** as the origin. Distances are straight-line (great-circle) miles, **not driving distance** or exact seller addresses. Missing/ambiguous locations are excluded only while the distance filter is active; scanning rules do not change. Where the same car appears on multiple sites, any verified source location can qualify.
- **Location identification:** Additional seller/dealer town, postcode and address-locality fields are inspected on advert cards. The geocoder now strips common UK region/country suffixes and unlabelled "Town · 28 miles away" style annotations before town lookup; ambiguous names still remain unknown rather than being placed incorrectly.
- **Right click / middle click:** On a result card's car image/title/body, a right click or middle click opens the original provider advert in a **new browser tab**. A normal left click still opens the in-app multi-site details modal. Source buttons and other controls retain their own behaviour.
- **Hidden cars:** Each result group has a **Hide** control. Hidden source adverts disappear from normal searches and the saved shortlist but remain safely stored on Railway in the **Hidden cars** navigation section. Select **Restore** there or in the car's details to bring all grouped adverts back. Saved status, private notes, image hashes, listing history and prices are **never deleted**. Hidden saved cars are also excluded from shared shortlist exports until restored. Existing legacy backups that lack the new boolean field continue to work.
- Tests cover colour across cross-site groups, High Lane distance against known coordinates, ambiguous locations, hide/restore persistence, legacy colour migration and browser click handlers.

## v4.5 — High-confidence image comparisons, with no AI

Car Search Hub now supports **traditional perceptual image hashing** as another strong signal for cross-site duplicate detection.

- **No AI or external recognition service:** The server downloads each supported site's advert thumbnail, resizes it with Pillow and computes a 64-bit DCT perceptual hash (pHash), a 64-bit difference hash (dHash) and average RGB. Images are processed locally using deterministic image mathematics, not machine learning. The original image bytes are **not retained**.
- **Very high threshold:** Only photographs meeting **both** a maximum 3-bit pHash difference and 5-bit dHash difference, a compatible average colour and at least **94% combined similarity** are considered strong matches. This is designed for the *same photograph* resized, compressed or rehosted on two websites, not different pictures of the same car from different angles.
- **Merge safeguards:** The vehicle model must agree, all existing explicit owner **Not same car** decisions remain authoritative, and confirmed registration, incompatible gearbox, exterior colour, odometer or model-year conflicts prevent merging. Because dealers may reuse stock photos, the image match also needs at least one non-image clue: matching price, location, mileage or verified exterior colour.
- **Backfill and ongoing scans:** After signing in and opening the app, missing image hashes for current and older adverts are computed in a small, bounded background queue. Hashes persist on the existing Railway volume in each car record; future refreshes only re-hash a car if its image changes. Searches and Facebook sign-in take priority over optional thumbnail hashing; progress updates appear as records finish. A green **Photo match XX%** badge appears on a combined result when strong photo evidence is present.
- **Network safety:** Requests are HTTPS-only to recognised vehicle-photo/CDN domains, block private IPs and redirects, restrict payload to 2.5MB and reject unusably small, near-solid or oversized images. If a provider blocks remote image retrieval or serves a new CDN, the photo remains unavailable for comparison and the original colour/mileage/location-based matching continues unchanged. Existing manual merge/separate controls remain available.
- **Important limit:** A hash comparison cannot establish that two *different photos* of the same car show the same vehicle; equally, a generic stock photograph may be repeated in separate adverts. The strict threshold and vehicle evidence are designed to avoid false merges. Do not use image similarity alone to confirm a vehicle's identity.

## v4.4 — Prioritise colour, mileage and location for duplicate matching

- **Colour + mileage + location** are now the strongest combination for identifying the same car across websites. When a pair has a consistent make/model, verified matching exterior paint, close odometer readings and the same advertised town/postcode, Car Search Hub groups the adverts **even if the prices have changed or are missing**.
- **Mileage tolerance and accuracy:** different websites may round a car's odometer or list it at slightly different times. The matcher accepts differences within 1.8% of the lower reading, with a minimum tolerance of 500 miles and maximum 1,250 miles. Larger discrepancies are a veto when mileage is available for both adverts. The search-card scraper now rejects seller-distance figures such as `Milton Keynes (120 miles)` or `120 miles away` as odometer readings. Older listings where mileage exactly equals that distance are excluded from automatic merges until the next refresh corrects them.
- **Two of the three signals:** matching mileage and location can also identify a car when supported by price or title similarity; matching mileage and colour can identify it with matching price (or compelling title/year evidence). Matching colour and location without mileage requires the same price, model year and convincing title overlap.
- **No longer price-first:** identical asking prices, standard make/model titles, body colour or gearbox type alone cannot automatically merge cars. Registration numbers remain the strongest exact ID. Contradictory registration, known transmission, reliable exterior colour and substantially different model years prevent an automatic match.
- **Safe grouping:** Listings from the same website are never automatically merged, and each member of a multi-site group must match every other member. Your existing **Not same car**, **Allow matching** and deliberate manual-merge choices take priority over these rules.
- **Colour reliability:** Colour evidence comes from the existing verified exterior-colour classifier (labelled paint data or a safe advert-title indication). Old unverified colour guesses are not counted until a source refresh. Unknown colour cannot be treated as a match. Advertised location is normalised to remove UK country labels and mileage-to-seller suffixes.
- These rules apply to all existing stored adverts immediately after the release, without re-scanning. Updating existing search results may reveal newly confirmed paint and odometer fields and improve matching further. No original adverts, snapshots, saved cars, notes or price histories are deleted.

## v4.3 — Trustworthy exterior colour filtering

Previous versions looked for the first generic colour word in the combined advert title **and description**, checking black before blue. This caused blue cars with black leather, black alloy wheels or other trim to be misclassified as black.

- **Colour evidence:** The search-card scraper now reads only explicitly labelled exterior/body/paint colour fields when available. Otherwise the server can identify certain standard or manufacturer paint names **from the advert title**, but never guesses from arbitrary descriptive text, seats, wheels, calipers or photos.
- **Paint name normalisation:** Broad colour choices recognise common variations and factory paint names, e.g. Long Beach Blue → Blue, Hockenheim Silver → Silver, Mineral Grey/Nardo Grey → Grey, Sapphire Black → Black, Alpine White → White and Sakhir Orange → Orange. Unknown or conflicting colour information is not guessed.
- **Search filtering:** When one or more exterior colours are selected, adverts with a known different exterior colour are excluded. Unknown colour remains visible by default to avoid hiding potentially suitable cars. The **Exclude adverts where exterior colour cannot be confirmed** checkbox offers strict matching. Existing saved searches retain their previous permissive unknown-colour behaviour until changed.
- **Results-only filtering:** The **Exterior colour** dropdown matches only colours backed by an explicit field or a recognised title colour. An **Unknown / not confirmed** option lets you review what may be missing; source-less legacy colour guesses are treated as unknown until their next refresh.
- **Legacy data corrected on refresh:** Old guesses without paint provenance (for example black mistakenly inferred from black leather) are discarded and reassessed during the next provider scan. Explicitly supplied paint data from a saved-car detail lookup takes precedence over weaker title inference; known prices, notes, history and saved status remain untouched.
- **Limitations:** No photo colour recognition is attempted, and not every manufacturer colour name is represented. Some providers may not expose exterior colour in the search-card data. Strict matching can therefore exclude genuine matches with incomplete adverts.

## v4.2 — More accurate cross-site car duplicate detection

**Automatic matching** now uses a **conservative multi-signal approach** instead of the previous strict requirement for a matching year, near-identical mileage, a very similar title **and** a matching location:

- **Matching vehicle identity and identical advertised price** are the default starting point. BMW M2 and BMW M4 are not grouped just because both are in the same town at the same price; model names are checked from titles independently of search query generation.
- **Any strong corroborating signal** can then identify the same car: near-identical mileage (up to 125 miles apart), a matching town/postcode with some shared title content, or highly similar titles. Colour and transmission may support a weaker title match when model and year agree, but **price + colour alone** and **price + transmission alone** are not sufficiently distinctive and won't automatically merge.
- If both adverts expose contradictory registrations, significantly different mileages, incompatible transmission types or very different model years, they remain separate. **Matching UK registrations** can link cross-site adverts even when sellers have not synchronised their prices.
- Automatic grouping never combines two listings **from the same website** and requires each new advert to match every advert already in the group, preventing indirect chains from hiding unrelated cars. Explicit owner-created merges remain supported.
- On a grouped listing, select **Not same car** to split its source adverts and remember that choice. To reverse the exclusion later, use **Allow matching** on a separated card. Both decisions are persisted in the existing Railway data file and included in the normal backup. No saved-car history, notes, prices or original source records are deleted.
- Matching is based on available advert data, not a verified vehicle registration database. Inspect any auto-grouped results before relying on them for a purchase decision.

## v4.1 — Facebook locations, transmission, saved-car detail completion and result filtering

- **Facebook Marketplace locations:** Some search cards render the seller town as an unlabelled line immediately after the advert title (e.g. North Tidworth, Sutton Coldfield, Birmingham, Solihull, Stoke-on-Trent, Luton). The scraper now reads that line *within the individual advert card*, rejecting prices, specs and navigation labels; extracted locations feed the existing map. Live Meta markup can still change.
- **Transmission:** Every structured search has **Any / Automatic / Manual**. Auto Trader receives its native `transmission=Automatic/Manual` filter; other providers are checked locally when the listing explicitly gives a transmission. DCT, DSG and PDK are recognised as automatic. Unknown transmission remains visible in the *search*, but the optional independent **results** transmission filter includes only verified/classifiable matches.
- **Saved-car enrichment:** Newly saving a car queues a limited detail lookup. eBay uses the existing Browse API `get_item_by_legacy_id` operation; Auto Trader, PistonHeads and Facebook use their individual listing pages through Playwright (Facebook with the persisted Railway session). The server fills **missing only** among location, mileage, year, registration, transmission, colour, engine, power, image, title and description. **Never overwrite an existing price, price history or private notes.** Site login requirements, blocked pages, removed adverts or missing API credentials can leave details unavailable. The car modal contains **Refresh missing details** to retry.
- **Share the saved list:** The Saved cars view has **Share saved cars**. It opens the device's share sheet when supported, otherwise copies a list of titles, prices, advertised locations and original car links. It deliberately excludes private notes and doesn't create a public bypass to your password-protected dashboard.
- **App zoom:** The mobile viewport explicitly permits pinch zoom, and layout touch handling permits native pinch and Ctrl/trackpad browser zoom. Map gestures may zoom the map itself when started inside it.
- **Map thumbnails:** Selecting a map marker shows a small photo for each mapped car where an advert photo exists, alongside the title, price and source sites. Select a car to open its existing detail modal.
- **Separate result filters:** A new **Filter displayed results** section adjusts the already collected list **and map**, without modifying saved search criteria or rerunning any source. It includes price and year bounds, mileage bounds, engine-size bounds, BHP bounds, colour and transmission. The original text/site/new-price-change/sort controls remain. A **Clear result filters** button resets only the local display refinements.
- **Compatibility:** Original stored searches, snapshots, saved cars, notes, Facebook session, map cache and prices are retained. New fields are optional for earlier backups and adverts. No changes to your search history or accounts are needed.

## v4.0 — Connected Facebook badge, four-column results and better advert map

- **Facebook:** The top-bar button changes to green and reads **FB marketplace connected** (shortened to FB connected on narrow screens) only when the Railway browser actually reaches Marketplace. The dashboard now re-checks a previously verified session saved on `/data` after deployment/restart, rather than treating a cookie as proof of access. It also re-checks periodically while the dashboard is open. This is a status indicator, not a login bypass.
- **Results:** One column on smaller screens, two on compact screens, three on medium desktops and **a maximum of four** on wide screens. The car cards remain compact. The **Specs unverified** labels have been removed from cards and the detail dialog; the app still checks filter information internally and does not claim unavailable data is verified.
- **Modal previews and cross-site sources:** Clicking a car or any of its **Auto Trader, PistonHeads, eBay or Facebook source labels** opens the existing details modal, choosing the clicked site's advert automatically. For cars listed on multiple websites, each original source gets its own button and price (where known), plus a tab inside the modal. Only the explicit **Open original advert** action leaves the app because those third-party websites may prevent their full pages being embedded.
- **Map locations:** Auto Trader-style place strings such as `Milton Keynes (120 miles)`, `Nelson (26 miles)` and `Ripley (46 miles)` now have the distance suffix removed before matching the UK town. Where two towns share a name, the distance relative to the configured `MAP_ORIGIN_POSTCODE` (defaulting to the Auto Trader search postcode) can select a matching town **only if unambiguous**; otherwise the car remains in the unlocated section. Every grouped advert source is checked for locations, with postcodes preferred over less specific text. Map positions remain approximate centres, not verified seller addresses.
- **Auto Trader write-offs:** Every generated **and legacy** Auto Trader search sends `exclude-writeoff-categories=on`, and adverts explicitly marked Cat N/S/C/D or otherwise previously written off are filtered before being saved and from older listings displayed in the UI. Category A/B adverts are normally excluded by Auto Trader itself. **No website filter or scraped text can guarantee a car has never been written off** if its status is missing or misreported; run an independent vehicle history check before purchase.
- **Data retention:** Existing searches, links, cross-site grouping, saved cars, notes, price changes and Facebook account cookies on Railway are left in place. Your location-map cache is reused; corrected location strings use new cache keys so earlier failed lookups do not block the fix.

## v3.9 — Keyword-led Auto Trader/PistonHeads and a car location map

- **Search by the full phrase:** The search name (for example `BMW M2` or `Porsche 997`) and optional extra keywords (for example `manual`) are combined into a single `keywords=BMW+M2+manual` value for both **Auto Trader** and **PistonHeads**. The previous hard-coded manufacturer/model detection, PistonHeads numerical IDs and Auto Trader make/model mapping are no longer used. Auto Trader retains the UK-wide postcode/radius and compatible price/year/mileage filters; other specifications are checked locally when known. PistonHeads receives its keyword field and local verification; keyword search on third-party websites may still be imprecise or blocked.
- **Existing searches migrate automatically:** When a structured search is refreshed, its source URLs are regenerated with the new keyword behaviour while retaining each source's ID and the stored car history, saved notes and price changes. Legacy manually entered URLs remain valid and are not silently rewritten.
- **Location map:** Use the **List / Map** toggle above the results. The map displays the **same filtered, de-duplicated cars** as the normal list, including all saved-only and per-search views. Cars in the same postcode/town-centre area share a numbered marker. Select a marker to see its cars and open any car's existing details modal with its multiple source adverts. Cars that cannot be placed are shown separately beneath the map, not excluded or assigned fictional positions.
- **Approximate data only:** The app derives locations from each public car advert's visible postcode or town/city. It resolves full UK postcodes, outward postcode districts and matched towns using [Postcodes.io](https://postcodes.io/), with town-name data sourced from Ordnance Survey Open Names. The markers indicate **postcodes or town centres**, not a seller's exact address. Ambiguous town names, unknown locations or provider failures are left unlocated; Northern Ireland place-name coverage may be limited.
- **On-demand and cached:** Geocoding occurs only when the owner opens the map. Resolved locations are cached in `/data/location-map-cache.json`; no new Railway variables or paid map/geocoding key are needed. The map uses [Leaflet](https://leafletjs.com/) and OpenStreetMap map tiles with attribution; an internet connection is required for tiles and the mapping library. This is a personal self-hosted view, not a guaranteed geocoding service.

## v3.8 — PistonHeads search repair and compact two-column cards

- **PistonHeads:** Previous filter-led searches used the unsupported assumption that a `keywords=BMW M2` query selected the BMW M2 category, plus unverified camelCase filter names. For known models, the app now uses model-specific PistonHeads `make-id`/`model-id` values verified against actual site links: BMW M2, Lotus Evora, Ford Mustang, Jaguar F-Type and the Porsche 911 family. Optional words remain in `keywords`; price, mileage, year, colour, engine and BHP are checked against extracted listing details. These are not guaranteed exhaustive where listing data is missing.
- If the PistonHeads results app displays an empty JS shell (without reporting a real zero-results response or access block), the scanner tries the corresponding public model page and flags its results **incomplete**. It never retries through another route when PistonHeads returns HTTP 403 or CAPTCHA.
- Existing filter-based searches receive updated PistonHeads URLs the next time you refresh them, while retaining the provider snapshot IDs, existing cars, saved notes and price history.
- **Results layout:** Exactly two compact columns on larger screens and one on phones. Cards use smaller images, tighter spacing and shorter labels. The full car details and all cross-site advertisements remain available in the existing click-to-open modal. Saving, notes and manual duplicate controls remain unchanged.
- These fixes have automated tests. Successful live PistonHeads extraction on Railway needs confirmation by refreshing a search.
## v3.7 — Complete Facebook's verification in the Railway browser

If Facebook accepts the username/password but shows a confirmation challenge, Car Search Hub must complete that challenge in the **same Playwright browser on Railway**; a login in a separate phone browser is not shared with the scanner.

Open **Connect Facebook → View / complete Facebook challenge**. The screenshot is now interactive: tap a Facebook button or input directly in the browser image; scroll the screen or use the Tab/Enter controls as required. For a confirmation code, tap the Facebook code field, enter only the code requested in the masked **Text or code** box, then select **Type in selected field** and press Enter if Facebook asks. If Facebook sends a confirmation notification, approve it in the official Facebook app and return to **Recheck Railway Marketplace access**. Once Marketplace listings (or a real signed-in no-results page) are confirmed, the app saves the verified Railway session privately under `/data`.

The normal password step remains automatic using Railway Variables. This interaction is solely for **human completion of Facebook's real security prompts**, not automatic circumvention. The UI restricts remote navigation to Facebook, limits interactions, and requires the Car Search Hub login. The challenge page expires after approximately 15 minutes. The private screen may contain personal account details or security codes: **do not share screenshots unredacted**. No passwords or entered codes are returned in API responses or recorded in the car-search database.

Facebook may still prohibit access to Marketplace from a hosted server even after a genuine login; the connection will not be marked successful unless content is verified. An authenticated Facebook session is not proof of access to listings.

## v3.6 — Submit Facebook sign-in with the keyboard

The Railway browser preview showed a populated Facebook login form and an unpressed blue **Log in** button. That suggests the previous Playwright submit-button selector was failing or timing out before normal login submission.

Car Search Hub now sends the **Enter key directly from the password field**. This uses the normal form submit behaviour without waiting for the site's changing button markup or navigating overlays. It does **not** bypass Facebook login checks. After submission the app separately checks the Facebook page for an incorrect-password response and verifies genuine Marketplace content. It keeps the login page available for owner diagnostics if the submit step fails or a checkpoint appears. The five-minute rate limit still applies to a real attempt, to avoid account lockouts.

To test: confirm the current password in Railway Variables, open Car Search Hub → Connect Facebook → Clear old FB session if you still have an old login, then connect **once**. Only use the private preview if Facebook doesn't finish login. Do not share screenshots showing your phone number, password or verification codes.

## v3.5 — Auto Trader restoration and fresh Facebook login

**Auto Trader:** Searches now include a UK postcode anchor and a nationwide (1500-mile) radius, using the regular Auto Trader `/car-search` filters for make, model, price, year and mileage. Default `AUTOTRADER_POSTCODE=M1 1AE` can be changed in Railway Variables; this is a search anchor, not a location restriction. If Auto Trader's JS-filtered search page fails to expose adverts, the scanner attempts a public `/cars/uk/make/model` page **only for recognised make/model pairs**. It labels the fallback **incomplete** and checks the requested price, mileage, colour, year, engine size and BHP locally where advertised. **The fallback does not run for an HTTP 403 or CAPTCHA**, nor if the filtered page explicitly reports zero results. Real-site coverage remains unverified until a successful scan. Existing search source IDs, saved cars and notes are preserved when queries regenerate.

**Porsche 996/997:** Auto Trader often titles these cars `Porsche 911` rather than the generation code. A plausible generation-matching advert remains visible with an *unverified generation* label (and a year sanity check) instead of being discarded.

**Facebook:** If the earlier Railway password was incorrect, update `FACEBOOK_PASSWORD` in the existing Railway service (keep `FACEBOOK_EMAIL` as the registered phone number or email). Railway will redeploy with the new value. In Car Search Hub select **Connect Facebook → Clear old FB session** and confirm. This clears only the managed Facebook cookies on `/data`, **not** your saved searches or car notes. Then select **Connect and check Facebook** once. The browser will try the current Railway credentials and will only mark connected if it loads real Marketplace content. Where Facebook explicitly says the password is incorrect, the dashboard now reports that as an *invalid credentials* problem rather than assuming a security challenge. The five-minute retry limit still applies after a submitted login; clearing the session does not bypass it.

**Restrictions:** A successful login on your phone does not authenticate the Railway server browser. Meta or Auto Trader may still restrict requests from hosting providers. These changes don't bypass website access controls, CAPTCHA or account checks. Keep passwords in Railway Variables only, not in GitHub or chat.

## v3.4 — Inspect Facebook's actual Railway login page on failure

- Diagnosed a specific failure at **Submitting Railway login form**: this is the Playwright button click stage, not proof that Facebook received the login or sent an approval notification.
- Supports several ordinary Facebook login submit-button variants instead of relying solely on `button[name="login"]`.
- Prevents the browser click from unnecessarily waiting for a navigation to finish; separately verifies actual Marketplace access after attempting to submit.
- Distinguishes a timed-out click from a Facebook Marketplace rejection. A local retry cooldown still applies to attempted submissions.
- **Preserves the server login page for private preview** if the click or login page fails, instead of destroying it. Open **Connect Facebook → View Facebook's Railway screen** before attempting another login. Only enter a code when the screen requests one.
- A successful preview or a login cookie **does not** prove access; only actual Marketplace content marks the server as connected. If the preview shows Facebook blocking hosting-provider traffic, automated Railway sign-in may remain unavailable.
- Does not expose passwords, raw browser exceptions or login cookies through the dashboard.

## v3.3 — Facebook connection diagnostics and safer retries

- The message *"A Facebook login was attempted recently"* is generated by **Car Search Hub's own five-minute safety cooldown**, not by Facebook. Facebook may send **no notification**; the message never proves an actual Facebook authentication occurred.
- **Connect Facebook** now reports the latest Railway browser stage (for example loading the login page, filling the form, submitting it or checking Marketplace), the last safe result and the remaining app-level cooldown.
- Pressing Connect during the cooldown **does not submit the credentials again**. The app displays the remaining seconds and disables the button until another attempt is permitted.
- A blocked **unauthenticated** Marketplace page no longer prevents a first eligible login attempt; the app checks the server's own Marketplace access again after submitting the login form.
- A successful phone login does not affect Railway's Playwright session. If the server reports **blocked** after sign-in or its Marketplace results cannot be verified, there may be no further working login fix on a hosted datacentre. Don't keep retrying repeatedly; an authorised data provider is the more maintainable next option.
- Never paste Facebook credentials into the dashboard or this chat. Continue to store any credentials only in private Railway environment variables. No app logs print credentials.

## v3.2 — Facebook connection that the scanner can actually use

**Why the old login did not work:** Signing in through your phone's Facebook browser creates a session on that phone, not in the headless browser running on Railway. The old connector also considered any stored `c_user` cookie sufficient, even when that cookie had expired or Facebook was presenting an account checkpoint. Facebook can block hosting providers irrespective of account credentials.

**New flow:** In Car Search Hub choose **Connect Facebook**, then **Connect and check Facebook**. The server first tests a Marketplace search in the *same browser environment* used for scheduled/manual car scans. If an existing session loads real Marketplace content, the app reports **Verified**. Otherwise, with `FACEBOOK_EMAIL` (your phone number works) and `FACEBOOK_PASSWORD` already stored in Railway Variables, it attempts a normal server-side sign-in. If Facebook sends a login approval notification, approve it in your official Facebook app and choose **Recheck Railway Marketplace access** in Car Search Hub. If the server browser asks for an SMS/2FA code, enter it in the temporary one-time code field and submit. A private screenshot preview is available only for troubleshooting the verification step. The app saves the browser cookies in `/data/facebook-session.json` **only after real Marketplace content has been confirmed**.

**Safety:** This does not transfer your phone's cookies to Railway, bypass CAPTCHA or fool Facebook security checks. A 403, unresolved checkpoint, or a Marketplace shell without results is reported as blocked/unverified instead of a false connection success. The dashboard does not expose the stored Facebook password or the captured session cookies. Login attempts and one-time codes are rate limited to avoid repeated account lockouts. Only users already authenticated to the Car Search Hub dashboard can call these endpoints. The sensitive session file stays in Railway's `/data` volume; do not share or commit it.

**Still not guaranteed:** Facebook may continue to block or restrict Railway datacentre browsers, even after your account is authenticated. In that case, this is an access limitation rather than a fixable credential bug. The **Visit** link on your search opens the Marketplace search in your own browser for manual inspection. Automated tracking may require an authorised data provider or a trusted, owner-managed browser on a permitted network. Neither approach guarantees uninterrupted access, and they must comply with Facebook's terms.

## v3.1 — Corrected search inputs and Facebook sign-in

- The **search name** is now the required vehicle make/model phrase, for example `BMW M2`.
- **Extra keywords are optional**. On Auto Trader, a recognised make/model is sent through its native filters and only additional words go into `keywords`; on PistonHeads, the vehicle phrase and extra words are combined in its keyword search because native make/model values need provider-specific IDs. On eBay and Facebook, the extra words are appended to the vehicle phrase in the search text.
- Auto Trader no longer receives redundant `keywords=BMW M2` alongside `make=BMW&model=M2`, and uses conventional car-search URL parameters. Existing filter-based searches get fresh source URLs on their next refresh without losing notes, car history or source snapshot identities. **The live scraper is still subject to provider restrictions.**
- **FB sign in** in the top bar now opens `facebook.com/login` in a normal browser tab and separately attempts to sign in Railway's headless browser with `FACEBOOK_EMAIL` (phone numbers accepted) and `FACEBOOK_PASSWORD`. Both variables must be configured in Railway. The app reports whether Railway's attempt completed, or if Meta required additional security verification.
- **Important distinction:** the Facebook tab on your phone is a *different browser* from the Railway headless browser. Due to cross-origin browser protections, Railway variables cannot be autofilled into that normal Facebook tab; the server-only login is for the scanner. Two-factor and CAPTCHA challenges may still block the Railway session.
- The old manual screenshot/click/type login UI and its API endpoints are disabled.

## Version 3 — Search by vehicle, not by website

Create or edit a search using a **required vehicle name**, optional extra keywords, and minimum/maximum price, mileage, engine size in litres, BHP and year; one or more colours; and which car sites to include. The backend generates each site's search URL or eBay Browse API request. You no longer need to paste individual website links.

The overview combines results from all enabled sources into a **single list of cars**. Likely duplicates are grouped conservatively (registration match or matching year, mileage, price, location and title); you can merge or unmerge ambiguous cross-site ads manually. Click a car to open the detail modal, switch tabs among the adverts and open the full original listing on the provider's website. Most providers block embedding their website in third-party iframes, so the modal displays stored advert details rather than a live embedded provider page.

**How filtering works:** The app pushes supported constraints to each source (not every site accepts the same filters), then verifies the additional criteria in available listing text. It rejects a result when a known specification is outside the requested range. When colour, BHP, mileage, engine or another specification is **missing**, it does **not** silently remove the car: it labels the specification **unverified**. This means some displayed cars need manual confirmation, and the results are not guaranteed complete. Each provider's generated link and scan diagnostic are visible on the search detail screen.

**Existing searches:** URL-based searches and saved data remain accessible and continue to scan. Editing an older search opens the new vehicle-filter form; enter keywords and save to migrate that search. A changed URL establishes a fresh scan baseline. Back up first via Settings.

### Facebook login inside the dashboard

Click **Facebook login** in the top bar (or Settings → Connect Facebook account). Select **Start / restart Facebook browser**. The page displays a live *screenshot* of the Playwright Chromium browser running on your Railway server. Click a field in that screenshot, type into the masked input below and press **Type**; use **Enter**, **Tab**, **Scroll** or **Update view** as needed. You can enter your login phone number, password and normal Facebook verification codes here. Click **Save signed-in session** once Facebook has finished authenticating. The session is saved in `/data/facebook-session.json` with restrictive permissions; passwords typed into the browser are not saved to the car-search database. The `FACEBOOK_EMAIL` / `FACEBOOK_PASSWORD` Railway variables remain optional for automatic sign-in, but are no longer necessary if the interactive session works.

This is **not** a CAPTCHA or security bypass. Facebook may refuse logins from Railway/cloud IPs or display a checkpoint that cannot be completed there. Your normal account may receive suspicious-login alerts. Never send credentials in chat or put them in GitHub. Your dashboard must be protected by HTTPS and a long, private `APP_PASSWORD` because anyone who can use the login modal can interact with your Facebook session.

### eBay API caveat

The eBay UK Browse API is used directly with OAuth production credentials. Vehicle inventory/format coverage is not guaranteed to match eBay's own search pages. The API requests extended listing summaries to improve specification extraction. The application uses common URL query fields only for linking back to eBay; unsupported website filters are not required for new searches. Check [eBay Buy API requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html) and the API's data-display restrictions before relying on a mixed-source marketplace UI.

## Features

- Define vehicle filters once per search and generate provider-specific URLs/API requests; legacy URL searches remain readable.
- Refresh a single search, or refresh all, from the website. eBay uses its official API; the other sources use headless Chromium (one source at a time).
- Collect listing title, listing link, advertised price, image where exposed, year, mileage and location where available.
- Baseline on the first successful scan; thereafter flag newly seen adverts and any price rises/drops. Keep previous prices and timestamped price history in the stored data.
- Browse unified results per search or across searches. Conservative same-car grouping based on registration or very close spec, price, mileage and location; manual merge/unmerge.
- Save cars to a global shortlist and add notes. Records are stored on the server, **not localStorage**.
- Page-depth options, per-source scan errors, manual cancellation, export/import of v1 or v2-compatible JSON backups.
- Password gate for hosted installations; one user (not a multi-account service).
- Facebook search URLs must have a `query`, `q` or `keywords` parameter. Facebook ads whose **titles do not include all the words in the query** are discarded before saving.


## Railway integration setup (v2.1)

Add these **Variables** in the existing `car-finder` Railway service and redeploy:

| Variable | Value |
| --- | --- |
| `EBAY_CLIENT_ID` | Production **App ID / Client ID** from [eBay Developer Program](https://developer.ebay.com/) |
| `EBAY_CLIENT_SECRET` | Production **Cert ID / Client Secret** from the same application |
| `FACEBOOK_EMAIL` | Email address used to sign in to your own Facebook account |
| `FACEBOOK_PASSWORD` | Your Facebook password (set it as a private Railway variable, never in GitHub) |

Keep your existing `APP_PASSWORD`, `AUTH_SECRET`, `DATA_DIR=/data`, `PORT`, and Railway persistent volume attached at `/data`. `httpx` and Playwright are installed automatically during the Docker build.

### eBay API

Create developer keys at [developer.ebay.com](https://developer.ebay.com/), select the **production** application keys and copy the App ID and Cert ID, not Sandbox credentials. The server obtains and caches its own short-lived application OAuth token; do not paste an OAuth token in Railway.

The URL parser translates saved eBay website search parameters: `_nkw` (keywords), `_sacat` (category), `_udlo`/`_udhi` (price), `_sop` (common sort options) and listing format flags. All requests target the UK marketplace, include classified advertisements where supported, and show warnings for website-only filters. An API response can differ from the eBay website; UK vehicle / classified-ad coverage is **not verified** until tested with your production credentials and specific saved URLs. Some categories or formats may not be available through your API access. Errors do not erase previous listings.

### Facebook account session

The service tries a normal login using `FACEBOOK_EMAIL` and `FACEBOOK_PASSWORD` if no existing session is available. On success it writes Chromium cookies/session data to `/data/facebook-session.json` with restrictive file permissions and reuses them after Railway restarts. The session file is sensitive: treat the Railway volume as confidential, restrict Railway project access, and do not export or commit that file. Facebook credentials are never returned by the app or written to its application JSON database.

**Important:** Facebook often challenges new logins from cloud datacentres. Two-factor prompts, CAPTCHAs, checkpoints, login approval or an existing blocked session can still prevent automated scanning. This app **does not bypass them**, does not provide an interactive checkpoint flow and cannot guarantee that Railway-hosted login succeeds. Repeated failures pause attempts briefly to reduce account lockout risk. You may need to inspect account alerts through the official Facebook app/site. Using your main Facebook password as a Railway secret also creates credential exposure risk for anyone with access to the service settings; restrict admin access, enable 2FA and rotate the password if you suspect exposure.

## Easiest way: Docker Compose

Requirements: a computer/server with Docker and Docker Compose. To access from your phone outside your home, deploy it on a host with a public **HTTPS URL** (for example Railway, a VPS behind a reverse proxy, or another Docker-capable host).

1. Unzip the project folder.
2. Copy `.env.example` to `.env` and set **a long, unique `APP_PASSWORD`**.
3. From the project folder run `docker compose up -d --build`.
4. Open `http://localhost:3000` from the machine running Docker. Sign in with the password.
5. For internet access, use a hosting provider with HTTPS and a **persistent volume**. This Compose configuration already keeps `/data` in a named Docker volume, but a cloud host needs its own persistent volume mapped to `/data`.

**Do not publicly expose this site over plain HTTP.** HTTPS and the password are essential; the app stores personal notes and marketplace search URLs. Keep one application instance/worker connected to the data file. Deleting the server volume deletes the data unless backed up.

### Deploy to Railway / similar Docker host

Create a private repository containing this folder, create a service from the repo, use the included `Dockerfile`, set `APP_PASSWORD`, and attach a persistent volume at `/data`. Set `DATA_DIR=/data` (already set by Dockerfile). Ensure the host offers HTTPS and sufficient CPU/RAM to run Chromium; budget at least 1–2 GB of RAM. Generate the service domain and visit the site from any device. Hosting may incur charges.

**The application package is ready for deployment; it is not already hosted at a public URL.**

### Run without Docker

Requires Python 3.11+ and a system Chromium installation:

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export APP_PASSWORD='your-long-password' # Windows PowerShell: $env:APP_PASSWORD='your-long-password'
export CHROMIUM_PATH='/usr/bin/chromium'  # adjust for your OS
uvicorn server:app --host 127.0.0.1 --port 3000
```

Then visit `http://127.0.0.1:3000` on that computer. To use it on other devices, it must be hosted on a reachable network address and protected with HTTPS.

## Add searches

1. Go to the car-search site and set up the search filters as you normally would.
2. Copy the **results page** URL, not the link to an individual car.
3. Create a named search in Car Search Hub and paste one result URL per line. Mix sources freely.
4. Click **Refresh search**. The server launches Chromium, reads up to the configured result-page depth and saves the baseline.
5. Refresh another day and see newly found cars and advertised price changes. **Newly found** means not previously recorded for that URL, not necessarily a newly posted advert.
6. Click a car's source link to open the actual advertisement in your browser. Save interesting cars and edit notes in the dashboard.

## Important live-scraping limitations

**The four live car websites have not been tested against your own saved searches in this environment.** Their page structures can change, and they may block datacentre IPs or headless browsers, display CAPTCHAs, require authentication or restrict scraping under their terms. The app does not evade verification or guarantee that every result is found. In particular:

- **Facebook Marketplace:** supports optional Railway username/password variables and persists a private server-side session file as described above. Challenges, login approval and CAPTCHA still require owner action and cannot be solved by the scanner. The existing manual session helper (`scripts/facebook_login.py`) remains available as an alternative if you can securely provision a saved session.
- **Auto Trader and PistonHeads:** selectors and pagination are heuristic. **eBay:** results come from Browse API with API-compatible filters rather than webpage scraping, and its inventory may differ. Check the actual source pages if counts look wrong; page depth is a **maximum**, not an assurance of comprehensive coverage.
- A failed scan **never clears** a previous successful snapshot. If later pages fail, earlier results are marked incomplete and the old snapshot is retained alongside any successfully scanned cars.
- A server restart interrupts an in-progress scan; completed sources remain in persistent storage.
- Images are loaded from the car websites, not stored on this server, and might be blocked or expire.
- Refresh is manual, not scheduled. For regular checks the user must click Refresh.
- Duplicate detection is conservative to avoid hiding legitimately different cars. Manual merging is available.

Respect the sites' terms, access controls and sensible scan frequency. The app is for a single user's personal searches, not bulk scraping at scale.

## Project structure

- `server.py` – API, password/session handling, persistence, refresh jobs and history comparisons.
- `src/scanner.py` – Playwright navigation, Facebook session login, source filtering and error handling.
- `src/ebay_api.py` – OAuth application token, eBay Browse API search, UK filter translation and item normalisation.
- `src/extractor.js` – in-page car-card extraction script run by server Chromium.
- `public/` – responsive single-page HTML, CSS and JavaScript.
- `Dockerfile`, `docker-compose.yml`, `requirements.txt` – deployable container.
- `scripts/facebook_login.py` – optional interactive session capture on your own machine.
- `tests/` – validation tests (run `python -m pytest -q tests` with pytest/httpx installed).

## Data and upgrades

Data is stored in `$DATA_DIR/car-search-hub.json` (Docker: `/data/car-search-hub.json`). It is updated atomically and is only accessible via authenticated APIs. Export a backup via **Settings & backup** before making major changes or upgrading. Import supports the old extension's **Car Search Hub v1** backup format so you can migrate any previously collected searches, notes and cars.

This is a self-hosted release, not a production SLA. The eBay Browse API integration is independent and not endorsed by eBay; other providers are accessed on a best-effort basis.
