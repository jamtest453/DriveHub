"""Required and preferred keyword modes for cross-site vehicle searches."""
import pytest

from src.query_builder import validate_filters, generate_links, normalise_keyword_phrases


def test_new_modes_are_independent_and_backward_compatible():
    filters = validate_filters({
        "requiredKeywords": " manual, heated  seats; MANUAL ",
        "preferredKeywords": "Harman Kardon, performance exhaust",
        "excludeKeywords": "wrapped, Cat S",
    })
    assert filters["requiredKeywords"] == "manual, heated seats, MANUAL"
    assert filters["preferredKeywords"] == "Harman Kardon, performance exhaust"
    assert filters["excludeKeywords"] == "wrapped, Cat S"
    assert filters["keywords"] == filters["preferredKeywords"]
    assert validate_filters({})["requiredKeywords"] == ""
    assert validate_filters({})["preferredKeywords"] == ""
    assert validate_filters({"keywords": "  historic extra "})["preferredKeywords"] == "historic extra"


def test_provider_search_remains_broad_for_required_and_preferred():
    filters = validate_filters({
        "requiredKeywords": "manual, heated seats",
        "preferredKeywords": "performance exhaust, Harman Kardon",
        "excludeKeywords": "convertible",
    })
    links = generate_links(filters, sources=["autotrader", "ebay", "facebook", "pistonheads"],
                           search_name="BMW M2")
    assert len(links) == 4
    for item in links:
        assert "BMW+M2" in item["url"] or "BMW%20M2" in item["url"]
        assert all(term not in item["url"].lower()
                   for term in ("heated", "manual", "harman", "performance", "convertible"))

    # Older keyword fields must no longer over-constrain site results.
    legacy = validate_filters({"keywords": "red, manual"})
    legacy_links = generate_links(legacy, sources=["facebook"], search_name="BMW M2")
    assert "red" not in legacy_links[0]["url"].lower()
    assert "manual" not in legacy_links[0]["url"].lower()


@pytest.mark.parametrize("field", ["requiredKeywords", "preferredKeywords"])
@pytest.mark.parametrize("value", [
    ["manual"],
    "a" * 501,
    ",".join("x" + str(i) for i in range(31)),
    "b" * 81,
])
def test_invalid_keyword_modes_rejected(field, value):
    with pytest.raises(ValueError):
        validate_filters({field: value})


def test_normalise_comma_separated_phrases():
    assert normalise_keyword_phrases("non-sport, 6 speed manual", "Required keywords") == \
           "non-sport, 6 speed manual"


def test_required_keyword_logic_validation_and_default():
    assert validate_filters({})["requiredKeywordLogic"] == "all"
    assert validate_filters({"requiredKeywords":"C4S OR Carrera 4S, manual",
                             "requiredKeywordLogic":"any"})["requiredKeywordLogic"] == "any"
    assert validate_filters({"requiredKeywords":"C4S | Carrera 4S",
                             "requiredKeywordLogic":"all"})["requiredKeywords"] == "C4S | Carrera 4S"
    for invalid in ("xor", "none", True, 1, None):
        with pytest.raises(ValueError):
            validate_filters({"requiredKeywordLogic":invalid})
