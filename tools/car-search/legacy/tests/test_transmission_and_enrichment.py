"""Transmission filters, save-time enrichment and list-vs-query UI separation."""
import asyncio
import json
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

import httpx
import pytest

import server
from src.detail_enrichment import normalize_details
from src.query_builder import validate_filters, generate_links, apply_local_filters, infer_transmission


def test_transmission_validation_and_vehicle_classification():
    assert validate_filters({"keywords":"","transmission":"manual"})["transmission"] == "manual"
    assert validate_filters({"keywords":""})["transmission"] == "any"
    with pytest.raises(ValueError):
        validate_filters({"transmission":"semi-autonomous"})
    for title in ("2017 BMW M2 DCT Coupe", "BMW 911 PDK", "VW Golf DSG",
                  "BMW Z4 Automatic", "Audi S Tronic"):
        assert infer_transmission({"title":title}) == "automatic",title
    for title in ("Lotus Evora 6 speed manual", "Porsche 997 Manual"):
        assert infer_transmission({"title":title}) == "manual"
    assert infer_transmission({"title":"2017 BMW M2" }) is None


def test_transmission_search_filter_is_provider_specific_and_unknowns_are_retained():
    filters = validate_filters({"keywords":"","transmission":"manual"})
    links = generate_links(filters, ["autotrader","pistonheads","facebook","ebay"], "BMW M2")
    params = {l["site"]:parse_qs(urlsplit(l["url"]).query) for l in links}
    assert params["autotrader"]["transmission"] == ["Manual"]
    assert "transmission" not in params["pistonheads"]
    assert apply_local_filters({"title":"BMW M2 DCT automatic"},filters,"BMW M2")[0] is False
    assert apply_local_filters({"title":"BMW M2 6 speed manual"},filters,"BMW M2")[0] is True
    unknown = apply_local_filters({"title":"BMW M2 Coupe"},filters,"BMW M2")
    assert unknown[0] is True and "transmission" in unknown[1]


def test_detail_enrichment_extracts_only_explicit_advert_data():
    record = normalize_details({
        "title":"2017 BMW M2 3.0 DCT",
        "description":"One owner. 55,000 miles. 365 BHP.",
        "image":"https://example.com/m2.jpg",
        "location":"Sutton Coldfield",
        "transmission":"DCT"
    })
    assert record["transmission"] == "automatic"
    assert record["year"] == 2017
    assert record["mileage"] == 55000
    assert record["engine"] == 3.0
    assert record["bhp"] == 365
    assert record["location"] == "Sutton Coldfield"
    assert "price" not in record
    assert not normalize_details({"image":"javascript:alert(1)"}).get("image")


@pytest.mark.asyncio
async def test_saving_car_queues_background_enrichment_and_preserves_known_data(tmp_path,monkeypatch):
    original_state = server.state
    original_data = server.DATA_DIR
    original_file = server.DATA_FILE
    original_password=server.PASSWORD
    monkeypatch.setattr(server, "PASSWORD", "")
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "DATA_FILE", tmp_path/"car-search-hub.json")
    record={"id":"facebook:12345678901","site":"facebook",
            "url":"https://www.facebook.com/marketplace/item/12345678901/",
            "title":"2017 BMW M2 DCT","price":23000,"notes":"private note",
            "saved":False,"location":"","transmission":"","priceHistory":[{"price":23000,"at":"2026-11-15"}]}
    monkeypatch.setattr(server,"state",{**server.fresh_state(),
                                       "listings":{record["id"]:record}})
    async def fake_enrichment(snapshot):
        assert snapshot["saved"] is True
        return {"location":"Sutton Coldfield","transmission":"automatic",
                "price":999,"title":"Another title","mileage":55000,"notes":"OVERWRITE"}
    monkeypatch.setattr(server,"enrich_listing",fake_enrichment)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
            base_url="http://testserver") as client:
            response = await client.post("/api/listings/saved",
                json={"ids":[record["id"]],"saved":True})
            assert response.status_code==200
        tasks=list(server.ENRICH_TASKS)
        if tasks:
            await asyncio.gather(*tasks)
        saved=server.state["listings"][record["id"]]
        assert saved["saved"] is True
        assert saved["location"]=="Sutton Coldfield"
        assert saved["transmission"]=="automatic"
        assert saved["mileage"]==55000
        assert saved["title"]=="2017 BMW M2 DCT"
        assert saved["price"]==23000
        assert saved["notes"]=="private note"
        assert len(saved["priceHistory"])==1
        assert saved["enrichStatus"]=="complete"
    finally:
        server.state = original_state
        server.DATA_DIR = original_data
        server.DATA_FILE = original_file
        server.PASSWORD=original_password


def test_results_filter_and_save_share_are_not_search_criteria():
    root=Path(__file__).resolve().parents[1]
    h=(root/"public/dashboard.html").read_text()
    j=(root/"public/dashboard.js").read_text()
    assert 'id="carTransmission"' in h
    assert 'id="resultTransmission"' in h
    assert 'id="resultFilterPanel"' in h
    assert 'id="resultPriceMax"' in h
    assert 'id="resultColour"' in h
    assert 'id="resultBhpMin"' in h
    assert 'id="resultEngineMax"' in h
    assert "g.some(matchesResultFilters)" in j
    assert "shareSavedCars()" in j
    assert "navigator.share" in j
    assert 'class="map-car-thumbnail"' in j
    assert 'user-scalable=yes' in h
    assert "pinch-zoom" in (root/"public/styles.css").read_text()
