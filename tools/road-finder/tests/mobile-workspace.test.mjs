import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL('../public/', import.meta.url);
const [html, css, app, renderers] = await Promise.all([
  readFile(new URL('index.html', base), 'utf8'),
  readFile(new URL('style.css', base), 'utf8'),
  readFile(new URL('app.js', base), 'utf8'),
  readFile(new URL('ui-renderers.js', base), 'utf8')
]);

assert.doesNotMatch(html, /id="mobileWorkspaceTabs"/, 'duplicate top Search/Results workspace tabs are removed');
assert.doesNotMatch(html, /id="searchModeToggle"/, 'legacy Round trip/A-to-B toggle is removed from the route builder');

assert.doesNotMatch(html, /aria-label="Back to DriveHub"/, 'redundant top-left DriveHub back button is removed');
assert.doesNotMatch(html, /<div class="hero-title">/, 'visible Road Finder title and description chrome is removed');
assert.match(html, /style\.css\?v=14221/, 'OpenFreeMap release uses a fresh stylesheet cache key');
assert.match(html, /app\.js\?v=14221/, 'OpenFreeMap release uses a fresh app cache key');

const navHome = html.indexOf('id="navHome"');
const navSearch = html.indexOf('id="navSearch"');
const navResults = html.indexOf('id="navResults"');
const navMap = html.indexOf('id="navMap"');
assert.ok(navHome >= 0 && navSearch > navHome && navResults > navSearch && navMap > navResults,
  'bottom nav order is Home, Search, Results, Map');
assert.match(html, /id="navHome"[^>]*href="\.\.\/\.\.\/\.\.\/index\.html"/, 'Home returns to the DriveHub main page');

const kindRoads = html.indexOf('id="searchKindRoads"');
const kindRoutes = html.indexOf('id="searchKindRoutes"');
const kindA2b = html.indexOf('id="searchKindA2b"');
const locationInput = html.indexOf('id="addr"');
assert.ok(kindRoads >= 0 && kindRoutes > kindRoads && kindA2b > kindRoutes && locationInput > kindA2b,
  'Roads / Routes / A-to-B is selected before location entry');

assert.match(css, /@media \(max-width:720px\)[\s\S]*--rf-mobile-pane-top/, 'phone workspace remains responsive');
assert.match(css, /body\.mobile-workspace-search \.rf-sheet[\s\S]*opacity:0[\s\S]*visibility:hidden/, 'inactive phone panes stay mounted but animate out of view');
assert.match(css, /body\.mobile-workspace-results #results\{[\s\S]*overscroll-behavior:contain/, 'results list receives its own scrollable mobile space');
assert.match(css, /\.nav-btn \.nav-label\{display:block;font-size:11px\}/, 'mobile task labels remain visible');
assert.doesNotMatch(html, /id="navHome"[\s\S]{0,260}<span class="nav-label">Home<\/span>/, 'Road Finder Home is icon-only');
assert.match(css, /body\.mobile-workspace-search \.search-kind-card\{position:sticky/, 'search type remains visible at the top of the mobile search workspace');
assert.doesNotMatch(css, /--rf-mobile-pane-height:50%/, 'mobile workspace no longer forces an arbitrary half-screen height');
assert.match(css, /--rf-mobile-pane-max-height:calc\(100dvh[\s\S]*var\(--rf-nav-h\)[\s\S]*92px\)/, 'long mobile panes retain a ceiling that leaves map visible above navigation');
assert.match(css, /height:auto!important;[\s\S]*max-height:var\(--rf-mobile-pane-max-height\)!important/, 'mobile pane grows naturally with its content until the map-preserving ceiling');
assert.match(css, /body\.mobile-workspace-search \.rf-hero\.has-more::after\{display:none\}/, 'mobile search removes the dark clipped-content fade');
assert.match(css, /body\.mobile-workspace-search \.control-card\{padding:14px;border-radius:21px\}/, 'mobile search controls are compact without forced clipping');
assert.match(css, /body\.mobile-workspace-search \.hero-top\{display:none!important\}/, 'mobile search begins directly with useful controls');

assert.doesNotMatch(html, /id="loading"|id="status"/, 'Road Finder no longer renders duplicate tool-specific loading/status pills');
assert.doesNotMatch(css, /\.loading-overlay\{|#status\{/, 'Road Finder local toast/loading styling is removed');
assert.match(app, /DriveHubChrome\?\.beginActivity\?\.\(msg/, 'Road Finder starts work through the shared DriveHub status surface');
assert.match(app, /_drivehubActivity\?\.update/, 'Road Finder progress updates the existing shared activity instead of creating another pill');
assert.match(app, /DriveHubChrome\?\.showStatus/, 'Road Finder outcomes use the same shared DriveHub status surface');
assert.doesNotMatch(app, /els\.loading|els\.status/, 'Road Finder has no direct local loading/status lifecycle left');
assert.match(app, /function showMobileWorkspace\(view/, 'mobile workspace has a central state controller');
assert.match(app, /function selectSearchKind\(kind/, 'search type has a central state controller');
assert.match(app, /kind === 'roads' \? 'roads' : 'routes'/, 'Roads maps to road results while Routes and A-to-B map to route results');
assert.match(app, /kind === 'a2b' \? 'a2b' : 'circular'/, 'A-to-B is a distinct route mode');
assert.match(app, /navSearch\?\.addEventListener\('click'[\s\S]*navResults\?\.addEventListener\('click'[\s\S]*navMap\?\.addEventListener\('click'/,
  'bottom nav directly controls Search, Results and Map workspaces');
assert.match(app, /function openResultsSection\(\)[\s\S]*showMobileWorkspace\('results'/, 'results opening switches the phone workspace');
assert.match(app, /handleSearchCompletion\(\)[\s\S]*showMobileWorkspace\('map', 'search-complete-show-map'\)/, 'completed mobile searches reveal the map');
assert.match(app, /navSearch\?\.addEventListener\('click'[\s\S]*nav-search-toggle-close[\s\S]*showMobileWorkspace\('map'/,
  'tapping an already-open Search workspace minimises it to the map');
assert.match(app, /navResults\?\.addEventListener\('click'[\s\S]*nav-results-toggle-close[\s\S]*showMobileWorkspace\('map'/,
  'tapping an already-open Results workspace minimises it to the map');
assert.match(app, /fromMap && usesMobileWorkspace\(\)[\s\S]*showMobileWorkspace\('results', 'map-item-selected'\)/,
  'tapping a mapped road or route opens Results');
assert.match(app, /map\.on\('click',[\s\S]*map-background-dismiss/, 'tapping exposed map space minimises Search or Results');
assert.match(app, /suppressMapPaneDismissUntil = Date\.now\(\) \+ 250/, 'road and route taps are protected from the background-map dismiss gesture');
assert.match(app, /direct-route-preview/, 'A-to-B direct-route preview uses the map-first mobile flow');
assert.match(app, /const compactMobileResults = usesMobileWorkspace\(\)/, 'phone results use the compact result renderer');
assert.match(app, /function ensureRoadResultFiltersAreRenderable\(\)[\s\S]*VALID_ROAD_TIERS/, 'stale road filters are repaired before rendering');
assert.match(app, /Road Finder presentation invariant failed/, 'successful road discovery is guarded by a presentation invariant');


assert.match(app, /onSelect: \(\) => selectItem\(road\.id, false, false, usesMobileWorkspace\(\)\)/,
  'tapping a road result card opens the focused map on mobile');
assert.match(app, /onSelect: \(\) => selectItem\(route\.id, true, false, usesMobileWorkspace\(\)\)/,
  'tapping a route result card opens the focused map on mobile');
assert.match(app, /selected-map-item-deselected/, 'tapping the already-selected mapped item opens Results while deselecting it everywhere');
assert.match(app, /state\.cardMap\.forEach\(c => \{ c\.classList\.remove\('selected'\); c\.classList\.remove\('dimmed'\); \}\)/,
  'map deselection clears selected/dimmed state from result cards as well as the map');

assert.match(css, /--rf-workspace-transition:190ms cubic-bezier/, 'mobile workspace changes use a short eased transition');
assert.match(css, /transform:translateY\(-8px\) scale\(\.992\)/, 'Search and Results use a subtle movement rather than abrupt display switching');
assert.match(app, /scope === 'selected'[\s\S]*\(isRoute \? 16 : 17\)/, 'selected roads and routes are allowed to zoom in more tightly');
assert.match(app, /bottomPad = navRect \? Math\.max\(22, window\.innerHeight - navRect\.top \+ 14\) : 88/, 'mobile map fitting reserves only the real bottom navigation in Map view');
assert.match(app, /function focusSelectedMapItem\(itemId = state\.selectedId/, 'selected item geometry has a dedicated tight-fit helper');
assert.match(app, /if \(openMap\) scheduleSelectedMapFocus\(itemId\)/, 'result-card to map transitions focus only the chosen item');
assert.match(app, /if \(state\.selectedId !== null && focusSelectedMapItem/, 'Map navigation preserves a selected-item fit instead of zooming back to all results');
assert.match(app, /SEARCH_RESULT_CACHE_TTL_MS = 86400000/, 'processed search results are cached for repeat searches');
assert.match(app, /search-result:v14120-score2:roads/, 'road-result cache has a versioned stable key');
assert.match(app, /\[Result Cache Hit\]/, 'repeat searches can restore processed results without rebuilding the same roads');
assert.match(html, /id="roadScoreFilter"/, 'Road Score filter has a stable interactive target');
assert.doesNotMatch(html, /onchange="toggleTier\(this\)"/, 'Road Score checkboxes do not double-fire through inline and JS change handlers');
assert.match(css, /filter-chip-row\.dropdown-open\{overflow:visible;flex-wrap:wrap\}/, 'opened Road Score menu escapes the mobile horizontal filter scroller');
assert.match(css, /body\.mobile-workspace-results \.rf-sheet\{overflow:visible\}/, 'mobile result sheet does not clip the Road Score dropdown');
assert.match(app, /roadScoreFilter\?\.addEventListener\('toggle'[\s\S]*dropdown-open/, 'Road Score dropdown toggles the mobile unclipped state');
assert.match(css, /body\.mobile-workspace-results \.apex-score-pill\{width:44px;height:44px\}/,
  'mobile score controls are compact');
assert.match(css, /body\.mobile-workspace-results \.route-metrics\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
  'mobile route metrics stay on one compact row');

assert.match(css, /@media \(min-width:900px\)[\s\S]*\.rf-hero\{[\s\S]*width:clamp\(440px,38vw,620px\)/,
  'desktop search gets a larger independent left-hand workspace');
assert.match(css, /@media \(min-width:900px\)[\s\S]*\.rf-sheet\{[\s\S]*right:max\(var\(--rf-inset\),env\(safe-area-inset-right\)\)[\s\S]*bottom:var\(--rf-sheet-bottom\)[\s\S]*height:clamp\(360px,66dvh,720px\)/,
  'desktop results are a large bottom-right panel independent from search');
assert.match(app, /const MOBILE_BREAKPOINT = 899;/, 'Road Finder JS switches to desktop behaviour at the same 900px breakpoint');
assert.match(app, /drivehub-embedded-visible/, 'standalone Road Finder repairs map/layout when its iframe becomes visible');
assert.match(css, /\.rf-hero \.top-collapsible\{[\s\S]*scrollbar-width:none/,
  'desktop search does not show an internal scrollbar when a short viewport still needs overflow');
assert.match(css, /\.rf-hero \.hero-extras\{[\s\S]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/,
  'desktop secondary search controls share a row to preserve vertical space');
assert.match(app, /Desktop search is a left-hand surface[\s\S]*leftPad = Math\.max\(leftPad, rect\.right \+ 18\)/,
  'desktop map fitting accounts for the search panel horizontally rather than as a top obstruction');

assert.match(app, /function compactGeocodeResults\(results\)/, 'geocoder collapses duplicate representations of the same physical place');
assert.match(app, /haverDist\(pa,pb\)<=8000/, 'nearby locality and boundary results can be treated as the same place');
assert.match(app, /queryWords\.length>=2&&best\.coverage===1/, 'qualified location queries that fully match are accepted without redundant confirmation');
assert.match(app, /plausible\.every\(row=>[\s\S]*haverDist\(bestPoint,point\)<=8000/, 'single-name geocoder variants are accepted silently when they resolve to the same nearby place');
assert.match(app, /There are a few distinct matches for/, 'location confirmation is reserved for genuinely distinct matches');

assert.match(html, /<p class="hero-kicker">SEARCH<\/p>/, 'desktop search panel is titled Search rather than Go drive');
assert.match(html, /id="resultsCollapseBtn"/, 'results header has its own chevron collapse control');
assert.match(css, /@media \(min-width:900px\)[\s\S]*\.rf-sheet\.collapsed #sidebarPanel\{display:none\}/,
  'desktop Results really collapses instead of only changing state');
assert.match(app, /map-background-dismiss-results/, 'clicking the desktop or tablet map dismisses an open Results panel');
assert.match(app, /results-header-toggle/, 'Results header chevron toggles the Results panel');
assert.match(app, /search-header-surface-toggle/, 'clicking the Search header surface toggles the Search panel');
assert.match(app, /results-header-surface-toggle/, 'clicking the Results header surface toggles the Results panel');
assert.match(css, /hero-top,\.results-header\{cursor:pointer/, 'panel headers advertise their click target on pointer devices');
assert.match(app, /const DEFAULT_ROAD_TIERS = \['tier1','tier2'\]/, 'Top and Exceptional are the default Road Score bands');
assert.match(html, /value="tier1" checked[\s\S]*value="tier2" checked[\s\S]*value="tier3"[^>]*>[\s\S]*value="tier4"[^>]*>/,
  'Road Score filter defaults to Top and Exceptional only');
assert.match(app, /state\.activeTiers = new Set\(DEFAULT_ROAD_TIERS\)/, 'fresh sessions reset Road Score visibility to Top and Exceptional');

assert.match(app, /wrap\.dataset\.itemId = String\(road\.id\)[\s\S]*wrap\.addEventListener\('click'[\s\S]*selectFeaturedRoad\(\)/,
  'the whole Featured road card uses the normal road-selection path');
assert.match(app, /state\.cardMap\.set\(String\(road\.id\), card\)[\s\S]*featuredWrap\.appendChild\(card\)/,
  'Featured roads participate in the shared selected-card state');
assert.match(app, /const featuredRoadIds = compactMobileResults[\s\S]*const rankedListRoads = filtered\.filter\(r => !featuredRoadIds\.has\(String\(r\.id\)\)\)/,
  'desktop Featured roads are excluded from the main ranked list instead of appearing twice');
assert.match(app, /if \(featuredRoadIds\.has\(String\(road\.id\)\)\) continue;/,
  'Featured road map geometry is still drawn while its duplicate ranked card is skipped');

assert.match(html, /maplibre-gl@5\/dist\/maplibre-gl\.js/, 'Road Finder loads MapLibre GL for the OpenFreeMap basemap');
assert.match(html, /@maplibre\/maplibre-gl-leaflet\/leaflet-maplibre-gl\.js/, 'Road Finder loads the Leaflet-to-MapLibre bridge');
assert.match(app, /OPENFREEMAP_STYLE = 'https:\/\/tiles\.openfreemap\.org\/styles\/positron'/, 'Road Finder uses OpenFreeMap Positron as its primary basemap');
assert.match(app, /L\.maplibreGL\([\s\S]*style: OPENFREEMAP_STYLE/, 'OpenFreeMap is rendered through the existing Leaflet map');
assert.doesNotMatch(app, /basemaps\.cartocdn\.com/, 'CARTO raster tiles are no longer used');
assert.match(renderers, /dh-state--\$\{safeTone\}/, 'Road Finder empty states use the shared DriveHub recovery hierarchy');
assert.match(app, /Search couldn’t finish[\s\S]*actionLabel: 'Try again'[\s\S]*secondaryLabel: 'Edit search'/,
  'failed road searches provide persistent retry and edit-search actions');
assert.match(app, /state\.lastSearchMeta = \{ \.\.\.\(state\.lastSearchMeta \|\| \{\}\), cacheHit: true \}/,
  'restored processed-result caches are explicitly marked in the search state');
assert.match(app, /meta\.cacheHit \? `Cached/,'desktop search overview makes cache reuse visible');
assert.match(app, /function routeRationale\(route, evidence=\{\}\)/, 'route cards derive a concise explanation from rated-road coverage and the strongest roads');
assert.match(renderers, /route-rationale[\s\S]*Why this route/, 'route cards surface why each route was selected');
assert.match(css, /\.route-rationale\{/, 'route reasoning has a compact DriveHub treatment');

console.log('Mobile workspace UI regression checks passed.');
