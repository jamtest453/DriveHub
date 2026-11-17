"""Body type filtering must preserve adverts with unknown style."""
import pytest

from src.body_type import listing_body_type, normalise_body_type
from src.query_builder import validate_filters, apply_local_filters, generate_links


@pytest.mark.parametrize(("raw","expected"), [
    ("Coupe","coupe"),("Coupé","coupe"),("Roadster","convertible"),
    ("Cabriolet","convertible"),("SUV","suv"),("4x4","suv"),
    ("Hatchback","hatchback"),("Estate","estate"),
    ("Saloon","saloon"),("MPV","mpv"),("Pick-up","pickup"),
    ("People Carrier","mpv"),("Sportback",""),("","")
])
def test_normalisation(raw,expected):
    assert (normalise_body_type(raw) or "")==expected


def test_explicit_and_title_only_body_types_without_description_guessing():
    assert listing_body_type({"bodyType":"Roadster","title":"2017 BMW M2"})=="convertible"
    assert listing_body_type({"title":"2017 BMW M2 Coupe"})=="coupe"
    assert listing_body_type({"title":"Jaguar F-Type V6", "description":"Not a convertible, full history"}) is None
    assert listing_body_type({"bodyType":"Unknown","title":"Ford Mustang Coupe"}) is None


def test_unknowns_pass_and_known_mismatches_fail():
    filters=validate_filters({"bodyTypes":["coupe","convertible"]})
    assert filters["bodyTypes"] == ["convertible","coupe"]
    for item in (
      {"title":"BMW M2"},
      {"title":"2017 BMW M2 Coupe"},
      {"title":"BMW M2","bodyType":"Roadster"},
    ):
      keep,unknown=apply_local_filters(item,filters,"BMW M2")
      assert keep, (item,unknown)
    keep,unknown=apply_local_filters({"title":"BMW M2"},filters,"BMW M2")
    assert keep and "bodyType" in unknown
    keep,_=apply_local_filters({"title":"2017 BMW M2 Hatchback"},filters,"BMW M2")
    assert not keep


def test_search_source_filters_do_not_suppress_undocumented_body_types():
    filters=validate_filters({"bodyTypes":["coupe"],"colours":["blue"],
                              "includeUnknownColours":True})
    urls=generate_links(filters,search_name="BMW M2")
    assert len(urls)==4
    for row in urls:
        assert "Body styles are checked locally" in row["sourceNote"]
        # A provider-only body filter would exclude adverts with no style.
        assert "body-type=" not in row["url"]
    assert "colour=" not in next(row["url"] for row in urls if row["site"]=="autotrader")


@pytest.mark.parametrize("invalid", [["coupe","bogus"],"coupe",["SUV","other","other"]*10])
def test_reject_unsupported_filter_values(invalid):
    with pytest.raises(ValueError):
        validate_filters({"bodyTypes":invalid})
