(function () {
  'use strict';

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function createEmptyState({ title, message, tone = 'quiet', actionLabel = '', secondaryLabel = '' }) {
    const safeTone = ['quiet','error','warning'].includes(tone) ? tone : 'quiet';
    const wrap = el('div', `empty-state dh-state dh-state--${safeTone}`);
    const icon = safeTone === 'error'
      ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 17h.01"></path></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 21 11 3M17 21 13 3M9.3 13h5.4M10.2 8h3.6M8.5 17h7"></path></svg>';
    wrap.innerHTML = `<div class="dh-state__icon" aria-hidden="true">${icon}</div><h3></h3><p></p><div class="dh-state__actions" hidden></div>`;
    wrap.querySelector('h3').textContent = title || '';
    wrap.querySelector('p').textContent = message || '';
    const actions = wrap.querySelector('.dh-state__actions');
    if (actionLabel) {
      const button = el('button', 'dh-state__action');
      button.type = 'button'; button.dataset.stateAction = 'primary'; button.textContent = actionLabel;
      actions.appendChild(button);
    }
    if (secondaryLabel) {
      const button = el('button', 'dh-state__action dh-state__action--secondary');
      button.type = 'button'; button.dataset.stateAction = 'secondary'; button.textContent = secondaryLabel;
      actions.appendChild(button);
    }
    actions.hidden = !actions.children.length;
    return wrap;
  }

  function bindCard(card, handlers) {
    const { onSelect, onHover, onFavourite, onExport } = handlers || {};
    card.querySelectorAll('a, button, .apex-score-control, .score-help').forEach((node) => {
      node.addEventListener('click', (event) => event.stopPropagation());
    });
    const favourite = card.querySelector('[data-fav-id]');
    const activateFavourite = (event) => {
      event.preventDefault();
      event.stopPropagation();
      onFavourite?.();
    };
    favourite?.addEventListener('click', activateFavourite);
    favourite?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activateFavourite(event);
    });
    card.querySelector('[data-export-route]')?.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onExport?.(); });
    card.addEventListener('click', () => onSelect?.());
    card.addEventListener('mouseenter', () => onHover?.(true));
    card.addEventListener('mouseleave', () => onHover?.(false));
    return card;
  }

  function createRoadCard(model, handlers) {
    const card = el('article', `road-card${model.isExcluded ? ' excluded' : ''}`);
    card.dataset.itemId = model.id;
    card.innerHTML = `
      <div class="road-top road-card__header">
        <div class="road-card__identity">
          <div class="road-card__title-row">
            <h3 class="road-name">
              <span class="road-name-text" style="--road-accent:${model.accent}">${model.name}</span>
              <span class="road-speed-chip">${model.speed}</span>
              ${model.speedEstimated ? '<span class="road-estimated">estimated</span>' : ''}
            </h3>
            <div class="mobile-inline-nav" aria-label="Navigation options">
              <a href="${model.startUrl}" target="_blank" rel="noopener noreferrer" class="mobile-nav-pill">Start</a>
              <a href="${model.endUrl}" target="_blank" rel="noopener noreferrer" class="mobile-nav-pill">Drive</a>
            </div>
            <div class="road-card__badges">${model.badgesHtml || ''}</div>
          </div>
          <div class="road-meta">${model.length} km · ${model.tierLabel} · <span class="confidence-text confidence-${String(model.confidenceLabel||'medium').toLowerCase()}">${model.confidenceLabel || 'Medium'} data confidence</span></div>
        </div>
        <div class="road-card-actions">
          ${model.scoreControlHtml}
          <svg class="fav-icon ${model.favouriteClass}" viewBox="0 0 24 24" data-fav-id="${model.id}" role="button" tabindex="0" aria-label="${model.favouriteLabel}" width="20" height="20" fill="${model.favouriteFill}" stroke="${model.favouriteStroke}" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
      </div>
      <div class="btn-row desktop-nav-row">
        <a href="${model.startUrl}" target="_blank" rel="noopener noreferrer" class="action-btn nav-compact-btn"><span>Navigate to start</span></a>
        <a href="${model.endUrl}" target="_blank" rel="noopener noreferrer" class="action-btn nav-compact-btn"><span>Open drive</span></a>
      </div>`;
    return bindCard(card, handlers);
  }

  function createLoadMoreButton({ remaining, increment = 50, onClick }) {
    const wrap = el('div', 'load-more-wrap');
    const button = el('button', 'action-btn load-more-btn');
    button.type = 'button';
    button.innerHTML = `Load ${increment} more roads <span>(${remaining} remaining)</span>`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick?.();
    });
    wrap.appendChild(button);
    return wrap;
  }


  function createRouteCard(model, handlers) {
    const card = el('article', 'road-card route-card');
    card.dataset.itemId = model.id;
    card.style.setProperty('--route-accent', model.accent);
    const roads = (model.roads || []).map((road) => `
      <div class="route-road-row${road.isGood ? '' : ' connector'}">
        <span>${road.name}${road.isGood ? '' : ' (connector)'}</span>
      </div>`).join('');
    card.innerHTML = `
      <div class="road-top route-card__header">
        <div class="route-card__identity">
          <div class="route-title-row">
            <h3 class="road-name route-card__name">${model.name}</h3>
            <span class="route-kind-pill">${model.kindLabel}</span>
          </div>
          <div class="road-meta">${model.length} km ${model.kindDescription} · ${model.tierLabel} · ${model.goodRoads} rated road${model.goodRoads === 1 ? '' : 's'} · <span class="confidence-text confidence-${String(model.confidenceLabel||'medium').toLowerCase()}">${model.confidenceLabel || 'Medium'} confidence</span></div>
        </div>
        <svg class="fav-icon ${model.favouriteClass}" viewBox="0 0 24 24" data-fav-id="${model.id}" role="button" tabindex="0" aria-label="${model.favouriteLabel}" width="20" height="20" fill="${model.favouriteFill}" stroke="${model.favouriteStroke}" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </div>
      <div class="route-metrics">
        <div class="metric"><span class="metric-label">Avg score</span><span class="metric-value metric-value--large">${model.score}</span></div>
        <div class="metric"><span class="metric-label">Drive time</span><span class="metric-value">${model.time}</span></div>
        <div class="metric"><span class="metric-label">Rated-road coverage</span><span class="metric-value">${model.coverage}<span class="metric-unit">%</span></span></div>
      </div>
      ${model.reason ? `<div class="route-rationale"><span>Why this route</span><strong>${model.reason}</strong></div>` : ''}
      <div class="btn-row desktop-nav-row">
        <a href="${model.startUrl}" target="_blank" rel="noopener noreferrer" class="action-btn nav-compact-btn"><span>Navigate to start</span></a>
        <a href="${model.routeUrl}" target="_blank" rel="noopener noreferrer" class="action-btn nav-compact-btn"><span>Open route</span></a>
        <button type="button" data-export-route="true" class="action-btn nav-compact-btn route-export-btn"><span>Export GPX</span></button>
      </div>
      <details class="route-road-list">
        <summary>Included roads</summary>
        <div class="route-road-list__items">${roads}</div>
      </details>`;
    return bindCard(card, handlers);
  }

  function createDiagnosticsPanel(model, handlers) {
    const panel = el('details', 'road-diagnostics-panel');
    panel.innerHTML = `
      <summary class="diagnostics-summary">
        <span><strong>Processed road diagnostics</strong><small>Shows every processed road and why it is or is not visible.</small></span>
        <span class="diagnostics-total">${model.processed} processed</span>
      </summary>
      <div class="diagnostics-body">
        <div class="diagnostics-stats">
          <div><strong>${model.valid}</strong><small>valid final roads</small></div>
          <div><strong>${model.excluded}</strong><small>excluded/rejected</small></div>
          <div><strong>${model.filtered}</strong><small>hidden by filters</small></div>
          <div><strong>${model.merged}</strong><small>merged/not final cards</small></div>
        </div>
        <p>If a road is visible on the base map but not listed here, it was not returned by the map-data fetch or was ignored before processing.</p>
        ${model.limitMessage ? `<p class="diagnostics-warning">${model.limitMessage}</p>` : ''}
        <div class="diagnostics-rows">${model.rowsHtml}</div>
        ${model.footer ? `<div class="diagnostics-footer">${model.footer}</div>` : ''}
      </div>`;
    panel.addEventListener('click', (event) => {
      const row = event.target.closest('[data-debug-road-id]');
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      handlers?.onSelectRoad?.(row.dataset.debugRoadId);
    });
    return panel;
  }

  window.RoadFinderUIRenderers = {
    createEmptyState,
    createRoadCard,
    createRouteCard,
    createDiagnosticsPanel,
    createLoadMoreButton,
    bindCard
  };
  window.ApexUIRenderers = window.RoadFinderUIRenderers; // legacy alias
})();
