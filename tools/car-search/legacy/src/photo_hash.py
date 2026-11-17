"""Deterministic perceptual hashes of public advert photographs (NO AI).

Only fetch recognised car-photo CDN hosts over HTTPS. Never follow redirects,
accept arbitrary uploaded URLs, fetch private services or download unlimited
bytes. Hashes identify near-identical photographs, NOT arbitrary photographs
of the same car from different angles.
"""
import asyncio
from functools import lru_cache
from io import BytesIO
from ipaddress import ip_address
import math
from urllib.parse import urlsplit

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 2_500_000
MAX_PIXELS = 8_000_000
HOST_SUFFIXES = (
    "fbcdn.net", "fbsbx.com", "atcdn.co.uk", "autotrader.co.uk",
    "pistonheads.com", "ebayimg.com", "ebaystatic.com",
    "imgix.net", "cloudinary.com", "carandclassic.com",
    "cloudfront.net", "cdninstagram.com",
)
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def valid_photo_url(raw):
    if not isinstance(raw, str) or not 12 < len(raw) <= 2200:
        return False
    try:
        url = urlsplit(raw)
        host = (url.hostname or "").lower().rstrip(".")
        if url.scheme != "https" or url.username or url.password or url.port not in (None, 443):
            return False
        try:
            ip_address(host)
            return False
        except ValueError:
            pass
        return bool(host and all(c.isalnum() or c in "-." for c in host) and
                    any(host == suffix or host.endswith("." + suffix)
                        for suffix in HOST_SUFFIXES))
    except ValueError:
        return False


@lru_cache(maxsize=1)
def cosine_table():
    return tuple(tuple(math.cos((2 * x + 1) * u * math.pi / 64)
                       for x in range(32)) for u in range(8))


def image_fingerprint(raw):
    """Compute 64-bit DCT pHash, 64-bit difference hash and average RGB.

    All hashing is deterministic and takes place locally. No recognition
    model, external AI, external ML service, or uploaded image storage.
    """
    if len(raw) > MAX_BYTES:
        return None
    try:
        with Image.open(BytesIO(raw)) as opened:
            if opened.width < 100 or opened.height < 70:
                return None
            if opened.width * opened.height > MAX_PIXELS:
                return None
            oriented = ImageOps.exif_transpose(opened)
            rgb = oriented.convert("RGB")
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None

    colour_pixels = list(rgb.resize((8, 8), Image.Resampling.LANCZOS).getdata())
    mean = [round(sum(p[i] for p in colour_pixels) / len(colour_pixels))
            for i in range(3)]
    gray = rgb.convert("L")
    gray32 = gray.resize((32, 32), Image.Resampling.LANCZOS)
    pixels = list(gray32.getdata())
    avg = sum(pixels) / len(pixels)
    stddev = math.sqrt(sum((v-avg)**2 for v in pixels) / len(pixels))
    # Reject near-solid placeholder, brand-logo, loading or missing images.
    if stddev < 19:
        return None

    cosines = cosine_table()
    rows = [pixels[i*32:(i+1)*32] for i in range(32)]
    transforms = [[sum(row[x]*cosines[u][x] for x in range(32))
                   for row in rows] for u in range(8)]
    frequencies = [sum(transforms[u][y]*cosines[v][y] for y in range(32))
                   for u in range(8) for v in range(8)]
    low = frequencies[1:]
    median = sorted(low)[len(low)//2]
    bits = 0
    for idx, coefficient in enumerate(frequencies):
        if idx and coefficient > median:
            bits |= 1 << idx

    diff = gray.resize((9, 8), Image.Resampling.LANCZOS)
    values = list(diff.getdata())
    dhash = 0
    for y in range(8):
        for x in range(8):
            if values[y*9+x] > values[y*9+x+1]:
                dhash |= 1 << (y*8+x)

    return {"p": f"{bits:016x}", "d": f"{dhash:016x}", "rgb": mean}


async def download_fingerprint(url):
    if not valid_photo_url(url):
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0),
                                      follow_redirects=False,
                                      trust_env=False) as client:
            async with client.stream("GET", url, headers={
                "Accept": "image/jpeg,image/png,image/webp,image/gif",
                "User-Agent": "Mozilla/5.0 (compatible; CarSearchHub/4.5 photo-fingerprint)"
            }) as response:
                if response.status_code != 200:
                    return None
                content_type = response.headers.get("content-type", "").split(";")[0].lower()
                if content_type not in ("image/jpeg","image/png","image/webp","image/gif"):
                    return None
                length = response.headers.get("content-length")
                if length and int(length) > MAX_BYTES:
                    return None
                parts, downloaded = [], 0
                async for chunk in response.aiter_bytes(65536):
                    downloaded += len(chunk)
                    if downloaded > MAX_BYTES:
                        return None
                    parts.append(chunk)
        return await asyncio.to_thread(image_fingerprint, b"".join(parts))
    except (httpx.HTTPError, OSError, ValueError):
        return None
