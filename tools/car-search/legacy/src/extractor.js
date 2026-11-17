/* Runs only in the opened search-result tab, in Chrome's isolated extension world. */
(() => {
  const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
  const tidy = str => String(str || '').replace(/\s+/g, ' ').trim();
  const money = str => {
    const match = String(str || '').match(/(?:£|GBP\s*)(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{2})?/i);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    return amount > 100 && amount < 10000000 ? amount : null;
  };
  const mileage = str => {
    const text = String(str || '');
    const possibilities = [...text.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{1,6})\s*(?:miles?\b|mi\b)/gi)]
      .map(match => {
        const value = Number(match[1].replace(/,/g,''));
        const before = text.slice(Math.max(0,match.index-32),match.index);
        const after = text.slice(match.index+match[0].length,match.index+match[0].length+24);
        const explicitlyOdometer = /(?:mileage|odometer|on the clock|miles driven)\s*[:\-]?\s*$/i.test(before);
        const distanceAway = /\(\s*$/.test(before) && /^\s*\)/.test(after) ||
          /^\s*(?:away|from|distant)\b/i.test(after) ||
          /(?:distance|from seller|from dealer)\s*[:\-]?\s*$/i.test(before);
        return {value, confidence: explicitlyOdometer ? 3 : distanceAway ? 0 : value>=1000 ? 2 : 1};
      })
      .filter(candidate => candidate.value>=0 && candidate.value<1000000 && candidate.confidence>0)
      .sort((a,b) => b.confidence-a.confidence);
    return possibilities.length ? possibilities[0].value : null;
  };
  const year = str => {
    const all = [...String(str || '').matchAll(/\b(19[89]\d|20[0-2]\d)\b/g)];
    return all.length ? Number(all[0][1]) : null;
  };
  const patterns = {
    autotrader: /\/car-details\/(\d{8,})/i,
    ebay: /\/itm\/(?:[^/?#]+\/)?(\d{8,15})(?=[/?#]|$)/i,
    pistonheads: /\/buy\/listing\/(\d+)/i,
    facebook: /\/marketplace\/item\/(\d+)/i
  };
  function listingUrl(url, site) {
    try {
      const u = new URL(url, document.location.href);
      const m = u.pathname.match(patterns[site]);
      if (!m) return null;
      const host = u.hostname.toLowerCase();
      if (site === 'autotrader' && !/(^|\.)autotrader\.co\.uk$/.test(host)) return null;
      if (site === 'ebay' && !/(^|\.)ebay\.(?:co\.uk|com)$/.test(host)) return null;
      if (site === 'pistonheads' && !/(^|\.)pistonheads\.com$/.test(host)) return null;
      if (site === 'facebook' && !/(^|\.)facebook\.com$/.test(host)) return null;
      const canonicalPath = site === 'autotrader' ? '/car-details/' + m[1] : site === 'ebay' ? '/itm/' + m[1] : site === 'pistonheads' ? '/buy/listing/' + m[1] : '/marketplace/item/' + m[1] + '/';
      return { id: site + ':' + m[1], url: u.origin + canonicalPath };
    } catch { return null; }
  }
  function pageText(el) { return tidy(el && (el.innerText || el.textContent || '')); }
  function uniqueListings(container, site) {
    const keys = new Set();
    container.querySelectorAll('a[href]').forEach(a => {
      const item = listingUrl(a.href, site);
      if (item) keys.add(item.id);
    });
    return keys.size;
  }
  function findCard(anchor, site) {
    const preferred = site === 'ebay' ? anchor.closest('li.s-item, .s-card, [data-view]')
      : anchor.closest('article, [data-testid*="listing"], [data-testid*="advert"], [data-testid*="result"], [class*="ListingCard"], [class*="listing-card"]');
    if (preferred && uniqueListings(preferred, site) === 1 && pageText(preferred).length < 4000) return preferred;
    let el = anchor;
    let best = anchor;
    for (let i = 0; i < 9 && el && el !== document.body; i++, el = el.parentElement) {
      const count = uniqueListings(el, site);
      if (count > 1) break;
      const text = pageText(el);
      if (text.length > 20 && text.length < 2300 && (money(text) || el.querySelector('img'))) best = el;
      if (text.length > 40 && text.length < 1700 && money(text) && el.querySelector('img')) break;
    }
    return best;
  }
  function findPrice(card, site) {
    const selectors = site === 'ebay' ? ['.s-item__price', '[class*="price"]']
      : ['[data-testid*="price"]', '[class*="Price"]', '[class*="price"]'];
    for (const selector of selectors) {
      for (const el of card.querySelectorAll(selector)) {
        const value = pageText(el);
        // Ignore monthly payments and unrelated price/range widgets.
        if (/per month|\/mo\b|pcm\b|monthly/i.test(value)) continue;
        const found = money(value);
        if (found) return found;
      }
    }
    return money(pageText(card));
  }
  function findTitle(card, anchor, site) {
    const selectors = site === 'ebay' ? ['.s-item__title', '[class*="item-title"]']
      : site === 'autotrader' ? ['[data-testid*="title"]', 'h3', 'h2', '[class*="title"]']
      : site === 'pistonheads' ? ['h3', 'h2', '[class*="title"]']
      : ['[data-testid*="title"]', '[dir="auto"]'];
    for (const selector of selectors) {
      const found = [...card.querySelectorAll(selector)].map(pageText).find(text =>
        text.length >= 8 && text.length <= 200 && !/^(sponsored|featured|image|video|promoted|£\s*[\d,]+)$/i.test(text) && !/^\d{1,3} miles?$/i.test(text));
      if (found) return found;
    }
    const aText = pageText(anchor);
    if (aText.length >= 8 && aText.length <= 170 && !/^£/.test(aText)) return aText;
    const lines = String(card.innerText || card.textContent || '').split(/[\n\r]+/).map(tidy);
    const line = lines.find(text => text.length >= 9 && text.length < 150 &&
      !/^£/.test(text) && !/^\d[\d,]*\s*(miles?|mi)\b/i.test(text) &&
      !/^(sponsored|promoted|free delivery|save|message|seller details|image|video|automatic|manual|petrol|diesel)$/i.test(text));
    if (line) return line;
    const img = card.querySelector('img[alt]');
    return tidy(img?.alt || 'Vehicle listing').slice(0, 200);
  }
  function findImage(card) {
    const candidates = [...card.querySelectorAll('img')];
    const likely = candidates.find(img => img.naturalWidth >= 180 && img.naturalHeight >= 90)
      || candidates.find(img => (img.getAttribute('src') || img.getAttribute('data-src') || '').startsWith('http'));
    if (!likely) return '';
    const src = likely.currentSrc || likely.src || likely.getAttribute('data-src') || '';
    return /^https?:\/\//i.test(src) ? src : '';
  }
  function facebookLocationFromCard(card, title) {
    // Marketplace cards often show [price] [title] [town] as plain text
    // lines, with no data-testid or location CSS class. Use only a line
    // within the SAME listing card, after its title.
    const lines = String(card.innerText || '').split(/[\r\n]+/).map(tidy).filter(Boolean);
    const normalizedTitle = tidy(title).toLowerCase();
    const titleAt = lines.findIndex(line => line.toLowerCase() === normalizedTitle);
    const priceAt = lines.findIndex(line => /^£\s*\d/.test(line));
    const start = titleAt >= 0 ? titleAt + 1 : Math.max(0, priceAt + 2);
    for (const line of lines.slice(start, start + 6)) {
      if (line.length < 3 || line.length > 75 || !/[a-z]/i.test(line)) continue;
      if (/^(?:(?:save|share|follow|message|listed|seller|sponsored|promoted|delivery|view|sold|free)\b|£|mark as\b)/i.test(line)) continue;
      if (/^(?:new|used|new listing|used car|used cars)$/i.test(line)) continue;
      if (/\b(?:miles?|km|bhp|hp|engine|automatic|manual|petrol|diesel|gearbox|transmission|euro\s*\d)\b/i.test(line)) continue;
      if (/\d{4}\s+\w+|\b(?:bmw|audi|porsche|mercedes|jaguar|ford|volkswagen|lotus)\b/i.test(line)) continue;
      if (!/^[\p{L}\p{M} .,'’\-]+(?:,\s*(?:United Kingdom|UK))?$/u.test(line)) continue;
      if (line.trim().split(/\s+/).length > 7) continue;
      return line;
    }
    return '';
  }
  function findExteriorColour(card) {
    // Use a specifically labelled EXTERIOR/PAINT field; search-card copy
    // often describes black leather seats, alloys and brake calipers.
    for (const selector of [
      '[itemprop="color"]', '[data-testid*="exterior-colour"]',
      '[data-testid*="exterior-color"]', '[data-testid*="body-colour"]',
      '[data-testid*="body-color"]', '[data-testid*="paint-colour"]',
      '[data-testid*="paint-color"]', '[data-qa*="exterior-colour"]'
    ]) {
      const field = card.querySelector(selector);
      const value = field && pageText(field).replace(/^(?:exterior|body|paint)\s*(?:colour|color)\s*[:\-]?\s*/i,'').trim();
      if (value && value.length < 70) return value;
    }
    const lines = String(card.innerText || '').split(/[\r\n]+/);
    for (const line of lines) {
      // Anchor to the beginning so "Interior colour: Black" cannot count.
      const match = line.match(/^\s*(?:(?:exterior|body|paint)\s*)?(?:colour|color)\s*[:\-]\s*(.{2,55})$/i);
      if (match && !/\b(?:interior|leather|seats?|wheels?|alloys?|calipers?|trim)\b/i.test(match[1]))
        return tidy(match[1]);
    }
    return '';
  }
  function findBodyType(card) {
    // Trust only a specifically labelled body-style field. Model names and
    // free-text descriptions can refer to multiple possible body shapes.
    for(const selector of [
      '[itemprop="bodyType"]','[data-testid*="body-type"]',
      '[data-testid*="body-style"]','[data-qa*="body-type"]',
      '[data-qa*="body-style"]'
    ]) {
      const node=card.querySelector(selector);
      const value=node && pageText(node).replace(/^body\s*(?:type|style)\s*[:\-]?\s*/i,'').trim();
      if(value && value.length<65) return value;
    }
    for(const line of String(card.innerText||'').split(/[\r\n]+/)) {
      const match=line.match(/^\s*body\s*(?:type|style)\s*[:\-]\s*(.{3,55})\s*$/i);
      if(match) return tidy(match[1]);
    }
    return '';
  }
  function findTransmission(card) {
    const text = pageText(card);
    if (/\b(?:dct|dsg|pdk|cvt|tiptronic|steptronic|automatic|auto gearbox|dual.clutch)\b/i.test(text))
      return 'automatic';
    if (/\b(?:manual gearbox|\d.speed manual|manual transmission|6mt)\b/i.test(text))
      return 'manual';
    return '';
  }
  function findLocation(card, site, title) {
    const selectors = [
      '[data-testid*="location"]', '[data-testid*="Location"]',
      '[class*="Location"]', '[class*="location"]',
      '.s-item__location', '[itemprop="addressLocality"]',
      '[itemprop="postalCode"]', '[data-testid*="dealer-town"]',
      '[data-testid*="seller-town"]', '[data-testid*="postcode"]',
      '[data-qa*="location"]', '[data-qa*="seller-town"]'
    ];
    for (const selector of selectors) {
      const el = card.querySelector(selector);
      if (!el) continue;
      const name = pageText(el).replace(/^(?:Located in|Location:|Based in)\s*/i,'').trim();
      if (name && name.length <= 100) return name;
    }
    // Only fall back to explicit location text or a postcode actually
    // present within this single advert card. Never infer a town from title.
    const raw = String(card.innerText || '');
    for (const pattern of [
      /(?:^|\n)\s*(?:Location|Dealer location|Seller location)\s*:\s*([^\n]{2,85})/i,
      /(?:^|\n)\s*(?:Located in|Based in)\s+([^\n]{2,85})/i
    ]) {
      const match = raw.match(pattern);
      if (match) return tidy(match[1]).slice(0,85);
    }
    const postcode = raw.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
    if (postcode) return postcode[0];
    if (site === 'facebook') return facebookLocationFromCard(card, title);
    // Some Auto Trader and PistonHeads cards render "Town (53 miles)"
    // with no location-labelled element. Match the whole line inside the
    // advert rather than guessing a place from the vehicle title.
    const lines=raw.split(/[\r\n]+/).map(tidy).filter(Boolean);
    for (const line of lines) {
      if (/^[\p{L}\p{M}][\p{L}\p{M} .,\-']{2,55}\s*\(\s*\d{1,4}\s*miles?\s*\)$/iu.test(line) &&
          !/\b(?:mileage|insurance|monthly|engine|warranty|finance)\b/i.test(line))
        return line;
    }
    return '';
  }
  function extract(site, maxResults) {
    const seen = new Set();
    const items = [];
    const anchors = document.querySelectorAll('a[href]');
    for (const anchor of anchors) {
      const info = listingUrl(anchor.href, site);
      if (!info || seen.has(info.id)) continue;
      const card = findCard(anchor, site);
      const text = pageText(card);
      const title = findTitle(card, anchor, site);
      if (!title || title.length < 3) continue;
      // Refuse clear navigation/link-only elements, but preserve results with temporarily unknown prices.
      if (text.length < 6) continue;
      seen.add(info.id);
      items.push({
        id: info.id, site, url: info.url, title: title.slice(0, 240),
        price: findPrice(card, site), image: findImage(card), year: year(title) || year(text),
        mileage: mileage(text), location: findLocation(card, site, title), transmission: findTransmission(card),
        colour: findExteriorColour(card),
        bodyType: findBodyType(card),
        description: text.slice(0, 900),
        registration: (text.match(/\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/) || [])[0] || ''
      });
      if (items.length >= maxResults) break;
    }
    return items;
  }
  window.__CSH_SCRAPE__ = async (site, maxResults = 350) => {
    if (!patterns[site]) return { items: [], error: 'Unsupported source' };
    for (let i = 0; i < 11; i++) {
      if (document.querySelectorAll('a[href*="/itm/"],a[href*="/car-details/"],a[href*="/buy/listing/"],a[href*="/marketplace/item/"]').length) break;
      await nap(600);
    }
    if (site === 'facebook') {
      // Marketplace is infinite-scroll: inspect what loads as we scroll, not only the first viewport.
      let last = 0;
      let idle = 0;
      for (let i = 0; i < 9 && idle < 3; i++) {
        const count = extract(site, maxResults).length;
        if (count === last) idle++; else idle = 0;
        last = count;
        if (count >= maxResults) break;
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        await nap(1000);
      }
      window.scrollTo(0, 0);
    } else {
      // Some listing cards and images are lazy-loaded.
      window.scrollTo({ top: Math.round(document.documentElement.scrollHeight / 2), behavior: 'instant' });
      await nap(450);
      window.scrollTo(0, 0);
    }
    const items = extract(site, maxResults);
    const txt = pageText(document.body).slice(0, 1500);
    const challenge = /captcha|unusual traffic|confirm you(?:'|’)re human|temporarily blocked|access denied|security check|log in to facebook|log into facebook/i.test(txt);
    return { items, title: document.title, blocked: !!(challenge && !items.length),
      noResults: /(?:0 results|no cars found|no results found|we couldn.t find|no listings found)/i.test(txt) };
  };
})();
