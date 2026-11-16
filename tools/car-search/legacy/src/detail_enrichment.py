"""Read a saved advert once to fill genuinely missing fields.

Runs only after the owner saves a car. Prefer the existing eBay Browse API;
other supported listing sites use the authenticated/public Playwright page.
Never fabricate specs, overwrite recorded prices/notes, or visit arbitrary URLs.
"""
import os
import re
from urllib.parse import urlsplit

import httpx
from playwright.async_api import async_playwright

from .ebay_api import access_token
from .query_builder import specs
from .scanner import facebook_context, site_for, unsafe_host

DETAIL_JS = r"""() => {
  const text = (node) => String(node?.innerText || node?.textContent || '').trim();
  const meta = key => document.querySelector('meta[property="'+key+'"],meta[name="'+key+'"]')?.content || '';
  const pick = selectors => {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found && text(found)) return text(found).slice(0,160);
    }
    return '';
  };
  let structured = {};
  for (const tag of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,12)) {
    if ((tag.textContent || '').length > 200000) continue;
    try {
      const parsed = JSON.parse(tag.textContent);
      const values = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      const obj = values.find(x => x && typeof x === 'object' &&
        /vehicle|car|product/i.test(String(x['@type'] || '')));
      if (obj) { structured = obj; break; }
    } catch {}
  }
  const location = pick(['[itemprop="addressLocality"]',
    '[data-testid*="location"]','[data-testid*="Location"]',
    '[class*="Location"]','[class*="seller-location"]',
    '[data-qa*="location"]']);
  const addr = structured.offers?.seller?.address || structured.seller?.address ||
               structured.address || {};
  const structuredLocation = typeof addr === 'string' ? addr :
    [addr.addressLocality, addr.postalCode].filter(Boolean).join(', ');
  const description = String(structured.description || meta('og:description') ||
    meta('description') || '').slice(0,1900);
  const body = (document.querySelector('main')?.innerText ||
    document.querySelector('[role="main"]')?.innerText ||
    document.body?.innerText || '').slice(0,7500);
  return {
    title: String(structured.name || meta('og:title') || document.title || '').slice(0,220),
    image: String((Array.isArray(structured.image) ? structured.image[0] :
                   typeof structured.image === 'string' ? structured.image :
                   structured.image?.url) || meta('og:image') || '').slice(0,1500),
    description, body, location: String(location || structuredLocation).slice(0,150),
    colour: String(structured.color || structured.vehicleColour || '').slice(0,40),
    transmission: String(structured.vehicleTransmission || '').slice(0,50),
    mileage: structured.mileageFromOdometer || null,
    year: structured.vehicleModelDate || structured.modelDate || null,
    engine: structured.engineDisplacement || null
  };
}"""


def number_from(text, pattern, cast=int):
    found = re.search(pattern, text, re.I)
    if not found:
        return None
    try:
        return cast(found.group(1).replace(",", ""))
    except (ValueError, TypeError):
        return None


def normalize_details(raw):
    if not isinstance(raw, dict):
        return {}
    title = str(raw.get("title") or "")[:220]
    body = str(raw.get("body") or "")[:7500]
    desc = str(raw.get("description") or "")[:1900]
    text = " ".join((title, desc, body))
    provided = raw.get("mileage")
    if isinstance(provided, dict):
        provided = provided.get("value")
    odometer = None
    if provided not in (None, ""):
        try:
            odometer = int(float(str(provided).replace(",", "")))
        except (ValueError, TypeError):
            pass
    if odometer is None:
        odometer = number_from(text, r"\b(\d{1,3}(?:,\d{3})+|\d{1,6})\s*(?:miles?|mi)\b")
    year = number_from(str(raw.get("year") or "") + " " + title,
                       r"\b(19[89]\d|20[0-2]\d)\b")
    if not year:
        year = number_from(desc, r"\b(19[89]\d|20[0-2]\d)\b")
    loc = str(raw.get("location") or "").strip()[:100]
    # Only use explicit location fields, not the first town-looking text in body.
    transmission = str(raw.get("transmission") or "").lower().strip()
    if transmission in ("automatic", "auto", "dct", "pdk", "dsg", "cvt"):
        transmission = "automatic"
    elif transmission in ("manual", "mt"):
        transmission = "manual"
    else:
        transmission = ""
    item = {"title": title, "description": desc or body[:1000],
            "transmission": transmission, "colour": raw.get("colour") or ""}
    details = specs(item)
    engine = raw.get("engine")
    if engine is not None:
        match = re.search(r"\b([1-9](?:\.\d+)?)", str(engine))
        if match:
            details["engine"] = float(match.group(1))
    out = {
        "title": title or None,
        "description": desc or body[:1000] or None,
        "image": raw.get("image") if str(raw.get("image") or "").startswith("https://") else None,
        "location": loc or None,
        "year": year,
        "mileage": odometer if isinstance(odometer,int) and 0 <= odometer <= 1000000 else None,
        "registration": (re.search(r"\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b", text, re.I) or [None])[0],
        "transmission": details.get("transmission"),
        "engine": details.get("engine"),
        "bhp": details.get("bhp"),
        "colour": details.get("colour"),
        "colourSource": details.get("colourSource"),
    }
    return {k:v for k,v in out.items() if v not in (None,"")}


async def read_ebay_detail(id):
    if not re.fullmatch(r"ebay:\d{8,15}", id):
        return {}
    async with httpx.AsyncClient(timeout=13.0, follow_redirects=False) as client:
        token = await access_token(client)
        response = await client.get(
            "https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id",
            params={"legacy_item_id":id.split(":",1)[1]},
            headers={"Authorization":"Bearer "+token, "X-EBAY-C-MARKETPLACE-ID":"EBAY_GB"})
        if response.status_code != 200:
            return {}
        item = response.json()
    aspects = {str(x.get("localizedName") or "").lower(): str((x.get("localizedValues") or [""])[0])
               for x in item.get("localizedAspects") or [] if isinstance(x,dict)}
    loc = item.get("itemLocation") or {}
    image = item.get("image") or {}
    return normalize_details({
        "title": item.get("title"), "description": item.get("description") or item.get("shortDescription"),
        "image": image.get("imageUrl"), "location": ", ".join(str(loc.get(k))
            for k in ("city","postalCode") if loc.get(k)),
        "transmission": aspects.get("transmission", ""),
        "colour": aspects.get("colour") or aspects.get("color"),
        "mileage": aspects.get("mileage") or aspects.get("odometer"),
        "engine": aspects.get("engine size") or aspects.get("engine"),
    })


async def read_browser_detail(record):
    site = record.get("site")
    url = str(record.get("url") or "")
    if site not in ("facebook","autotrader","pistonheads") or site_for(url) != site:
        return {}
    parsed = urlsplit(url)
    if parsed.scheme != "https" or unsafe_host(parsed.hostname):
        return {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH","/usr/bin/chromium"),
            headless=True, args=["--disable-dev-shm-usage"])
        try:
            if site == "facebook":
                context = await facebook_context(browser)
            else:
                context = await browser.new_context(locale="en-GB", timezone_id="Europe/London",
                    viewport={"width":1280,"height":900}, service_workers="block")
            try:
                page = await context.new_page()
                async def protect(route):
                    target = urlsplit(route.request.url)
                    if target.scheme not in ("https","http") or unsafe_host(target.hostname):
                        return await route.abort()
                    if (route.request.is_navigation_request() and
                        route.request.frame == page.main_frame and site_for(route.request.url) != site):
                        return await route.abort()
                    return await route.continue_()
                await page.route("**/*", protect)
                response = await page.goto(url,wait_until="domcontentloaded",timeout=27000)
                if response and response.status in (401,403,429):
                    return {}
                if site_for(page.url) != site or any(
                    x in urlsplit(page.url).path.lower()
                    for x in ("/login","/checkpoint","/two_factor")):
                    return {}
                await page.wait_for_timeout(1100)
                raw = await page.evaluate(DETAIL_JS)
                # A login shell or unrelated advert must not enrich a saved car.
                # Require some distinctive model text in the listing detail.
                original = str(record.get("title") or "")
                # A generic "Car from Auto Trader" placeholder is not a
                # vehicle identity. Do not require that phrase in the advert.
                if record.get("titleSource") == "placeholder":
                    source_path = urlsplit(url).path.rstrip("/")
                    final_path = urlsplit(page.url).path.rstrip("/")
                    if source_path != final_path:
                        return {}
                    heading = str(raw.get("title") or "").strip()
                    if (len(heading) < 12 or re.search(
                            r"\b(?:log\s*in|sign\s*in|access denied|"
                            r"verification|captcha|attention required)\b", heading, re.I)):
                        return {}
                    expected = []
                else:
                    expected = [x for x in re.findall(r"[a-z0-9]+", original.casefold())
                                if len(x) > 1 and not re.fullmatch(r"(?:19|20)\d{2}", x)
                                and x not in ("used","sale","euro","automatic","manual","car","coupe")]
                observed = set(re.findall(r"[a-z0-9]+",
                    (str(raw.get("title") or "") + " " + str(raw.get("description") or "")
                     + " " + str(raw.get("body") or "")[:500]).casefold()))
                if expected and not any(x in observed for x in expected):
                    return {}
                return normalize_details(raw)
            finally:
                await context.close()
        finally:
            await browser.close()


async def enrich_listing(record):
    """Returns parsed missing-field candidates; never changes stored records."""
    site = record.get("site")
    if site == "ebay":
        record_id = str(record.get("id") or "")
        if record.get("manuallyAdded"):
            # Manually added records have independent IDs; resolve the actual
            # eBay item identifier from the verified listing link.
            from .manual_cars import listing_url
            try:
                _, _, identity = listing_url(record.get("url"))
                record_id = identity
            except ValueError:
                return {}
        return await read_ebay_detail(record_id)
    return await read_browser_detail(record)
