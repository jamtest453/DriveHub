"""Verify and maintain the browser session used by the Railway Marketplace scanner.

A phone/browser Facebook login is NOT this Playwright session. All normal
sign-in happens inside Railway; no CAPTCHA bypass or credential transfer.
"""
import asyncio
import os
import time
import math
from urllib.parse import urlsplit
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout, Error as PlaywrightError

from .scanner import facebook_context, facebook_state_path
from . import facebook_profile

CHECK_URL = "https://www.facebook.com/marketplace/search/?query=BMW%20M2"
CHALLENGE_TERMS = (
    "captcha", "unusual traffic", "confirm you are human",
    "confirm you're human", "security check", "enter your code",
    "enter the code", "two-factor authentication", "two factor authentication",
    "temporarily blocked", "suspicious activity", "verify your identity",
)
BAD_URL_PARTS = ("/login", "/checkpoint", "/recover", "/two_step", "/two_factor")


def managed_state_path():
    return facebook_profile.active().managed_path()


async def marketplace_probe(context):
    """Test genuine Marketplace navigation; a c_user cookie alone is insufficient."""
    page = await context.new_page()
    try:
        response = await page.goto(CHECK_URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(1600)
        url = page.url.lower()
        status = response.status if response else None
        if status in (401, 403, 429):
            return "blocked", f"Facebook refused Marketplace in Car Search's browser (HTTP {status})."
        if any(part in url for part in BAD_URL_PARTS):
            return "verification", "Facebook sent Car Search's browser to sign-in or a security checkpoint."
        body = (await page.locator("body").inner_text(timeout=12000))[:7000].lower()
        if any(term in body for term in CHALLENGE_TERMS):
            return "verification", "Facebook is requiring further verification in Car Search's browser."
        if ("log in to facebook" in body or "log into facebook" in body
                or await page.locator('input[name="email"], input[name="pass"]').count()):
            return "verification", "Facebook is showing its login page in Car Search's browser."
        if "marketplace isn't available" in body or "marketplace is not available" in body:
            return "blocked", "Facebook Marketplace is not accessible from this server/account."
        cookies = await context.cookies("https://www.facebook.com")
        if not any(c.get("name") == "c_user" for c in cookies):
            return "verification", "Car Search's browser is not signed into Facebook."
        if await page.locator('a[href*="/marketplace/item/"]').count():
            return "connected", "Marketplace listings loaded in Car Search's browser."
        if any(term in body for term in ("no results", "no listings", "nothing found", "couldn't find any listings")):
            return "connected", "Marketplace returned a genuine no-results page while signed in."
        # A Marketplace page title and a c_user cookie are not sufficient:
        # the server can render a shell without any accessible listings.
        if "content isn't available" in body or "content not available" in body:
            return "blocked", "Facebook did not make Marketplace content available to Car Search's browser."
        return "unverified", "A Facebook cookie exists, but real Marketplace results could not be loaded in Car Search's browser."
    except PlaywrightTimeout:
        return "unverified", "Timed out while checking Marketplace from Car Search's browser."
    except Exception:
        return "unverified", "Could not verify Facebook Marketplace access from Car Search's browser."
    finally:
        await page.close()


class FacebookConnection:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.pw = None
        self.browser = None
        self.context = None
        self.page = None
        self.started = 0
        self.last_attempt = 0
        self.last_stage = "not started"
        self.last_outcome = "No login attempt recorded in this application session."
        self.code_attempts = 0
        self.interaction_count = 0
        self.task = None
        self.check_task = None
        self.last_saved_check = 0
        self.verified_at = 0
        self.state = "not_checked"
        self.message = "Facebook Marketplace connection has not yet been tested."

    def retry_seconds(self):
        if not self.last_attempt:
            return 0
        return max(0, int(301 - (time.monotonic() - self.last_attempt)))

    def status(self):
        return {
            "state": self.state, "message": self.message,
            "verificationPending": bool(self.page is not None),
            "retryAfterSeconds": self.retry_seconds(),
            "stage": self.last_stage,
            "lastOutcome": self.last_outcome,
        }

    async def _close(self):
        try:
            if self.context:
                await self.context.close()
            if self.browser:
                await self.browser.close()
            if self.pw:
                await self.pw.stop()
        finally:
            self.pw = self.browser = self.context = self.page = None
            self.started = 0

    async def check_saved_status(self):
        """Check persisted Marketplace cookies without resubmitting credentials.

        The app can restart on Railway while /data/facebook-session.json survives.
        Re-probe Marketplace so the UI never displays a green badge for a mere
        cookie or for an old in-memory status.
        """
        if self.page is not None or (self.task and not self.task.done()):
            return self.status()
        path = managed_state_path()
        if not path.is_file():
            if self.state == "connected" or self.state == "checking_saved":
                self.state = "not_checked"
                self.message = "No verified Facebook session found."
            return self.status()
        if self.state == "connected" and time.monotonic() - self.verified_at < 300:
            return self.status()
        if self.check_task and not self.check_task.done():
            return self.status()
        if self.state == "unverified" and time.monotonic() - self.last_saved_check < 120:
            return self.status()
        self.state = "checking_saved"
        self.message = "Checking the saved Facebook session against Marketplace…"
        self.last_saved_check = time.monotonic()
        self.check_task = asyncio.create_task(self._check_saved_session())
        return self.status()

    async def _check_saved_session(self):
        """Short, read-only test. Never clear the stored cookies on failure."""
        async with self.lock:
            if self.page is not None or (self.task and not self.task.done()):
                return
            if not managed_state_path().is_file():
                self.state = "not_checked"
                return
            try:
                async with async_playwright() as pw:
                    browser = await pw.chromium.launch(
                        executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                        headless=True, args=["--disable-dev-shm-usage"])
                    try:
                        context = await facebook_context(browser)
                        try:
                            status, detail = await marketplace_probe(context)
                        finally:
                            await context.close()
                    finally:
                        await browser.close()
                self.state = "connected" if status == "connected" else "unverified"
                self.message = ("Verified: Car Search's browser can access Facebook Marketplace."
                                if status == "connected" else detail)
                self.last_stage = "Checked stored Facebook Marketplace session"
                self.last_outcome = detail
                if status == "connected":
                    self.verified_at = time.monotonic()
            except Exception:
                self.state = "unverified"
                self.message = "Could not verify Marketplace with the saved Facebook session."

    async def reset(self):
        """Clear only the Railway Facebook session; preserve car searches/data."""
        async with self.lock:
            if self.task and not self.task.done():
                self.message = ("Finish the current connection attempt before resetting Facebook.")
                return self.status()
            await self._close()
            dest = managed_state_path()
            try:
                if dest.is_file():
                    dest.unlink()
            except OSError:
                self.state = "error"
                self.message = "Could not clear the saved Facebook session."
                return self.status()
            self.state = "not_checked"
            self.verified_at = 0
            self.last_stage = "Facebook browser session cleared"
            self.last_outcome = ("Previous Facebook session removed. New sign-in "
                                 "will use the current Railway environment variables.")
            self.message = ("Facebook session cleared. Ensure FACEBOOK_PASSWORD is correct "
                            "in Railway, then connect once. Other saved data is untouched."
                            if not facebook_profile.active().personal else
                            "Facebook session cleared. Check your Facebook login in Settings, "
                            "then connect once. Other saved data is untouched.")
            self.code_attempts = 0
            self.interaction_count = 0
            return self.status()

    async def login_feedback(self):
        """Identify normal form-validation errors without exposing page contents."""
        if not self.page:
            return None
        try:
            body = (await self.page.locator("body").inner_text(timeout=8000))[:5000].casefold()
        except Exception:
            return None
        incorrect = (
            "incorrect password", "wrong password", "invalid password",
            "password you entered is incorrect", "password you.ve entered is incorrect",
            "the password that you entered is incorrect",
            "incorrect email or password", "incorrect phone number or password",
        )
        if any(marker in body for marker in incorrect):
            if facebook_profile.active().personal:
                return ("invalid_credentials", "Facebook says your login details are incorrect. "
                        "Update your Facebook password in Car Search Settings and connect again.")
            return ("invalid_credentials", "Facebook says the login details are incorrect. "
                    "Update FACEBOOK_PASSWORD in Railway Variables, redeploy, and reset the server session.")
        if "account has been disabled" in body or "your account has been suspended" in body:
            return ("blocked", "Facebook is reporting an account restriction. Sign into Facebook directly to review it.")
        return None

    async def _browser(self):
        if not self.pw:
            self.pw = await async_playwright().start()
            self.browser = await self.pw.chromium.launch(
                executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                headless=True, args=["--disable-dev-shm-usage"])

    async def _commit_verified(self):
        dest = managed_state_path()
        dest.parent.mkdir(parents=True, exist_ok=True)
        temp = dest.with_suffix(".tmp")
        try:
            await self.context.storage_state(path=str(temp))
            os.chmod(temp, 0o600)
            os.replace(temp, dest)
        finally:
            if temp.is_file():
                temp.unlink()
        facebook_profile.active().saved()
        self.state = "connected"
        self.verified_at = time.monotonic()
        self.message = "Verified: Car Search's browser can access Facebook Marketplace."
        await self._close()

    async def start(self):
        """Start a connection attempt without tying it to a long HTTP request."""
        if self.task and not self.task.done():
            return self.status()
        # Preserve an open Facebook 2FA/checkpoint page; a second click must
        # not discard an approval that the owner is completing on their phone.
        if self.page and time.monotonic() - self.started < 900:
            return self.status()
        if self.retry_seconds() and self.state not in ("connected", "verification", "unverified"):
            self.state = "cooldown"
            self.message = (
                f"Car Search Hub is pausing another attempt for {self.retry_seconds()} seconds. "
                "This is the app's own safety limit, not a Facebook warning. "
                "Facebook may send no notification. " + self.last_outcome
            )
            return self.status()
        self.state = "connecting"
        self.message = "Signing in and verifying Marketplace access…"
        self.task = asyncio.create_task(self.connect())
        return self.status()

    async def connect(self):
        async with self.lock:
            if self.page and time.monotonic() - self.started < 900:
                return self.status()
            await self._close()
            self.state = "connecting"
            self.message = "Checking Facebook Marketplace from Car Search's browser."
            try:
                await self._browser()
                self.context = await facebook_context(self.browser)
                self.last_stage = "Checking previous Marketplace session"
                check, detail = await marketplace_probe(self.context)
                if check == "connected":
                    await self._commit_verified()
                    return self.status()
                # A blocked *unauthenticated* Marketplace page does not establish
                # whether a fresh login can work. Try one sign-in, if permitted
                # by the app's retry limit, rather than stopping prematurely.
                initial_probe = detail

                email, password = facebook_profile.active().credentials()
                if not email or not password:
                    self.state = "needs_credentials"
                    self.message = ("Add your Facebook email or phone number and password in Car Search Settings."
                                    if facebook_profile.active().personal else
                                    "Add FACEBOOK_EMAIL (a phone number is fine) and FACEBOOK_PASSWORD to Railway Variables.")
                    await self._close()
                    return self.status()
                if self.retry_seconds():
                    self.state = "cooldown"
                    self.message = (
                        f"Car Search Hub is pausing another attempt for {self.retry_seconds()} seconds. "
                        "This is a local retry limit, not an indication that Facebook requested "
                        "verification or sent an alert. " + self.last_outcome
                    )
                    await self._close()
                    return self.status()

                # Discard stale cookies before an explicit new login attempt.
                await self.context.close()
                self.context = await facebook_context(self.browser, use_saved_state=False)
                self.page = await self.context.new_page()
                self.interaction_count = 0
                # The owner may interact with verification prompts, but the
                # remote browser must not navigate to third-party sites.
                async def guard_owner_navigation(route):
                    request = route.request
                    if request.is_navigation_request() and request.frame == self.page.main_frame:
                        parsed = urlsplit(request.url)
                        host = (parsed.hostname or "").lower()
                        allowed = parsed.scheme == "https" and (
                            host == "facebook.com" or host.endswith(".facebook.com")
                        )
                        if not allowed:
                            return await route.abort()
                    return await route.continue_()
                await self.page.route("**/*", guard_owner_navigation)
                self.last_stage = "Loading Facebook login form"
                await self.page.goto("https://www.facebook.com/login", wait_until="domcontentloaded", timeout=30000)
                self.last_stage = "Filling in Facebook's login form"
                await self.page.locator('input[name="email"]').fill(email, timeout=14000)
                await self.page.locator('input[name="pass"]').fill(password, timeout=14000)
                # Treat login as a form: pressing Enter in the password
                # field triggers the normal browser submit path without
                # Playwright waiting for a potentially hidden/overlaid button.
                # A click-only approach often times out against Meta's newer UI.
                self.last_attempt = time.monotonic()
                self.started = self.last_attempt
                self.last_stage = "Submitting Facebook form with Enter"
                submit_issue = None
                try:
                    password_input = self.page.locator('input[name="pass"]')
                    await password_input.press("Enter", timeout=10000, no_wait_after=True)
                    self.last_outcome = "Enter key sent to the Facebook password field. Checking the result."
                except PlaywrightTimeout:
                    submit_issue = "Pressing Enter in Facebook's password field timed out."
                except PlaywrightError:
                    submit_issue = "Car Search could not send Enter to Facebook's password field."
                self.last_stage = "Checking Facebook after keyboard submission"
                if submit_issue:
                    self.last_outcome = submit_issue + " Marketplace is not verified."
                    # Do not attempt a second blind sign-in: keep the real
                    # browser page for inspection after the cooldown.
                    self.state = "error"
                    self.message = self.last_outcome + " View Car Search's Facebook screen to diagnose it."
                    return self.status()
                await self.page.wait_for_timeout(1800)
                feedback = await self.login_feedback()
                if feedback:
                    self.state, self.last_outcome = feedback
                    self.last_stage = "Facebook login form returned an error"
                    self.message = self.last_outcome
                    return self.status()
                check, detail = await marketplace_probe(self.context)
                if check == "connected":
                    self.last_outcome = "Marketplace loaded using the saved session."
                    await self._commit_verified()
                elif check == "blocked":
                    self.last_outcome = detail
                    self.last_stage = "Marketplace blocked after sign-in attempt"
                    self.state, self.message = "blocked", detail + " No Facebook notification is necessarily sent."
                    await self._close()
                else:
                    self.last_outcome = detail
                    self.last_stage = "Marketplace access not yet verified after keyboard submission"
                    self.state = check
                    self.message = (detail +
                                    " The browser sent Enter to the password field but did not "
                                    "confirm Marketplace access. View Car Search's Facebook screen. "
                                    "Only enter a code or approve a notification if Facebook asks for it.")
                return self.status()
            except Exception:
                # Do not expose raw Playwright errors (which can contain page
                # data or private URLs). Preserve the live login page when
                # possible so the owner can inspect it without repeating login.
                stage = self.last_stage
                self.state = "error"
                self.last_outcome = f"Failed during: {stage}. Marketplace access is not confirmed."
                if self.page and self.context:
                    self.started = self.started or time.monotonic()
                    self.message = (self.last_outcome +
                                    " Open Car Search's Facebook screen to diagnose the page "
                                    "before attempting another login.")
                else:
                    self.message = (self.last_outcome + " The server login browser is unavailable.")
                    await self._close()
                return self.status()

    async def recheck(self):
        async with self.lock:
            if not self.context or not self.page or time.monotonic() - self.started > 900:
                await self._close()
                self.state, self.message = "expired", "No live verification session. Select Connect Facebook again."
                return self.status()
            check, detail = await marketplace_probe(self.context)
            if check == "connected":
                await self._commit_verified()
            elif check == "blocked":
                self.state, self.message = "blocked", detail
                await self._close()
            else:
                self.state, self.message = check, (detail + " Check Car Search's Facebook screen. "
                    "Facebook may not issue a notification. Recheck only after taking any requested action.")
            return self.status()

    async def code(self, code):
        async with self.lock:
            if not self.page or time.monotonic() - self.started > 900:
                self.state, self.message = "expired", "Start a new Facebook login first."
                return self.status()
            if not isinstance(code, str) or not code.isdigit() or not 4 <= len(code) <= 10:
                self.message = "Enter a numeric verification code of 4–10 digits."
                return self.status()
            if self.code_attempts >= 3:
                self.message = "Too many code attempts. Complete verification through Facebook instead."
                return self.status()
            self.code_attempts += 1
            try:
                target = self.page.locator(
                    'input[autocomplete="one-time-code"], input[name="approvals_code"], '
                    'input[name="code"], input[name="security_code"], input[type="tel"]'
                )
                if not await target.count():
                    self.message = "No verification-code field was found. Use the preview to check Facebook's current request."
                    return self.status()
                await target.first.fill(code, timeout=8000)
                submit = self.page.locator('button[type="submit"], button[name="submit"]')
                if await submit.count():
                    await submit.first.click(timeout=8000)
                else:
                    await target.first.press("Enter")
                await self.page.wait_for_timeout(1800)
                check, detail = await marketplace_probe(self.context)
                if check == "connected":
                    await self._commit_verified()
                else:
                    self.state, self.message = "verification", "Facebook still needs approval. Check the verification screen or recheck."
            except Exception:
                self.state, self.message = "verification", "Facebook did not accept the code automatically. Check the security screen."
            return self.status()

    async def interact(self, kind, x=None, y=None, text=None):
        """Owner-directed actions on an active Facebook challenge page only.

        The normal credential sign-in is automated. This remote interaction
        is needed solely for Meta's human confirmation/checkpoint steps.
        No password, code or page contents are logged or sent back.
        """
        async with self.lock:
            if not self.page or not self.context or time.monotonic() - self.started > 900:
                raise ValueError("The Facebook verification session expired. Connect again.")
            if self.interaction_count >= 100:
                raise ValueError("Too many verification interactions. Start a fresh connection.")
            parsed = urlsplit(self.page.url)
            hostname = (parsed.hostname or "").lower()
            if parsed.scheme != "https" or not (
                hostname == "facebook.com" or hostname.endswith(".facebook.com")
            ):
                raise ValueError("Car Search's browser left Facebook. Verification controls disabled.")
            try:
                if kind == "click":
                    if not (isinstance(x, (int, float)) and isinstance(y, (int, float))
                            and math.isfinite(x) and math.isfinite(y)):
                        raise ValueError("Invalid tap position.")
                    viewport = self.page.viewport_size or {"width":1440,"height":1100}
                    if not (0 <= x < viewport["width"] and 0 <= y < viewport["height"]):
                        raise ValueError("Tap position is outside the Facebook screen.")
                    await self.page.mouse.click(float(x), float(y))
                elif kind == "type":
                    if not isinstance(text, str) or not 1 <= len(text) <= 120:
                        raise ValueError("Enter up to 120 characters into the selected Facebook field.")
                    # Prevent writing data to arbitrary elements / hidden pages.
                    is_editable = await self.page.evaluate("""() => {
                        const active = document.activeElement;
                        return !!active && (
                            active.matches('input:not([type=hidden]), textarea') ||
                            active.isContentEditable
                        );
                    }""")
                    if not is_editable:
                        raise ValueError("Tap the verification input on the screen before typing.")
                    await self.page.keyboard.insert_text(text)
                elif kind == "key":
                    if text not in ("Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown"):
                        raise ValueError("Unsupported verification key.")
                    await self.page.keyboard.press(text)
                elif kind == "scroll_down":
                    await self.page.mouse.wheel(0, 510)
                elif kind == "scroll_up":
                    await self.page.mouse.wheel(0, -510)
                else:
                    raise ValueError("Unsupported Facebook verification action.")
                self.interaction_count += 1
                await self.page.wait_for_timeout(400)
                self.last_stage = "Owner completing Facebook verification"
                self.message = ("Action sent to the Facebook screen. Continue if prompted, "
                                "then select Recheck Marketplace access.")
                return self.status()
            except ValueError:
                raise
            except (PlaywrightError, PlaywrightTimeout) as exc:
                raise ValueError("Facebook did not accept that interaction. Refresh the private screen.") from exc


    async def screenshot(self):
        async with self.lock:
            if not self.page or time.monotonic() - self.started > 900:
                raise ValueError("No active Facebook verification screen.")
            try:
                return await self.page.screenshot(type="jpeg", quality=68, full_page=False, timeout=15000)
            except Exception as exc:
                raise ValueError("Facebook's login page is not available for preview.") from exc


connection = FacebookConnection()
