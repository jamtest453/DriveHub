"""Non-AI photo-colour estimation and conservative provenance regression tests."""
from io import BytesIO
from PIL import Image, ImageDraw

from src.image_colour import estimate_paint
from src.photo_hash import image_fingerprint


def photo(paint, bg='#a4b7aa', size=(800, 600)):
    image = Image.new('RGB', size, bg)
    draw = ImageDraw.Draw(image)
    draw.rectangle((115, 160, 685, 445), fill=paint)
    draw.polygon([(195, 185), (550, 185), (592, 284), (175, 284)], fill='#29333d')
    draw.ellipse((170, 390, 290, 510), fill='#1d2023')
    draw.ellipse((515, 390, 635, 510), fill='#1d2023')
    return image


def test_bright_colours_are_detected_without_ai():
    for colour in ('blue', 'red', 'yellow', 'green'):
        result = estimate_paint(photo(colour))
        assert result and result['colour'] == colour, (colour, result)
        assert .75 <= result['confidence'] <= 1


def test_neutral_paints_only_when_central_area_dominates():
    for name,paint in [('black','#111111'),('white','#f5f5f5'),('silver','#bbbbbb'),('grey','#777777')]:
        result=estimate_paint(photo(paint))
        assert result and result['colour']==name, (name,result)
        assert result['confidence']>=.78


def test_ambiguous_images_remain_unknown():
    uniform = Image.new('RGB', (800, 600), '#d5d5d5')
    assert estimate_paint(uniform) is None  # A uniform placeholder is not a car photo
    alternating = Image.new('RGB', (800, 600), '#2040dc')
    painter = ImageDraw.Draw(alternating)
    for x in range(0, 800, 60):
        painter.rectangle((x, 0, x+29, 600), fill='#ec2424')
    assert estimate_paint(alternating) is None


def test_fingerprint_includes_paint_without_new_download():
    source=photo('blue')
    buffer=BytesIO()
    source.save(buffer, format='PNG')
    result=image_fingerprint(buffer.getvalue())
    assert result is not None and result['p'] and result['d']
    assert result['paint']['colour']=='blue'


def test_photo_worker_respects_colour_evidence(monkeypatch):
    import asyncio
    import server

    rows = {
        'missing': {'id':'missing','image':'https://images.atcdn.co.uk/1.jpg','colourSource':'unknown'},
        'title': {'id':'title','image':'https://images.atcdn.co.uk/2.jpg','colour':'red','colourSource':'title'},
        'explicit': {'id':'explicit','image':'https://images.atcdn.co.uk/3.jpg','colour':'red','colourSource':'explicit'},
        'manual': {'id':'manual','image':'https://images.atcdn.co.uk/4.jpg','colour':'black','colourSource':'manual','manualFields':['colour']},
    }
    monkeypatch.setattr(server,'state',{'listings': rows})
    monkeypatch.setattr(server,'PHOTO_QUEUE',asyncio.Queue())
    monkeypatch.setattr(server,'PHOTO_PENDING',set(rows))
    monkeypatch.setattr(server,'store',lambda:None)
    monkeypatch.setattr(server,'job',{'busy':False})
    async def fake(url):
        return {'p':'0'*16,'d':'f'*16,'rgb':[15,30,200],
                'paint':{'colour':'blue','confidence':.94}}
    monkeypatch.setattr(server,'download_fingerprint',fake)

    async def check():
        for key in rows:
            server.PHOTO_QUEUE.put_nowait(key)
        await server.photo_hash_worker()
    asyncio.run(check())
    assert rows['missing']['colour']=='blue' and rows['missing']['colourSource']=='photo'
    for key in ('title','explicit','manual'):
        assert rows[key]['colour']=='black' if key=='manual' else rows[key]['colour']=='red'
        assert rows[key]['colourSource']==key
    for item in rows.values():
        assert item['photoColour']=='blue'
        assert item['photoColourCheckedAt']


def test_new_photo_invalidates_previous_photo_colour(monkeypatch):
    import server
    car={'id':'m2','site':'autotrader','title':'BMW M2','url':'https://www.autotrader.co.uk/car-details/202611027550673',
         'image':'https://images.atcdn.co.uk/old.jpg','colour':'blue','colourSource':'photo',
         'photoColour':'blue','photoColourConfidence':.91,'photoColourCheckedAt':12345,
         'photoHash':{'p':'0'*16},'price':25000,'manualFields':[]}
    monkeypatch.setattr(server,'state',{'listings':{'m2':car}})
    server.update_listing({'id':'m2','site':'autotrader','title':'BMW M2',
                           'image':'https://images.atcdn.co.uk/new.jpg',
                           'colourSource':'unknown','price':25000},'now')
    assert car['colourSource']=='unknown' and not car.get('colour')
    assert 'photoColour' not in car and 'photoHash' not in car
