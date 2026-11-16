import pytest
import httpx
import server
from src.scanner import clean_url, site_for, fb_query, match_fb_title, url_for_page, unsafe_host


def test_url_safety():
    assert site_for('https://www.autotrader.co.uk/car-search?model=m2') == 'autotrader'
    assert site_for('https://www.ebay.co.uk/sch/i.html?_nkw=bmw+m2') == 'ebay'
    assert clean_url('http://www.autotrader.co.uk/car-search') is None
    assert clean_url('https://facebook.com.evil.example/marketplace/') is None
    assert clean_url('https://127.0.0.1/marketplace/') is None
    assert unsafe_host('169.254.169.254') and unsafe_host('127.0.0.1')
    assert not unsafe_host('www.facebook.com')


def test_facebook_title_filter():
    query=fb_query('https://www.facebook.com/marketplace/search?query=BMW%20M2')
    assert query == 'BMW M2'
    assert match_fb_title('BMW M2 competition in Long Beach Blue', query)
    assert not match_fb_title('BMW 330d MSport', query)
    assert not match_fb_title('A different M2 offered for sale', query)
    assert url_for_page('https://www.ebay.co.uk/sch/i.html?_nkw=m2','ebay',2).endswith('_nkw=m2&_pgn=2')


def test_price_history():
    server.state=server.fresh_state()
    car={'id':'ebay:1234567890','site':'ebay','url':'https://www.ebay.co.uk/itm/1234567890','title':'2017 BMW M2','price':24450,'image':''}
    assert not server.update_listing(car,'2026-11-14T10:00:00Z')
    assert not server.update_listing({**car,'price':None},'2026-11-14T11:00:00Z')
    assert server.update_listing({**car,'price':23450},'2026-11-14T12:00:00Z')
    found=server.state['listings'][car['id']]
    assert found['price']==23450 and found['previousPrice']==24450
    assert len(found['priceHistory'])==2


@pytest.mark.asyncio
async def test_api_searches_notes_and_backup(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(server, 'DATA_FILE', tmp_path/'state.json')
    monkeypatch.setattr(server, 'state', server.fresh_state())
    monkeypatch.setattr(server, 'PASSWORD', '')
    transport=httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport,base_url='http://testserver') as client:
        r=await client.post('/api/searches',json={'name':'BMW M2','urls':['https://www.autotrader.co.uk/car-search?make=BMW&model=M2']})
        assert r.status_code==200, r.text
        search_id=r.json()['searchId']
        assert (await client.get('/api/state')).json()['state']['searches'][0]['id']==search_id
        assert (await client.patch('/api/options',json={'pageDepth':5})).status_code==200
        assert (await client.get('/api/export')).status_code==200
        assert (await client.delete(f'/api/searches/{search_id}')).status_code==200
        assert (await client.get('/api/state')).json()['state']['searches']==[]
    assert (tmp_path/'state.json').is_file()

@pytest.mark.asyncio
async def test_full_refresh_baseline_then_new_and_price_change(tmp_path, monkeypatch):
    monkeypatch.setattr(server,'DATA_DIR',tmp_path)
    monkeypatch.setattr(server,'DATA_FILE',tmp_path/'store.json')
    link={'id':'link-1','site':'autotrader','url':'https://www.autotrader.co.uk/car-search?model=M2'}
    search={'id':'search-1','name':'BMW M2','links':[link],'lastChecked':None,'lastReport':None}
    monkeypatch.setattr(server,'state',{**server.fresh_state(),'searches':[search]})
    server.job.update(busy=True,stop=False,label='',detail='',message='')
    car_a={'id':'autotrader:1234567890','site':'autotrader','url':'https://www.autotrader.co.uk/car-details/1234567890','title':'BMW M2 blue','price':24450}
    car_b={'id':'autotrader:1234567891','site':'autotrader','url':'https://www.autotrader.co.uk/car-details/1234567891','title':'BMW M2 white','price':22500}
    outcomes=[{'ok':True,'items':[car_a],'pagesRead':1,'incomplete':False},
              {'ok':True,'items':[{**car_a,'price':23450},car_b],'pagesRead':1,'incomplete':False},
              {'ok':False,'error':'Blocked by website'}]
    async def fake_scan(*args,**kwargs):
        return outcomes.pop(0)
    class Browser:
        async def close(self): pass
    class Chromium:
        async def launch(self,**kwargs): return Browser()
    class PW:
        chromium=Chromium()
    class Context:
        async def __aenter__(self): return PW()
        async def __aexit__(self,*args): pass
    monkeypatch.setattr(server,'async_playwright',lambda:Context())
    monkeypatch.setattr(server,'scan_link',fake_scan)
    await server.perform_scan(['search-1'])
    assert search['lastReport']['newIds']==[]
    server.job.update(busy=True,stop=False)
    await server.perform_scan(['search-1'])
    assert search['lastReport']['newIds']==[car_b['id']]
    assert search['lastReport']['changedIds']==[car_a['id']]
    previous_ids=server.state['snapshots']['link-1']['ids'].copy()
    server.job.update(busy=True,stop=False)
    await server.perform_scan(['search-1'])
    assert server.state['snapshots']['link-1']['ids']==previous_ids
    assert 'Blocked by website' in server.state['snapshots']['link-1']['error']
