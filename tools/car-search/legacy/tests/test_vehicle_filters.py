"""Structured search and local vehicle-filter regression tests."""
import httpx
import pytest
import server
from src.query_builder import validate_filters, generate_links, apply_local_filters


def filters(**updates):
    return validate_filters({"keywords": "BMW M2", **updates})


def test_structured_filters_validate_ranges_and_colours():
    f = filters(priceMin=18000, priceMax=26000, yearMin=2016, yearMax=2020,
                mileageMax=80000, colours=["blue","grey"], engineMin=2.9, bhpMin=350)
    assert f["colours"] == ["blue","grey"]
    assert f["engineMin"] == 2.9 and f["bhpMin"] == 350
    with pytest.raises(ValueError):
        filters(priceMin=27000, priceMax=24000)
    with pytest.raises(ValueError):
        filters(colours=["blue", "invisible"])
    with pytest.raises(ValueError):
        filters(yearMin=2030, yearMax=2020)


def test_autotrader_nationwide_search_and_public_browse_fallback(monkeypatch):
    from urllib.parse import urlsplit, parse_qs
    monkeypatch.delenv("AUTOTRADER_POSTCODE", raising=False)
    selected = generate_links(validate_filters({"keywords": "", "priceMax": 27000}),
                              ["autotrader"], "BMW M2")[0]
    params = parse_qs(urlsplit(selected["url"]).query)
    assert params["postcode"] == ["M1 1AE"]
    assert params["radius"] == ["1500"]
    assert params["keywords"] == ["BMW M2"]
    assert "make" not in params and "model" not in params
    assert params["price-to"] == ["27000"]
    assert "browseUrl" not in selected
    monkeypatch.setenv("AUTOTRADER_POSTCODE", "SW1A 1AA")
    changed = generate_links(validate_filters({"keywords": ""}), ["autotrader"], "BMW M2")[0]
    assert parse_qs(urlsplit(changed["url"]).query)["postcode"] == ["SW1A 1AA"]
    monkeypatch.setenv("AUTOTRADER_POSTCODE", "a very invalid postcode")
    with pytest.raises(ValueError, match="AUTOTRADER_POSTCODE"):
        generate_links(validate_filters({"keywords": ""}), ["autotrader"], "BMW M2")


def test_porsche_997_in_autotrader_911_title_remains_unverified():
    f = validate_filters({"keywords": "", "priceMax": 28000})
    listing = {"title": "2006 Porsche 911 Carrera 4S Coupe", "year": 2006, "price": 26950}
    included, unknown = apply_local_filters(listing, f, "Porsche 997")
    assert included and "911 generation" in unknown
    later = {"title": "2022 Porsche 911 Carrera 4S", "year": 2022, "price": 26950}
    assert apply_local_filters(later, f, "Porsche 997")[0] is False


@pytest.mark.asyncio
async def test_autotrader_fallback_retains_incomplete_flag_and_local_advert():
    from src import scanner

    class BrowserReply:
        status = 200

    class Page:
        def __init__(self):
            self.url = ""
            self.scrapes = 0
        async def route(self, pattern, fn): pass
        async def goto(self, url, **kwargs):
            self.url = url
            return BrowserReply()
        async def wait_for_timeout(self, ms): pass
        async def wait_for_selector(self, selector, timeout=0): pass
        async def evaluate(self, script, *args):
            if script == scanner.EXTRACTOR:
                return None
            self.scrapes += 1
            if self.scrapes == 1:
                return {"items": [], "blocked": False, "noResults": False}
            return {"items": [{
                "site":"autotrader", "id":"autotrader:202611010000000",
                "title":"2017 BMW M2 Coupe", "price":24000,
                "url":"https://www.autotrader.co.uk/car-details/202611010000000"}],
                "blocked":False}
    class Context:
        def __init__(self): self.page = Page()
        def set_default_timeout(self, ms): pass
        async def new_page(self): return self.page
        async def close(self): pass
    class Browser:
        async def new_context(self, **opts):
            return Context()

    found = await scanner.scan_link(Browser(), {
        "site":"autotrader",
        "url":"https://www.autotrader.co.uk/car-search?postcode=M1+1AE&make=BMW&model=M2",
        "browseUrl":"https://www.autotrader.co.uk/cars/uk/bmw/m2",
    }, 3, lambda: False, lambda message: None)
    assert found["ok"] and len(found["items"]) == 1
    assert found["incomplete"] is True
    assert "public model listings" in found["caveat"].lower()


def test_pistonheads_and_autotrader_use_keyword_field_for_any_model():
    from urllib.parse import parse_qs, urlsplit
    for name in ("BMW M2", "Lotus Evora", "Porsche 997", "Jaguar XKR",
                 "Aston Martin Vantage", "Mercedes AMG GT"):
        filters = validate_filters({"keywords": "manual"})
        links = generate_links(filters, ["autotrader", "pistonheads"], name)
        for link in links:
            query = parse_qs(urlsplit(link["url"]).query)
            assert query["keywords"] == [name]  # Preferred term never restricts provider search
            assert "make" not in query and "model" not in query
            assert "make-id" not in query and "model-id" not in query
            assert "browseUrl" not in link
    old = {"name":"BMW M2", "filters":validate_filters({"keywords": ""}),
           "sources":["pistonheads"], "links":[{"site":"pistonheads","id":"source-ph",
           "url":"https://www.pistonheads.com/buy/search?make-id=17&model-id=2940"}]}
    assert server.regenerate_search_links(old)
    assert old["links"][0]["id"] == "source-ph"
    assert "keywords=BMW+M2" in old["links"][0]["url"]
    assert "make-id" not in old["links"][0]["url"]
    assert not server.regenerate_search_links(old)


@pytest.mark.asyncio
async def test_pistonheads_js_search_fallback_is_labeled_incomplete():
    from src import scanner
    class Reply:
        status = 200
    class Page:
        def __init__(self): self.url = ""; self.reads = 0
        async def route(self, pattern, fn): pass
        async def goto(self, url, **kw): self.url=url; return Reply()
        async def wait_for_timeout(self, ms): pass
        async def wait_for_selector(self, selector, timeout=0):
            assert "/buy/listing/" in selector
        async def evaluate(self, script, *args):
            if script == scanner.EXTRACTOR: return None
            self.reads += 1
            if self.reads == 1: return {"items":[], "blocked":False, "noResults":False}
            return {"items":[{"site":"pistonheads","id":"pistonheads:21345721",
                "url":"https://www.pistonheads.com/buy/listing/21345721",
                "title":"2017 BMW M2 Coupe","price":22500}]}
    class Context:
        def __init__(self): self.page=Page()
        def set_default_timeout(self, ms): pass
        async def new_page(self): return self.page
        async def close(self): pass
    class Browser:
        async def new_context(self, **opts): return Context()
    outcome = await scanner.scan_link(Browser(), {
        "site":"pistonheads", "url":"https://www.pistonheads.com/buy/search?make-id=17&model-id=2940",
        "browseUrl":"https://www.pistonheads.com/buy/bmw/m2",
    }, 3, lambda:False, lambda _:None)
    assert outcome["ok"] and len(outcome["items"]) == 1
    assert outcome["incomplete"] is True
    assert "public model listings" in outcome["caveat"]

def test_vehicle_name_is_required_and_legacy_extra_keywords_are_preferred():
    f = validate_filters({"keywords": ""})
    links = generate_links(f, ["autotrader", "pistonheads", "facebook", "ebay"], "BMW M2")
    from urllib.parse import urlsplit, parse_qs
    queries = {item["site"]: parse_qs(urlsplit(item["url"]).query) for item in links}
    assert queries["autotrader"]["keywords"] == ["BMW M2"]
    assert "make" not in queries["autotrader"]
    assert "model" not in queries["autotrader"]
    assert "advertising-location" not in queries["autotrader"]
    assert queries["pistonheads"]["keywords"] == ["BMW M2"]
    assert "make-id" not in queries["pistonheads"]
    assert "model-id" not in queries["pistonheads"]
    assert queries["facebook"]["query"] == ["BMW M2"]
    assert queries["ebay"]["_nkw"] == ["BMW M2"]

    extra = validate_filters({"keywords": "manual"})
    with_extra = generate_links(extra, ["autotrader", "pistonheads", "facebook", "ebay"], "BMW M2")
    q = {item["site"]: parse_qs(urlsplit(item["url"]).query) for item in with_extra}
    assert q["autotrader"]["keywords"] == ["BMW M2"]
    assert q["pistonheads"]["keywords"] == ["BMW M2"]
    assert q["facebook"]["query"] == ["BMW M2"]
    assert q["ebay"]["_nkw"] == ["BMW M2"]
    assert extra["preferredKeywords"] == "manual"
    assert apply_local_filters({"title": "2017 BMW M2"}, extra, "BMW M2")[0]


@pytest.mark.asyncio
async def test_api_allows_empty_keywords_for_named_search(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "DATA_FILE", tmp_path / "state.json")
    monkeypatch.setattr(server, "state", server.fresh_state())
    monkeypatch.setattr(server, "PASSWORD", "")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        response = await client.post("/api/searches", json={
            "name": "Lotus Evora", "filters": {"keywords": "", "priceMax": 28000},
            "sources": ["autotrader", "ebay"]})
        assert response.status_code == 200, response.text
        search = response.json()["state"]["searches"][0]
        assert search["filters"]["keywords"] == ""
        assert "Lotus+Evora" in search["links"][1]["url"]


def test_regenerate_existing_bad_autotrader_url_preserves_snapshot_identity():
    f = validate_filters({"keywords": "BMW M2", "priceMax": 25000})
    search = {
        "name": "BMW M2", "filters": f, "sources": ["autotrader"],
        "links": [{"site": "autotrader", "id": "existing-link",
                   "url": "https://www.autotrader.co.uk/car-search?keywords=BMW+M2",
                   "sourceNote": "Previous version"}]
    }
    assert server.regenerate_search_links(search) is True
    assert search["links"][0]["id"] == "existing-link"
    assert "keywords=BMW+M2" in search["links"][0]["url"]
    assert "make=BMW" not in search["links"][0]["url"]
    assert "model=M2" not in search["links"][0]["url"]
    assert server.regenerate_search_links(search) is False


def test_local_keywords_prevent_unrelated_cars_from_being_added():
    f = filters()
    assert apply_local_filters({"title": "BMW M2 Coupe 2017"}, f)[0]
    assert not apply_local_filters({"title": "BMW 330d M Sport"}, f)[0]


def test_searches_are_generated_without_user_supplied_urls():
    links = generate_links(filters(priceMax=25000), ["ebay", "facebook", "autotrader", "pistonheads"])
    assert [link["site"] for link in links] == ["ebay", "facebook", "autotrader", "pistonheads"]
    assert "_nkw=BMW+M2" in links[0]["url"] and "_sacat=9801" in links[0]["url"]
    assert "query=BMW+M2" in links[1]["url"] and "maxPrice=25000" in links[1]["url"]
    assert "price-to=25000" in links[2]["url"]
    assert "keywords=BMW+M2" in links[2]["url"]
    assert "keywords=BMW+M2" in links[3]["url"]
    assert "make-id" not in links[3]["url"] and "make=BMW" not in links[2]["url"]
    with pytest.raises(ValueError):
        generate_links(filters(), ["evil"])


def test_unknown_specs_are_kept_and_flagged_not_silently_removed():
    f = filters(colours=["blue"], includeUnknownColours=True, mileageMax=70000, bhpMin=320, engineMin=2.8)
    car = {"title": "2017 BMW M2 Coupe", "price": 24000, "year": 2017,
           "mileage": 56000}
    included, unknown = apply_local_filters(car, f)
    assert included and set(unknown) == {"colour","bhp","engine"}
    car["title"] = "2017 BMW M2 white 3.0l 365 bhp"
    assert not apply_local_filters(car, f)[0]
    blue_car = {"title": "2017 BMW M2 blue 3.0l 365 bhp",
                "year": 2017, "price": 24000, "mileage": 56000}
    assert apply_local_filters(blue_car, f) == (True, [])


@pytest.mark.asyncio
async def test_website_creates_structured_search_with_persistent_filters(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "DATA_FILE", tmp_path / "car.json")
    monkeypatch.setattr(server, "state", server.fresh_state())
    monkeypatch.setattr(server, "PASSWORD", "")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        res = await client.post("/api/searches", json={
            "name": "BMW M2", "filters": {"keywords": "BMW M2", "priceMax": 25000,
            "colours": ["blue"], "bhpMin": 350}, "sources": ["ebay", "facebook"]})
        assert res.status_code == 200, res.text
        record = res.json()["state"]["searches"][0]
        assert record["filters"]["colours"] == ["blue"]
        assert len(record["links"]) == 2
        assert all(link["id"] and link["sourceNote"] for link in record["links"])
        sid = record["id"]
        again = await client.post("/api/searches", json={
            "id": sid, "name": "BMW M2", "filters": {"keywords": "BMW M2", "priceMax": 25000,
            "colours": ["blue"], "bhpMin": 350}, "sources": ["ebay", "facebook"]})
        assert [x["id"] for x in again.json()["state"]["searches"][0]["links"]] == [x["id"] for x in record["links"]]
    assert (tmp_path / "car.json").exists()


@pytest.mark.asyncio
async def test_facebook_login_endpoints_require_dashboard_auth(monkeypatch):
    monkeypatch.setattr(server, "PASSWORD", "unit-test-password")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        for method, route in [
            ("GET", "/api/facebook/connection/status"),
            ("POST", "/api/facebook/connection/connect"),
            ("POST", "/api/facebook/connection/reset"),
            ("POST", "/api/facebook/connection/recheck"),
            ("POST", "/api/facebook/connection/code"),
            ("POST", "/api/facebook/connection/interact"),
            ("GET", "/api/facebook/connection/preview"),
        ]:
            r = await client.request(method, route, json={} if method == "POST" else None)
            assert r.status_code == 401, (route, r.text)
