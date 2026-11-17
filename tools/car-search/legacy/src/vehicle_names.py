"""Recognise a provider make/model conservatively from a saved search name.

A model is only selected when it is a known match; the original search phrase
is retained in Car Search for local verification. No numeric provider IDs are
guessed, and an unknown model remains a keyword search.
"""
import re
from dataclasses import dataclass

# Names validated against common UK manufacturer headings. Single-word make
# prefixes are preferred; multi-word names are supported as necessary.
MAKES = {
    name.casefold(): (name, name.lower().replace(" ", "-"))
    for name in (
        "Abarth", "Alpine", "Ariel", "Audi", "Bentley", "BMW", "Bugatti",
        "Caterham", "Chevrolet", "Citroen", "Cupra", "Dodge", "Ferrari",
        "Fiat", "Ford", "Honda", "Hyundai", "Jaguar", "Kia", "Lamborghini",
        "Lotus", "Maserati", "Mazda", "McLaren", "Mini", "Mitsubishi",
        "Morgan", "Nissan", "Noble", "Peugeot", "Polestar", "Porsche",
        "Renault", "Seat", "Skoda", "Subaru", "Suzuki", "Tesla", "Toyota",
        "TVR", "Volkswagen", "Volvo"
    )
}
MAKES.update({
    "aston": ("Aston Martin", "aston-martin"),
    "aston martin": ("Aston Martin", "aston-martin"),
    "alfa": ("Alfa Romeo", "alfa-romeo"),
    "alfa romeo": ("Alfa Romeo", "alfa-romeo"),
    "land": ("Land Rover", "land-rover"),
    "land rover": ("Land Rover", "land-rover"),
    "mercedes": ("Mercedes-Benz", "mercedes-benz"),
    "mercedes-benz": ("Mercedes-Benz", "mercedes-benz"),
    "mercedes benz": ("Mercedes-Benz", "mercedes-benz"),
    "range rover": ("Land Rover", "land-rover"),
    "ds": ("DS Automobiles", "ds-automobiles"),
    "ds automobiles": ("DS Automobiles", "ds-automobiles"),
    "rolls": ("Rolls-Royce", "rolls-royce"),
    "rolls royce": ("Rolls-Royce", "rolls-royce"),
    "rolls-royce": ("Rolls-Royce", "rolls-royce"),
    "vw": ("Volkswagen", "volkswagen"),
    "vauxhall": ("Vauxhall", "vauxhall"),
    "lexus": ("Lexus", "lexus"),
})

# Canonical Auto Trader model -> known PistonHeads model path -> aliases.
# Paths are only used when the provider's model page naming is known.
MODELS = {
    "bmw": [
        ("M135i", "m135i", ("m135i",)), ("M140i", "m140i", ("m140i",)),
        ("M2", "m2", ("m2",)), ("M3", None, ("m3",)),
        ("M4", None, ("m4",)), ("M5", "m5", ("m5",)),
        ("i8", "i8", ("i8",)), ("Z4", None, ("z4",)),
        ("2 Series", None, ("2 series",)), ("3 Series", None, ("3 series",)),
        ("4 Series", None, ("4 series",)), ("5 Series", None, ("5 series",)),
        ("X3", None, ("x3",)), ("X5", None, ("x5",))
    ],
    "porsche": [
        ("Carrera GT", "carrera-gt", ("carrera gt",)),
        ("911", None, ("911", "996", "997", "991", "992", "964", "993", "c4s", "c2s", "carrera 4s", "carrera 2s", "carrera s")),
        ("Boxster", None, ("boxster",)), ("Cayman", None, ("cayman",)),
        ("Cayenne", "cayenne", ("cayenne",)),
        ("Macan", "macan", ("macan",)),
        ("Panamera", "panamera", ("panamera",)),
        ("Taycan", "taycan", ("taycan",))
    ],
    "lotus": [
        ("Evora", "evora", ("evora",)), ("Elise", "elise", ("elise",)),
        ("Exige", "exige", ("exige",)), ("Emira", "emira", ("emira",)),
        ("Eletre", None, ("eletre",))
    ],
    "jaguar": [
        ("F-Type", "f-type", ("f-type", "f type", "ftype")),
        ("XKR", None, ("xkr",)), ("XK", None, ("xk",)),
        ("XF", None, ("xf",)), ("F-Pace", None, ("f-pace", "f pace"))
    ],
    "ford": [
        ("Mustang", "mustang", ("mustang",)), ("Focus", "focus", ("focus",)),
        ("Fiesta", "fiesta", ("fiesta",)), ("Puma", "puma", ("puma",)),
        ("Kuga", "kuga", ("kuga",))
    ],
    "aston-martin": [
        ("DB9", None, ("db9",)), ("DB11", None, ("db11",)),
        ("DB12", None, ("db12",)), ("Vantage", None, ("vantage",)),
        ("Vanquish", None, ("vanquish",)), ("DBS", None, ("dbs",))
    ],
    "nissan": [
        ("Qashqai", "qashqai", ("qashqai",)), ("370Z", None, ("370z",)),
        ("350Z", None, ("350z",)), ("GT-R", None, ("gt-r", "gtr")),
        ("Juke", "juke", ("juke",)), ("Leaf", "leaf", ("leaf",))
    ],
    "mazda": [
        ("MX-5", None, ("mx-5", "mx5", "mx 5", "miata")),
        ("Mazda3", None, ("mazda3", "3")), ("CX-5", None, ("cx-5",))
    ],
    "audi": [
        ("TT", None, ("tt",)), ("R8", "r8", ("r8",)),
        ("RS3", None, ("rs3", "rs 3")), ("RS4", None, ("rs4", "rs 4")),
        ("A3", "a3", ("a3",)), ("A4", "a4", ("a4",))
    ],
    "mercedes-benz": [
        ("AMG GT", None, ("amg gt",)), ("C Class", None, ("c class", "c-class")),
        ("E Class", None, ("e class", "e-class")), ("SL", None, ("sl",))
    ],
    "volkswagen": [
        ("Golf", "golf", ("golf",)), ("Polo", "polo", ("polo",)),
        ("Passat", "passat", ("passat",)), ("Tiguan", "tiguan", ("tiguan",))
    ],
    "toyota": [
        ("Supra", "supra", ("supra",)), ("GR86", None, ("gr86",)),
        ("GT86", None, ("gt86",)), ("Yaris", None, ("yaris",))
    ],
}


@dataclass(frozen=True)
class VehicleIdentity:
    make: str
    make_slug: str
    model: str | None
    model_slug: str | None
    keywords: str


def _has_phrase(text, phrase):
    return bool(re.search(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", text, re.IGNORECASE))


def resolve_vehicle_query(value):
    """Return a provider make/model or None when the leading make is unknown."""
    text = " ".join(str(value or "").split())
    if not text:
        return None
    parts = re.split(r"\s+", text, maxsplit=2)
    if not parts:
        return None
    first = parts[0].lower()
    candidate = first
    used = 1
    if len(parts) > 1 and first + " " + parts[1].lower() in MAKES:
        candidate = first + " " + parts[1].lower()
        used = 2
    found = MAKES.get(candidate)
    if not found:
        return None
    make, slug = found
    remaining = " ".join(parts[used:]).strip()
    model = model_slug = None
    for canonical, piston_slug, aliases in MODELS.get(slug, []):
        if any(_has_phrase(remaining, alias) for alias in aliases):
            model, model_slug = canonical, piston_slug
            break
    # A numbered Porsche generation identifies the 911; PH's generation
    # pages are verified canonical paths and include 4S/C4S variants.
    if slug == "porsche" and model == "911":
        generation = next((g for g in ("996", "997", "991", "992")
                           if _has_phrase(remaining, g)), None)
        if generation:
            model_slug = "911-carrera-" + generation
    return VehicleIdentity(make, slug, model, model_slug, remaining if not model else "")
