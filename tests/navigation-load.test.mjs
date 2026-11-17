import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const RELEASE='142.34';
const ASSET_VERSION='14221';
const port=19000+(process.pid%700);
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let serverOutput='';
child.stdout.on('data',d=>serverOutput+=d);
child.stderr.on('data',d=>serverOutput+=d);

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitForServer(){
  for(let i=0;i<60;i++){
    try{const r=await fetch(`${base}/`,{redirect:'manual'});if(r.status===200)return}catch{}
    if(child.exitCode!==null)throw new Error(`DriveHub server exited early:\n${serverOutput}`);
    await sleep(50);
  }
  throw new Error(`DriveHub server did not start:\n${serverOutput}`);
}
function sameOriginAssetUrls(html,documentUrl){
  const urls=new Set();
  const re=/(?:src|href)="([^"]+)"/g;
  let m;
  while((m=re.exec(html))){
    const raw=m[1];
    if(!raw||raw.startsWith('#')||raw.startsWith('data:')||raw.startsWith('blob:')||raw.startsWith('mailto:'))continue;
    let url;try{url=new URL(raw,documentUrl)}catch{continue}
    if(url.origin!==new URL(base).origin)continue;
    if(url.pathname.startsWith('/car-search-app/'))continue; // Remote tool is tested with a local fake upstream.
    urls.add(url.href);
  }
  return [...urls];
}
async function get(route,opts={}){return fetch(`${base}${route}`,{redirect:'manual',...opts})}

try{
  await waitForServer();

  // Cold entry + refresh contract: every primary route must be directly loadable,
  // uncached at the document level, and identify the exact release being served.
  for(const route of ['/','/index.html','/garage/','/valuation/','/roads/','/search/']){
    const r=await get(route);
    assert.equal(r.status,200,`${route} cold-loads directly`);
    assert.equal(r.headers.get('x-drivehub-version'),RELEASE,`${route} exposes the current release`);
    assert.match(r.headers.get('cache-control')||'',/no-store|no-cache/,`${route} documents are refresh-safe`);
    const html=await r.text();
    assert.match(html,/<html|<!doctype/i,`${route} returns HTML`);
    for(const asset of sameOriginAssetUrls(html,new URL(route,base).href)){
      const a=await fetch(asset,{redirect:'manual'});
      assert.equal(a.status,200,`${route} same-origin asset loads: ${new URL(asset).pathname}`);
    }
  }

  // Canonical path handling protects bookmarked / refreshed tool URLs.
  for(const route of ['/garage','/valuation','/roads','/search']){
    const r=await get(route);
    assert.equal(r.status,308,`${route} canonicalises to its trailing-slash route`);
    assert.equal(r.headers.get('location'),`${route}/`);
    assert.match(r.headers.get('cache-control')||'',/no-store/,`${route} redirect is not cached`);
  }

  // Versioned assets can be immutable; shell documents/service worker cannot.
  for(const route of [`/shared/public/drivehub-chrome.js?v=${ASSET_VERSION}`,`/roads/app.js?v=${ASSET_VERSION}`,`/valuation/app.js?v=${ASSET_VERSION}`,`/garage/js/app.bundle.js?v=${ASSET_VERSION}`]){
    const r=await get(route);
    assert.equal(r.status,200,`${route} loads`);
    assert.match(r.headers.get('cache-control')||'',/immutable/,`${route} uses immutable versioned caching`);
  }
  {
    const r=await get(`/garage/service-worker.js?v=${ASSET_VERSION}`);
    assert.equal(r.status,200,'MyGarage service worker loads');
    assert.match(r.headers.get('cache-control')||'',/no-store|no-cache/,'service worker is always revalidated');
  }

  // Hosted Home must use the lightweight gateway, not the multi-megabyte
  // single-file/offline launcher that embeds all three tools.
  {
    const r=await get('/');
    const html=await r.text();
    assert.doesNotMatch(html,/DRIVEHUB_TOOLS\s*=/,'hosted Home does not ship embedded copies of every tool');
    assert.ok(Buffer.byteLength(html,'utf8')<100000,'hosted Home stays a lightweight shell');
  }

  // Home cards must be useful before gateway JavaScript runs. This prevents a
  // partial JS/load failure from turning the main navigation into dead links.
  const gateway=fs.readFileSync(path.join(ROOT,'gateway/public/index.html'),'utf8');
  for(const route of ['/garage/','/valuation/','/roads/','/search/'])assert.match(gateway,new RegExp(`href="${route.replaceAll('/','\\/')}"`),`gateway has a real ${route} fallback href`);
  const built=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  for(const [tool,route] of [['garage','/garage/'],['valuation','/valuation/'],['roads','/roads/'],['search','/search/']]){
    assert.match(built,new RegExp(`href="${route.replaceAll('/','\\/')}"[^>]*data-tool="${tool}"`),`built launcher keeps hosted fallback href for ${tool}`);
  }
  assert.match(built,/DRIVEHUB_IS_HOSTED=\/\^https\?:\$\//,'hosted launcher remains separate from standalone srcdoc mode');
  assert.match(built,/DRIVEHUB_TOOLS\s*=/,'standalone file launcher still embeds all tools for offline use');
  assert.match(built,/window\.addEventListener\('popstate'/,'standalone launcher handles Back/Forward navigation');

  // BFCache and orientation restoration are explicit. Back from a tool may
  // restore Home without re-running its script, so continuity must refresh on pageshow.
  const gatewayJs=fs.readFileSync(path.join(ROOT,'gateway/public/app.js'),'utf8');
  assert.match(gatewayJs,/window\.addEventListener\('pageshow',[\s\S]*event\.persisted[\s\S]*refreshGateway/,'Home refreshes continuity after BFCache restore');
  assert.match(gatewayJs,/syncGarageCount\(\)[\s\S]*syncValuationCount\(\)[\s\S]*syncRoadCacheCount\(\)/,'Home refreshes all local continuity counts together');
  const sharedJs=fs.readFileSync(path.join(ROOT,'shared/public/drivehub-chrome.js'),'utf8');
  assert.match(sharedJs,/window\.addEventListener\('pageshow',[\s\S]*syncDesktopNav/,'desktop navigation resynchronises after BFCache restore');
  assert.match(sharedJs,/window\.addEventListener\('orientationchange',[\s\S]*syncDesktopNav/,'desktop navigation resynchronises after orientation changes');

  // Wide-tablet breakpoint contract: CSS and Road Finder runtime must switch at exactly 900px.
  const sharedCss=fs.readFileSync(path.join(ROOT,'shared/public/drivehub-chrome.css'),'utf8');
  const roadCss=fs.readFileSync(path.join(ROOT,'tools/road-finder/public/style.css'),'utf8');
  const roadJs=fs.readFileSync(path.join(ROOT,'tools/road-finder/public/app.js'),'utf8');
  assert.match(sharedCss,/@media \(min-width:900px\)/,'shared desktop chrome begins at 900px');
  assert.match(roadCss,/@media \(min-width:900px\)/,'Road Finder desktop layout begins at 900px');
  assert.match(roadJs,/const MOBILE_BREAKPOINT = 899;/,'Road Finder runtime switches at the same 900px boundary');
  assert.match(roadJs,/window\.addEventListener\('resize',[\s\S]*setPanelState\(\{\}, 'resize-repair'\)/,'Road Finder repairs layout after viewport changes');
  assert.match(roadJs,/window\.addEventListener\('orientationchange',[\s\S]*orientation-repair/,'Road Finder repairs map/panels after orientation changes');

  // MyGarage had drifted two releases behind. Lock shell, SW and registrations together.
  const garageIndex=fs.readFileSync(path.join(ROOT,'tools/my-garage/public/index.html'),'utf8');
  const garageSw=fs.readFileSync(path.join(ROOT,'tools/my-garage/public/service-worker.js'),'utf8');
  const garageApp=fs.readFileSync(path.join(ROOT,'tools/my-garage/public/js/app.bundle.js'),'utf8');
  assert.doesNotMatch(`${garageIndex}\n${garageSw}\n${garageApp}`,/14214|14216/,'active MyGarage shell contains no stale v142.14/v142.16 cache markers');
  assert.match(garageSw,new RegExp(`drivehub-mygarage-v${ASSET_VERSION}`),'MyGarage cache name matches the release');
  assert.match(garageApp,new RegExp(`service-worker\\.js\\?v=${ASSET_VERSION}`),'MyGarage service-worker registration matches the release');

  // Road Finder must fail visibly rather than crashing to a blank page if its
  // external mapping library is unavailable on a cold load.
  assert.match(roadJs,/typeof window\.L === 'undefined'[\s\S]*Map controls didn’t load[\s\S]*roadFinderBootRetry/,'Road Finder has a recoverable mapping-library boot failure state');

  const status=await get('/api/integrations/status');
  assert.equal(status.status,200,'hosted integration readiness endpoint stays available');
  assert.equal(status.headers.get('content-type')?.includes('application/json'),true,'integration readiness returns JSON');

  const missing=await get('/definitely-not-a-drivehub-route');
  assert.equal(missing.status,404,'unknown routes fail explicitly rather than returning a blank shell');

  console.log('Navigation/load regression checks passed');
} finally {
  child.kill('SIGTERM');
}
