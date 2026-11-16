"""Render the real DriveHub shared header on each tool using inlined HTML/CSS.

Chromium's sandbox here disallows navigation to local ports, so this tests
layout and interaction without attempting network navigation.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
chrome_css=(ROOT/'shared/public/drivehub-chrome.css').read_text()
chrome_js=(ROOT/'shared/public/drivehub-chrome.js').read_text()
pages={
 'home':('gateway/public/index.html','gateway/public/styles.css',''),
 'garage':('tools/my-garage/public/index.html','tools/my-garage/public/css/styles.css','garage'),
 'valuation':('tools/valuation/public/index.html','tools/valuation/public/styles.css','valuation'),
 'roads':('tools/road-finder/public/index.html','tools/road-finder/public/style.css','roads'),
 'search':('tools/car-search/public/index.html','tools/car-search/public/styles.css','search'),
}
with sync_playwright() as playwright:
 browser=playwright.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for width,height in [(1440,900),(390,844),(820,1050)]:
  for name,(markup,style,tool) in pages.items():
   page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
   text=(ROOT/markup).read_text()
   body=re.search(r'<body[^>]*>(.*?)</body>',text,re.S|re.I).group(1)
   body=re.sub(r'<script\b[^>]*>.*?</script>','',body,flags=re.S|re.I)
   doc='<!doctype html><html><head><style>'+((ROOT/style).read_text())+'</style><style>'+chrome_css+'</style></head><body'+(f' data-drivehub-tool="{tool}"' if tool else '')+'>'+body+'</body></html>'
   errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.set_content(doc,wait_until='domcontentloaded')
   page.add_script_tag(content=chrome_js)
   header=page.locator('.drivehub-desktop-nav')
   header.wait_for(timeout=3000)
   data=header.evaluate('''e=>({h:e.getBoundingClientRect().height,w:e.getBoundingClientRect().width,top:e.getBoundingClientRect().top,label:e.querySelector('.drivehub-desktop-nav__context strong').textContent,home:e.querySelector('button[aria-label="Go to DriveHub home"]')!==null})''')
   assert data['top']==0 and data['w']>=width-1 and data['home'] and data['h']>=60,(name,width,data)
   if name=='search':
    frame=page.locator('#search-frame');box=frame.bounding_box()
    assert box and box['width']>=width-1 and box['height']>=height-80,(width,box)
    assert box['y']>=data['h'],(name,width,data,box)
   # Actual document horizontal overflows are harmful especially on phone.
   if name in ('home','search'):
    overflow=page.evaluate('document.documentElement.scrollWidth-innerWidth')
    assert overflow<=2,(name,width,overflow)
   if width==390:
    page.screenshot(path=f'/mnt/data/v14226-{name}-offline.png',full_page=False)
   print(width,name,data, 'errors',errors[:2],flush=True)
   page.close()
 browser.close()
