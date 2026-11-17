"""Conservative body-style extraction from explicit adverts and vehicle titles.

Only classify confirmed title wording or an explicit labelled body-style field.
Never infer an SUV/coupe/etc from a particular model name: trims vary.
"""
import re

BODY_TYPES = ("coupe", "convertible", "saloon", "hatchback", "estate",
              "suv", "mpv", "pickup", "van", "other")
PATTERNS = (
    ("convertible", r"\b(?:convertible|cabriolet|cabrio|roadster|drophead|soft[ -]?top|open[ -]?top|spyder|spider)\b"),
    ("coupe", r"\b(?:coup[eé]|coupe|2[ -]?door coup[eé])\b"),
    ("estate", r"\b(?:estate|station wagon|touring|sportbrake|sportwagon|shooting brake)\b"),
    ("saloon", r"\b(?:saloon|sedan)\b"),
    ("hatchback", r"\b(?:hatchback|hatch)\b"),
    ("suv", r"\b(?:suv|4x4|crossover|sport utility vehicle)\b"),
    ("mpv", r"\b(?:mpv|people carrier|minivan)\b"),
    ("pickup", r"\b(?:pick[ -]?up(?: truck)?|double cab pickup)\b"),
    ("van", r"\b(?:panel van|van|light commercial vehicle)\b"),
)
ALIASES = {
    "coupe": "coupe", "coupé": "coupe", "sports coupe": "coupe",
    "convertible": "convertible", "cabriolet": "convertible",
    "cabrio": "convertible", "roadster": "convertible",
    "saloon": "saloon", "sedan": "saloon",
    "hatchback": "hatchback", "hatch": "hatchback",
    "estate": "estate", "touring": "estate",
    "suv": "suv", "4x4": "suv", "crossover": "suv",
    "mpv": "mpv", "people carrier": "mpv",
    "pickup": "pickup", "pick-up": "pickup",
    "van": "van", "other": "other",
}


def normalise_body_type(value):
    if not isinstance(value, str) or not value.strip():
        return None
    plain = " ".join(value.strip().casefold().split())
    if plain in ALIASES:
        return ALIASES[plain]
    # A labelled body-style field sometimes contains "Coupe / 2-door".
    matches = {style for style, pattern in PATTERNS if re.search(pattern, plain, re.I)}
    return next(iter(matches)) if len(matches) == 1 else None


def listing_body_type(item):
    """Return a validated body type from a source field or title, if available."""
    if not isinstance(item, dict):
        return None
    supplied = item.get("bodyType")
    if supplied is None:
        supplied = item.get("bodyStyle")
    if supplied:
        return normalise_body_type(supplied)
    # Titles often explicitly say "Coupe", "Roadster" or "Estate".
    # Do not parse non-labelled descriptions: one advert may mention
    # competing bodies (e.g. "not a convertible").
    return normalise_body_type(item.get("title") or "")
