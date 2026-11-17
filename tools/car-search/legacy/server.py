"""Car Search Hub – self-hosted single-user web app with server-side headless scanning."""
import asyncio
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from playwright.async_api import async_playwright

from src.scanner import SITES, clean_url, site_for, scan_link
from src.query_builder import validate_filters, generate_links, apply_local_filters, SOURCES
from src.search_url_import import parse_search_url
from src.facebook_connection import connection as facebook_connection
from src.location_map import LocationResolver
from src.writeoff import is_visible_writeoff
from src.colour import listing_exterior_colour, title_exterior_colour
from src.detail_enrichment import enrich_listing
from src.photo_hash import download_fingerprint, valid_photo_url
from src.manual_cars import (
    listing_url, validate_manual_details, apply_manual_details, SITE_NAMES as MANUAL_SITE_NAMES
)

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get('DATA_DIR', ROOT / 'data'))
DATA_FILE = DATA_DIR / 'car-search-hub.json'
PASSWORD = os.environ.get('APP_PASSWORD', '')
if os.environ.get('ENVIRONMENT') == 'production' and (not PASSWORD or PASSWORD == 'replace-with-a-long-unique-password'):
    raise RuntimeError('Set a strong APP_PASSWORD before running the site publicly.')
SIGNING_KEY = os.environ.get('AUTH_SECRET', '').encode() or secrets.token_bytes(32)
LOCK = asyncio.Lock()
LOCATION_RESOLVER = LocationResolver()
ENRICH_LOCK = asyncio.Semaphore(2)
ENRICH_TASKS = set()
PHOTO_QUEUE = asyncio.Queue()
PHOTO_PENDING = set()
PHOTO_WORKERS = set()
PHOTO_WORKER_LIMIT = 3
SESSION_LIFETIME = 30 * 86400
LOGIN_ATTEMPTS = {}

def fresh_state():
    return {'version': 1, 'searches': [], 'listings': {}, 'snapshots': {}, 'manualDuplicates': {}, 'separateDuplicates': {}, 'hiddenBySearch': {}, 'options': {'pageDepth': 3}}

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

def uid():
    return str(uuid4())

def migrate_hidden_state(raw):
    """Move old global hide flags into the appropriate saved searches once."""
    if raw.get('hiddenPerSearchMigrated'):
        return
    mapping = raw.setdefault('hiddenBySearch', {})
    if not isinstance(mapping, dict):
        mapping = {}
        raw['hiddenBySearch'] = mapping
    for search in raw.get('searches', []):
        search_id = search.get('id')
        if not isinstance(search_id, str):
            continue
        candidates = set()
        for link in search.get('links', []):
            snapshot = raw.get('snapshots', {}).get(link.get('id'), {})
            candidates.update(snapshot.get('ids', []))
        past = set(mapping.get(search_id, []))
        past.update(item_id for item_id in candidates
                    if raw.get('listings', {}).get(item_id, {}).get('hidden'))
        if past:
            mapping[search_id] = sorted(past)
    raw['hiddenPerSearchMigrated'] = True


def remove_photo_colour_guesses(raw):
    """Retire inaccurate image-inferred exterior paints without losing source/manual colour."""
    for car in raw.get('listings', {}).values():
        if not isinstance(car, dict):
            continue
        for key in ('photoColour', 'photoColourConfidence', 'photoColourCheckedAt'):
            car.pop(key, None)
        if car.get('colourSource') == 'photo':
            # The old image heuristic was not reliable enough to represent exterior paint.
            car.pop('colour', None)
            car['colourSource'] = 'unknown'


def load_state():
    if DATA_FILE.exists():
        try:
            raw = json.loads(DATA_FILE.read_text())
            if raw.get('version') == 1 and isinstance(raw.get('searches'), list) and isinstance(raw.get('listings'), dict):
                # Older versions guessed car colour from seat, wheel and
                # trim text. Recheck only safe title paint terms when the
                # source of the colour was never recorded.
                for car in raw['listings'].values():
                    if not isinstance(car, dict) or car.get('colourSource'):
                        continue
                    safe_colour = title_exterior_colour(car.get('title'))
                    if safe_colour:
                        car['colour'] = safe_colour
                        car['colourSource'] = 'title'
                    else:
                        car.pop('colour', None)
                        car['colourSource'] = 'unknown'
                migrate_hidden_state(raw)
                remove_photo_colour_guesses(raw)
                return {**fresh_state(), **raw}
        except Exception as exc:
            raise RuntimeError(f'Cannot load saved car data from {DATA_FILE}: {exc}') from exc
    return fresh_state()

state = load_state()
revision = 0
job = {'busy': False, 'label': '', 'detail': '', 'stop': False, 'message': '',
       'started': None, 'finished': None, 'searchIds': []}

def store(publish=True):
    global revision
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(temporary, DATA_FILE)
    if publish:
        revision += 1

def site_name(site):
    return SITES.get(site, site)

def cookie_value():
    expires = str(int(time.time()) + SESSION_LIFETIME)
    signature = hmac.new(SIGNING_KEY, expires.encode(), sha256).hexdigest()
    return expires + '.' + signature

def is_authenticated(request):
    if not PASSWORD:
        return True
    value = request.cookies.get('carhub_session', '')
    try:
        expiry, signature = value.split('.', 1)
        wanted = hmac.new(SIGNING_KEY, expiry.encode(), sha256).hexdigest()
        return int(expiry) > time.time() and hmac.compare_digest(signature, wanted)
    except (ValueError, TypeError):
        return False

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

@app.middleware('http')
async def gate(request: Request, call_next):
    path = request.url.path
    if path.startswith('/api/') and path not in ('/api/login', '/api/auth') and not is_authenticated(request):
        return JSONResponse({'error': 'Sign in to continue.'}, status_code=401)
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin', '')
        if origin and urlsplit(origin).netloc != request.headers.get('host'):
            return JSONResponse({'error': 'Cross-site request rejected.'}, status_code=403)
    return await call_next(request)

async def payload(request, limit=8_000_000):
    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(status_code=413, detail='Request is too large.')
    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError):
        raise HTTPException(status_code=400, detail='Invalid JSON.')
    if not isinstance(result, dict):
        raise HTTPException(status_code=400, detail='Expected a JSON object.')
    return result

def result():
    return {'state': state, 'revision': revision, 'job': job}

def block_during_scan():
    if job['busy']:
        raise HTTPException(409, 'Search edits and imports are disabled during a scan.')

@app.get('/api/auth')
async def auth_status(request: Request):
    return {'authenticated': is_authenticated(request), 'passwordRequired': bool(PASSWORD)}

@app.post('/api/login')
async def login(request: Request, response: Response):
    body = await payload(request, 4096)
    key = (request.client.host if request.client else 'unknown')
    failures = [x for x in LOGIN_ATTEMPTS.get(key, []) if time.time() - x < 900]
    if len(failures) >= 10:
        raise HTTPException(429, 'Too many attempts. Try later.')
    if PASSWORD and not hmac.compare_digest(str(body.get('password', '')), PASSWORD):
        failures.append(time.time())
        LOGIN_ATTEMPTS[key] = failures
        raise HTTPException(401, 'Incorrect password.')
    LOGIN_ATTEMPTS.pop(key, None)
    response.set_cookie('carhub_session', cookie_value(), httponly=True, max_age=SESSION_LIFETIME,
        secure=(request.url.scheme == 'https' or request.headers.get('x-forwarded-proto') == 'https'), samesite='strict', path='/')
    return {'ok': True}

@app.post('/api/logout')
async def logout(response: Response):
    response.delete_cookie('carhub_session', path='/')
    return {'ok': True}

async def photo_hash_worker():
    """Resolve image hashes outside the state lock; keep the UI responsive."""
    while not PHOTO_QUEUE.empty():
        item_id = await PHOTO_QUEUE.get()
        try:
            # Searches and Facebook authentication take priority over
            # optional image hashing; queued work resumes afterwards.
            while job['busy']:
                await asyncio.sleep(1)
            async with LOCK:
                record = state['listings'].get(item_id)
                url = str(record.get('image') or '') if record else ''
                if not valid_photo_url(url):
                    continue
                if record.get('photoHash') is not None:
                    continue
            fingerprint = await download_fingerprint(url)
            async with LOCK:
                current = state['listings'].get(item_id)
                if current and current.get('image') == url:
                    if fingerprint:
                        current['photoHash'] = fingerprint
                        current['photoStatus'] = 'ready'
                    else:
                        current.pop('photoHash', None)
                        current['photoStatus'] = 'unavailable'
                    current['photoCheckedAt'] = time.time()
                    # Persist fingerprints, but do not publish a full-state revision
                    # for every thumbnail (which previously caused constant UI reloads).
                    store(publish=False)
        except Exception:
            # Photos are optional. Never interrupt scans or saved-car updates.
            pass
        finally:
            PHOTO_PENDING.discard(item_id)
            PHOTO_QUEUE.task_done()
            if not PHOTO_PENDING and PHOTO_QUEUE.empty():
                # One client update after background fingerprints are complete.
                # Fingerprints are still persisted individually for crash safety.
                async with LOCK:
                    store()


def schedule_photo_hashes(ids=None, limit=240):
    """Queue new/changed listing photos and backfill older entries on load."""
    if ids is None:
        candidates = sorted(state['listings'].items(),
            key=lambda pair: (not bool(pair[1].get('saved')),
                              str(pair[1].get('lastSeen') or '')),
            reverse=False)
        ids = [item_id for item_id, _ in candidates]
    added = 0
    for item_id in ids:
        if added >= limit or PHOTO_QUEUE.qsize() >= 300:
            break
        row = state['listings'].get(item_id)
        if not row or item_id in PHOTO_PENDING or row.get('photoHash'):
            continue
        url = row.get('image')
        if not valid_photo_url(url):
            continue
        if (row.get('photoStatus') == 'unavailable' and
                time.time()-float(row.get('photoCheckedAt') or 0) < 86400):
            continue
        PHOTO_PENDING.add(item_id)
        PHOTO_QUEUE.put_nowait(item_id)
        added += 1
    # A worker drains the queue rather than spawning a task per photo.
    while len(PHOTO_WORKERS) < PHOTO_WORKER_LIMIT and not PHOTO_QUEUE.empty():
        task = asyncio.create_task(photo_hash_worker())
        PHOTO_WORKERS.add(task)
        task.add_done_callback(PHOTO_WORKERS.discard)


@app.get('/api/state')
async def get_state():
    schedule_photo_hashes()
    return result()

@app.post('/api/map/locations')
async def map_locations(request: Request):
    """Resolve publicly advertised locations when the user chooses Map view."""
    body = await payload(request, 12000)
    raw = body.get('locations')
    if not isinstance(raw, list) or len(raw) > 30 or any(
        not isinstance(value, str) or len(value) > 120 for value in raw
    ):
        raise HTTPException(400, 'Provide at most 30 short listing locations per request.')
    retry = body.get("retry", False)
    if not isinstance(retry, bool):
        raise HTTPException(400, "Retry must be on or off.")
    try:
        resolved = (await LOCATION_RESOLVER.resolve(raw, DATA_DIR, retry=True)
                    if retry else await LOCATION_RESOLVER.resolve(raw, DATA_DIR))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {'locations': resolved}


@app.get('/api/status')
async def get_status():
    return {'revision': revision, 'job': job}

@app.post('/api/searches/parse-url')
async def parse_search_url_request(request: Request):
    """Preview criteria derived from a supported URL without creating a search.

    Parsing never fetches the supplied URL, and the raw URL is not stored.
    """
    body = await payload(request, 6000)
    try:
        return parse_search_url(body.get('url'))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post('/api/searches')
async def upsert_search(request: Request):
    body = await payload(request, 200_000)
    name = body.get('name', '')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 90:
        raise HTTPException(400, 'Search name must be 1–90 characters.')

    structured = 'filters' in body
    if structured:
        try:
            filters = validate_filters(body['filters'])
            sources = body.get('sources', list(SOURCES))
            generated = generate_links(filters, sources, name.strip())
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        clean = generated
    else:
        # Legacy URL-based requests/backups are still accepted, but the new
        # dashboard only creates structured searches.
        urls = body.get('urls', [])
        if not isinstance(urls, list) or not (1 <= len(urls) <= 30):
            raise HTTPException(400, 'Add between 1 and 30 search URLs.')
        clean_urls = []
        for raw in urls:
            url = clean_url(raw)
            if not url:
                raise HTTPException(400, 'Only valid HTTPS search URLs from supported car sites are allowed.')
            if url not in clean_urls:
                clean_urls.append(url)
        clean = [{'site': site_for(url), 'url': url, 'sourceNote': 'Legacy saved URL'} for url in clean_urls]
        filters = None
        sources = sorted(set(link['site'] for link in clean))

    async with LOCK:
        block_during_scan()
        previous = next((s for s in state['searches'] if s['id'] == body.get('id')), None)
        if body.get('id') and previous is None:
            raise HTTPException(404, 'Search not found.')
        old_by_url = {link['url']: link for link in previous['links']} if previous else {}
        # Structured search edits must not wipe existing scan snapshots just
        # because keyword strategy or provider URL formatting has changed.
        # Each structured search has one query per provider.
        old_by_site = ({link['site']: link for link in previous['links']}
                       if (previous and previous.get('filters') and structured
                           and previous.get('name', '').casefold() == name.strip().casefold())
                       else {})
        links = []
        for item in clean:
            prior = old_by_url.get(item['url']) or old_by_site.get(item['site'])
            links.append({**item, 'id': prior['id'] if prior else uid()})
        if previous:
            retained = {link['id'] for link in links}
            for link in previous['links']:
                if link['id'] not in retained:
                    state['snapshots'].pop(link['id'], None)
            previous.update({'name': name.strip(), 'links': links,
                             'filters': filters, 'sources': sources, 'lastReport': None})
            search_id = previous['id']
        else:
            search_id = uid()
            state['searches'].append({'id': search_id, 'name': name.strip(),
                'links': links, 'filters': filters, 'sources': sources,
                'lastChecked': None, 'lastReport': None})
        store()
        return {**result(), 'searchId': search_id}

@app.delete('/api/searches/{search_id}')
async def remove_search(search_id: str):
    async with LOCK:
        block_during_scan()
        previous = next((s for s in state['searches'] if s['id'] == search_id), None)
        if not previous:
            raise HTTPException(404, 'Search not found.')
        for link in previous['links']:
            state['snapshots'].pop(link['id'], None)
        state['searches'].remove(previous)
        state.setdefault('hiddenBySearch', {}).pop(search_id, None)
        store()
        return result()

async def enrich_saved_listing(item_id):
    """Fill missing fields, never overwrite saved prices, notes or known specs."""
    async with ENRICH_LOCK:
        async with LOCK:
            record = state["listings"].get(item_id)
            if not record or not record.get("saved"):
                return
            snapshot = dict(record)
            record["enrichStatus"] = "running"
            store()
        try:
            incoming = await asyncio.wait_for(enrich_listing(snapshot), timeout=42)
            if not isinstance(incoming, dict):
                incoming = {}
        except Exception:
            incoming = {}
        async with LOCK:
            current = state["listings"].get(item_id)
            if not current or not current.get("saved"):
                return
            filled = 0
            locked = set(current.get("manualFields") or [])
            for field in ("title", "description", "image", "year", "mileage",
                          "location", "registration", "engine", "bhp",
                          "transmission", "bodyType"):
                # A placeholder title is not owner-entered vehicle evidence.
                placeholder = field == "title" and current.get("titleSource") == "placeholder"
                if (field not in locked and
                    (placeholder or current.get(field) in (None, "")) and
                        incoming.get(field) not in (None, "")):
                    current[field] = incoming[field]
                    if placeholder:
                        current.pop("titleSource", None)
                    filled += 1
            # A provider's explicitly labelled paint colour can correct an
            # old unverified/title-only guess; this is not an overwrite of
            # independently verified or user-entered vehicle data.
            if ("colour" not in locked and incoming.get("colour")
                    and incoming.get("colourSource") == "explicit"
                    and current.get("colourSource") not in ("explicit", "manual")):
                current["colour"] = incoming["colour"]
                current["colourSource"] = "explicit"
                filled += 1
            elif ("colour" not in locked and current.get("colour") in (None, "")
                  and incoming.get("colour")
                  and incoming.get("colourSource") in ("explicit", "title")):
                current["colour"] = incoming["colour"]
                current["colourSource"] = incoming["colourSource"]
                filled += 1
            if current.get('image') != snapshot.get('image'):
                current.pop('photoHash', None)
                current.pop('photoStatus', None)
                current.pop('photoCheckedAt', None)
                if current.get('colourSource') == 'photo':
                    current.pop('colour', None)
                    current['colourSource'] = 'unknown'
            current["enrichStatus"] = "complete" if filled else "unavailable"
            current["enrichedAt"] = now()
            current["enrichedFields"] = filled
            store()
        schedule_photo_hashes([item_id], limit=1)


def start_enrichment(ids):
    # Only records already in our database; never accept arbitrary links.
    for item_id in list(dict.fromkeys(ids))[:8]:
        task = asyncio.create_task(enrich_saved_listing(item_id))
        ENRICH_TASKS.add(task)
        task.add_done_callback(ENRICH_TASKS.discard)


@app.post('/api/listings/enrich')
async def refresh_saved_car_details(request: Request):
    body = await payload(request, 3000)
    ids = body.get("ids", [])
    if not isinstance(ids, list) or len(ids) > 8 or any(not isinstance(i,str) for i in ids):
        raise HTTPException(400, "Select up to eight saved car adverts.")
    async with LOCK:
        ready = []
        for item_id in ids:
            record = state["listings"].get(item_id)
            if record and record.get("saved") and record.get("enrichStatus") not in ("queued", "running"):
                record["enrichStatus"] = "queued"
                ready.append(item_id)
        if ready:
            store()
    if ready:
        start_enrichment(ready)
    return result()


@app.post('/api/listings/manual')
async def add_saved_listing_from_url(request: Request):
    """Save a specific advert URL without requiring it to appear in a search."""
    body = await payload(request, 30_000)
    try:
        link, site, identity = listing_url(body.get("url"))
        fields = validate_manual_details(body.get("fields", {}), allow_empty=True)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    stamp = now()
    async with LOCK:
        existing = next((car for car in state["listings"].values()
                         if car.get("manualIdentity") == identity), None)
        if existing is None:
            for row in state["listings"].values():
                try:
                    if listing_url(row.get("url"))[2] == identity:
                        existing = row
                        break
                except ValueError:
                    continue
        if existing:
            existing["saved"] = True
            if fields:
                apply_manual_details(existing, fields, stamp)
            item_id = existing["id"]
            already_present = True
        else:
            if len(state["listings"]) >= 150000:
                raise HTTPException(409, "Storage limit reached. Export a backup first.")
            item_id = "manual:" + uid()
            record = {
                "id": item_id, "site": site, "url": link,
                "title": "Car from " + MANUAL_SITE_NAMES[site],
                "titleSource": "placeholder", "manualIdentity": identity,
                "manuallyAdded": True, "saved": True, "notes": "",
                "price": None, "priceHistory": [], "previousPrice": None,
                "firstSeen": stamp, "lastSeen": stamp,
                "enrichStatus": "queued"
            }
            if fields:
                apply_manual_details(record, fields, stamp)
            state["listings"][item_id] = record
            already_present = False
        if existing and existing.get("enrichStatus") not in ("queued", "running"):
            existing["enrichStatus"] = "queued"
        store()
        response = {**result(), "carId": item_id, "alreadyPresent": already_present}
    start_enrichment([item_id])
    if fields.get("image"):
        schedule_photo_hashes([item_id], limit=1)
    return response


@app.patch('/api/listings/manual/{item_id}')
async def edit_saved_listing(item_id: str, request: Request):
    """Edit any tracked car; edits persist without adding it to saved cars."""
    body = await payload(request, 30_000)
    try:
        fields = validate_manual_details(body.get("fields"))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    async with LOCK:
        record = state["listings"].get(item_id)
        if not record:
            raise HTTPException(404, "Tracked car not found.")
        apply_manual_details(record, fields, now())
        store()
        response = result()
    if "image" in fields:
        schedule_photo_hashes([item_id], limit=1)
    return response


@app.post('/api/listings/saved')
async def save_car(request: Request):
    body = await payload(request, 100_000)
    ids = body.get('ids', [])
    if not isinstance(ids, list) or len(ids) > 100:
        raise HTTPException(400, 'Invalid listing IDs.')
    to_enrich = []
    async with LOCK:
        for item_id in ids:
            record = state["listings"].get(item_id)
            if record:
                saved = bool(body.get("saved"))
                was_saved = record.get("saved", False)
                record["saved"] = saved
                if saved and not was_saved and len(to_enrich) < 8:
                    record["enrichStatus"] = "queued"
                    to_enrich.append(item_id)
        store()
        response = result()
    if to_enrich:
        start_enrichment(to_enrich)
    return response

@app.post('/api/listings/hidden')
async def set_hidden_car(request: Request):
    """Hide adverts only within one saved search; keep full source records."""
    body = await payload(request, 100_000)
    ids = body.get('ids')
    hidden = body.get('hidden')
    search_id = body.get('searchId')
    if (not isinstance(search_id, str) or
            not isinstance(ids, list) or not 1 <= len(ids) <= 100 or
            len(set(ids)) != len(ids) or not isinstance(hidden, bool) or
            any(not isinstance(item_id, str) for item_id in ids)):
        raise HTTPException(400, 'Choose a saved search and up to 100 car adverts to hide or restore.')
    async with LOCK:
        search = next((item for item in state['searches'] if item.get('id') == search_id), None)
        if not search:
            raise HTTPException(404, 'Saved search not found.')
        if any(item_id not in state['listings'] for item_id in ids):
            raise HTTPException(404, 'One or more adverts no longer exist.')
        known_ids = set(state.get('hiddenBySearch', {}).get(search_id, []))
        for link in search.get('links', []):
            known_ids.update(state['snapshots'].get(link.get('id'), {}).get('ids', []))
        if any(item_id not in known_ids for item_id in ids):
            raise HTTPException(400, 'An advert does not belong to this search.')
        hidden_by_search = state.setdefault('hiddenBySearch', {})
        selected = set(hidden_by_search.get(search_id, []))
        if hidden:
            selected.update(ids)
        else:
            selected.difference_update(ids)
        hidden_by_search[search_id] = sorted(selected)
        store()
        return result()


@app.post('/api/listings/notes')
async def save_note(request: Request):
    body = await payload(request, 60_000)
    ids = body.get('ids', [])
    note = body.get('notes', '')
    if not isinstance(ids, list) or len(ids) > 100 or not isinstance(note, str) or len(note) > 12000:
        raise HTTPException(400, 'Invalid notes.')
    async with LOCK:
        for item_id in ids:
            if item_id in state['listings']:
                state['listings'][item_id]['notes'] = note
        store()
        return result()

@app.post('/api/duplicates')
async def duplicates(request: Request):
    body = await payload(request, 60_000)
    async with LOCK:
        if body.get('separateIds') is not None:
            ids = body['separateIds']
            if (not isinstance(ids, list) or not 2 <= len(ids) <= 12
                    or len(set(map(str, ids))) != len(ids)
                    or any(not isinstance(item_id, str) or item_id not in state['listings'] for item_id in ids)):
                raise HTTPException(400, 'Choose two to twelve different existing adverts to keep separate.')
            # Preserve user decisions independently of automatic matching.
            exclusions = state.setdefault('separateDuplicates', {})
            for i, first in enumerate(ids):
                for second in ids[i+1:]:
                    exclusions['|'.join(sorted((first, second)))] = True
            # Splitting explicitly merged adverts also clears their merge links.
            for item_id in ids:
                state['manualDuplicates'].pop(item_id, None)
        elif body.get('clearSeparateIds') is not None:
            ids = body['clearSeparateIds']
            if (not isinstance(ids, list) or not 1 <= len(ids) <= 12
                    or any(not isinstance(item_id, str) or item_id not in state['listings'] for item_id in ids)):
                raise HTTPException(400, 'Select up to twelve existing adverts.')
            chosen = set(ids)
            exclusions = state.setdefault('separateDuplicates', {})
            for pair in list(exclusions):
                if any(item_id in chosen for item_id in pair.split('|')):
                    exclusions.pop(pair, None)
        elif body.get('unmergeIds') is not None:
            ids = body['unmergeIds']
            if not isinstance(ids, list) or len(ids) > 100:
                raise HTTPException(400, 'Invalid merge IDs.')
            for item_id in ids:
                state['manualDuplicates'].pop(item_id, None)
        else:
            source, target = body.get('from'), body.get('to')
            if not isinstance(source, str) or not isinstance(target, str) or source == target or source not in state['listings'] or target not in state['listings']:
                raise HTTPException(400, 'Choose two different listings.')
            # Prevent cyclic references.
            root, visited = target, {source}
            while root in state['manualDuplicates']:
                if root in visited:
                    raise HTTPException(400, 'Cannot create a duplicate loop.')
                visited.add(root)
                root = state['manualDuplicates'][root]
            if root == source:
                raise HTTPException(400, 'Cannot create a duplicate loop.')
            state['manualDuplicates'][source] = root
        store()
        return result()

def clean_home(raw):
    """A user-chosen distance origin: a short label and UK-ish coordinates."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError('Invalid home location.')
    label = ' '.join(str(raw.get('label') or '').split())[:80]
    try:
        lat, lng = float(raw.get('lat')), float(raw.get('lng'))
    except (TypeError, ValueError):
        raise ValueError('Invalid home location.')
    if not label or not (49 <= lat <= 61.5 and -9 <= lng <= 2.5):
        raise ValueError('Home location must be a UK place.')
    return {'label': label, 'lat': lat, 'lng': lng}


def clean_options(raw):
    raw = raw if isinstance(raw, dict) else {}
    depth = str(raw.get('pageDepth', 3))
    options = {'pageDepth': int(depth) if depth in ('1', '3', '5', '10', '20') else 3}
    try:
        home = clean_home(raw.get('home'))
    except ValueError:
        home = None
    if home:
        options['home'] = home
    return options


@app.patch('/api/options')
async def change_options(request: Request):
    body = await payload(request, 4000)
    depth = None
    if 'pageDepth' in body:
        try:
            depth = int(body.get('pageDepth'))
        except (ValueError, TypeError):
            raise HTTPException(400, 'Invalid scan depth.')
        if depth not in (1, 3, 5, 10, 20):
            raise HTTPException(400, 'Invalid scan depth.')
    home = None
    if 'home' in body:
        try:
            home = clean_home(body.get('home'))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    elif depth is None:
        raise HTTPException(400, 'Invalid scan depth.')
    async with LOCK:
        if depth is not None:
            state['options']['pageDepth'] = depth
        if 'home' in body:
            if home:
                state['options']['home'] = home
            else:
                state['options'].pop('home', None)
        store()
        return result()

@app.get('/api/export')
async def export_data():
    return Response(json.dumps(state, indent=2, ensure_ascii=False), media_type='application/json',
        headers={'Content-Disposition': 'attachment; filename="car-search-hub-backup.json"'})

@app.post('/api/import')
async def import_data(request: Request):
    global state
    body = await payload(request)
    if body.get('version') != 1 or not isinstance(body.get('searches'), list) or not isinstance(body.get('listings'), dict) or not isinstance(body.get('snapshots'), dict):
        raise HTTPException(400, 'Not a valid Car Search Hub v1/v2 backup.')
    if len(body['searches']) > 500 or len(body['listings']) > 100_000:
        raise HTTPException(400, 'Backup is too large.')
    for search in body['searches']:
        if not isinstance(search, dict) or not isinstance(search.get('links'), list) or any(not isinstance(l, dict) or clean_url(l.get('url')) is None or site_for(l['url']) != l.get('site') for l in search['links']):
            raise HTTPException(400, 'Backup contains invalid search URLs.')
    async with LOCK:
        block_during_scan()
        state = {**fresh_state(), **body}
        migrate_hidden_state(state)
        remove_photo_colour_guesses(state)
        state['options'] = clean_options(state.get('options'))
        store()
        return result()


def update_listing(item, stamp):
    # Normalise even legacy search scans which do not apply structured
    # filters, so all four providers use the same exterior-colour logic.
    if "colourSource" not in item:
        value, source = listing_exterior_colour(item)
        item["colourSource"] = source
        if value:
            item["colour"] = value
        else:
            item.pop("colour", None)
    item_id = item['id']
    old = state['listings'].get(item_id)
    price = item.get('price')
    price = price if isinstance(price, (int, float)) and price > 0 else None
    if old is None:
        state['listings'][item_id] = {**item, 'price': price, 'firstSeen': stamp, 'lastSeen': stamp,
            'previousPrice': None, 'priceHistory': [{'price': price, 'at': stamp}] if price else [],
            'saved': False, 'notes': ''}
        return False
    # A new lead photograph invalidates the old perceptual fingerprint.
    # It will be re-hashed from the new image URL after the scan completes.
    if ("image" not in (old.get("manualFields") or [])
            and item.get('image') and item['image'] != old.get('image')):
        old.pop('photoHash', None)
        old.pop('photoStatus', None)
        old.pop('photoCheckedAt', None)
        if old.get('colourSource') == 'photo':
            old.pop('colour', None)
            old['colourSource'] = 'unknown'
    changed = ("price" not in (old.get("manualFields") or [])
               and price is not None and old.get('price') is not None and price != old['price'])
    if changed:
        old['previousPrice'] = old['price']
        old['priceHistory'] = (old.get('priceHistory', []) + [{'price': price, 'at': stamp}])[-80:]
    locked = set(old.get("manualFields") or [])
    for field in ('url', 'title', 'image', 'year', 'mileage', 'location', 'registration',
                  'engine', 'bhp', 'transmission', 'bodyType', 'description', 'unverifiedFilters'):
        if field not in locked and item.get(field) not in (None, ''):
            old[field] = item[field]
    # Re-evaluate legacy colour guesses on refresh instead of preserving a
    # stale "black" inferred from black seats or alloys. Explicit paint
    # from enrichment remains more authoritative than a title guess.
    incoming = item.get("colourSource") or "unknown"
    prior = old.get("colourSource") or "legacy"
    rank = {"legacy": 0, "unknown": 0, "photo": 0, "title": 2, "explicit": 3}
    if "colour" not in locked:
        if incoming in ("title", "explicit") and rank.get(incoming, 0) >= rank.get(prior, 0):
            old["colour"] = item["colour"]
            old["colourSource"] = incoming
        elif incoming == "unknown" and prior in ("legacy", "unknown", "title", "photo"):
            old.pop("colour", None)
            old["colourSource"] = "unknown"
    if price is not None and "price" not in locked:
        old['price'] = price
    old['lastSeen'] = stamp
    return changed


async def perform_scan(search_ids):
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await asyncio.wait_for(pw.chromium.launch(headless=True,
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                args=['--disable-dev-shm-usage']), timeout=50)
            for search_id in search_ids:
                if job['stop']:
                    break
                search = next((s for s in state['searches'] if s['id'] == search_id), None)
                if not search:
                    continue
                job['label'] = f'Checking {search["name"]}'
                report = {'newIds': [], 'changedIds': [], 'errors': [], 'scanned': 0, 'sourcesChecked': 0}
                for link in list(search['links']):
                    if job['stop']:
                        break
                    job['detail'] = site_name(link['site'])
                    depth = int(state.get('options', {}).get('pageDepth', 3))
                    timeout = max(90, min(360, 60 + 35 * depth))
                    try:
                        outcome = await asyncio.wait_for(
                            scan_link(browser, link, depth,
                                      lambda: job['stop'],
                                      lambda detail: job.update(detail=detail)),
                            timeout=timeout)
                    except asyncio.TimeoutError:
                        outcome = {'ok': False,
                                   'error': f'Source timed out after {timeout}s; other sources will continue.'}
                    except Exception as exc:
                        outcome = {'ok': False, 'error': str(exc)[:230]}
                    async with LOCK:
                        snapshot = state['snapshots'].get(link['id'])
                        if not outcome['ok']:
                            state['snapshots'][link['id']] = {**(snapshot or {}), 'ids': (snapshot or {}).get('ids', []),
                                'lastChecked': (snapshot or {}).get('lastChecked'), 'error': outcome['error']}
                            report['errors'].append(f'{site_name(link["site"])}: {outcome["error"]}')
                        else:
                            stamp = now()
                            prior_ids = set(snapshot.get('ids', [])) if snapshot else set()
                            found_ids = set()
                            unverified_total = 0
                            for item in outcome['items']:
                                if item.get('site') == 'autotrader' and is_visible_writeoff(item):
                                    continue
                                if search.get('filters'):
                                    # Preserve all source adverts for cross-site grouping:
                                    # Auto Trader may know the exterior paint while Facebook
                                    # does not. Apply vehicle search colour to the entire
                                    # deduplicated group in the dashboard, not to isolated
                                    # source adverts at ingestion.
                                    scan_filters = {**search['filters'], 'colours': [], 'bodyTypes': []}
                                    include, missing = apply_local_filters(item, scan_filters, search['name'])
                                    if not include:
                                        continue
                                    item['unverifiedFilters'] = missing
                                    if missing:
                                        unverified_total += 1
                                if len(state['listings']) > 150000:
                                    report['errors'].append('Storage limit reached; export a backup and remove old searches.')
                                    break
                                if not isinstance(item.get('id'), str):
                                    continue
                                found_ids.add(item['id'])
                                changed = update_listing(item, stamp)
                                if snapshot and snapshot.get('lastChecked') and item['id'] not in prior_ids:
                                    report['newIds'].append(item['id'])
                                if changed:
                                    report['changedIds'].append(item['id'])
                            incomplete = outcome.get('incomplete', False)
                            all_ids = prior_ids | found_ids if incomplete else found_ids
                            state['snapshots'][link['id']] = {'ids': sorted(all_ids), 'lastChecked': stamp,
                                'error': outcome.get('caveat', '') if incomplete else '', 'incomplete': incomplete,
                                'pagesRead': outcome.get('pagesRead', 0), 'caveat': outcome.get('caveat', '')}
                            report['scanned'] += len(found_ids)
                            report['sourcesChecked'] += 1
                            if link.get('sourceNote') and not link.get('sourceNote', '').startswith('Legacy'):
                                report.setdefault('sourceNotes', {})[link['site']] = link['sourceNote']
                            if incomplete:
                                report['errors'].append(f'{site_name(link["site"])}: scan incomplete; previous ads preserved.')
                        # Update user-facing report after each source rather than only when the whole job ends.
                        search['lastReport'] = {'newIds': sorted(set(report['newIds'])),
                            'changedIds': sorted(set(report['changedIds'])), 'errors': report['errors'],
                            'scanned': report['scanned'], 'sourcesChecked': report['sourcesChecked'],
                            'sourceNotes': report.get('sourceNotes', {})}
                        if report['sourcesChecked']:
                            search['lastChecked'] = now()
                        store()
                job['message'] = f'{search["name"]}: {len(report["newIds"])} newly found, {len(report["changedIds"])} price changes, {len(report["errors"])} warnings.'
    except Exception as exc:
        job['message'] = 'Refresh failed: ' + str(exc)[:230]
    finally:
        # Never leave the job marked as running if Chromium fails to close.
        try:
            if browser:
                await asyncio.wait_for(browser.close(), timeout=15)
        except Exception:
            pass
        finally:
            job.update(busy=False, label='', detail='', finished=now())
        # Fingerprint public thumbnails after the scan, without slowing down
        # or blocking source extraction. Cached hashes persist on /data.
        schedule_photo_hashes()
        if job['stop']:
            job['message'] = 'Refresh stopped. Completed source results have been saved.'

def regenerate_search_links(search):
    """Refresh provider queries after code changes without losing scan history."""
    if not search.get('filters'):
        return False
    generated = generate_links(search['filters'], search.get('sources') or list(SOURCES), search['name'])
    previous = {link['site']: link for link in search.get('links', [])}
    updated = []
    for data in generated:
        old = previous.get(data['site'])
        updated.append({**data, 'id': old['id'] if old else uid()})
    if updated != search['links']:
        # Same provider + same search criteria: retain its baseline and saved cars.
        search['links'] = updated
        return True
    return False


@app.post('/api/refresh')
async def begin_refresh(request: Request):
    body = await payload(request, 4000)
    async with LOCK:
        if job['busy']:
            raise HTTPException(409, 'A refresh is already running.')
        search_id = body.get('searchId')
        if search_id and not any(s['id'] == search_id for s in state['searches']):
            raise HTTPException(404, 'Search not found.')
        search_ids = [search_id] if search_id else [s['id'] for s in state['searches']]
        if not search_ids:
            raise HTTPException(400, 'Create a search first.')
        migrated = False
        for target_id in search_ids:
            search = next((s for s in state['searches'] if s['id'] == target_id), None)
            if search and search.get('filters'):
                try:
                    migrated = regenerate_search_links(search) or migrated
                except ValueError as exc:
                    raise HTTPException(400, f'Cannot recreate {search["name"]} search: {exc}')
        if migrated:
            store()
        job.update(busy=True, stop=False, label='Starting headless Chromium…',
                   detail='', message='', started=now(), finished=None, searchIds=search_ids)
        asyncio.create_task(perform_scan(search_ids))
        return {'ok': True, 'job': job}

@app.post('/api/refresh/stop')
async def stop_refresh():
    job['stop'] = True
    return {'ok': True, 'job': job}

@app.get('/api/facebook/connection/status')
async def facebook_connection_status():
    return await facebook_connection.check_saved_status()


@app.post('/api/facebook/connection/connect')
async def facebook_connection_connect():
    if job['busy']:
        raise HTTPException(409, 'Finish the current refresh before connecting Facebook.')
    return await facebook_connection.start()


@app.post('/api/facebook/connection/reset')
async def facebook_connection_reset():
    if job['busy']:
        raise HTTPException(409, 'Finish the current refresh before resetting Facebook.')
    return await facebook_connection.reset()


@app.post('/api/facebook/connection/recheck')
async def facebook_connection_recheck():
    if job['busy']:
        raise HTTPException(409, 'Finish the current refresh before verifying Facebook.')
    return await facebook_connection.recheck()


@app.post('/api/facebook/connection/code')
async def facebook_connection_code(request: Request):
    if job['busy']:
        raise HTTPException(409, 'Finish the current refresh before verifying Facebook.')
    body = await payload(request, 1000)
    return await facebook_connection.code(body.get('code'))


@app.post('/api/facebook/connection/interact')
async def facebook_connection_interact(request: Request):
    if job['busy']:
        raise HTTPException(409, 'Finish the current scan before completing Facebook verification.')
    body = await payload(request, 1024)
    try:
        return await facebook_connection.interact(
            body.get('kind'), body.get('x'), body.get('y'), body.get('text'))
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.get('/api/facebook/connection/preview')
async def facebook_connection_preview():
    try:
        image = await facebook_connection.screenshot()
        return Response(image, media_type='image/jpeg',
            headers={'Cache-Control':'no-store, private',
                     'X-Content-Type-Options':'nosniff'})
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.get('/api/health')
async def health():
    return {'ok': True, 'busy': job['busy']}

@app.get('/')
@app.get('/dashboard.html')
async def index():
    # A deployment can replace HTML and JavaScript while a browser has the
    # previous dashboard.js cached. Version both local assets from their actual
    # contents so old event handlers never accompany a new interface.
    assets = ROOT / 'public'
    version = sha256((assets / 'dashboard.js').read_bytes() +
                     (assets / 'styles.css').read_bytes()).hexdigest()[:12]
    html = (assets / 'dashboard.html').read_text(encoding='utf-8')
    html = html.replace('src="dashboard.js"',
                        f'src="dashboard.js?v={version}"')
    html = html.replace('href="styles.css"',
                        f'href="styles.css?v={version}"')
    return HTMLResponse(html, headers={'Cache-Control': 'no-store, max-age=0, must-revalidate'})


app.mount('/', StaticFiles(directory=ROOT / 'public'), name='assets')
