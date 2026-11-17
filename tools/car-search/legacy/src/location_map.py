"""On-demand, cached UK car-advert location lookup for the map view.

Uses Postcodes.io only when the user opens the map. No background postcode
harvesting, invented locations or external requests from the browser.
Locations are public advert text and pins indicate approximate area centres.
"""
import asyncio
import json
import math
import os
import re
import time
from pathlib import Path
from urllib.parse import quote

import httpx

UK_LAT = (49.0, 61.5)
UK_LON = (-9.0, 2.6)
POSTCODE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b", re.I)
OUTCODE = re.compile(r"^[A-Z]{1,2}\d[A-Z\d]?$", re.I)
DISTANCE_SUFFIX = re.compile(r"\s*\(\s*(\d{1,4}(?:\.\d+)?)\s*(?:miles?|mi)\s*\)\s*$", re.I)


def distance_hint(raw):
    match = DISTANCE_SUFFIX.search(raw) if isinstance(raw, str) else None
    if not match:
        return None
    miles = float(match.group(1))
    return miles if 0 < miles < 900 else None


def cache_key(raw):
    cleaned = clean_location(raw).casefold()
    miles = distance_hint(raw)
    # v2 avoids reusing older negative results that ignored settlement type
    # and gave ambiguous names like Hayes the wrong candidate.
    return cleaned + ("|%.1fmi|placev3" % miles if miles else "|placev3")



PLACE_KINDS = {"capital city": 0, "city": 1, "town": 2, "village": 3,
               "hamlet": 4, "suburban area": 5, "other settlement": 6}
IGNORED = {"", "unknown", "not specified", "n/a", "uk", "united kingdom",
           "nationwide", "online", "various", "location not provided"}


def clean_location(raw):
    if not isinstance(raw, str):
        return ""
    text = re.sub(r"\s+", " ", raw).strip(" ,;:-")
    # The distance describes the search postcode, not the seller town.
    text = DISTANCE_SUFFIX.sub("", text).strip(" ,;:-")
    # Sites also show "Sutton Coldfield · 28 miles away", or
    # "Stoke-on-Trent, England, United Kingdom".
    text = re.sub(r"\s*(?:[·|\-]\s*)?\d{1,4}(?:\.\d+)?\s*(?:miles?|mi)\s*(?:away|from you)?\s*$", "", text, flags=re.I).strip(" ,;:-")
    text = re.sub(r"(?:,?\s*(?:United Kingdom|UK|England|Scotland|Wales|Northern Ireland))+$",
                  "", text, flags=re.I).strip(" ,;:-")
    text = re.sub(r"^(?:located in|location\s*:|based in|near|in)\s+", "", text, flags=re.I)
    text = re.sub(r"\s*(?:[·,;|–—-]\s*)?multiple locations\s*$", "", text, flags=re.I)
    text = re.sub(r"\s*\(\s*multiple locations\s*\)\s*$", "", text, flags=re.I)
    # A real named place beats an appended full/outward postcode. Retain
    # *postcode-only* input so it can still locate an approximate area.
    postcode = POSTCODE.search(text)
    without_postcodes = POSTCODE.sub("", text)
    without_postcodes = re.sub(r"\b[A-Z]{1,2}\d[A-Z\d]?\b", "", without_postcodes, flags=re.I)
    without_postcodes = re.sub(r"\s*[,;|·]\s*[,;|·]\s*", ", ", without_postcodes)
    without_postcodes = without_postcodes.strip(" ,;|·:-")
    if without_postcodes and re.search(r"[a-z]", without_postcodes, re.I):
        text = without_postcodes
    elif postcode:
        text = postcode.group(1)
    elif OUTCODE.fullmatch(text):
        text = text.upper()
    if not text or len(text) > 120 or text.casefold() in IGNORED:
        return ""
    return text


def place_request(raw):
    """Return (type, value, disambiguation), never infer a postcode from title."""
    text = clean_location(raw)
    if not text:
        return None
    full = POSTCODE.search(text)
    if full:
        return ("postcode", re.sub(r"\s+", "", full.group(1)).upper(), "")
    pieces = [piece.strip(" ,.;") for piece in text.split(",") if piece.strip(" ,.;")]
    if not pieces:
        return None
    for piece in pieces[:2]:
        if OUTCODE.fullmatch(piece.upper()):
            return ("outcode", piece.upper(), "")
    # Do not guess a UK town from a long advert description.
    name = pieces[0]
    if len(name) > 65 or not re.fullmatch(r"[A-Za-zÀ-ÿ '\-]+", name):
        return None
    if name.casefold() in IGNORED:
        return None
    hint = pieces[1].casefold() if len(pieces) > 1 else ""
    return ("place", name.strip(), hint)


def valid_point(obj, precision, label):
    if not isinstance(obj, dict):
        return None
    try:
        lat, lon = float(obj["latitude"]), float(obj["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    if not UK_LAT[0] <= lat <= UK_LAT[1] or not UK_LON[0] <= lon <= UK_LON[1]:
        return None
    return {"lat": round(lat, 6), "lng": round(lon, 6),
            "precision": precision, "label": label}


def great_circle_miles(a_lat, a_lng, b_lat, b_lng):
    lat1, lon1, lat2, lon2 = (math.radians(v) for v in (a_lat, a_lng, b_lat, b_lng))
    a = math.sin((lat2 - lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2 - lon1)/2)**2
    return 3958.8 * 2 * math.asin(min(1, math.sqrt(a)))


def find_place(results, name, hint, distance=None, origin=None):
    """Resolve official UK settlement names, using advertised miles as a clue.

    Distance from the source search postcode is approximate; it is never a
    postcode or precise seller coordinate. An ambiguous result remains
    unplaced rather than picking the first city/town or a random Hayes.
    """
    if not isinstance(results, list):
        return None
    key = name.casefold().strip()
    exact = [r for r in results if isinstance(r, dict) and any(
        isinstance(r.get(field), str) and r[field].casefold() == key
        for field in ("name_1", "name_2")) and r.get("local_type", "").casefold() in PLACE_KINDS]
    if not exact:
        return None
    if hint:
        matched = [r for r in exact if any(
            hint == str(r.get(field) or "").casefold() or
            hint in str(r.get(field) or "").casefold().split(",")
            for field in ("county_unitary", "district_borough", "region", "country"))]
        if matched:
            exact = matched
    # Use known advertised distance BEFORE sorting by settlement category.
    # "Hayes" near London can be a suburban area while another Hayes is a
    # village. Prioritising village/town type would ignore a 157-mile hint.
    if len(exact) > 1 and distance is not None and origin is not None:
        choices = []
        for row in exact:
            point = valid_point(row, "", name)
            if point:
                delta = abs(great_circle_miles(origin["lat"], origin["lng"],
                                              point["lat"], point["lng"]) - distance)
                choices.append((delta, row))
        choices.sort(key=lambda entry: entry[0])
        if not choices or choices[0][0] > max(15, distance * .33):
            return None
        # Closely ranked towns remain ambiguous: road distances, seller
        # search anchors and city-centre coordinates are only approximations.
        if len(choices) > 1 and choices[1][0] - choices[0][0] < max(6, distance * .065):
            return None
        chosen = choices[0][1]
        precision = "Town centre inferred from advertised distance (approx.)"
    elif len(exact) == 1:
        chosen = exact[0]
        precision = "Town or city centre (approx.)"
    else:
        # Without corroborating miles or a county there is no safe way to
        # select one of multiple UK places with the same name.
        return None
    return valid_point(chosen, precision, str(chosen.get("name_1") or name))


class LocationResolver:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.cache = None
        self.cache_file = None
        self.origin_lock = asyncio.Lock()
        self.origin_coords = None
        self.origin_postcode = None

    def _load_cache(self, file):
        if self.cache is not None and file == self.cache_file:
            return
        self.cache_file = file
        try:
            obj = json.loads(file.read_text())
            self.cache = obj if isinstance(obj, dict) else {}
        except (FileNotFoundError, ValueError, OSError):
            self.cache = {}

    def _save_cache(self):
        path = self.cache_file
        path.parent.mkdir(parents=True, exist_ok=True)
        # Only keep recent cache entries; negative results expire separately.
        if len(self.cache) > 6000:
            self.cache = dict(sorted(self.cache.items(),
                key=lambda pair: pair[1].get("checked", 0), reverse=True)[:5000])
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.cache, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)

    async def _origin(self, client):
        """The advertised distance is interpreted only against a known search postcode."""
        postcode = re.sub(r"\s+", "", os.getenv("MAP_ORIGIN_POSTCODE",
            os.getenv("AUTOTRADER_POSTCODE", "M1 1AE"))).upper()
        if self.origin_postcode == postcode:
            return self.origin_coords
        async with self.origin_lock:
            if self.origin_postcode == postcode:
                return self.origin_coords
            try:
                response = await client.get(
                    "https://api.postcodes.io/postcodes/" + quote(postcode, safe=""))
                self.origin_coords = valid_point(response.json().get("result"), "", postcode) if response.status_code == 200 else None
            except (httpx.HTTPError, ValueError, AttributeError):
                self.origin_coords = None
            self.origin_postcode = postcode
            return self.origin_coords

    async def _lookup(self, client, request):
        kind, value, hint, *extra = request
        miles = extra[0] if extra else None
        if kind == "postcode":
            url = "https://api.postcodes.io/postcodes/" + quote(value, safe="")
            precision = "Postcode centroid (approx.)"
        elif kind == "outcode":
            url = "https://api.postcodes.io/outcodes/" + quote(value, safe="")
            precision = "Postcode district centre (approx.)"
        else:
            url = "https://api.postcodes.io/places"
            precision = "Town or city centre (approx.)"
        try:
            response = await client.get(url, params={"q": value, "limit": 75} if kind == "place" else None)
            if response.status_code == 404:
                return None, True
            if response.status_code != 200:
                return None, False
            result = response.json().get("result")
            if kind == "place":
                origin = await self._origin(client) if miles is not None else None
                return find_place(result, value, hint, distance=miles, origin=origin), True
            # Postcodes.io gives administrative place names alongside the
            # postcode coordinates. Show an area name, never a raw postcode,
            # in marker captions and location dialogs.
            locality = value
            if isinstance(result, dict):
                locality = next((str(result.get(k)).strip() for k in
                    ("parish", "admin_ward", "admin_district", "region")
                    if result.get(k) and str(result[k]).strip().casefold() not in
                    ("unparished area", "unparished", "none")), "Advertised area")
            return valid_point(result, precision, locality), True
        except (httpx.HTTPError, ValueError, AttributeError, TypeError):
            return None, False

    async def resolve(self, locations, data_dir=None):
        """Return a matching result for each advertised location, including misses."""
        if not isinstance(locations, list) or len(locations) > 30 or any(
            not isinstance(loc, str) or len(loc) > 120 for loc in locations
        ):
            raise ValueError("Resolve at most 30 short listing locations per request.")
        data = Path(data_dir or os.getenv("DATA_DIR", "data"))
        cache_path = data / "location-map-cache.json"
        async with self.lock:
            self._load_cache(cache_path)
            now = time.time()
            pending = {}
            output = {}
            for location in locations:
                raw = clean_location(location)
                if not raw:
                    output[location] = None
                    continue
                key = cache_key(location)
                cached = self.cache.get(key)
                if cached and (cached.get("point") is not None or now - cached.get("checked", 0) < 86400):
                    output[location] = cached.get("point")
                else:
                    request = place_request(raw)
                    if request:
                        pending[key] = (*request, distance_hint(location))
                    else:
                        output[location] = None
            if pending:
                # Modest parallelism, manual map-only lookups, persisted cache.
                semaphore = asyncio.Semaphore(3)
                async with httpx.AsyncClient(timeout=7.0, follow_redirects=False,
                         headers={"User-Agent": "CarSearchHub/3.9 location-map (postcodes.io)"}) as client:
                    async def work(key, request):
                        async with semaphore:
                            point, definitive = await self._lookup(client, request)
                            return key, point, definitive
                    found = await asyncio.gather(*(work(k, v) for k, v in pending.items()))
                updated = False
                for key, point, definitive in found:
                    if definitive:
                        self.cache[key] = {"point": point, "checked": now}
                        updated = True
                if updated:
                    try:
                        self._save_cache()
                    except OSError:
                        pass  # Map can still display resolved locations without disk access.
                for location in locations:
                    key = cache_key(location)
                    if key in pending:
                        row = next((x for x in found if x[0] == key), None)
                        output[location] = row[1] if row else None
            return [{"location": loc, "point": output.get(loc)} for loc in locations]
