"""Convert supported UK car-search URLs into editable Car Search Hub criteria.

Pure URL parsing: does not visit the website, follow redirects, infer vehicle
identity from numeric category IDs, or retain the pasted URL in saved state.
Unknown or site-only options are reported so the owner can review them.
"""
import re
from urllib.parse import parse_qsl, urlsplit

from .query_builder import COLOURS, validate_filters
from .scanner import clean_url, site_for

# Parameter naming differs per provider, including casing and punctuation.
def _key(raw):
    return re.sub(r"[^a-z0-9]", "", raw.casefold())


PARAMETERS = {
    "priceMin": ("pricefrom", "minprice", "pricemin", "minimumprice", "udlo"),
    "priceMax": ("priceto", "maxprice", "pricemax", "maximumprice", "udhi"),
    "mileageMin": ("minimum mileage", "mileagemin", "minmileage", "mileagefrom"),
    "mileageMax": ("maximummileage", "mileagemax", "maxmileage", "mileageto"),
    "yearMin": ("yearfrom", "minyear", "yearmin", "minimumyear"),
    "yearMax": ("yearto", "maxyear", "yearmax", "maximumyear"),
    "engineMin": ("enginesizefrom", "minenginesize", "enginemin", "enginefrom"),
    "engineMax": ("enginesizeto", "maxenginesize", "enginemax", "engineto"),
    "bhpMin": ("powerfrom", "minbhp", "bhpmin", "minpower"),
    "bhpMax": ("powerto", "maxbhp", "bhpmax", "maxpower"),
}
PARAMETERS = {field: {_key(alias) for alias in aliases} for field, aliases in PARAMETERS.items()}
TEXT_KEYS = {"keywords", "keyword", "query", "q", "nkw", "search", "searchterm", "searchterms"}
MAKE_KEYS = {"make", "manufacturer"}
MODEL_KEYS = {"model"}
TRIM_KEYS = {"aggregatedtrim", "trim", "variant", "derivative"}
TRANSMISSION_KEYS = {"transmission", "gearbox", "transmissiontype"}
COLOUR_KEYS = {"colour", "colours", "color", "colors", "exteriorcolour", "exteriorcolor"}
LOCATION_KEYS = {"postcode", "radius", "location", "advertisinglocation", "distance",
                 "latitude", "longitude", "lat", "lng", "long", "city", "region"}
NON_CRITERIA_KEYS = {
    "channel", "sort", "sortby", "sortorder", "page", "pagesize", "pgn", "sop",
    "sacat", "price search type", "pricesearchtype", "view", "viewtype", "searchid",
    "exclude writeoff categories", "excludewriteoffcategories", "srp", "ref",
    "category", "categoryid", "pagination", "results", "searchtype", "searchradius",
}
NON_CRITERIA_KEYS = {_key(key) for key in NON_CRITERIA_KEYS}
COLOUR_ALIASES = {"gray": "grey", "grey": "grey", "other": "other",
                  "metallicgrey": "grey", "metallicgray": "grey"}
TRANSMISSION_ALIASES = {
    "automatic": "automatic", "auto": "automatic", "semiautomatic": "automatic",
    "dct": "automatic", "dsg": "automatic", "pdk": "automatic", "tiptronic": "automatic",
    "manual": "manual",
}
NAME_KEY_LABELS = {"makeid", "modelid", "variantid", "derivativeid"}
SITE_LABELS = {"autotrader": "Auto Trader", "ebay": "eBay",
               "pistonheads": "PistonHeads", "facebook": "Facebook Marketplace"}


def _number(value):
    text = str(value).strip().replace(",", "").replace("£", "").replace(" ", "")
    if not re.fullmatch(r"\d+(?:\.\d+)?", text):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _search_page(site, path):
    path = path.rstrip("/").casefold() or "/"
    if site == "autotrader":
        return path in ("/car-search", "/cars")
    if site == "ebay":
        return path == "/sch" or path.startswith("/sch/")
    if site == "pistonheads":
        return path in ("/buy", "/buy/search")
    if site == "facebook":
        return path == "/marketplace/search" or (
            path.startswith("/marketplace/") and path.endswith("/vehicles"))
    return False


def _name(value):
    return " ".join(str(value).replace("_", " ").split()).strip(" ,;:-")


def parse_search_url(raw):
    """Return name, normalised filters and reviewer warnings for a provider URL.

    This creates an editable structured search. Generated links are not identical
    to the original provider URL; unsupported provider-specific options are
    disclosed instead of silently claiming they have been retained.
    """
    if not isinstance(raw, str) or len(raw) > 4000:
        raise ValueError("Paste a supported car-search URL (up to 4,000 characters).")
    url = clean_url(raw.strip())
    if not url:
        raise ValueError("Use an HTTPS search URL from Auto Trader, eBay, PistonHeads or Facebook Marketplace.")
    site = site_for(url)
    parsed = urlsplit(url)
    if not _search_page(site, parsed.path):
        raise ValueError("This looks like an individual advert or another page. Paste a car search results URL.")
    try:
        pairs = parse_qsl(parsed.query, keep_blank_values=False, max_num_fields=160)
    except ValueError as exc:
        raise ValueError("This search URL has too many parameters to import safely.") from exc
    if not pairs:
        raise ValueError("The URL has no search parameters to import.")
    values = {}
    original_names = {}
    for key, value in pairs:
        normal = _key(key)
        if not normal or len(value) > 600:
            continue
        values.setdefault(normal, []).append(value.strip())
        original_names.setdefault(normal, key)
    if not values:
        raise ValueError("There are no usable search parameters in this URL.")

    warnings, applied, consumed = [], [], set()
    raw_filters = {}
    for field, keys in PARAMETERS.items():
        found = [(key, item) for key in keys for item in values.get(key, [])]
        if not found:
            continue
        consumed.update(key for key, _ in found)
        numeric = [_number(item) for _, item in found]
        if any(value is None for value in numeric):
            warnings.append(f"{field}: unsupported numeric value; check this filter manually.")
            continue
        if len(set(numeric)) > 1:
            warnings.append(f"{field}: conflicting URL values; check this filter manually.")
            continue
        raw_filters[field] = numeric[0]
        applied.append(field)

    makes = [item for key in MAKE_KEYS for item in values.get(key, [])]
    models = [item for key in MODEL_KEYS for item in values.get(key, [])]
    consumed.update(MAKE_KEYS & values.keys())
    consumed.update(MODEL_KEYS & values.keys())
    # Omit numeric IDs: they cannot be safely converted to a name from the URL alone.
    make = _name(makes[0]) if makes else ""
    model = _name(models[0]) if models else ""
    # A named model parameter can legitimately contain a number (911, 997).
    # Only *numeric manufacturer* values are untrustworthy; IDs use separate
    # "make-id"/"model-id" keys and are reported below.
    if make.isdigit():
        warnings.append("The URL contains a numeric manufacturer identifier. Enter the car name manually.")
        make, model = "", ""
    elif len(set(makes)) > 1 or len(set(models)) > 1:
        warnings.append("Several makes/models are selected; review the car name.")
    vehicle = _name(" ".join(part for part in (make, model) if part))
    if vehicle:
        applied.append("car name (make/model)")

    phrases = [(key, item) for key in TEXT_KEYS for item in values.get(key, [])]
    consumed.update(TEXT_KEYS & values.keys())
    raw_query = _name(phrases[0][1]) if phrases else ""
    if len({v for _, v in phrases}) > 1:
        warnings.append("Multiple keyword queries found; using the first.")
    if raw_query:
        if not vehicle:
            vehicle = raw_query
            applied.append("car name (search query)")
        elif raw_query.casefold() != vehicle.casefold():
            # A site's text filter has stricter meaning than the generic car
            # name. If the phrase starts with the already specified make/model,
            # extract the remaining required qualifier.
            remainder = (raw_query[len(vehicle):].strip() if
                         raw_query.casefold().startswith(vehicle.casefold() + " ") else raw_query)
            if remainder:
                raw_filters["requiredKeywords"] = remainder
                applied.append("required keywords")
                warnings.append("Extra source keyword text was imported as a required phrase; review it.")

    # Auto Trader expresses important model variants separately from 'model'.
    # Without mapping aggregatedTrim, a Porsche 911 / 996 Carrera 4S URL
    # becomes an overly broad all-generation Porsche 911 search.
    trim_values = [(key, item) for key in TRIM_KEYS for item in values.get(key, [])]
    consumed.update(TRIM_KEYS & values.keys())
    if trim_values:
        trims = [_name(item) for _, item in trim_values if _name(item)]
        if len(set(trims)) > 1:
            warnings.append("Several trims/variants are selected; review the required keywords.")
        if trims:
            trim = trims[0]
            generation = re.match(r"^(996|997|991|992|986|987|981|982|718)\s+(.+)$", trim, re.I)
            # Split generation and derivative into searchable phrases. A single
            # contiguous phrase like '996 Carrera 4S' is rarely present verbatim
            # in adverts on other providers.
            terms = [generation.group(1), generation.group(2)] if generation else [trim]
            existing = raw_filters.get("requiredKeywords", "")
            raw_filters["requiredKeywords"] = ", ".join(
                part for part in [existing, *terms] if part)
            applied.append("trim / variant (required keywords)")
            warnings.append("Variant terms are required advert-text matches. Some listings omit generation codes; review these keywords if results are too narrow.")

    colours = []
    for key in COLOUR_KEYS & values.keys():
        consumed.add(key)
        for raw_colour in values[key]:
            for piece in re.split(r"[,;|]+", raw_colour):
                normal = _key(piece)
                colour = COLOUR_ALIASES.get(normal, normal)
                if colour in COLOURS:
                    if colour not in colours:
                        colours.append(colour)
                else:
                    warnings.append(f"Unrecognised exterior colour '{piece[:35]}'; review it manually.")
    if colours:
        raw_filters["colours"] = colours
        applied.append("exterior colour")

    for key in TRANSMISSION_KEYS & values.keys():
        consumed.add(key)
        transmissions = {TRANSMISSION_ALIASES.get(_key(value))
                         for value in values[key]}
        if len(transmissions) == 1 and None not in transmissions:
            raw_filters["transmission"] = transmissions.pop()
            applied.append("transmission")
        else:
            warnings.append("Transmission options could not be mapped reliably; review them.")
        break

    if any(key in values for key in LOCATION_KEYS):
        consumed.update(LOCATION_KEYS & values.keys())
        warnings.append("Location/postcode and search radius are not transferred. Generated searches use the app's normal UK-wide coverage.")

    id_parameters = NAME_KEY_LABELS & values.keys()
    if id_parameters:
        consumed.update(id_parameters)
        warnings.append("Site-specific numeric make/model/variant IDs cannot be translated reliably; review the vehicle name.")

    ignored = []
    for key, display in original_names.items():
        if key in consumed or key in NON_CRITERIA_KEYS:
            continue
        if (key.startswith(("utm", "fbclid", "gclid", "gbraid", "wbraid", "yclid"))
                or key in {"fbsource", "refsrc", "tracking", "source", "campaign"}):
            continue
        ignored.append(display[:55])
    if ignored:
        names = ", ".join(sorted(set(ignored), key=str.casefold)[:12])
        warnings.append("Unsupported URL parameters not imported: " + names +
                        (" and others." if len(set(ignored)) > 12 else "."))

    if len(vehicle) > 90:
        warnings.append("Search phrase is longer than 90 characters; shorten the car name before saving.")
        vehicle = ""
    try:
        # Imported provider URLs cannot describe DriveHub's own
        # include-unknown option. Keep the application's checked-by-default
        # behaviour instead of silently making imported colours strict.
        raw_filters.setdefault("includeUnknownColours", True)
        filters = validate_filters(raw_filters)
    except ValueError as exc:
        # Inconsistent limits must never produce a misleading accepted import.
        raise ValueError("The URL contains invalid or incompatible filters: " + str(exc)) from exc
    if not vehicle:
        warnings.insert(0, "Could not identify a car name from this URL. Enter one before saving.")
    if not applied and not vehicle and not id_parameters:
        raise ValueError("No supported vehicle criteria could be read from this URL. Try a search URL with keywords or make/model.")
    return {"site": site, "siteLabel": SITE_LABELS[site], "name": vehicle,
            "filters": filters, "applied": applied, "warnings": warnings}
