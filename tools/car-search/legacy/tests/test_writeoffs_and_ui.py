"""Auto Trader write-off suppression and verified Facebook UI-status checks."""
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from src.query_builder import generate_links, validate_filters
from src.scanner import url_for_page
from src.writeoff import is_visible_writeoff
from src.facebook_connection import FacebookConnection


def test_autotrader_search_always_excludes_recorded_writeoffs():
    link = generate_links(validate_filters({"keywords":""}), ["autotrader"], "BMW M2")[0]
    params = parse_qs(urlsplit(link["url"]).query)
    assert params["exclude-writeoff-categories"] == ["on"]
    assert params["keywords"] == ["BMW M2"]


def test_legacy_autotrader_url_is_forced_to_exclude_writeoffs_on_all_pages():
    old = ("https://www.autotrader.co.uk/car-search?"
           "keywords=BMW+M2&writeoff-categories=on")
    for page in (1, 2, 5):
        url = url_for_page(old, "autotrader", page)
        params = parse_qs(urlsplit(url).query)
        assert params["exclude-writeoff-categories"] == ["on"]
        assert "writeoff-categories" not in params
        assert "only-writeoff-categories" not in params
        assert params["keywords"] == ["BMW M2"]
        if page > 1:
            assert params["page"] == [str(page)]
    assert url_for_page("https://www.pistonheads.com/buy/search?keywords=BMW+M2",
                        "pistonheads", 1).endswith("keywords=BMW+M2")


def test_visible_recorded_writeoff_indicators_are_suppressed():
    for label in ("Cat S BMW M2", "Category N repaired BMW M2",
                  "previously written off", "Cat D vehicle", "insurance total loss",
                  "write-off category C"):
        assert is_visible_writeoff({"title": label}), label
    for label in ("BMW M2 3.0 Coupe", "Category: Sports cars",
                  "Cat Back Exhaust", "Never written off", "Not a Cat S car"):
        assert not is_visible_writeoff({"title": label}), label
    assert is_visible_writeoff({"title":"BMW M2",
                                "description":"This example is a category S repair."})


@pytest.mark.asyncio
async def test_connection_status_checks_persisted_session_after_restart(tmp_path,monkeypatch):
    import src.facebook_connection as fc
    file=tmp_path / "facebook-session.json"
    file.write_text('{"cookies":[]}')
    monkeypatch.setattr(fc,"managed_state_path",lambda:file)
    obj=FacebookConnection()
    async def fake_verify():
        obj.state="connected"
        obj.message="Marketplace listings loaded on Railway."
        import time
        obj.verified_at=time.monotonic()
    monkeypatch.setattr(obj,"_check_saved_session",fake_verify)
    first=await obj.check_saved_status()
    assert first["state"]=="checking_saved"
    await obj.check_task
    assert obj.status()["state"]=="connected"
    second=await obj.check_saved_status()
    assert second["state"]=="connected"
    file.unlink()
    again=await obj.check_saved_status()
    assert again["state"]=="not_checked"


def test_ui_has_four_column_cap_and_modal_source_previews():
    from pathlib import Path
    root=Path(__file__).resolve().parents[1]
    css=(root/"public/styles.css").read_text(encoding="utf-8")
    js=(root/"public/dashboard.js").read_text(encoding="utf-8")
    assert "grid-template-columns:repeat(4,minmax(0,1fr))" in css
    assert "fb-connected" in css and "FB marketplace connected" in js
    assert 'data-action="car-source"' in js
    assert "openCarDetails(ids, btn.dataset.id)" in js
    assert "Specs unverified" not in js
