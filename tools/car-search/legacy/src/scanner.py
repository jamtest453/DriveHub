"""Server-side car result extraction using headless Chromium (Playwright)."""
import asyncio
import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit, urlencode

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

from .ebay_api import scan_ebay_api
from .writeoff import is_visible_writeoff

# Keep browser cookies on the persistent Railway volume. Credentials are read from
# Railway Variables only; never return, print or persist the password itself.
from . import facebook_profile

_FB_LOGIN_LOCK = asyncio.Lock()
_FB_LAST_FAILED_ATTEMPT = 0.0


def _last_failed():
    profile = facebook_profile.active()
    return profile.last_failed_attempt if profile.personal else _FB_LAST_FAILED_ATTEMPT


def _set_last_failed(value):
    global _FB_LAST_FAILED_ATTEMPT
    profile = facebook_profile.active()
    if profile.personal:
        profile.last_failed_attempt = value
    else:
        _FB_LAST_FAILED_ATTEMPT = value


def facebook_state_path():
    profile = facebook_profile.active()
    if profile.personal:
        # A signed-in person's own session only; never the server's.
        return profile.managed_path()
    # The verified, managed session takes precedence over older manually
    # provided storage state. Otherwise a stale Railway variable overrides
    # an interactive sign-in and makes refresh look permanently logged out.
    managed = Path(os.getenv("DATA_DIR", "/data")) / "facebook-session.json"
    if managed.is_file():
        return managed
    explicit = os.getenv("FACEBOOK_STORAGE_STATE", "").strip()
    if explicit and Path(explicit).is_file():
        return Path(explicit)
    return managed


async def facebook_context(browser, use_saved_state=True):
    options = dict(
        viewport={"width": 1440, "height": 1100},
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale="en-GB", timezone_id="Europe/London",
        service_workers="block", accept_downloads=False,
    )
    path = facebook_state_path()
    if use_saved_state and path.is_file():
        try:
            return await browser.new_context(storage_state=str(path), **options)
        except (OSError, ValueError):
            # The state may be stale or corrupt. Login only if credentials exist.
            pass
    return await browser.new_context(**options)


async def ensure_facebook_session(context):
    """Attempt one normal Facebook sign-in, never a CAPTCHA/2FA bypass."""
    cookies = await context.cookies("https://www.facebook.com")
    if any(c.get("name") == "c_user" for c in cookies):
        return
    profile = facebook_profile.active()
    email, password = profile.credentials()
    if not email or not password:
        raise ValueError("Facebook is not signed in. Set " + profile.where_to_set() + ".")
    import time
    async with _FB_LOGIN_LOCK:
        cookies = await context.cookies("https://www.facebook.com")
        if any(c.get("name") == "c_user" for c in cookies):
            return
        if time.monotonic() - _last_failed() < 900:
            raise ValueError("Facebook login was unsuccessful recently. Retry later or complete account verification in Facebook.")
        login_page = await context.new_page()
        try:
            await login_page.goto("https://www.facebook.com/login", wait_until="domcontentloaded", timeout=35000)
            await login_page.locator('input[name="email"]').wait_for(timeout=12000)
            await login_page.locator('input[name="email"]').fill(email)
            await login_page.locator('input[name="pass"]').fill(password)
            await login_page.locator('button[name="login"]').click(timeout=12000)
            # Authentication can redirect through checkpoint/2FA pages.
            for _ in range(12):
                await login_page.wait_for_timeout(1000)
                cookies = await context.cookies("https://www.facebook.com")
                if any(c.get("name") == "c_user" for c in cookies):
                    break
            else:
                _set_last_failed(time.monotonic())
                raise ValueError("Facebook did not complete login. Check your credentials and any Facebook security alert.")
            # A cookie may be set before two-factor verification has completed.
            # Never falsely treat a challenge page as a completed sign-in.
            if any(marker in login_page.url.lower() for marker in ("checkpoint", "two_step", "two-factor", "recover", "login/")):
                _set_last_failed(time.monotonic())
                raise ValueError("Facebook requires further account verification in Car Search's browser. Automatic login cannot complete it.")
            dest = profile.managed_path()
            dest.parent.mkdir(parents=True, exist_ok=True)
            temp = dest.with_suffix(".tmp")
            await context.storage_state(path=str(temp))
            os.chmod(temp, 0o600)
            os.replace(temp, dest)
            _set_last_failed(0.0)
            profile.saved()
        except (PlaywrightTimeout, OSError) as exc:
            _set_last_failed(time.monotonic())
            raise ValueError("Facebook login timed out or session could not be saved. Account verification may be required.") from exc
        finally:
            await login_page.close()


SITES = {'autotrader': 'Auto Trader', 'ebay': 'eBay', 'pistonheads': 'PistonHeads', 'facebook': 'Facebook'}
ROOTS = {'autotrader': {'autotrader.co.uk'}, 'ebay': {'ebay.co.uk', 'ebay.com'},
         'pistonheads': {'pistonheads.com'}, 'facebook': {'facebook.com'}}
EXTRACTOR = (Path(__file__).parent / 'extractor.js').read_text(encoding='utf-8')


def site_for(raw):
    try:
        parsed = urlsplit(raw)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        host = (parsed.hostname or '').lower().rstrip('.')
        for site, roots in ROOTS.items():
            if any(host == root or host.endswith('.' + root) for root in roots):
                return site
    except (ValueError, TypeError):
        pass
    return None


def clean_url(raw):
    if not isinstance(raw, str) or len(raw) > 4000 or not site_for(raw):
        return None
    u = urlsplit(raw.strip())
    return urlunsplit((u.scheme, u.netloc, u.path or '/', u.query, ''))


def url_for_page(raw, site, page):
    if site == 'facebook':
        return raw
    if page <= 1 and site != 'autotrader':
        return raw
    u = urlsplit(raw)
    values = parse_qs(u.query, keep_blank_values=True)
    if site == 'autotrader':
        # Apply to structured AND legacy URLs on EVERY scan, even when the
        # saved search predates the newer provider filter.
        values.pop('writeoff-categories', None)
        values.pop('only-writeoff-categories', None)
        values['exclude-writeoff-categories'] = ['on']
    if page > 1:
        values['_pgn' if site == 'ebay' else 'page'] = [str(page)]
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(values, doseq=True), ''))


def fb_query(raw):
    params = parse_qs(urlsplit(raw).query)
    query = next((v[0].strip() for k in ('query', 'q', 'keywords') if (v := params.get(k)) and v[0].strip()), '')
    return unquote(query)


def match_fb_title(title, query):
    import re
    tokens = re.findall(r'[a-z0-9]+', query.casefold())
    title_tokens = set(re.findall(r'[a-z0-9]+', str(title).casefold()))
    # A listing must contain every meaningful search term, regardless of punctuation or word order.
    return bool(tokens) and all(token in title_tokens for token in tokens)


def unsafe_host(host):
    host = (host or '').lower().strip('[]').rstrip('.')
    if host in {'localhost', 'metadata.google.internal'} or host.endswith(('.localhost', '.local', '.internal')):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return not ip.is_global
    except ValueError:
        return False


async def scan_link(browser, link, depth, stopped, progress):
    site = link['site']
    if site == 'ebay':
        return await scan_ebay_api(link, depth, stopped, progress)
    query = fb_query(link['url']) if site == 'facebook' else ''
    if site == 'facebook' and not query:
        return {'ok': False, 'error': 'Facebook URL has no search query; add a Marketplace search URL with ?query=… so title filtering can be applied.'}

    try:
        if site == 'facebook':
            context = await facebook_context(browser)
            # Never assume the user's phone session is shared with Railway.
            # An explicit "Connect Facebook" must verify Marketplace first.
            cookies = await context.cookies("https://www.facebook.com")
            if not any(cookie.get("name") == "c_user" for cookie in cookies):
                raise ValueError("Car Search is not signed into Facebook. Select Connect Facebook in the dashboard first.")
        else:
            context = await browser.new_context(
                viewport={'width': 1440, 'height': 1100},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                locale='en-GB', timezone_id='Europe/London',
                service_workers='block', accept_downloads=False)
    except ValueError as exc:
        if 'context' in locals():
            await context.close()
        return {'ok': False, 'error': str(exc)[:230]}
    context.set_default_timeout(15000)
    async def protect(route):
        url = route.request.url
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in {'https', 'http'} or unsafe_host(parsed.hostname):
                await route.abort(); return
        except Exception:
            await route.abort(); return
        # Don't follow cross-site top-level redirects; the page should remain on the requested provider.
        if route.request.is_navigation_request() and route.request.frame == page.main_frame and site_for(url) != site:
            await route.abort(); return
        await route.continue_()

    page = await context.new_page()
    await page.route('**/*', protect)
    found = {}
    pages_read = 0
    incomplete = False
    caveat = ''
    try:
        for n in range(1, 2 if site == 'facebook' else max(1, min(20, depth)) + 1):
            if stopped():
                incomplete = True; caveat = 'Stopped early; previous listings retained.'; break
            progress(f'{SITES[site]} · ' + ('scrolling Marketplace' if site == 'facebook' else f'page {n}'))
            target = url_for_page(link['url'], site, n)
            try:
                response = await page.goto(target, wait_until='domcontentloaded', timeout=35000)
                await page.wait_for_timeout(1300)
                if site in ('autotrader', 'pistonheads'):
                    # Both sites render some result cards after the initial HTML.
                    # Wait briefly rather than declaring an empty JS shell.
                    selector = ('a[href*="/car-details/"]' if site == 'autotrader'
                                else 'a[href*="/buy/listing/"]')
                    try:
                        await page.wait_for_selector(selector, timeout=9000)
                    except PlaywrightTimeout:
                        pass
            except PlaywrightTimeout:
                raise ValueError('Page load timed out.')
            if site_for(page.url) != site:
                raise ValueError('Redirected outside the expected car website.')
            if response and response.status in (401, 403, 429):
                raise ValueError(f'Website blocked the request (HTTP {response.status}).')
            await page.evaluate(EXTRACTOR)
            result = await page.evaluate('(site) => window.__CSH_SCRAPE__(site, 350)', site)
            if result.get('blocked'):
                raise ValueError('Login, CAPTCHA or human verification required. The server cannot bypass this.')
            items = result.get('items') or []
            # If a filtered results page fails to render advert cards, try
            # that provider\'s public, verified make/model page. Never use
            # this fallback to evade HTTP errors or CAPTCHA challenges.
            if (site in ('autotrader', 'pistonheads') and n == 1 and not items
                    and not result.get('blocked') and not result.get('noResults')
                    and link.get('browseUrl')):
                progress(f'{SITES[site]} · trying public model listings')
                browse_url = link['browseUrl']
                if site_for(browse_url) == site:
                    backup = await page.goto(browse_url, wait_until='domcontentloaded', timeout=35000)
                    if backup and backup.status in (401, 403, 429):
                        raise ValueError(f'{SITES[site]} blocked its model page (HTTP {backup.status}).')
                    try:
                        selector = ('a[href*="/car-details/"]' if site == 'autotrader'
                                    else 'a[href*="/buy/listing/"]')
                        await page.wait_for_selector(selector, timeout=11000)
                    except PlaywrightTimeout:
                        pass
                    await page.evaluate(EXTRACTOR)
                    second = await page.evaluate('(site) => window.__CSH_SCRAPE__(site, 350)', site)
                    items = second.get('items') or []
                    if items:
                        incomplete = True
                        caveat = (f'{SITES[site]} filtered results did not render. '
                                  'Used public model listings; locally verifiable filters '
                                  'are applied, and coverage may be incomplete.')
                    elif second.get('blocked'):
                        raise ValueError(f'{SITES[site]} requested human verification on its model page.')
            if site == 'facebook':
                filtered = [item for item in items if match_fb_title(item.get('title'), query)]
                # A page full of irrelevant Marketplace ads is a valid zero-match scan.
                if items and not filtered:
                    pages_read = 1
                    break
                items = filtered
            if not items:
                if not pages_read and result.get('noResults'):
                    pages_read = 1; break
                if not pages_read:
                    raise ValueError('No readable listings. The site may need login, may block headless browsers, or may have changed its layout.')
                break
            before = len(found)
            for item in items:
                if not isinstance(item, dict) or not item.get('id', '').startswith(site + ':'):
                    continue
                if site == 'autotrader' and is_visible_writeoff(item):
                    continue
                found[item['id']] = item
            if n > 1 and before == len(found):
                incomplete = True; caveat = 'Site returned repeated results on page ' + str(n) + '; earlier results were preserved.'
                break
            pages_read += 1
            if incomplete and site in ('autotrader', 'pistonheads'):
                break
            if len(items) < 12 or site == 'facebook':
                break
            await asyncio.sleep(0.4)
        return {'ok': True, 'items': list(found.values()), 'pagesRead': pages_read, 'incomplete': incomplete, 'caveat': caveat}
    except Exception as exc:
        error = str(exc)[:230]
        if pages_read:
            return {'ok': True, 'items': list(found.values()), 'pagesRead': pages_read, 'incomplete': True, 'caveat': f'Some result pages failed: {error}'}
        return {'ok': False, 'error': error}
    finally:
        # A hung browser context must never leave a refresh running forever.
        try:
            await asyncio.wait_for(context.close(), timeout=12)
        except Exception:
            pass

