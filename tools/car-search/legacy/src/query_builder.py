"""Provider-specific car searches from a single, validated set of vehicle filters.

Only enforce fields when listings actually expose them. Unknown specifications
remain visible and are marked unverified rather than silently excluded.
"""
import re
import os
from urllib.parse import urlencode
from .colour import COLOUR_CHOICES, listing_exterior_colour
from .body_type import BODY_TYPES, listing_body_type
from .vehicle_names import resolve_vehicle_query

SOURCES = ("autotrader", "ebay", "pistonheads", "facebook")
TRANSMISSIONS = ("any", "automatic", "manual")
COLOURS = COLOUR_CHOICES
NUMERIC = {
    "priceMin": (0, 1_000_000), "priceMax": (0, 1_000_000),
    "mileageMin": (0, 1_000_000), "mileageMax": (0, 1_000_000),
    "yearMin": (1950, 2035), "yearMax": (1950, 2035),
    "engineMin": (0.1, 12), "engineMax": (0.1, 12),
    "bhpMin": (1, 2000), "bhpMax": (1, 2000),
}


def normalise_keyword_phrases(value, label):
    """Keep comma-separated full words/phrases, never silently truncate."""
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError(f"{label} must be text (up to 500 characters).")
    terms = [" ".join(part.split()) for part in re.split(r"[,;\n\r]+", value)]
    terms = list(dict.fromkeys(part for part in terms if part))
    if len(terms) > 30 or any(len(part) > 80 for part in terms):
        raise ValueError(f"{label} supports at most 30 words or phrases, each up to 80 characters.")
    return ", ".join(terms)


def validate_filters(raw):
    if not isinstance(raw, dict):
        raise ValueError("Vehicle filters must be an object.")
    # Older saved searches used "keywords" for extra terms. Treat those as
    # preferred (never mandatory) until their owner edits the search.
    preferred = normalise_keyword_phrases(
        raw.get("preferredKeywords", raw.get("keywords", "")), "Preferred keywords")
    required = normalise_keyword_phrases(raw.get("requiredKeywords", ""), "Required keywords")
    excluded = normalise_keyword_phrases(raw.get("excludeKeywords", ""), "Exclude keywords")
    required_logic = raw.get("requiredKeywordLogic", "all")
    if required_logic not in ("all", "any") or not isinstance(required_logic, str):
        raise ValueError("Required keywords must use AND (all groups) or OR (any group).")
    transmission = raw.get("transmission") or "any"
    if not isinstance(transmission, str) or transmission.casefold() not in TRANSMISSIONS:
        raise ValueError("Choose any, automatic or manual transmission.")
    strict_colour = raw.get("strictColour", False)
    if not isinstance(strict_colour, bool):
        raise ValueError("Strict exterior colour must be on or off.")
    # Earlier releases silently admitted unknown-colour cars. The default is
    # now strict whenever a paint colour is selected. Users may explicitly
    # opt into including unknowns; a legacy strictColour=false is NOT opt-in.
    include_unknown = raw.get("includeUnknownColours", False)
    if not isinstance(include_unknown, bool):
        raise ValueError("Include unknown exterior colours must be on or off.")
    result = {"keywords": preferred,  # Legacy alias retained for old backups/clients.
              "requiredKeywords": required, "requiredKeywordLogic": required_logic,
              "preferredKeywords": preferred,
              "excludeKeywords": excluded, "colours": [], "bodyTypes": [],
              "transmission": transmission.casefold(),
              "strictColour": strict_colour, "includeUnknownColours": include_unknown}
    colours = raw.get("colours", [])
    if not isinstance(colours, list) or len(colours) > len(COLOURS) or any(
        not isinstance(c, str) or c.lower() not in COLOURS for c in colours
    ):
        raise ValueError("Choose valid colours.")
    result["colours"] = sorted(set(c.lower() for c in colours))
    body_types = raw.get("bodyTypes", [])
    if not isinstance(body_types, list) or len(body_types) > len(BODY_TYPES) or any(
        not isinstance(body, str) or body.casefold() not in BODY_TYPES
        for body in body_types
    ):
        raise ValueError("Choose valid vehicle body types.")
    result["bodyTypes"] = sorted(set(body.casefold() for body in body_types))
    # Keep the legacy flag in outgoing API responses for old clients,
    # while deriving it from the explicit include-unknown setting.
    if result["colours"]:
        result["strictColour"] = not include_unknown
    for key, (low, high) in NUMERIC.items():
        value = raw.get(key)
        if value in (None, ""):
            result[key] = None
            continue
        try:
            if isinstance(value, bool):
                raise ValueError
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid {key}.")
        if not low <= number <= high:
            raise ValueError(f"{key} must be between {low} and {high}.")
        if key.startswith("engine"):
            result[key] = round(number, 1)
        else:
            if int(number) != number:
                raise ValueError(f"{key} must be a whole number.")
            result[key] = int(number)
    for first, second in (("priceMin", "priceMax"), ("mileageMin", "mileageMax"),
                          ("yearMin", "yearMax"), ("engineMin", "engineMax"),
                          ("bhpMin", "bhpMax")):
        if result[first] is not None and result[second] is not None and result[first] > result[second]:
            raise ValueError(f"{first} cannot exceed {second}.")
    return result


def autotrader_postcode():
    """Configurable UK search anchor; nationwide radius prevents local-only results."""
    value = os.environ.get("AUTOTRADER_POSTCODE", "M1 1AE").strip().upper()
    if not re.fullmatch(r"[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}", value):
        raise ValueError("AUTOTRADER_POSTCODE must be a valid UK postcode, e.g. M1 1AE.")
    return value


def generate_links(filters, sources=SOURCES, search_name=None):
    sources = list(sources)
    if not sources or len(sources) > 4 or len(set(sources)) != len(sources) or any(
        source not in SOURCES for source in sources
    ):
        raise ValueError("Select at least one supported car website.")
    # Do not send preferred or required terms to the provider. Some sites
    # perform title-only keyword matching (Facebook) or treat every term as
    # mandatory, hiding otherwise valid cars with a matching description.
    # Fetch by vehicle identity, then apply required/excluded terms to
    # deduplicated groups and rank preferred matches in the dashboard.
    vehicle = " ".join(str(search_name if search_name is not None else filters.get("keywords", "")).split())
    if not vehicle:
        raise ValueError("Enter a car name or make/model to search.")
    combined = vehicle
    identity = resolve_vehicle_query(vehicle)
    links = []
    for site in sources:
        note = ""
        if site == "ebay":
            params = {"_nkw": combined, "_sacat": "9801", "_sop": "10"}
            if filters["priceMin"] is not None: params["_udlo"] = filters["priceMin"]
            if filters["priceMax"] is not None: params["_udhi"] = filters["priceMax"]
            url = "https://www.ebay.co.uk/sch/i.html?" + urlencode(params)
            note = "eBay uses its Browse API. Vehicle details beyond keywords and price are locally checked when available."

        elif site == "facebook":
            params = {"query": combined}
            if filters["priceMin"] is not None: params["minPrice"] = filters["priceMin"]
            if filters["priceMax"] is not None: params["maxPrice"] = filters["priceMax"]
            url = "https://www.facebook.com/marketplace/search/?" + urlencode(params)
            note = "Facebook title must contain search terms. Other filters checked locally if advertised."
        elif site == "autotrader":
            # Use genuine provider make/model filters where recognised. Any
            # unknown remainder is a keyword, never a guessed model value.
            params = {"channel": "cars", "postcode": autotrader_postcode(),
                      "radius": "1500", "sort": "relevance",
                      "price_search_type": "total",
                      "exclude-writeoff-categories": "on"}
            if identity:
                params["make"] = identity.make
                if identity.model:
                    params["model"] = identity.model
                elif identity.keywords:
                    params["keywords"] = identity.keywords
            else:
                params["keywords"] = combined
            if filters["priceMin"] is not None: params["price-from"] = filters["priceMin"]
            if filters["priceMax"] is not None: params["price-to"] = filters["priceMax"]
            if filters["yearMin"] is not None: params["year-from"] = filters["yearMin"]
            if filters["yearMax"] is not None: params["year-to"] = filters["yearMax"]
            if filters["mileageMax"] is not None: params["maximum-mileage"] = filters["mileageMax"]
            if filters.get("transmission") in ("automatic", "manual"):
                params["transmission"] = filters["transmission"].capitalize()
            # Auto Trader's search uses repeated 'colour' parameters for
            # multiple selected colours. A source-side colour constraint
            # would exclude genuine unknowns, so only add it for confirmed-
            # colour-only searches.
            if filters["colours"] and not filters["includeUnknownColours"]:
                params["colour"] = [colour.title() for colour in filters["colours"]]
            url = "https://www.autotrader.co.uk/car-search?" + urlencode(params, doseq=True)
            note = ("Auto Trader " + (
                "make/model filters" if identity and identity.model else
                "make and remaining keywords" if identity else "full keyword search"
            ) + " with nationwide coverage. Write-offs are also excluded locally; "
                "confirm vehicle history independently.")
            if filters["colours"] and not filters["includeUnknownColours"]:
                note += " Selected exterior colours are applied on Auto Trader."
        else:
            if identity:
                url = "https://www.pistonheads.com/buy/" + identity.make_slug
                if identity.model_slug:
                    # Known PistonHeads public make/model paths, not guessed IDs.
                    url += "/" + identity.model_slug
                    note = "PistonHeads make/model page; remaining search criteria are checked locally."
                elif identity.keywords or identity.model:
                    # An unrecognised model stays a keyword, with the make
                    # restricted by its public maker page.
                    keywords = identity.keywords or identity.remainder
                    url += "?" + urlencode({"keywords": keywords})
                    note = "PistonHeads make page with keyword fallback. Verify local criteria against the advert."
                else:
                    note = "PistonHeads make page; vehicle filters checked locally."
            else:
                url = "https://www.pistonheads.com/buy/search?" + urlencode({"keywords": combined})
                note = "Unrecognised make: PistonHeads keyword search. Vehicle filters checked locally."
        link = {"site": site, "url": url, "sourceNote": note}
        if filters.get("bodyTypes"):
            link["sourceNote"] += (" Body styles are checked locally because "
                                   "provider-only body-type filters remove "
                                   "adverts that do not specify a body style.")
        if filters["colours"]:
            if filters["includeUnknownColours"]:
                link["sourceNote"] += (" Selected exterior colours plus unknowns: "
                                       "a provider colour filter cannot be used if it "
                                       "would omit unknown-colour cars. Confirmed mismatches "
                                       "are hidden by DriveHub.")
            elif site != "autotrader":
                link["sourceNote"] += (" Provider has no verified compatible exterior "
                                       "colour facet; DriveHub checks the advert colour.")
        links.append(link)
    return links


def infer_transmission(item):
    """Only infer transmission from explicit advert terms, not model assumptions."""
    supplied = str(item.get("transmission") or "").strip().lower()
    if supplied in ("automatic", "manual"):
        return supplied
    automatic = re.compile(
        r"\b(?:automatic|auto\s+gearbox|automatic\s+gearbox|dct|dsg|pdk|cvt|"
        r"tiptronic|steptronic|s[\s-]*tronic|dual[\s-]*clutch|"
        r"7[\s-]*speed\s+auto|8[\s-]*speed\s+auto)\b", re.I)
    manual = re.compile(r"\b(?:manual\s+gearbox|[4567][\s-]*speed\s+manual|"
                        r"manual\s+transmission|6mt|manual)\b", re.I)
    for raw in (item.get("title"), item.get("description")):
        text = str(raw or "")
        auto = bool(automatic.search(text))
        man = bool(manual.search(text))
        if auto != man:
            return "automatic" if auto else "manual"
        if auto and man:
            return None
    return None


def specs(item):
    text = " ".join(str(item.get(k) or "") for k in ("title", "description"))
    normal = text.lower()
    # Exterior colour is based only on a labelled source field or a colour
    # in the advert title. Never infer from free-text description / cabin.
    value, evidence = listing_exterior_colour(item)
    raw_engine = item.get("engine")
    if raw_engine is None:
        m = re.search(r"\b([1-9](?:\.[0-9])?)\s*(?:l|litre|liter)\b", normal)
        if not m:
            m = re.search(r"\b([1-9]\.[0-9])\b", normal)
        if m: raw_engine = float(m.group(1))
    bhp = item.get("bhp")
    if bhp is None:
        m = re.search(r"\b(\d{2,4})\s*(?:bhp|hp|ps)\b", normal)
        if m: bhp = int(m.group(1))
    return {"colour": value, "colourSource": evidence,
            "bodyType": listing_body_type(item),
            "engine": raw_engine, "bhp": bhp,
            "transmission": infer_transmission(item)}


def apply_local_filters(item, filters, search_name=None):
    """Returns (include, fields_not_verifiable). Never infer missing specs."""
    details = specs(item)
    item.update({k: v for k, v in details.items() if v is not None})
    # Do not keep a supplied raw paint string that could not be classified.
    if details["colour"] is None:
        item.pop("colour", None)
    unknown = []
    # Some sites ignore their keyword query parameter. Require model tokens
    # containing digits (M2, 997, 911), and keep uncertain matches labelled.
    car_query = str(search_name) if search_name is not None else (filters.get("keywords") or "")
    required = re.findall(r"[a-z0-9]+", car_query.lower())
    observed = set(re.findall(r"[a-z0-9]+", (
        str(item.get("title") or "") + " " + str(item.get("description") or "")
    ).lower()))
    relevant = [token for token in required if len(token) > 1]
    # Auto Trader advert titles commonly say "Porsche 911" rather than
    # "Porsche 997"/"996". Don't discard a plausible 911 generation simply
    # because the platform omits the internal-generation code. Flag it instead.
    generation = next((g for g in ("997", "996") if g in relevant), None)
    if generation and "porsche" in relevant and generation not in observed and {"porsche", "911"} <= observed:
        year = item.get("year")
        bounds = {"997": (2004, 2012), "996": (1997, 2005)}
        if year is not None:
            try:
                if not bounds[generation][0] <= int(year) <= bounds[generation][1]:
                    return False, []
            except (TypeError, ValueError):
                pass
        relevant.remove(generation)
        unknown.append("911 generation")
    if relevant:
        if not any(token in observed for token in relevant):
            return False, []
        if any(any(ch.isdigit() for ch in token) and token not in observed for token in relevant):
            return False, []
        if any(token not in observed for token in relevant):
            unknown.append("keywords")
    # Required/excluded terms are applied after cross-site grouping in the
    # dashboard. Preferred terms never filter or mark a listing unverified.
    fields = {
        "price": ("priceMin", "priceMax"),
        "mileage": ("mileageMin", "mileageMax"),
        "year": ("yearMin", "yearMax"),
        "engine": ("engineMin", "engineMax"),
        "bhp": ("bhpMin", "bhpMax"),
    }
    for field, (minimum, maximum) in fields.items():
        if filters.get(minimum) is None and filters.get(maximum) is None: continue
        value = item.get(field)
        if value is None or value == "":
            unknown.append(field)
            continue
        try: value = float(value)
        except (ValueError, TypeError):
            unknown.append(field)
            continue
        if filters.get(minimum) is not None and value < filters[minimum]: return False, []
        if filters.get(maximum) is not None and value > filters[maximum]: return False, []
    selected_transmission = filters.get("transmission") or "any"
    if selected_transmission in ("automatic", "manual"):
        transmission = item.get("transmission") or details.get("transmission")
        if transmission is None:
            unknown.append("transmission")
        elif transmission != selected_transmission:
            return False, []
    body_types = filters.get("bodyTypes") or []
    if body_types:
        body_type = item.get("bodyType") or details["bodyType"]
        if not body_type:
            unknown.append("bodyType")
        elif body_type not in body_types:
            return False, []
    colours = filters.get("colours") or []
    if colours:
        colour = details["colour"]
        if not colour:
            if not filters.get("includeUnknownColours", False):
                return False, []
            unknown.append("colour")
        elif colour not in colours:
            return False, []
    return True, unknown
