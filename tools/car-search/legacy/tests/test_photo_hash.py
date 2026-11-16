"""Non-AI photo comparison: pHash + dHash, URL access restrictions and server job."""
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image, ImageDraw
import pytest

import server
from src.photo_hash import image_fingerprint, valid_photo_url, download_fingerprint


def make_photo(variant=0, fmt="PNG", resize=None, quality=95):
    im=Image.new("RGB", (440, 290), "#d7d4ca" if variant==0 else "#91a6ae")
    draw=ImageDraw.Draw(im)
    for y in range(290):
        shade=((y*7) % 55)
        draw.line((0,y,440,y),fill=(70+shade,110+shade//2,105+shade//3))
    if variant==0:
        draw.polygon([(36,176),(90,113),(330,110),(395,189),(350,230),(55,220)],
                     fill=(35,79,151))
        draw.ellipse((70,195,140,266),fill=(18,19,26))
        draw.ellipse((300,194,369,265),fill=(18,19,26))
        draw.rectangle((123,130,262,174),fill=(160,201,217))
        draw.line((0,270,440,245),fill=(220,198,170),width=10)
    else:
        draw.rectangle((18,150,420,225),fill=(210,82,48))
        draw.polygon([(70,145),(140,75),(270,92),(355,159)],fill=(190,52,36))
        draw.ellipse((44,204,117,282),fill=(25,27,30))
        draw.ellipse((337,205,410,282),fill=(25,27,30))
        draw.rectangle((155,110,245,153),fill=(210,205,205))
    if resize:
        im=im.resize(resize,Image.Resampling.LANCZOS)
    buf=BytesIO()
    if fmt=="JPEG":
        im.save(buf,"JPEG",quality=quality)
    else:
        im.save(buf,"PNG")
    return buf.getvalue()


def distance(first,second):
    return (int(first["p"],16)^int(second["p"],16)).bit_count(), \
           (int(first["d"],16)^int(second["d"],16)).bit_count()


def test_near_identical_resized_jpeg_has_very_close_hashes():
    original=image_fingerprint(make_photo(0))
    jpg=image_fingerprint(make_photo(0,fmt="JPEG",resize=(340,224),quality=85))
    assert original is not None and jpg is not None
    pd,dd=distance(original,jpg)
    assert pd<=3 and dd<=5,(pd,dd)
    assert abs(original["rgb"][0]-jpg["rgb"][0])<=38


def test_different_car_photo_is_not_near_identical():
    first=image_fingerprint(make_photo(0))
    second=image_fingerprint(make_photo(1))
    assert first is not None and second is not None
    pd,dd=distance(first,second)
    assert pd>3 or dd>5 or sum(abs(a-b) for a,b in zip(first["rgb"],second["rgb"]))/3>38


def test_placeholder_and_invalid_images_are_not_fingerprinted():
    im=Image.new("RGB",(400,300),(220,220,220))
    buf=BytesIO();im.save(buf,"PNG")
    assert image_fingerprint(buf.getvalue()) is None
    assert image_fingerprint(b"not an image") is None
    assert image_fingerprint(b"x"*2500001) is None


@pytest.mark.parametrize("url",[
    "http://images.pistonheads.com/car.jpg",
    "https://127.0.0.1/photo.png",
    "https://192.168.1.100/photo.jpg",
    "https://169.254.169.254/latest/meta-data/",
    "https://fbcdn.net.attacker.example/img.jpg",
    "https://localhost/photo.jpg",
    "https://evil.com/image.jpg",
    "https://user:pass@i.ebayimg.com/a.jpg",
    "https://i.ebayimg.com:8443/photo.jpg",
    "file:///etc/passwd",
])
def test_refuses_untrusted_photo_urls(url):
    assert not valid_photo_url(url)


@pytest.mark.parametrize("url",[
    "https://scontent-lhr8-1.xx.fbcdn.net/image.jpg?x=123",
    "https://i.ebayimg.com/images/g/test/s-l1600.jpg",
    "https://m.atcdn.co.uk/a.jpeg",
    "https://images.pistonheads.com/cars/large.jpg",
])
def test_accepts_known_photo_cdn_urls(url):
    assert valid_photo_url(url)


@pytest.mark.asyncio
async def test_non_image_response_never_stored(monkeypatch):
    class Response:
        status_code=200
        headers={"content-type":"text/html"}
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
    class Client:
        def __init__(self,**kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        def stream(self,*args,**kwargs): return Response()
    monkeypatch.setattr("src.photo_hash.httpx.AsyncClient",Client)
    assert await download_fingerprint("https://i.ebayimg.com/images/g/test.jpg") is None


@pytest.mark.asyncio
async def test_server_queues_and_saves_fingerprint_without_changing_car_details(monkeypatch,tmp_path):
    import time
    monkeypatch.setattr(server,"DATA_DIR",tmp_path)
    monkeypatch.setattr(server,"DATA_FILE",tmp_path/"data.json")
    monkeypatch.setattr(server,"state",{**server.fresh_state(),"listings":{
        "ebay:1":{
            "id":"ebay:1","site":"ebay","title":"BMW M2",
            "image":"https://i.ebayimg.com/images/g/photo.jpg",
            "price":23500,"saved":True,"notes":"Keep", "priceHistory":[{"price":23500,"at":"yesterday"}]
        }}})
    stub={"p":"f" * 16, "d":"a" * 16, "rgb":[120,95,80]}
    async def fake_download(url):
        return stub
    monkeypatch.setattr(server,"download_fingerprint",fake_download)
    server.PHOTO_PENDING.clear()
    while not server.PHOTO_QUEUE.empty():
        server.PHOTO_QUEUE.get_nowait()
        server.PHOTO_QUEUE.task_done()
    server.schedule_photo_hashes()
    tasks=list(server.PHOTO_WORKERS)
    if tasks:
        await __import__("asyncio").gather(*tasks)
    car=server.state["listings"]["ebay:1"]
    assert car["photoHash"]==stub
    assert car["photoStatus"]=="ready"
    assert car["notes"]=="Keep" and car["price"]==23500
    assert len(car["priceHistory"])==1
    assert (tmp_path/"data.json").exists()
