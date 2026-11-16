"""Regression tests for inaccurate colour guesses from advert interiors/trim."""
from pathlib import Path

import pytest

import server
from src.colour import listing_exterior_colour, normalise_colour, title_exterior_colour
from src.detail_enrichment import normalize_details
from src.query_builder import apply_local_filters, validate_filters


@pytest.mark.parametrize("paint,expected",[
    ("Long Beach Blue Metallic","blue"),
    ("Hockenheim Silver","silver"),
    ("Mineral Grey Metallic","grey"),
    ("Nardo Gray","grey"),
    ("Carbon Black","black"),
    ("Alpine White","white"),
    ("British Racing Green","green"),
    ("Sakhir Orange","orange"),
    ("Thundernight Metallic","purple"),
    ("Blue metallic","blue"),
    ("GRAY","grey"),
    ("Silver grey metallic","silver"),
])
def test_explicit_factory_paint_names_are_normalised(paint,expected):
    assert normalise_colour(paint)==expected


@pytest.mark.parametrize("title,expected",[
    ("BMW M2 Long Beach Blue 2017","blue"),
    ("2017 BMW M2 in Hockenheim Silver with black leather","silver"),
    ("BMW M2 Blue with black leather and black alloys","blue"),
    ("2018 BMW M2 Carbon Black","black"),
    ("BMW M2 2017 black leather seats",None),
    ("2017 BMW M2 Black alloy wheels",None),
    ("BMW M2 2017, red brake calipers",None),
    ("2017 BMW M2 Black Edition",None),
    ("2017 BMW M2",None),
])
def test_title_colour_ignores_trim_interior_and_wheels(title,expected):
    assert title_exterior_colour(title)==expected


def test_colour_is_never_guessed_from_generic_description():
    item={"title":"2017 BMW M2 Coupe",
          "description":"Black leather interior, silver wheels, red brake calipers, blue stitching"}
    assert listing_exterior_colour(item)==(None,"unknown")


def test_explicit_exterior_colour_has_priority_over_other_title_colours():
    item={"title":"2017 BMW M2 with black leather","colour":"Long Beach Blue"}
    assert listing_exterior_colour(item)==("blue","explicit")
    raw={"title":"2017 BMW M2 Black leather","colour":"Long Beach Blue"}
    assert apply_local_filters(raw,validate_filters({"colours":["blue"]}),"BMW M2")[0]
    assert raw["colour"]=="blue" and raw["colourSource"]=="explicit"


def test_search_colour_requires_confirmed_match_unless_unknown_is_explicitly_included():
    selected=validate_filters({"colours":["blue"]})
    assert selected["strictColour"] is True
    assert selected["includeUnknownColours"] is False
    unidentified={"title":"2017 BMW M2 Coupe",
                  "description":"Black leather seats, silver alloys"}
    included,unknown=apply_local_filters(unidentified,selected,"BMW M2")
    assert not included and unknown==[]
    assert unidentified["colourSource"]=="unknown"

    broad=validate_filters({"colours":["blue"],"includeUnknownColours":True})
    assert broad["strictColour"] is False
    another={"title":"2017 BMW M2 Coupe","description":"Black leather seats"}
    keep,missing=apply_local_filters(another,broad,"BMW M2")
    assert keep and "colour" in missing
    assert not another.get("colour")
    assert apply_local_filters({"title":"2017 BMW M2 Long Beach Blue"},selected,"BMW M2")[0]
    assert apply_local_filters({"title":"2017 BMW M2 red"},selected,"BMW M2")[0] is False

    # Older strictColour=False was the automatic old default; it must not
    # secretly opt a user into unknown-colour results after the upgrade.
    old=validate_filters({"colours":["blue"],"strictColour":False})
    assert old["includeUnknownColours"] is False
    assert old["strictColour"] is True


def test_invalid_strict_filter_is_rejected():
    with pytest.raises(ValueError):
        validate_filters({"strictColour":"yes"})
    with pytest.raises(ValueError):
        validate_filters({"includeUnknownColours":"yes"})


def test_refresh_clears_legacy_colour_guesses_but_keeps_explicit_paint(monkeypatch):
    item_id="autotrader:1234567890"
    monkeypatch.setattr(server,"state",{**server.fresh_state(),"listings":{
        item_id:{"id":item_id,"site":"autotrader","title":"2017 BMW M2",
                 "colour":"black","price":23000,"saved":True,
                 "notes":"Keep this note", "priceHistory":[{"price":23000,"at":"earlier"}]}
    }})
    server.update_listing({
        "id":item_id,"site":"autotrader","title":"2017 BMW M2",
        "description":"Black leather, silver wheels", "price":23000,
    },"later")
    item=server.state["listings"][item_id]
    assert item.get("colour") is None
    assert item["colourSource"]=="unknown"
    assert item["notes"]=="Keep this note"
    assert item["saved"] is True
    assert len(item["priceHistory"])==1
    server.update_listing({
        "id":item_id,"site":"autotrader","title":"2017 BMW M2 Long Beach Blue",
        "price":23000,
    },"later-2")
    assert item["colour"]=="blue" and item["colourSource"]=="title"
    # A shorter search card should not erase independently verified paint.
    item["colourSource"]="explicit"
    server.update_listing({
        "id":item_id,"site":"autotrader","title":"2017 BMW M2",
        "description":"Black seats", "price":23000,
    },"later-3")
    assert item["colour"]=="blue" and item["colourSource"]=="explicit"


def test_saved_advert_enrichment_normalises_explicit_paint():
    details=normalize_details({
        "title":"2017 BMW M2", "description":"Black seats",
        "colour":"Hockenheim Silver", "transmission":"DCT"
    })
    assert details["colour"]=="silver"
    assert details["colourSource"]=="explicit"


def test_displayed_result_colour_filter_uses_provenance():
    root=Path(__file__).resolve().parents[1]
    dashboard=(root/"public/dashboard.js").read_text(encoding="utf-8")
    html=(root/"public/dashboard.html").read_text(encoding="utf-8")
    assert "function exteriorColour(car)" in dashboard
    assert "['explicit','title','manual','photo'].includes(car.colourSource)" in dashboard
    assert "selected === 'unknown'" in dashboard
    assert "function groupMatchesColour(group)" in dashboard
    assert "colours.length === 0" in dashboard
    assert 'id="carStrictColour"' in html
    assert 'value="unknown">Unknown / not confirmed' in html
