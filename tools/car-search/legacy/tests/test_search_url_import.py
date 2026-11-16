"""Import a supported website search URL into editable structured search criteria."""
import pytest
import httpx

from src.search_url_import import parse_search_url
import server


def test_autotrader_imports_make_model_prices_year_mileage_colour_transmission():
    url = (
        "https://www.autotrader.co.uk/car-search?"
        "make=BMW&model=M2&price-from=20000&price-to=30000"
        "&year-from=2016&year-to=2018&maximum-mileage=65000"
        "&transmission=Automatic&colour=Blue&colour=Grey"
        "&postcode=SK12+2NL&radius=50&sort=relevance&utm_source=share"
    )
    parsed = parse_search_url(url)
    assert parsed["site"] == "autotrader"
    assert parsed["name"] == "BMW M2"
    f = parsed["filters"]
    assert (f["priceMin"], f["priceMax"]) == (20000, 30000)
    assert (f["yearMin"], f["yearMax"]) == (2016, 2018)
    assert f["mileageMax"] == 65000
    assert f["transmission"] == "automatic"
    assert f["colours"] == ["blue", "grey"]
    assert any("Location/postcode" in warning for warning in parsed["warnings"])
    assert "utm_source" not in str(parsed["warnings"])
    assert "SK12" not in str(parsed)  # Never echo postcode or full URL back.


def test_autotrader_keyword_with_named_model_becomes_required_qualifier():
    parsed = parse_search_url(
        "https://www.autotrader.co.uk/car-search?"
        "make=PORSCHE&model=911&keywords=Porsche+911+manual")
    assert parsed["name"] == "PORSCHE 911"
    assert parsed["filters"]["requiredKeywords"] == "manual"
    assert "required keywords" in parsed["applied"]


def test_user_reported_porsche_996_carrera_4s_url():
    url = ("https://www.autotrader.co.uk/car-search?"
           "aggregatedTrim=996%20Carrera%204S&body-type=Coupe&make=Porsche"
           "&maximum-mileage=100000&model=911&postcode=SK6%203DU"
           "&price-to=30000&sort=most-recent&transmission=Manual")
    imported = parse_search_url(url)
    assert imported["site"] == "autotrader"
    assert imported["name"] == "Porsche 911"
    assert imported["filters"]["mileageMax"] == 100000
    assert imported["filters"]["priceMax"] == 30000
    assert imported["filters"]["transmission"] == "manual"
    # '996 Carrera 4S' must NOT be lost. Separate phrases tolerate adverts
    # where the generation is elsewhere in the title or description.
    assert imported["filters"]["requiredKeywords"] == "996, Carrera 4S"
    assert "trim / variant (required keywords)" in imported["applied"]
    warnings = " ".join(imported["warnings"])
    assert "body-type" in warnings
    assert "Location/postcode" in warnings


@pytest.mark.asyncio
async def test_dashboard_html_busts_old_asset_versions_after_deployment():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        for page in ("/", "/dashboard.html"):
            response = await client.get(page)
            assert response.status_code == 200
            assert "no-store" in response.headers["Cache-Control"]
            assert 'src="dashboard.js?v=' in response.text
            assert 'href="styles.css?v=' in response.text
            js_url = response.text.split('src="dashboard.js?v=')[1].split('"')[0]
            assert len(js_url) == 12
            js = await client.get("/dashboard.js?v=" + js_url)
            assert js.status_code == 200
            assert "importSearchCriteriaFromUrl" in js.text


def test_ebay_imports_search_query_and_numeric_filters():
    parsed = parse_search_url(
        "https://www.ebay.co.uk/sch/i.html?_nkw=Lotus+Evora+S"
        "&_sacat=9801&_udlo=20000&_udhi=28000&_sop=10")
    assert parsed["site"] == "ebay"
    assert parsed["name"] == "Lotus Evora S"
    assert parsed["filters"]["priceMin"] == 20000
    assert parsed["filters"]["priceMax"] == 28000


def test_facebook_marketplace_imports_query_and_price_without_fetch():
    parsed = parse_search_url(
        "https://www.facebook.com/marketplace/search/?query=BMW+M2"
        "&minPrice=10000&maxPrice=25000")
    assert parsed["site"] == "facebook"
    assert parsed["name"] == "BMW M2"
    assert parsed["filters"]["priceMin"] == 10000
    assert parsed["filters"]["priceMax"] == 25000
    assert parsed["filters"]["transmission"] == "any"


def test_pistonheads_keywords_and_prices_import():
    parsed = parse_search_url(
        "https://www.pistonheads.com/buy/search?"
        "keywords=Jaguar+F-Type&min-price=15000&max-price=25000")
    assert parsed["site"] == "pistonheads"
    assert parsed["name"] == "Jaguar F-Type"
    assert parsed["filters"]["priceMin"] == 15000
    assert parsed["filters"]["priceMax"] == 25000


def test_pistonheads_numeric_make_model_requires_name_review():
    parsed = parse_search_url(
        "https://www.pistonheads.com/buy/search?make-id=17&model-id=2940")
    assert parsed["site"] == "pistonheads"
    assert parsed["name"] == ""
    assert any("numeric" in w for w in parsed["warnings"])
    assert any("Enter" in w for w in parsed["warnings"])


def test_unknown_site_specific_filters_are_reported_not_guessed():
    parsed = parse_search_url(
        "https://www.autotrader.co.uk/car-search?"
        "keywords=BMW+M2&fuel-type=Petrol&body-type=Coupe&"
        "aggregatedTrim=Competition")
    assert parsed["name"] == "BMW M2"
    joined = " ".join(parsed["warnings"])
    assert "fuel-type" in joined and "body-type" in joined
    assert "aggregatedTrim" not in joined  # Now mapped into required keywords.
    assert parsed["filters"]["requiredKeywords"] == "Competition"


def test_supported_engine_and_power_ranges_are_read():
    parsed = parse_search_url(
        "https://www.autotrader.co.uk/car-search?"
        "keywords=Jaguar+F-Type&engine-size-from=3.0&"
        "engine-size-to=5.0&power-from=300&power-to=600")
    f = parsed["filters"]
    assert (f["engineMin"], f["engineMax"]) == (3.0, 5.0)
    assert (f["bhpMin"], f["bhpMax"]) == (300, 600)


def test_unsupported_transmission_is_not_guessed():
    parsed = parse_search_url("https://www.autotrader.co.uk/car-search?"
                              "keywords=BMW+M2&transmission=unknown")
    assert parsed["filters"]["transmission"] == "any"
    assert any("Transmission" in w for w in parsed["warnings"])


@pytest.mark.parametrize("url", [
    "http://www.autotrader.co.uk/car-search?keywords=BMW",
    "https://www.autotrader.co.uk.evil.example/car-search?keywords=BMW",
    "https://user:pass@www.autotrader.co.uk/car-search?keywords=BMW",
    "https://www.autotrader.co.uk:444/car-search?keywords=BMW",
    "https://www.autotrader.co.uk/car-details/202611012345678?keywords=BMW",
    "https://www.ebay.co.uk/itm/123456?_nkw=BMW",
    "https://www.pistonheads.com/buy/listing/123?keywords=BMW",
    "https://www.facebook.com/marketplace/item/123?query=BMW",
    "https://www.autotrader.co.uk/car-search",
    "https://www.autotrader.co.uk/car-search?utm_source=mail",
])
def test_reject_non_search_and_non_importable_urls(url):
    with pytest.raises(ValueError):
        parse_search_url(url)


def test_conflicting_years_are_not_silently_accepted():
    with pytest.raises(ValueError, match="incompatible"):
        parse_search_url("https://www.autotrader.co.uk/car-search?"
                         "keywords=BMW+M2&year-from=2020&year-to=2018")


@pytest.mark.asyncio
async def test_parse_endpoint_previews_but_does_not_save(monkeypatch):
    monkeypatch.setattr(server, "PASSWORD", "")
    monkeypatch.setattr(server, "state", server.fresh_state())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        response = await client.post("/api/searches/parse-url", json={
            "url": "https://www.ebay.co.uk/sch/i.html?_nkw=Ford+Mustang&_udhi=30000"
        })
        assert response.status_code == 200
        assert response.json()["name"] == "Ford Mustang"
        assert response.json()["filters"]["priceMax"] == 30000
        assert server.state["searches"] == []
        bad = await client.post("/api/searches/parse-url", json={
            "url": "https://example.com/?keywords=Ford+Mustang"
        })
        assert bad.status_code == 400
