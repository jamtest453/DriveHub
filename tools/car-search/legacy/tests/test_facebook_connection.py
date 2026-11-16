"""Offline regression checks for Facebook's Railway-only connection."""
import pytest
import httpx

import server
from src import scanner
from src.facebook_connection import FacebookConnection, marketplace_probe


class FakeResponse:
    status = 200


class FakeLocator:
    def __init__(self, page, selector):
        self.page, self.selector = page, selector

    async def inner_text(self, timeout=0):
        return self.page.body

    async def count(self):
        if 'marketplace/item/' in self.selector:
            return self.page.items
        if 'input[name=' in self.selector:
            return self.page.form_inputs
        return 0


class FakePage:
    def __init__(self, url, body, items=0, inputs=0):
        self.url, self.body = url, body
        self.items, self.form_inputs = items, inputs
        self.closed = False

    async def goto(self, url, **kwargs):
        return FakeResponse()

    async def wait_for_timeout(self, ms):
        return None

    def locator(self, selector):
        return FakeLocator(self, selector)

    async def title(self):
        return "Marketplace | Facebook"

    async def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, page, cookies):
        self.page, self.saved_cookies = page, cookies

    async def new_page(self):
        return self.page

    async def cookies(self, url):
        return self.saved_cookies


@pytest.mark.asyncio
async def test_facebook_cookie_does_not_override_login_redirect():
    page = FakePage("https://www.facebook.com/login/", "Log in to Facebook")
    context = FakeContext(page, [{"name": "c_user", "value": "old"}])
    state, message = await marketplace_probe(context)
    assert state == "verification", message
    assert page.closed


@pytest.mark.asyncio
async def test_facebook_marketplace_requires_real_visible_content():
    page = FakePage("https://www.facebook.com/marketplace/search/?query=BMW%20M2",
                    "Marketplace BMW M2 results", items=3)
    context = FakeContext(page, [{"name": "c_user", "value": "valid"}])
    state, message = await marketplace_probe(context)
    assert state == "connected", message


@pytest.mark.asyncio
async def test_cookie_and_marketplace_title_alone_do_not_mean_connected():
    page = FakePage("https://www.facebook.com/marketplace/search/?query=m2",
                    "Marketplace")
    state, message = await marketplace_probe(FakeContext(page, [{"name":"c_user","value":"old"}]))
    assert state == "unverified", message


@pytest.mark.asyncio
async def test_marketplace_without_cookie_is_not_connected():
    page = FakePage("https://www.facebook.com/marketplace/search/?query=m2",
                    "Marketplace welcome")
    state, _ = await marketplace_probe(FakeContext(page, []))
    assert state != "connected"


def test_verified_session_path_wins_over_legacy_override(tmp_path, monkeypatch):
    (tmp_path / "facebook-session.json").write_text("{}")
    legacy = tmp_path / "legacy-session.json"
    legacy.write_text("{}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FACEBOOK_STORAGE_STATE", str(legacy))
    assert scanner.facebook_state_path() == tmp_path / "facebook-session.json"


@pytest.mark.asyncio
async def test_scanner_asks_to_connect_not_auto_signin(monkeypatch):
    class Context:
        closed = False
        async def cookies(self, url): return []
        async def close(self): self.closed = True

    ctx = Context()
    async def stub_context(browser): return ctx
    monkeypatch.setattr(scanner, "facebook_context", stub_context)
    response = await scanner.scan_link(
        object(), {"site":"facebook",
                   "url":"https://www.facebook.com/marketplace/search/?query=BMW+M2"},
        1, lambda:False, lambda _:None)
    assert response["ok"] is False
    assert "Connect Facebook" in response["error"]
    assert ctx.closed


@pytest.mark.asyncio
async def test_facebook_connection_endpoint_returns_no_secrets(monkeypatch):
    monkeypatch.setattr(server, "PASSWORD", "")
    async def mock_start():
        return {"state":"connecting", "message":"Checking Facebook in Railway",
                "verificationPending":False}
    monkeypatch.setattr(server.facebook_connection, "start", mock_start)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        res = await client.post("/api/facebook/connection/connect", json={})
        assert res.status_code == 200
        assert res.json()["state"] == "connecting"
        assert "FACEBOOK_PASSWORD" not in res.text


def test_recent_attempt_is_local_cooldown_not_facebook_notification():
    import time
    conn = FacebookConnection()
    conn.last_attempt = time.monotonic() - 5
    conn.last_stage = "Submitting Railway login form"
    conn.last_outcome = "Marketplace did not load."
    assert conn.retry_seconds() > 0
    assert conn.status()["stage"] == "Submitting Railway login form"


@pytest.mark.asyncio
async def test_start_during_cooldown_does_not_repeat_credentials_submission():
    import time
    conn = FacebookConnection()
    conn.state = "error"
    conn.last_attempt = time.monotonic() - 10
    conn.last_outcome = "Facebook has not verified the previous login."
    result = await conn.start()
    assert result["state"] == "cooldown"
    assert "app's own safety limit" in result["message"]
    assert result["retryAfterSeconds"] > 0
    assert conn.task is None


@pytest.mark.asyncio
async def test_unauthenticated_marketplace_block_does_not_prevent_first_login(monkeypatch):
    import src.facebook_connection as fbmodule

    class FakeBrowser:
        async def close(self): pass

    class FakeLocator:
        @property
        def first(self): return self
        async def count(self): return 1
        async def fill(self, value, timeout=0): pass
        async def press(self, key, timeout=0, no_wait_after=False): pass

    class FakeLoginPage:
        url = "https://www.facebook.com/login"
        async def goto(self, url, **kwargs): self.url = url
        async def route(self, pattern, callback): pass
        def locator(self, selector): return FakeLocator()
        async def wait_for_timeout(self, millis): pass
        async def close(self): pass

    class FakeContext:
        async def close(self): pass
        async def new_page(self): return FakeLoginPage()

    checks = 0
    async def fake_probe(ctx):
        nonlocal checks
        checks += 1
        return ("blocked", "Facebook Marketplace returned a 403.")

    async def fake_browser(self):
        self.browser = FakeBrowser()

    async def fake_context(browser, use_saved_state=True):
        return FakeContext()

    monkeypatch.setattr(fbmodule, "marketplace_probe", fake_probe)
    monkeypatch.setattr(fbmodule, "facebook_context", fake_context)
    monkeypatch.setattr(FacebookConnection, "_browser", fake_browser)
    monkeypatch.setenv("FACEBOOK_EMAIL", "+447700900000")
    monkeypatch.setenv("FACEBOOK_PASSWORD", "placeholder-test-secret")
    conn = FacebookConnection()
    outcome = await conn.connect()
    assert checks == 2, "A blocked anonymous Marketplace page should not suppress an eligible sign-in."
    assert conn.last_attempt > 0
    assert outcome["state"] == "blocked"
    assert "after sign-in" in outcome["stage"]


@pytest.mark.asyncio
async def test_submit_enter_timeout_preserves_preview_and_does_not_claim_connected(monkeypatch):
    import src.facebook_connection as fbmodule
    from playwright.async_api import TimeoutError as BrowserTimeout

    class FakeBrowser:
        async def close(self): pass

    class FakeLocator:
        def __init__(self, kind): self.kind = kind
        @property
        def first(self): return self
        async def count(self): return 1
        async def fill(self, value, timeout=0): pass
        async def press(self, key, timeout=0, no_wait_after=False):
            assert key == "Enter" and no_wait_after is True
            raise BrowserTimeout("Playwright click exceeded timeout")

    class FakePage:
        url = "https://www.facebook.com/login"
        async def goto(self, url, **kwargs): self.url = url
        async def route(self, pattern, callback): pass
        def locator(self, selector): return FakeLocator(selector)
        async def wait_for_timeout(self, millis): pass
        async def screenshot(self, **kwargs): return b"jpeg-binary"

    class FakeContext:
        async def close(self): pass
        async def new_page(self): return FakePage()

    checks = 0
    async def fake_probe(context):
        nonlocal checks
        checks += 1
        return ("verification", "Facebook still shows its login form.")

    async def fake_browser(self): self.browser = FakeBrowser()
    async def fake_context(browser, use_saved_state=True): return FakeContext()
    monkeypatch.setattr(fbmodule, "marketplace_probe", fake_probe)
    monkeypatch.setattr(fbmodule, "facebook_context", fake_context)
    monkeypatch.setattr(FacebookConnection, "_browser", fake_browser)
    monkeypatch.setenv("FACEBOOK_EMAIL", "example-test-login")
    monkeypatch.setenv("FACEBOOK_PASSWORD", "not-a-real-password")

    conn = FacebookConnection()
    status = await conn.connect()
    assert checks == 1
    assert status["state"] == "error"
    assert status["verificationPending"] is True
    assert "Pressing Enter" in status["lastOutcome"]
    assert conn.retry_seconds() > 0
    assert await conn.screenshot() == b"jpeg-binary"
    # The page is diagnostic, not a successful authenticated Marketplace session.
    assert "connected" not in status["message"].lower()


@pytest.mark.asyncio
async def test_enter_submission_works_when_no_button_selector_exists(monkeypatch):
    import src.facebook_connection as fbmodule
    class FakeLocator:
        @property
        def first(self): return self
        async def count(self): return 0
        async def fill(self, value, timeout=0): pass
        async def press(self, key, timeout=0, no_wait_after=False):
            assert key == "Enter" and no_wait_after
    class FakePage:
        url = "https://www.facebook.com/login"
        async def goto(self, url, **kwargs): self.url = url
        async def route(self, pattern, callback): pass
        def locator(self, selector):
            assert "button" not in selector
            return FakeLocator()
        async def wait_for_timeout(self, millis): pass
    class FakeContext:
        async def close(self): pass
        async def new_page(self): return FakePage()
    class FakeBrowser:
        async def close(self): pass
    async def fake_probe(context): return ("verification", "Login needed")
    async def fake_browser(self): self.browser = FakeBrowser()
    async def fake_context(browser, use_saved_state=True): return FakeContext()
    monkeypatch.setattr(fbmodule, "marketplace_probe", fake_probe)
    monkeypatch.setattr(fbmodule, "facebook_context", fake_context)
    monkeypatch.setattr(FacebookConnection, "_browser", fake_browser)
    monkeypatch.setenv("FACEBOOK_EMAIL", "fake-phone")
    monkeypatch.setenv("FACEBOOK_PASSWORD", "test-password")

    conn = FacebookConnection()
    result = await conn.connect()
    assert result["state"] == "verification"
    assert result["verificationPending"] is True
    assert result["retryAfterSeconds"] > 0
    assert "sent Enter" in result["message"]
    assert conn.page is not None


@pytest.mark.asyncio
async def test_reset_clears_only_facebook_session_and_keeps_car_files(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    facebook = tmp_path / "facebook-session.json"
    facebook.write_text('{"cookies":[]}')
    saved = tmp_path / "car-search-hub.json"
    saved.write_text('{"myCars":["keep"]}')
    client = FacebookConnection()
    result = await client.reset()
    assert result["state"] == "not_checked"
    assert not facebook.exists()
    assert saved.read_text() == '{"myCars":["keep"]}'
    assert "current Railway environment variables" in result["lastOutcome"]


@pytest.mark.asyncio
async def test_wrong_facebook_password_is_reported_distinctly():
    class Locator:
        async def inner_text(self, timeout=0):
            return "The password you entered is incorrect. Please try again."
    class Page:
        def locator(self, selector):
            assert selector == "body"
            return Locator()
    client = FacebookConnection()
    client.page = Page()
    result = await client.login_feedback()
    assert result[0] == "invalid_credentials"
    assert "FACEBOOK_PASSWORD" in result[1]
    assert "Please try again" not in result[1]


@pytest.mark.asyncio
async def test_owner_can_tap_and_press_buttons_on_railway_facebook_challenge():
    import time
    class Mouse:
        def __init__(self): self.calls = []
        async def click(self,x,y): self.calls.append(("click",x,y))
        async def wheel(self,x,y): self.calls.append(("wheel",x,y))
    class Keyboard:
        def __init__(self): self.calls = []
        async def press(self, key): self.calls.append(key)
        async def insert_text(self, value): self.calls.append("text entered")
    class Page:
        url = "https://www.facebook.com/checkpoint/"
        viewport_size = {"width":1440,"height":1100}
        def __init__(self): self.mouse=Mouse(); self.keyboard=Keyboard()
        async def evaluate(self, expr): return True
        async def wait_for_timeout(self, millis): pass
    client = FacebookConnection()
    page = Page()
    client.page, client.context = page, object()
    client.started = time.monotonic()
    status = await client.interact("click",x=250,y=300)
    assert status["verificationPending"] is True
    assert page.mouse.calls == [("click",250,300)]
    await client.interact("key",text="Enter")
    await client.interact("scroll_down")
    assert page.keyboard.calls == ["Enter"]
    assert page.mouse.calls[-1] == ("wheel",0,510)
    response = await client.interact("type",text="sample-verification-code")
    assert page.keyboard.calls[-1] == "text entered"
    assert "sample-verification-code" not in str(response)
    assert client.interaction_count == 4


@pytest.mark.asyncio
async def test_interactive_verification_rejects_bad_clicks_and_other_sites():
    import time
    class Page:
        url = "https://www.facebook.com/checkpoint/"
        viewport_size = {"width":1440,"height":1100}
        class Mouse:
            async def click(self,x,y): raise AssertionError("must not be invoked")
        mouse = Mouse()
    client = FacebookConnection()
    client.page, client.context = Page(), object()
    client.started = time.monotonic()
    with pytest.raises(ValueError, match="outside"):
        await client.interact("click",x=999999,y=10)
    with pytest.raises(ValueError, match="Unsupported"):
        await client.interact("key",text="Control+Shift+I")
    with pytest.raises(ValueError, match="Unsupported"):
        await client.interact("navigate",text="https://example.com")
    client.page.url="https://example.com/"
    with pytest.raises(ValueError, match="left Facebook"):
        await client.interact("click",x=100,y=100)


@pytest.mark.asyncio
async def test_interactive_verification_requires_active_page_and_field():
    import time
    client = FacebookConnection()
    with pytest.raises(ValueError, match="expired"):
        await client.interact("click",x=10,y=10)
    class Page:
        url = "https://www.facebook.com/checkpoint"
        async def evaluate(self, text): return False
    client.page, client.context = Page(), object()
    client.started = time.monotonic()
    with pytest.raises(ValueError, match="Tap the verification input"):
        await client.interact("type",text="123456")


@pytest.mark.asyncio
async def test_expired_session_does_not_allow_code_without_login():
    connection = FacebookConnection()
    answer = await connection.code("123456")
    assert answer["state"] == "expired"
