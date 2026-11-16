"""Validation and provider behaviour for saved-search negative keywords."""
import pytest

from src.query_builder import validate_filters, generate_links


def test_exclusions_normalise_and_preserve_multi_word_phrases():
    filters = validate_filters({
        "excludeKeywords": " wrapped,  Cat  S ; convertible\n wrapped "
    })
    assert filters["excludeKeywords"] == "wrapped, Cat S, convertible"
    assert validate_filters({})["excludeKeywords"] == ""


def test_exclusions_never_remove_source_adverts_at_collection_time():
    filters = validate_filters({"excludeKeywords": "convertible, damaged"})
    links = generate_links(filters, sources=["autotrader", "ebay", "facebook", "pistonheads"],
                           search_name="BMW M2")
    # Match exclusions locally after grouping, not in provider queries:
    # losing an advert at ingestion can let another provider reintroduce it.
    assert len(links) == 4
    assert all("convertible" not in link["url"] and "damaged" not in link["url"]
               for link in links)


@pytest.mark.parametrize("raw", [
    {"excludeKeywords": ["wrapped"]},
    {"excludeKeywords": "x" * 501},
    {"excludeKeywords": ",".join(f"keyword{i}" for i in range(31))},
    {"excludeKeywords": "x" * 81},
])
def test_invalid_exclusion_fields_are_rejected(raw):
    with pytest.raises(ValueError, match="Exclude|excluded"):
        validate_filters(raw)
