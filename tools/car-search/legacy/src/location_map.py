"""On-demand, cached UK car-advert location lookup for the map view.

Uses Postcodes.io only when the user opens the map. No background postcode
harvesting, invented locations or external requests from the browser.
Locations are public advert text and pins indicate approximate area centres.
"""
import asyncio
from difflib import SequenceMatcher
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
DISTANCE_SUFFIX = re.compile(
    r"\s*(?:\(\s*(\d{1,4}(?:\.\d+)?)\s*(?:miles?|mi)\s*\)"
    r"|[·,;|–—-]\s*(\d{1,4}(?:\.\d+)?)\s*(?:miles?|mi)\s*(?:away|from you)?"
    r")\s*$", re.I)


def distance_hint(raw):
    match = DISTANCE_SUFFIX.search(raw) if isinstance(raw, str) else None
    if not match:
        return None
    miles = float(match.group(1) or match.group(2))
    return miles if 0 < miles < 900 else None


def cache_key(raw):
    cleaned = clean_location(raw).casefold()
    miles = distance_hint(raw)
    # Refresh lookups made before ambiguous exact names could receive pins.
    postcode = POSTCODE.search(raw) if isinstance(raw, str) else None
    exact = ("|postcode:" + re.sub(r"\s+", "", postcode.group(1)).casefold()) if postcode else ""
    # Keep postcode, county and distance clues in the lookup identity even
    # though the card's display label omits them.
    return cleaned + exact + ("|%.1fmi|placev5" % miles if miles else "|placev5")



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
    """Return (type, value, disambiguation), preserving full postcodes."""
    full = POSTCODE.search(raw) if isinstance(raw, str) else None
    if full:
        return ("postcode", re.sub(r"\s+", "", full.group(1)).upper(), "")
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


def find_place_detailed(results, name, hint, distance=None, origin=None):
    """Return a defensible approximate settlement and an explanation code."""
    if not isinstance(results, list):
        return None, "unmatched"
    key = " ".join(name.casefold().split())
    exact = [row for row in results if isinstance(row, dict) and
             row.get("local_type", "").casefold() in PLACE_KINDS and any(
                 isinstance(row.get(field), str) and
                 " ".join(row[field].casefold().split()) == key
                 for field in ("name_1", "name_2"))]
    near_match = False
    if not exact:
        # Only accept high-confidence name variants; never pick an arbitrary
        # fuzzy match from a set of different towns.
        simplified = lambda value: re.sub(r"[^a-z0-9]", "", value.casefold())
        target = simplified(name)
        similar = []
        for row in results:
            if not isinstance(row, dict) or row.get("local_type", "").casefold() not in PLACE_KINDS:
                continue
            names = (row.get("name_1"), row.get("name_2"))
            if any(isinstance(candidate, str) and
                   (simplified(candidate) == target or
                    (len(target) >= 6 and
                     SequenceMatcher(None, target, simplified(candidate)).ratio() >= .92))
                   for candidate in names):
                similar.append(row)
        exact = similar
        near_match = bool(similar)
    if not exact:
        return None, "unmatched"
    if hint:
        matching = [row for row in exact if any(
            hint == str(row.get(field) or "").casefold() or
            hint in str(row.get(field) or "").casefold().split(",")
            for field in ("county_unitary", "district_borough", "region", "country"))]
        if matching:
            exact = matching
    exact = [row for row in exact if valid_point(row, "", name)]
    if not exact:
        return None, "unmatched"
    precision = ("Town or locality name matched approximately" if near_match
                 else "Town or city centre") + " (approx.)"
    if len(exact) == 1:
        chosen = exact[0]
    else:
        choices = []
        if distance is not None and origin is not None:
            for row in exact:
                delta = abs(great_circle_miles(origin["lat"], origin["lng"],
                                              float(row["latitude"]), float(row["longitude"])) - distance)
                choices.append((delta, row))
            choices.sort(key=lambda entry: entry[0])
        plausible_distance = choices and choices[0][0] <= max(15, distance * .33)
        if plausible_distance and choices[1][0] - choices[0][0] >= max(6, distance * .065):
            chosen = choices[0][1]
            precision = "Town centre inferred from advertised distance (approx.)"
        elif near_match:
            return None, "ambiguous"
        else:
            # Prefer the closest plausible mileage, then the largest settlement type.
            # For equally ranked places, keep the geocoder's order.
            ranked = [row for delta, row in choices if delta == choices[0][0]] if plausible_distance else exact
            chosen = min(ranked, key=lambda row: PLACE_KINDS[row["local_type"].casefold()])
            area = chosen.get("district_borough") or chosen.get("county_unitary")
            precision = "Best guess (approx.)" + (f" · {area}" if area else "")
    point = valid_point(chosen, precision, str(chosen.get("name_1") or name))
    return (point, "mapped") if point else (None, "unmatched")


def find_place(results, name, hint, distance=None, origin=None):
    return find_place_detailed(results, name, hint, distance, origin)[0]


LOCATION_STATUS = {
    "mapped": "Approximate advertised area located.",
    "missing": "This advert does not provide a usable location.",
    "ambiguous": "Several UK places match this name. A postcode or county would help.",
    "unmatched": "No reliable UK place match was found for the advertised location.",
    "invalid_postcode": "The advertised postcode could not be found.",
    "unsupported": "The advertised location cannot be interpreted as a UK place.",
    "temporary": "The location service could not be reached. Please retry.",
}


class LocationResolver:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.cache = None
        self.cache_file = None
        self.origin_lock = asyncio.Lock()
        self.origin_coords = None
        self.origin_postcode = None
        self.lookup_status = {}

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
        fallback = extra[1] if len(extra) > 1 else None

        def finish(point, definitive, status=None):
            self.lookup_status[request] = (status or ("mapped" if point else
                                                     "unmatched" if definitive else "temporary"))
            return point, definitive

        if kind == "postcode":
            url = "https://api.postcodes.io/postcodes/" + quote(value, safe="")
            precision = "Postcode centroid (approx.)"
        elif kind == "outcode":
            url = "https://api.postcodes.io/outcodes/" + quote(value, safe="")
            precision = "Postcode district centre (approx.)"
        else:
            url = "https://api.postcodes.io/places"
            precision = "Town or city centre (approx.)"

        async def postcode_fallback():
            # Wrong full postcode need not hide the correctly named town.
            if fallback:
                secondary = (*fallback, miles)
                point, definitive = await self._lookup(client, secondary)
                return finish(point, definitive, self.lookup_status.get(secondary))
            return finish(None, True, "invalid_postcode")

        try:
            response = await client.get(url, params={"q": value, "limit": 100}
                                        if kind == "place" else None)
            if response.status_code == 404:
                return await postcode_fallback() if kind == "postcode" else finish(
                    None, True, "invalid_postcode" if kind == "outcode" else "unmatched")
            if response.status_code != 200:
                return finish(None, False, "temporary")
            result = response.json().get("result")
            if kind == "place":
                origin = await self._origin(client) if miles is not None else None
                point, status = find_place_detailed(result, value, hint, miles, origin)
                return finish(point, True, status)
            if not isinstance(result, dict):
                return await postcode_fallback() if kind == "postcode" else finish(
                    None, True, "invalid_postcode")
            locality = next((str(result.get(k)).strip() for k in
                ("parish", "admin_ward", "admin_district", "region")
                if result.get(k) and str(result[k]).strip().casefold() not in
                ("unparished area", "unparished", "none")), "Advertised area")
            point = valid_point(result, precision, locality)
            return finish(point, True, "mapped" if point else "invalid_postcode")
        except (httpx.HTTPError, ValueError, AttributeError, TypeError):
            return finish(None, False, "temporary")

    async def resolve(self, locations, data_dir=None, *, retry=False):
        """Resolve locations with diagnostics; explicit retry skips negative cache."""
        if not isinstance(locations, list) or len(locations) > 30 or any(
            not isinstance(loc, str) or len(loc) > 120 for loc in locations
        ):
            raise ValueError("Resolve at most 30 short listing locations per request.")
        data = Path(data_dir or os.getenv("DATA_DIR", "data"))
        cache_path = data / "location-map-cache.json"
        async with self.lock:
            self._load_cache(cache_path)
            self.lookup_status = {}
            now = time.time()
            pending = {}
            output = {}
            for location in locations:
                raw = clean_location(location)
                if not raw:
                    status = "missing" if not str(location).strip() or str(location).strip().casefold() in IGNORED else "unsupported"
                    output[location] = (None, status)
                    continue
                key = cache_key(location)
                cached = self.cache.get(key)
                if cached and (cached.get("point") is not None or
                    (not retry and now - cached.get("checked", 0) < 86400)):
                    point = cached.get("point")
                    output[location] = (point, cached.get("status") or
                        ("mapped" if point else "unmatched"))
                else:
                    request = place_request(location)
                    if request:
                        # Full postcodes are tried before the named locality,
                        # but a bad postcode can still fall back to a town.
                        fallback = None
                        if request[0] == "postcode":
                            town = place_request(raw)
                            if town and town[0] == "place":
                                fallback = town
                        pending[key] = (*request, distance_hint(location), fallback)
                    else:
                        output[location] = (None, "unsupported")
            if pending:
                semaphore = asyncio.Semaphore(3)
                async with httpx.AsyncClient(timeout=7.0, follow_redirects=False,
                        headers={"User-Agent": "CarSearchHub/4.0 location-map (postcodes.io)"}) as client:
                    async def work(key, request):
                        async with semaphore:
                            point, definitive = await self._lookup(client, request)
                            status = self.lookup_status.get(request,
                                     "mapped" if point else
                                     "unmatched" if definitive else "temporary")
                            return key, point, definitive, status
                    found = await asyncio.gather(*(work(k, v) for k, v in pending.items()))
                updated = False
                results = {key: (point, status) for key, point, _, status in found}
                for key, point, definitive, status in found:
                    # Upstream errors are never saved as permanent misses.
                    if definitive:
                        self.cache[key] = {"point": point, "status": status,
                                           "checked": now}
                        updated = True
                if updated:
                    try:
                        self._save_cache()
                    except OSError:
                        pass
                for location in locations:
                    key = cache_key(location)
                    if key in pending:
                        output[location] = results.get(key, (None, "temporary"))
            return [
                {"location": loc, "point": output.get(loc, (None, "missing"))[0],
                 "status": output.get(loc, (None, "missing"))[1],
                 "reason": LOCATION_STATUS.get(
                     output.get(loc, (None, "missing"))[1],
                     LOCATION_STATUS["unmatched"]),
                 "retryable": output.get(loc, (None, "missing"))[1] not in
                     ("mapped", "missing")}
                for loc in locations
            ]
