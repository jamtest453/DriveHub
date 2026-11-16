"""Manual saved adverts: validation, persistence and scan-safe owner overrides."""
import asyncio
import copy

import httpx
import pytest

import server
from src.manual_cars import listing_url, validate_manual_details, apply_manual_details


@pytest.mark.parametrize(("raw", "site", "identity"), [
    ("https://www.autotrader.co.uk/car-details/202611027550673?utm_source=share",
     "autotrader", "autotrader:202611027550673"),
    ("https://www.ebay.co.uk/itm/2006-Porsche/123456789012?hash=test",
     "ebay", "ebay:123456789012"),
    ("https://www.pistonheads.com/buy/listing/12345678?source=share",
     "pistonheads", "pistonheads:12345678"),
    ("https://www.facebook.com/marketplace/item/123456789012345/",
     "facebook", "facebook:123456789012345"),
])
def test_supported_individual_listing_links(raw, site, identity):
    url, found, key = listing_url(raw)
    assert found == site
    assert key == identity
    assert url.startswith("https://")


@pytest.mark.parametrize("raw", [
    "https://example.com/itm/123456789012",
    "https://www.autotrader.co.uk/car-search?make=BMW",
    "https://www.pistonheads.com/buy/search?keywords=BMW",
    "https://www.facebook.com/marketplace/search?query=BMW",
    "https://www.ebay.co.uk/sch/i.html?_nkw=BMW",
    "https://evil.autotrader.co.uk.attacker.net/car-details/202611027550673",
    "http://www.autotrader.co.uk/car-details/202611027550673",
    "https://someone:secret@www.ebay.co.uk/itm/123456789012",
    "https://www.ebay.co.uk:448/itm/123456789012",
    "file:///etc/passwd",
    "",
])
def test_reject_non_adverts_and_unsafe_urls(raw):
    with pytest.raises(ValueError):
        listing_url(raw)


def test_owner_fields_are_validated_and_image_is_optional():
    fields = validate_manual_details({
        "title": "  Porsche 911 996 4S ", "price": 28995, "year": 2003,
        "mileage": 72000, "colour": "blue", "transmission": "manual",
        "notes": "Ask about Hartech rebuild", "description": "FSH",
    })
    assert fields["title"] == "Porsche 911 996 4S"
    assert fields["price"] == 28995
    assert fields["notes"] == "Ask about Hartech rebuild"
    assert validate_manual_details({}, allow_empty=True) == {}


@pytest.mark.parametrize("fields", [
    {"title": 42}, {"price": "not a number"}, {"year": 1899},
    {"mileage": -1}, {"bhp": 2500}, {"engine": 20}, {"colour": "neon"},
    {"transmission": "cvt"}, {"saved": False}, {"price": True},
    {"image": "http://localhost/private"}, {"notes": "a" * 12001},
])
def test_invalid_manual_edits_are_rejected(fields):
    with pytest.raises(ValueError):
        validate_manual_details(fields)


def test_manual_overrides_protect_price_title_colour_and_metadata_from_scans():
    original = {"id":"example", "site":"autotrader", "url":"https://www.autotrader.co.uk/car-details/202611027550673",
                "title":"BMW M2 2017", "price":24000, "colour":"blue",
                "colourSource":"explicit", "mileage":60000, "priceHistory": [],
                "saved":True, "notes":"Private buyer notes"}
    car = copy.deepcopy(original)
    apply_manual_details(car, {"title":"M2 DCT", "price":23800,
                               "mileage":59000, "colour":"grey"}, "2026-11-16T15:00:00Z")
    server_state = server.state
    try:
        server.state = server.fresh_state()
        server.state["listings"]["example"] = car
        changed = server.update_listing({
            "id":"example", "site":"autotrader", "url":car["url"],
            "title":"BMW M2 original dealer title", "price":25000,
            "mileage":65000, "colour":"red", "colourSource":"explicit",
            "image":"https://example.com/new.jpg", "location":"London",
        }, "2026-11-17T00:00:00Z")
        assert not changed
        stored = server.state["listings"]["example"]
        assert stored["title"] == "M2 DCT"
        assert stored["price"] == 23800
        assert stored["mileage"] == 59000
        assert stored["colour"] == "grey"
        assert stored["colourSource"] == "manual"
        assert stored["location"] == "London"  # Fields not edited may still refresh.
        assert stored["notes"] == "Private buyer notes"
        assert stored["priceHistory"][-1]["source"] == "manual"
    finally:
        server.state = server_state


@pytest.mark.asyncio
async def test_manual_add_edit_duplicate_and_existing_scanned_source(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "DATA_FILE", tmp_path / "state.json")
    monkeypatch.setattr(server, "state", server.fresh_state())
    monkeypatch.setattr(server, "PASSWORD", "")
    scheduled = []
    monkeypatch.setattr(server, "start_enrichment", lambda ids: scheduled.extend(ids))
    monkeypatch.setattr(server, "schedule_photo_hashes", lambda ids=None, limit=240: 0)
    base = "https://www.autotrader.co.uk/car-details/202611027550673"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        added = await client.post("/api/listings/manual", json={
            "url":base+"?utm_source=share", "fields":{"title":"Blue BMW M2","price":24500}
        })
        assert added.status_code == 200, added.text
        body = added.json()
        key = body["carId"]
        assert body["state"]["listings"][key]["manuallyAdded"]
        assert body["state"]["listings"][key]["saved"]
        assert body["state"]["listings"][key]["price"] == 24500
        assert body["state"]["listings"][key]["manualFields"] == ["price","title"]
        assert scheduled == [key]
        assert server.state["searches"] == [] and server.state["snapshots"] == {}
        again = await client.post("/api/listings/manual", json={"url":base})
        assert again.status_code == 200 and again.json()["alreadyPresent"]
        assert len(server.state["listings"]) == 1
        assert again.json()["carId"] == key
        edited = await client.patch("/api/listings/manual/" + key, json={"fields":{
            "title":"2017 M2 manual", "price":24000, "notes":"Great value"
        }})
        assert edited.status_code == 200, edited.text
        assert edited.json()["state"]["listings"][key]["title"] == "2017 M2 manual"
        assert edited.json()["state"]["listings"][key]["notes"] == "Great value"
        assert edited.json()["state"]["listings"][key]["priceHistory"][-1]["source"] == "manual"
        bad = await client.post("/api/listings/manual", json={
            "url":"https://example.com/itm/123456789012"
        })
        assert bad.status_code == 400
        not_saved = await client.patch("/api/listings/manual/missing",
                                       json={"fields":{"title":"X"}})
        assert not_saved.status_code == 404
        assert server.DATA_FILE.exists()


@pytest.mark.asyncio
async def test_enrichment_fills_placeholder_but_preserves_manually_locked_title(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "DATA_FILE", tmp_path / "state.json")
    monkeypatch.setattr(server, "state", server.fresh_state())
    monkeypatch.setattr(server, "schedule_photo_hashes", lambda ids=None, limit=240: 0)

    async def discovered(_):
        return {"title":"2003 Porsche 911 Carrera 4S", "mileage":72000,
                "colour":"blue", "colourSource":"explicit"}
    monkeypatch.setattr(server, "enrich_listing", discovered)
    for item_id, manual_fields, title in [
        ("auto", [], "Car from Auto Trader"),
        ("edited", ["title","colour"], "My own Porsche")
    ]:
        server.state["listings"][item_id] = {
            "id":item_id, "saved":True, "site":"autotrader",
            "title":title, "titleSource":"placeholder" if item_id == "auto" else None,
            "manualFields":manual_fields,
            "colour":"red" if item_id == "edited" else None,
            "colourSource":"manual" if item_id == "edited" else "unknown",
        }
        await server.enrich_saved_listing(item_id)
    assert server.state["listings"]["auto"]["title"] == "2003 Porsche 911 Carrera 4S"
    assert server.state["listings"]["auto"]["mileage"] == 72000
    assert server.state["listings"]["edited"]["title"] == "My own Porsche"
    assert server.state["listings"]["edited"]["colour"] == "red"
