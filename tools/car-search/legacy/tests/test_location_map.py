"""On-demand UK map geocoding, ambiguous places and authentication."""
import json

import httpx
import pytest

import server
from src.location_map import (LocationResolver, clean_location, place_request,
                              valid_point, find_place)


def test_uk_location_parser_uses_advert_locations_only():
    assert place_request("Located in Bristol, South West") == ("place", "Bristol", "south west")
    assert place_request("Manchester, M2") == ("place", "Manchester", "")
    assert place_request("SW1A 1AA") == ("postcode", "SW1A1AA", "")
    assert place_request("London") == ("place", "London", "")
    assert place_request("Location not provided") is None
    assert place_request("www.evil.example/path") is None
    assert clean_location(None) == ""


def test_map_query_removes_location_suffixes_and_partial_postcodes():
    cases = {
        "Bristol, BS1 1AA": ("postcode", "BS11AA", ""),
        "Manchester M2 (28 miles)": ("place", "Manchester", ""),
        "Hayes · 157 miles away": ("place", "Hayes", ""),
        "High Lane, SK12": ("place", "High Lane", ""),
        "SK12 2NL, High Lane": ("postcode", "SK122NL", ""),
        "Newport, Isle of Wight, PO30": ("place", "Newport", "isle of wight"),
        "Hayes (multiple locations)": ("place", "Hayes", ""),
    }
    for advert, expected in cases.items():
        assert place_request(advert) == expected, advert
    # When only a full postcode is supplied, preserve precise mapping.
    assert place_request("SK12 2NL") == ("postcode", "SK122NL", "")
    assert place_request("SK12") == ("outcode", "SK12", "")


@pytest.mark.asyncio
async def test_postcode_map_marker_uses_place_name_not_postcode():
    resolver = LocationResolver()

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"result": {
                "latitude": 53.3639, "longitude": -2.0678,
                "postcode": "SK12 2NL", "parish": "High Lane",
                "admin_ward": "Marple South"
            }}

    class FakeClient:
        async def get(self, url, params=None):
            return FakeResponse()

    point, definitive = await resolver._lookup(FakeClient(),
                                                ("postcode", "SK122NL", ""))
    assert definitive
    assert point["label"] == "High Lane"
    assert point["precision"] == "Postcode centroid (approx.)"


def test_autotrader_display_distance_is_not_part_of_town_name():
    from src.location_map import distance_hint, cache_key
    examples = [
        ("Milton Keynes (120 miles)", "Milton Keynes", 120),
        ("Nelson (26 miles)", "Nelson", 26),
        ("Ripley (46 miles)", "Ripley", 46),
        ("Hayes (157 miles)", "Hayes", 157),
        ("Manchester (7 mi)", "Manchester", 7),
    ]
    for raw, name, miles in examples:
        assert clean_location(raw) == name
        assert place_request(raw) == ("place", name, "")
        assert distance_hint(raw) == miles
        assert cache_key(raw).startswith(name.casefold() + "|")
    assert cache_key("Ripley (46 miles)") != cache_key("Ripley (140 miles)")


def test_ambiguous_town_can_use_actual_advertised_distance_from_search_postcode():
    # Two distinct "Nelson" / "Ripley" candidates are not interchangeable.
    places = [
        {"name_1": "Ripley", "local_type": "Town", "county_unitary": "Derbyshire",
         "latitude": 53.048, "longitude": -1.403},
        {"name_1": "Ripley", "local_type": "Town", "county_unitary": "Surrey",
         "latitude": 51.298, "longitude": -0.490},
    ]
    origin = {"lat": 53.48, "lng": -2.24}
    assert find_place(places, "Ripley", "") is None
    point = find_place(places, "Ripley", "", distance=46, origin=origin)
    assert point is not None
    assert point["label"] == "Ripley"
    assert point["precision"].startswith("Town centre inferred")
    assert abs(point["lat"] - 53.048) < .0001
    assert find_place(places, "Ripley", "", distance=400, origin=origin) is None
    # When two candidates would be indistinguishable from the distance,
    # avoid a made-up precise pin.
    tied = [
        {"name_1":"Nelson","local_type":"Town","latitude":53.82,"longitude":-2.23},
        {"name_1":"Nelson","local_type":"Town","latitude":53.81,"longitude":-2.25},
    ]
    assert find_place(tied, "Nelson", "", distance=26, origin=origin) is None


def test_hayes_mileage_disambiguates_across_settlement_types():
    from src.location_map import distance_hint, cache_key
    # London Hayes is classified as a suburban area in some datasets,
    # whereas other settlements called Hayes can be classified as villages.
    # A 157-mile advertised distance must be allowed to choose the London
    # one without the local_type sort selecting a different Hayes first.
    alternatives = [
        {"name_1":"Hayes", "local_type":"Village",
         "county_unitary":"Greater London", "district_borough":"Bromley",
         "latitude":51.372, "longitude":0.020},
        {"name_1":"Hayes", "local_type":"Suburban Area",
         "county_unitary":"Greater London", "district_borough":"Hillingdon",
         "latitude":51.508, "longitude":-0.414},
    ]
    manchester = {"lat":53.4808, "lng":-2.2426}
    assert clean_location("Hayes (157 miles)") == "Hayes"
    assert place_request("Hayes (157 miles)") == ("place","Hayes","")
    assert distance_hint("Hayes (157 miles)") == 157
    point = find_place(alternatives,"Hayes","",distance=157,origin=manchester)
    assert point and point["lat"] == 51.508
    assert "inferred from advertised distance" in point["precision"]
    assert find_place(alternatives,"Hayes","") is None
    assert cache_key("Hayes (157 miles)").endswith("|placev4")


def test_exact_place_centres_and_ambiguous_locations():
    places = [
        {"name_1":"Newport","local_type":"Town","county_unitary":"Isle of Wight",
         "region":"South East","latitude":50.701,"longitude":-1.291},
        {"name_1":"Newport","local_type":"Town","county_unitary":"Newport",
         "region":"Wales","latitude":51.585,"longitude":-2.998},
    ]
    assert find_place(places, "Newport", "") is None
    selected = find_place(places, "Newport", "wales")
    assert selected["lat"] == 51.585
    assert "approx" in selected["precision"].lower()
    assert find_place(places, "Newport", "isle of wight")["lng"] == -1.291
    assert find_place(places, "Newcastle", "") is None


def test_coordinates_are_limited_to_uk_and_marked_approximate():
    assert valid_point({"latitude":51.5,"longitude":-0.12},
                       "Postcode centroid (approx.)","SW1A1AA")["precision"].endswith("approx.)")
    assert valid_point({"latitude":33.0,"longitude":-0.12},
                       "Postcode","Outside UK") is None
    assert valid_point({"latitude":"nan","longitude":"nan"},"","") is None


@pytest.mark.asyncio
async def test_distance_locations_cache_using_clean_location_but_individual_hints(tmp_path,monkeypatch):
    resolver = LocationResolver()
    calls = []
    async def fake_lookup(client, request):
        calls.append(request)
        assert request[:3] == ("place","Milton Keynes","")
        assert request[3] == 120
        return {"lat":52.04,"lng":-0.76,"precision":"Town centre (approx.)",
                "label":"Milton Keynes"}, True
    monkeypatch.setattr(resolver,"_lookup",fake_lookup)
    response=await resolver.resolve(["Milton Keynes (120 miles)"],tmp_path)
    assert response[0]["point"]["label"]=="Milton Keynes"
    assert len(calls)==1
    await resolver.resolve(["Milton Keynes (120 miles)"],tmp_path)
    assert len(calls)==1


@pytest.mark.asyncio
async def test_map_only_lookup_writes_cache_and_does_not_repeat_requests(tmp_path, monkeypatch):
    resolver = LocationResolver()
    called = []
    async def lookup(client, request):
        called.append(request)
        return ({"lat":53.4808,"lng":-2.2426,
                 "label":"Manchester","precision":"Town centre (approx.)"}, True)
    monkeypatch.setattr(resolver, "_lookup", lookup)
    first = await resolver.resolve(["Manchester", "Manchester", ""], tmp_path)
    assert first[0]["point"]["label"] == "Manchester"
    assert first[2]["point"] is None
    assert len(called) == 1
    assert (tmp_path / "location-map-cache.json").exists()
    stored = json.loads((tmp_path / "location-map-cache.json").read_text())
    assert "manchester|placev4" in stored
    await resolver.resolve(["Manchester"], tmp_path)
    assert len(called) == 1


@pytest.mark.asyncio
async def test_missing_location_does_not_get_a_guessed_pin(tmp_path, monkeypatch):
    resolver = LocationResolver()
    calls = 0
    async def no_match(client, request):
        nonlocal calls
        calls += 1
        return None, True
    monkeypatch.setattr(resolver, "_lookup", no_match)
    first = await resolver.resolve(["Unlistedtown", "unknown"], tmp_path)
    assert [r["point"] for r in first] == [None,None]
    assert calls == 1
    await resolver.resolve(["Unlistedtown"], tmp_path)
    assert calls == 1  # Negative results cached for at least a day.


def test_full_postcode_and_mileage_clues_are_preserved_in_mapping_requests():
    from src.location_map import cache_key, distance_hint
    assert place_request("Bristol, BS1 1AA") == ("postcode", "BS11AA", "")
    assert place_request("High Lane, SK12") == ("place", "High Lane", "")
    assert distance_hint("Hayes · 157 miles away") == 157
    assert distance_hint("Hayes (157 miles)") == 157
    assert cache_key("Bristol BS1 1AA") != cache_key("Bristol BS1 1AB")
    assert cache_key("Hayes (40 miles)") != cache_key("Hayes (157 miles)")


def test_conservative_fuzzy_and_ambiguous_place_diagnostics():
    from src.location_map import find_place_detailed
    candidates = [
        {"name_1": "Stoke-on-Trent", "local_type": "City",
         "latitude": 53.0027, "longitude": -2.1794}
    ]
    point, status = find_place_detailed(candidates, "Stoke On Trent", "")
    assert status == "mapped" and point["label"] == "Stoke-on-Trent"
    assert "approximately" in point["precision"]
    assert find_place_detailed(candidates, "Stoke", "")[1] == "unmatched"
    newports = [
        {"name_1": "Newport", "local_type": "Town", "county_unitary": "Newport",
         "latitude": 51.585, "longitude": -2.998},
        {"name_1": "Newport", "local_type": "Town", "county_unitary": "Isle of Wight",
         "latitude": 50.701, "longitude": -1.291},
    ]
    assert find_place_detailed(newports, "Newport", "")[1] == "ambiguous"
    located, status = find_place_detailed(newports, "Newport", "isle of wight")
    assert status == "mapped" and located["lat"] == 50.701


@pytest.mark.asyncio
async def test_named_town_fallback_for_invalid_full_postcode():
    resolver = LocationResolver()
    class FakeResponse:
        def __init__(self, code, result):
            self.status_code = code
            self.result = result

        def json(self):
            return {"result": self.result}
    class FakeClient:
        def __init__(self):
            self.urls = []

        async def get(self, url, params=None):
            self.urls.append(url)
            if "/postcodes/BS11AA" in url:
                return FakeResponse(404, None)
            return FakeResponse(200, [
                {"name_1": "Bristol", "local_type": "City",
                 "latitude": 51.4545, "longitude": -2.5879}
            ])
    fake = FakeClient()
    request = (*place_request("Bristol, BS1 1AA"), None,
               place_request(clean_location("Bristol, BS1 1AA")))
    point, definitive = await resolver._lookup(fake, request)
    assert definitive and point["label"] == "Bristol"
    assert fake.urls == [
        "https://api.postcodes.io/postcodes/BS11AA",
        "https://api.postcodes.io/places",
    ]


@pytest.mark.asyncio
async def test_map_failure_reasons_negative_cache_and_manual_retry(tmp_path, monkeypatch):
    resolver = LocationResolver()
    calls = 0

    async def mocked(client, request):
        nonlocal calls
        calls += 1
        if calls == 1:
            resolver.lookup_status[request] = "ambiguous"
            return None, True
        return {"lat": 51.585, "lng": -2.998,
                "label": "Newport", "precision": "Approximate"}, True

    monkeypatch.setattr(resolver, "_lookup", mocked)
    first = await resolver.resolve(["Newport"], tmp_path)
    assert first[0]["point"] is None
    assert first[0]["status"] == "ambiguous"
    assert "Several UK places" in first[0]["reason"]
    assert first[0]["retryable"] is True
    assert (await resolver.resolve(["Newport"], tmp_path))[0]["status"] == "ambiguous"
    assert calls == 1
    refreshed = await resolver.resolve(["Newport"], tmp_path, retry=True)
    assert refreshed[0]["status"] == "mapped"
    assert calls == 2
    assert (await resolver.resolve(["Newport"], tmp_path))[0]["point"]["label"] == "Newport"
    assert calls == 2


@pytest.mark.asyncio
async def test_transient_geocode_failure_not_cached(tmp_path, monkeypatch):
    resolver = LocationResolver()
    count = 0
    async def flaky(client, request):
        nonlocal count
        count += 1
        return None, False
    monkeypatch.setattr(resolver, "_lookup", flaky)
    for _ in range(2):
        response = await resolver.resolve(["Manchester"], tmp_path)
        assert response[0]["status"] == "temporary"
    assert count == 2


@pytest.mark.asyncio
async def test_map_endpoint_is_private_and_validates_limit(monkeypatch,tmp_path):
    monkeypatch.setattr(server,"PASSWORD","secret-test")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        response = await client.post("/api/map/locations",
                                    json={"locations":["London"]})
        assert response.status_code == 401

    monkeypatch.setattr(server,"PASSWORD","")
    async def fake_resolve(locations, data_dir=None):
        return [{"location":v,"point":{"lat":51.5,"lng":-0.12,
                "precision":"City centre (approx.)","label":"London"}} for v in locations]
    monkeypatch.setattr(server.LOCATION_RESOLVER,"resolve",fake_resolve)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        response = await client.post("/api/map/locations",
                                    json={"locations":["London"]})
        assert response.status_code == 200
        assert response.json()["locations"][0]["point"]["label"] == "London"
        response = await client.post("/api/map/locations",
                                    json={"locations":["London"]*31})
        # Mocked resolve skips validation; API must still enforce user limits.
        assert response.status_code == 400
