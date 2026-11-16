// Cold-load guard: Road Finder depends on Leaflet for the map and route overlay stack.
// If the CDN is unavailable, render a recoverable state instead of crashing at
// the first `L.map(...)` call and leaving the user with a blank tool.
if (typeof window.L === 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<main style="min-height:100dvh;display:grid;place-items:center;padding:28px;background:#f6f4ef;color:#14292b;font-family:Figtree,system-ui,sans-serif"><section class="dh-state dh-state--warning" style="width:min(100%,520px);background:#fff;border:1px solid rgba(20,49,58,.14);border-radius:24px;padding:26px"><div class="dh-state__icon" aria-hidden="true">!</div><p class="kicker">ROAD FINDER</p><h1 style="margin:.35rem 0 .5rem">Map controls didn’t load</h1><p>Road Finder couldn’t load its mapping library. Check your connection, then reload the tool.</p><div class="dh-state__actions"><button id="roadFinderBootRetry" class="dh-state__action" type="button">Reload Road Finder</button></div></section></main>`;
    document.getElementById('roadFinderBootRetry')?.addEventListener('click', () => location.reload());
  }
  window.DriveHubChrome?.showStatus?.('Road Finder map controls failed to load.', 'error', { duration: 8000 });
  throw new Error('Road Finder boot failed: Leaflet is unavailable');
}

const els = window.RoadFinderUI?.elements || {};
const RF = window.RoadFinderCore || {};
const ROAD_FINDER_FAVS_KEY = 'roadfinder_favs_v2';
const LEGACY_FAVS_KEY = 'apex_favs';
const DEVELOPER_MODE = (() => { try { return new URLSearchParams(location.search).has('debug') || localStorage.getItem('roadfinder.developerMode') === '1'; } catch { return false; } })();
function loadFavouriteIds(){ try { const cur=JSON.parse(localStorage.getItem(ROAD_FINDER_FAVS_KEY)||'[]'); if(Array.isArray(cur)&&cur.length)return cur.map(String); const old=JSON.parse(localStorage.getItem(LEGACY_FAVS_KEY)||'[]'); return Array.isArray(old)?old.map(String):[]; } catch { return []; } }

const VALID_ROAD_TIERS = ['tier1','tier2','tier3','tier4'];
const DEFAULT_ROAD_TIERS = ['tier1','tier2'];
const state = { ignoreMapClick: false,
  currentTab:'roads',masterRoads:[],excludedRoads:[],masterRoutes:[],allProcessedRoads:[],lastA2BFailure:null,
  activeTiers:new Set(DEFAULT_ROAD_TIERS),
  selectedId:null,preSelectionView:null,hasSearched:false,polylines:[],debugMode:DEVELOPER_MODE,
  routeDistanceChosen:false, searchMode:'circular', routeMode:'distance', routeTypeFilter:{ circular:true, a2b:true }, visibleRoadsLimit: 100, endMarker:null,routesLoading:false,routeBuildTimer:null,nameTooltip:null,searchMarker:null,
  favs: new Set(loadFavouriteIds()),
  favsOnly: false, picksOnly: false,
  searchAbort: null,
  isUserZooming: false,
  isZooming: false,
  isPanning: false,
  
  turnRestrictions: new Map(),
  hoveredId: null, cardMap: new Map(), polylineMap: new Map(),
  lastSearchMeta: null,
  lastMobileWorkspacePane: 'search'
};


function debugLog(...args) {
  if (state.debugMode) console.debug(...args);
}

function stopCardClickPropagation(root) {
  if (!root) return;
  root.querySelectorAll('a, .apex-score-control, .score-help').forEach(el => {
    el.addEventListener('click', event => event.stopPropagation());
  });
}

function bindFavouriteControl(root, id) {
  const fav = root?.querySelector('[data-fav-id]');
  if (!fav) return;
  const activate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleFav(id);
  };
  fav.addEventListener('click', activate);
  fav.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') activate(event);
  });
}

const map = L.map('map',{
  zoomControl:false,
  renderer: L.canvas({ tolerance: 10, padding: 0.5 }),
  preferCanvas: true,

  // Keep programmatic zooms smooth, but disable Leaflet's default wheel zoom.
  // The stock wheel handler debounces each wheel/trackpad burst into stepped
  // zoom jumps; with many canvas polylines that feels jerky. A custom RAF
  // wheel handler below updates fractional zoom continuously instead.
  zoomAnimation: true,
  zoomAnimationThreshold: 8,
  fadeAnimation: false,
  markerZoomAnimation: true,
  zoomSnap: 0,
  zoomDelta: 0.5,
  scrollWheelZoom: false,
  wheelDebounceTime: 24,
  wheelPxPerZoomLevel: 420,
  inertia: true,
  inertiaDeceleration: 2800,
  inertiaMaxSpeed: 2100,
  inertiaThreshold: 10,
  easeLinearity: 0.28,
  bounceAtZoomLimits: false,
  tapTolerance: 18
}).setView([53.4,-2.1],11);
L.control.zoom({position:'bottomright'}).addTo(map);

// Base map: OpenFreeMap Positron via MapLibre GL Leaflet.
// CARTO's raster basemap now requires an API key, so keep the DriveHub map
// keyless while preserving the existing Leaflet road/route overlay stack.
const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
let baseMapLayer = null;
if (typeof L.maplibreGL === 'function') {
  baseMapLayer = L.maplibreGL({
    style: OPENFREEMAP_STYLE,
    interactive: false
  }).addTo(map);
  map.attributionControl?.addAttribution(
    '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  );
} else {
  // Rare resilience fallback if the MapLibre bridge itself fails to load.
  // This is deliberately not the normal production basemap.
  console.warn('[Road Finder] MapLibre bridge unavailable; using OSM fallback tiles.');
  baseMapLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    updateWhenZooming: true,
    updateWhenIdle: false,
    updateInterval: 80,
    keepBuffer: 4
  }).addTo(map);
}

// Smooth continuous wheel / trackpad zoom.
// Uses requestAnimationFrame and fractional zoom levels instead of Leaflet's
// stepped wheel debounce. This keeps the map moving continuously even when the
// route layer contains many canvas polylines.
function installSmoothWheelZoom(map) {
  const container = map.getContainer();
  let targetZoom = map.getZoom();
  let rafId = null;
  let anchorLatLng = null;
  let idleTimer = null;

  const clampZoom = (z) => {
    const min = Number.isFinite(map.getMinZoom()) ? map.getMinZoom() : 0;
    const rawMax = map.getMaxZoom();
    const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 19;
    return Math.max(min, Math.min(max, z));
  };

  const stopSmoothZoomSoon = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      state.isUserZooming = false;
      state.isZooming = false;
      document.querySelector('.leaflet-container')?.classList.remove('smooth-wheel-zooming', 'zooming');
    }, 95);
  };

  const step = () => {
    rafId = null;
    const current = map.getZoom();
    const diff = targetZoom - current;

    if (Math.abs(diff) < 0.0025) {
      map.setZoomAround(anchorLatLng || map.getCenter(), targetZoom, { animate: false });
      stopSmoothZoomSoon();
      return;
    }

    // Ease towards the target without huge jumps. Trackpads feel smoother with
    // a lower factor; mouse-wheel bursts still respond quickly because the
    // target zoom accumulates over the wheel event sequence.
    const nextZoom = current + diff * 0.3;
    map.setZoomAround(anchorLatLng || map.getCenter(), nextZoom, { animate: false });
    rafId = requestAnimationFrame(step);
  };

  container.addEventListener('wheel', (e) => {
    if (!map._loaded || prefersReducedMotion()) return;
    e.preventDefault();

    const modeScale = e.deltaMode === 1 ? 18 : (e.deltaMode === 2 ? window.innerHeight : 1);
    const deltaPx = e.deltaY * modeScale;

    // Negative wheel delta means zoom in. Trackpads produce smaller deltas,
    // mouse wheels larger ones; pinch gestures often arrive with ctrlKey. The
    // divisor curve keeps zoom responsive but stops mouse wheels feeling like
    // hard zoom steps.
    const absDelta = Math.abs(deltaPx);
    const divisor = e.ctrlKey ? 560 : (absDelta < 18 ? 360 : 430);
    const maxStep = e.ctrlKey ? 0.32 : 0.5;
    const zoomDelta = Math.max(-maxStep, Math.min(maxStep, -deltaPx / divisor));

    if (!state.isUserZooming) {
      targetZoom = map.getZoom();
    }
    targetZoom = clampZoom(targetZoom + zoomDelta);
    anchorLatLng = map.mouseEventToLatLng(e);
    state.isUserZooming = true;
    state.isZooming = true;
    document.querySelector('.leaflet-container')?.classList.add('zooming', 'smooth-wheel-zooming');

    if (!rafId) rafId = requestAnimationFrame(step);
    stopSmoothZoomSoon();
  }, { passive: false });
}
installSmoothWheelZoom(map);

// ── ZOOM STATE TRACKING ─────────────────────────────────────────────────────
// While the zoom animation is in progress, skip any JS work that would trigger
// a canvas redraw or DOM mutation (hover updates, tooltip repositioning, etc).
// This keeps the main thread free so Leaflet's zoom animation hits 60fps.
// We track zoom specifically rather than any movement so normal panning still
// feels responsive for hover interactions.
state.isZooming = false;
let _zoomEndTimer = null;
map.on('zoomstart', () => {
  state.isZooming = true;
  // Add class so CSS can fade road overlays while tiles remain visible.
  document.querySelector('.leaflet-container')?.classList.add('zooming');
  if (_zoomEndTimer) { clearTimeout(_zoomEndTimer); _zoomEndTimer = null; }
});
map.on('zoomend', () => {
  // Custom wheel zoom keeps emitting zoomend during a wheel burst. Do not fade
  // roads back in until the wheel gesture is idle, otherwise the overlay flickers.
  const container = document.querySelector('.leaflet-container');
  if (container?.classList.contains('smooth-wheel-zooming')) return;

  // Brief guard period after zoom ends — the canvas needs a frame to redraw at
  // the new zoom level. Then fade roads back in quickly.
  if (_zoomEndTimer) clearTimeout(_zoomEndTimer);
  _zoomEndTimer = setTimeout(() => {
    state.isZooming = false;
    container?.classList.remove('zooming');
    _zoomEndTimer = null;
  }, 55);
});

state.isPanning = false;
let _panEndTimer = null;
map.on('movestart dragstart', () => {
  clearHoverPreviewForMapMove();
  state.isPanning = true;
  document.querySelector('.leaflet-container')?.classList.add('panning');
  if (_panEndTimer) { clearTimeout(_panEndTimer); _panEndTimer = null; }
});
map.on('moveend dragend', () => {
  if (_panEndTimer) clearTimeout(_panEndTimer);
  _panEndTimer = setTimeout(() => {
    state.isPanning = false;
    document.querySelector('.leaflet-container')?.classList.remove('panning');
    _panEndTimer = null;
  }, 60);
});

const roadLayers = L.featureGroup().addTo(map);

// On phones the Search/Results pane deliberately leaves a strip of live map
// visible above the primary navigation. Tapping that exposed map is the simple
// dismiss gesture for either pane. A road/route click sets a short guard in
// selectItem() so the same pointer event can still open Results instead.
map.on('click', () => {
  if ((state.suppressMapPaneDismissUntil || 0) > Date.now()) return;
  if (usesMobileWorkspace()) {
    const view = state.ui?.mobileWorkspace;
    if (view === 'search' || view === 'results') {
      showMobileWorkspace('map', 'map-background-dismiss');
    }
    return;
  }

  // On tablet/desktop the map is the shared canvas. A background map tap should
  // get the floating Results workspace out of the way without unexpectedly
  // closing Search as well.
  if (state.ui?.resultsPanel === 'open') {
    setPanelState({ resultsPanel: 'collapsed' }, 'map-background-dismiss-results');
  }
});

const MOBILE_BREAKPOINT = 899;
const MOBILE_WORKSPACE_BREAKPOINT = 720;
const MOBILE_WORKSPACE_TRANSITION_MS = 190;
const MOBILE_SHEET_HANDLE_PX = 64;
const INLINE_SCORING_BREAKPOINT = 760;
const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
const isDesktop = () => window.innerWidth > MOBILE_BREAKPOINT;
const usesMobileWorkspace = () => window.matchMedia(`(max-width: ${MOBILE_WORKSPACE_BREAKPOINT}px)`).matches;
const usesInlineScoring = () => window.innerWidth <= INLINE_SCORING_BREAKPOINT;

// ── PANEL STATE CONTROLLER ──────────────────────────────────────────────────
state.ui = {
  searchPanel: 'open',
  resultsPanel: isMobile() ? 'collapsed' : 'open',
  mobileWorkspace: 'search'
};

function syncPrimaryNav(view = 'search') {
  const safeView = ['search','results','map'].includes(view) ? view : 'search';
  const buttons = {
    search: document.getElementById('navSearch'),
    results: document.getElementById('navResults'),
    map: document.getElementById('navMap')
  };
  for (const [key, button] of Object.entries(buttons)) {
    const active = key === safeView;
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', String(active));
  }
}

function applyMobileWorkspaceView(view = state.ui?.mobileWorkspace || 'search') {
  const classes = ['mobile-workspace-search','mobile-workspace-results','mobile-workspace-map'];
  if (!usesMobileWorkspace()) {
    document.body.classList.remove(...classes);
    return;
  }

  const safeView = ['search','results','map'].includes(view) ? view : 'search';
  state.ui.mobileWorkspace = safeView;
  if (safeView === 'search' || safeView === 'results') state.lastMobileWorkspacePane = safeView;

  // Remove legacy fixed-sheet inline overrides. They were useful when Search
  // and Results occupied separate layers, but would override the shared mobile
  // workspace geometry with inline !important styles.
  clearMobilePanelInlineStyles();
  document.body.classList.remove(...classes);
  document.body.classList.add(`mobile-workspace-${safeView}`);
  if (safeView !== 'results') {
    const scoreFilter = document.getElementById('roadScoreFilter');
    if (scoreFilter?.open) scoreFilter.open = false;
  }

  const searchActive = safeView === 'search';
  const resultsActive = safeView === 'results';
  syncPrimaryNav(safeView);

  if (searchActive) {
    els.topPanel?.classList.remove('collapsed');
    els.topToggleBtn?.setAttribute('aria-expanded', 'true');
  }
  if (resultsActive) {
    els.sidebar?.classList.remove('collapsed');
    els.sheetToggle?.setAttribute('aria-expanded', 'true');
  }

  smoothInvalidateSize();
}

function showMobileWorkspace(view, reason = '') {
  if (!usesMobileWorkspace()) return false;
  state.ui.mobileWorkspace = view;
  if (view === 'search') {
    state.ui.searchPanel = 'open';
    state.ui.resultsPanel = 'collapsed';
  } else if (view === 'results') {
    state.ui.searchPanel = 'collapsed';
    state.ui.resultsPanel = 'open';
  } else if (view === 'map') {
    state.ui.searchPanel = 'collapsed';
    state.ui.resultsPanel = 'collapsed';
  }
  applyMobileWorkspaceView(view);
  return true;
}

function ensureMobileSearchHandle() {
  let handle = document.getElementById('mobileSearchHandle');
  if (!handle) {
    handle = document.createElement('button');
    handle.id = 'mobileSearchHandle';
    handle.type = 'button';
    handle.className = 'mobile-search-handle';
    handle.setAttribute('aria-label', 'Open search');
    handle.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.2-4.2"></path></svg><span>Search</span>`;
    handle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPanelState({ searchPanel: 'open' }, 'mobile-search-handle-open');
    });
    document.body.appendChild(handle);
  }
  return handle;
}

function updateMobileSearchHandle() {
  const handle = ensureMobileSearchHandle();
  // The collapsed top panel already provides a clear reopen affordance.
  // Keeping a second floating search pill caused awkward placement and overlap.
  handle.hidden = true;
  handle.setAttribute('aria-expanded', 'true');
  document.body.classList.remove('mobile-search-collapsed');
}

const scoringRestoreTarget = document.createElement('div');
scoringRestoreTarget.id = 'scoringRestoreTarget';
els.scoringPanel?.insertAdjacentElement('afterend', scoringRestoreTarget);

function relocateScoringUI() {
  if (!els.scoringToggle || !els.scoringPanel) return;
  const inlineHost = document.querySelector('.results-controls') || document.getElementById('sidebarPanel');
  const inline = usesInlineScoring() && inlineHost;
  document.body.classList.toggle('rf-inline-scoring', Boolean(inline));
  if (inline) {
    if (els.scoringToggle.parentElement !== inlineHost) inlineHost.appendChild(els.scoringToggle);
    if (els.scoringPanel.parentElement !== inlineHost) inlineHost.appendChild(els.scoringPanel);
  } else if (scoringRestoreTarget.parentElement) {
    const parent = scoringRestoreTarget.parentElement;
    parent.insertBefore(els.scoringToggle, scoringRestoreTarget);
    parent.insertBefore(els.scoringPanel, scoringRestoreTarget);
  }
}


function getMobileSearchTopPx() {
  // Chrome on Android can move the visual viewport independently of the layout
  // viewport when the browser UI expands/collapses or when inputs receive focus.
  // Anchor the floating search panel to the visible viewport, not just CSS top.
  const vv = window.visualViewport;
  const safeTop = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rf-inset'), 10) || 10;
  const offsetTop = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
  return Math.round(Math.max(safeTop, offsetTop + safeTop));
}

function anchorMobileSearchPanel() {
  if (!isMobile() || usesMobileWorkspace() || !els.topPanel) return;
  const topPx = getMobileSearchTopPx();
  document.documentElement.style.setProperty('--mobile-search-top', `${topPx}px`);
  els.topPanel.style.setProperty('position', 'fixed', 'important');
  els.topPanel.style.setProperty('top', `${topPx}px`, 'important');
  els.topPanel.style.setProperty('left', 'max(var(--rf-inset), env(safe-area-inset-left))', 'important');
  els.topPanel.style.setProperty('right', 'max(var(--rf-inset), env(safe-area-inset-right))', 'important');
  els.topPanel.style.setProperty('width', 'auto', 'important');
  els.topPanel.style.setProperty('transform', 'none', 'important');
}

function resetMobileSearchPanelScroll() {
  if (!isMobile() || !els.topPanel) return;
  anchorMobileSearchPanel();
  try { window.scrollTo(0, 0); } catch(e) {}
  try { document.documentElement.scrollTop = 0; } catch(e) {}
  try { document.body.scrollTop = 0; } catch(e) {}
  try { els.topPanel.scrollTop = 0; } catch(e) {}
  const collapsible = els.topPanel.querySelector('.top-collapsible');
  try { if (collapsible) collapsible.scrollTop = 0; } catch(e) {}
}

function mountDebugControl() {
  if (!els.debugLabel) return;
  els.debugLabel.style.display = DEVELOPER_MODE ? 'flex' : 'none';
  if (!DEVELOPER_MODE) return;
  const heading = document.querySelector('#sidebarPanel > div:first-child');
  const toolbarRight = document.querySelector('.results-toolbar > div:last-child');
  const target = heading || toolbarRight;
  if (!target || els.debugLabel.parentElement === target) return;
  target.appendChild(els.debugLabel);
}

function repairMobileResultsPanelVisibility() {
  if (!isMobile() || usesMobileWorkspace() || !els.sidebar) return;

  // Mobile Chrome can occasionally leave the bottom sheet with a stale inline
  // transform/visibility after a select -> deselect cycle. Force the sheet
  // back to one of two valid states: open, or collapsed with the handle visible.
  const collapsed = state.ui?.resultsPanel === 'collapsed' || els.sidebar.classList.contains('collapsed');
  els.sidebar.style.setProperty('display', 'flex', 'important');
  els.sidebar.style.setProperty('visibility', 'visible', 'important');
  els.sidebar.style.setProperty('opacity', '1', 'important');
  els.sidebar.style.setProperty('pointer-events', 'auto', 'important');
  els.sidebar.style.setProperty('left', 'max(var(--rf-inset), env(safe-area-inset-left))', 'important');
  els.sidebar.style.setProperty('right', 'max(var(--rf-inset), env(safe-area-inset-right))', 'important');
  els.sidebar.style.setProperty('bottom', 'var(--rf-sheet-bottom)', 'important');
  // The current bottom-sheet CSS handles open/collapsed geometry itself.
  // Avoid legacy transforms that could pull the new sheet partly off-screen.
  els.sidebar.style.removeProperty('transform');

  if (els.sheetToggle) {
    els.sheetToggle.style.removeProperty('display');
    els.sheetToggle.removeAttribute('hidden');
  }
}

function clearMobilePanelInlineStyles() {
  // Mobile repair code uses inline !important styles to work around mobile
  // viewport quirks. Remove those styles when returning to tablet/desktop so
  // CSS can control the floating 25%-style panel layout again.
  if (els.topPanel) {
    ['position', 'top', 'left', 'right', 'bottom', 'width', 'max-height', 'height', 'transform', 'overflow-y'].forEach(prop => {
      els.topPanel.style.removeProperty(prop);
    });
  }

  if (els.sidebar) {
    ['display', 'visibility', 'opacity', 'pointer-events', 'left', 'right', 'bottom', 'width', 'height', 'min-height', 'max-height', 'transform'].forEach(prop => {
      els.sidebar.style.removeProperty(prop);
    });
  }

  if (els.sheetToggle) {
    ['display', 'height', 'min-height'].forEach(prop => els.sheetToggle.style.removeProperty(prop));
    els.sheetToggle.removeAttribute('hidden');
  }

  document.body.classList.remove('mobile-search-collapsed');
}

function setPanelState(next = {}, reason = '') {
  state.ui = state.ui || { searchPanel: 'open', resultsPanel: isMobile() ? 'collapsed' : 'open', mobileWorkspace: 'search' };

  if (next.searchPanel === 'open' || next.searchPanel === 'collapsed') state.ui.searchPanel = next.searchPanel;
  if (next.resultsPanel === 'open' || next.resultsPanel === 'collapsed') state.ui.resultsPanel = next.resultsPanel;

  if (!isMobile()) {
    clearMobilePanelInlineStyles();
  }

  const searchCollapsed = state.ui.searchPanel === 'collapsed';
  const resultsCollapsed = state.ui.resultsPanel === 'collapsed';

  if (usesMobileWorkspace()) {
    let workspace = state.ui.mobileWorkspace || 'search';
    if (next.resultsPanel === 'open') workspace = 'results';
    else if (next.searchPanel === 'open') workspace = 'search';
    else if (next.searchPanel === 'collapsed' && next.resultsPanel === 'collapsed') workspace = 'map';
    state.ui.mobileWorkspace = workspace;
  }

  els.topPanel?.classList.toggle('collapsed', searchCollapsed);
  els.topToggleBtn?.setAttribute('aria-expanded', searchCollapsed ? 'false' : 'true');

  // Mobile repair: Chrome/Android can preserve or create scroll offsets when
  // a fixed panel containing inputs is reopened. Re-anchor the panel to the
  // visible viewport and reset all relevant scroll containers over a few frames.
  if (isMobile() && !usesMobileWorkspace() && els.topPanel) {
    anchorMobileSearchPanel();
    if (!searchCollapsed) {
      resetMobileSearchPanelScroll();
      requestAnimationFrame(resetMobileSearchPanelScroll);
      setTimeout(resetMobileSearchPanelScroll, 80);
      setTimeout(resetMobileSearchPanelScroll, 260);
    }
  }

  els.sidebar?.classList.toggle('collapsed', resultsCollapsed);
  els.sheetToggle?.setAttribute('aria-expanded', resultsCollapsed ? 'false' : 'true');
  document.getElementById('resultsCollapseBtn')?.setAttribute('aria-expanded', resultsCollapsed ? 'false' : 'true');

  els.topToggleBtn?.removeAttribute('hidden');
  els.sheetToggle?.removeAttribute('hidden');

  if (isMobile()) {
    repairMobileResultsPanelVisibility();
    requestAnimationFrame(repairMobileResultsPanelVisibility);
    setTimeout(repairMobileResultsPanelVisibility, 120);
  }

  mountDebugControl();
  updateMobileSearchHandle();
  if (usesMobileWorkspace()) applyMobileWorkspaceView(state.ui.mobileWorkspace);
  else {
    const primaryView = state.ui.resultsPanel === 'open' ? 'results' : state.ui.searchPanel === 'open' ? 'search' : 'map';
    syncPrimaryNav(primaryView);
  }

  smoothInvalidateSize();
  smoothInvalidateSize(320);
}

// Respect user's motion preferences. When true: skip smooth flyTo, skip pulse,
// skip decorative animations. Check dynamically so users can toggle it in OS settings.
const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch(e) { return false; }
};

function smoothInvalidateSize(delay = 0) {
  const run = () => {
    try { map.invalidateSize({ pan: false, debounceMoveend: true }); }
    catch(e) { try { map.invalidateSize(false); } catch(_) {} }
  };
  if (delay > 0) setTimeout(run, delay);
  else requestAnimationFrame(run);
}

function smoothSetView(center, zoom, opts = {}) {
  if (!center) return;
  const targetZoom = Number.isFinite(zoom) ? zoom : map.getZoom();
  if (prefersReducedMotion() || opts.animate === false) {
    map.setView(center, targetZoom, { animate: false });
    return;
  }
  const currentZoom = map.getZoom();
  const zoomDelta = Math.abs(targetZoom - currentZoom);
  const duration = opts.duration ?? Math.min(0.68, Math.max(0.24, 0.26 + zoomDelta * 0.07));
  if (map.flyTo && zoomDelta > 1.4) {
    map.flyTo(center, targetZoom, { duration, easeLinearity: opts.easeLinearity ?? 0.3 });
  } else {
    map.setView(center, targetZoom, { animate: true, duration, easeLinearity: opts.easeLinearity ?? 0.3 });
  }
}

function smoothFitBounds(bounds, opts = {}) {
  if (!bounds || !bounds.isValid()) return;
  if (prefersReducedMotion() || opts.smooth === false) {
    map.fitBounds(bounds, { ...opts, animate: false });
    return;
  }
  const paddingOpts = { ...opts };
  delete paddingOpts.smooth;
  delete paddingOpts.duration;
  if (map.flyToBounds) {
    map.flyToBounds(bounds, {
      ...paddingOpts,
      duration: opts.duration ?? 0.55,
      easeLinearity: opts.easeLinearity ?? 0.3
    });
  } else {
    map.fitBounds(bounds, { ...paddingOpts, animate: true, duration: opts.duration ?? 0.55 });
  }
}


// ── CACHING (IndexedDB) ───────────────────────────────────────────────────────
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('RoadFinderDataCache', 1);
  request.onupgradeneeded = e => {
    if (!e.target.result.objectStoreNames.contains('api_cache')) {
      e.target.result.createObjectStore('api_cache');
    }
  };
  request.onsuccess = e => resolve(e.target.result);
  request.onerror = () => reject(request.error);
});

async function getCachedData(key, maxAgeMs = 86400000) {
  try {
    const db = await dbPromise;
    return await new Promise(resolve => {
      const tx = db.transaction('api_cache', 'readonly');
      const store = tx.objectStore('api_cache');
      const req = store.get(key);
      req.onsuccess = () => {
        const row = req.result;
        if (row && (Date.now() - row.timestamp < maxAgeMs)) {
          resolve(row.data);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function setCachedData(key, data) {
  try {
    const db = await dbPromise;
    await new Promise(resolve => {
      const tx = db.transaction('api_cache', 'readwrite');
      const store = tx.objectStore('api_cache');
      store.put({ data, timestamp: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {}
}

// Cache the *processed* search result as well as the raw provider responses.
// Overpass caching avoids another download, but without this layer DriveHub still
// re-processed and re-scored the same roads every time a user repeated a search.
// Road topology changes slowly, so a one-day cache is a useful balance between
// responsiveness and freshness.
const SEARCH_RESULT_CACHE_TTL_MS = 86400000;
function cacheCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : 'na';
}
function currentRouteRangeCachePart() {
  if (state.routeMode === 'time') {
    const min = Number(document.getElementById('routeMinTime')?.value || 5);
    const max = Number(document.getElementById('routeMaxTime')?.value || 120);
    return `time:${min}:${max}`;
  }
  const min = Number(els.routeMinRange?.value || 0);
  const max = Number(els.routeMaxRange?.value || 0);
  return `distance:${min}:${max}`;
}
function makeSearchResultCacheKey({ lat, lon, distKm = 0, endLat = null, endLon = null, isA2B = false, tab = state.currentTab } = {}) {
  const origin = `${cacheCoord(lat)},${cacheCoord(lon)}`;
  if (isA2B) return `search-result:v14120-score2:a2b:${origin}:${cacheCoord(endLat)},${cacheCoord(endLon)}`;
  if (tab === 'routes') return `search-result:v14120-score2:routes:${origin}:r${Number(distKm || 0)}:${currentRouteRangeCachePart()}`;
  return `search-result:v14120-score2:roads:${origin}:r${Number(distKm || 0)}`;
}
async function restoreSearchResultCache(key) {
  if (!key) return false;
  const cached = await getCachedData(key, SEARCH_RESULT_CACHE_TTL_MS);
  if (!cached || cached.version !== 1) return false;
  state.masterRoads = Array.isArray(cached.masterRoads) ? cached.masterRoads : [];
  state.excludedRoads = Array.isArray(cached.excludedRoads) ? cached.excludedRoads : [];
  state.allProcessedRoads = Array.isArray(cached.allProcessedRoads) ? cached.allProcessedRoads : [];
  state.masterRoutes = Array.isArray(cached.masterRoutes) ? cached.masterRoutes : [];
  state.turnRestrictions = new Map(Array.isArray(cached.turnRestrictions) ? cached.turnRestrictions : []);
  state.routeDistanceChosen = Boolean(cached.routeDistanceChosen || state.masterRoutes.length);
  state.hasSearched = true;
  debugLog('[Result Cache Hit]', key, { roads: state.masterRoads.length, routes: state.masterRoutes.length });
  return Boolean(state.masterRoads.length || state.masterRoutes.length);
}
async function saveSearchResultCache(key) {
  if (!key || (!state.masterRoads.length && !state.masterRoutes.length)) return;
  await setCachedData(key, {
    version: 1,
    masterRoads: state.masterRoads,
    excludedRoads: state.excludedRoads,
    allProcessedRoads: state.allProcessedRoads,
    masterRoutes: state.masterRoutes,
    turnRestrictions: [...(state.turnRestrictions || new Map()).entries()],
    routeDistanceChosen: state.routeDistanceChosen
  });
}

const APP_STATE_KEY = 'roadfinder_app_state_v2';

let savePrefsTimer = null;
function savePrefs(){
  try{
    const payload = {
      searchMode: state.searchMode,
      addr: els.addr?.value || '',
      addrTo: els.addrTo?.value || '',
      dist: els.dist?.value || '10',
      currentTab: state.currentTab,
      hasSearched: state.hasSearched,
      routeDistanceChosen: state.routeDistanceChosen,
      routeTypeFilter: state.routeTypeFilter,
      favsOnly: state.favsOnly,
      picksOnly: state.picksOnly,
      activeTiers: [...state.activeTiers],
      selectedId: state.selectedId,
      lastView: map ? { center: map.getCenter(), zoom: map.getZoom() } : null
    };
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(payload));
  }catch(err){}
}
function saveAppState(){
  clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(savePrefs, 500);
}

function restoreAppState(){
  try{
    const raw = localStorage.getItem(APP_STATE_KEY);
    if(!raw) return false;
    const saved = JSON.parse(raw);

    // Keep user preferences but start fresh without previous search data
    // Always default to Roads tab on a fresh load as requested
    const startTab = 'roads';

    state.searchMode = saved.searchMode === 'a2b' ? 'a2b' : 'circular';

    state.debugMode = DEVELOPER_MODE;
    // Saved/Top-picks are view filters, not durable search preferences. Restoring
    // them can make a fresh search report valid roads while hiding every card
    // and every map line. Always start a new session with the full result set.
    state.favsOnly = false;
    state.picksOnly = false;
    // Road Score visibility is a view default, not a durable preference. Start
    // every session focused on the genuinely strong roads; users can widen the
    // filter to Great/Good for the current session when they want more coverage.
    state.activeTiers = new Set(DEFAULT_ROAD_TIERS);

    // Do NOT restore the previous search results or location values
    state.hasSearched = false;
    state.routeDistanceChosen = false;
    state.routeTypeFilter = saved.routeTypeFilter && typeof saved.routeTypeFilter === 'object'
      ? { circular: saved.routeTypeFilter.circular !== false, a2b: saved.routeTypeFilter.a2b !== false }
      : { circular: true, a2b: true };
    state.masterRoads = [];
    state.excludedRoads = [];
    state.masterRoutes = [];
    state.allProcessedRoads = [];
    state.selectedId = null;

    // Optional: Keep the user's last geographic map location so they don't have to pan across the world
    if(saved.lastView?.center && Number.isFinite(saved.lastView?.zoom)){
      map.setView([saved.lastView.center.lat, saved.lastView.center.lng], saved.lastView.zoom);
    }

    if(els.debugToggle) {
      els.debugToggle.checked = state.debugMode;
      const debugLabel=document.getElementById('debugLabel');
      if(debugLabel)debugLabel.style.display=DEVELOPER_MODE?'flex':'none';
      if (els.debugSearchWrap) els.debugSearchWrap.style.display = state.debugMode ? 'block' : 'none';
    }

    syncTiersUI();

    // Force the UI to reflect the selected tab immediately
    state.currentTab = null; 
    switchTab(startTab, true);
    syncSearchKindUI();

    // Render the empty fresh state
    renderResults(); 

    return true;
  }catch(err){
    return false;
  }
}


// ── MOBILE SEARCH / RESULTS WORKSPACE ──────────────────────────────────────
// Search, Results and Map are now controlled by the primary bottom navigation.
// The panes still share a single mobile footprint; this controller only manages
// their visibility and automatic transition to Results when a search completes.

// ── BOTTOM SHEET DRAG GESTURES ──
let sheetStartY = 0;
let sheetCurrentY = 0;
let isDragging = false;
let isDragAction = false;

els.sheetToggle.addEventListener('mousedown', dragStart);
els.sheetToggle.addEventListener('touchstart', dragStart, {passive: true});

function dragStart(e) {
  isDragging = true;
  isDragAction = false;
  sheetStartY = e.touches ? e.touches[0].clientY : e.clientY;
  sheetCurrentY = sheetStartY;
  els.sidebar.style.transition = 'none';
  document.addEventListener('mousemove', dragMove);
  document.addEventListener('touchmove', dragMove, {passive: false});
  document.addEventListener('mouseup', dragEnd);
  document.addEventListener('touchend', dragEnd);
}

function dragMove(e) {
  if(!isDragging) return;
  sheetCurrentY = e.touches ? e.touches[0].clientY : e.clientY;
  const delta = sheetCurrentY - sheetStartY;
  if(Math.abs(delta) > 5) isDragAction = true;

  if (els.sidebar.classList.contains('collapsed')) {
    if (delta < 0) els.sidebar.style.transform = `translateY(calc(100% - ${MOBILE_SHEET_HANDLE_PX}px + ${Math.max(-200, delta)}px))`;
  } else {
    if (delta > 0) els.sidebar.style.transform = `translateY(${Math.min(500, delta)}px)`;
  }
}

function dragEnd(e) {
  if(!isDragging) return;
  isDragging = false;
  document.removeEventListener('mousemove', dragMove);
  document.removeEventListener('touchmove', dragMove);
  document.removeEventListener('mouseup', dragEnd);
  document.removeEventListener('touchend', dragEnd);

  els.sidebar.style.transition = '';
  els.sidebar.style.transform = '';

  if (isDragAction) {
    const delta = sheetCurrentY - sheetStartY;
    const isCollapsed = state.ui?.resultsPanel === 'collapsed' || els.sidebar.classList.contains('collapsed');

    if (isCollapsed) {
      if (delta < -50) setPanelState({ resultsPanel: 'open' }, 'drag-open-results');
    } else {
      if (delta > 50) setPanelState({ resultsPanel: 'collapsed' }, 'drag-close-results');
    }

    setTimeout(() => { isDragAction = false; }, 0);
  }
}

els.sheetToggle.addEventListener('click', (e) => {
  if (isDragAction) {
    e.preventDefault();
    e.stopPropagation();
    setTimeout(() => { isDragAction = false; }, 0);
    return;
  }
  const currentlyCollapsed = state.ui?.resultsPanel === 'collapsed' || els.sidebar.classList.contains('collapsed');
  setPanelState({ resultsPanel: currentlyCollapsed ? 'open' : 'collapsed' }, 'sheet-toggle');
});

els.topToggleBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const currentlyCollapsed = state.ui?.searchPanel === 'collapsed' || els.topPanel?.classList.contains('collapsed');
  setPanelState({ searchPanel: currentlyCollapsed ? 'open' : 'collapsed' }, 'top-search-toggle');
});

const resultsCollapseBtn = document.getElementById('resultsCollapseBtn');
resultsCollapseBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const currentlyCollapsed = state.ui?.resultsPanel === 'collapsed' || els.sidebar?.classList.contains('collapsed');
  setPanelState({ resultsPanel: currentlyCollapsed ? 'open' : 'collapsed' }, 'results-header-toggle');
});

// v142.10: the whole visible panel header is an affordance, not just the small
// chevron. Interactive descendants keep their own behaviour.
const panelHeaderClickIsInteractive = target => !!target?.closest?.('button,a,input,select,textarea,summary,details,label');
const searchPanelHeader = els.topPanel?.querySelector('.hero-top');
searchPanelHeader?.addEventListener('click', (e) => {
  if (panelHeaderClickIsInteractive(e.target)) return;
  const currentlyCollapsed = state.ui?.searchPanel === 'collapsed' || els.topPanel?.classList.contains('collapsed');
  setPanelState({ searchPanel: currentlyCollapsed ? 'open' : 'collapsed' }, 'search-header-surface-toggle');
});
const resultsPanelHeader = els.sidebar?.querySelector('.results-header');
resultsPanelHeader?.addEventListener('click', (e) => {
  if (panelHeaderClickIsInteractive(e.target)) return;
  const currentlyCollapsed = state.ui?.resultsPanel === 'collapsed' || els.sidebar?.classList.contains('collapsed');
  setPanelState({ resultsPanel: currentlyCollapsed ? 'open' : 'collapsed' }, 'results-header-surface-toggle');
});

let _panelResizeTimer = null;
window.addEventListener('resize',()=>{
  clearTimeout(_panelResizeTimer);
  _panelResizeTimer = setTimeout(() => {
    relocateScoringUI();
    setPanelState({}, 'resize-repair');
    try {
      smoothInvalidateSize();
      if(state.hasSearched && roadLayers.getLayers().length > 0 && state.selectedId === null) {
        const bounds = roadLayers.getBounds();
        if(bounds.isValid()) focusRoadBounds(bounds, { smooth: false, scope: 'results' });
      }
    } catch(e) {}
  }, 150);
});
els.scoringToggle.addEventListener('click',()=>{
  const open = els.scoringToggle.getAttribute('aria-expanded')==='true';
  els.scoringToggle.setAttribute('aria-expanded',String(!open));
  els.scoringPanel.hidden = open;
});
els.debugToggle?.addEventListener('change',e=>{ 
  state.debugMode=e.target.checked; 
  if (els.debugSearchWrap) els.debugSearchWrap.style.display = state.debugMode ? 'block' : 'none';
  if (!state.debugMode && els.debugSearchResults) els.debugSearchResults.innerHTML = '';
  if (els.debugSearchInput) els.debugSearchInput.value = '';
  renderResults(); 
  saveAppState(); 
});
if (els.debugSearchInput) {
  els.debugSearchInput.addEventListener('input', e => renderDebugSearchResults(e.target.value));
}
els.routeMinRange?.addEventListener('input',()=>syncRouteDistanceControls(els.routeMinRange));
els.routeMaxRange?.addEventListener('input',()=>syncRouteDistanceControls(els.routeMaxRange));
document.getElementById('routeMinTime')?.addEventListener('input',()=>syncRouteDistanceControls(document.getElementById('routeMinTime')));
document.getElementById('routeMaxTime')?.addEventListener('input',()=>syncRouteDistanceControls(document.getElementById('routeMaxTime')));

function updateSearchUI() {
  syncFilterChipsUI();
  const isRoutes = state.currentTab === 'routes';
  const isA2B = isRoutes && state.searchMode === 'a2b';
  const topbar = els.searchForm ? els.searchForm.querySelector('.search-topbar') : null;
  const radiusField = els.dist ? (els.dist.closest('.field') || els.dist.parentElement) : null;

  syncSearchKindUI();

  // The search card is reused across all three modes, so its heading has to say
  // which one you are in. On the routes tab it is genuinely step one of two.
  const setCardCopy = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  if (isA2B) {
    setCardCopy('roadSearchEyebrow', 'Route');
    setCardCopy('roadSearchTitle', 'Plan A to B');
    setCardCopy('roadSearchCopy', 'Enter where you are starting and where you are heading.');
  } else if (isRoutes) {
    setCardCopy('roadSearchEyebrow', 'Step 1');
    setCardCopy('roadSearchTitle', 'Where do you want to drive?');
    setCardCopy('roadSearchCopy', 'Choose the area to start from, then set the kind of round trip you want.');
    setCardCopy('routeBuilderEyebrow', 'Step 2');
  } else {
    setCardCopy('roadSearchEyebrow', 'Explore');
    setCardCopy('roadSearchTitle', 'Search area');
    setCardCopy('roadSearchCopy', 'Look for rewarding roads around a town, landmark or well-known route.');
  }

  // #routeSearchControls is the container for the mode toggle and route building tools.
  if (isRoutes) {
    if(els.routeSearchControls) els.routeSearchControls.style.display = 'block';
    if(els.roadSearchControls) els.roadSearchControls.style.display = 'block';

    const routeBuilderTitle = document.getElementById('routeBuilderTitle');
    const routeBuilderCopy = document.getElementById('routeBuilderCopy');
    const routeBuilderTools = document.getElementById('routeBuilderTools');
    const routeSearchBtn = document.getElementById('routeSearchBtn');

    const routeBuilderCard = document.querySelector('.route-builder-card');

    if (isA2B) {
      if(topbar) topbar.classList.add('a2b-layout');
      if(routeBuilderTitle) routeBuilderTitle.style.display = 'none';
      if(routeBuilderCard) routeBuilderCard.style.display = 'none';
      if(routeBuilderCopy) routeBuilderCopy.style.display = 'none';
      if(routeBuilderTools) routeBuilderTools.style.display = 'none';
      if(routeSearchBtn) routeSearchBtn.style.display = 'none';
      if(els.routeSearchHint) els.routeSearchHint.style.display = 'none';

      if(els.a2bToSlot) { els.a2bToSlot.style.display = 'flex'; els.a2bToSlot.style.borderTop = 'none'; }
      if(els.a2bDivider) els.a2bDivider.style.display = 'block';
      if(radiusField) radiusField.style.display = 'none';
      const div = document.querySelector('.search-divider');
      if(div) div.style.display = 'none';
      if(els.addr) els.addr.placeholder = 'Start location...';
      const addrLabelA2B = document.getElementById('addrLabel');
      if(addrLabelA2B) addrLabelA2B.textContent = 'Start';
      if(els.searchBtn) els.searchBtn.innerHTML = '<span>Build route</span>';
    } else {
      if(topbar) topbar.classList.remove('a2b-layout');
      if(routeBuilderTitle) {
          routeBuilderTitle.style.display = 'block';
          routeBuilderTitle.textContent = 'Choose your drive';
      }
      if(routeBuilderCard) routeBuilderCard.style.display = 'block';
      if(routeBuilderCopy) routeBuilderCopy.style.display = 'none';
      if(routeBuilderTools) routeBuilderTools.style.display = 'block';
      if(routeSearchBtn) {
          routeSearchBtn.style.display = state.hasSearched ? 'block' : 'none';
          routeSearchBtn.textContent = 'Update routes';
      }
      if(els.routeSearchHint) els.routeSearchHint.style.display = 'none';

      if(els.a2bToSlot) els.a2bToSlot.style.display = 'none';
      if(els.a2bDivider) els.a2bDivider.style.display = 'none';
      if(radiusField) radiusField.style.display = 'flex';
      const div = document.querySelector('.search-divider');
      if(div) div.style.display = 'block';
      if(els.addr) els.addr.placeholder = 'Peak District, Snake Pass...';
      const addrLabelDefault = document.getElementById('addrLabel');
      if(addrLabelDefault) addrLabelDefault.textContent = 'Location';
      if(els.searchBtn) els.searchBtn.innerHTML = '<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.8" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.35-4.35"></path></svg><span>Find routes</span>';
    }
  } else {
    // Roads Tab
    if(topbar) topbar.classList.remove('a2b-layout');
    if(els.roadSearchControls) els.roadSearchControls.style.display = 'block';
    if(els.routeSearchControls) els.routeSearchControls.style.display = 'none';
    if(els.routeSearchHint) els.routeSearchHint.style.display = 'none';

    // Force Circular style on main search
    if(els.a2bToSlot) els.a2bToSlot.style.display = 'none';
    if(els.a2bDivider) els.a2bDivider.style.display = 'none';
    if(els.dist && els.dist.parentElement) els.dist.parentElement.style.display = 'flex';
    const div = document.querySelector('.search-divider');
    if(div) div.style.display = 'block';
    if(els.addr) els.addr.placeholder = 'Peak District, Snake Pass...';
    if(els.searchBtn) els.searchBtn.innerHTML = '<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.8" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.35-4.35"></path></svg><span>Find roads</span>';
  }
}

function getSearchKind(){
  if (state.currentTab !== 'routes') return 'roads';
  return state.searchMode === 'a2b' ? 'a2b' : 'routes';
}

function syncSearchKindUI(){
  const kind = getSearchKind();
  const buttons = {
    roads: document.getElementById('searchKindRoads'),
    routes: document.getElementById('searchKindRoutes'),
    a2b: document.getElementById('searchKindA2b')
  };
  for (const [key, button] of Object.entries(buttons)) {
    const active = key === kind;
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', String(active));
  }
}

function clearModeSpecificResults(){
  state.hasSearched = false;
  state.masterRoads = [];
  state.masterRoutes = [];
  state.excludedRoads = [];
  state.allProcessedRoads = [];
  state.selectedId = null;
  state.routeDistanceChosen = false;
  roadLayers.clearLayers();
  renderResults();
}

function switchTab(id, forceUpdate=false){
  if(state.currentTab===id && !forceUpdate) return;
  state.currentTab=id;
  els.resultsTitle.textContent=id==='roads'?'Best roads':'Suggested drives';
  els.routeFilters.style.display='none';
  if (els.debugLabel) els.debugLabel.style.display=(DEVELOPER_MODE && id==='roads')?'flex':'none';
  mountDebugControl();
  relocateScoringUI();
  updateSearchUI();

  if(id==='routes') {
    const searchSec=document.getElementById('searchSection');
    if(searchSec) searchSec.classList.add('open');
  }

  if(id==='routes'&&state.hasSearched&&!state.routeDistanceChosen&&state.searchMode!=='a2b') {
    setStatus('Choose a route distance range and press Update routes.','info');
  }

  if(state.hasSearched) renderResults();
  else if (forceUpdate) renderResults();
}

function selectSearchKind(kind, {preserveResults=false} = {}){
  if (!['roads','routes','a2b'].includes(kind)) kind = 'roads';
  const previous = getSearchKind();
  const nextTab = kind === 'roads' ? 'roads' : 'routes';
  const nextMode = kind === 'a2b' ? 'a2b' : 'circular';

  if (previous !== kind && state.hasSearched && !preserveResults) clearModeSpecificResults();
  state.searchMode = nextMode;
  switchTab(nextTab, true);
  syncSearchKindUI();
  updateSearchUI();
  saveAppState();

  if (usesMobileWorkspace()) showMobileWorkspace('search', 'search-kind-change');
  requestAnimationFrame(() => {
    const collapsible = document.querySelector('#topSearchPanel .top-collapsible');
    if (collapsible) collapsible.scrollTop = 0;
  });
}

document.getElementById('searchKindRoads')?.addEventListener('click', () => selectSearchKind('roads'));
document.getElementById('searchKindRoutes')?.addEventListener('click', () => selectSearchKind('routes'));
document.getElementById('searchKindA2b')?.addEventListener('click', () => selectSearchKind('a2b'));

let _drivehubActivity = null;
function setStatus(message, state='info') {
  const text = String(message || '').trim();
  const chrome = window.DriveHubChrome;
  if (chrome?.showStatus) {
    chrome.showStatus(text, state);
    return;
  }
  // The shared shell loads synchronously immediately after Road Finder's app
  // script in older standalone builds. Retry once rather than creating a
  // second tool-specific toast surface.
  if (text) setTimeout(() => window.DriveHubChrome?.showStatus?.(text, state), 0);
}
function setLoading(on,msg='Finding roads…'){
  if (on) {
    if (_drivehubActivity?.update) {
      _drivehubActivity.update(msg);
    } else {
      _drivehubActivity = window.DriveHubChrome?.beginActivity?.(msg) || null;
    }
  } else {
    _drivehubActivity?.();
    _drivehubActivity = null;
  }
  document.body.classList.toggle('rf-loading', Boolean(on));
  document.body.setAttribute('aria-busy', on ? 'true' : 'false');
  [els.searchBtn, els.routeSearchBtn, els.locateBtn].forEach(btn => { if (btn) btn.disabled = !!on; });
}
function getColor(s) {
  if (s >= 70) return '#e2ac21';   // y-500  — top roads
  if (s >= 50) return '#1f7754';   // accent-600
  if (s >= 30) return '#63b98c';   // accent-400
  return '#a6bab7';                // neutral-400
}

function focusRoadBounds(bounds, opts = {}) {
  if(!bounds || !bounds.isValid()) return;
  // Do not auto-fit while the user is manually wheel/trackpad zooming.
  // This prevents the UI from fighting the map and producing a jumpy feel.
  if (state.isUserZooming && !opts.force) return;

  const topPanel = document.getElementById('topSearchPanel');
  const sidePanel = document.getElementById('sidebar');
  const mobileLike = isMobile();
  const mobileWorkspace = usesMobileWorkspace();
  const workspaceView = state.ui?.mobileWorkspace || 'map';
  const scope = opts.scope === 'selected' ? 'selected' : 'results';

  let leftPad = 24;
  let topPad = 24;
  let rightPad = 24;
  let bottomPad = 24;

  if (mobileWorkspace) {
    // The old fitter reserved space for the legacy 50–72% bottom sheet even
    // after Road Finder moved to overlay panes. That made every fit much wider
    // than the geometry required. In Map view the only persistent obstruction
    // is the primary bottom nav, so fit tightly to the actual visible map.
    leftPad = 16;
    rightPad = 16;
    topPad = 16;
    const navRect = document.querySelector('.bottom-nav')?.getBoundingClientRect?.();
    bottomPad = navRect ? Math.max(22, window.innerHeight - navRect.top + 14) : 88;

    // If a fit is explicitly requested while Search/Results is open, protect
    // the exposed map below the pane without pretending the pane lives at the
    // bottom of the screen. Normal card -> map selection fits after the pane
    // has closed, so this branch is intentionally uncommon.
    if (workspaceView !== 'map' && opts.accountForPane !== false) {
      const activePane = workspaceView === 'results' ? sidePanel : topPanel;
      const rect = activePane?.getBoundingClientRect?.();
      if (rect && rect.bottom > 0) topPad = Math.max(topPad, Math.min(window.innerHeight * 0.62, rect.bottom + 12));
    }
  } else {
    if (topPanel && !topPanel.classList.contains('collapsed')) {
      const rect = topPanel.getBoundingClientRect();
      if (!mobileLike) {
        // Desktop search is a left-hand surface, not a top sheet. Reserve its
        // actual horizontal footprint so fitted roads sit in the visible map
        // rather than being pushed unnecessarily downward.
        leftPad = Math.max(leftPad, rect.right + 18);
        topPad = 24;
      } else {
        topPad = (rect.height || topPanel.offsetHeight || 0) + 24;
      }
    } else if (topPanel && topPanel.classList.contains('collapsed')) {
      if (!mobileLike) leftPad = 78;
      else topPad = 72;
    }

    if (!mobileLike && sidePanel && !sidePanel.classList.contains('collapsed')) {
      const rect = sidePanel.getBoundingClientRect();
      rightPad = (rect.width || sidePanel.offsetWidth || 0) + 28;
    }

    if (mobileLike && sidePanel) {
      bottomPad = sidePanel.classList.contains('collapsed')
        ? 80
        : Math.min(sidePanel.getBoundingClientRect().height || (window.innerHeight * 0.72), window.innerHeight - 140) + 16;
    }
  }

  const isRoute = state.currentTab === 'routes';
  const isA2B = isRoute && state.searchMode === 'a2b';
  // A selected item should fill the useful map area. The old maxZoom values
  // (15 for roads / 13 for loops) artificially forced short results to stay
  // zoomed out even when their exact bounds could be shown much more clearly.
  const maxZoom = scope === 'selected'
    ? (isRoute ? 16 : 17)
    : (isRoute ? (isA2B ? 15 : 15) : 16);

  const useFly = opts.smooth !== false && !prefersReducedMotion();
  smoothFitBounds(bounds, {
    paddingTopLeft: [leftPad, topPad],
    paddingBottomRight: [rightPad, bottomPad],
    maxZoom,
    smooth: useFly,
    duration: opts.duration || (scope === 'selected' ? 0.58 : 0.48),
    easeLinearity: 0.26
  });
}

function getItemMapBounds(itemId) {
  if (itemId === null || itemId === undefined) return null;
  const key = String(itemId);
  const polys = state.polylineMap.get(key) || state.polylines.filter(p => String(p.itemId) === key);
  if (!polys || !polys.length) return null;
  try {
    const bounds = L.featureGroup(polys).getBounds();
    return bounds && bounds.isValid() ? bounds : null;
  } catch (e) {
    return null;
  }
}

function focusSelectedMapItem(itemId = state.selectedId, opts = {}) {
  const bounds = getItemMapBounds(itemId);
  if (!bounds) return false;
  focusRoadBounds(bounds, { ...opts, scope: 'selected', accountForPane: false });
  return true;
}

function scheduleSelectedMapFocus(itemId = state.selectedId, delay = MOBILE_WORKSPACE_TRANSITION_MS) {
  setTimeout(() => {
    smoothInvalidateSize();
    requestAnimationFrame(() => focusSelectedMapItem(itemId));
  }, Math.max(0, delay));
}
function getRoadStrokeStyle(road, selected) {
  let w = road.score >= 70 ? 10 : 7;
  const baseWeight = selected ? w + 2 : w;
  const baseOpacity = selected ? 1 : 0.9;
  if (road.isExcluded) return { color: '#9ca3af', weight: selected ? 6 : 4, dashArray: '5,8', opacity: 0.55, lineCap:'round', lineJoin:'round' };
  if (road.connector) return { color: '#ffffff', weight: selected ? 8 : 6, opacity: 0.6, lineCap:'round', lineJoin:'round' };
  return { color: '#ffffff', weight: baseWeight, opacity: baseOpacity, lineCap:'round', lineJoin:'round' };
}
function getRoadInnerStyle(road, selected) {
  let w = road.score >= 70 ? 6 : 3;
  const fw = selected ? w + 2 : w;
  const op = selected ? 1 : 0.9;
  if (road.isExcluded) return { color: '#6b7280', weight: selected ? 4 : 2, dashArray: '5,8', opacity: 0.55, lineCap:'round', lineJoin:'round' };
  if (road.connector) return { color: '#9ca3af', weight: fw, opacity: op, lineCap:'round', lineJoin:'round' };
  return { color: getColor(road.score), weight: fw, opacity: op, lineCap:'round', lineJoin:'round' };
}

// ── SELECTION PULSE ANIMATION ────────────────────────────────────────────────
// Subtle stroke-weight pulse on the selected polyline. Driven by requestAnimationFrame
// rather than CSS since canvas polylines don't support CSS animations.
let _pulseRafId = null;
let _pulseStartTs = 0;
function startSelectionPulse() {
  stopSelectionPulse();
  if (prefersReducedMotion()) return; // Respect user preference
  _pulseStartTs = performance.now();
  const tick = (now) => {
    if (state.selectedId === null) { _pulseRafId = null; return; }
    if (state.isZooming) {
      // Don't compete with the zoom animation for canvas redraws
      _pulseRafId = requestAnimationFrame(tick);
      return;
    }
    const elapsed = now - _pulseStartTs;
    // 1.6s cycle, sine-based smooth pulse between 0 and 1
    const phase = (elapsed % 1600) / 1600;
    const t = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0→1→0 smooth
    // Subtle: +/- 1.5px weight and 0.85-1.0 opacity
    const selectedPolys = state.polylineMap.get(String(state.selectedId));
    if (selectedPolys) {
      for (const poly of selectedPolys) {
        if (poly.isTooltip || !poly.setStyle || !poly.road) continue;
        const base = poly.inner ? getRoadInnerStyle(poly.road, true) : getRoadStrokeStyle(poly.road, true);
        // Only pulse the outer stroke (inner stays solid) for a nicer glow effect
        if (!poly.inner) {
          poly.setStyle({
            ...base,
            weight: base.weight + t * 3,
            opacity: Math.max(0.5, base.opacity - t * 0.3)
          });
        }
      }
    }
    _pulseRafId = requestAnimationFrame(tick);
  };
  _pulseRafId = requestAnimationFrame(tick);
}
function stopSelectionPulse() {
  if (_pulseRafId !== null) {
    cancelAnimationFrame(_pulseRafId);
    _pulseRafId = null;
  }
}

function toggleFav(id) {
  const strId = String(id);
  const isNowFav = !state.favs.has(strId);
  if(isNowFav) state.favs.add(strId);
  else state.favs.delete(strId);
  localStorage.setItem(ROAD_FINDER_FAVS_KEY, JSON.stringify([...state.favs]));

  // If the "Saved" filter is on, a fav change changes which cards should show,
  // so we need a full re-render. Same if "Top Picks" is on (picks recalculate).
  if (state.favsOnly || state.picksOnly) {
    renderResults();
    savePrefs();
    return;
  }

  // Surgical DOM update: just update the star SVG on this specific card,
  // avoiding a full Leaflet polyline teardown/rebuild.
  const card = state.cardMap.get(strId) || els.results.querySelector(`.road-card[data-item-id="${strId}"]`);
  if (card) {
    const star = card.querySelector('.fav-icon');
    if (star) {
      star.setAttribute('fill', isNowFav ? '#eab308' : 'none');
      star.setAttribute('stroke', isNowFav ? '#eab308' : '#94a3b8');
      star.classList.toggle('active', isNowFav);
      star.classList.add('pop-anim');
      setTimeout(() => star.classList.remove('pop-anim'), 400);
    }
  }

  // Update the on-map star tooltip for routes (roads have inline stars in name labels,
  // which we'd need to re-render to update — skip for perf, will refresh on next interaction)
  if (isNowFav) {
    const route = state.masterRoutes.find(r => String(r.id) === strId);
    if (route && route.coords) {
      const center = route.coords[Math.floor(route.coords.length/2)];
      if (center) {
        const ttStar = L.tooltip({permanent:true, direction:'center', className:'road-label-overlay star-only', interactive:false, opacity:1})
          .setLatLng(center)
          .setContent(`<span style="color:#eab308;font-size:24px;text-shadow:0 0 10px rgba(0,0,0,0.5);">★</span>`)
          .addTo(roadLayers);
        state.polylines.push({ isTooltip: true, tt: ttStar, routeIds: [route.id], labelKey: 'STAR_'+route.id });
      }
    }
  } else {
    // Remove the star tooltip
    const starIdx = state.polylines.findIndex(p => p.isTooltip && p.labelKey === 'STAR_'+id);
    if (starIdx !== -1) {
      const p = state.polylines[starIdx];
      try { roadLayers.removeLayer(p.tt); } catch(e) {}
      state.polylines.splice(starIdx, 1);
    }
  }

  savePrefs();
}

function getTierLabel(s){ return s>=70?'Top road':s>=50?'Exceptional':s>=30?'Great':'Good'; }
function getRoadName(t){ if(t.name) return t.name; if(t.ref) return t.ref; return 'Unnamed Road'; }
function updateCount(t){
  els.toolbarCount.textContent=t;
  const badge=document.getElementById('mobileResultsCount');
  if(!badge)return;
  const match=String(t||'').match(/^(\d+)/);
  if(match&&Number(match[1])>0){badge.textContent=match[1];badge.hidden=false;}
  else badge.hidden=true;
}
function clearNameTooltip(){
  if(state.nameTooltip){ map.removeLayer(state.nameTooltip); state.nameTooltip=null; }
}
function showNameTooltip(item){
  clearNameTooltip();
  if(!item||!item.coords||!item.coords.length) return;
  const mid=item.coords[Math.floor(item.coords.length/2)];
  if(!mid) return;
  state.nameTooltip = L.tooltip({permanent:true,direction:'center',className:'map-name-tooltip',offset:[0,0],interactive:false,opacity:1})
    .setLatLng(mid)
    .setContent(escapeHtml(item.name||'Unnamed Road'))
    .addTo(map);
}
function formatRouteSpeed(route){
  const min=Number.isFinite(route?.minSpd)?route.minSpd:0;
  const max=Number.isFinite(route?.maxSpd)?route.maxSpd:0;
  if(min>0&&max>0) return min===max ? `${min}` : `${min}-${max}`;
  if(max>0) return `${max}`;
  if(min>0) return `${min}`;
  return '—';
}

function routeRationale(route, evidence={}){
  const coverage=Math.max(0,Math.min(100,Math.round(Number(evidence.ratedRatio ?? route?.driverRoadRatio ?? 0)*100)));
  const score=Number(route?.score||0);
  const profile=String(route?.routeProfile||'').toLowerCase();
  const good=(route?.roadDetails||[])
    .filter(r=>r?.isGood&&String(r.name||'').trim()&&String(r.name).toLowerCase()!=='unnamed road')
    .sort((a,b)=>(Number(b.score||0)*Math.max(.25,Number(b.len||0)))-(Number(a.score||0)*Math.max(.25,Number(a.len||0))));
  const names=[...new Set(good.map(r=>String(r.name).trim()))].slice(0,2);
  const roadsText=names.length===2?`${names[0]} and ${names[1]}`:names[0]||'';
  if(profile.includes('direct')){
    if(roadsText&&coverage>=35)return `Keeps the journey direct while picking up stronger sections around ${roadsText}.`;
    return 'Prioritises the most direct practical drive, using rated roads where they naturally fit.';
  }
  if(coverage>=75&&score>=60){
    return roadsText?`Most of the drive stays on rated roads, led by ${roadsText}.`:'Most of the drive stays on highly rated roads with little connector mileage.';
  }
  if(coverage>=50){
    return roadsText?`Prioritises ${roadsText} for the strongest sections, with connectors between them.`:'Balances worthwhile rated-road sections with the connectors needed to make the route work.';
  }
  if(roadsText)return `Uses ${roadsText} where practical, but more of this option is connector road.`;
  return 'A practical alternative with fewer scored-road sections than the higher-ranked options.';
}
function syncRouteDistanceControls(activeEl=null){
  if(!els.routeMinRange || !els.routeMaxRange) return;
  let minV=parseInt(els.routeMinRange.value,10), maxV=parseInt(els.routeMaxRange.value,10);
  if(minV>maxV){
    if(activeEl===els.routeMinRange){ maxV=minV; els.routeMaxRange.value=String(maxV); }
    else { minV=maxV; els.routeMinRange.value=String(minV); }
  }
  if(els.routeMinValue) els.routeMinValue.textContent=`${minV} km`;
  if(els.routeMaxValue) els.routeMaxValue.textContent=`${maxV} km`;

  const rtMin = document.getElementById('routeMinTime');
  const rtMax = document.getElementById('routeMaxTime');
  const rtMinVal = document.getElementById('routeMinTimeValue');
  const rtMaxVal = document.getElementById('routeMaxTimeValue');
  if(rtMin && rtMax) {
    let minT=parseInt(rtMin.value,10), maxT=parseInt(rtMax.value,10);
    if(minT>maxT){
      if(activeEl===rtMin){ maxT=minT; rtMax.value=String(maxT); }
      else { minT=maxT; rtMin.value=String(minT); }
    }
    const fmt = m => m>=60 ? `${Math.floor(m/60)}h ${m%60||''}m`.trim() : `${m} mins`;
    if(rtMinVal) rtMinVal.textContent=fmt(minT);
    if(rtMaxVal) rtMaxVal.textContent=fmt(maxT);
  }
}
function openResultsSection(){
  if (showMobileWorkspace('results', 'open-results')) return;
  setPanelState({ resultsPanel: 'open' }, 'open-results');
}

function collapseResultsSection(){
  if (usesMobileWorkspace()) { showMobileWorkspace('map', 'collapse-results'); return; }
  setPanelState({ resultsPanel: 'collapsed' }, 'collapse-results');
}

function handleSearchCompletion() {
  // On phones, a completed search should reveal the thing the user actually
  // searched for: the roads/routes on the map. Results remain one tap away in
  // the primary nav, and tapping a map item opens Results focused on that item.
  if (usesMobileWorkspace()) {
    showMobileWorkspace('map', 'search-complete-show-map');
    return;
  }

  // Keep the richer desktop layout unchanged.
  setPanelState({ searchPanel: 'collapsed', resultsPanel: 'open' }, 'search-complete');
}

async function buildRoutesForSelection(){
  if(state.searchMode === 'a2b') return; // Prevent A2B from triggering circular route logic
  if(!state.hasSearched||!state.allProcessedRoads.length){
    setStatus('Search roads first, then build best routes.','error');
    return false;
  }
  syncRouteDistanceControls();

  const minD=parseFloat(els.routeMinRange.value||0), maxD=parseFloat(els.routeMaxRange.value||0);
  const rtMinEl = document.getElementById('routeMinTime');
  const rtMaxEl = document.getElementById('routeMaxTime');
  const minT=parseFloat((rtMinEl && rtMinEl.value) || 5), maxT=parseFloat((rtMaxEl && rtMaxEl.value) || 120);

  if(state.routeMode === 'distance') {
    if(!Number.isFinite(minD)||!Number.isFinite(maxD)||minD<1||maxD<minD){ setStatus('Choose a valid route distance range.','error'); return false; }
  } else {
    if(!Number.isFinite(minT)||!Number.isFinite(maxT)||minT<5||maxT<minT){ setStatus('Choose a valid route time range.','error'); return false; }
  }

  state.routeDistanceChosen=true;
  state.routesLoading=true;
  if(state.routeBuildTimer) { clearTimeout(state.routeBuildTimer); state.routeBuildTimer = null; }
  renderResults();
  setLoading(true,'Building route options…');
  if(els.routeSearchBtn) els.routeSearchBtn.disabled=true;
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try{
      const routeOpts = state.routeMode==='distance'?{minD,maxD}:{minT,maxT};
      const routeCacheKey = makeSearchResultCacheKey({
        lat: state.searchStart?.[0], lon: state.searchStart?.[1],
        distKm: Number(state.lastSearchMeta?.distKm || els.dist?.value || 0),
        tab: 'routes'
      });
      const cached = await getCachedData(routeCacheKey, SEARCH_RESULT_CACHE_TTL_MS);
      if (cached?.version === 1 && Array.isArray(cached.masterRoutes) && cached.masterRoutes.length) {
        state.masterRoutes = cached.masterRoutes;
        state.masterRoads = Array.isArray(cached.masterRoads) ? cached.masterRoads : state.masterRoads;
        state.excludedRoads = Array.isArray(cached.excludedRoads) ? cached.excludedRoads : state.excludedRoads;
        state.allProcessedRoads = Array.isArray(cached.allProcessedRoads) ? cached.allProcessedRoads : state.allProcessedRoads;
        state.turnRestrictions = new Map(Array.isArray(cached.turnRestrictions) ? cached.turnRestrictions : []);
        setStatus(`Showing ${state.masterRoutes.length} cached round trip${state.masterRoutes.length === 1 ? '' : 's'}.`, 'success');
        return true;
      }

      // This function is only used by Round trip mode (A-to-B exits above).
      // v141.8 still launched a second, expensive point-to-point graph search
      // after building loops. That both contradicted the selected mode and was
      // a major source of the endless "Building route options…" state.
      let circularRoutes = [];
      try {
          circularRoutes = await generateRoutes(state.allProcessedRoads, routeOpts);
      } catch (err) {
          console.error('Loop generation failed:', err);
          throw err;
      }

      state.masterRoutes = circularRoutes
        .sort((a,b)=>(b.rankScore||b.score||0)-(a.rankScore||a.score||0));

      const range = state.routeMode==='distance'?minD+' and '+maxD+' km':minT+' and '+maxT+' mins';
      if (state.masterRoutes.length === 0) {
          setStatus(`No viable round trips found between ${range}. Try widening the range.`, 'error');
      } else {
          const loopCount = circularRoutes.length;
          setStatus(`Found ${loopCount} round trip${loopCount!==1?'s':''}, built from the best-scoring roads nearby.`, 'success');
          await saveSearchResultCache(routeCacheKey);
      }
  }catch(err){
    if(err.name === 'AbortError' || err.message === 'Search cancelled.') return false;
    state.masterRoutes=[];
    setStatus(err.message||'Route generation failed.','error');
    return false;
  }finally{
    state.routesLoading=false;
    setLoading(false);
    handleSearchCompletion();
    renderResults();
  }
  return true;
}
function renderEmpty(title, message, options = {}) {
  const node = window.RoadFinderUIRenderers.createEmptyState({
    title,
    message,
    tone: options.tone || 'quiet',
    actionLabel: options.actionLabel || '',
    secondaryLabel: options.secondaryLabel || ''
  });
  node.querySelector('[data-state-action="primary"]')?.addEventListener('click', () => options.onAction?.());
  node.querySelector('[data-state-action="secondary"]')?.addEventListener('click', () => options.onSecondary?.());
  els.results.replaceChildren(node);
}
function reopenSearchFromState(reason='empty-state-edit'){
  if (usesMobileWorkspace()) { showMobileWorkspace('search', reason); return; }
  setPanelState({ searchPanel: 'open', resultsPanel: 'collapsed' }, reason);
}

// ── POLYLINE VISIBILITY ──────────────────────────────────────────────────────
// When nothing is selected → all visible at normal opacity.
// When one is selected → only that one is visible, others fade to 0.
function updatePolylineVisibility(){
  const sel = state.selectedId;
  const hov = state.hoveredId;
  for(const poly of state.polylines){
    if (poly.isTooltip) {
      const isSelected = poly.routeIds ? poly.routeIds.includes(sel) : poly.roadId === sel;
      const isHovered = poly.routeIds ? poly.routeIds.includes(hov) : poly.roadId === hov;
      let nextOpacity;
      if (sel === null) {
        nextOpacity = isHovered ? 1 : (hov ? 0.4 : ((poly.labelKey && poly.labelKey.startsWith('STAR_'))?1:0.85));
      } else {
        nextOpacity = (isSelected || isHovered) ? ((poly.labelKey && poly.labelKey.startsWith('STAR_'))?1:0.95) : 0;
      }
      // Skip setOpacity call if unchanged (Leaflet still triggers DOM writes otherwise)
      if (poly.tt._map && poly._lastOpacity !== nextOpacity) {
        poly.tt.setOpacity(nextOpacity);
        poly._lastOpacity = nextOpacity;
      }
      continue;
    }
    const isSel = poly.itemId === sel;
    const isHov = poly.itemId === hov;

    // Compute a compact state key: selected=2, hovered=1, dimmed-by-hover=0.5, normal=0, hidden=-1
    let stateKey;
    if(sel === null){
      stateKey = isHov ? 2 : (hov !== null ? 0.5 : 0);
    } else {
      stateKey = (isSel || isHov) ? 2 : -1;
    }
    if (poly._lastStateKey === stateKey) continue; // No change, skip style recomputation

    if(sel === null){
      if(isHov){
        poly.setStyle(poly.inner ? getRoadInnerStyle(poly.road, true) : getRoadStrokeStyle(poly.road, true));
        poly.bringToFront();
      } else {
        const style = poly.inner ? getRoadInnerStyle(poly.road, false) : getRoadStrokeStyle(poly.road, false);
        if(hov !== null) style.opacity *= 0.35;
        poly.setStyle(style);
        if(!hov && poly.inner) poly.bringToFront();
      }
    } else {
      if(isSel || isHov){
        poly.setStyle(poly.inner ? getRoadInnerStyle(poly.road, true) : getRoadStrokeStyle(poly.road, true));
        poly.bringToFront();
      } else {
        poly.setStyle({opacity:0,weight:0});
      }
    }
    poly._lastStateKey = stateKey;
  }
}

// ── ROUTE NAME GENERATOR ─────────────────────────────────────────────────────
// Deterministic: same route always gets same name. Uses score + len + goodRoads
// as a seed so similar but distinct routes get different names.
const ROUTE_PLACE_ADJ = ['Moorland','Valley','Highway','Upland','Ridge','Pass','Coast','Backroad','Hill','Forest'];
const ROUTE_MOTION = ['Run','Loop','Circuit','Sweep','Drive','Ride','Tour','Traverse','Byway'];
const ROUTE_TONE_TOP = ['Apex','Premier','Elite','Prime','Summit','Topline'];
const ROUTE_TONE_EXC = ['Brisk','Nimble','Quick','Sharp','Punchy','Tidy'];
const ROUTE_TONE_OTHER = ['Green','Quiet','Gentle','Easy','Clean','Fresh'];

function makeRouteName(route){
  const words = (route.roadNames || []).flatMap(n => String(n).split(/[^A-Za-z0-9]+/).filter(Boolean)).filter(w => w.length > 2);
  const unique = [...new Set(words.map(w => w.toLowerCase()))];
  const len = parseFloat(route.len);
  const s = route.score;
  const g = route.goodRoads;
  const placeAdj = ROUTE_PLACE_ADJ;
  const motion = ROUTE_MOTION;
  const tone = s >= 70 ? ROUTE_TONE_TOP : s >= 50 ? ROUTE_TONE_EXC : ROUTE_TONE_OTHER;
  let tag = unique.slice(0, 2).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  if(!tag){
    const seed = Math.abs(Math.round(s * 11 + len * 7 + g * 17)) % 97;
    tag = `${tone[seed % tone.length]} ${placeAdj[(seed + 3) % placeAdj.length]}`;
  }
  const seed = Math.abs(Math.round(s * 13 + len * 9 + g * 19 + unique.join('').length * 7)) % 97;
  const suffix = motion[(seed + 4) % motion.length];
  const prefix = tone[(seed + 1) % tone.length];
  return `The ${prefix} ${tag} ${suffix}`.replace(/\s+/g,' ').trim();
}

// ── SELECTION + TOGGLE ───────────────────────────────────────────────────────
let _hoverPending = null;
function clearHoverPreviewForMapMove() {
  if (_hoverPending !== null) {
    cancelAnimationFrame(_hoverPending);
    _hoverPending = null;
  }
  if (state.hoveredId === null) return;
  const prevId = state.hoveredId;
  state.hoveredId = null;
  const prev = state.cardMap?.get(String(prevId)) || els.results?.querySelector?.(`.road-card[data-item-id="${prevId}"]`);
  if (prev) prev.classList.remove('previewed');
  try { updatePolylineVisibility(); } catch(e) {}
}
function setHoveredItem(id, fromMap = false) {
  if (state.hoveredId === id) return;
  // Don't process hover during zoom/pan — the canvas is mid-animation and any
  // setStyle call would trigger a redraw competing with the zoom animation.
  if (state.isZooming || state.isPanning) return;

  // Coalesce rapid mouseout→mouseover transitions into a single update.
  // When moving between adjacent polylines Leaflet fires mouseout then mouseover
  // in the same task; if we process both, we do two full DOM passes.
  if (_hoverPending !== null) cancelAnimationFrame(_hoverPending);
  _hoverPending = requestAnimationFrame(() => {
    _hoverPending = null;
    if (state.hoveredId === id) return;
    if (state.isZooming || state.isPanning) return; // Bail again if movement started between rAF callbacks
    const prevId = state.hoveredId;
    state.hoveredId = id;
    
    if (state.routeMarkers) {
      state.routeMarkers.forEach(m => map.removeLayer(m));
      state.routeMarkers = [];
    }
    updatePolylineVisibility();

    if (fromMap) return;

    // Only toggle the cards that actually changed state
    if (state.cardMap.size) {
      if (prevId !== null) {
        const prev = state.cardMap.get(String(prevId));
        if (prev) prev.classList.remove('previewed');
      }
      if (id !== null) {
        const curr = state.cardMap.get(String(id));
        if (curr) curr.classList.add('previewed');
      }
    } else {
      if (prevId !== null) {
        const prev = els.results.querySelector(`.road-card[data-item-id="${prevId}"]`);
        if (prev) prev.classList.remove('previewed');
      }
      if (id !== null) {
        const curr = els.results.querySelector(`.road-card[data-item-id="${id}"]`);
        if (curr) curr.classList.add('previewed');
      }
    }
  });
}




function collapseTopPanelForMobile() {
  if (!isMobile()) return;
  setPanelState({ searchPanel: 'collapsed' }, 'collapse-search-mobile');
}

function openTopPanelForMobile() {
  if (!isMobile()) return;
  setPanelState({ searchPanel: 'open' }, 'open-search-mobile');
}

function selectItem(itemId, isRoute, fromMap=false, openMap=false){
  if (fromMap) {
    // Leaflet path clicks can bubble to the map. Keep the background-map dismiss
    // handler from immediately undoing the Results view opened by this item tap.
    state.suppressMapPaneDismissUntil = Date.now() + 250;
  }

  // The map is the default post-search view on phones. Any road/route tapped on
  // the map reveals Results. If the mapped item was already selected, the normal
  // toggle path below will clear that same selection from both map and result card.
  if (fromMap && usesMobileWorkspace()) {
    showMobileWorkspace('results', state.selectedId === itemId
      ? 'selected-map-item-deselected'
      : 'map-item-selected');
  }

  // Tapping an already-selected result card still means "show this on the map".
  // Map taps are intentionally allowed to fall through to the toggle branch so
  // deselection is reflected everywhere, not just on the polyline.
  if (state.selectedId === itemId && usesMobileWorkspace() && openMap && !fromMap) {
    showMobileWorkspace('map', 'selected-result-item-show-map');
    scheduleSelectedMapFocus(itemId);
    return;
  }

  // Toggle: clicking the already-selected item deselects it on desktop/legacy views.
  if(state.selectedId === itemId){
    state.selectedId = null;
    stopSelectionPulse();
    updatePolylineVisibility();
    if (state.cardMap.size) {
      state.cardMap.forEach(c => { c.classList.remove('selected'); c.classList.remove('dimmed'); });
    } else {
      els.results.querySelectorAll('.road-card').forEach(c=>{
        c.classList.remove('selected','dimmed');
      });
    }

    setStatus(`Showing all ${isRoute?'routes':'roads'}.`,'success');

    // Smoothly fly back to the view before selection, rather than snapping
    if (state.preSelectionView) {
      smoothSetView(state.preSelectionView.center, state.preSelectionView.zoom, { duration: 0.5 });
      state.preSelectionView = null;
    } else {
      const bounds = roadLayers.getBounds();
      if(bounds.isValid()){
        focusRoadBounds(bounds, { scope: 'results' });
      }
    }

    els.results.classList.remove('has-selected');

    // The legacy bottom sheet collapsed on deselect. In the phone workspace,
    // keep the current Results/Map view stable instead of unexpectedly changing panes.
    if (isMobile() && !usesMobileWorkspace()) {
      setPanelState({ resultsPanel: 'collapsed' }, 'item-deselected');
    }
    return;
  }

  // If selecting a new item while nothing was selected, snapshot the current view
  if (state.selectedId === null) {
    state.preSelectionView = { center: map.getCenter(), zoom: map.getZoom() };
  }

  state.selectedId = itemId;
  updatePolylineVisibility();
  // Start the subtle pulse animation on the selected polyline
  startSelectionPulse();

  // Card states — use cardMap for O(1) access instead of querySelectorAll
  const itemIdStr = String(itemId);
  let selCard = null;
  if (state.cardMap.size) {
    state.cardMap.forEach((c, key) => {
      const isSel = key === itemIdStr;
      c.classList.toggle('selected', isSel);
      c.classList.toggle('dimmed', !isSel);
      if (isSel) selCard = c;
    });
  } else {
    els.results.querySelectorAll('.road-card').forEach(c=>{
      const isSel = String(c.dataset.itemId)===itemIdStr;
      c.classList.toggle('selected', isSel);
      c.classList.toggle('dimmed', !isSel);
      if (isSel) selCard = c;
    });
  }

  if (!selCard && !isRoute) {
    const item = (state.masterRoads || []).find(r => String(r.id) === itemIdStr) || (state.excludedRoads || []).find(r => String(r.id) === itemIdStr);
    if (item) {
      selCard = createRoadCard(item);
      selCard.classList.add('selected');
      state.cardMap.set(itemIdStr, selCard);
      // Ensure all previously rendered cards are dimmed since we just added a new selected one
      state.cardMap.forEach((c, key) => {
        if (key !== itemIdStr) c.classList.add('dimmed');
      });
      const loadMoreBtnWrap = els.results.querySelector('.load-more-btn')?.parentElement;
      if (loadMoreBtnWrap) {
        els.results.insertBefore(selCard, loadMoreBtnWrap);
      } else {
        els.results.appendChild(selCard);
      }
    }
  }

  els.results.classList.add('has-selected');

  // A map tap should reveal the selected card; an explicit "Show on map"
  // action should do the opposite. Ordinary card selection stays in Results.
  if (usesMobileWorkspace()) {
    if (openMap) showMobileWorkspace('map', 'item-show-map');
    else if (fromMap) showMobileWorkspace('results', 'map-item-selected');
  } else if (fromMap) {
    // A mapped road/route is intentional content, not a background-map click:
    // reveal Results so the selected item and its details are available again.
    setPanelState({ resultsPanel: 'open' }, 'map-item-selected-desktop');
  } else if (isMobile()) {
    setPanelState({ resultsPanel: 'open' }, 'item-selected-keep-search');
  }

  if(selCard) selCard.scrollIntoView({behavior:'smooth',block:'nearest'});

  const arr = isRoute ? state.masterRoutes : [...state.masterRoads,...state.excludedRoads];
  const item = arr.find(r=>r.id===itemId);
  // Use polylineMap for O(1) lookup instead of scanning all polylines
  const polys = state.polylineMap.get(itemIdStr) || state.polylines.filter(p=>p.itemId===itemId);

  if(item&&polys.length){
    // Result card -> Map should tightly frame only that road/route. A Map ->
    // Results tap should not unexpectedly move the map underneath the opening
    // pane; it keeps the user's current geographic context intact.
    if (usesMobileWorkspace()) {
      if (openMap) scheduleSelectedMapFocus(itemId);
    } else {
      try {
        const b = L.featureGroup(polys).getBounds();
        if (b.isValid()) focusRoadBounds(b, { scope: 'selected' });
      } catch(e) {}
    }
  }

  
  // Add start/end markers
  if (state.routeMarkers) {
      state.routeMarkers.forEach(m => map.removeLayer(m));
  }
  state.routeMarkers = [];

  if (isRoute && selCard) {
      const arr = state.masterRoutes;
      const item = arr.find(r=>r.id===itemId);
      if (item && item.coords && item.coords.length > 0) {
          const startIcon = L.divIcon({
              className: 'custom-pin',
              html: `<svg width="24" height="24" viewBox="0 0 24 24" fill="#16a34a" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>`,
              iconSize: [24, 24], iconAnchor: [12, 12]
          });

          const endIcon = L.divIcon({
              className: 'custom-pin',
              html: `<svg width="24" height="24" viewBox="0 0 24 24" fill="#ef4444" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/><rect x="8" y="8" width="8" height="8" fill="#fff"/></svg>`,
              iconSize: [24, 24], iconAnchor: [12, 12]
          });

          const loopIcon = L.divIcon({
              className: 'custom-pin',
              html: `<svg width="24" height="24" viewBox="0 0 24 24" fill="#eab308" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8m-4-4v8" stroke="#fff" stroke-width="3"/></svg>`,
              iconSize: [24, 24], iconAnchor: [12, 12]
          });

          const startPt = item.coords[0];
          const endPt = item.coords[item.coords.length - 1];

          if (item.isCircular) {
              const marker = L.marker(startPt, {icon: loopIcon, zIndexOffset: 1000}).addTo(map);
              marker.bindTooltip("Start & Finish", {permanent: true, direction: "top", className: "map-name-tooltip"});
              state.routeMarkers.push(marker);
          } else {
              const sm = L.marker(startPt, {icon: startIcon, zIndexOffset: 1000}).addTo(map);
              sm.bindTooltip("Start", {permanent: true, direction: "top", className: "map-name-tooltip"});
              const em = L.marker(endPt, {icon: endIcon, zIndexOffset: 1000}).addTo(map);
              em.bindTooltip("Finish", {permanent: true, direction: "top", className: "map-name-tooltip"});
              state.routeMarkers.push(sm, em);
          }
      }
  }

  setStatus(isRoute?`Route selected — ${item?.len}km loop`:`${item?.name} — ${item?.len}km`,'success');
}

function switchRouteMode(mode) {
  state.routeMode = mode;
  document.getElementById('modeDistanceBtn').className = mode==='distance'?'seg-btn active':'seg-btn';
  document.getElementById('modeTimeBtn').className = mode==='time'?'seg-btn active':'seg-btn';
  document.getElementById('distSliderWrap').style.display = mode==='distance'?'block':'none';
  document.getElementById('timeSliderWrap').style.display = mode==='time'?'block':'none';
  saveAppState();
}
// Returns markup, not text: the unit is wrapped so it can be set smaller than
// the number. Built purely from numbers, so it is safe to insert as HTML — but
// it must never be passed through escapeHtml, or the tags become visible.
function formatRouteTime(m) {
  if(!m) return '0<span class="metric-unit">m</span>';
  const hrs = Math.floor(m/60);
  const mins = Math.round(m%60);
  return hrs > 0 ? `${hrs}<span class="metric-unit">h</span> ${mins}<span class="metric-unit">m</span>` : `${mins}<span class="metric-unit">m</span>`;
}
// Plain-text equivalent, for anywhere the value is escaped or read aloud.
function formatRouteTimeText(m) {
  if(!m) return '0m';
  const hrs = Math.floor(m/60);
  const mins = Math.round(m%60);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}
// ── MATH HELPERS ─────────────────────────────────────────────────────────────
const TO_RAD=Math.PI/180,TO_DEG=180/Math.PI;
function haverDist(a,b){
  const R=6371000,dLat=(b.lat-a.lat)*TO_RAD,dLon=(b.lon-a.lon)*TO_RAD;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*TO_RAD)*Math.cos(b.lat*TO_RAD)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
// Raw-coordinate versions avoid {lat,lon} object allocation in tight loops
function haverDistRaw(lat1, lon1, lat2, lon2){
  const R=6371000, dLat=(lat2-lat1)*TO_RAD, dLon=(lon2-lon1)*TO_RAD;
  const x=Math.sin(dLat/2)**2+Math.cos(lat1*TO_RAD)*Math.cos(lat2*TO_RAD)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
// Faster Equirectangular approximation for short distances (<10km)
function fastDist(a,b){
  const dLat = (b.lat - a.lat) * TO_RAD;
  const dLon = (b.lon - a.lon) * TO_RAD;
  const x = dLon * Math.cos((a.lat + b.lat) / 2 * TO_RAD);
  return 6371000 * Math.sqrt(x * x + dLat * dLat);
}
function fastDistRaw(lat1, lon1, lat2, lon2){
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  const x = dLon * Math.cos((lat1 + lat2) * 0.5 * TO_RAD);
  return 6371000 * Math.sqrt(x * x + dLat * dLat);
}
function bearing(a,b){
  const dLon=(b.lon-a.lon)*TO_RAD,lat1=a.lat*TO_RAD,lat2=b.lat*TO_RAD;
  return(Math.atan2(Math.sin(dLon)*Math.cos(lat2),Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon))*TO_DEG+360)%360;
}
function bearingRaw(lat1Raw, lon1Raw, lat2Raw, lon2Raw){
  const dLon=(lon2Raw-lon1Raw)*TO_RAD, la1=lat1Raw*TO_RAD, la2=lat2Raw*TO_RAD;
  return(Math.atan2(Math.sin(dLon)*Math.cos(la2),Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dLon))*TO_DEG+360)%360;
}

// ── SPEED DETECTION ──────────────────────────────────────────────────────────
function getExplicitSpeed(tags){
  const t = tags || {};
  const extractSpd = (val) => {
    if (!val) return null;
    const raw = String(val).toLowerCase();
    if(raw.includes('national')||raw==='gb:national') return (t.oneway==='yes'||t.dual_carriageway==='yes')?70:60;
    if(raw.includes('restricted')) return 30;
    const m = raw.match(/(\d+)/);
    if(m) { const n = parseInt(m[1], 10); return raw.includes('km/h') ? Math.round(n/1.609) : n; }
    return null;
  };
  const fromMax = extractSpd(t.maxspeed) || extractSpd(t['maxspeed:forward']) || extractSpd(t['maxspeed:backward']) || extractSpd(t['maxspeed:type']) || extractSpd(t['zone:maxspeed']);
  if (fromMax) return fromMax;
  if (t.highway==='motorway'||t.highway==='motorway_link') return 70;
  return null;
}

// ── OSM FETCH ────────────────────────────────────────────────────────────────
async function fetchWithRetry(lat,lon,distKm,signal,endLat=null,endLon=null){
  if(endLat===null&&endLon===null&&distKm>50){const tileRadius=35,side=Math.max(2,Math.ceil(distKm/tileRadius)),span=Math.max(0,distKm-tileRadius),offsets=[];for(let i=0;i<side;i++)offsets.push(side===1?0:-span+(2*span*i/(side-1)));const jobs=[],cosLat=Math.max(.2,Math.cos(lat*Math.PI/180));for(const nKm of offsets)for(const eKm of offsets)jobs.push([lat+nKm/111.32,lon+eKm/(111.32*cosLat)]);const merged=new Map();for(let i=0;i<jobs.length;i+=2){if(signal?.aborted){const er=new Error('Search cancelled.');er.name='AbortError';throw er}setLoading(true,`Loading map area ${Math.min(i+1,jobs.length)}–${Math.min(i+2,jobs.length)} of ${jobs.length}…`);const rows=await Promise.all(jobs.slice(i,i+2).map(([la,lo])=>fetchWithRetry(la,lo,tileRadius,signal)));for(const data of rows)for(const el of data.elements||[]){const key=`${el.type||'element'}:${el.id??(RF.stableHash?RF.stableHash(JSON.stringify(el)):Math.random())}`;if(!merged.has(key))merged.set(key,el)}}return{elements:[...merged.values()]}}
  let s, n, w, e;
  if (endLat !== null && endLon !== null) {
    const TO_RAD = Math.PI / 180;
    const dLatR = (endLat - lat) * TO_RAD, dLonR = (endLon - lon) * TO_RAD;
    const x = Math.sin(dLatR/2)**2 + Math.cos(lat*TO_RAD) * Math.cos(endLat*TO_RAD) * Math.sin(dLonR/2)**2;
    const distM = 2 * 6371000 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));

    if (distM > 120000) throw new Error('Distance is too great for a direct corridor search (>120km). Please pick closer points.');

    const bufferKm = Math.min(40, 18 + (distM/1000) * 0.15);
    const centerLat = (lat + endLat) / 2;
    const bufLat = bufferKm / 111.32;
    const bufLon = bufferKm / (111.32 * Math.cos(centerLat * TO_RAD));

    s = (Math.min(lat, endLat) - bufLat).toFixed(5);
    n = (Math.max(lat, endLat) + bufLat).toFixed(5);
    w = (Math.min(lon, endLon) - bufLon).toFixed(5);
    e = (Math.max(lon, endLon) + bufLon).toFixed(5);
  } else {
    const dLat = distKm / 111.32;
    const dLon = distKm / (111.32 * Math.cos(lat * Math.PI / 180));
    s = (lat - dLat).toFixed(5);
    n = (lat + dLat).toFixed(5);
    w = (lon - dLon).toFixed(5);
    e = (lon + dLon).toFixed(5);
  }
  const bbox = `${s},${w},${n},${e}`;
  const localConnectorClauses = (endLat !== null && endLon !== null) ? `
  way(around:6000,${lat.toFixed(6)},${lon.toFixed(6)})["highway"~"residential|living_street|service|road"];
  way(around:6000,${endLat.toFixed(6)},${endLon.toFixed(6)})["highway"~"residential|living_street|service|road"];` : `
  way(around:4500,${lat.toFixed(6)},${lon.toFixed(6)})["highway"~"residential|living_street|service|road"];`;
  const qRoads=`[out:json][timeout:60];
(
  way["highway"="motorway"](${bbox});
  way["highway"="motorway_link"](${bbox});
  way["highway"="trunk"](${bbox});
  way["highway"="trunk_link"](${bbox});
  way["highway"="primary"](${bbox});
  way["highway"="primary_link"](${bbox});
  way["highway"="secondary"](${bbox});
  way["highway"="secondary_link"](${bbox});
  way["highway"="tertiary"](${bbox});
  way["highway"="tertiary_link"](${bbox});
  way["highway"="unclassified"](${bbox});${localConnectorClauses}
  way["landuse"~"residential|commercial|retail|industrial"](${bbox});
);
out body geom qt;`;

  const qScenery=`[out:json][timeout:30];
(
  node["natural"="peak"](${bbox});
  node["natural"="water"](${bbox});
  node["natural"="beach"](${bbox});
  node["natural"="coastline"](${bbox});
  node["natural"="fell"](${bbox});
  node["tourism"="viewpoint"](${bbox});
  node["place"~"city|town|village|suburb"](${bbox});
  way["natural"~"water|wood|coastline|beach|fell|heath|scrub|grassland"](${bbox});
  way["waterway"~"river|stream|canal"](${bbox});
  way["leisure"="nature_reserve"](${bbox});
  way["landuse"~"forest|meadow|grass|recreation_ground"](${bbox});
  rel["boundary"="national_park"](${bbox});
);
out geom center tags qt;`;

  const qRestrictions=`[out:json][timeout:30];
relation["type"="restriction"](${bbox});
out body qt;`;

  const mirrors = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter'
  ];

  async function fetchQuery(query, offset, queryName='map data', maxRetries=1) {
    const useCache = els.useCacheToggle ? els.useCacheToggle.checked : true;
    const cacheKey = `overpass:${query}`;
    const cached = useCache ? await getCachedData(cacheKey) : null;
    if (cached) {
      debugLog(`[Cache Hit] ${queryName}`);
      return cached;
    }

    const ordered = mirrors.map((_, i) => mirrors[(i + offset) % mirrors.length]);
    // Two small parallel waves are both faster and more resilient than walking
    // four mirrors one-by-one. A degraded Overpass instance can no longer hold
    // the entire search UI for minutes before another mirror is tried.
    const waves = maxRetries > 0
      ? [ordered.slice(0, 2), ordered.slice(2, 4)]
      : [ordered.slice(0, 2)];

    const requestMirror = async (url) => {
      const controller = new AbortController();
      let timedOut = false;
      const forwardAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) forwardAbort();
      else signal?.addEventListener('abort', forwardAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 9000);
      try {
        const res = await fetch(url, { method: 'POST', body: query, signal: controller.signal });
        if (res.status === 429 || res.status >= 500) throw new Error('busy');
        if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) throw new Error('invalid');
        const data = await res.json();
        if (data.remark) throw new Error('overpass_remark');
        if (!data.elements || (queryName === 'roads data' && data.elements.length === 0)) throw new Error('empty_roads');
        return data;
      } catch (err) {
        if (signal?.aborted) throw new DOMException('Search cancelled.', 'AbortError');
        if (timedOut) throw new Error('timeout');
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
      }
    };

    for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
      if (signal?.aborted) throw new DOMException('Search cancelled.', 'AbortError');
      try {
        const data = await Promise.any(waves[waveIndex].map(requestMirror));
        await setCachedData(cacheKey, data);
        return data;
      } catch (err) {
        if (signal?.aborted) throw new DOMException('Search cancelled.', 'AbortError');
        if (waveIndex < waves.length - 1) {
          setLoading(true, `${queryName[0].toUpperCase()+queryName.slice(1)} service is slow — trying backup servers…`);
          await new Promise(resolve => setTimeout(resolve, 450));
        }
      }
    }
    throw new Error('Live road data is temporarily unavailable. Cached results still work; otherwise try again shortly.');
  }

  // Fetch roads and scenery in parallel, staggered across different mirrors
  const [roadsData, sceneryData, restrictionData] = await Promise.all([
    fetchQuery(qRoads, 0, 'roads data'),  // Roads hit Kumi first
    fetchQuery(qScenery, 1, 'scenery data'), // Scenery hits OSM France first
    // Restrictions improve route legality, but a temporary restriction-service failure
    // should not make road discovery itself unusable.
    fetchQuery(qRestrictions, 2, 'turn restrictions', 0).catch(() => ({elements:[]}))
  ]);

  // Combine elements for processing. Restriction relations are consumed by the
  // routing graph and ignored by the normal road/scenery scorers.
  return {
    elements: [...(roadsData.elements||[]), ...(sceneryData.elements||[]), ...(restrictionData.elements||[])]
  };
}

// ── ROUTE GENERATION ─────────────────────────────────────────────────────────
// Simple-cycle DFS: visitedNodes set per stack frame guarantees no node is
// entered twice, producing genuine loop variety in both length and road count.
// Excluded roads are used as connectors but don't count as "good roads".
async function generateA2BRoutes(startCoord, endCoord, masterRoads, allRoads) {
  // A-to-B deliberately routes over a broader graph than Road Score discovery.
  // Ordinary local roads may be used as connectors, but never become "good roads"
  // unless they independently pass the scoring rules.
  const stLat = Number(startCoord?.[0]), stLon = Number(startCoord?.[1]);
  const endLat = Number(endCoord?.[0]), endLon = Number(endCoord?.[1]);
  if (![stLat,stLon,endLat,endLon].every(Number.isFinite)) return [];

  const graph = buildRoadGraph(allRoads);
  if (graph.size < 2) return [];

  const straightKm = Math.max(0.05, fastDistRaw(stLat, stLon, endLat, endLon) / 1000);
  const nodeRows = [...graph.keys()].map(key => {
    const [lat, lon] = key.split(',').map(Number);
    return { key, lat, lon, degree: (graph.get(key) || []).length };
  });

  // Union-find gives us weakly-connected components. This stops A* wasting most
  // of its budget trying a start/end snap pair that can never be connected.
  const parent = new Map(nodeRows.map(n => [n.key, n.key]));
  const find = key => {
    let p = parent.get(key) || key;
    while (p !== (parent.get(p) || p)) p = parent.get(p);
    let cur = key;
    while (parent.get(cur) && parent.get(cur) !== p) {
      const next = parent.get(cur); parent.set(cur, p); cur = next;
    }
    return p;
  };
  const union = (a,b) => {
    const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra,rb);
  };
  for (const [from, edges] of graph.entries()) for (const edge of edges || []) union(from, edge.targetKey);

  // Nodes are per-geometry-vertex, so the handful of points nearest a dropped
  // pin are usually all on the same short way — very often a driveway, car-park
  // aisle or service stub that is not joined to the through network. Taking the
  // N nearest nodes therefore spends every snap slot on one dead end and the
  // start and end never share a component. Cap how many candidates any single
  // component or source road may contribute so the real road network is always
  // represented.
  const componentOf = key => find(key);
  const sourceRoadOf = key => {
    const edge = (graph.get(key) || [])[0];
    return edge ? String(edge.sourceRoadId || edge.sourceWayId || '') : '';
  };

  function snapCandidates(lat, lon, limit = 8) {
    const rows = nodeRows
      .filter(row => row.degree > 0)
      .map(row => ({
        ...row,
        distanceKm: fastDistRaw(lat, lon, row.lat, row.lon) / 1000,
        component: componentOf(row.key),
        sourceRoad: sourceRoadOf(row.key)
      }))
      .sort((a,b) => (a.distanceKm-b.distanceKm) || (b.degree-a.degree));
    if (!rows.length) return [];

    const sensibleRadius = Math.max(1.5, Math.min(6, straightKm * 0.08 + 1));
    return RF.diversifySnapCandidates
      ? RF.diversifySnapCandidates(rows, { limit, radiusKm: sensibleRadius })
      : rows.slice(0, limit);
  }

  // Last resort: snap both ends into the largest component, however far away it
  // is. A long snap leg beats telling the user there is no route at all.
  function largestComponentFallback() {
    const sizes = new Map();
    for (const row of nodeRows) {
      const c = componentOf(row.key);
      sizes.set(c, (sizes.get(c) || 0) + 1);
    }
    let biggest = null, biggestSize = 0;
    for (const [component, size] of sizes) if (size > biggestSize) { biggestSize = size; biggest = component; }
    if (!biggest) return null;
    const nearestIn = (lat, lon) => {
      let best = null, bestDist = Infinity;
      for (const row of nodeRows) {
        if (row.degree <= 0 || componentOf(row.key) !== biggest) continue;
        const d = fastDistRaw(lat, lon, row.lat, row.lon) / 1000;
        if (d < bestDist) { bestDist = d; best = { ...row, distanceKm: d, component: biggest }; }
      }
      return best;
    };
    const a = nearestIn(stLat, stLon), b = nearestIn(endLat, endLon);
    return a && b && a.key !== b.key ? { start:a, end:b, snapKm:a.distanceKm+b.distanceKm } : null;
  }

  const starts = snapCandidates(stLat, stLon, 8);
  const ends = snapCandidates(endLat, endLon, 8);
  const pairs = [];
  for (const a of starts) for (const b of ends) {
    if (a.key === b.key || a.component !== b.component) continue;
    pairs.push({ start:a, end:b, snapKm:a.distanceKm+b.distanceKm });
  }
  pairs.sort((a,b)=>a.snapKm-b.snapKm);
  if (!pairs.length) {
    const fallback = largestComponentFallback();
    if (fallback) pairs.push(fallback);
  }
  if (!pairs.length) {
    state.lastA2BFailure = 'The downloaded road network has no route between these points.';
    return [];
  }
  state.lastA2BFailure = null;

  function coordForKey(key) {
    const [lat, lon] = key.split(',').map(Number); return [lat, lon];
  }
  function heuristic(nodeKey, targetKey) {
    const a=coordForKey(nodeKey), b=coordForKey(targetKey);
    return fastDistRaw(a[0],a[1],b[0],b[1]) / 1000;
  }

  // Small binary heap: diversified A-to-B runs several A* searches, so repeatedly
  // sorting the entire open set becomes a major bottleneck on denser local graphs.
  function heapPush(heap, row) {
    heap.push(row); let i=heap.length-1;
    while(i>0){const p=(i-1)>>1;if(heap[p].f<=row.f)break;heap[i]=heap[p];i=p}heap[i]=row;
  }
  function heapPop(heap) {
    if(!heap.length)return null;const root=heap[0],last=heap.pop();if(heap.length&&last){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=heap.length)break;let c=r<heap.length&&heap[r].f<heap[l].f?r:l;if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c}heap[i]=last}return root;
  }
  const edgeUseKey = edge => String(edge.segmentId || edge.roadId || `${edge.sourceWayId||''}:${edge.fromNodeId||''}>${edge.toNodeId||''}`);

  function astar(startK, endK, opts = {}) {
    const scoreWeight = Math.max(0, Math.min(1, Number(opts.scoreWeight || 0)));
    const connectorPenalty = Math.max(0, Number(opts.connectorPenalty || 0));
    const diversityWeight = Math.max(0, Number(opts.diversityWeight || 0));
    const usage = opts.usage instanceof Map ? opts.usage : new Map();
    const maxPhysicalKm = Math.max(straightKm + 3, straightKm * Math.max(1.12, Number(opts.maxDetour || 1.55)) + 2);
    const maxStates = Math.min(50000, Math.max(12000, graph.size * 4));
    const deadline = Date.now() + Math.max(250, Number(opts.budgetMs) || 1200);
    const open=[];
    heapPush(open,{f:heuristic(startK,endK),g:0,key:startK,path:[],physical:0});
    const initialKey=RF.routingStateKey?RF.routingStateKey(startK,[],state.turnRestrictions):startK;
    const best=new Map([[initialKey,0]]);
    let states=0;

    while(open.length && states++ < maxStates){
      if((states & 511) === 0 && Date.now() > deadline) break;
      const current=heapPop(open); if(!current)break;
      if(current.key===endK && current.path.length) return current.path;
      for(const edge of graph.get(current.key)||[]){
        if(!turnIsAllowed(current.path,edge))continue;
        const len=Math.max(.001,Number(edge.len||0));
        const physical=current.physical+len;
        if(physical>maxPhysicalKm)continue;
        const qualityBonus=scoreWeight*Math.max(0,Math.min(100,Number(edge.score||0)))/100*.42;
        const connectorCost=edge.isGood?0:connectorPenalty;
        const used=Number(usage.get(edgeUseKey(edge))||0);
        const diversityCost=diversityWeight*used*.62;
        const edgeCost=Math.max(.0005,len*(1+connectorCost+diversityCost-qualityBonus));
        const g=current.g+edgeCost;
        const nextPath=[...current.path,edge];
        const routingKey=RF.routingStateKey?RF.routingStateKey(edge.targetKey,nextPath,state.turnRestrictions):edge.targetKey;
        if(best.has(routingKey)&&g>=best.get(routingKey)-1e-9)continue;
        best.set(routingKey,g);
        heapPush(open,{key:edge.targetKey,g,f:g+heuristic(edge.targetKey,endK),path:nextPath,physical});
      }
    }
    return null;
  }

  // A snapped leg is drawn as a straight line from the requested point to the
  // road network — the driver cannot use it. It must therefore cost far more
  // than real road distance, or a short fragment miles from both endpoints
  // outbids the genuine route that runs between them.
  const SNAP_COST_PER_KM = 1.6;
  const maxSensibleSnapKm = Math.max(2.5, straightKm * 0.35);

  function findPath(profile, usage, options = {}) {
    // Try several nearby snap pairs. The nearest OSM node is often a cul-de-sac,
    // private estate entrance or one-way fragment; a slightly farther snap can be
    // the correct connected road network.
    const attempt = candidates => {
      let bestPath=null,bestPair=null,bestCost=Infinity;
      const maxPairAttempts=Math.min(12,candidates.length);
      for(let i=0;i<maxPairAttempts;i++){
        const pair=candidates[i];
        const path=astar(pair.start.key,pair.end.key,{...profile,usage});
        if(!path?.length)continue;
        const distance=path.reduce((s,e)=>s+(e.len||0),0);
        const candidateCost=distance+pair.snapKm*SNAP_COST_PER_KM;
        if(candidateCost<bestCost){bestCost=candidateCost;bestPath=path;bestPair=pair}
        // Very close snaps with a legal path are good enough; don't run 11 more A*s.
        if(pair.snapKm<.35)break;
      }
      return bestPath?{path:bestPath,pair:bestPair}:null;
    };

    // Only consider pairs that actually sit near the requested points. Distant
    // snaps are a last resort handled by the recovery pass below: reaching for
    // them here lets a short fragment miles away satisfy a profile whose real
    // answer was simply a longer route.
    const plausible=pairs.filter(pair=>pair.snapKm<=maxSensibleSnapKm);
    if(plausible.length){
      const found=attempt(plausible);
      if(found)return found;
    }
    return (options.allowDistantSnaps || !plausible.length) ? attempt(pairs) : null;
  }

  const profiles = [
    { label:'Direct route',       scoreWeight:0.00, connectorPenalty:0.00, maxDetour:1.22, alternatives:1, diversityBase:0.00 },
    { label:'Fast & flowing',     scoreWeight:0.35, connectorPenalty:0.03, maxDetour:1.38, alternatives:2, diversityBase:0.42 },
    { label:'Balanced drive',     scoreWeight:0.62, connectorPenalty:0.05, maxDetour:1.58, alternatives:3, diversityBase:0.58 },
    { label:'Best roads',         scoreWeight:0.90, connectorPenalty:0.07, maxDetour:1.82, alternatives:3, diversityBase:0.72 },
  ];

  const usage=new Map(), acceptedPaths=[], results=[];
  const seenSigs=new Set();
  const maxResults=9;

  function buildRoute(edgePath, profile, variant, snapPair) {
    let pathCoords=[];
    for(const edge of edgePath){
      const coords=edge.coords||[];if(!coords.length)continue;
      if(pathCoords.length){const prev=pathCoords[pathCoords.length-1],first=coords[0],same=Math.abs(prev[0]-first[0])<1e-7&&Math.abs(prev[1]-first[1])<1e-7;pathCoords.push(...(same?coords.slice(1):coords))}
      else pathCoords.push(...coords);
    }
    if(pathCoords.length<2)return null;
    const distanceKm=edgePath.reduce((sum,e)=>sum+(e.len||0),0);

    // The legs between the requested points and the snapped road network are
    // drawn as straight lines the driver cannot take. If those legs rival the
    // route itself, this is not a route between A and B — it is a fragment
    // somewhere else. Reject it so the caller can say so honestly.
    const snapKm=Number(snapPair?.snapKm||0);
    const snapAllowance=Math.min(
      Math.max(2, distanceKm*0.4),                 // never a large share of the drive
      Math.max(1, Math.min(3, straightKm*0.25))    // nor a large share of the hop
    );
    if(snapKm>snapAllowance)return null;

    pathCoords=[startCoord,...pathCoords,endCoord];
    const goodEdges=edgePath.filter(e=>e.isGood),goodDistance=goodEdges.reduce((s,e)=>s+(e.len||0),0);
    const goodRoadsCount=new Set(goodEdges.map(e=>e.sourceRoadId||e.sourceWayId||e.roadId).filter(Boolean)).size;
    const avgScore=goodDistance>0?Math.round(goodEdges.reduce((s,e)=>s+(e.score||0)*(e.len||0),0)/goodDistance):0;
    const detailMap=new Map();
    for(const e of edgePath){const k=e.sourceRoadId||e.sourceWayId||e.roadId;if(!k)continue;if(!detailMap.has(k))detailMap.set(k,{name:e.roadRef?.name||'Unnamed Road',score:e.roadRef?.score||0,tier:e.roadRef?.tier||'excluded',confidence:e.roadRef?.confidence||55,len:0,isGood:!!e.isGood});const row=detailMap.get(k);row.len+=(e.len||0);row.isGood=row.isGood||!!e.isGood}
    const roadDetails=[...detailMap.values()].map(r=>({...r,len:Number(r.len.toFixed(2))}));
    const ratio=distanceKm>0?goodDistance/distanceKm:0;
    const evidence=RF.routeConfidence?RF.routeConfidence({roadDetails,driverRoadRatio:ratio}):{score:55};
    const tier=avgScore>=70?'tier1':avgScore>=50?'tier2':avgScore>=30?'tier3':'tier4';
    const namedGood=[...new Set(goodEdges.map(e=>e.roadRef?.name).filter(n=>n&&!String(n).startsWith('Unnamed')))];
    const viaName=namedGood[0];
    const suffix=variant>0?` alternative ${variant+1}`:'';
    const routeName=viaName?`${profile.label}${suffix} via ${viaName}`:`${profile.label}${suffix}`;
    const orderedRoadIds=[];
    for(const e of edgePath){const k=e.sourceRoadId||e.segmentId||e.roadId;if(k&&orderedRoadIds[orderedRoadIds.length-1]!==k)orderedRoadIds.push(k)}
    return {
      id:`A2B-${profile.label}-${variant}`,
      routeType:'a2b',isCircular:false,name:routeName,coords:pathCoords,startCoord,
      len:distanceKm.toFixed(1),timeMins:estimatePathTimeMins(edgePath),score:avgScore,tier,
      goodRoads:goodRoadsCount,driverRoadRatio:ratio,routeConfidence:evidence.score,
      roadNames:[...new Set(roadDetails.filter(r=>r.isGood).map(r=>r.name))],roadIds:orderedRoadIds,roadDetails,
      snapDistanceKm:Number((snapPair?.snapKm||0).toFixed(2)),routeProfile:profile.label,
      segmentDetails:[{coords:pathCoords,isGood:false,name:'A-to-B route'},...goodEdges.map(e=>({coords:e.coords,isGood:true,name:e.roadRef?.name||'Unnamed Road',score:e.score,confidence:e.roadRef?.confidence||55}))]
    };
  }

  for(const profile of profiles){
    for(let variant=0;variant<profile.alternatives && results.length<maxResults;variant++){
      const diversityWeight=variant===0?Math.max(0,profile.diversityBase*.35):profile.diversityBase*(1+variant*.45);
      const found=findPath({...profile,diversityWeight},usage);
      if(!found)continue;
      const path=found.path;
      const sig=path.map(edgeUseKey).join('>');
      if(seenSigs.has(sig))continue;
      const tooSimilar=acceptedPaths.some(existing => (RF.pathOverlapRatio?RF.pathOverlapRatio(existing,path):0) > .94);
      if(tooSimilar){
        // Record this path as heavily used so the next variant is pushed harder
        // away from it, even though we do not show a near-duplicate card.
        for(const edge of path){const k=edgeUseKey(edge);usage.set(k,(usage.get(k)||0)+1.4)}
        continue;
      }
      const route=buildRoute(path,profile,variant,found.pair);if(!route)continue;
      seenSigs.add(sig);acceptedPaths.push(path);results.push(route);
      for(const edge of path){const k=edgeUseKey(edge);usage.set(k,(usage.get(k)||0)+1)}
    }
  }

  // If profiles collapsed onto the same road sequence, actively seek a few more
  // alternatives with stronger reuse penalties. This is what turns "one route"
  // into a useful choice when the local graph actually contains alternatives.
  let rescue=0;
  while(results.length<Math.min(6,maxResults) && rescue<5){
    const profile={label:'Alternative route',scoreWeight:.48,connectorPenalty:.035,maxDetour:1.72,diversityWeight:1.05+rescue*.35};
    const found=findPath(profile,usage);rescue++;
    if(!found)continue;
    const path=found.path,sig=path.map(edgeUseKey).join('>');
    if(seenSigs.has(sig)) { for(const edge of path){const k=edgeUseKey(edge);usage.set(k,(usage.get(k)||0)+1.5)}; continue; }
    const overlap=acceptedPaths.reduce((m,p)=>Math.max(m,RF.pathOverlapRatio?RF.pathOverlapRatio(p,path):0),0);
    if(overlap>.96){for(const edge of path){const k=edgeUseKey(edge);usage.set(k,(usage.get(k)||0)+1.5)};continue}
    const route=buildRoute(path,profile,rescue-1,found.pair);if(!route)continue;
    seenSigs.add(sig);acceptedPaths.push(path);results.push(route);
    for(const edge of path){const k=edgeUseKey(edge);usage.set(k,(usage.get(k)||0)+1)}
  }

  // Recovery pass. The quality profiles cap the corridor at 1.82x the straight
  // line, but real road distance regularly beats that — a river crossing, an
  // estuary, a mountain pass or a single valley road round the long way. Widen
  // the corridor in steps rather than telling the user there is no route.
  if(!results.length){
    // Widen the corridor first, keeping the snap near the requested points. Only
    // if that still fails do we accept a distant snap, because a distant snap is
    // drawn as a straight line the driver cannot actually take.
    const recovery=[
      {maxDetour:2.6,allowDistantSnaps:false},
      {maxDetour:4.2,allowDistantSnaps:false},
      {maxDetour:7.0,allowDistantSnaps:false},
      {maxDetour:7.0,allowDistantSnaps:true},
    ];
    for(const step of recovery){
      const profile={label:'Direct route',scoreWeight:0,connectorPenalty:0,maxDetour:step.maxDetour,alternatives:1,diversityBase:0};
      const found=findPath(profile,usage,{allowDistantSnaps:step.allowDistantSnaps});
      if(!found)continue;
      const route=buildRoute(found.path,profile,0,found.pair);
      if(!route)continue;
      results.push(route);
      break;
    }
  }

  for(const route of results){if(RF.stableRouteId)route.id=RF.stableRouteId(route);delete route.roadIds}
  // Keep direct first, then provide genuinely different choices by quality.
  if (!results.length) {
    // Snapping worked but no legal path survived the detour caps or the search
    // budget, which is a different problem from a disconnected network.
    state.lastA2BFailure = 'Found the road network but no drivable route between these points. Try moving the start or destination slightly.';
  }
  return results.slice(0,maxResults);
}

function getNodeKey(coord) {
    if (!coord || coord.length < 2) return '';
    return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`; // ~0.1m: only join genuinely shared OSM geometry
}

function buildRoadGraph(allRoads) {
    const graph = new Map();
    const addEdge=(fromKey,toKey,coords,road,segmentId,isReverse=false,sourceWayId=null,fromNodeId=null,toNodeId=null)=>{
      if(!fromKey||!toKey||fromKey===toKey)return;
      const a=coords[0],b=coords[1],len=fastDistRaw(a[0],a[1],b[0],b[1])/1000;
      if(!Number.isFinite(len)||len<0.003||len>15)return;
      if(!graph.has(fromKey))graph.set(fromKey,[]);
      graph.get(fromKey).push({targetKey:toKey,roadId:`${segmentId}${isReverse?':r':':f'}`,segmentId,sourceRoadId:road.id,sourceWayId,fromNodeId,toNodeId,len,isGood:road.tier!=='excluded',score:road.score||0,coords:isReverse?[coords[1],coords[0]]:coords,roadRef:road});
    };
    for(const road of allRoads){
      if(!road)continue;
      const ways=Array.isArray(road.graphWays)&&road.graphWays.length?road.graphWays:[{wayId:road.sourceWayIds?.[0]||road.id,coords:road.coords,nodeIds:[],tags:road.tags||{}}];
      for(const way of ways){
        const coords=way?.coords||[],nodeIds=Array.isArray(way?.nodeIds)?way.nodeIds:[];
        if(coords.length<2)continue;
        const tags=way.tags||{},access=RF.accessStatus?RF.accessStatus(tags):{allowed:true};
        if(!access.allowed)continue;
        const oneWay=RF.normaliseOneway?RF.normaliseOneway(tags):0;
        for(let i=1;i<coords.length;i++){
          const prev=coords[i-1],curr=coords[i];
          if(!prev||!curr)continue;
          const fk=getNodeKey(prev),tk=getNodeKey(curr),sid=`${way.wayId||road.id}:${i}`;
          const prevNode=nodeIds[i-1]??null,currNode=nodeIds[i]??null;
          if(oneWay>=0)addEdge(fk,tk,[prev,curr],road,sid,false,way.wayId,prevNode,currNode);
          if(oneWay<=0)addEdge(tk,fk,[prev,curr],road,sid,true,way.wayId,currNode,prevNode);
        }
      }
    }
    for(const edges of graph.values())edges.sort((a,b)=>((b.isGood?1:0)-(a.isGood?1:0))||((b.score||0)-(a.score||0))||((a.len||0)-(b.len||0)));
    return graph;
}

function turnIsAllowed(path, edge) {
    if (RF.pathTransitionAllowed) return RF.pathTransitionAllowed(path, edge, state.turnRestrictions);
    const previous = Array.isArray(path) && path.length ? path[path.length - 1] : null;
    return !previous || !RF.turnAllowed || RF.turnAllowed(previous, edge, state.turnRestrictions);
}

function estimatePathTimeMins(path=[]) {
    let hours=0;
    for(const edge of path){
      const len=Math.max(0,Number(edge?.len||0));
      if(!len)continue;
      const road=edge.roadRef||{};
      const limit=Math.max(20,Number(road.speedMph||35));
      const twist=Math.max(0,Math.min(100,Number(road.twistScore||road.twists||0)));
      const urban=Math.max(0,Math.min(1,Number(road.debug?.urbanExposure||0)));
      const factor=Math.max(.48,Math.min(.80,.79-(twist/100)*.17-urban*.12));
      const expectedKph=Math.max(24,Math.min(95,limit*1.609344*factor));
      hours+=len/expectedKph;
    }
    return Math.max(1,Math.round(hours*60));
}

async function generateRoutes(allRoads, opts={}) {
    const mode = state.routeMode;
    const MINVAL = mode === 'distance' ? Math.max(1, opts.minD || 1) : Math.max(5, opts.minT || 5);
    const MAXVAL = mode === 'distance' ? Math.max(MINVAL, opts.maxD || 50) : Math.max(MINVAL, opts.maxT || 120);
    const minD = mode === 'distance' ? MINVAL : MINVAL * 0.83;
    const maxD = mode === 'distance' ? MAXVAL : MAXVAL * 0.83;

    const usableRoads = allRoads.filter(r => r.coords && r.coords.length >= 2 && parseFloat(r.len) > 0.2);
    const goodRoads = usableRoads
        .filter(r => r.tier !== 'excluded' && r.score >= 30 && parseFloat(r.len) >= 0.5)
        .sort((a, b) => (b.score || 0) - (a.score || 0));

    if (!goodRoads.length) return [];

    const fullGraph = buildRoadGraph(usableRoads);
    const routeOrigin = Array.isArray(state.searchCoord) ? state.searchCoord : (() => {
        const allCoords = usableRoads.flatMap(road => road.coords || []);
        if (!allCoords.length) return null;
        const bounds = allCoords.reduce((acc, coord) => ({
            minLat: Math.min(acc.minLat, coord[0]), maxLat: Math.max(acc.maxLat, coord[0]),
            minLon: Math.min(acc.minLon, coord[1]), maxLon: Math.max(acc.maxLon, coord[1])
        }), { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity });
        return [(bounds.minLat + bounds.maxLat) / 2, (bounds.minLon + bounds.maxLon) / 2];
    })();
    const circularGraph = RF.buildCircularRoutingGraph
        ? RF.buildCircularRoutingGraph(fullGraph, routeOrigin, maxD)
        : { graph: fullGraph, nodeKeys: [...fullGraph.keys()] };
    const graph = circularGraph.graph;
    const graphNodes = circularGraph.nodeKeys;
    if (graphNodes.length < 3) return [];

    // Round-trip generation must never monopolise the UI indefinitely.  The
    // builder returns the best routes completed inside this budget and lets the
    // user refine/re-run rather than exhaustively enumerating the graph.
    const routeBuildDeadline = Date.now() + 4500;

    function nodeKeyToCoord(key) {
        const [lat, lon] = key.split(',').map(Number);
        return [lat, lon];
    }

    function pathDistance(path) {
        return path.reduce((sum, edge) => sum + (edge.len || 0), 0);
    }

    function pathGoodDistance(path) {
        return path.reduce((sum, edge) => sum + (edge.isGood ? (edge.len || 0) : 0), 0);
    }

    function pathScoreAverage(path) {
        let weighted=0, distance=0;
        for(const edge of path){if(!edge.isGood)continue;const len=edge.len||0;weighted+=(edge.score||0)*len;distance+=len}
        return distance>0?weighted/distance:0;
    }

    function edgeUseKey(edge) {
        return edge.segmentId || edge.roadId || edge.sourceRoadId;
    }

    function edgeSourceKey(edge) {
        return edge.sourceRoadId || edge.roadId;
    }

    function dedupeJoinedCoords(parts) {
        const out = [];
        for (const coords of parts) {
            if (!coords || !coords.length) continue;
            if (!out.length) {
                out.push(...coords);
                continue;
            }
            const prev = out[out.length - 1];
            const first = coords[0];
            const same = Math.abs(prev[0] - first[0]) < 0.000001 && Math.abs(prev[1] - first[1]) < 0.000001;
            out.push(...(same ? coords.slice(1) : coords));
        }
        return out;
    }

    function buildCoordsFromPath(path) {
        return dedupeJoinedCoords(path.map(edge => edge.coords || []));
    }

    function routeRoadIdSet(path) {
        return new Set(path.map(edgeSourceKey));
    }

    function calcBounds(coords) {
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const c of coords) {
            if (c[0] < minLat) minLat = c[0];
            if (c[0] > maxLat) maxLat = c[0];
            if (c[1] < minLon) minLon = c[1];
            if (c[1] > maxLon) maxLon = c[1];
        }
        return { minLat, maxLat, minLon, maxLon };
    }

    function scoreRouteShape(coords, totalDist) {
        if (!coords || coords.length < 4 || totalDist <= 0) return 0;
        const b = calcBounds(coords);
        const width = fastDistRaw(b.minLat, b.minLon, b.minLat, b.maxLon) / 1000;
        const height = fastDistRaw(b.minLat, b.minLon, b.maxLat, b.minLon) / 1000;
        const spread = width + height;
        const spreadScore = Math.max(0, Math.min(100, (spread / Math.max(2, totalDist * 0.55)) * 100));

        const first = coords[0];
        const last = coords[coords.length - 1];
        const closeGap = fastDistRaw(first[0], first[1], last[0], last[1]);
        const closurePenalty = Math.min(25, closeGap / 25);

        let headingChanges = 0;
        for (let i = 1; i < coords.length - 1; i += Math.max(1, Math.floor(coords.length / 20))) {
            const a = bearingRaw(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
            const b2 = bearingRaw(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
            const turn = Math.abs(((a - b2 + 540) % 360) - 180);
            if (turn > 20) headingChanges++;
        }
        const shapeScore = Math.min(100, 40 + headingChanges * 8 + spreadScore * 0.35 - closurePenalty);
        return Math.max(0, Math.min(100, shapeScore));
    }

    function calculateSelfOverlapPenalty(path) {
        // With the segment-level graph, multiple consecutive segments can belong
        // to the same named road. That is normal and should not count as self-overlap.
        // Only penalise reusing the exact same graph segment.
        const seen = new Set();
        let overlap = 0;
        for (const edge of path) {
            const k = edgeUseKey(edge);
            if (seen.has(k)) overlap += edge.len || 0;
            seen.add(k);
        }
        return overlap;
    }

    function overlapRatio(candidateIds, chosenIds) {
        let shared = 0;
        for (const id of candidateIds) if (chosenIds.has(id)) shared++;
        return shared / Math.max(1, candidateIds.size);
    }

    function classifyTier(score) {
        return score >= 70 ? 'tier1' : score >= 50 ? 'tier2' : score >= 30 ? 'tier3' : 'tier4';
    }

    function formatRouteFromPath(path, anchor, outwardNodeKey) {
        const coords = buildCoordsFromPath(path);
        if (!coords.length) return null;

        // Force loop routes to explicitly end where they started.
        // The graph may consider the route closed at a snapped junction, but the
        // rendered polyline should also visibly return to the same point.
        const first = coords[0];
        const last = coords[coords.length - 1];
        const closeGapM = fastDistRaw(first[0], first[1], last[0], last[1]);
        // Never draw an artificial straight line to make a broken route look
        // circular. A valid loop must close through actual graph edges.
        if (closeGapM > 35) return null;
        const closedCoords = [...coords];
        closedCoords[closedCoords.length - 1] = [...first];

        const totalDist = pathDistance(path);
        const goodDist = pathGoodDistance(path);
        const goodRoads = path.filter(edge => edge.isGood);
        const avgScore = goodRoads.length ? Math.round(pathScoreAverage(path)) : 0;
        const driverRoadRatio = totalDist > 0 ? goodDist / totalDist : 0;
        const detailMap = new Map();
        for (const edge of path) {
            const k = edgeSourceKey(edge);
            if (!detailMap.has(k)) {
                detailMap.set(k, {
                    name: edge.roadRef?.name || 'Unnamed Road',
                    score: edge.roadRef?.score || 0,
                    tier: edge.roadRef?.tier || 'excluded',
                    confidence: edge.roadRef?.confidence || 55,
                    len: 0,
                    isGood: !!edge.isGood
                });
            }
            const row = detailMap.get(k);
            row.len += edge.len || 0;
            row.isGood = row.isGood || !!edge.isGood;
        }
        const roadDetails = [...detailMap.values()].map(row => ({ ...row, len: Number(row.len.toFixed(2)) }));

        const roadNames = [...new Set(goodRoads.map(edge => edge.roadRef?.name).filter(Boolean))];
        const shapeScore = scoreRouteShape(closedCoords, totalDist);
        const selfOverlapPenalty = calculateSelfOverlapPenalty(path);
        const uniqueRoadCount = new Set(path.map(edgeSourceKey)).size;
        const connectorPenalty = Math.max(0, totalDist - goodDist);
        const scenicBias = goodRoads.length
            ? goodRoads.reduce((sum, edge) => sum + (edge.roadRef?.scenery || 0), 0) / goodRoads.length
            : 0;

        const outwardCoord = outwardNodeKey ? nodeKeyToCoord(outwardNodeKey) : null;
        const anchorMid = anchor?.coords?.[Math.floor((anchor.coords?.length || 1) / 2)] || coords[Math.floor(coords.length / 2)];
        const routeSpreadKm = outwardCoord && anchorMid
            ? fastDistRaw(anchorMid[0], anchorMid[1], outwardCoord[0], outwardCoord[1]) / 1000
            : 0;

        const routeEvidence=RF.routeConfidence?RF.routeConfidence({roadDetails,driverRoadRatio}):{score:55};
        const rankScore =
            (avgScore * 0.33) +
            (driverRoadRatio * 100 * 0.27) +
            (Math.min(100, uniqueRoadCount * 11) * 0.12) +
            (Math.min(100, routeSpreadKm * 12) * 0.10) +
            (shapeScore * 0.10) +
            (Math.min(100, scenicBias) * 0.08) +
            ((routeEvidence.score-55) * 0.05) -
            Math.min(20, connectorPenalty * 1.8) -
            Math.min(20, selfOverlapPenalty * 4);

        return {
            id: `CIRC-${Math.random().toString(36).slice(2,10)}-${Date.now()}`,
            isCircular: true,
            name: `Loop via ${anchor.name || 'Unnamed Road'}`,
            coords: closedCoords,
            startCoord: closedCoords[0],
            len: totalDist.toFixed(1),
            timeMins: estimatePathTimeMins(path),
            score: avgScore,
            tier: classifyTier(avgScore),
            goodRoads: new Set(goodRoads.map(edgeSourceKey)).size,
            driverRoadRatio,
            routeConfidence: routeEvidence.score,
            maxSpd: goodDist>0 ? Math.round(goodRoads.reduce((s,e)=>s+(e.roadRef?.speedMph||0)*(e.len||0),0)/goodDist) : 0,
            roadDetails,
            roadNames,
            rankScore,
            routeSpreadKm,
            uniqueRoadCount,
            segmentDetails: [
                { coords: closedCoords, isGood: false, name: 'Route path' },
                ...goodRoads.map(edge => ({
                    coords: edge.coords,
                    isGood: true,
                    name: edge.roadRef?.name || 'Unnamed Road',
                    score: edge.score,
                    confidence: edge.roadRef?.confidence || 55
                }))
            ],
            roadIds: routeRoadIdSet(path)
        };
    }

    function findLoopBackPath(startKey, targetKey, preferredRoadIds, bannedRoadIds, constraints = {}) {
        const maxDist = constraints.maxDist ?? maxD;
        const minDist = constraints.minDist ?? minD;
        const maxStates = constraints.maxStates ?? 1800;
        const anchorSourceRoadId = constraints.anchorSourceRoadId || constraints.anchorRoadId;
        // Exempt the anchor road from the initial banned set so it can close the loop
        // when it's the only viable closing edge. We restrict its reuse to the closing
        // hop only via the per-edge check below.
        const initialBanned = new Set(bannedRoadIds || []);
        // bannedRoadIds contains segment ids. Do not delete by source road id here.
        const open = [{
            key: startKey,
            dist: 0,
            goodDist: 0,
            preferredHits: 0,
            path: [],
            usedRoadIds: initialBanned,
            visitedKeys: new Set([startKey])
        }];
        const results = [];
        let states = 0;

        while (open.length && states < maxStates && results.length < 8) {
            open.sort((a, b) => {
                const aScore = (a.preferredHits * 3) + (a.goodDist * 1.4) - (a.dist * 0.35);
                const bScore = (b.preferredHits * 3) + (b.goodDist * 1.4) - (b.dist * 0.35);
                return bScore - aScore;
            });
            const current = open.shift();
            states++;
            const remainingDirect = (() => {
                const a = nodeKeyToCoord(current.key);
                const b = nodeKeyToCoord(targetKey);
                return fastDistRaw(a[0], a[1], b[0], b[1]) / 1000;
            })();
            if (current.dist + remainingDirect > maxDist * 1.08) continue;

            if (current.key === targetKey && current.path.length) {
                if (current.dist >= Math.max(0.5, minDist * 0.35)) {
                    results.push(current);
                }
                continue;
            }

            const neighbors = graph.get(current.key) || [];
            for (const edge of neighbors) {
                if(!turnIsAllowed(current.path, edge)) continue;
                const useKey = edgeUseKey(edge);
                if (current.usedRoadIds.has(useKey)) continue;
                // Only allow the anchor road source to be re-traversed if doing so closes the loop.
                if (anchorSourceRoadId && edgeSourceKey(edge) === anchorSourceRoadId && edge.targetKey !== targetKey) continue;
                if (current.visitedKeys.has(edge.targetKey) && edge.targetKey !== targetKey) continue;

                const nextDist = current.dist + (edge.len || 0);
                if (nextDist > maxDist) continue;

                const nextUsed = new Set(current.usedRoadIds);
                nextUsed.add(useKey);
                const nextVisited = new Set(current.visitedKeys);
                nextVisited.add(edge.targetKey);
                open.push({
                    key: edge.targetKey,
                    dist: nextDist,
                    goodDist: current.goodDist + (edge.isGood ? (edge.len || 0) : 0),
                    preferredHits: current.preferredHits + (preferredRoadIds.has(edgeSourceKey(edge)) ? 1 : 0),
                    path: [...current.path, edge],
                    usedRoadIds: nextUsed,
                    visitedKeys: nextVisited
                });
            }
        }

        results.sort((a, b) => {
            const aScore = (a.preferredHits * 4) + (a.goodDist * 1.5) - (a.dist * 0.25);
            const bScore = (b.preferredHits * 4) + (b.goodDist * 1.5) - (b.dist * 0.25);
            return bScore - aScore;
        });
        return results;
    }

    const anchors = goodRoads.slice(0, 28);
    const rawRoutes = [];
    const seenSigs = new Set();

    // Loop-first generator -------------------------------------------------
    // Build geographically balanced triangles around the search origin and
    // route through those waypoints. This avoids the old failure mode where
    // the search committed to a long outward leg before discovering that the
    // only viable return was a weak, overlapping or highly lopsided path.
    function nearestGraphNode(coord, predicate = null) {
        let bestKey = null;
        let bestDist = Infinity;
        for (const key of graphNodes) {
            if (predicate && !predicate(key)) continue;
            const c = nodeKeyToCoord(key);
            const d = fastDistRaw(coord[0], coord[1], c[0], c[1]);
            if (d < bestDist) { bestDist = d; bestKey = key; }
        }
        return bestKey;
    }

    function destinationPoint(origin, bearingDeg, distanceKm) {
        const R = 6371;
        const brng = bearingDeg * Math.PI / 180;
        const lat1 = origin[0] * Math.PI / 180;
        const lon1 = origin[1] * Math.PI / 180;
        const dr = distanceKm / R;
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brng));
        const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
        return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
    }

    function angularDifference(a, b) {
        return Math.abs(((a - b + 540) % 360) - 180);
    }

    function pickDirectionalWaypoint(origin, targetBearing, targetRadiusKm, excludedKeys = new Set()) {
        let bestKey = null;
        let bestScore = Infinity;
        for (const key of graphNodes) {
            if (excludedKeys.has(key)) continue;
            const coord = nodeKeyToCoord(key);
            const radiusKm = fastDistRaw(origin[0], origin[1], coord[0], coord[1]) / 1000;
            if (radiusKm < Math.max(0.6, targetRadiusKm * 0.45) || radiusKm > targetRadiusKm * 1.8) continue;
            const bearing = bearingRaw(origin[0], origin[1], coord[0], coord[1]);
            const angleError = angularDifference(bearing, targetBearing);
            if (angleError > 58) continue;
            const radiusError = Math.abs(radiusKm - targetRadiusKm) / Math.max(0.5, targetRadiusKm);
            const edges = graph.get(key) || [];
            const goodEdges = edges.filter(edge => edge.isGood);
            const quality = goodEdges.length
                ? goodEdges.reduce((sum, edge) => sum + (edge.score || 0), 0) / goodEdges.length
                : 0;
            const junctionBonus = Math.min(4, new Set(edges.map(edge => edge.targetKey)).size);
            const score = angleError * 0.75 + radiusError * 38 - quality * 0.12 - junctionBonus * 2.5;
            if (score < bestScore) { bestScore = score; bestKey = key; }
        }
        return bestKey;
    }

    // Heap-based bounded A*. Round-trip routing runs several short legs; using
    // Array.sort() on every expansion made v141.8 effectively freeze on dense
    // road graphs. Each leg now has both a state cap and a wall-clock deadline.
    function routeHeapPush(heap, row) {
        heap.push(row);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].f <= row.f) break;
            heap[i] = heap[parent];
            i = parent;
        }
        heap[i] = row;
    }

    function routeHeapPop(heap) {
        if (!heap.length) return null;
        const root = heap[0];
        const last = heap.pop();
        if (heap.length && last) {
            let i = 0;
            while (true) {
                const left = i * 2 + 1;
                const right = left + 1;
                if (left >= heap.length) break;
                const child = right < heap.length && heap[right].f < heap[left].f ? right : left;
                if (heap[child].f >= last.f) break;
                heap[i] = heap[child];
                i = child;
            }
            heap[i] = last;
        }
        return root;
    }

    function findBalancedPath(startKey, targetKey, options = {}) {
        if (!startKey || !targetKey) return null;
        if (startKey === targetKey) return [];
        const maxDist = options.maxDist ?? maxD;
        const bannedSegments = options.bannedSegments || new Set();
        const discouragedSources = options.discouragedSources || new Set();
        const discouragedSegments = options.discouragedSegments || new Set();
        const preferredSources = options.preferredSources || new Set();
        const maxStates = Math.max(300, Math.min(3500, options.maxStates ?? 2200));
        const deadline = Math.min(
            Number(options.deadlineAt) || Infinity,
            Date.now() + Math.max(80, Number(options.budgetMs) || 320)
        );
        const targetCoord = nodeKeyToCoord(targetKey);
        const heuristicFor = key => {
            const c = nodeKeyToCoord(key);
            return fastDistRaw(c[0], c[1], targetCoord[0], targetCoord[1]) / 1000;
        };
        const open = [];
        routeHeapPush(open, { key:startKey, dist:0, cost:0, f:heuristicFor(startKey), path:[], used:new Set() });
        const initialState = RF.routingStateKey ? RF.routingStateKey(startKey, [], state.turnRestrictions) : startKey;
        const best = new Map([[initialState, 0]]);
        let states = 0;

        while (open.length && states++ < maxStates) {
            if ((states & 127) === 0 && Date.now() >= deadline) break;
            const current = routeHeapPop(open);
            if (!current) break;
            if (current.key === targetKey) return current.path;
            const neighbors = graph.get(current.key) || [];
            for (const edge of neighbors.slice(0, 18)) {
                if (!turnIsAllowed(current.path, edge)) continue;
                const seg = edgeUseKey(edge);
                if (bannedSegments.has(seg) || current.used.has(seg)) continue;
                const nextDist = current.dist + (edge.len || 0);
                if (nextDist > maxDist) continue;

                const quality = Math.max(0, Math.min(100, edge.score || 0));
                const connectorPenalty = edge.isGood ? 0 : 0.48;
                const sourceKey = edgeSourceKey(edge);
                const reusePenalty = (discouragedSources.has(sourceKey) ? 0.65 : 0) +
                    (discouragedSegments.has(seg) ? 2.2 : 0);
                const preferredBonus = preferredSources.has(sourceKey) ? 0.28 : 0;
                const edgeCost = (edge.len || 0) * Math.max(0.48, 1.35 - quality / 180 - preferredBonus) + connectorPenalty + reusePenalty;
                const nextCost = current.cost + edgeCost;
                const nextPath = [...current.path, edge];
                const routingKey = RF.routingStateKey ? RF.routingStateKey(edge.targetKey, nextPath, state.turnRestrictions) : edge.targetKey;
                const previous = best.get(routingKey);
                if (previous !== undefined && previous <= nextCost) continue;
                best.set(routingKey, nextCost);
                const used = new Set(current.used); used.add(seg);
                const h = heuristicFor(edge.targetKey);
                routeHeapPush(open, {
                    key: edge.targetKey,
                    dist: nextDist,
                    cost: nextCost,
                    f: nextCost + h * 0.13,
                    path: nextPath,
                    used
                });
            }
        }
        return null;
    }

    function pathSegmentSet(path) { return new Set(path.map(edgeUseKey)); }
    function pathSourceSet(path) { return new Set(path.map(edgeSourceKey)); }

    // Score-chained loop generator ------------------------------------------
    // Start at the user's chosen location, identify the best roads around it,
    // chain those roads in a sensible angular order, then close the route back
    // to the same start. Geometry shapes the loop; Road Score decides which
    // roads deserve to be included.
    const graphNodesByRoad = new Map();
    const addRoadNode = (roadId, key) => {
        if (!roadId || !key || !graph.has(key)) return;
        const id = String(roadId);
        if (!graphNodesByRoad.has(id)) graphNodesByRoad.set(id, new Set());
        graphNodesByRoad.get(id).add(key);
    };
    for (const [fromKey, edges] of graph.entries()) {
        for (const edge of edges || []) {
            const roadId = edgeSourceKey(edge);
            addRoadNode(roadId, fromKey);
            addRoadNode(roadId, edge.targetKey);
        }
    }

    function roadWaypointKey(road, excluded = new Set()) {
        const keys = [...(graphNodesByRoad.get(String(road?.id)) || [])].filter(k => !excluded.has(k));
        if (!keys.length) return null;
        const mid = road?.coords?.[Math.floor((road.coords.length - 1) / 2)] || routeOrigin;
        let best = null, bestDist = Infinity;
        for (const key of keys) {
            const c = nodeKeyToCoord(key);
            const d = fastDistRaw(mid[0], mid[1], c[0], c[1]);
            if (d < bestDist) { bestDist = d; best = key; }
        }
        return best;
    }

    async function generateScoreChainedLoops() {
        const origin = routeOrigin;
        if (!origin || !RF.planScoreChainedRoundTrips) return;
        const startKey = nearestGraphNode(origin);
        if (!startKey) return;

        const targetDistance = Math.max(minD, Math.min(maxD, (minD + maxD) / 2));
        const radiusKm = Math.max(1.0, targetDistance / 6.15);
        const roadPool = goodRoads.slice(0, 60);
        const plans = RF.planScoreChainedRoundTrips(roadPool, origin, radiusKm, {
            count: 3,
            minScore: 30,
            maxAngle: 68,
            limit: 8,
            rotations: [0, 60, 120, 180, 240, 300]
        });
        if (!plans.length) return;

        // The whole score-chain stage is deliberately time-bounded. Returning
        // the best 2-3 completed loops is far better than freezing while trying
        // every possible combination.
        const overallDeadline = Math.min(routeBuildDeadline, Date.now() + 2600);
        for (const plan of plans) {
            if (Date.now() >= overallDeadline || rawRoutes.filter(r => r.generationMethod === 'score-chain').length >= 8) break;
            const chosen = plan.anchors || [];
            const excluded = new Set([startKey]);
            const waypointRows = [];
            for (const row of chosen) {
                const key = roadWaypointKey(row.road, excluded);
                if (!key) continue;
                excluded.add(key);
                waypointRows.push({ ...row, key });
            }
            if (waypointRows.length < 2) continue;

            const preferredSources = new Set(waypointRows.map(row => String(row.road.id)));
            const sequence = [startKey, ...waypointRows.map(row => row.key), startKey];
            const legs = [];
            let failed = false;
            let banned = new Set();
            let discouraged = new Set();

            for (let i = 0; i < sequence.length - 1; i++) {
                if (Date.now() >= overallDeadline) { failed = true; break; }
                const usedDist = pathDistance(legs.flat());
                const remainingLegs = sequence.length - 1 - i;
                const reserve = Math.max(0.5, (remainingLegs - 1) * 0.45);
                const legBudget = Math.max(1.5, maxD - usedDist - reserve);
                let leg = findBalancedPath(sequence[i], sequence[i + 1], {
                    maxDist: legBudget,
                    bannedSegments: banned,
                    discouragedSources: discouraged,
                    preferredSources,
                    maxStates: 2200,
                    budgetMs: 300,
                    deadlineAt: overallDeadline
                });
                // A strict non-overlap rule can strand the closing leg. Retry
                // once with reused segments penalised rather than forbidden.
                if (!leg || !leg.length) {
                    leg = findBalancedPath(sequence[i], sequence[i + 1], {
                        maxDist: legBudget,
                        discouragedSegments: banned,
                        discouragedSources: discouraged,
                        preferredSources,
                        maxStates: 2600,
                        budgetMs: 340,
                        deadlineAt: overallDeadline
                    });
                }
                if (!leg || !leg.length) { failed = true; break; }
                legs.push(leg);
                for (const seg of pathSegmentSet(leg)) banned.add(seg);
                for (const src of pathSourceSet(leg)) discouraged.add(src);
            }
            if (!failed) {
                const fullPath = legs.flat();
                const total = pathDistance(fullPath);
                if (total >= minD && total <= maxD) {
                    const sources = pathSourceSet(fullPath);
                    const anchorHits = [...preferredSources].filter(id => sources.has(id));
                    if (anchorHits.length >= Math.min(2, preferredSources.size)) {
                        const sourceSig = [...sources].sort().join('|');
                        if (!seenSigs.has(sourceSig)) {
                            const anchor = waypointRows.slice().sort((a,b)=>b.score-a.score)[0]?.road || anchors[0];
                            const outward = waypointRows[Math.floor(waypointRows.length / 2)]?.key;
                            const formatted = formatRouteFromPath(fullPath, anchor, outward);
                            if (formatted) {
                                const repeatedKm = calculateSelfOverlapPenalty(fullPath);
                                const repeatedRatio = repeatedKm / Math.max(0.1, total);
                                if (formatted.driverRoadRatio >= 0.40 && formatted.uniqueRoadCount >= 4 && repeatedRatio <= 0.18) {
                                    const chainScore = waypointRows.reduce((sum,row)=>sum+Number(row.score||0),0) / waypointRows.length;
                                    formatted.rankScore += 10 + Math.max(0, chainScore - 45) * 0.10;
                                    formatted.generationMethod = 'score-chain';
                                    formatted.chainedRoadNames = waypointRows.map(row => row.road.name || 'Unnamed Road');
                                    formatted.chainedRoadScore = Math.round(chainScore);
                                    seenSigs.add(sourceSig);
                                    rawRoutes.push(formatted);
                                }
                            }
                        }
                    }
                }
            }

            // Yield between chains so the loading indicator animates and the
            // browser remains cancellable/responsive on mobile devices.
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    await generateScoreChainedLoops();

    async function generateWaypointLoops() {
        const origin = routeOrigin;
        if (!origin || Date.now() >= routeBuildDeadline) return;
        const startKey = nearestGraphNode(origin);
        if (!startKey) return;

        const targetDistances = [...new Set([
            Math.max(minD, Math.min(maxD, (minD + maxD) / 2)),
            Math.max(minD, Math.min(maxD, minD + (maxD - minD) * 0.30))
        ].map(v => Number(v.toFixed(1))))];
        const rotations = [0, 90, 180, 270];
        const fallbackDeadline = Math.min(routeBuildDeadline, Date.now() + 1200);

        for (const targetDistance of targetDistances) {
            const radiusKm = Math.max(1.2, targetDistance / 6.1);
            for (const rotation of rotations) {
                for (const direction of [1, -1]) {
                    if (Date.now() >= fallbackDeadline || rawRoutes.length >= 6) return;
                    const bearings = [rotation, rotation + direction * 120, rotation + direction * 240];
                    const waypointKeys = [];
                    const excluded = new Set([startKey]);
                    for (const bearing of bearings) {
                        const key = pickDirectionalWaypoint(origin, (bearing + 360) % 360, radiusKm, excluded);
                        if (!key) break;
                        waypointKeys.push(key);
                        excluded.add(key);
                    }
                    if (waypointKeys.length !== 3 || new Set([startKey, ...waypointKeys]).size < 4) continue;

                    const legs = [];
                    let failed = false;
                    let banned = new Set();
                    let discouraged = new Set();
                    const sequence = [startKey, ...waypointKeys, startKey];
                    for (let i = 0; i < sequence.length - 1; i++) {
                        if (Date.now() >= fallbackDeadline) { failed = true; break; }
                        const remainingLegs = sequence.length - 1 - i;
                        const usedDist = pathDistance(legs.flat());
                        const legBudget = Math.max(2, maxD - usedDist - (remainingLegs - 1) * 0.5);
                        let leg = findBalancedPath(sequence[i], sequence[i+1], {
                            maxDist: legBudget,
                            bannedSegments: banned,
                            discouragedSources: discouraged,
                            maxStates: 1400,
                            budgetMs: 180,
                            deadlineAt: fallbackDeadline
                        });
                        if (!leg || !leg.length) {
                            leg = findBalancedPath(sequence[i], sequence[i+1], {
                                maxDist: legBudget,
                                discouragedSegments: banned,
                                discouragedSources: discouraged,
                                maxStates: 1600,
                                budgetMs: 200,
                                deadlineAt: fallbackDeadline
                            });
                        }
                        if (!leg || !leg.length) { failed = true; break; }
                        legs.push(leg);
                        for (const seg of pathSegmentSet(leg)) banned.add(seg);
                        for (const src of pathSourceSet(leg)) discouraged.add(src);
                    }
                    if (!failed) {
                        const fullPath = legs.flat();
                        const total = pathDistance(fullPath);
                        if (total >= minD && total <= maxD) {
                            const sourceSig = [...new Set(fullPath.map(edgeSourceKey))].sort().join('|');
                            if (!seenSigs.has(sourceSig)) {
                                const anchor = fullPath.find(e => e.isGood)?.roadRef || anchors[0];
                                const formatted = formatRouteFromPath(fullPath, anchor, waypointKeys[1]);
                                if (formatted) {
                                    const repeatedKm = calculateSelfOverlapPenalty(fullPath);
                                    const repeatedRatio = repeatedKm / Math.max(0.1, total);
                                    if (formatted.driverRoadRatio >= 0.38 && formatted.uniqueRoadCount >= 4 && repeatedRatio <= 0.16) {
                                        seenSigs.add(sourceSig);
                                        formatted.rankScore += 5;
                                        formatted.generationMethod = 'bounded-waypoints';
                                        rawRoutes.push(formatted);
                                    }
                                }
                            }
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        }
    }

    if (rawRoutes.length < 3 && Date.now() < routeBuildDeadline) await generateWaypointLoops();

    // The pre-v141.9 exhaustive anchor DFS and generic cycle enumeration are
    // intentionally no longer executed. They could explore tens of thousands
    // of states after the score-chain stage failed, which recreated the same
    // apparent infinite "Building route options…" state. The bounded waypoint
    // pass above is the only fallback; if it cannot make a legal loop inside
    // the time budget we return cleanly and ask the user to widen the range.

    if (!rawRoutes.length) return [];

    rawRoutes.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score);

    const selected = [];
    for (const route of rawRoutes) {
        if (selected.length >= 10) break;
        const tooSimilar = selected.some(existing => {
            const overlap = overlapRatio(route.roadIds, existing.roadIds);
            const reverseOverlap = overlapRatio(existing.roadIds, route.roadIds);
            return overlap > 0.55 || reverseOverlap > 0.55;
        });
        if (!tooSimilar) selected.push(route);
    }

    if (selected.length < 10) {
        for (const route of rawRoutes) {
            if (selected.length >= 10) break;
            if (!selected.includes(route)) selected.push(route);
        }
    }

    return selected
        .map(route => {
            if(RF.stableRouteId)route.id=RF.stableRouteId(route);
            delete route.roadIds;return route;
        })
        .sort((a, b) => b.rankScore - a.rankScore || b.score - a.score);
}

async function generateSuggestedA2BRoutes(allRoads, opts = {}) {
    const mode = state.routeMode;
    const minVal = mode === 'distance' ? Math.max(1, opts.minD || 1) : Math.max(5, opts.minT || 5);
    const maxVal = mode === 'distance' ? Math.max(minVal, opts.maxD || 50) : Math.max(minVal, opts.maxT || 120);
    const minD = mode === 'distance' ? minVal : minVal * 0.83;
    const maxD = mode === 'distance' ? maxVal : maxVal * 0.83;

    const usableRoads = allRoads.filter(r => r && r.coords && r.coords.length >= 2 && parseFloat(r.len) > 0.2);
    const goodRoads = usableRoads
        .filter(r => r.tier !== 'excluded' && r.score >= 30 && parseFloat(r.len) >= 0.45)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
    if (goodRoads.length < 2) return [];

    const graph = buildRoadGraph(usableRoads);
    if (graph.size < 3) return [];

    const edgeSourceKey = edge => edge.sourceRoadId || edge.roadId;
    const buildCoordsFromPath = (path) => {
        const out = [];
        for (const edge of path) {
            const coords = edge.coords || [];
            if (!coords.length) continue;
            if (!out.length) { out.push(...coords); continue; }
            const prev = out[out.length - 1];
            const first = coords[0];
            const same = Math.abs(prev[0] - first[0]) < 0.000001 && Math.abs(prev[1] - first[1]) < 0.000001;
            out.push(...(same ? coords.slice(1) : coords));
        }
        return out;
    };
    const classifyTier = score => score >= 70 ? 'tier1' : score >= 50 ? 'tier2' : score >= 30 ? 'tier3' : 'tier4';
    const pathDistance = path => path.reduce((sum, e) => sum + (e.len || 0), 0);
    const pathGoodDistance = path => path.reduce((sum, e) => sum + (e.isGood ? (e.len || 0) : 0), 0);

    function nodeKeyToCoord(key) {
        const [lat, lon] = key.split(',').map(Number);
        return [lat, lon];
    }
    function heuristic(nodeKey, targetKey) {
        const a = nodeKeyToCoord(nodeKey);
        const b = nodeKeyToCoord(targetKey);
        return fastDistRaw(a[0], a[1], b[0], b[1]) / 1000;
    }

    function astar(startKey, endKey, scoreWeight = 0.85) {
        const open = [{ key: startKey, g: 0, f: heuristic(startKey, endKey), path: [] }];
        const best = new Map([[startKey, 0]]);
        let states = 0;
        while (open.length && states++ < 6500) {
            open.sort((a, b) => a.f - b.f);
            const current = open.shift();
            if (current.key === endKey && current.path.length) return current.path;
            const neighbors = graph.get(current.key) || [];
            for (const edge of neighbors.slice(0, 22)) {
                if(!turnIsAllowed(current.path, edge)) continue;
                const connectorPenalty = edge.isGood ? 0 : 0.18;
                const scoreBonus = scoreWeight * ((edge.score || 0) / 100) * (edge.len || 0) * 0.55;
                const cost = Math.max(0.004, (edge.len || 0) + connectorPenalty - scoreBonus);
                const g = current.g + cost;
                const physicalDist = pathDistance(current.path) + (edge.len || 0);
                if (physicalDist > maxD * 1.18) continue;
                const nextPath=[...current.path, edge];
                const routingKey=RF.routingStateKey?RF.routingStateKey(edge.targetKey,nextPath,state.turnRestrictions):edge.targetKey;
                if (!best.has(routingKey) || g < best.get(routingKey)) {
                    best.set(routingKey, g);
                    open.push({
                        key: edge.targetKey,
                        g,
                        f: g + heuristic(edge.targetKey, endKey),
                        path: nextPath
                    });
                }
            }
        }
        return null;
    }

    function formatA2BPath(path, labelSeed = '') {
        const coords = buildCoordsFromPath(path);
        if (coords.length < 2) return null;
        const totalDist = pathDistance(path);
        if (totalDist < minD || totalDist > maxD * 1.08) return null;
        const goodEdges = path.filter(e => e.isGood);
        const goodDist = pathGoodDistance(path);
        const uniqueGoodIds = new Set(goodEdges.map(edgeSourceKey));
        if (uniqueGoodIds.size < 2 || (goodDist / Math.max(0.1, totalDist)) < 0.45) return null;

        const detailMap = new Map();
        for (const edge of path) {
            const k = edgeSourceKey(edge);
            if (!detailMap.has(k)) {
                detailMap.set(k, {
                    name: edge.roadRef?.name || 'Unnamed Road',
                    score: edge.roadRef?.score || 0,
                    tier: edge.roadRef?.tier || 'excluded',
                    confidence: edge.roadRef?.confidence || 55,
                    len: 0,
                    isGood: !!edge.isGood
                });
            }
            const row = detailMap.get(k);
            row.len += edge.len || 0;
            row.isGood = row.isGood || !!edge.isGood;
        }
        const roadDetails = [...detailMap.values()].map(row => ({ ...row, len: Number(row.len.toFixed(2)) }));
        const avgScore = goodDist>0?Math.round(goodEdges.reduce((sum,e)=>sum+(e.score||0)*(e.len||0),0)/goodDist):0;
        const roadNames = [...new Set(goodEdges.map(e => e.roadRef?.name).filter(Boolean))];
        const firstName = roadNames[0] || labelSeed || 'Scenic road';
        const lastName = roadNames.find(n => n !== firstName) || roadNames[roadNames.length - 1] || '';
        const scenicBias = goodEdges.reduce((sum, e) => sum + (e.roadRef?.scenery || 0), 0) / Math.max(1, goodEdges.length);
        const driverRoadRatio = goodDist / Math.max(0.1, totalDist);
        const routeEvidence=RF.routeConfidence?RF.routeConfidence({roadDetails,driverRoadRatio}):{score:55};
        const rankScore = (avgScore * 0.42) + (driverRoadRatio * 100 * 0.26) + (Math.min(100, uniqueGoodIds.size * 14) * 0.16) + (Math.min(100, scenicBias) * 0.10) + ((routeEvidence.score-55)*0.05) - Math.max(0, totalDist - goodDist) * 0.8;

        return {
            id: `A2B-SUG-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`,
            routeType: 'a2b',
            isCircular: false,
            name: lastName && lastName !== firstName ? `${firstName} to ${lastName}` : `A-to-B via ${firstName}`,
            coords,
            startCoord: coords[0],
            len: totalDist.toFixed(1),
            timeMins: estimatePathTimeMins(path),
            score: avgScore,
            tier: classifyTier(avgScore),
            goodRoads: uniqueGoodIds.size,
            driverRoadRatio,
            routeConfidence: routeEvidence.score,
            maxSpd: goodDist>0 ? Math.round(goodEdges.reduce((sum,e)=>sum+(e.roadRef?.speedMph||0)*(e.len||0),0)/goodDist) : 0,
            roadDetails,
            roadNames,
            rankScore,
            uniqueRoadCount: new Set(path.map(edgeSourceKey)).size,
            segmentDetails: [
                { coords, isGood: false, name: 'A-to-B path' },
                ...goodEdges.map(edge => ({
                    coords: edge.coords,
                    isGood: true,
                    name: edge.roadRef?.name || 'Unnamed Road',
                    score: edge.score,
                    confidence: edge.roadRef?.confidence || 55
                }))
            ],
            roadIds: new Set(path.map(edgeSourceKey))
        };
    }

    // When the local network has few closed loops — the normal case for rural
    // roads — point-to-point chains are the whole answer, so the caller can ask
    // for a wider search rather than the default handful.
    const anchorLimit = Math.max(22, Math.min(48, Number(opts.anchorLimit) || 22));
    const resultTarget = Math.max(8, Math.min(16, Number(opts.resultLimit) || 8));
    const minSeparationKm = Number(opts.minSeparationKm) > 0
        ? Number(opts.minSeparationKm)
        : Math.max(1.5, minD * 0.35);

    const anchors = goodRoads.slice(0, anchorLimit);
    const endpoints = [];
    for (const road of anchors) {
        const pts = [road.coords[0], road.coords[road.coords.length - 1], road.coords[Math.floor(road.coords.length / 2)]];
        for (const pt of pts) {
            const key = getNodeKey(pt);
            if (key && graph.has(key)) endpoints.push({ key, road });
        }
    }

    const results = [];
    const seen = new Set();
    const searchCap = resultTarget * 2;
    for (let i = 0; i < endpoints.length && results.length < searchCap; i++) {
        for (let j = endpoints.length - 1; j >= 0 && results.length < searchCap; j--) {
            if (i === j || endpoints[i].road.id === endpoints[j].road.id) continue;
            const a = nodeKeyToCoord(endpoints[i].key);
            const b = nodeKeyToCoord(endpoints[j].key);
            const straightKm = fastDistRaw(a[0], a[1], b[0], b[1]) / 1000;
            if (straightKm < minSeparationKm || straightKm > maxD * 0.95) continue;
            const pairKey = [endpoints[i].road.id, endpoints[j].road.id].sort().join('|');
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            const path = astar(endpoints[i].key, endpoints[j].key, 0.9);
            if (!path) continue;
            const route = formatA2BPath(path, endpoints[i].road.name);
            if (!route) continue;
            const tooSimilar = results.some(r => {
                const ids = route.roadIds;
                let shared = 0;
                for (const id of ids) if (r.roadIds?.has(id)) shared++;
                return shared / Math.max(1, ids.size) > 0.62;
            });
            if (!tooSimilar) results.push(route);
        }
    }

    return results
        .map(route=>{if(RF.stableRouteId)route.id=RF.stableRouteId(route);delete route.roadIds;return route;})
        .sort((a, b) => (b.rankScore || b.score) - (a.rankScore || a.score))
        .slice(0, resultTarget);
}
async function process(data,onProgress,signal){
  const roads=[],excluded=[],allProcessed=[];
  if(!data.elements) return{roads,excluded,allProcessed};
  state.turnRestrictions = RF.extractTurnRestrictions ? RF.extractTurnRestrictions(data.elements) : new Map();

    const urbanPolygons = [];
  const urbanCenters = [];

  for (const el of data.elements) {
    if (el.type === 'way' && el.tags && el.tags.landuse && el.geometry) {
      if (['residential', 'commercial', 'retail', 'industrial'].includes(el.tags.landuse)) {
        let minL=90, maxL=-90, minLn=180, maxLn=-180;
        for (const pt of el.geometry) {
          if(pt.lat < minL) minL = pt.lat;
          if(pt.lat > maxL) maxL = pt.lat;
          if(pt.lon < minLn) minLn = pt.lon;
          if(pt.lon > maxLn) maxLn = pt.lon;
        }
        el._aabb = { minL, maxL, minLn, maxLn };
        urbanPolygons.push(el);
      }
    }
    if (el.type === 'node' && el.tags && el.tags.place) {
      const pt = el.tags.place;
      if (['city', 'town', 'village', 'suburb'].includes(pt)) {
        let r = 500;
        if (pt === 'city') r = 2500;
        if (pt === 'town') r = 1000;
        if (pt === 'suburb') r = 500;
        if (pt === 'village') r = 300;
        urbanCenters.push({ lat: el.lat, lon: el.lon, radius: r });
      }
    }
  }

  const pointInPolygon=(lat,lon,geometry=[])=>{if(!Array.isArray(geometry)||geometry.length<4)return false;let inside=false;for(let i=0,j=geometry.length-1;i<geometry.length;j=i++){const yi=geometry[i].lat,xi=geometry[i].lon,yj=geometry[j].lat,xj=geometry[j].lon;const crosses=((yi>lat)!==(yj>lat))&&(lon<((xj-xi)*(lat-yi)/(yj-yi||1e-12)+xi));if(crosses)inside=!inside}return inside};
  const isInsideUrban = (lat, lon) => {
    // Precompute cos(lat) once instead of in each iteration
    const cosLat = Math.cos(lat * Math.PI / 180);
    // Check distance to urban center nodes
    for (const c of urbanCenters) {
      const dLat = (c.lat - lat) * 111320;
      const dLon = (c.lon - lon) * 111320 * cosLat;
      // Use squared distance to avoid sqrt inside tight loop
      const distSq = dLat*dLat + dLon*dLon;
      if (distSq < c.radius * c.radius) return true;
    }
    // Check polygons
    for (const area of urbanPolygons) {
      const { minL, maxL, minLn, maxLn } = area._aabb;
      const buf = 0.0005; // roughly 50m
      if (lat >= minL-buf && lat <= maxL+buf && lon >= minLn-buf && lon <= maxLn+buf) {
        if(!area.geometry?.length || pointInPolygon(lat,lon,area.geometry)) return true;
      }
    }
    return false;
  };


  const scenery = [];
  const sceneryGrid = new Map();
  const addSceneryPoint = (lat, lon, weight, cat, source='', featureId='') => {
    if(!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const sc = {lat, lon, weight, cat, source, featureId: featureId || source};
    scenery.push(sc);
    const gx = Math.floor(lon / 0.02);
    const gy = Math.floor(lat / 0.02);
    const k = `${gx},${gy}`;
    if(!sceneryGrid.has(k)) sceneryGrid.set(k, []);
    sceneryGrid.get(k).push(sc);
  };

  for(const el of data.elements){
    if(!el.tags?.highway) {
      const t = el.tags || {};
      let cat = 'green';
      let weight = 2;
      if(t.tourism==='viewpoint') { cat = 'landmark'; weight = 7; }
      else if(t.natural==='peak' || t.natural==='fell') { cat = 'landmark'; weight = 5; }
      else if(t.natural==='beach' || t.natural==='coastline') { cat = 'coast'; weight = 7; }
      else if(t.natural==='water'||t.waterway) { cat = 'water'; weight = 6; }
      else if(t.boundary==='national_park' || t.boundary==='protected_area') { cat = 'park'; weight = 5; }
      else if(t.natural==='wood'||t.landuse==='forest'||t.leisure==='nature_reserve') { cat = 'green'; weight = 4; }
      else if(['heath','scrub','grassland'].includes(t.natural) || ['meadow','grass','recreation_ground'].includes(t.landuse)) { cat = 'open'; weight = 3; }

      // Way centres alone badly under-score roads running beside reservoirs, rivers or woods.
      // When geometry is available, index several points along the feature boundary/line so
      // proximity checks can see scenery next to the road rather than only the polygon centre.
      if(el.geometry && el.geometry.length) {
        const step = Math.max(1, Math.floor(el.geometry.length / 12));
        for(let i=0; i<el.geometry.length; i+=step) addSceneryPoint(el.geometry[i].lat, el.geometry[i].lon, weight, cat, t.name || t.natural || t.landuse || t.waterway || 'scenery', `${el.type}:${el.id}`);
        const last = el.geometry[el.geometry.length - 1];
        addSceneryPoint(last.lat, last.lon, weight, cat, t.name || t.natural || t.landuse || t.waterway || 'scenery', `${el.type}:${el.id}`);
      } else {
        let lat, lon;
        if(el.type === 'node') { lat=el.lat; lon=el.lon; }
        else if(el.center) { lat=el.center.lat; lon=el.center.lon; }
        addSceneryPoint(lat, lon, weight, cat, t.name || t.natural || t.landuse || t.waterway || 'scenery', `${el.type}:${el.id}`);
      }
    }
  }

  let id=1; const pending=[];
  for(const el of data.elements){
    if(!el.tags?.highway || ['residential', 'commercial', 'retail', 'industrial'].includes(el.tags.landuse) || !el.geometry || el.geometry.length<2) continue;
    let reason=null;
    if(el.tags?.junction==='roundabout') reason='Roundabout';
    if(el.tags?.highway==='motorway' || el.tags?.highway==='motorway_link') reason='Motorway';
    let explicitSpd = getExplicitSpeed(el.tags || {});
    let speed = explicitSpd;
    let speedIsEstimated = !explicitSpd;

    if (!reason) {
      const t = el.tags || {};
      const hw = t.highway || '';
      const n = getRoadName(t); const name = (n.match(/^(Primary|Secondary|Tertiary|Unclassified|Residential|Unnamed) (Road|Street)$/i) ? '' : n).toLowerCase();

      const urbanName =
        name.includes(' street') ||
        name.includes(' avenue') ||
        name.includes(' close') ||
        name.includes(' drive') ||
        name.includes(' crescent') ||
        name.includes(' grove') ||
        name.includes(' terrace') ||
        name.includes(' court') ||
        name.includes(' place'); // Removed 'road', 'lane', 'way' which are common on great rural driving roads

      const midIdx = Math.floor(el.geometry.length / 2);
      const midLat = el.geometry[midIdx].lat;
      const midLon = el.geometry[midIdx].lon;
      const inSettlement = isInsideUrban(midLat, midLon);

      const urbanHint =
        inSettlement ||
        t.lit === 'yes' ||
        (t.sidewalk && t.sidewalk !== 'no' && t.sidewalk !== 'none') ||
        t['zone:traffic'] === 'urban' ||
        hw === 'residential' ||
        (urbanName && inSettlement); // require both

      const ruralHint =
        t.lit === 'no' ||
        (!t.sidewalk && !t['zone:traffic'] && !urbanHint && !['residential'].includes(hw));

      // Only override speed if we don't have an explicit speed limit
      if (!explicitSpd && urbanHint && !['primary', 'secondary', 'tertiary'].includes(hw)) {
        speed = 30;
        speedIsEstimated = true;
      } else if (!speed) {
        if (ruralHint && ['primary', 'secondary', 'trunk', 'tertiary', 'unclassified'].includes(hw)) {
          speed = (t.oneway === 'yes' || t.dual_carriageway === 'yes') ? 70 : 60;
        } else {
          if (['primary', 'secondary', 'trunk'].includes(hw) && !urbanHint) {
            speed = 40;
          } else {
            speed = 30;
          }
        }
      }
    }
    const rawCoords=el.geometry.map(pt=>[pt.lat,pt.lon]);
    const rd={el,speed,reason,speedIsEstimated,graphWays:[{wayId:el.id,coords:rawCoords,nodeIds:Array.isArray(el.nodes)?[...el.nodes]:[],tags:{...(el.tags||{})}}]};
    pending.push(rd);
  }
  
  // Merge contiguous segments with the same name (Optimized O(N) using Map)
  const mergedPending = [];
  const groupedByName = new Map();
  for (const p of pending) {
    if (p.reason || !p.el.tags?.name) {
      mergedPending.push(p);
      continue;
    }
    // Group by both name and speed so slow sections don't ruin fast sections
    const key = p.el.tags.name + '|' + Math.round(p.speed / 10) * 10;
    if (!groupedByName.has(key)) groupedByName.set(key, []);
    groupedByName.get(key).push(p);
  }

  const getPtKey = (pt) => `${Math.round(pt.lat*100000)},${Math.round(pt.lon*100000)}`;

  for (const [key, group] of groupedByName.entries()) {
    let unmerged = new Set(group);

    while(unmerged.size > 0) {
      let current = unmerged.values().next().value;
      unmerged.delete(current);

      let merged = true;
      while(merged) {
        merged = false;
        const curGeom = current.el.geometry;
        const cStart = getPtKey(curGeom[0]);
        const cEnd = getPtKey(curGeom[curGeom.length - 1]);

        for (const cand of unmerged) {
          const candGeom = cand.el.geometry;
          const candStart = getPtKey(candGeom[0]);
          const candEnd = getPtKey(candGeom[candGeom.length - 1]);

          if (cEnd === candStart) {
            current.el.geometry = [...curGeom, ...candGeom.slice(1)];
            current.speed = Math.max(current.speed, cand.speed);
            current.speedIsEstimated = current.speedIsEstimated && cand.speedIsEstimated;
            current.graphWays=[...(current.graphWays||[]),...(cand.graphWays||[])];
            unmerged.delete(cand);
            merged = true; break;
          } else if (cEnd === candEnd) {
            current.el.geometry = [...curGeom, ...candGeom.slice(0, -1).reverse()];
            current.speed = Math.max(current.speed, cand.speed);
            current.speedIsEstimated = current.speedIsEstimated && cand.speedIsEstimated;
            current.graphWays=[...(current.graphWays||[]),...(cand.graphWays||[])];
            unmerged.delete(cand);
            merged = true; break;
          } else if (cStart === candEnd) {
            current.el.geometry = [...candGeom, ...curGeom.slice(1)];
            current.speed = Math.max(current.speed, cand.speed);
            current.speedIsEstimated = current.speedIsEstimated && cand.speedIsEstimated;
            current.graphWays=[...(current.graphWays||[]),...(cand.graphWays||[])];
            unmerged.delete(cand);
            merged = true; break;
          } else if (cStart === candStart) {
            current.el.geometry = [...candGeom.slice().reverse(), ...curGeom.slice(1)];
            current.speed = Math.max(current.speed, cand.speed);
            current.speedIsEstimated = current.speedIsEstimated && cand.speedIsEstimated;
            current.graphWays=[...(current.graphWays||[]),...(cand.graphWays||[])];
            unmerged.delete(cand);
            merged = true; break;
          }
        }
      }
      mergedPending.push(current);
    }
  }

  let _processed = 0;
  for(const d of mergedPending){

    if(signal?.aborted) throw new Error('Search cancelled.');
    _processed++;
    if (_processed % 200 === 0) {
      onProgress(`Scoring roads... ${_processed}/${mergedPending.length}`);
      await new Promise(r => setTimeout(r, 0));
    }
    const el=d.el; let reason=d.reason; const speed=d.speed; const speedIsEstimated=d.speedIsEstimated;
    if (!reason && el.geometry.length < 5) reason = 'Too few geometry points';
    const urbanStep=Math.max(1,Math.floor(el.geometry.length/12));
    const urbanSamples=[];
    for(let i=0;i<el.geometry.length;i+=urbanStep)urbanSamples.push(el.geometry[i]);
    if(urbanSamples[urbanSamples.length-1]!==el.geometry[el.geometry.length-1])urbanSamples.push(el.geometry[el.geometry.length-1]);
    const urbanHits=urbanSamples.reduce((sum,p)=>sum+(isInsideUrban(p.lat,p.lon)?1:0),0);
    const urbanExposure=urbanSamples.length?urbanHits/urbanSamples.length:0;
    const roadNameLower=(el.tags?.name||'').toLowerCase();
    const urbanNameHint=roadNameLower.includes(' street')||roadNameLower.includes(' avenue');
    const isUrban = urbanExposure >= 0.45 || speed <= 30 || (urbanNameHint && urbanExposure >= 0.20);

    if (state.debugMode) {
      debugLog(`[DEBUG] ${el.tags?.name||'Unnamed Road'} (way/${el.id}) | Urban exposure ${(urbanExposure*100).toFixed(0)}% | Final Speed: ${speed}mph`);
    }

    const qualityRows=(d.graphWays||[{tags:el.tags||{}}]).map(w=>RF.roadQuality?RF.roadQuality(w.tags||{}):({reject:false,penalty:0,confidencePenalty:0,flags:[]}));
    const rejectedQuality=qualityRows.find(q=>q.reject);const roadQuality={reject:Boolean(rejectedQuality),reason:rejectedQuality?.reason||'',penalty:Math.max(0,...qualityRows.map(q=>Number(q.penalty||0))),confidencePenalty:Math.max(0,...qualityRows.map(q=>Number(q.confidencePenalty||0))),flags:[...new Set(qualityRows.flatMap(q=>q.flags||[]))]};
    if(!reason&&roadQuality.reject)reason=roadQuality.reason;
        let totalLen=0,twists=0,accelZones=0,lastCornerDist=0,twistCount=0,microTwistCount=0,turnSum=0,maxTurnAngle=0,bendEvents=[];
    const pts=el.geometry;
    const nPts = pts.length;

    // Single pass: length + bearing/twists (was two separate loops doubling haversine cost)
    if(!reason) {
      for(let i=1;i<nPts;i++){
        const sd=haverDistRaw(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        totalLen+=sd;
        lastCornerDist+=sd;
        if(i<nPts-1){
          const a=bearingRaw(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
          const b=bearingRaw(pts[i].lat, pts[i].lon, pts[i+1].lat, pts[i+1].lon);
          const turnAngle = Math.abs(((a-b+540)%360)-180);
          if(turnAngle>6) {
            // Store small bend events for acceleration/rhythm scoring. This is
            // intentionally looser than the old >20° corner rule so flowing
            // roads with many small direction changes are not scored as having
            // zero acceleration zones.
            bendEvents.push({ dist: totalLen, angle: turnAngle });
          }
          if(turnAngle>8) {
            microTwistCount++;
            turnSum += turnAngle;
            if(turnAngle > maxTurnAngle) maxTurnAngle = turnAngle;
          }
          if(turnAngle>14) twistCount++;
          if(turnAngle>20){
            twists++; 
            if(turnAngle>45) twists += 0.5; // bonus for sharper twists
            lastCornerDist=0; 
          }
        }
      }
    } else {
      // Just calculate length for excluded roads (used in debug/merge logic)
      for(let i=1;i<nPts;i++){
        totalLen += haverDistRaw(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
      }
    }

    const km = Math.max(0.15, totalLen / 1000);
    const coarseTwistScore = (twistCount / km) * 20;
    const microTwistScore = (microTwistCount / km) * 9;
    const bendEnergyScore = (turnSum / km) * 0.55;
    // Micro heading changes are useful for recognising flowing roads, but raw OSM
    // geometry can contain tiny zig-zags. Cap the micro-only signal unless the
    // larger turns/bend energy corroborate it, so map noise cannot manufacture a
    // top-tier twist score.
    const corroboratedMicroTwist=Math.min(microTwistScore,Math.max(coarseTwistScore,bendEnergyScore)+18);
    const twistScore=Math.min(100, Math.max(coarseTwistScore, corroboratedMicroTwist, bendEnergyScore));

    // Acceleration/rhythm scoring. The previous implementation only counted
    // distances between sharp >20° corner nodes inside a single OSM way, which
    // made flowing roads score 0 even when they clearly had repeated bend/short
    // straight/bend rhythm. This clusters small bend events first, then rewards
    // usable straights between bend clusters.
    const bendClusters=[];
    if(!reason && bendEvents.length){
      for(const ev of bendEvents){
        const last=bendClusters[bendClusters.length-1];
        if(last && ev.dist - last.endDist <= 140){
          last.endDist = ev.dist;
          last.sumAngle += ev.angle;
          last.maxAngle = Math.max(last.maxAngle, ev.angle);
          last.count++;
        } else {
          bendClusters.push({startDist:ev.dist,endDist:ev.dist,sumAngle:ev.angle,maxAngle:ev.angle,count:1});
        }
      }
    }
    const meaningfulBendClusters = bendClusters.filter(c => c.sumAngle >= 14 || c.maxAngle >= 10 || c.count >= 3);
    let accelRhythmRaw = 0;
    let accelStraightCount = 0;
    for(let i=1;i<meaningfulBendClusters.length;i++){
      const prev = meaningfulBendClusters[i-1];
      const curr = meaningfulBendClusters[i];
      const gap = curr.startDist - prev.endDist;
      if(gap >= 80 && gap <= 900){
        accelStraightCount++;
        const gapScore = gap <= 450 ? 1 : Math.max(0.35, 1 - ((gap - 450) / 650));
        const bendWeight = Math.min(1.45, (prev.sumAngle + curr.sumAngle) / 60);
        accelRhythmRaw += 2.5 * gapScore * Math.max(0.55, bendWeight);
      }
    }
    const bendEnergyPerKm = turnSum / km;
    const continuousBendBonus = Math.min(5, Math.max(0, (bendEnergyPerKm - 22) / 9));
    const clusterDensityBonus = Math.min(3, meaningfulBendClusters.length * 0.28);
    const speedSuitability = speed >= 60 ? 1 : speed >= 50 ? 0.78 : speed >= 40 ? 0.52 : 0.22;
    const lengthSuitability = km >= 1 ? 1 : Math.max(0.45, km);
    const accelRhythmScore = Math.min(15, Math.round((accelRhythmRaw + continuousBendBonus + clusterDensityBonus) * speedSuitability * lengthSuitability));
    accelZones = accelStraightCount;
    // cornerScore removed, merged into twistScore. The score now also counts small
    // continuous heading changes so flowing roads with lots of gentle bends are not
    // mistaken for straight roads.
    // Roads above 500m score well, below 500m heavily penalized
    // 0.5km = 50 score, 1km = 100 score
    // Require longer roads to max out length score (2.8km instead of 1km) to create more variance
    const lengthScore=Math.min(100, (totalLen / 2800) * 100);
    const highwayType = el.tags?.highway || '';
    const effectiveSpeedForScore = speed;
    const velocity=RF.drivingPaceScore?RF.drivingPaceScore(speed):Math.min(100,(Math.min(speed,60)/60)*100);
    const techPenalty=highwayType.includes('_link')?100:0;
    // Missing OSM metadata should reduce confidence, not bury an otherwise excellent
    // road. Keep a small score penalty, with the stronger uncertainty signal shown
    // separately through data confidence.
    const estPenalty = speedIsEstimated ? 6 : 0;
    const unnamedPenalty = getRoadName(el.tags).includes('Unnamed') ? 8 : 0;

    let sceneryPts=0;
    let scenicHits=0;
    let scenicCoverage=0;
    let scenicFeatureCount=0;
    // Scenery checks. Reward scenery that persists along the road, not repeated
    // samples of the same single feature around one point.
    if(!reason) {
      const step = Math.max(1, Math.floor(pts.length / 12));
      const samplePts = [];
      for(let i=0; i<pts.length; i+=step) samplePts.push(pts[i]);
      if(!samplePts.includes(pts[pts.length-1])) samplePts.push(pts[pts.length-1]);

      let bestLandmark = 0, bestWater = 0, bestCoast = 0, bestPark = 0, bestGreen = 0, bestOpen = 0;
      let scenicSamples = 0;
      const uniqueFeatures = new Set();

      for(const p of samplePts){
        const gx = Math.floor(p.lon / 0.02);
        const gy = Math.floor(p.lat / 0.02);
        const pLat = p.lat, pLon = p.lon;
        let sampleBest = 0;

        for(let dx=-1; dx<=1; dx++){
          for(let dy=-1; dy<=1; dy++){
            const k = `${gx+dx},${gy+dy}`;
            const cell = sceneryGrid.get(k);
            if(!cell) continue;
            for(const sc of cell){
              const d = fastDistRaw(pLat, pLon, sc.lat, sc.lon);
              let ptsAwarded = 0;
              if(d <= 150) ptsAwarded = sc.weight;
              else if(d <= 400) ptsAwarded = sc.weight * 0.7;
              else if(d <= 900) ptsAwarded = sc.weight * 0.4;
              else if(d <= 1500) ptsAwarded = sc.weight * 0.2;
              if(ptsAwarded <= 0) continue;
              sampleBest=Math.max(sampleBest,ptsAwarded);
              if(sc.featureId)uniqueFeatures.add(sc.featureId);
              if(sc.cat === 'landmark') bestLandmark = Math.max(bestLandmark,ptsAwarded);
              if(sc.cat === 'water') bestWater = Math.max(bestWater,ptsAwarded);
              if(sc.cat === 'coast') bestCoast = Math.max(bestCoast,ptsAwarded);
              if(sc.cat === 'park') bestPark = Math.max(bestPark,ptsAwarded);
              if(sc.cat === 'green') bestGreen = Math.max(bestGreen,ptsAwarded);
              if(sc.cat === 'open') bestOpen = Math.max(bestOpen,ptsAwarded);
            }
          }
        }
        if(sampleBest>=1.4)scenicSamples++;
      }

      bestLandmark = Math.min(7, bestLandmark);
      bestWater = Math.min(7, bestWater);
      bestCoast = Math.min(7, bestCoast);
      bestPark = Math.min(5, bestPark);
      bestGreen = Math.min(4, bestGreen);
      bestOpen = Math.min(3, bestOpen);
      scenicCoverage = samplePts.length ? scenicSamples / samplePts.length : 0;
      scenicFeatureCount = uniqueFeatures.size;
      scenicHits = scenicFeatureCount;
      const coverageBonus = Math.min(5, scenicCoverage * 5);
      const varietyBonus = Math.min(3, Math.max(0, scenicFeatureCount - 1) * 0.55);
      sceneryPts = Math.min(20, bestLandmark + Math.max(bestWater,bestCoast) + bestPark + Math.max(bestGreen,bestOpen) + coverageBonus + varietyBonus);
    }

    // Dual-path scoring:
    // 1) Technical score rewards bends, usable length, rhythm, pace and scenery.
    // 2) Flow score lets genuinely enjoyable rural A/B roads qualify without
    //    allowing fast-but-boring roads to rank as exceptional.
    const accelBonus = accelRhythmScore;
    const qualityPenalty=(roadQuality.penalty||0)+(roadQuality.confidencePenalty||0);
    const urbanPenalty=Math.round(Math.max(0,urbanExposure-0.15)*30);
    const penaltyTotal=techPenalty+estPenalty+unnamedPenalty+qualityPenalty+urbanPenalty;
    const lengthMultiplier = totalLen < 200 ? 0 : totalLen < 500 ? 0.4 + 0.6 * ((totalLen - 200) / 300) : 1;
    const laneCount=Number(String(el.tags?.lanes||'').match(/\d+(?:\.\d+)?/)?.[0]||0);
    const oneWay=['yes','1','true'].includes(String(el.tags?.oneway||'').toLowerCase());
    const isLikelyDual=(el.tags?.dual_carriageway === 'yes') || (oneWay && laneCount>=2 && ['trunk','primary'].includes(highwayType));
    const isMotorwayOrDual = highwayType === 'motorway' || highwayType === 'motorway_link' || isLikelyDual;
    const sceneryScore = Math.min(100, (sceneryPts / 20) * 100);
    const surfaceKnownGood=['asphalt','paved','concrete'].includes(String(el.tags?.surface||'').toLowerCase()) && !['bad','very_bad','horrible','very_horrible','impassable'].includes(String(el.tags?.smoothness||'').toLowerCase());
    const scoreParts=RF.drivingRoadScore?RF.drivingRoadScore({
      twistScore,lengthScore,paceScore:velocity,accelRhythmScore,sceneryScore,sceneryPts,
      penaltyTotal,highwayType,urbanExposure,speedMph:speed,totalLen,isMotorwayOrDual,
      lengthMultiplier,surfaceKnownGood,reason
    }):{
      score:Math.max(0,Math.min(100,Math.round((velocity*.13)+(twistScore*.42)+(lengthScore*.17)+(sceneryScore*.15)-penaltyTotal))),
      technicalBaseScore:0,technicalScore:0,flowCandidate:false,flowBaseScore:0,flowScore:0,scoringMode:'technical',
      classBonus:0,ruralFitBonus:0,surfaceBonus:0,paceScore:Math.round(velocity),rhythmScore:Math.round(accelRhythmScore/15*100)
    };
    const {technicalBaseScore,technicalScore,flowCandidate,flowBaseScore,flowScore,scoringMode}=scoreParts;
    const flowClassBonus=scoreParts.classBonus||0;
    const baseScore = scoringMode === 'flow' ? flowBaseScore : technicalBaseScore;
    let score = scoreParts.score;

    // Strict culling: clean out unsuitable roads after scoring.
    if(!reason&&isMotorwayOrDual) reason='Motorway/dual carriageway not prioritised for driving-road discovery';
    if(!reason&&highwayType.includes('_link')) reason='Junction/link road not suitable for driving-road discovery';
    if(!reason&&speed<=30&&twistScore<35) reason='Low-speed road lacks enough driving interest';
    if(!reason&&urbanExposure>=0.60&&twistScore<45) reason='Mostly urban road lacks enough driving interest';
    else if(!reason&&isUrban&&speed<=50&&twistScore<25) reason='Urban/slow road lacks twists';
    const roadCoords=pts.map(p=>[p.lat,p.lon]);const sourceWayIds=[...new Set((d.graphWays||[]).map(w=>w.wayId).filter(Boolean))],roadName=getRoadName(el.tags);
    const evidence=RF.roadDataConfidence?RF.roadDataConfidence(el.tags||{},{speedIsEstimated,geometryPoints:nPts,urbanSamples:urbanSamples.length,confidencePenalty:roadQuality.confidencePenalty||0}):{score:55,label:'Medium',missing:[]};
    const confidence=Math.max(20,Math.min(98,Math.round(evidence.score-(urbanExposure>0.5?4:0))));
    const confidenceLabel=RF.confidenceLabel?RF.confidenceLabel(confidence):evidence.label;
    const obj={
      id:RF.stableRoadId?RF.stableRoadId({sourceWayIds,ref:el.tags?.ref,name:roadName,coords:roadCoords}):`road:${id++}`,name:roadName,ref:el.tags?.ref,sourceWayIds,graphWays:d.graphWays||[],tags:{...(el.tags||{})},
      coords:roadCoords,score,confidence,confidenceLabel,
      twists:Math.round(twistScore), twistScore:Math.round(twistScore),
      speedMph:speed, speedIsEstimated:speedIsEstimated, scenery:Math.round((sceneryPts/20)*100), scenicCoverage:Math.round(scenicCoverage*100),
      len:(totalLen/1000).toFixed(1),
      tier:reason?'excluded':(score>=70?'tier1':score>=50?'tier2':score>=30?'tier3':'tier4'),
      reason,
      debug: { penalties: Math.round(penaltyTotal || 0),
        highway: highwayType || 'none',
        maxspeedTag: el.tags?.maxspeed || 'none',
        totalLen, speed, effectiveSpeedForScore, isUrban, urbanExposure, twists, accelZones, accelRhythmScore, accelStraightCount, bendClusters: meaningfulBendClusters.length, 
         twistScore, coarseTwistScore, microTwistScore, bendEnergyScore, microTwistCount, turnSum, maxTurnAngle, lengthScore, velocity,
        twistContribution: Math.round(twistScore * 0.42),
        lengthContribution: Math.round(lengthScore * 0.17),
        speedContribution: Math.round(velocity * 0.13),
        rhythmContribution: Math.round((scoreParts.rhythmScore||0) * 0.13),
        sceneryContribution: Math.round(sceneryScore * 0.15),
        accelBonus: Math.round(accelBonus),
        lengthMultiplier,
        rawScore: score,
        scoringMode,
        technicalBaseScore, technicalScore,
        flowCandidate, flowBaseScore, flowScore, flowClassBonus, sceneryScore, classBonus:scoreParts.classBonus||0, ruralFitBonus:scoreParts.ruralFitBonus||0, surfaceBonus:scoreParts.surfaceBonus||0, rhythmScore:scoreParts.rhythmScore||0,
        techPenalty, estPenalty, unnamedPenalty, qualityPenalty, urbanPenalty, qualityFlags:roadQuality.flags||[], sceneryPts, scenicHits, scenicCoverage, scenicFeatureCount, evidenceConfidence:confidence, evidenceMissing:evidence.missing||[], baseScore, isMotorwayOrDual,
        nodes: pts.length
      }
    };
    allProcessed.push(obj);
    if(reason) excluded.push(obj); else roads.push(obj);
  }
  // Bucket roads by name/ref to avoid O(N²) comparisons across all roads.
  // Most roads have unique names so this collapses to near-O(N).
  const nameBuckets = new Map();
  const refBuckets = new Map();
  for(let i=0; i<roads.length; i++){
    const r = roads[i];
    if(!r) continue;
    if(r.name && r.name !== 'Unnamed Road'){
      if(!nameBuckets.has(r.name)) nameBuckets.set(r.name, []);
      nameBuckets.get(r.name).push(i);
    }
    if(r.ref){
      if(!refBuckets.has(r.ref)) refBuckets.set(r.ref, []);
      refBuckets.get(r.ref).push(i);
    }
  }
  // Build candidate pair list (each road i → set of j>i that share name or ref)
  const candidates = new Map(); // i -> Set of j
  const addPair = (i, j) => {
    if(i === j) return;
    const [a, b] = i < j ? [i, j] : [j, i];
    if(!candidates.has(a)) candidates.set(a, new Set());
    candidates.get(a).add(b);
  };
  for(const arr of nameBuckets.values()){
    if(arr.length < 2) continue;
    for(let a=0; a<arr.length; a++) for(let b=a+1; b<arr.length; b++) addPair(arr[a], arr[b]);
  }
  for(const arr of refBuckets.values()){
    if(arr.length < 2) continue;
    for(let a=0; a<arr.length; a++) for(let b=a+1; b<arr.length; b++) addPair(arr[a], arr[b]);
  }

  let merged = true;
  while(merged) {
    merged = false;
    for(const [i, jSet] of candidates) {
      if(!roads[i]) { candidates.delete(i); continue; }
      for(const j of jSet) {
        if(!roads[j]) { jSet.delete(j); continue; }

        const A = roads[i].coords;
        const B = roads[j].coords;
        const aSLat=A[0][0], aSLon=A[0][1];
        const aELat=A[A.length-1][0], aELon=A[A.length-1][1];
        const bSLat=B[0][0], bSLon=B[0][1];
        const bELat=B[B.length-1][0], bELon=B[B.length-1][1];

        // fastDistRaw is sufficient here - we only care if <200m
        const dist_aE_bS = fastDistRaw(aELat, aELon, bSLat, bSLon);
        const dist_aE_bE = fastDistRaw(aELat, aELon, bELat, bELon);
        const dist_aS_bE = fastDistRaw(aSLat, aSLon, bELat, bELon);
        const dist_aS_bS = fastDistRaw(aSLat, aSLon, bSLat, bSLon);

        let match = false;
        let newCoords = null;

        if(dist_aE_bS < 200) { newCoords = [...A, ...B.slice(dist_aE_bS<1.5 ? 1 : 0)]; match = true; }
        else if(dist_aE_bE < 200) { newCoords = [...A, ...[...B].reverse().slice(dist_aE_bE<1.5 ? 1 : 0)]; match = true; }
        else if(dist_aS_bE < 200) { newCoords = [...B, ...A.slice(dist_aS_bE<1.5 ? 1 : 0)]; match = true; }
        else if(dist_aS_bS < 200) { newCoords = [...[...A].reverse(), ...B.slice(dist_aS_bS<1.5 ? 1 : 0)]; match = true; }

        if(match) {
          const l1 = parseFloat(roads[i].len), l2 = parseFloat(roads[j].len);
          const tL = l1 + l2;
          if(tL > 0) {
            const nScore = Math.round((roads[i].score * l1 + roads[j].score * l2) / tL);
            const keepI = l1 >= l2;
            roads[i] = {
              ...roads[i],
              name: keepI ? roads[i].name : roads[j].name,
              ref: roads[i].ref || roads[j].ref,
              coords: newCoords,
              len: tL.toFixed(1),
              score: nScore,
              twists: Math.round((roads[i].twists * l1 + roads[j].twists * l2) / tL),
              twistScore: Math.round(((roads[i].twistScore||roads[i].twists||0) * l1 + (roads[j].twistScore||roads[j].twists||0) * l2) / tL),
              
              scenery: Math.round(((roads[i].scenery||0) * l1 + ((roads[j].scenery||0) * l2)) / tL),
              speedMph: Math.max(roads[i].speedMph||0, roads[j].speedMph||0),sourceWayIds:[...new Set([...(roads[i].sourceWayIds||[]),...(roads[j].sourceWayIds||[])])],graphWays:[...(roads[i].graphWays||[]),...(roads[j].graphWays||[])],
              tier: nScore >= 70 ? 'tier1' : nScore >= 50 ? 'tier2' : nScore >= 30 ? 'tier3' : 'tier4'
            };roads[i].id=RF.stableRoadId?RF.stableRoadId(roads[i]):roads[i].id;
          }
          roads[j] = null;
          // Transfer j's pairs into i's bucket so they can still merge with i
          if(candidates.has(j)){
            for(const k of candidates.get(j)) if(k !== i && roads[k]) jSet.add(k);
            candidates.delete(j);
          }
          jSet.delete(j);
          merged = true;
          break;
        }
      }
    }
  }
  const finalRoads = roads.filter(Boolean);
  finalRoads.sort((a,b)=>(b.score-a.score)||((b.confidence||0)-(a.confidence||0))||((b.scenery||0)-(a.scenery||0))||(parseFloat(b.len||0)-parseFloat(a.len||0)));
  return{roads:finalRoads,excluded:excluded.sort((a,b)=>b.score-a.score),allProcessed};
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function renderDebugSearchResults(query) {
  if (!els.debugSearchResults) return;
  const q = (query || '').trim().toLowerCase();

  if (!state.debugMode || !q) {
    els.debugSearchResults.innerHTML = '';
    renderResults();
    return;
  }

  const matches = (state.allProcessedRoads || [])
    .filter(r => (r.name || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const an = (a.name || '').localeCompare(b.name || '');
      if (an !== 0) return an;
      return (b.score || 0) - (a.score || 0);
    }).slice(0, 50);

  roadLayers.clearLayers();
  state.polylines = [];
  els.results.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px;text-align:center;">Showing debug search results on map.<br><br>Clear search to return to normal list.</div>';

  if (!matches.length) {
    els.debugSearchResults.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 2px;">No matching processed roads.</div>';
    return;
  }

  let bounds = L.latLngBounds([]);
  for (const road of matches) {
      if (road.coords && road.coords.length) {
          const color = road.reason ? '#b91c1c' : '#16a34a'; // Red for excluded, Green for valid
          const weight = road.reason ? 4 : 6;
          const poly = L.polyline(road.coords, {color, weight, opacity: 0.8}).addTo(roadLayers);
          poly.on('click', () => selectDebugRoadByName(road.id));
          road.coords.forEach(c => bounds.extend(c));
      }
  }
  if (bounds.isValid()) smoothFitBounds(bounds, {padding: [50, 50], maxZoom: 14, duration: 0.45});

  const frag = document.createDocumentFragment();
  for (const road of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.debugRoadId = String(road.id);
    btn.className = 'debug-search-result-btn';
    btn.innerHTML = `
      <div style="font-weight:700;color:var(--text);">${escapeHtml(road.name || 'Unnamed Road')}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px;">
        Tier: ${escapeHtml(road.tier)} &middot; Score: ${escapeHtml(road.score)} &middot; Speed: ${escapeHtml(road.speedMph)} mph<br>
        <span style="color:${road.reason?'#b91c1c':'#16a34a'};font-weight:600;">${escapeHtml(road.reason || 'Valid road')}</span>
      </div>`;
    btn.addEventListener('click', () => selectDebugRoadByName(road.id));
    frag.appendChild(btn);
  }
  els.debugSearchResults.innerHTML = '';
  els.debugSearchResults.appendChild(frag);
}

function selectDebugRoadByName(id) {
  const road = (state.allProcessedRoads || []).find(r => String(r.id) === String(id));
  if (!road) return;

  

  // Otherwise, render a standalone debug card
  const panel = els.results;
  if (!panel) return;

  const isExcluded = !!road.reason;
  const themeColor = isExcluded ? '#b91c1c' : '#16a34a';
  const badgeBg = isExcluded ? '#fee2e2' : '#dcfce7';
  const badgeBorder = isExcluded ? '#fca5a5' : '#86efac';

  // Instead of clearing all layers (which hides the other search results),
  // we could just draw a prominent highlight over it, but clearing keeps the map clean for deep inspection.
  roadLayers.clearLayers();
  state.polylines = [];

  // Center map on it
  if (road.coords && road.coords.length) {
    const lats = road.coords.map(c=>c[0]), lons = road.coords.map(c=>c[1]);
    const b = [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
    smoothFitBounds(b, {padding:[50,50], maxZoom:14, duration:0.65});

    // Draw background highlight
    L.polyline(road.coords, {color: themeColor, weight:12, opacity:0.3}).addTo(roadLayers);
    // Draw core line
    L.polyline(road.coords, {color: themeColor, weight:4, opacity:1.0}).addTo(roadLayers);
  }

  const safeRoadName = escapeHtml(road.name || 'Unnamed Road');
  const safeRoadTier = escapeHtml(road.tier);
  const safeRoadScore = escapeHtml(road.score);
  const safeRoadSpeed = escapeHtml(road.speedMph);
  const safeReason = escapeHtml(road.reason || '');

  panel.innerHTML = `
    <div style="padding:16px 24px;">
      <button type="button" data-debug-back="true" style="margin-bottom:16px;color:var(--brand);font-weight:600;font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Back to search
      </button>
      <div class="road-card selected" style="border:2px solid ${themeColor};box-shadow:var(--shadow-md);">
        <div class="road-top" style="align-items:flex-start; margin-bottom:12px;">
          <div style="flex-grow:1;">
            <h3 class="road-name" style="color:${themeColor};">${safeRoadName} <span style="font-size:11px;font-weight:600;color:var(--muted);background:${badgeBg};padding:2px 6px;border-radius:4px;border:1px solid ${badgeBorder};">Debug View</span></h3>
            <div class="road-meta">${safeRoadTier} &middot; Score ${safeRoadScore} &middot; ${safeRoadSpeed} mph</div>
          </div>
        </div>
        ${road.reason ? `<div class="debug-reason" style="display:block;margin-top:0;padding-top:0;border:none;">Excluded: ${safeReason}</div>` : ''}
        ${road.debug ? `
          <div class="debug-panel" style="display:block;font-size:11px;background:#f1f5f9;padding:10px;border-radius:6px;margin-top:12px;border:1px solid #cbd5e1;color:#475569;line-height:1.6;font-family:monospace;text-align:left;">
            <div style="font-weight:700;margin-bottom:6px;color:#0f172a;font-family:var(--font-body);">🛠 Processing & Scoring Debug</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
              <div><b>HW:</b> ${road.debug.highway}</div>
              <div><b>Tag:</b> ${road.debug.maxspeedTag}</div>
              <div><b>Spd:</b> ${road.debug.speed} mph</div>
              <div><b>Urban:</b> ${road.debug.isUrban}</div>
              <div><b>Nodes:</b> ${road.debug.nodes}</div>
              <div><b>Motor/Dual:</b> ${road.debug.isMotorwayOrDual}</div>
              <div><b>Crnrs:</b> ${road.debug.twists}</div>
              <div><b>Rhythm:</b> ${road.debug.accelBonus}/15</div>
            </div>
            <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #cbd5e1;display:grid;grid-template-columns:1fr 1fr;gap:4px;">
              <div><b>v-scr:</b> ${road.debug.velocity.toFixed(1)}</div>
              
              
              <div><b>l-scr:</b> ${road.debug.lengthScore.toFixed(1)}</div>
              <div style="color:var(--brand-dark)"><b>tech-pen:</b> -${road.debug.techPenalty}</div>
              <div style="color:var(--brand-dark)"><b>est-pen:</b> -${road.debug.estPenalty}</div>
            </div>
            <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #cbd5e1;font-weight:bold;color:#0f172a;">
              Base: ${road.debug.baseScore} &rarr; Final: ${road.score}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
  panel.querySelector('[data-debug-back="true"]')?.addEventListener('click', () => {
    if(els.debugSearchInput && els.debugSearchInput.value) renderDebugSearchResults(els.debugSearchInput.value);
    else renderResults();
  });
}


function getRoadScoreParts(road) {
  const d = road?.debug || {};
  const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
  const twistRaw = clamp(Number(d.twistScore ?? road?.twistScore ?? road?.twists ?? 0), 0, 100);
  const lengthRaw = clamp(Number(d.lengthScore ?? 0), 0, 100);
  const paceRaw = clamp(Number(d.velocity ?? d.paceScore ?? 0), 0, 100);
  const rhythmRaw = clamp(Number(d.rhythmScore ?? ((d.accelRhythmScore || 0) / 15 * 100)), 0, 100);
  const sceneryRaw = clamp(Number(d.sceneryScore ?? road?.scenery ?? 0), 0, 100);
  const penalties = clamp(Number(d.penalties ?? 0), 0, 200);
  const lengthMultiplier = Number.isFinite(Number(d.lengthMultiplier)) ? Number(d.lengthMultiplier) : 1;
  const scoringMode = d.scoringMode || 'technical';
  const isFlow = scoringMode === 'flow';
  const twistMax = isFlow ? 14 : 42;
  const lengthMax = isFlow ? 15 : 17;
  const paceMax = isFlow ? 28 : 13;
  const rhythmMax = 13;
  const sceneryMax = isFlow ? 22 : 15;
  const twistPts = Math.round(twistRaw * twistMax / 100);
  const lengthPts = Math.round(lengthRaw * lengthMax / 100);
  const pacePts = Math.round(paceRaw * paceMax / 100);
  const rhythmPts = Math.round(rhythmRaw * rhythmMax / 100);
  const sceneryPts = Math.round(sceneryRaw * sceneryMax / 100);
  const classBonus = Number(d.classBonus ?? d.flowClassBonus ?? 0) || 0;
  const ruralFitBonus = Number(d.ruralFitBonus ?? 0) || 0;
  const surfaceBonus = Number(d.surfaceBonus ?? 0) || 0;
  const roadFitBonus = Math.round(classBonus + ruralFitBonus + surfaceBonus);
  const technicalScore = Number.isFinite(Number(d.technicalScore)) ? Math.round(Number(d.technicalScore)) : null;
  const flowScore = Number.isFinite(Number(d.flowScore)) ? Math.round(Number(d.flowScore)) : null;
  const baseScore = Number.isFinite(Number(d.baseScore)) ? Math.round(Number(d.baseScore)) : Math.round(pacePts + twistPts + lengthPts + rhythmPts + sceneryPts + roadFitBonus - penalties);
  return {
    scoringMode,
    twistRaw: Math.round(twistRaw), twistPts, twistMax,
    lengthRaw: Math.round(lengthRaw), lengthPts, lengthMax,
    paceRaw: Math.round(paceRaw), pacePts, paceMax,
    rhythmRaw: Math.round(rhythmRaw), rhythmPts, rhythmMax,
    sceneryRaw: Math.round(sceneryRaw), sceneryPts, sceneryMax,
    classBonus: Math.round(classBonus), ruralFitBonus: Math.round(ruralFitBonus), surfaceBonus: Math.round(surfaceBonus), roadFitBonus,
    penalties: Math.round(penalties),
    baseScore,
    technicalScore,
    flowScore,
    lengthMultiplier,
    confidence: Math.round(Number(road?.confidence||d.evidenceConfidence||55)),
    confidenceLabel: road?.confidenceLabel || (RF.confidenceLabel?RF.confidenceLabel(Number(road?.confidence||d.evidenceConfidence||55)):'Medium'),
    urbanExposure: Math.round(Math.max(0,Math.min(1,Number(d.urbanExposure||0)))*100),
    scenicCoverage: Math.round(Math.max(0,Math.min(1,Number(d.scenicCoverage||0)))*100),
    evidenceMissing: Array.isArray(d.evidenceMissing)?d.evidenceMissing:[]
  };
}

function renderRoadScoreControl(road) {
  const p = getRoadScoreParts(road);
  const modeLabel = p.scoringMode === 'flow' ? 'Flow score' : 'Technical road score';
  const fitText = p.roadFitBonus !== 0 ? `<div class="score-tooltip-row"><span>Road fit</span><strong>${p.roadFitBonus > 0 ? '+' : ''}${p.roadFitBonus}</strong></div>` : '';
  const comparisonText = (p.technicalScore !== null && p.flowScore !== null && p.flowScore > 0)
    ? `<div class="score-tooltip-row muted"><span>Technical / flow</span><strong>${p.technicalScore} / ${p.flowScore}</strong></div>`
    : '';
  const multiplierText = p.lengthMultiplier < 1 && p.scoringMode !== 'flow' ? `<div class="score-tooltip-row muted"><span>Short-road multiplier</span><strong>×${p.lengthMultiplier.toFixed(2)}</strong></div>` : '';
  return `
    <div class="apex-score-control">
      <div class="apex-score-pill" style="background:${getColor(road.score)}">
        <span class="apex-score-number">${road.score}</span>
        <span class="apex-score-label">ROAD</span>
      </div>
      <div class="score-tooltip-wrap">
        <button class="score-help" type="button" aria-label="Show road score breakdown">?</button>
        <div class="score-tooltip" role="tooltip">
          <div class="score-tooltip-title">${modeLabel}</div>
          <div class="score-tooltip-row"><span>Twists</span><strong>${p.twistPts}/${p.twistMax}</strong></div>
          <div class="score-tooltip-row sub"><span>Raw twist strength</span><strong>${p.twistRaw}/100</strong></div>
          <div class="score-tooltip-row"><span>Useful length</span><strong>${p.lengthPts}/${p.lengthMax}</strong></div>
          <div class="score-tooltip-row"><span>Driving pace</span><strong>${p.pacePts}/${p.paceMax}</strong></div>
          <div class="score-tooltip-row sub"><span>Pace quality</span><strong>${p.paceRaw}/100</strong></div>
          <div class="score-tooltip-row"><span>Bend / straight rhythm</span><strong>${p.rhythmPts}/${p.rhythmMax}</strong></div>
          <div class="score-tooltip-row"><span>Scenery</span><strong>${p.sceneryPts}/${p.sceneryMax}</strong></div>
          ${fitText}
          <div class="score-tooltip-row penalty"><span>Penalties</span><strong>-${p.penalties}</strong></div>
          ${multiplierText}
          ${comparisonText}
          <div class="score-tooltip-row muted"><span>Urban exposure</span><strong>${p.urbanExposure}%</strong></div>
          <div class="score-tooltip-row muted"><span>Scenery coverage</span><strong>${p.scenicCoverage}%</strong></div>
          <div class="score-tooltip-row muted"><span>Data confidence</span><strong>${p.confidenceLabel} · ${p.confidence}/100</strong></div>
          ${p.evidenceMissing.length?`<div class="score-tooltip-row muted"><span>Missing metadata</span><strong>${escapeHtml(p.evidenceMissing.slice(0,3).join(', '))}</strong></div>`:''}
          <div class="score-tooltip-total"><span>Final score</span><strong>${road.score}/100</strong></div>
        </div>
      </div>
    </div>`;
}


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function escapeJsString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildRoadDiagnosticsPanel(finalFilteredRoads, totalFiltered, cardLimit) {
  if (!state.debugMode || state.currentTab !== 'roads' || !state.hasSearched) return null;

  const all = Array.isArray(state.allProcessedRoads) ? state.allProcessedRoads : [];
  if (!all.length) return null;

  const finalRoadIds = new Set((state.masterRoads || []).map(r => String(r.id)));
  const shownCardIds = new Set((finalFilteredRoads || []).slice(0, cardLimit).map(r => String(r.id)));
  const filteredFinalIds = new Set((finalFilteredRoads || []).map(r => String(r.id)));
  const favIds = state.favs || new Set();
  const pickMap = state._pickMap || new Map();

  const validFinalCount = (state.masterRoads || []).length;
  const excludedCount = (state.excludedRoads || []).length;
  const mergedOrHiddenCount = all.filter(r => !r.reason && !finalRoadIds.has(String(r.id))).length;
  const hiddenByFiltersCount = (state.masterRoads || []).filter(r => {
    if (!state.activeTiers.has(r.tier)) return true;
    if (state.favsOnly && !favIds.has(String(r.id))) return true;
    if (state.picksOnly && !pickMap.has(r.id)) return true;
    return false;
  }).length;
  const hiddenByLimitCount = Math.max(0, totalFiltered - cardLimit);

  const getStatus = (road) => {
    const id = String(road.id);
    if (road.reason) return { label: 'Excluded: ' + road.reason, tone: 'bad' };
    if (!finalRoadIds.has(id)) return { label: 'Processed, then merged into another segment or removed from final cards', tone: 'neutral' };
    if (!state.activeTiers.has(road.tier)) return { label: 'Hidden by road score filter (' + road.tier + ')', tone: 'warn' };
    if (state.favsOnly && !favIds.has(id)) return { label: 'Hidden by Saved-only filter', tone: 'warn' };
    if (state.picksOnly && !pickMap.has(road.id)) return { label: 'Hidden by Top Picks filter', tone: 'warn' };
    if (filteredFinalIds.has(id) && !shownCardIds.has(id)) return { label: 'Valid: on map, card hidden behind Load more', tone: 'warn' };
    if (shownCardIds.has(id)) return { label: 'Visible in results and on map', tone: 'good' };
    return { label: 'Valid, but not currently displayed', tone: 'warn' };
  };

  const toneStyle = {
    good: 'background:#dcfce7;color:#166534;border-color:#86efac;',
    warn: 'background:#fff7ed;color:#9a3412;border-color:#fed7aa;',
    bad: 'background:#fee2e2;color:#991b1b;border-color:#fca5a5;',
    neutral: 'background:#f1f5f9;color:#475569;border-color:#cbd5e1;'
  };

  const rows = [...all]
    .sort((a, b) => {
      const an = String(a.name || '').localeCompare(String(b.name || ''));
      if (an !== 0) return an;
      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, 300)
    .map(road => {
      const status = getStatus(road);
      const d = road.debug || {};
      const highway = d.highway || road.el?.tags?.highway || 'unknown';
      const speed = road.speedMph ? road.speedMph + 'mph' : '—';
      const len = road.len ? road.len + 'km' : '—';
      const name = road.name || road.ref || 'Unnamed Road';
      return '<button type="button" class="diagnostic-road-row" data-debug-road-id="' + escapeHtml(road.id) + '" style="width:100%;text-align:left;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;cursor:pointer;display:flex;gap:10px;justify-content:space-between;align-items:flex-start;">' +
          '<span style="min-width:0;flex:1;">' +
            '<strong style="display:block;color:var(--text);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(name) + '</strong>' +
            '<span style="display:block;color:var(--muted);font-size:12px;margin-top:2px;">' + escapeHtml(highway) + ' · score ' + escapeHtml(road.score) + ' · ' + escapeHtml(road.tier) + ' · ' + escapeHtml(speed) + ' · ' + escapeHtml(len) + '</span>' +
          '</span>' +
          '<span style="flex-shrink:0;max-width:46%;font-size:11px;font-weight:700;border:1px solid;border-radius:999px;padding:4px 8px;line-height:1.2;' + toneStyle[status.tone] + '">' + escapeHtml(status.label) + '</span>' +
        '</button>';
    }).join('');

  return window.RoadFinderUIRenderers.createDiagnosticsPanel({
    processed: all.length,
    valid: validFinalCount,
    excluded: excludedCount,
    filtered: hiddenByFiltersCount,
    merged: mergedOrHiddenCount,
    limitMessage: hiddenByLimitCount > 0 ? `${hiddenByLimitCount} valid roads are currently behind the Load more limit.` : '',
    rowsHtml: rows,
    footer: all.length > 300 ? 'Showing first 300 processed roads alphabetically. Use Debug Mode search above to find a specific road name.' : ''
  }, {
    onSelectRoad: selectDebugRoadByName
  });
}

function createRoadCard(road) {
  const roadId = String(road.id);
  const isExcluded = road.tier === 'excluded';
  const isFavourite = state.favs.has(roadId);
  const start = road.coords[0];
  const end = road.coords[road.coords.length - 1];
  const driveUrl=RF.googleMapsDirectionsUrl?RF.googleMapsDirectionsUrl(road.coords,[],8):'';
  const picks = state._pickMap?.get(road.id) || [];
  const badgesHtml = picks.map((pick, index) => `<span class="${index === 0 ? 'pick-badge' : 'road-pick-badge'}"><span>${escapeHtml(pick.icon)}</span>${escapeHtml(pick.label)}</span>`).join('');

  return window.RoadFinderUIRenderers.createRoadCard({
    id: escapeHtml(roadId),
    name: escapeHtml(road.name || 'Unnamed Road'),
    speed: escapeHtml(road.speedMph ?? ''),
    speedEstimated: Boolean(road.speedIsEstimated),
    length: escapeHtml(road.len ?? ''),
    tierLabel: isExcluded ? 'Excluded' : escapeHtml(getTierLabel(road.score)),
    confidenceLabel: escapeHtml(road.confidenceLabel || (RF.confidenceLabel?RF.confidenceLabel(road.confidence||55):'Medium')),
    accent: isExcluded ? '#9ca3af' : getColor(road.score),
    isExcluded,
    badgesHtml,
    scoreControlHtml: renderRoadScoreControl(road),
    favouriteClass: isFavourite ? 'active' : '',
    favouriteFill: isFavourite ? '#eab308' : 'none',
    favouriteStroke: isFavourite ? '#eab308' : '#94a3b8',
    favouriteLabel: isFavourite ? 'Remove from saved' : 'Save road',
    startUrl: `https://www.google.com/maps/dir/?api=1&destination=${start[0]},${start[1]}&travelmode=driving`,
    endUrl:driveUrl||`https://www.google.com/maps/dir/?api=1&origin=${start[0]},${start[1]}&destination=${end[0]},${end[1]}&travelmode=driving`
  }, {
    onFavourite: () => toggleFav(road.id),
    onSelect: () => selectItem(road.id, false, false, usesMobileWorkspace()),
    onHover: (active) => setHoveredItem(active ? road.id : null)
  });
}

function exportRouteGpx(route){if(!route||!RF.routeToGpx)return;const xml=RF.routeToGpx(route),safe=String(route.name||'drivehub-route').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase()||'drivehub-route',blob=new Blob([xml],{type:'application/gpx+xml;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${safe}.gpx`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);setStatus('GPX route exported.','success')}

function getRouteKind(route) {
  return (route && (route.routeType === 'a2b' || route.isCircular === false || String(route.id || '').startsWith('A2B'))) ? 'a2b' : 'circular';
}

function ensureRouteTypeFilters() {
  if (!state.routeTypeFilter) state.routeTypeFilter = { circular: true, a2b: true };
  if (typeof state.routeTypeFilter.circular !== 'boolean') state.routeTypeFilter.circular = true;
  if (typeof state.routeTypeFilter.a2b !== 'boolean') state.routeTypeFilter.a2b = true;

  if (!els.filtersSection || document.getElementById('routeTypeFilterWrap')) return;
  const wrap = document.createElement('div');
  wrap.id = 'routeTypeFilterWrap';
  wrap.style.display = 'none';
  wrap.style.margin = '0 0 12px 0';
  wrap.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Route type</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" class="chip" data-route-type="circular" aria-pressed="true">Circular loops</button>
      <button type="button" class="chip" data-route-type="a2b" aria-pressed="true">A-to-B routes</button>
    </div>`;
  els.filtersSection.insertBefore(wrap, els.filtersSection.firstChild);
  wrap.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-route-type]');
    if (!btn) return;
    const type = btn.dataset.routeType;
    const next = { ...state.routeTypeFilter, [type]: !state.routeTypeFilter[type] };
    if (!next.circular && !next.a2b) next[type] = true;
    state.routeTypeFilter = next;
    syncRouteTypeFilterUI();
    renderResults();
    saveAppState();
  });
}

function syncRouteTypeFilterUI() {
  ensureRouteTypeFilters();
  const wrap = document.getElementById('routeTypeFilterWrap');
  if (!wrap) return;
  const show = state.currentTab === 'routes' && state.searchMode !== 'a2b' && state.masterRoutes.length > 0;
  wrap.style.display = show ? 'block' : 'none';
  wrap.querySelectorAll('[data-route-type]').forEach(btn => {
    const type = btn.dataset.routeType;
    const on = state.routeTypeFilter?.[type] !== false;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function sameCoord(a, b) {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 0.000001 && Math.abs(a[1] - b[1]) < 0.000001;
}

function routeCoordKey(c) {
  if (!Array.isArray(c) || c.length < 2) return '';
  return `${Number(c[0]).toFixed(6)},${Number(c[1]).toFixed(6)}`;
}

function routeEdgeKey(a, b) {
  return `${routeCoordKey(a)}>${routeCoordKey(b)}`;
}

function routeSegmentColourScore(seg, route) {
  // The renderer groups by the actual rendered colour, not exact score. That
  // lets adjacent Road Score sections in the same colour band become one continuous
  // line instead of many separate rounded blobs.
  const score = Math.round(seg?.score || route?.score || 0);
  const colour = getColor(score);
  return { score, colour };
}

function routeSegmentStyleKey(seg, route) {
  const { colour } = routeSegmentColourScore(seg, route);
  return `${seg.isGood ? 'good' : 'connector'}:${colour}`;
}

function buildGoodRouteEdgeLookup(route) {
  const lookup = new Map();
  const details = Array.isArray(route.segmentDetails) ? route.segmentDetails : [];

  for (const seg of details) {
    if (!seg || !seg.isGood || !Array.isArray(seg.coords) || seg.coords.length < 2) continue;
    const { score, colour } = routeSegmentColourScore(seg, route);
    for (let i = 0; i < seg.coords.length - 1; i++) {
      const a = seg.coords[i], b = seg.coords[i + 1];
      const data = {
        isGood: true,
        name: seg.name || 'Rated road',
        score,
        colour,
        key: `good:${colour}`
      };
      lookup.set(routeEdgeKey(a, b), data);
      lookup.set(routeEdgeKey(b, a), data);
    }
  }
  return lookup;
}

function getRouteDisplaySegments(route) {
  const routeCoords = (route.coords || []).filter(c => Array.isArray(c) && c.length >= 2).map(c => [c[0], c[1]]);
  if (routeCoords.length < 2) {
    const raw = (route.segmentDetails && route.segmentDetails.length)
      ? route.segmentDetails
      : [{ coords: route.coords, isGood: false, name: route.name, score: route.score }];

    const fallback = [];
    for (const seg of raw) {
      if (!seg || !seg.coords || seg.coords.length < 2) continue;
      const key = routeSegmentStyleKey(seg, route);
      const prev = fallback[fallback.length - 1];
      if (prev && prev.key === key && sameCoord(prev.coords[prev.coords.length - 1], seg.coords[0])) {
        prev.coords.push(...seg.coords.slice(1));
        if (seg.name && !prev.name.includes(seg.name)) prev.name = `${prev.name}, ${seg.name}`;
      } else {
        fallback.push({
          ...seg,
          key,
          coords: seg.coords.map(c => Array.isArray(c) ? [c[0], c[1]] : c),
          score: seg.score || route.score || 0
        });
      }
    }
    return fallback;
  }

  // Build one continuous route from route.coords, then colour each small edge by
  // whether it belongs to one of the rated good-road segments. This avoids the
  // old double-draw approach (full route + overlaid rated sections), keeps the
  // individual Road Score colours, and merges adjacent sections with the same rendered
  // colour into single polylines.
  const goodEdgeLookup = buildGoodRouteEdgeLookup(route);
  const merged = [];

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const a = routeCoords[i];
    const b = routeCoords[i + 1];
    if (sameCoord(a, b)) continue;

    const good = goodEdgeLookup.get(routeEdgeKey(a, b));
    const seg = good || {
      isGood: false,
      name: 'Connector',
      score: 0,
      colour: 'connector',
      key: 'connector:neutral'
    };

    const prev = merged[merged.length - 1];
    if (prev && prev.key === seg.key && sameCoord(prev.coords[prev.coords.length - 1], a)) {
      prev.coords.push(b);
      if (seg.isGood && seg.name && !prev.name.includes(seg.name)) prev.name = `${prev.name}, ${seg.name}`;
      if (seg.isGood) {
        prev._scoreSum = (prev._scoreSum || prev.score || 0) + (seg.score || 0);
        prev._scoreCount = (prev._scoreCount || 1) + 1;
        prev.score = Math.round(prev._scoreSum / prev._scoreCount);
      }
    } else {
      merged.push({
        coords: [a, b],
        isGood: !!seg.isGood,
        name: seg.name || (seg.isGood ? 'Rated road' : 'Connector'),
        score: seg.isGood ? (seg.score || route.score || 0) : 0,
        key: seg.key,
        _scoreSum: seg.isGood ? (seg.score || route.score || 0) : 0,
        _scoreCount: seg.isGood ? 1 : 0
      });
    }
  }

  return merged.filter(seg => seg.coords.length >= 2);
}


function getCurrentSearchSummary(){
  const meta = state.lastSearchMeta || {};
  const location = String(meta.addr || els.addr?.value || '').trim();
  const destination = String(meta.addrTo || els.addrTo?.value || '').trim();
  const radius = Number(meta.distKm || els.dist?.value || 0);
  const whenClock = meta.when ? new Date(meta.when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const whenText = meta.cacheHit ? `Cached${whenClock ? ` · ${whenClock}` : ''}` : whenClock;
  return {
    location: location || 'Search area',
    destination,
    radius: Number.isFinite(radius) && radius > 0 ? radius : null,
    whenText,
    modeLabel: state.currentTab === 'routes' ? (state.searchMode === 'a2b' ? 'A to B drive' : 'Route building') : 'Best roads'
  };
}

function createOverviewCard(config){
  const wrap = document.createElement('section');
  wrap.className = 'results-overview-card';
  wrap.innerHTML = `
    <div class="results-overview-head">
      <div>
        <p class="eyebrow">${escapeHtml(config.kicker || 'Overview')}</p>
        <h3>${escapeHtml(config.title || '')}</h3>
        <p>${escapeHtml(config.copy || '')}</p>
      </div>
      ${config.actionsHtml || ''}
    </div>
    <div class="results-overview-stats">${(config.stats || []).map(stat => `
      <div class="overview-stat">
        <span class="overview-stat__label">${escapeHtml(stat.label)}</span>
        <strong class="overview-stat__value">${escapeHtml(String(stat.value ?? '—'))}</strong>
      </div>`).join('')}</div>
  `;
  wrap.querySelectorAll('[data-switch-tab]').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.switchTab)));
  return wrap;
}

function createSectionHeader(title, subtitle=''){
  const wrap = document.createElement('div');
  wrap.className = 'results-section-heading';
  wrap.innerHTML = `<div><h3>${escapeHtml(title)}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>`;
  return wrap;
}

function createFeaturedRoadCard(road){
  const picks = state._pickMap?.get(road.id) || [];
  const pickText = picks.map(p => `${p.icon} ${p.label}`).join(' · ') || getTierLabel(road.score);
  const confidence = road.confidenceLabel || (RF.confidenceLabel ? RF.confidenceLabel(road.confidence || 55) : 'Medium');
  const wrap = document.createElement('article');
  wrap.className = 'featured-result-card';
  wrap.dataset.itemId = String(road.id);
  wrap.setAttribute('role', 'button');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', `Select ${road.name || 'featured road'}`);
  wrap.innerHTML = `
    <div class="featured-result-card__top">
      <span class="featured-tag">${escapeHtml(pickText)}</span>
      <span class="featured-score">${escapeHtml(String(road.score || 0))}</span>
    </div>
    <h4>${escapeHtml(road.name || 'Unnamed road')}</h4>
    <p>${escapeHtml(`${road.len ?? '—'} km · ${road.speedMph ?? '—'} mph · ${confidence} confidence`)}</p>
    <div class="featured-result-card__actions">
      <button type="button" class="chip featured-action" data-select-road="${escapeHtml(String(road.id))}">Show on map</button>
      <button type="button" class="chip featured-action" data-open-drive="${escapeHtml(String(road.id))}">Open drive</button>
    </div>
  `;
  const selectFeaturedRoad = () => selectItem(road.id, false, false, usesMobileWorkspace());
  wrap.addEventListener('click', (event) => {
    if (event.target.closest('button,a,.apex-score-control,.score-help')) return;
    selectFeaturedRoad();
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectFeaturedRoad();
  });
  wrap.querySelector('[data-select-road]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectItem(road.id, false, false, true);
  });
  wrap.querySelector('[data-open-drive]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const start = road.coords?.[0];
    const end = road.coords?.[road.coords.length - 1];
    if (!start || !end) return;
    const url = RF.googleMapsDirectionsUrl ? RF.googleMapsDirectionsUrl(road.coords, [], 8) : `https://www.google.com/maps/dir/?api=1&origin=${start[0]},${start[1]}&destination=${end[0]},${end[1]}&travelmode=driving`;
    window.open(url, '_blank', 'noopener');
  });
  return wrap;
}

function createFeaturedRouteCard(route){
  const routeEvidence = RF.routeConfidence ? RF.routeConfidence(route) : { score: Number(route.routeConfidence || 55), label: 'Medium', ratedRatio: Number(route.driverRoadRatio || 0) };
  const wrap = document.createElement('article');
  wrap.className = 'featured-result-card featured-result-card--route';
  wrap.innerHTML = `
    <div class="featured-result-card__top">
      <span class="featured-tag">${escapeHtml(getRouteKind(route) === 'circular' ? 'Round trip' : 'A to B')}</span>
      <span class="featured-score">${escapeHtml(route.scoreAvailable===false?'—':String(route.score || 0))}</span>
    </div>
    <h4>${escapeHtml(route.name || 'Suggested route')}</h4>
    <p>${escapeHtml(`${route.len ?? '—'} km · ${formatRouteTimeText(route.timeMins)} · ${routeEvidence.label} confidence`)}</p>
    <div class="featured-result-card__actions">
      <button type="button" class="chip featured-action" data-select-route="${escapeHtml(String(route.id))}">Show on map</button>
      <button type="button" class="chip featured-action" data-open-route="${escapeHtml(String(route.id))}">Open route</button>
    </div>
  `;
  wrap.querySelector('[data-select-route]')?.addEventListener('click', () => selectItem(route.id, true, false, true));
  wrap.querySelector('[data-open-route]')?.addEventListener('click', () => {
    const start = route.startCoord || route.coords?.[0];
    const end = route.coords?.[route.coords.length - 1];
    if (!start || !end) return;
    const priorityCoords = (route.segmentDetails || []).filter(seg => seg.isGood && Array.isArray(seg.coords) && seg.coords.length).sort((a,b)=>(b.score||0)-(a.score||0)).map(seg=>({coord:seg.coords[Math.floor(seg.coords.length/2)],score:seg.score||0}));
    const url = RF.googleMapsDirectionsUrl ? RF.googleMapsDirectionsUrl(route.coords, priorityCoords, 8) : `https://www.google.com/maps/dir/?api=1&origin=${start[0]},${start[1]}&destination=${end[0]},${end[1]}&travelmode=driving`;
    window.open(url, '_blank', 'noopener');
  });
  return wrap;
}

function ensureRoadResultFiltersAreRenderable() {
  let changed = false;
  const valid = new Set([...state.activeTiers].filter(tier => VALID_ROAD_TIERS.includes(tier)));
  // Repair only genuinely invalid/all-off filter state. Do not automatically
  // widen a valid Top + Exceptional default just because a particular search
  // contains only lower-tier roads: the empty state should invite the user to
  // widen the Road Score filter deliberately.
  if (!valid.size) {
    state.activeTiers = new Set(DEFAULT_ROAD_TIERS);
    changed = true;
  } else if (valid.size !== state.activeTiers.size) {
    state.activeTiers = valid;
    changed = true;
  }

  // A stale Saved-only state is equally confusing on a new area: the raw search
  // succeeds but there is nothing to render. Drop it only when it would hide the
  // entire successful search.
  if (state.favsOnly && (state.masterRoads || []).length && !(state.masterRoads || []).some(road => state.favs.has(String(road.id)))) {
    state.favsOnly = false;
    changed = true;
  }

  if (changed) {
    syncTiersUI();
    syncFilterChipsUI();
    saveAppState();
  }
  return changed;
}

function renderResults(){
  stopSelectionPulse();
  const compactMobileResults = usesMobileWorkspace();
  roadLayers.clearLayers(); state.polylines=[]; state.cardMap.clear(); state.polylineMap.clear(); els.results.innerHTML=''; state.selectedId=null; state.preSelectionView=null; state._pickMap=new Map(); clearNameTooltip();

  // Route-type filters are injected dynamically. Make sure they cannot remain
  // visible when the user switches back to the Roads tab.
  const routeTypeWrap = document.getElementById('routeTypeFilterWrap');
  if (routeTypeWrap && state.currentTab !== 'routes') routeTypeWrap.style.display = 'none';

  if(state.currentTab==='routes'){
    els.filtersSection.hidden=!state.hasSearched && state.currentTab==='routes';
    els.scoringToggle.hidden=true; els.scoringPanel.hidden=true;
    if(!state.hasSearched){ 
      const emptyDesc = (state.currentTab === 'routes' && state.searchMode === 'a2b') 
        ? 'Enter start and end locations to build a route.' 
        : 'Search a location to generate best routes.';
      renderEmpty('No search yet', emptyDesc); 
      syncRouteDistanceControls();



updateCount('Ready'); return; }
    const isA2B = (state.currentTab === 'routes' && state.searchMode === 'a2b');
    ensureRouteTypeFilters();
    syncRouteTypeFilterUI();
    let filtered = state.masterRoutes;
    if (!isA2B) {
      filtered = state.masterRoutes
        .filter(r => state.activeTiers.has(r.tier))
        .filter(r => state.routeTypeFilter[getRouteKind(r)] !== false);
    }
    if(state.favsOnly) filtered = filtered.filter(r=>state.favs.has(String(r.id)));
    filtered.sort((a,b) => {
      const aF = state.favs.has(String(a.id))?1:0;
      const bF = state.favs.has(String(b.id))?1:0;
      if(aF !== bF) return bF - aF;
      if(isA2B){
        const aDirect=String(a.routeProfile||a.name||'').toLowerCase().includes('direct route')?1:0;
        const bDirect=String(b.routeProfile||b.name||'').toLowerCase().includes('direct route')?1:0;
        if(aDirect!==bDirect)return bDirect-aDirect;
      }
      return b.score - a.score;
    });

    if(!state.masterRoutes.length) { 
      if (isA2B) {
        renderEmpty('No routes found','Could not connect these locations. Try nearby start/end points; Road Finder now searches local connector streets automatically.',{actionLabel:'Edit search',onAction:()=>reopenSearchFromState('no-a2b-edit')});
      } else {
        if(state.hasSearched && state.routeDistanceChosen) {
          renderEmpty('No routes found','Try a larger radius — routes need interconnected road loops.',{actionLabel:'Edit search',onAction:()=>reopenSearchFromState('no-loop-edit')});
        } else {
          renderEmpty('Ready to build routes', 'Choose distance and press Update routes.');
        }
      }
      updateCount('0 routes'); 
      return; 
    }
    if(!filtered.length) { renderEmpty('No routes match filters','Enable circular loops or A-to-B routes, or widen the distance range.',{actionLabel:'Edit search',onAction:()=>reopenSearchFromState('route-filter-edit')}); updateCount('0 matching'); return; }

    const summary = getCurrentSearchSummary();
    const modeLabel = state.searchMode === 'a2b' ? 'A to B drive' : 'Route building';
    if (!compactMobileResults) {
      els.results.appendChild(createOverviewCard({
        kicker: 'Route overview',
        title: state.searchMode === 'a2b' && summary.destination ? `${summary.location} → ${summary.destination}` : summary.location,
        copy: state.searchMode === 'a2b' ? 'Road Finder generated multiple route options between your chosen start and destination.' : 'Road Finder generated route ideas from the roads in your current search area.',
        stats: [
          { label: 'Mode', value: modeLabel },
          { label: 'Options', value: `${filtered.length}` },
          { label: 'Loops', value: `${filtered.filter(r => getRouteKind(r) === 'circular').length}` },
          { label: 'Updated', value: summary.whenText || 'Now' }
        ],
        actionsHtml: '<button type="button" class="chip overview-tab-action" data-switch-tab="roads">View roads</button>'
      }));

      const featuredRoutes = filtered.slice(0, 3);
      if (featuredRoutes.length) {
        els.results.appendChild(createSectionHeader('Best route options', state.searchMode === 'a2b' ? 'Use these as the main shortlist before browsing the full set.' : 'These are the strongest drive ideas from the current area.'));
        const featuredWrap = document.createElement('div');
        featuredWrap.className = 'featured-results-grid';
        featuredRoutes.forEach(route => featuredWrap.appendChild(createFeaturedRouteCard(route)));
        els.results.appendChild(featuredWrap);
      }

      els.results.appendChild(createSectionHeader('All route options', 'Every generated route option is listed below.'));
    }

    const seenLabels = new Set();
    const fragment = document.createDocumentFragment();
    let renderIndex = 0;
    for(const route of filtered){
      for(const seg of getRouteDisplaySegments(route)){
        const segRoad={score:seg.score||route.score,connector:!seg.isGood,isExcluded:false,name:seg.name,isRouteSegment:true};
        // Keep route geometry continuous. Route type is now communicated in the
        // card label/filter, not via dashed map strokes, because dash patterns
        // made same-colour sections look like disconnected blobs on mobile.
        const dashPattern = null;

        const outerStroke = getRoadStrokeStyle(segRoad,false);
        if(dashPattern) outerStroke.dashArray = dashPattern;
        const outer=L.polyline(seg.coords, outerStroke).addTo(roadLayers);

        const innerStroke = getRoadInnerStyle(segRoad,false);
        if(dashPattern) innerStroke.dashArray = dashPattern;
        const poly=L.polyline(seg.coords, innerStroke).addTo(roadLayers);
        outer.itemId=route.id; outer.isExcluded=false; outer.inner=false; outer.road=segRoad;
        poly.itemId=route.id; poly.isExcluded=false; poly.inner=true; poly.road=segRoad;
        outer.on('click',()=>selectItem(route.id,true,true));
        poly.on('click',()=>selectItem(route.id,true,true));
        outer.on('mouseover',()=>setHoveredItem(route.id, true)); poly.on('mouseover',()=>setHoveredItem(route.id, true));
        outer.on('mouseout',()=>setHoveredItem(null)); poly.on('mouseout',()=>setHoveredItem(null));
        state.polylines.push(outer, poly);
        if(!state.polylineMap.has(String(route.id))) state.polylineMap.set(String(route.id), []);
        state.polylineMap.get(String(route.id)).push(outer, poly);
        // Suppress individual segment labels for routes, we will draw one route-level label below
        const isRoutesTab = state.currentTab === 'routes';
        if(!isRoutesTab) {
          const mid = seg.coords[Math.floor(seg.coords.length/2)];
          if(mid && seg.name && !seg.name.startsWith('Unnamed') && !seg.name.match(/^(Primary|Secondary|Tertiary|Unclassified|Residential|Trunk|Service|Track|Path)[\s\w]*$/i)) {
            const labelKey = `${seg.name}_${mid[0].toFixed(3)}_${mid[1].toFixed(3)}`;
            if(!seenLabels.has(labelKey)) {
              seenLabels.add(labelKey);
              const tt = L.tooltip({permanent:true, direction:'center', className:'road-label-overlay', interactive:false, opacity:0.85})
                .setLatLng(mid)
                .setContent(`<span>${escapeHtml(seg.name)}</span>`)
                .addTo(roadLayers);
              state.polylines.push({ isTooltip: true, tt: tt, routeIds: [route.id], labelKey: labelKey });
            } else {
              const existing = state.polylines.find(p => p.isTooltip && p.labelKey === labelKey);
              if(existing) existing.routeIds.push(route.id);
            }
          }
        }
      }

      // Do not draw route.highlightedRoads as a second overlay. The merged
      // display segments above already carry the Road Score colours; drawing the
      // highlighted roads again creates the separate rounded "blob" effect.

      if(state.currentTab === 'routes' && renderIndex < 5) {
        const midIdx = Math.floor(route.coords.length / 2);
        const mid = route.coords[midIdx];
        if(mid && route.name) {
          const labelKey = `ROUTE_${route.id}`;
          if(!seenLabels.has(labelKey)) {
            seenLabels.add(labelKey);
            const tt = L.tooltip({permanent:true, direction:'center', className:'road-label-overlay', interactive:false, opacity:0.9})
              .setLatLng(mid)
              .setContent(`<span style="font-weight:700;color:var(--brand)">${escapeHtml(route.name)}</span>`)
              .addTo(roadLayers);
            state.polylines.push({ isTooltip: true, tt: tt, routeIds: [route.id], labelKey: labelKey });
          }
        }
      }

      if(state.favs.has(String(route.id))) {
        const center = route.coords[Math.floor(route.coords.length/2)];
        if(center) {
          const ttStar = L.tooltip({permanent:true, direction:'center', className:'road-label-overlay star-only', interactive:false, opacity:1})
            .setLatLng(center)
            .setContent(`<span style="color:#eab308;font-size:24px;text-shadow:0 0 10px rgba(0,0,0,0.5);">★</span>`)
            .addTo(roadLayers);
          state.polylines.push({ isTooltip: true, tt: ttStar, routeIds: [route.id], labelKey: 'STAR_'+route.id });
        }
      }

      const startPt = route.startCoord || route.coords[0];
      const startLat = startPt[0], startLon = startPt[1];
      const endLat = route.coords[route.coords.length-1][0], endLon = route.coords[route.coords.length-1][1];

      const priorityCoords=(route.segmentDetails||[]).filter(seg=>seg.isGood&&Array.isArray(seg.coords)&&seg.coords.length).sort((a,b)=>(b.score||0)-(a.score||0)).map(seg=>({coord:seg.coords[Math.floor(seg.coords.length/2)],score:seg.score||0}));
      const navStartUrl=`https://www.google.com/maps/dir/?api=1&destination=${startLat},${startLon}&travelmode=driving`;
      const navEndUrl=RF.googleMapsDirectionsUrl?RF.googleMapsDirectionsUrl(route.coords,priorityCoords,8):`https://www.google.com/maps/dir/?api=1&origin=${startLat},${startLon}&destination=${endLat},${endLon}&travelmode=driving`;

      const isFavourite = state.favs.has(String(route.id));
      const routeEvidence=RF.routeConfidence?RF.routeConfidence(route):{score:Number(route.routeConfidence||55),label:'Medium',ratedRatio:Number(route.driverRoadRatio||0)};
      const card = window.RoadFinderUIRenderers.createRouteCard({
        id: escapeHtml(String(route.id)),
        name: escapeHtml(route.name || 'Unnamed Route'),
        accent: getColor(route.score),
        kindLabel: getRouteKind(route) === 'circular' ? 'Loop' : 'A-to-B',
        kindDescription: getRouteKind(route) === 'circular' ? 'loop' : 'A-to-B route',
        length: escapeHtml(route.len ?? ''),
        tierLabel: escapeHtml(route.scoreAvailable===false?'Not scored':getTierLabel(route.score)),
        confidenceLabel: escapeHtml(routeEvidence.label),
        coverage: Math.round((routeEvidence.ratedRatio||0)*100),
        goodRoads: Number(route.goodRoads || 0),
        score: escapeHtml(route.scoreAvailable===false?'—':route.score),
        time: formatRouteTime(route.timeMins),
        speed: escapeHtml(formatRouteSpeed(route)),
        favouriteClass: isFavourite ? 'active' : '',
        favouriteFill: isFavourite ? '#eab308' : 'none',
        favouriteStroke: isFavourite ? '#eab308' : '#94a3b8',
        favouriteLabel: isFavourite ? 'Remove from saved' : 'Save route',
        startUrl: navStartUrl,
        routeUrl: navEndUrl,
        reason: escapeHtml(routeRationale(route,routeEvidence)),
        roads: (route.roadDetails || []).map(road => ({
          name: escapeHtml(road.name || 'Unnamed road'),
          isGood: Boolean(road.isGood)
        }))
      }, {
        onFavourite:()=>toggleFav(route.id),onExport:()=>exportRouteGpx(route),
        onSelect: () => selectItem(route.id, true, false, usesMobileWorkspace()),
        onHover: (active) => setHoveredItem(active ? route.id : null)
      });
      card.style.animationDelay = `${Math.min(renderIndex * 0.04, 0.4)}s`;
      state.cardMap.set(String(route.id), card);
      renderIndex++;
      fragment.appendChild(card);
    }
    els.results.appendChild(fragment);

    const shownLoops = filtered.filter(r => getRouteKind(r) === 'circular').length;
    const shownA2B = filtered.filter(r => getRouteKind(r) === 'a2b').length;
    updateCount(`${filtered.length} route${filtered.length!==1?'s':''} · ${shownLoops} loop${shownLoops!==1?'s':''}, ${shownA2B} A-to-B`);

    const bounds=roadLayers.getBounds();
    if(bounds.isValid()){
      if (isMobile()) {
        requestAnimationFrame(() => {
          smoothInvalidateSize();
          requestAnimationFrame(() => {
            try { focusRoadBounds(bounds, { scope: 'results' }); } catch(e){}
            setTimeout(() => {
              setStatus(`Showing ${filtered.length} route${filtered.length!==1?'s':''}.`, 'success');
            }, 300);
          });
        });
      } else {
        focusRoadBounds(bounds, { scope: 'results' });
        setStatus(`Showing ${filtered.length} route${filtered.length!==1?'s':''}.`, 'success');
      }
    } else {
        setStatus(`Showing ${filtered.length} route${filtered.length!==1?'s':''}.`, 'success');
    }

  } else {
    // ROADS TAB
    ensureRoadResultFiltersAreRenderable();
    const tierFiltered = state.masterRoads.filter(r => state.activeTiers.has(r.tier));
    state._pickMap = new Map();

    if (tierFiltered.length > 0) {
       const topOverall = tierFiltered.reduce((a,b) => a.score > b.score ? a : b, tierFiltered[0]);
       
       const topTwist = tierFiltered.reduce((a,b) => (a.twistScore||a.twists||0) > (b.twistScore||b.twists||0) ? a : b, tierFiltered[0]);
       const challengeScore = (r) => {
         const speedBand = Math.max(0, Math.min(1, ((r.speedMph || 0) - 40) / 30));
         const twistBand = Math.max(0, Math.min(1, ((r.twistScore || r.twists || 0) - 20) / 80));
         return speedBand * 0.45 + twistBand * 0.55;
       };
       const topChallenge = tierFiltered.reduce((a,b) => challengeScore(a) > challengeScore(b) ? a : b, tierFiltered[0]);
       const topScenic = tierFiltered.reduce((a,b) => (a.scenery||0) > (b.scenery||0) ? a : b, tierFiltered[0]);

       const pickMap = state._pickMap;
       const addPick = (id, label, icon) => {
         if(!pickMap.has(id)) pickMap.set(id, []);
         pickMap.get(id).push({label, icon});
       };
       addPick(topOverall.id, 'Best road', '🏆');
       
       if(topTwist.id !== topOverall.id) addPick(topTwist.id, 'Biggest twists', '🐍');
       if(topChallenge.id !== topOverall.id && topChallenge.id !== topTwist.id) addPick(topChallenge.id, 'Most technical', '🔥');
       if(topScenic.id !== topOverall.id) addPick(topScenic.id, 'Scenic cruise', '🌲');
    }

    let filtered = tierFiltered;
    if(state.favsOnly) filtered = filtered.filter(r=>state.favs.has(String(r.id)));
    if (state.picksOnly) filtered = filtered.filter(r => state._pickMap && state._pickMap.has(r.id));

    filtered.sort((a,b) => {
      const aF = state.favs.has(String(a.id))?1:0;
      const bF = state.favs.has(String(b.id))?1:0;
      if(aF !== bF) return bF - aF;
      return b.score - a.score;
    });

    const totalFiltered = filtered.length;
    const limit = state.visibleRoadsLimit || 100;
    
    const excToShow=[]; // Debugging is now solely via search
    els.filtersSection.hidden=!state.hasSearched && state.currentTab==='routes';
    const hasR=state.masterRoads.length>0||state.excludedRoads.length>0;
    els.scoringToggle.hidden=!hasR; if(!hasR) els.scoringPanel.hidden=true;
    if(!state.hasSearched){ renderEmpty('No search yet','Try a town, landmark or well-known road.'); syncRouteDistanceControls();



updateCount('Ready'); return; }
    if(!hasR){ renderEmpty('No roads found','Try a larger radius or different location.',{actionLabel:'Edit search',onAction:()=>reopenSearchFromState('no-road-edit')}); updateCount('0 roads'); setStatus('No suitable roads found.','error'); return; }
    if(!filtered.length){ renderEmpty('No roads match filters','Turn on more Road Score bands to see results.',{actionLabel:'Edit filters',onAction:()=>reopenSearchFromState('road-filter-edit')}); updateCount('Filtered'); return; }

    const summary = getCurrentSearchSummary();
    if (!compactMobileResults) {
      els.results.appendChild(createOverviewCard({
        kicker: 'Search overview',
        title: summary.location,
        copy: state.currentTab === 'roads' ? 'These roads are ranked for the current area. Use the featured picks to jump straight into the strongest finds.' : '',
        stats: [
          { label: 'Mode', value: 'Best roads' },
          { label: 'Radius', value: summary.radius ? `${summary.radius} km` : '—' },
          { label: 'Matches', value: `${filtered.length}` },
          { label: 'Updated', value: summary.whenText || 'Now' }
        ],
        actionsHtml: '<button type="button" class="chip overview-tab-action" data-switch-tab="routes">Build a drive</button>'
      }));

      const featuredRoads = filtered.filter(r => state._pickMap?.has(r.id)).slice(0, 3);
      if (featuredRoads.length) {
        els.results.appendChild(createSectionHeader('Featured roads', 'A quick shortlist of the strongest roads in this search.'));
        const featuredWrap = document.createElement('div');
        featuredWrap.className = 'featured-results-grid';
        featuredRoads.forEach(road => {
          const card = createFeaturedRoadCard(road);
          state.cardMap.set(String(road.id), card);
          featuredWrap.appendChild(card);
        });
        els.results.appendChild(featuredWrap);
      }
    }

    // Desktop featured roads are promoted once: they remain on the map but are
    // not duplicated again in the ranked list underneath. Mobile has no separate
    // featured section, so it continues to render the full ranked list.
    const featuredRoadIds = compactMobileResults
      ? new Set()
      : new Set(filtered.filter(r => state._pickMap?.has(r.id)).slice(0, 3).map(r => String(r.id)));
    const rankedListRoads = filtered.filter(r => !featuredRoadIds.has(String(r.id)));
    const rankedListCount = rankedListRoads.length;

    const diagnosticsPanel = buildRoadDiagnosticsPanel(filtered, totalFiltered, limit);
    if (diagnosticsPanel) els.results.appendChild(diagnosticsPanel);

    if (!compactMobileResults && rankedListCount) els.results.appendChild(createSectionHeader('More roads', 'The remaining ranked roads for the current search area.'));
    const fragment = document.createDocumentFragment();
    let renderCount = 0;
    let roadListRenderCount = 0;
    let roadLabelCount = 0;
    for(const road of filtered){
      const isExc=road.tier==='excluded';
      road.isExcluded = isExc;
      const outer=L.polyline(road.coords,getRoadStrokeStyle(road,false)).addTo(roadLayers);
      const poly=L.polyline(road.coords,getRoadInnerStyle(road,false)).addTo(roadLayers);

      const mid = road.coords[Math.floor(road.coords.length/2)];
      const roadIsFeatured = state._pickMap?.has(road.id) || state.favs.has(String(road.id)) || Number(road.score || 0) >= 75;
      if(roadLabelCount < 10 && roadIsFeatured && mid && road.name && !road.name.startsWith('Unnamed') && !road.name.match(/^(Primary|Secondary|Tertiary|Unclassified|Residential|Trunk|Service|Track|Path)[\s\w]*$/i)) {
        roadLabelCount += 1;
        const tt = L.tooltip({permanent:true, direction:'center', className:'road-label-overlay', interactive:false, opacity:0.92})
          .setLatLng(mid)
          .setContent(`<span>${escapeHtml(road.name)}${state.favs.has(String(road.id))?' <span style="color:#d99b13;">★</span>':''}</span>`)
          .addTo(roadLayers);
        state.polylines.push({ isTooltip: true, tt: tt, roadId: road.id });
      }
      outer.itemId=road.id; outer.isExcluded=isExc; outer.inner=false; outer.road=road;
      poly.itemId=road.id; poly.isExcluded=isExc; poly.inner=true; poly.road=road;
      outer.on('click',()=>selectItem(road.id,false,true));
      poly.on('click',()=>selectItem(road.id,false,true));
      outer.on('mouseover',()=>setHoveredItem(road.id, true)); poly.on('mouseover',()=>setHoveredItem(road.id, true));
      outer.on('mouseout',()=>setHoveredItem(null)); poly.on('mouseout',()=>setHoveredItem(null));
      state.polylines.push(outer, poly);
      if(!state.polylineMap.has(String(road.id))) state.polylineMap.set(String(road.id), []);
      state.polylineMap.get(String(road.id)).push(outer, poly);

      renderCount++;
      if (featuredRoadIds.has(String(road.id))) continue;
      roadListRenderCount++;
      if (roadListRenderCount > limit) continue;

      const card = createRoadCard(road);
      card.style.animationDelay = `${Math.min(roadListRenderCount * 0.04, 0.4)}s`;
      state.cardMap.set(String(road.id), card);
      fragment.appendChild(card);
    }
    
    if (rankedListCount > limit) {
      fragment.appendChild(window.RoadFinderUIRenderers.createLoadMoreButton({
        remaining: rankedListCount - limit,
        increment: 50,
        onClick: () => {
          state.visibleRoadsLimit += 50;
          renderResults();
        }
      }));
    }
    els.results.appendChild(fragment);

    // Successful discovery and presentation must stay coupled. Both the cards
    // and the map are generated from the exact same filtered array, so a future
    // regression cannot quietly report roads without presenting them.
    const renderedRoadCards = state.cardMap.size;
    const renderedRoadLayers = roadLayers.getLayers().filter(layer => layer && typeof layer.getLatLngs === 'function').length;
    if (filtered.length && (!renderedRoadCards || !renderedRoadLayers)) {
      console.error('Road Finder presentation invariant failed', { found: filtered.length, renderedRoadCards, renderedRoadLayers });
      renderEmpty('Roads found, display failed', 'Road Finder found roads but could not draw the result set. Reset the filters or run the search again.');
      updateCount(`${filtered.length} found`);
      setStatus('Roads were found, but the display layer failed. Please retry the search.', 'error');
      return;
    }
    

    const bounds=roadLayers.getBounds();
    if(bounds.isValid()){
      if (isMobile()) {
        setTimeout(() => { try { focusRoadBounds(bounds, { scope: 'results' }); } catch(e){} }, MOBILE_WORKSPACE_TRANSITION_MS);
      } else {
        focusRoadBounds(bounds, { scope: 'results' });
      }
    }
    updateCount(`${filtered.length} valid${excToShow.length>0?' + '+excToShow.length+' excl.':''}`);
    setStatus(`Found ${filtered.length} valid road${filtered.length!==1?'s':''}.`,'success');
  }

  // Apply current visibility state after rendering
  updatePolylineVisibility();
}

function parseCoordinateQuery(query){
  const m=String(query||'').trim().match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if(!m)return null;
  const lat=Number(m[1]),lon=Number(m[2]);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return null;
  return{lat,lon,displayName:`${lat.toFixed(5)}, ${lon.toFixed(5)}`};
}

async function fetchJsonTimed(url,signal,timeoutMs=9000){
  const controller=new AbortController();
  let timedOut=false;
  const forwardAbort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)forwardAbort();
  else signal?.addEventListener('abort',forwardAbort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},timeoutMs);
  try{
    const r=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }catch(err){
    if(signal?.aborted)throw new DOMException('Search cancelled.','AbortError');
    if(timedOut){const e=new Error('Location lookup timed out.');e.code='GEOCODE_TIMEOUT';throw e}
    throw err;
  }finally{
    clearTimeout(timer);
    signal?.removeEventListener('abort',forwardAbort);
  }
}

function photonRows(data){
  const features=Array.isArray(data?.features)?data.features:[];
  return features.map(f=>{
    const p=f?.properties||{},coords=f?.geometry?.coordinates||[];
    const cc=String(p.countrycode||p.country_code||'').toLowerCase();
    const country=String(p.country||'').toLowerCase();
    if(cc&&cc!=='gb'&&cc!=='uk')return null;
    if(!cc&&country&&!/(united kingdom|great britain|england|scotland|wales|northern ireland)/i.test(country))return null;
    const parts=[p.name,p.street,p.district,p.city,p.county,p.state,p.postcode,p.country].filter(Boolean);
    return{
      name:p.name||p.city||p.county||'Location',
      display_name:[...new Set(parts.map(String))].join(', '),
      lat:String(coords[1]??''),lon:String(coords[0]??''),importance:Number(p.importance||0)
    };
  }).filter(r=>Number.isFinite(+r.lat)&&Number.isFinite(+r.lon));
}

const LOCATION_MATCH_STOP_WORDS=new Set(['the','of','and','uk','gb','england','scotland','wales','united','kingdom','great','britain']);
function locationMatchWords(value){
  return String(value||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(w=>w&&w.length>1&&!LOCATION_MATCH_STOP_WORDS.has(w));
}
function locationPrimaryName(result){
  return String(result?.name||result?.display_name?.split(',')[0]||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function locationResultPoint(result){
  const lat=Number(result?.lat),lon=Number(result?.lon);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}
function locationCandidatesEquivalent(a,b){
  const aName=locationPrimaryName(a),bName=locationPrimaryName(b);
  if(!aName||aName!==bName)return false;
  const pa=locationResultPoint(a),pb=locationResultPoint(b);
  if(!pa||!pb)return false;
  // Nominatim/Photon often return a locality and its administrative boundary as
  // separate rows. Treat those as one place when their centres are nearby.
  return haverDist(pa,pb)<=8000;
}
function compactGeocodeResults(results){
  const unique=[];
  for(const result of Array.isArray(results)?results:[]){
    if(!unique.some(existing=>locationCandidatesEquivalent(existing,result)))unique.push(result);
  }
  return unique;
}
function autoGeocodeChoice(results,query){
  const choices=compactGeocodeResults(results);
  if(choices.length<=1)return choices[0]||null;

  const clean=String(query||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const exact=choices.filter(r=>locationPrimaryName(r)===clean);
  if(exact.length===1)return exact[0];

  const queryWords=locationMatchWords(query);
  if(!queryWords.length)return null;
  const scored=choices.map((result,index)=>{
    const words=new Set(locationMatchWords(`${result?.name||''} ${result?.display_name||''}`));
    const matched=queryWords.reduce((n,w)=>n+(words.has(w)?1:0),0);
    return{result,index,coverage:matched/queryWords.length};
  }).sort((a,b)=>b.coverage-a.coverage||a.index-b.index);
  const best=scored[0];

  // A qualified query such as “Romiley (Stockport)” or “Buxton Derbyshire” is
  // already disambiguated by the user. If the top geocoder result contains all
  // of those meaningful words, accepting it silently is safer and less noisy
  // than asking the user to confirm a differently formatted version of it.
  if(queryWords.length>=2&&best.coverage===1)return best.result;

  // For a single-name query, only skip confirmation when all same-name rows
  // collapsed to one physical place. Distinct towns with the same name still
  // surface the chooser.
  if(queryWords.length===1&&best.coverage===1){
    const bestPoint=locationResultPoint(best.result);
    const plausible=scored.filter(row=>row.coverage===1);
    if(plausible.length===1)return best.result;
    if(bestPoint&&plausible.every(row=>{
      const point=locationResultPoint(row.result);
      return point&&haverDist(bestPoint,point)<=8000;
    }))return best.result;
  }
  return null;
}

async function chooseGeocodeResult(results,query,signal){
  const choices=compactGeocodeResults(results);
  if(choices.length<=1)return choices[0]||null;
  const automatic=autoGeocodeChoice(choices,query);
  if(automatic)return automatic;
  // Only interrupt when there are genuinely distinct plausible places.
  setLoading(false);
  return new Promise((resolve,reject)=>{
    const o=document.createElement('div');o.className='location-choice-overlay';
    o.innerHTML=`<div class="location-choice-card" role="dialog" aria-modal="true"><div class="location-choice-head"><div><p class="drivehub-tool-kicker">ROAD FINDER</p><h2>Which place did you mean?</h2></div><button type="button" class="location-choice-close" aria-label="Cancel">×</button></div><p class="location-choice-copy">There are a few distinct matches for <strong>${escapeHtml(query)}</strong>.</p><div class="location-choice-list"></div></div>`;
    const l=o.querySelector('.location-choice-list'),cleanup=()=>{signal?.removeEventListener('abort',abort);o.remove()},finish=v=>{cleanup();resolve(v)},cancel=()=>{cleanup();const e=new Error('Search cancelled.');e.name='AbortError';reject(e)},abort=()=>cancel();
    choices.slice(0,5).forEach((r,i)=>{const b=document.createElement('button');b.type='button';b.className='location-choice-option';b.innerHTML=`<strong>${escapeHtml(r.name||r.display_name?.split(',')[0]||`Result ${i+1}`)}</strong><span>${escapeHtml(r.display_name||'')}</span>`;b.addEventListener('click',()=>finish(r));l.appendChild(b)});
    o.querySelector('.location-choice-close')?.addEventListener('click',cancel);o.addEventListener('click',e=>{if(e.target===o)cancel()});signal?.addEventListener('abort',abort,{once:true});document.body.appendChild(o);o.querySelector('.location-choice-option')?.focus({preventScroll:true});
  });
}

async function geocodeLocation(query,signal,label='Location',progress=()=>{}){
  const coords=parseCoordinateQuery(query);if(coords)return coords;
  const key=`geocode:v3:${String(query||'').trim().toLowerCase()}`;
  const cached=await getCachedData(key);
  if(Array.isArray(cached)&&cached.length){const x=await chooseGeocodeResult(cached,query,signal);if(x)return{lat:+x.lat,lon:+x.lon,displayName:x.display_name||query}}

  const failures=[];
  let rows=[];
  try{
    progress(`Looking up ${label.toLowerCase()}…`);
    const url=`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&namedetails=1&countrycodes=gb&limit=5`;
    const data=await fetchJsonTimed(url,signal,8500);
    rows=Array.isArray(data)?data:[];
  }catch(err){failures.push(err)}

  if(!rows.length){
    try{
      progress(`Trying backup location service…`);
      const url=`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=en`;
      rows=photonRows(await fetchJsonTimed(url,signal,8500)).slice(0,5);
    }catch(err){failures.push(err)}
  }

  if(!rows.length){
    const timedOut=failures.some(e=>e?.code==='GEOCODE_TIMEOUT');
    throw new Error(timedOut?`${label} lookup timed out. Please try again.`:`${label} not found or location services are unavailable.`);
  }
  await setCachedData(key,rows);
  const x=await chooseGeocodeResult(rows,query,signal);
  if(!x)throw new Error(`${label} not found.`);
  return{lat:+x.lat,lon:+x.lon,displayName:x.display_name||query};
}


const BROWSER_ROUTE_PROVIDERS=[
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  'https://router.project-osrm.org/route/v1/driving'
];
const DIRECT_ROUTE_TIMEOUT_MS=6500;

function routeSignature(coords=[]){
  if(!Array.isArray(coords)||!coords.length)return'';
  const count=Math.min(18,coords.length),parts=[];
  for(let i=0;i<count;i++){
    const idx=Math.round((coords.length-1)*(i/Math.max(1,count-1))),c=coords[idx];
    parts.push(`${Number(c?.[0]).toFixed(3)},${Number(c?.[1]).toFixed(3)}`);
  }
  return parts.join('|');
}

function normaliseBrowserOsrmRoute(route,source,label){
  const raw=route?.geometry?.coordinates;
  if(!Array.isArray(raw)||raw.length<2)return null;
  const coords=raw.map(c=>[Number(c?.[1]),Number(c?.[0])]).filter(c=>c.every(Number.isFinite));
  const distance=Number(route?.distance),duration=Number(route?.duration);
  if(coords.length<2||!Number.isFinite(distance)||distance<=0||!Number.isFinite(duration)||duration<=0)return null;
  return {coords,distanceKm:distance/1000,durationMins:duration/60,source,label,signature:routeSignature(coords)};
}

function routeAbortError(message='Routing request cancelled.'){
  const err=new Error(message);err.name='AbortError';return err;
}

async function fetchRouteJson(url,signal,timeoutMs=DIRECT_ROUTE_TIMEOUT_MS){
  const controller=new AbortController();
  let timedOut=false;
  const abortFromParent=()=>controller.abort();
  if(signal?.aborted)throw routeAbortError();
  signal?.addEventListener?.('abort',abortFromParent,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},timeoutMs);
  try{
    const res=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'},cache:'no-store'});
    if(!res.ok)throw new Error(`Routing service returned ${res.status}.`);
    const data=await res.json();
    if(data?.code&&data.code!=='Ok')throw new Error(`Routing service returned ${data.code}.`);
    return data;
  }catch(err){
    if(signal?.aborted)throw routeAbortError();
    if(timedOut){const e=new Error('Routing service timed out.');e.code='ROUTE_TIMEOUT';throw e}
    throw err;
  }finally{
    clearTimeout(timer);
    signal?.removeEventListener?.('abort',abortFromParent);
  }
}

function browserRouteUrl(base,points,alternatives=false){
  const path=points.map(p=>`${Number(p[1]).toFixed(6)},${Number(p[0]).toFixed(6)}`).join(';');
  const altValue=alternatives?'true':'false';
  return `${base}/${path}?overview=full&geometries=geojson&steps=false&continue_straight=false&alternatives=${altValue}`;
}

async function fetchBrowserProviderOptions(base,points,label,signal,{alternatives=false}={}){
  const data=await fetchRouteJson(browserRouteUrl(base,points,alternatives),signal);
  const rows=(data?.routes||[]).map((r,i)=>normaliseBrowserOsrmRoute(r,base,i===0?label:`Alternative route ${i+1}`)).filter(Boolean);
  if(!rows.length)throw new Error('Routing service returned no usable route.');
  return rows;
}

async function firstSuccessfulRoute(promises,signal){
  if(!promises.length)throw new Error('No routing service is available.');
  try{return await Promise.any(promises)}
  catch(err){
    if(signal?.aborted)throw routeAbortError();
    const reasons=Array.isArray(err?.errors)?err.errors:[];
    const timedOut=reasons.some(e=>e?.code==='ROUTE_TIMEOUT');
    const message=reasons.map(e=>String(e?.message||'')).find(Boolean);
    throw new Error(timedOut?'Direct routing services timed out. Please try again.':(message||'Routing services are unavailable.'));
  }
}

async function fetchBrowserA2BOptions(points,label,signal,{alternatives=false}={}){
  // Do not wait for one public routing service to fail before trying the next.
  // A→B is latency-sensitive, so both independent OSM routing backends race and
  // the first valid response wins. Every request has its own hard timeout.
  return firstSuccessfulRoute(
    BROWSER_ROUTE_PROVIDERS.map(base=>fetchBrowserProviderOptions(base,points,label,signal,{alternatives})),
    signal
  );
}

async function fetchBrowserA2BRoute(points,label,signal){
  return (await fetchBrowserA2BOptions(points,label,signal,{alternatives:false}))[0]||null;
}

function canUseDriveHubProxy(){
  return Boolean(window.DriveHubRuntime?.hasHostedBackend)||location.protocol==='http:'||location.protocol==='https:';
}

async function fetchDriveHubProxyRoute(startCoord,endCoord,signal,{viaCoord=null,label='Direct route',alternatives=false}={}){
  if(!canUseDriveHubProxy())throw new Error('DriveHub routing proxy is unavailable in local-file mode.');
  const start=`${Number(startCoord[0]).toFixed(6)},${Number(startCoord[1]).toFixed(6)}`;
  const end=`${Number(endCoord[0]).toFixed(6)},${Number(endCoord[1]).toFixed(6)}`;
  const q=new URLSearchParams({start,end,label,alternatives:alternatives?'1':'0'});
  if(viaCoord)q.append('via',`${Number(viaCoord[0]).toFixed(6)},${Number(viaCoord[1]).toFixed(6)}`);
  const proxyPath=`/api/roads/a2b?${q.toString()}`;
  const data=await fetchRouteJson(window.DriveHubRuntime?.apiUrl?.(proxyPath)||proxyPath,signal,7500);
  if(!Array.isArray(data?.routes)||!data.routes.length)throw new Error('DriveHub routing proxy returned no route.');
  return alternatives?data.routes:data.routes.slice(0,1);
}

async function fetchProviderA2BRoute(startCoord,endCoord,signal,{viaCoord=null,label='Direct route'}={}){
  const points=[startCoord];
  if(viaCoord)points.push(viaCoord);
  points.push(endCoord);

  // Race the browser routing backends and the hosted proxy (when available).
  // This removes the old serial dependency where a stalled /api request could
  // leave the UI parked on “Finding the direct route…” indefinitely.
  const attempts=BROWSER_ROUTE_PROVIDERS.map(base=>
    fetchBrowserProviderOptions(base,points,label,signal,{alternatives:false}).then(rows=>rows[0])
  );
  if(canUseDriveHubProxy())attempts.push(
    fetchDriveHubProxyRoute(startCoord,endCoord,signal,{viaCoord,label,alternatives:false}).then(rows=>rows[0])
  );
  return firstSuccessfulRoute(attempts,signal);
}

async function fetchProviderA2BRoutes(startCoord,endCoord,signal){
  const direct=await fetchProviderA2BRoute(startCoord,endCoord,signal,{label:'Direct route'});
  return direct?[direct]:[];
}

async function fetchProviderNativeAlternatives(startCoord,endCoord,signal){
  const attempts=BROWSER_ROUTE_PROVIDERS.map(base=>
    fetchBrowserProviderOptions(base,[startCoord,endCoord],'Direct route',signal,{alternatives:true})
  );
  if(canUseDriveHubProxy())attempts.push(
    fetchDriveHubProxyRoute(startCoord,endCoord,signal,{label:'Direct route',alternatives:true})
  );
  return firstSuccessfulRoute(attempts,signal);
}

function sampleRouteCorridorPoints(coords,count=4){
  const rows=(coords||[]).filter(c=>Array.isArray(c)&&c.length>=2&&c.every(Number.isFinite));
  if(rows.length<2)return[];
  const n=Math.max(3,Math.min(6,Number(count)||4));
  const points=[];
  for(let i=0;i<n;i++){
    const t=n===1?.5:(.08+(.84*i/Math.max(1,n-1)));
    points.push(rows[Math.round((rows.length-1)*t)]);
  }
  return points;
}

async function fetchRouteCorridorData(routeCoords,routeDistanceKm,signal){
  const radiusKm=Math.max(5.5,Math.min(8.5,Number(routeDistanceKm||0)*.24+1.5));
  const centers=sampleRouteCorridorPoints(routeCoords,4);
  if(!centers.length)throw new Error('Direct route geometry is unavailable.');
  const merged=new Map();
  // Small overlapping searches are much more reliable than the old giant A→B
  // bounding box and, crucially, only inspect roads that are genuinely close to
  // the route the driver would otherwise take.
  for(let i=0;i<centers.length;i+=2){
    if(signal?.aborted){const e=new Error('Search cancelled.');e.name='AbortError';throw e}
    setLoading(true,`Checking better roads near the direct route ${Math.min(i+1,centers.length)}–${Math.min(i+2,centers.length)} of ${centers.length}…`);
    const rows=await Promise.all(centers.slice(i,i+2).map(c=>fetchWithRetry(c[0],c[1],radiusKm,signal)));
    for(const data of rows)for(const el of data?.elements||[]){
      const key=`${el.type||'element'}:${el.id??(RF.stableHash?RF.stableHash(JSON.stringify(el)):Math.random())}`;
      if(!merged.has(key))merged.set(key,el);
    }
  }
  return {data:{elements:[...merged.values()]},radiusKm};
}

function nearestRouteDistanceInfo(point,routeCoords){
  let bestKm=Infinity,bestIndex=0;
  const coords=routeCoords||[];
  if(!point||coords.length<2)return{distanceKm:bestKm,progress:0};
  const step=Math.max(1,Math.floor(coords.length/120));
  for(let i=0;i<coords.length;i+=step){
    const c=coords[i],d=fastDistRaw(point[0],point[1],c[0],c[1])/1000;
    if(d<bestKm){bestKm=d;bestIndex=i}
  }
  const last=coords.length-1,c=coords[last],d=fastDistRaw(point[0],point[1],c[0],c[1])/1000;
  if(d<bestKm){bestKm=d;bestIndex=last}
  return{distanceKm:bestKm,progress:bestIndex/Math.max(1,last)};
}

function selectCorridorRoadCandidates(allRoads,directRoute,corridorRadiusKm){
  const routeCoords=directRoute?.coords||[];
  const start=routeCoords[0],end=routeCoords[routeCoords.length-1];
  if(!start||!end)return[];
  const ax=end[1]-start[1],ay=end[0]-start[0];
  const rows=[];
  for(const road of allRoads||[]){
    if(!road||road.tier==='excluded'||Number(road.score||0)<35||parseFloat(road.len||0)<.55||!Array.isArray(road.coords)||road.coords.length<2)continue;
    const midpoint=road.coords[Math.floor(road.coords.length/2)];
    const info=nearestRouteDistanceInfo(midpoint,routeCoords);
    if(info.progress<.10||info.progress>.90)continue;
    // The direct route is already one result. Candidate roads should pull us
    // away from it enough to create a genuinely different drive, but remain in
    // the local corridor rather than becoming a huge detour.
    if(info.distanceKm<.65||info.distanceKm>Math.max(4.5,corridorRadiusKm*.95))continue;
    const bx=midpoint[1]-start[1],by=midpoint[0]-start[0];
    const side=Math.sign(ax*by-ay*bx)||0;
    const quality=Number(road.score||0);
    const lengthBonus=Math.min(12,parseFloat(road.len||0)*1.5);
    const detourPenalty=Math.max(0,info.distanceKm-2.5)*2.2;
    rows.push({road,midpoint,side,progress:info.progress,distanceKm:info.distanceKm,rank:quality+lengthBonus-detourPenalty});
  }
  rows.sort((a,b)=>b.rank-a.rank);
  const selected=[];
  const take=row=>{
    if(!row||selected.includes(row))return;
    const tooClose=selected.some(x=>Math.abs(x.progress-row.progress)<.09&&x.side===row.side);
    if(!tooClose)selected.push(row);
  };
  take(rows.find(r=>r.side>0));
  take(rows.find(r=>r.side<0));
  for(const r of rows)take(r);
  return selected.slice(0,10);
}

function routeOverlapApprox(aCoords,bCoords){
  const a=sampleRouteCorridorPoints(aCoords,18),b=sampleRouteCorridorPoints(bCoords,32);
  if(!a.length||!b.length)return 0;
  let matched=0;
  for(const p of a){
    let near=false;
    for(const q of b){if(fastDistRaw(p[0],p[1],q[0],q[1])<500){near=true;break}}
    if(near)matched++;
  }
  return matched/a.length;
}

async function buildBetterRoadAlternatives(directProviderRoute,allRoads,corridorRadiusKm,startCoord,endCoord,signal){
  const candidates=selectCorridorRoadCandidates(allRoads,directProviderRoute,corridorRadiusKm);
  const alternatives=[];
  const directKm=Number(directProviderRoute?.distanceKm||0);
  for(const candidate of candidates){
    if(alternatives.length>=4)break;
    const roadName=candidate.road?.name&&!String(candidate.road.name).startsWith('Unnamed')?candidate.road.name:'better road';
    const label=`Better roads via ${roadName}`;
    try{
      const raw=await fetchProviderA2BRoute(startCoord,endCoord,signal,{viaCoord:candidate.midpoint,label});
      if(!raw)continue;
      const km=Number(raw.distanceKm||0);
      if(directKm&&km>Math.max(directKm*1.55,directKm+18))continue;
      const overlap=routeOverlapApprox(raw.coords,directProviderRoute.coords);
      if(overlap>.94)continue;
      if(alternatives.some(r=>routeOverlapApprox(raw.coords,r.coords)>.91))continue;
      raw._candidateScore=Number(candidate.road?.score||0);
      raw._candidateName=roadName;
      alternatives.push(raw);
    }catch(err){if(err?.name==='AbortError')throw err}
  }
  return alternatives;
}

function assessProviderRoute(providerRoute,allRoads=[]){
  const coords=(providerRoute?.coords||[]).filter(c=>Array.isArray(c)&&c.length>=2&&c.every(Number.isFinite));
  const lenKm=Math.max(.1,Number(providerRoute?.distanceKm||0));
  const timeMins=Math.max(1,Math.round(Number(providerRoute?.durationMins||0)));
  const roads=(allRoads||[]).filter(r=>Array.isArray(r?.coords)&&r.coords.length>=2);
  if(coords.length<2)return null;

  // A provider route can be shown before Overpass scoring completes. Once the
  // local Road Finder dataset is available, sample the route against nearby
  // scored roads and upgrade the card without changing its geometry.
  if(!roads.length){
    const route={
      routeType:'a2b',isCircular:false,name:providerRoute.label||'A-to-B route',coords,startCoord:coords[0],
      len:lenKm.toFixed(1),timeMins,score:0,scoreAvailable:false,tier:'tier4',goodRoads:0,
      driverRoadRatio:0,routeConfidence:32,roadNames:[],roadDetails:[],routeProfile:providerRoute.label||'Provider route',
      segmentDetails:[{coords,isGood:false,name:'Routed road'}]
    };
    route.id=RF.stableRouteId?RF.stableRouteId(route):`A2B-PROVIDER-${providerRoute.signature||Date.now()}`;
    return route;
  }

  const sampleCount=Math.min(90,Math.max(18,coords.length));
  const routeSamples=[];
  for(let i=0;i<sampleCount;i++)routeSamples.push(coords[Math.round((coords.length-1)*(i/Math.max(1,sampleCount-1)))]);
  const roadSamples=roads.map(road=>{
    const pts=road.coords||[],n=Math.min(18,pts.length),samples=[];
    for(let i=0;i<n;i++)samples.push(pts[Math.round((pts.length-1)*(i/Math.max(1,n-1)))]);
    return {road,samples};
  });
  let rated=0,scoreSum=0;
  const matched=new Map();
  for(const point of routeSamples){
    let best=null,bestM=260;
    for(const row of roadSamples){
      for(const c of row.samples){
        const d=fastDistRaw(point[0],point[1],c[0],c[1]);
        if(d<bestM){bestM=d;best=row.road}
      }
    }
    if(!best||best.tier==='excluded')continue;
    rated++;scoreSum+=Number(best.score||0);
    const key=String(best.id||best.name||matched.size);
    const hit=matched.get(key)||{road:best,hits:0};hit.hits++;matched.set(key,hit);
  }
  const ratio=routeSamples.length?rated/routeSamples.length:0;
  const score=rated?Math.max(0,Math.min(100,Math.round(scoreSum/rated))):0;
  const roadDetails=[...matched.values()].sort((a,b)=>b.hits-a.hits).slice(0,10).map(x=>({
    name:x.road.name||'Unnamed road',score:Number(x.road.score||0),tier:x.road.tier||'tier4',confidence:Number(x.road.confidence||55),
    len:Number((lenKm*(x.hits/Math.max(1,rated))).toFixed(2)),isGood:true
  }));
  const evidence=RF.routeConfidence?RF.routeConfidence({roadDetails,driverRoadRatio:ratio}):{score:Math.round(40+ratio*40)};
  const roadNames=roadDetails.map(r=>r.name).filter(n=>n&&!String(n).startsWith('Unnamed'));
  const via=roadNames[0];
  const route={
    routeType:'a2b',isCircular:false,name:via?`${providerRoute.label||'A-to-B route'} via ${via}`:(providerRoute.label||'A-to-B route'),coords,startCoord:coords[0],
    len:lenKm.toFixed(1),timeMins,score,scoreAvailable:rated>0,tier:score>=70?'tier1':score>=50?'tier2':score>=30?'tier3':'tier4',
    goodRoads:roadDetails.length,driverRoadRatio:ratio,routeConfidence:evidence.score,roadNames,roadDetails,routeProfile:providerRoute.label||'Provider route',
    segmentDetails:[{coords,isGood:false,name:'Routed road'}]
  };
  route.id=RF.stableRouteId?RF.stableRouteId(route):`A2B-PROVIDER-${providerRoute.signature||Date.now()}`;
  return route;
}

function mergeA2BRouteSets(...sets){
  const out=[],seen=new Set();
  for(const set of sets)for(const route of set||[]){
    if(!route)continue;const id=String(route.id||'');
    if(id&&seen.has(id))continue;
    if(id)seen.add(id);out.push(route);
  }
  return out.slice(0,9);
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
async function start(overrideLat=null,overrideLon=null){
  const isA2B = (state.currentTab === 'routes' && state.searchMode === 'a2b');
  const addr = els.addr.value.trim();
  const addrTo = els.addrTo ? els.addrTo.value.trim() : '';
  const distKm = isA2B ? 15 : parseInt(els.dist.value, 10);

  if (isA2B) {
    if (!addr || !addrTo) { setStatus('Enter both Start and End locations.', 'error'); return; }
  } else {
    if(!addr && overrideLat === null) { setStatus('Enter a location first.', 'error'); els.addr.focus(); return; }
    if(!Number.isFinite(distKm) || distKm < 1 || distKm > 100) { setStatus('Radius must be 1–100 km.', 'error'); return; }
  }

  state.lastSearchMeta = {
    addr,
    addrTo,
    distKm,
    currentTab: state.currentTab,
    searchMode: state.searchMode,
    when: Date.now()
  };
  state.hasSearched=true; state.visibleRoadsLimit=100; updateCount('Searching...');
  document.getElementById('mapHint')?.setAttribute('hidden','');

  // Once a search is running the hero has done its job. Collapse it to its
  // summary line — the same move MyGarage makes when a car header goes compact —
  // so the results have the column and the map is not covered on phones.
  setPanelState({ searchPanel: 'collapsed' }, 'search-started');

  // Wipe previous results instantly
  roadLayers.clearLayers();
  state.polylines = [];
  state.masterRoads = [];
  state.excludedRoads = [];
  state.allProcessedRoads = [];
  state.masterRoutes = [];
  state.selectedId = null;
  state.preSelectionView = null;
  state._pickMap = new Map();
  clearNameTooltip();

  if (els.debugSearchInput) els.debugSearchInput.value = '';
  if (els.debugSearchResults) els.debugSearchResults.innerHTML = '';

  renderEmpty('Searching...', isA2B ? 'Finding the best route...' : 'Scanning roads in area...');

  if(state.searchAbort) state.searchAbort.abort();
  state.searchAbort = new AbortController();
  const signal = state.searchAbort.signal;

  try{
    let lat=overrideLat, lon=overrideLon;
    let endLat=null, endLon=null;

    if(lat===null){
      setLoading(true, isA2B ? 'Looking up route locations…' : 'Looking up location…');
      const loc=await geocodeLocation(addr,signal,isA2B?'Start location':'Location',msg=>setLoading(true,msg));lat=loc.lat;lon=loc.lon;
    }

    if(isA2B && endLat===null) {
      setLoading(true, 'Looking up destination…');
      const loc2=await geocodeLocation(addrTo,signal,'Destination',msg=>setLoading(true,msg));endLat=loc2.lat;endLon=loc2.lon;
    }

    if(state.searchMarker) map.removeLayer(state.searchMarker);
    if(state.endMarker) map.removeLayer(state.endMarker);

    const searchIcon = L.divIcon({
      className: 'search-marker',
      html: `<svg class="search-pin-graphic" viewBox="0 0 24 24" fill="var(--brand)" stroke="#fff" stroke-width="2" width="32" height="32"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/></svg>`,
      iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32]
    });
    state.searchCoord = [lat, lon];
    state.searchMarker = L.marker(state.searchCoord, {icon: searchIcon, interactive:false, keyboard:false}).addTo(map);

    if(isA2B && endLat !== null && endLon !== null) {
      const endIcon = L.divIcon({
        className: 'search-marker',
        html: `<svg class="search-pin-graphic" viewBox="0 0 24 24" fill="#000" stroke="#fff" stroke-width="2" width="32" height="32"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/></svg>`,
        iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32]
      });
      state.endCoord = [endLat, endLon];
      state.endMarker = L.marker(state.endCoord, {icon: endIcon, interactive:false, keyboard:false}).addTo(map);
      focusRoadBounds(L.latLngBounds([[lat,lon], [endLat,endLon]]));
    } else {
      smoothSetView([lat,lon], 12, { duration: 0.42 });
    }

    state.searchStart = [lat, lon];
    if(isA2B) state.searchEnd = [endLat, endLon];
    state.masterRoutes=[]; state.routeDistanceChosen=false; state.routesLoading=false; clearNameTooltip();
    syncRouteDistanceControls();

    const resultCacheKey = makeSearchResultCacheKey({ lat, lon, distKm, endLat, endLon, isA2B });
    state.currentResultCacheKey = resultCacheKey;
    if (await restoreSearchResultCache(resultCacheKey)) {
      state.lastSearchMeta = { ...(state.lastSearchMeta || {}), cacheHit: true };
      setLoading(false);
      updateSearchUI();
      renderResults();
      handleSearchCompletion();
      const count = state.currentTab === 'routes' ? state.masterRoutes.length : state.masterRoads.length;
      setStatus(`Showing ${count} cached ${state.currentTab === 'routes' ? 'route' : 'road'}${count === 1 ? '' : 's'}.`, 'success');
      return;
    }

    let providerRows=[];
    let providerError=null;
    if(isA2B){
      // A→B now has one hard requirement: find the normal direct drive first.
      // Everything DriveHub-specific is optional enrichment layered on top.
      setLoading(true,'Finding the direct route…');
      try{
        providerRows=await fetchProviderA2BRoutes(state.searchStart,state.searchEnd,signal);
        state.masterRoutes=providerRows.map(r=>assessProviderRoute(r,[])).filter(Boolean);
        state.routeDistanceChosen=true;
        if(state.masterRoutes.length){
          setStatus('Direct route found. Looking for better roads close to it…','success');
          updateSearchUI();
          renderResults();
          if (usesMobileWorkspace()) showMobileWorkspace('map', 'direct-route-preview');
          else openResultsSection();
        }
      }catch(err){providerError=err}
    }

    let mapDataError=null;
    let corridorRadiusKm=0;
    try{
      setLoading(true,isA2B?'Checking roads close to the direct route…':'Loading map data…');
      let data;
      if(isA2B){
        const direct=providerRows[0];
        if(!direct)throw providerError||new Error('Could not find the direct route.');
        const corridor=await fetchRouteCorridorData(direct.coords,direct.distanceKm,signal);
        data=corridor.data;corridorRadiusKm=corridor.radiusKm;
      }else{
        data=await fetchWithRetry(lat,lon,distKm,signal,endLat,endLon);
      }
      const processed=await process(data,msg=>setLoading(true,msg),signal);
      state.masterRoads=processed.roads; state.excludedRoads=processed.excluded; state.allProcessedRoads=processed.allProcessed;
    }catch(err){
      if(!isA2B)throw err;
      if(err.name==='AbortError'||err.message==='Search cancelled.')throw err;
      mapDataError=err;
      state.masterRoads=[];state.excludedRoads=[];state.allProcessedRoads=[];
    }

    if(isA2B) {
      const directRaw=providerRows[0]||null;
      let rawRoutes=directRaw?[directRaw]:[];
      if(directRaw){
        let better=[];
        if(state.allProcessedRoads.length){
          setLoading(true,'Trying the best nearby roads…');
          better=await buildBetterRoadAlternatives(
            directRaw,state.allProcessedRoads,corridorRadiusKm,state.searchStart,state.searchEnd,signal
          );
        }
        // The corridor search is the primary source of alternatives. If it does
        // not yield two distinct drives — including when Overpass is unavailable
        // — ask the routing engine for its normal alternatives as a safety net.
        if(better.length<2){
          try{
            setLoading(true,'Checking normal route alternatives…');
            const native=await fetchProviderNativeAlternatives(state.searchStart,state.searchEnd,signal);
            for(const row of native.slice(1)){
              if(better.length>=2)break;
              if(routeOverlapApprox(row.coords,directRaw.coords)>.94)continue;
              if(better.some(x=>routeOverlapApprox(row.coords,x.coords)>.91))continue;
              row.label=row.label||`Alternative route ${better.length+1}`;
              better.push(row);
            }
          }catch(err){if(err?.name==='AbortError')throw err}
        }
        rawRoutes=[directRaw,...better];
      }

      let providerRoutes=rawRoutes.map(r=>assessProviderRoute(r,state.allProcessedRoads)).filter(Boolean);
      if(providerRoutes.length>1){
        const direct=providerRoutes[0];
        const alternatives=providerRoutes.slice(1).sort((a,b)=>{
          const directLen=Math.max(.1,Number(direct.len||0));
          const rank=x=>(Number(x.score||0)*.58)+(Number(x.driverRoadRatio||0)*28)-Math.max(0,(Number(x.len||0)-directLen)/directLen)*28;
          return rank(b)-rank(a);
        });
        providerRoutes=[direct,...alternatives];
      }
      state.masterRoutes=mergeA2BRouteSets(providerRoutes);
      setLoading(false);
      if (state.masterRoutes.length === 0) {
        const reason=providerError?.message||mapDataError?.message;
        setStatus(reason || 'Could not find a drivable route between these locations.', 'error');
      } else if(mapDataError) {
        setStatus('Direct route found. Better-road search is temporarily unavailable, so showing the normal route.', 'success');
      } else if(state.masterRoutes.length===1) {
        setStatus('Direct route found. No sufficiently different better-road alternative was found in the nearby corridor.', 'success');
      } else {
        setStatus(`Found ${state.masterRoutes.length} routes: the direct route plus ${state.masterRoutes.length-1} alternative${state.masterRoutes.length===2?'':'s'}, prioritising better nearby roads.`, 'success');
      }
      state.routeDistanceChosen = true;
    } else {
      if (state.masterRoads.length === 0) throw new Error('no_roads');
      if(state.currentTab !== 'routes') setStatus(`Found ${state.masterRoads.length} roads.`, 'success');
    }
    if (isA2B || state.currentTab === 'roads') {
      await saveSearchResultCache(state.currentResultCacheKey);
    }
    updateSearchUI();

    if (state.currentTab === 'routes' && !isA2B) {
      // Don't close panels yet, let buildRoutesForSelection finish it
      await buildRoutesForSelection();
      return;
    }

    handleSearchCompletion();
    renderResults();
  }catch(err){
    if(err.name === 'AbortError' || err.message === 'Search cancelled.') return;

    let msg = err.message || 'Something went wrong.';
    if (msg.includes('All map data servers') || msg === 'empty_roads' || msg === 'overpass_remark') {
      msg = 'Map servers are currently overloaded or returned empty data. Please try again.';
    }
    if (msg === 'no_roads') msg = 'No valid driving roads found here. Please try a different area or wider radius.';

    renderEmpty('Search couldn’t finish', msg, {
      tone: 'error',
      actionLabel: 'Try again',
      secondaryLabel: 'Edit search',
      onAction: () => start(),
      onSecondary: () => reopenSearchFromState('search-error-edit')
    });
    updateCount('Search failed');
    openResultsSection();
    setStatus(msg, 'error');
  }finally{
    setLoading(false);
    if (state.searchAbort?.signal === signal) state.searchAbort = null;
  }
}

els.locateBtn.addEventListener('click',()=>{
  if(!navigator.geolocation){ setStatus('Geolocation not supported.','error'); return; }
  els.locateBtn.disabled = true;
  setLoading(true,'Getting your location...');
  navigator.geolocation.getCurrentPosition(async pos=>{
    const{latitude:lat,longitude:lon}=pos.coords;
    try{
      setLoading(true,'Identifying location...');
      const _nomKey = `nominatim:${lat.toFixed(3)},${lon.toFixed(3)}`;
      let d = await getCachedData(_nomKey);
      if (!d) {
        try {
          d=await fetchJsonTimed(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2`,null,7000);
        } catch {
          const pd=await fetchJsonTimed(`https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}`,null,7000);
          const f=pd?.features?.[0]?.properties||{};
          d={address:{city:f.city,town:f.city,village:f.name,suburb:f.district,county:f.county}};
        }
        await setCachedData(_nomKey, d);
      }
      const address = d && d.address ? d.address : {};
      els.addr.value=address.city||address.town||address.village||address.suburb||address.county||'Current Location';

      if (state.searchMode === 'a2b' && (!els.addrTo || !els.addrTo.value.trim())) {
        setLoading(false);
        els.locateBtn.disabled = false;
        setStatus('Start location found. Enter destination to route.', 'success');
        if(els.addrTo) els.addrTo.focus();
        return;
      }
      els.locateBtn.disabled = false;
      start(lat,lon);
    }catch{ 
      els.addr.value=`${lat.toFixed(4)}, ${lon.toFixed(4)}`; 
      if (state.searchMode === 'a2b' && (!els.addrTo || !els.addrTo.value.trim())) {
        setLoading(false);
        els.locateBtn.disabled = false;
        setStatus('Start location found. Enter destination to route.', 'success');
        if(els.addrTo) els.addrTo.focus();
        return;
      }
      els.locateBtn.disabled = false;
      start(lat,lon); 
    }
  },()=>{ 
    els.locateBtn.disabled = false;
    isLiveLocationActive = false;
    els.liveLocationBtn.style.color = 'var(--brand)';
    els.liveLocationBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg> Show live location';
    if (liveLocationInterval) { clearInterval(liveLocationInterval); liveLocationInterval = null; }
    setLoading(false); 
    setStatus('Unable to retrieve location.','error'); 
  },{enableHighAccuracy: true, timeout: 15000, maximumAge: 0});
});

els.searchForm.addEventListener('submit',e=>{ e.preventDefault(); start(); });
els.routeSearchBtn.addEventListener('click',()=>{ buildRoutesForSelection(); });
document.getElementById('modeDistanceBtn')?.addEventListener('click', () => switchRouteMode('distance'));
document.getElementById('modeTimeBtn')?.addEventListener('click', () => switchRouteMode('time'));
document.querySelector('.fav-chip')?.addEventListener('click', event => {
  event.preventDefault();
  state.favsOnly = !state.favsOnly;
  syncFilterChipsUI();
  renderResults();
  saveAppState();
});
document.querySelector('.picks-chip')?.addEventListener('click', event => {
  event.preventDefault();
  state.picksOnly = !state.picksOnly;
  syncFilterChipsUI();
  renderResults();
  saveAppState();
});
const roadScoreFilter = document.getElementById('roadScoreFilter');
roadScoreFilter?.addEventListener('toggle', () => {
  const row = roadScoreFilter.closest('.filter-chip-row');
  row?.classList.toggle('dropdown-open', Boolean(roadScoreFilter.open));
});
document.querySelectorAll('.dropdown-filter input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', () => toggleTier(cb));
});
function toggleTier(cb) {
  if(cb.checked) state.activeTiers.add(cb.value);
  else state.activeTiers.delete(cb.value);
  // At least one Road Score band must stay visible. An all-off tier state has no
  // useful meaning and was the main way a successful search could appear empty.
  if (state.activeTiers.size === 0) {
    cb.checked = true;
    state.activeTiers.add(cb.value);
    setStatus('Keep at least one Road Score band visible.', 'info');
  }
  renderResults(); savePrefs();
}
function syncFilterChipsUI() {
  const favBtn = document.querySelector('.fav-chip');
  if(favBtn) favBtn.setAttribute('aria-pressed', String(state.favsOnly));

  const picksBtn = document.querySelector('.picks-chip');
  if (picksBtn) {
    const showPicks = state.currentTab !== 'routes';
    picksBtn.hidden = !showPicks;
    picksBtn.setAttribute('aria-hidden', showPicks ? 'false' : 'true');
    picksBtn.setAttribute('aria-pressed', String(state.picksOnly));
  }
}

function syncTiersUI() {
  document.querySelectorAll('.dropdown-filter input[type="checkbox"]').forEach(cb => {
    cb.checked = state.activeTiers.has(cb.value);
  });
  syncFilterChipsUI();
}
syncRouteDistanceControls();
updateCount('Ready');


// ── LIVE LOCATION ────────────────────────────────────────────────────────────
let userLocationMarker = null;
let liveLocationInterval = null;
let isLiveLocationActive = false;
let preLiveLocationView = null;

function updateLiveLocation(panTo = false) {
  if (!navigator.geolocation) {
    setStatus('Geolocation is not supported by your browser.', 'error');
    return;
  }

  if (panTo) {
    setStatus('Finding your location...', 'info');
  }

  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    if (!userLocationMarker) {
      userLocationMarker = L.circleMarker([lat, lon], {
        radius: 6,
        fillColor: '#3b82f6',
        color: '#fff',
        weight: 3,
        opacity: 1,
        fillOpacity: 1
      }).addTo(map);
    } else {
      userLocationMarker.setLatLng([lat, lon]);
    }

    if (panTo) {
      smoothSetView([lat, lon], map.getZoom() > 12 ? map.getZoom() : 13, { duration: 0.45 });
      setStatus('Location found. Tracking active.', 'success');
    }
  }, err => {
    console.warn('Geolocation error:', err);
    if(err.code === 1) setStatus('Location permission denied.', 'error');
    else setStatus('Failed to find your location.', 'error');
  }, { enableHighAccuracy: true });
}

els.liveLocationBtn?.addEventListener('click', () => {
  isLiveLocationActive = !isLiveLocationActive;

  if (isLiveLocationActive) {
    // Save current view
    preLiveLocationView = { center: map.getCenter(), zoom: map.getZoom() };

    els.liveLocationBtn.style.color = '#3b82f6';
    els.liveLocationBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="12" cy="12" r="3"></circle></svg> Stop live location';

    updateLiveLocation(true); // pan on first click
    liveLocationInterval = setInterval(() => updateLiveLocation(false), 30000);
  } else {
    els.liveLocationBtn.style.color = 'var(--brand)';
    els.liveLocationBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg> Show live location';

    if (liveLocationInterval) {
      clearInterval(liveLocationInterval);
      liveLocationInterval = null;
    }
    if (userLocationMarker) {
      map.removeLayer(userLocationMarker);
      userLocationMarker = null;
    }
    setStatus('Live location tracking stopped.', 'success');

    // Restore previous view
    if (preLiveLocationView) {
      smoothSetView(preLiveLocationView.center, preLiveLocationView.zoom, { duration: 0.45 });
      preLiveLocationView = null;
    }
  }
});

if (!restoreAppState()) {
  // If no saved state, ensure UI still initializes the default tab correctly
  state.currentTab = null;
  switchTab('roads', true);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    anchorMobileSearchPanel();
    if (isMobile() && state.ui?.searchPanel === 'open') requestAnimationFrame(resetMobileSearchPanelScroll);
  });
  window.visualViewport.addEventListener('scroll', () => {
    anchorMobileSearchPanel();
    if (isMobile() && state.ui?.searchPanel === 'open') requestAnimationFrame(resetMobileSearchPanelScroll);
  });
}

['focusin', 'touchend'].forEach(evtName => {
  document.addEventListener(evtName, (evt) => {
    if (!isMobile() || state.ui?.searchPanel !== 'open') return;
    if (els.topPanel && els.topPanel.contains(evt.target)) {
      requestAnimationFrame(resetMobileSearchPanelScroll);
      setTimeout(resetMobileSearchPanelScroll, 120);
    }
  }, true);
});

setPanelState({}, 'initialise-panels');
mountDebugControl();
updateMobileSearchHandle();

// First-load entrance animation for the top search panel
if (els.topPanel) {
  els.topPanel.classList.add('entering');
  setTimeout(() => els.topPanel.classList.remove('entering'), 600);
}

// Ensure map is correctly sized after all CSS/layout has settled
setTimeout(() => { try { map.invalidateSize(); } catch(e){} }, 100);
setTimeout(() => { try { map.invalidateSize(); } catch(e){} }, 500);

// When Road Finder is used inside the standalone DriveHub iframe, the parent
// explicitly tells the tool when the iframe has become visible. Re-run the
// panel/layout repair at that point so Leaflet/MapLibre never initialise
// against a stale or zero-sized embedded viewport.
function repairAfterDriveHubReveal(){
  try {
    setPanelState({}, 'drivehub-embedded-reveal');
    smoothInvalidateSize();
    smoothInvalidateSize(180);
  } catch(e) {}
}
window.addEventListener('message', e => {
  if (e?.data?.type === 'drivehub-embedded-visible') repairAfterDriveHubReveal();
});
window.addEventListener('pageshow', repairAfterDriveHubReveal);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') repairAfterDriveHubReveal();
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    try {
      setPanelState({}, 'orientation-repair');
      smoothInvalidateSize();
      if(state.hasSearched && roadLayers.getLayers().length > 0 && state.selectedId === null) {
        const bounds = roadLayers.getBounds();
        if(bounds.isValid()) focusRoadBounds(bounds, { smooth: false, scope: 'results' });
      }
    } catch(e){}
  }, 300);
});

// ── MOBILE SCORE POPOVER ───────────────────────────────────────────────────
// Desktop keeps the hover/focus tooltip. Touch devices get a real tap target
// and fixed popover so the breakdown is not clipped, misplaced, or hidden
// behind neighbouring cards in the scroll list.
function shouldUseMobileScorePopover() {
  try {
    return window.matchMedia('(max-width: 720px), (hover: none), (pointer: coarse)').matches;
  } catch (e) {
    return isMobile && isMobile();
  }
}

function closeMobileScorePopover() {
  const existing = document.getElementById('mobileScorePopover');
  if (existing) existing.remove();
  document.body.classList.remove('score-popover-open');
}

function openMobileScorePopover(sourceTooltip) {
  if (!sourceTooltip) return;
  closeMobileScorePopover();

  const overlay = document.createElement('div');
  overlay.id = 'mobileScorePopover';
  overlay.className = 'mobile-score-popover';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Road score breakdown');

  overlay.innerHTML = `
    <div class="mobile-score-popover__backdrop" data-score-popover-close="true"></div>
    <div class="mobile-score-popover__panel" role="document">
      <div class="mobile-score-popover__handle" aria-hidden="true"></div>
      <button class="mobile-score-popover__close" type="button" aria-label="Close score breakdown" data-score-popover-close="true">×</button>
      <div class="mobile-score-popover__content">${sourceTooltip.innerHTML}</div>
    </div>
  `;

  overlay.addEventListener('click', (event) => {
    if (event.target.closest('[data-score-popover-close="true"]')) {
      event.preventDefault();
      event.stopPropagation();
      closeMobileScorePopover();
    }
  });

  document.body.appendChild(overlay);
  document.body.classList.add('score-popover-open');

  const closeBtn = overlay.querySelector('.mobile-score-popover__close');
  if (closeBtn) closeBtn.focus({ preventScroll: true });
}

document.addEventListener('click', (event) => {
  const helpBtn = event.target.closest('.score-help');
  if (!helpBtn) return;

  // On desktop, the CSS hover/focus tooltip remains the interaction model.
  if (!shouldUseMobileScorePopover()) return;

  event.preventDefault();
  event.stopPropagation();

  const tooltip = helpBtn.closest('.score-tooltip-wrap')?.querySelector('.score-tooltip');
  openMobileScorePopover(tooltip);
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileScorePopover();
});

// ── DriveHub shell ──────────────────────────────────────────────────────────
// Wiring for the DriveHub interface: the bottom pill nav (which replaces the
// old tab strip) and the ink hero summary, which mirrors the MyGarage car hero
// by showing what you are currently looking at once a search has run.
(function driveHubShell(){
  'use strict';

  const heroSummary  = document.getElementById('heroSummary');
  const navSearch    = document.getElementById('navSearch');
  const navResults   = document.getElementById('navResults');
  const navMap       = document.getElementById('navMap');
  const IDLE_COPY    = 'Score the roads around any place, then build a drive from the best of them.';

  // Search and Results are first-class workspaces in the primary nav. Tapping
  // the already-open workspace acts as a minimise toggle and returns to Map.
  navSearch?.addEventListener('click', () => {
    const alreadyOpen = usesMobileWorkspace()
      ? state.ui?.mobileWorkspace === 'search'
      : state.ui?.searchPanel === 'open';
    if (alreadyOpen) {
      if (!showMobileWorkspace('map', 'nav-search-toggle-close')) {
        setPanelState({ searchPanel: 'collapsed', resultsPanel: 'collapsed' }, 'nav-search-toggle-close');
      }
      return;
    }
    if (!showMobileWorkspace('search', 'nav-search')) {
      setPanelState({ searchPanel: 'open', resultsPanel: 'collapsed' }, 'nav-search');
    }
  });

  navResults?.addEventListener('click', () => {
    const alreadyOpen = usesMobileWorkspace()
      ? state.ui?.mobileWorkspace === 'results'
      : state.ui?.resultsPanel === 'open';
    if (alreadyOpen) {
      if (!showMobileWorkspace('map', 'nav-results-toggle-close')) {
        setPanelState({ searchPanel: 'collapsed', resultsPanel: 'collapsed' }, 'nav-results-toggle-close');
      }
      return;
    }
    if (!showMobileWorkspace('results', 'nav-results')) {
      setPanelState({ searchPanel: 'collapsed', resultsPanel: 'open' }, 'nav-results');
    }
  });

  // Map: get the panels out of the way and refit whatever is on screen.
  navMap?.addEventListener('click', () => {
    if (!showMobileWorkspace('map', 'nav-map')) {
      setPanelState({ searchPanel: 'collapsed', resultsPanel: 'collapsed' }, 'nav-map');
    }
    try {
      smoothInvalidateSize();
      setTimeout(() => {
        if (state.selectedId !== null && focusSelectedMapItem(state.selectedId, { force: true })) return;
        const bounds = roadLayers.getBounds();
        if (bounds && bounds.isValid()) focusRoadBounds(bounds, { force: true, scope: 'results', accountForPane: false });
        else map.invalidateSize();
      }, usesMobileWorkspace() ? MOBILE_WORKSPACE_TRANSITION_MS : 0);
    } catch (e) { /* map not ready yet */ }
  });

  function syncNav(){
    const view = usesMobileWorkspace() ? (state.ui?.mobileWorkspace || 'search') :
      (state.ui?.resultsPanel === 'open' ? 'results' : state.ui?.searchPanel === 'open' ? 'search' : 'map');
    syncPrimaryNav(view);
  }

  // The hero reports the current search the way the MyGarage hero reports the
  // current car: where you are, how much was found, and how good the best of it is.
  function syncHero(){
    syncNav();
    if (!heroSummary) return;

    const meta = state.lastSearchMeta;
    if (!state.hasSearched || !meta){
      heroSummary.textContent = IDLE_COPY;
      return;
    }

    const isRoutes = state.currentTab === 'routes';
    const items = isRoutes ? (state.masterRoutes || []) : (state.masterRoads || []);
    const place = (meta.addrTo ? `${meta.addr} → ${meta.addrTo}` : meta.addr) || 'your location';

    if (!items.length){
      heroSummary.textContent = `Nothing found around ${place} yet.`;
      return;
    }

    const best = items.reduce((top, item) => Math.max(top, Number(item.score) || 0), 0);
    const noun = isRoutes
      ? `${items.length} route${items.length === 1 ? '' : 's'}`
      : `${items.length} road${items.length === 1 ? '' : 's'}`;
    const where = meta.addrTo ? place : `within ${meta.distKm} km of ${place}`;

    heroSummary.innerHTML =
      `<strong>${escapeHtml(noun)}</strong> ${escapeHtml(where)} · best score <strong>${escapeHtml(String(best))}</strong>`;
  }

  // When the sheet is collapsed its contents — including the count — are hidden,
  // so the handle itself has to say how much is waiting behind it.
  function syncSheetToggle(){
    const label = document.querySelector('.sheet-toggle__text');
    if (!label) return;
    const isRoutes = state.currentTab === 'routes';
    const items = isRoutes ? (state.masterRoutes || []) : (state.masterRoads || []);
    label.textContent = (state.hasSearched && items.length)
      ? `Results · ${items.length}`
      : 'Results';
  }

  // updateCount already fires on every state change that matters, so the hero
  // follows it rather than duplicating the render triggers.
  const baseUpdateCount = updateCount;
  updateCount = function(text){
    baseUpdateCount(text);
    const pill = document.getElementById('toolbarCount');
    if (pill) pill.dataset.tone = /^(0|Ready|No )/.test(String(text)) ? 'empty' : 'full';
    try { syncHero(); syncSheetToggle(); } catch (e) { /* pre-init */ }
  };

  // The hero scrolls when the route builder adds a second step card. Show a
  // fade only while there is actually more below, so it reads as an
  // affordance rather than decoration.
  const hero = document.getElementById('topSearchPanel');
  const collapsible = hero?.querySelector('.top-collapsible');
  function syncScrollHint(){
    if (!hero || !collapsible) return;
    const more = collapsible.scrollHeight - collapsible.clientHeight - collapsible.scrollTop;
    hero.classList.toggle('has-more', more > 12);
  }
  collapsible?.addEventListener('scroll', syncScrollHint, { passive: true });
  window.addEventListener('resize', syncScrollHint);
  if (window.ResizeObserver && collapsible) new ResizeObserver(syncScrollHint).observe(collapsible);
  setInterval(syncScrollHint, 600);

  // Switching mode swaps the cards inside the hero; start that new content at
  // the top rather than wherever the previous card was scrolled to.
  ['searchKindRoads','searchKindRoutes','searchKindA2b'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      requestAnimationFrame(() => {
        if (collapsible) collapsible.scrollTop = 0;
        syncScrollHint();
      });
    });
  });

  syncHero();
  syncScrollHint();
})();
