"""Conservative exterior paint-colour classification for car adverts.

Do NOT classify colour from an unlabelled advert description: black seats,
silver wheels, red brake calipers, trim packs and seller boilerplate are
frequently mistaken for exterior paint.
"""
import re

COLOUR_CHOICES = ("black", "white", "silver", "grey", "blue", "red", "green",
                  "yellow", "orange", "purple", "brown", "gold", "beige", "other")

# Deliberately bounded: manufacturer colours are recognised when known,
# but arbitrary marketing names are NOT guessed from photographs.
FACTORY_PAINT = {
    "long beach blue": "blue", "yas marina blue": "blue",
    "san marino blue": "blue", "laguna seca blue": "blue",
    "tanzanite blue": "blue", "portimao blue": "blue",
    "estoril blue": "blue", "miami blue": "blue", "misano blue": "blue",
    "interlagos blue": "blue", "le mans blue": "blue",
    "hockenheim silver": "silver", "titanium silver": "silver",
    "glacier silver": "silver", "iridium silver": "silver",
    "mineral grey": "grey", "nardo grey": "grey",
    "daytona grey": "grey", "brooklyn grey": "grey",
    "skyscraper grey": "grey", "donington grey": "grey",
    "sapphire black": "black", "carbon black": "black",
    "jet black": "black", "onyx black": "black",
    "alpine white": "white", "mineral white": "white",
    "frozen white": "white", "pearl white": "white",
    "imola red": "red", "salsa red": "red",
    "firenze red": "red", "melbourne red": "red",
    "sakhir orange": "orange", "sunset orange": "orange",
    "austin yellow": "yellow", "phoenix yellow": "yellow",
    "british racing green": "green", "oxford green": "green",
    "thundernight metallic": "purple",
}
ALIASES = {
    "gray": "grey", "anthracite": "grey", "graphite": "grey",
    "charcoal": "grey", "gunmetal": "grey",
    "burgundy": "red", "maroon": "red",
    "cream": "beige", "tan": "beige",
    "bronze": "brown", "copper": "brown",
}
COLOUR_WORDS = {**{name: name for name in COLOUR_CHOICES if name != "other"}, **ALIASES}
# Colour contexts that often describe non-body parts in an advert title.
ACCESSORIES = re.compile(
    r"\b(?:interior|leather|seats?|upholstery|cabin|alloys?|wheels?|"
    r"calipers?|brakes?|mirrors?|roof|trim|stitching|dashboard|"
    r"exhaust|grille|grill|badge|badges|pack|package|edition|"
    r"headlights?|carpets?|lining)\b", re.I
)
WORD = re.compile(r"[a-z0-9]+")


def _normalise_phrase(value):
    return " ".join(WORD.findall(str(value or "").casefold()))


def normalise_colour(value):
    """Map an explicit paint specification to a broad user-visible colour.

    Values containing several competing colours are unknown, not arbitrarily
    treated as the first one (except established silver/grey expressions).
    """
    if not isinstance(value, str) or not value.strip():
        return None
    phrase = _normalise_phrase(value)
    if not phrase:
        return None
    if phrase == "other":
        return "other"
    # A source field sometimes contains a full interior specification
    # rather than body paint. It is safer to mark that ambiguous.
    if ACCESSORIES.search(phrase):
        return None
    found_factory = []
    for name, colour in FACTORY_PAINT.items():
        if re.search(r"\b" + re.escape(name) + r"\b", phrase):
            found_factory.append(colour)
    if found_factory:
        return found_factory[0] if len(set(found_factory)) == 1 else None
    found = [
        mapped for token, mapped in COLOUR_WORDS.items()
        if re.search(r"\b" + re.escape(token) + r"\b", phrase)
    ]
    values = set(found)
    if not values:
        return None
    if len(values) == 1:
        return found[0]
    # Some sellers use "silver grey" synonymously; conservatively classify
    # as silver only when the provided exterior label itself starts silver.
    if values == {"grey", "silver"}:
        return "silver" if phrase.startswith("silver") else "grey" if phrase.startswith("grey") else None
    return None


def title_exterior_colour(title):
    """Infer paint only from a recognisable colour in the advert TITLE.

    Do not use the body description; no image AI or guessing.
    """
    phrase = _normalise_phrase(title)
    if not phrase:
        return None
    # A recognised paint name is a meaningful signal unless title clearly
    # says it's an interior/trim item right next to that name.
    for name, colour in FACTORY_PAINT.items():
        hit = re.search(r"\b" + re.escape(name) + r"\b", phrase)
        if hit:
            before = phrase[max(0, hit.start()-22):hit.start()].split()
            after = phrase[hit.end():hit.end()+22].split()
            # Only an adjacent accessory label disqualifies a paint name,
            # not an unrelated "black seats" elsewhere in the car's title.
            if not (before and ACCESSORIES.fullmatch(before[-1])) and not (
                    after and ACCESSORIES.fullmatch(after[0])):
                return colour
    matches = []
    for match in WORD.finditer(phrase):
        mapped = COLOUR_WORDS.get(match.group())
        if not mapped:
            continue
        before = phrase[max(0,match.start()-26):match.start()].split()
        after = phrase[match.end():match.end()+26].split()
        # The accessory must be adjacent: "Blue M2 with black leather"
        # still establishes Blue body paint, not unknown or black.
        if (before and ACCESSORIES.fullmatch(before[-1])) or (
                after and ACCESSORIES.fullmatch(after[0])):
            continue
        matches.append(mapped)
    return matches[0] if matches and len(set(matches)) == 1 else None


def listing_exterior_colour(item):
    """Return (canonical colour or None, evidence provenance)."""
    supplied = item.get("colour") if isinstance(item, dict) else None
    if supplied:
        return normalise_colour(supplied), "explicit" if normalise_colour(supplied) else "unknown"
    guess = title_exterior_colour(item.get("title") if isinstance(item, dict) else "")
    return (guess, "title") if guess else (None, "unknown")
