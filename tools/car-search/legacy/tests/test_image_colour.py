"""Image-derived exterior paint is retired; photo matching still works."""
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from src.photo_hash import image_fingerprint


def sample_photo():
    img = Image.new("RGB", (800, 600), "#adb6ab")
    draw = ImageDraw.Draw(img)
    draw.rectangle((100, 170, 700, 440), fill="#1348b4")
    draw.rectangle((185, 180, 615, 245), fill="#292b35")
    draw.ellipse((150, 380, 280, 500), fill="#111111")
    draw.ellipse((510, 380, 640, 500), fill="#111111")
    out = BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def test_fingerprint_retains_image_matching_but_never_estimates_paint():
    result = image_fingerprint(sample_photo())
    assert result is not None and result["p"] and result["d"]
    assert len(result["rgb"]) == 3
    assert "paint" not in result


def test_retirement_cleans_only_photo_guesses_from_existing_data():
    import server
    raw = {"listings": {
        "photo": {"colour": "blue", "colourSource": "photo",
                  "photoColour": "blue", "photoColourConfidence": .98,
                  "photoColourCheckedAt": 12345},
        "manual": {"colour": "red", "colourSource": "manual",
                   "photoColour": "blue"},
        "explicit": {"colour": "grey", "colourSource": "explicit"},
        "title": {"colour": "white", "colourSource": "title"},
    }}
    server.remove_photo_colour_guesses(raw)
    assert raw["listings"]["photo"].get("colour") is None
    assert raw["listings"]["photo"]["colourSource"] == "unknown"
    assert "photoColour" not in raw["listings"]["photo"]
    for key,expected in (("manual","red"),("explicit","grey"),("title","white")):
        assert raw["listings"][key]["colour"] == expected


@pytest.mark.asyncio
async def test_photo_worker_keeps_user_and_advert_colours(monkeypatch):
    import asyncio
    import server
    rows = {
        "missing": {"id":"missing","image":"https://images.atcdn.co.uk/1.jpg",
                    "colourSource":"unknown"},
        "manual": {"id":"manual","image":"https://images.atcdn.co.uk/2.jpg",
                   "colour":"black","colourSource":"manual","manualFields":["colour"]},
        "explicit": {"id":"explicit","image":"https://images.atcdn.co.uk/3.jpg",
                     "colour":"red","colourSource":"explicit"},
    }
    monkeypatch.setattr(server,"state",{"listings":rows})
    monkeypatch.setattr(server,"PHOTO_QUEUE",asyncio.Queue())
    monkeypatch.setattr(server,"PHOTO_PENDING",set(rows))
    monkeypatch.setattr(server,"job",{"busy":False})
    monkeypatch.setattr(server,"store",lambda publish=True:None)
    async def fake(url):
        return {"p":"0"*16,"d":"f"*16,"rgb":[14,31,200]}
    monkeypatch.setattr(server,"download_fingerprint",fake)
    for key in rows:
        server.PHOTO_QUEUE.put_nowait(key)
    await server.photo_hash_worker()
    assert "colour" not in rows["missing"]
    assert rows["missing"]["colourSource"] == "unknown"
    assert rows["manual"]["colour"] == "black"
    assert rows["explicit"]["colour"] == "red"
    for car in rows.values():
        assert car["photoHash"]["p"] == "0"*16
        assert "photoColour" not in car
        assert "photoColourCheckedAt" not in car


def test_new_photo_drops_old_guess_without_restoring_estimation(monkeypatch):
    import server
    car={"id":"m2","site":"autotrader","title":"BMW M2",
         "url":"https://www.autotrader.co.uk/car-details/202611027550673",
         "image":"https://images.atcdn.co.uk/old.jpg",
         "colour":"blue","colourSource":"photo",
         "photoHash":{"p":"0"*16},"price":25000,"manualFields":[]}
    monkeypatch.setattr(server,"state",{"listings":{"m2":car}})
    server.update_listing({"id":"m2","site":"autotrader","title":"BMW M2",
                           "image":"https://images.atcdn.co.uk/new.jpg",
                           "colourSource":"unknown","price":25000},"now")
    assert car["colourSource"] == "unknown"
    assert not car.get("colour")
    assert "photoHash" not in car
