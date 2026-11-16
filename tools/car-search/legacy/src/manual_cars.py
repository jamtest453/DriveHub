"""Validated manually saved adverts and user-owned field overrides.

Never treat a search-results URL as an individual vehicle; never open unknown hosts.
Manual changes are protected from subsequent scanner and enrichment updates.
"""
import re
from urllib.parse import urlsplit

from .scanner import clean_url, site_for, unsafe_host
from .colour import COLOUR_CHOICES

EDITABLE_TEXT = {
    "title": 220, "description": 4000, "location": 120,
    "registration": 24, "notes": 12000, "image": 1500,
}
EDITABLE_NUMERIC = {
    "price": (0, 1_000_000),
    "year": (1950, 2035),
    "mileage": (0, 1_000_000),
    "engine": (0.1, 12),
    "bhp": (1, 2000),
}
EDITABLE = frozenset((*EDITABLE_TEXT, *EDITABLE_NUMERIC, "colour", "transmission"))
SITE_NAMES = {"autotrader": "Auto Trader", "ebay": "eBay",
              "pistonheads": "PistonHeads", "facebook": "Facebook Marketplace"}


def listing_url(raw):
    """Return a safe supported advert URL, its source and a stable advert key."""
    link = clean_url(raw.strip()) if isinstance(raw, str) else None
    if not link:
        raise ValueError("Paste a valid HTTPS listing URL from a supported website.")
    site = site_for(link)
    u = urlsplit(link)
    path = u.path.rstrip("/")
    patterns = {
        "autotrader": r"/car-details/(\d{10,18})$",
        "ebay": r"/itm/(?:[^/]+/)?(\d{8,15})$",
        "pistonheads": r"/buy/listing/([a-z0-9-]{4,100})$",
        "facebook": r"/marketplace/item/(\d{6,30})$",
    }
    m = re.fullmatch(patterns[site], path, re.I)
    if not m:
        raise ValueError("This is not a recognised individual car advert. Paste a vehicle listing link, not a search page.")
    # Ignore share/tracking query params and hostname variants for identity.
    identity = f"{site}:{m.group(1).casefold()}"
    return link, site, identity


def valid_user_image_url(raw):
    """Allow user-supplied HTTPS photo hosts; hashing still restricts CDNs."""
    if not isinstance(raw, str) or not 12 < len(raw) <= 1500:
        return False
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        return bool(parsed.scheme == "https" and host and
                    parsed.port in (None, 443) and not parsed.username
                    and not parsed.password and not unsafe_host(host))
    except ValueError:
        return False


def validate_manual_details(raw, *, allow_empty=False):
    if not isinstance(raw, dict):
        raise ValueError("Car details must be an object.")
    unknown = set(raw) - EDITABLE
    if unknown:
        raise ValueError("Unsupported vehicle fields: " + ", ".join(sorted(unknown)))
    if not raw and not allow_empty:
        raise ValueError("Enter at least one car detail.")
    result = {}
    for field, value in raw.items():
        if field in EDITABLE_TEXT:
            if not isinstance(value, str) or len(value) > EDITABLE_TEXT[field]:
                raise ValueError(f"{field} must be text (max {EDITABLE_TEXT[field]} characters).")
            clean = value.strip()
            if field == "image" and clean and not valid_user_image_url(clean):
                raise ValueError("Image must be a valid public HTTPS image URL.")
            result[field] = clean
        elif field in EDITABLE_NUMERIC:
            if value in (None, ""):
                result[field] = None
                continue
            if isinstance(value, bool):
                raise ValueError(f"Invalid {field}.")
            try:
                number = float(value)
            except (ValueError, TypeError):
                raise ValueError(f"Invalid {field}.")
            low, high = EDITABLE_NUMERIC[field]
            if not low <= number <= high or not number < float("inf"):
                raise ValueError(f"{field} must be between {low} and {high}.")
            if field != "engine" and int(number) != number:
                raise ValueError(f"{field} must be a whole number.")
            result[field] = round(number, 1) if field == "engine" else int(number)
        elif field == "colour":
            if not isinstance(value, str) or value.casefold() not in (*COLOUR_CHOICES, ""):
                raise ValueError("Choose a supported exterior colour.")
            result[field] = value.casefold()
        elif field == "transmission":
            if not isinstance(value, str) or value.casefold() not in ("", "automatic", "manual"):
                raise ValueError("Choose manual, automatic, or unknown transmission.")
            result[field] = value.casefold()
    return result


def apply_manual_details(record, details, stamp):
    """Apply explicit owner edits and remember which fields scans must not overwrite."""
    locked = set(record.get("manualFields") or [])
    for field, value in details.items():
        if field == "price" and value != record.get("price") and value not in (None, 0):
            previous = record.get("price")
            if previous not in (None, 0):
                record["previousPrice"] = previous
            record["priceHistory"] = (
                record.get("priceHistory", []) +
                [{"price": value, "at": stamp, "source": "manual"}])[-80:]
        if field == "image" and value != record.get("image"):
            for key in ("photoHash", "photoStatus", "photoCheckedAt"):
                record.pop(key, None)
        record[field] = value
        locked.add(field)
        if field == "colour":
            record["colourSource"] = "manual" if value else "unknown"
        if field == "title":
            record.pop("titleSource", None)
    record["manualFields"] = sorted(locked)
    record["manuallyEditedAt"] = stamp
    return record
