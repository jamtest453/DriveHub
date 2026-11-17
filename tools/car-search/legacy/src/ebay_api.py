"""eBay UK Browse API integration. No website scraping or credential exposure."""
import asyncio
import base64
import os
import re
import time
from urllib.parse import parse_qs, urlsplit

import httpx

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"
SCOPE = "https://api.ebay.com/oauth/api_scope"
_token = ""
_expiry = 0.0
_lock = asyncio.Lock()

# eBay's web URL parameters are not identical to the Browse API filters.
# Unsupported refinements are explicitly called out; never imply full equivalence.
SUPPORTED_QUERY_KEYS = {
    "_nkw", "_sacat", "_udlo", "_udhi", "_sop", "_pgn", "_ipg",
    "LH_Auction", "LH_BIN", "LH_Classified", "LH_PrefLoc",
    "rt", "mkcid", "mkrid", "siteid", "campid", "customid", "toolid",
    "hash", "epid", "keyword", "LH_ItemCondition",
}
GENERIC_QUERY_KEYS = {"_from", "_trksid", "_odkw", "_osacat"}


def parse_ebay_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or not (
        parsed.hostname == "ebay.co.uk" or parsed.hostname.endswith(".ebay.co.uk")
        or parsed.hostname == "ebay.com" or parsed.hostname.endswith(".ebay.com")
    ):
        raise ValueError("Not an eBay search URL.")
    raw = parse_qs(parsed.query)
    def first(key):
        return (raw.get(key) or [""])[0].strip()
    q = first("_nkw") or first("keyword")
    category = first("_sacat")
    if not category:
        match = re.search(r"/(?:b|sch)/[^/?#]*/(\d{3,9})(?:/|$)", parsed.path)
        if match:
            category = match.group(1)
    if category and category not in ("0",) and not category.isdecimal():
        raise ValueError("eBay category ID is invalid.")
    if not q and (not category or category == "0"):
        raise ValueError("eBay API needs search keywords (_nkw) or a category (_sacat) in the saved URL.")
    # A car-search dashboard must not pollute results with parts and accessories.
    # 9801 is the UK eBay Cars category; preserve the explicit URL category if set.
    default_car_category = not category or category == "0"
    if default_car_category:
        category = "9801"
    filters = ["itemLocationCountry:GB"]
    low, high = first("_udlo"), first("_udhi")
    for v in (low, high):
        if v and not re.fullmatch(r"\d+(?:\.\d{1,2})?", v):
            raise ValueError("eBay price range is invalid.")
    if low or high:
        filters += ["price:[" + low + ".." + high + "]", "priceCurrency:GBP"]
    # Including classified advertisements is crucial for used-car searches.
    # Browse API defaults to FIXED_PRICE-only without this filter.
    formats = []
    if first("LH_Auction") == "1": formats.append("AUCTION")
    if first("LH_BIN") == "1": formats.append("FIXED_PRICE")
    if first("LH_Classified") == "1": formats.append("CLASSIFIED_AD")
    if not formats:
        formats = ["CLASSIFIED_AD", "FIXED_PRICE", "AUCTION"]
    filters.append("buyingOptions:{" + "|".join(formats) + "}")
    sort = {"10": "newlyListed", "15": "price", "16": "-price", "1": "endingSoonest"}.get(first("_sop"), "newlyListed")
    unsupported = sorted(k for k in raw if k not in SUPPORTED_QUERY_KEYS and k not in GENERIC_QUERY_KEYS)
    if first("LH_ItemCondition"):
        unsupported.append("LH_ItemCondition")
    if first("LH_PrefLoc") not in ("", "1"):
        unsupported.append("LH_PrefLoc")
    params = {"limit": 100, "sort": sort, "filter": ",".join(filters)}
    if q: params["q"] = q[:100]
    params["category_ids"] = category
    return params, sorted(set(unsupported))


def ebay_item(item):
    ids = str(item.get("legacyItemId") or "")
    if not re.fullmatch(r"\d{8,15}", ids):
        m = re.search(r"v1\|(\d{8,15})\|", str(item.get("itemId", "")))
        if m: ids = m.group(1)
    if not re.fullmatch(r"\d{8,15}", ids):
        return None
    title = str(item.get("title") or "").strip()
    if not title: return None
    price_obj = item.get("price") or {}
    if price_obj.get("currency") != "GBP": return None
    try:
        price = float(price_obj.get("value", ""))
    except (TypeError, ValueError):
        price = None
    if price is not None and (price <= 0 or price >= 10000000): price = None
    location = item.get("itemLocation") or {}
    image = item.get("image") or {}
    # Extended Browse API responses sometimes contain structured vehicle
    # specifics; only trust an expressly labelled exterior/vehicle colour.
    aspects = {str(row.get("localizedName") or "").casefold(): row.get("localizedValues") or []
               for row in (item.get("localizedAspects") or []) if isinstance(row, dict)}
    raw_colour = next((values[0] for label, values in aspects.items()
                       if label in ("exterior colour", "exterior color",
                                    "vehicle colour", "vehicle color", "colour", "color")
                       and values and isinstance(values[0], str)), "")
    raw_body_type = next((values[0] for label, values in aspects.items()
                          if label in ("body type", "body style", "bodystyle", "bodytype")
                          and values and isinstance(values[0], str)), "")
    desc = str(item.get("shortDescription") or "")
    text = title + " " + desc
    y = re.search(r"\b(19[89]\d|20[0-2]\d)\b", text)
    miles = re.search(r"\b(\d{1,3}(?:,\d{3})+|\d{1,6})\s*(?:miles?|mi)\b", text, re.I)
    return {
        "id": "ebay:" + ids,
        "site": "ebay",
        "url": "https://www.ebay.co.uk/itm/" + ids,
        "title": title[:240],
        "description": desc[:900],
        "price": price,
        "image": image.get("imageUrl") or "",
        "year": int(y.group(1)) if y else None,
        "mileage": int(miles.group(1).replace(",", "")) if miles else None,
        "location": ", ".join(str(location.get(k, "")) for k in ("city", "postalCode") if location.get(k)),
        "registration": "",
        "colour": raw_colour,
        "bodyType": raw_body_type,
    }


async def access_token(client):
    global _token, _expiry
    if _token and time.monotonic() < _expiry: return _token
    async with _lock:
        if _token and time.monotonic() < _expiry: return _token
        app_id = os.environ.get("EBAY_CLIENT_ID", "").strip()
        secret = os.environ.get("EBAY_CLIENT_SECRET", "").strip()
        if not app_id or not secret:
            raise ValueError("Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (production keys) in Railway Variables.")
        basic = base64.b64encode((app_id + ":" + secret).encode()).decode()
        response = await client.post(TOKEN_URL, data={"grant_type": "client_credentials", "scope": SCOPE},
            headers={"Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded"})
        if response.status_code != 200:
            raise ValueError("eBay OAuth failed (HTTP " + str(response.status_code) + "). Verify production API credentials.")
        data = response.json()
        if not data.get("access_token"):
            raise ValueError("eBay OAuth response contained no access token.")
        _token = data["access_token"]
        _expiry = time.monotonic() + max(60, int(data.get("expires_in", 7200)) - 120)
        return _token


async def scan_ebay_api(link, depth, stopped, progress):
    try:
        params, unsupported = parse_ebay_url(link["url"])
        seen = {}
        pages = 0
        caveats = []
        if unsupported:
            caveats.append("eBay API does not reproduce URL filters: " + ", ".join(unsupported[:12]))
        if not (parse_qs(urlsplit(link["url"]).query).get("_sacat")):
            caveats.append("No eBay category selected in the URL; restricted to UK Cars category 9801.")
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=False) as client:
            token = await access_token(client)
            headers = {"Authorization": "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
                       "Accept": "application/json"}
            for page_num in range(min(max(1, depth), 20)):
                if stopped():
                    caveats.append("Stopped early; previous listings preserved.")
                    break
                progress("eBay API · page " + str(page_num + 1))
                request_params = {**params, "offset": page_num * 100, "fieldgroups": "EXTENDED"}
                response = await client.get(SEARCH_URL, params=request_params, headers=headers)
                if response.status_code != 200:
                    # Do not fall back to the blocked website or silently delete prior results.
                    raise ValueError("eBay Browse API rejected search (HTTP " + str(response.status_code) +
                                     "). Check API access, category or filters.")
                data = response.json()
                if not isinstance(data, dict) or not isinstance(data.get("itemSummaries"), list):
                    if data.get("total") == 0:
                        pages += 1
                        break
                    raise ValueError("eBay returned no readable item summaries.")
                items = data["itemSummaries"]
                before = len(seen)
                for raw in items:
                    car = ebay_item(raw)
                    if car: seen[car["id"]] = car
                pages += 1
                if len(items) < 100 or not data.get("next"): break
                if len(seen) == before:
                    caveats.append("eBay returned no additional usable listings.")
                    break
        return {"ok": True, "items": list(seen.values()), "pagesRead": pages,
                "incomplete": bool(caveats), "caveat": "; ".join(caveats)}
    except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
        return {"ok": False, "error": str(exc)[:230]}
