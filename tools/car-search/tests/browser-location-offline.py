"""Offline Chromium UI test: real Car Search card -> location modal with regional zoom."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
app=ROOT/'tools/car-search/legacy/public'
html=(app/'dashboard.html').read_text()
html=re.sub(r'<link[^>]*https?://[^>]*>','',html)
html=re.sub(r'<script[^>]*src=[^>]*></script>','',html)
html=html.replace('</head>','<style>'+ (app/'styles.css').read_text()+'\n'+(app/'drivehub-theme.css').read_text()+'</style></head>')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1280,'height':850})
 page.set_content(html,wait_until='domcontentloaded')
 page.evaluate('''() => {
   window.__requested=[];
   window.L={
    map:()=>({setView:(coords,zoom)=>{window.__mapView={coords,zoom};return this},invalidateSize:()=>{}}),
    tileLayer:()=>({addTo:()=>{}}),
    marker:()=>({addTo(){return this},bindPopup(){return this},openPopup(){return this},remove(){}})
   };
   window.fetch=async(url,options={})=>{
    window.__requested.push(url);
    const data=String(url).endsWith('/api/auth')?{authenticated:true,passwordRequired:false}:
      String(url).endsWith('/api/state')?{state:{version:1,searches:[],listings:{one:{id:'one',site:'autotrader',title:'Porsche 911 Carrera 4S',url:'https://www.autotrader.co.uk/car-details/202611027550673',price:27000,year:2006,mileage:70000,location:'Manchester',saved:true,firstSeen:'2026-11-16T12:00:00Z',colour:'blue',colourSource:'photo'}},snapshots:{},hiddenBySearch:{},manualDuplicates:{},options:{pageDepth:3}},revision:1,job:{busy:false}}:
      String(url).endsWith('/api/map/locations')?{locations:[{location:'Manchester',point:{lat:53.4808,lng:-2.2426,label:'Manchester',precision:'town'}}]}:
      {status:'ok',state:{searches:[],listings:{},snapshots:{}},revision:1};
    return {ok:true,status:200,json:async()=>data};
   };
 }''')
 page.add_script_tag(content=(app/'dashboard.js').read_text())
 page.evaluate('switchView("saved")')
 pin=page.locator('.car-location-link')
 pin.wait_for(timeout=3000)
 assert 'Manchester' in pin.inner_text(),pin.inner_text()
 assert page.locator('.listing-card').count()==1
 assert 'photo estimate' in page.locator('.car-specs').inner_text().lower()
 pin.click()
 assert page.locator('#locationDialog').evaluate('(el)=>el.open')
 assert not page.locator('#carDialog').evaluate('(el)=>el.open')
 page.wait_for_function('window.__mapView?.zoom===7',timeout=3000)
 assert page.locator('#locationMapDescription').inner_text().startswith('Showing the area around Manchester')
 assert '/api/map/locations' in page.evaluate('window.__requested')
 page.screenshot(path='/mnt/data/v14226-location-modal.png')
 page.locator('#closeLocationDialog').click()
 assert not page.locator('#locationDialog').evaluate('(el)=>el.open')
 print('Location pin, map dialog, geocoding request, regional zoom, colour provenance and close behaviour passed')
 b.close()
