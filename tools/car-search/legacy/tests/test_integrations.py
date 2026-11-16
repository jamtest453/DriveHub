"""Offline contract tests for the eBay API mapping and Facebook session behaviour."""
import pytest
from src import ebay_api
from src.scanner import ensure_facebook_session


def test_ebay_url_to_browse_query():
    url = "https://www.ebay.co.uk/sch/i.html?_nkw=BMW+M2&_sacat=9801&_udlo=19000&_udhi=26000&_sop=10"
    params, unsupported = ebay_api.parse_ebay_url(url)
    assert unsupported == []
    assert params["q"] == "BMW M2"
    assert params["category_ids"] == "9801"
    assert params["sort"] == "newlyListed"
    assert "price:[19000..26000]" in params["filter"]
    assert "priceCurrency:GBP" in params["filter"]
    assert "CLASSIFIED_AD" in params["filter"]


def test_ebay_unsupported_filters_not_silently_dropped():
    params, unsupported = ebay_api.parse_ebay_url(
        "https://www.ebay.co.uk/sch/i.html?_nkw=lotus+evora&_sacat=9801&Model=Evora"
    )
    assert "Model" in unsupported
    assert params["q"] == "lotus evora"


def test_ebay_malformed_and_non_search_urls():
    with pytest.raises(ValueError):
        ebay_api.parse_ebay_url("https://evil.example/sch/i.html?_nkw=m2")
    with pytest.raises(ValueError):
        ebay_api.parse_ebay_url("https://www.ebay.co.uk/sch/i.html")
    with pytest.raises(ValueError):
        ebay_api.parse_ebay_url("https://www.ebay.co.uk/sch/i.html?_nkw=m2&_udlo=oops")


def test_ebay_item_normalisation():
    raw = {
        "itemId": "v1|123456789012|0",
        "title": "2017 BMW M2 in Long Beach Blue",
        "price": {"value": "24450.00", "currency": "GBP"},
        "image": {"imageUrl": "https://i.ebayimg.com/abc.jpg"},
        "itemLocation": {"city": "Manchester", "postalCode": "M20"},
        "shortDescription": "52,000 miles, manual",
    }
    result = ebay_api.ebay_item(raw)
    assert result["id"] == "ebay:123456789012"
    assert result["price"] == 24450.0
    assert result["year"] == 2017
    assert result["mileage"] == 52000
    assert result["url"] == "https://www.ebay.co.uk/itm/123456789012"


@pytest.mark.asyncio
async def test_ebay_api_scan_with_mocked_response(monkeypatch):
    async def mock_token(_client):
        return "not-a-real-token"
    class Response:
        status_code = 200
        def json(self):
            return {"total": 1, "itemSummaries": [
                {"itemId": "v1|123456789012|0",
                 "title": "2017 BMW M2",
                 "price": {"value": "24500", "currency": "GBP"}}]}
    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, url, params, headers):
            assert url == ebay_api.SEARCH_URL
            assert headers["X-EBAY-C-MARKETPLACE-ID"] == "EBAY_GB"
            assert params["q"] == "bmw m2"
            return Response()
    monkeypatch.setattr(ebay_api, "access_token", mock_token)
    monkeypatch.setattr(ebay_api.httpx, "AsyncClient", lambda **kwargs: Client())
    outcome = await ebay_api.scan_ebay_api(
        {"url": "https://www.ebay.co.uk/sch/i.html?_nkw=bmw+m2&_sacat=9801"}, 3,
        lambda: False, lambda text: None)
    assert outcome["ok"]
    assert len(outcome["items"]) == 1
    assert outcome["items"][0]["id"] == "ebay:123456789012"


@pytest.mark.asyncio
async def test_facebook_session_without_credentials_is_explicit(monkeypatch):
    monkeypatch.delenv("FACEBOOK_EMAIL", raising=False)
    monkeypatch.delenv("FACEBOOK_PASSWORD", raising=False)
    class Context:
        async def cookies(self, url): return []
    with pytest.raises(ValueError, match="FACEBOOK_EMAIL"):
        await ensure_facebook_session(Context())


@pytest.mark.asyncio
async def test_facebook_existing_login_does_not_require_password(monkeypatch):
    monkeypatch.delenv("FACEBOOK_EMAIL", raising=False)
    monkeypatch.delenv("FACEBOOK_PASSWORD", raising=False)
    class Context:
        async def cookies(self, url): return [{"name": "c_user", "value": "test"}]
    await ensure_facebook_session(Context())
