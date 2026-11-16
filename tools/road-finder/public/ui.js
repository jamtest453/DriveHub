(function () {
  'use strict';

  const ids = [
    'sidebar','sheetToggle','locateBtn','searchForm','addr','dist','addrTo','a2bToSlot','a2bDivider','radiusLabel',
    'searchKindRoads','searchKindRoutes','searchKindA2b','debugSearchWrap','debugSearchInput','debugSearchResults','searchBtn','routeSearchBtn',
    'roadSearchControls','routeSearchControls','roadSearchHint','routeSearchHint','routeMinRange','routeMaxRange','routeMinValue',
    'routeMaxValue','filtersSection','filterChips','routeFilters','minRouteDist','maxRouteDist',
    'resultsTitle','results','toolbarCount','scoringToggle','scoringPanel','debugToggle','useCacheToggle','liveLocationBtn','debugLabel',
    'navSearch','navResults','navMap','topSearchPanel','topToggleBtn'
  ];

  function collectElements() {
    const elements = {};
    ids.forEach((id) => {
      const key = id === 'topSearchPanel' ? 'topPanel' : id;
      elements[key] = document.getElementById(id);
    });
    return elements;
  }

  function setBusy(isBusy, message) {
    document.body.classList.toggle('is-busy', Boolean(isBusy));
    window.DriveHubChrome?.setBusy?.(isBusy ? (message || 'Working…') : '');
  }

  window.RoadFinderUI = {
    elements: collectElements(),
    refreshElements() {
      this.elements = collectElements();
      return this.elements;
    },
    enhance() {},
    setBusy
  };
  window.ApexUI = window.RoadFinderUI; // legacy alias for older embedded builds
})();
