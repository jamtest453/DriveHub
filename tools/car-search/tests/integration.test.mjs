import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {rewriteCarSearchScript} from '../server/proxy.js';

const upstreamPort=3213,drivehubPort=22500+(process.pid%2000);
let hits=[];
const upstream=http.createServer(async (req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const body=[];for await(const chunk of req)body.push(chunk);
  hits.push({path,method:req.method,cookie:req.headers.cookie||'',origin:req.headers.origin,host:req.headers.host,body:Buffer.concat(body).toString('utf8')});
  if(path==='/dashboard.js'){
    res.setHeader('content-type','text/javascript');
    res.end("const x=await fetch(url,{credentials:'same-origin'});fetch('/api/facebook/connection/preview');window.location.href = '/api/export';");return;
  }
  if(path==='/api/login'){
    res.setHeader('set-cookie',['carhub_session=testing.123; HttpOnly; Path=/; SameSite=Strict',
      'other=ignore; Path=/; HttpOnly']);
    res.setHeader('content-type','application/json');res.end('{"ok":true}');return;
  }
  if(path==='/api/auth'){
    res.setHeader('content-type','application/json');res.end('{"authenticated":false,"passwordRequired":true}');return;
  }
  if(path==='/'){
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html><body><script src="dashboard.js"></script>Car search upstream</body></html>');return;
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({url:req.url,method:req.method}));
});
await new Promise(resolve=>upstream.listen(upstreamPort,'127.0.0.1',resolve));
const root=new URL('../../../',import.meta.url);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(drivehubPort),CAR_SEARCH_HUB_URL:'https://wrong-host.example'},stdio:['ignore','pipe','pipe']});
let output='';child.stderr.on('data',d=>output+=String(d));child.stdout.on('data',d=>output+=String(d));
const base=`http://127.0.0.1:${drivehubPort}`;
async function get(path,options={}){return fetch(base+path,{redirect:'manual',...options})}
try{
  let started=false;for(let i=0;i<80;i++){
    try{const r=await get('/');if(r.ok){started=true;break}}catch{}
    if(child.exitCode!==null)break;
    await sleep(50);
  }
  assert.ok(started,output||'DriveHub did not start');
  let r=await get('/');assert.equal(r.status,200);
  const home=await r.text();assert.match(home,/Car Search/);assert.match(home,/href="\/search\/"/);
  r=await get('/search');assert.equal(r.status,308);assert.equal(r.headers.get('location'),'/search/');
  r=await get('/search/');assert.equal(r.status,200);const html=await r.text();
  assert.match(html,/<iframe[^>]+src="\/car-search-app\/"/);
  // Regression: the previous release mistakenly served the native Node Car Search CSS
  // for the outer tool shell. Missing .search-shell/#search-frame styles caused
  // the iframe to render at the browser-default 300 × 150 pixels.
  const searchCss=await get('/search/styles.css?v=14226');
  assert.equal(searchCss.status,200,'Car Search shell stylesheet is served');
  const shellCss=await searchCss.text();
  assert.match(shellCss,/\.search-shell\s*\{[\s\S]*?height:\s*100dvh/s,'Car Search shell spans the full viewport');
  assert.match(shellCss,/#search-frame\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%/s,'embedded scanner iframe fills the tool workspace');
  assert.match(shellCss,/\.search-workspace\s*\{[\s\S]*?min-height:\s*0/s,'workspace can grow and shrink inside the viewport');
  assert.match(html,/drivehub-chrome\.js\?v=14226/,'Car Search renders the same global header as other tools');
  const shellJs=await get('/search/app.js?v=14226');
  assert.equal(shellJs.status,200);
  assert.match(await shellJs.text(),/contentDocument\?\.readyState/,'Car Search removes its loader even if the iframe loads before JavaScript initialises');
  assert.match(html,/id="search-frame"[^>]+src="\/car-search-app\/"/,'full-size original Car Search still embedded');
  const originalPage=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../legacy/public/dashboard.html',import.meta.url),'utf8'));
  const originalStyles=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../legacy/public/drivehub-theme.css',import.meta.url),'utf8'));
  assert.match(originalPage,/href="drivehub-theme\.css"/,'restored Python dashboard loads the DriveHub theme');
  assert.match(originalPage,/id="locationDialog"/,'Car Search has a dedicated map modal for result-card locations');
  assert.match(originalPage,/drivehub-chrome\.js\?v=14226/,'direct Car Search tabs also get the shared header');
  assert.match(originalPage,/id="locationMiniMap"/,'location modal has a Leaflet map container');
  assert.match(originalStyles,/Caprasimo/,'Car Search uses the same heading font as DriveHub');
  assert.match(originalStyles,/Figtree/,'Car Search uses the same body font as DriveHub');
  assert.match(originalStyles,/car-location-link/,'advert cards expose a clickable location pin');
  assert.match(originalPage,/CAR SEARCH <span>\/<\/span>/,'Car Search breadcrumb no longer incorrectly says MyGarage');
  assert.match(r.headers.get('x-frame-options')||'',/DENY/);
  r=await get('/search/app.js?v=14222');assert.equal(r.status,200);
  r=await get('/search/styles.css?v=14222');assert.equal(r.status,200);

  r=await get('/car-search-app/');assert.equal(r.status,200);
  assert.match(await r.text(),/Car search upstream/);
  assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.match(r.headers.get('content-security-policy')||'',/frame-ancestors 'self'/);
  assert.match(r.headers.get('content-security-policy')||'',/cdn\.jsdelivr\.net/);
  assert.match(r.headers.get('cache-control')||'',/no-store/);

  r=await get('/car-search-app/dashboard.js?v=abc');assert.equal(r.status,200);
  const script=await r.text();
  assert.match(script,/fetch\('\/car-search-app' \+ url/);
  assert.match(script,/fetch\('\/car-search-app\/api\/facebook\/connection\/preview'/);
  assert.match(script,/location.href = '\/car-search-app\/api\/export'/);
  assert.match(r.headers.get('cache-control')||'',/no-store/);

  r=await get('/car-search-app/api/auth',{headers:{cookie:'drivehub_private=must-not-leak; carhub_session=sent-to-carhub'}});
  assert.equal(r.status,200);assert.equal((await r.json()).passwordRequired,true);
  assert.equal(hits.at(-1).cookie,'carhub_session=sent-to-carhub');

  r=await get('/car-search-app/api/login',{method:'POST',headers:{'content-type':'application/json',
    origin:base,cookie:'anotherapp=secret; carhub_session=good'},body:'{"password":"some_password"}'});
  assert.equal(r.status,200,await r.text());
  assert.equal(hits.at(-1).body,'{"password":"some_password"}');
  assert.equal(hits.at(-1).origin,`http://127.0.0.1:${upstreamPort}`);
  assert.equal(hits.at(-1).cookie,'carhub_session=good');
  const cookies=r.headers.getSetCookie();
  assert.equal(cookies.length,1);
  for(const cookie of cookies){
    assert.match(cookie,/Path=\/car-search-app\//);
    assert.doesNotMatch(cookie,/Path=\/(?:;|$)/);
  }
  const bad=await get('/car-search-app/api/login',{method:'POST',headers:{origin:'https://malicious.example', 'content-type':'application/json'},body:'{}'});
  assert.equal(bad.status,403);

  r=await get('/api/integrations/status');assert.equal(r.status,200);const status=await r.json();
  assert.equal(status.carSearch.configured,true);assert.equal(status.carSearch.mode,'embedded-python');
  r=await get('/api/state');assert.equal(r.status,404,'Car Search must not intercept DriveHub API paths');
  assert.ok(rewriteCarSearchScript("fetch(url,{credentials:'same-origin'").includes("fetch('/car-search-app' + url"));
  // Make sure the saved original frontend's real API paths are covered.
  const {readFile} = await import('node:fs/promises');
  const oldJs = await readFile(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
  const converted = rewriteCarSearchScript(oldJs);
  assert.match(converted,/fetch\('\/car-search-app' \+ url/);
  assert.match(converted,/fetch\('\/car-search-app\/api\/facebook\/connection\/preview'/);
  assert.match(converted,/location.href = '\/car-search-app\/api\/export'/);
  assert.doesNotMatch(converted,/fetch\(url,\{credentials:'same-origin'/);
  // The original backend and its original scan modules must be bundled.
  for(const file of ['server.py','src/scanner.py','src/facebook_connection.py',
      'src/photo_hash.py','src/ebay_api.py','src/location_map.py',
      'src/detail_enrichment.py','src/query_builder.py','public/styles.css']){
    const content=await readFile(new URL('../legacy/'+file,import.meta.url));
    assert.ok(content.length>500,'Missing original Car Search file: '+file);
  }
  console.log('Embedded Car Search proxy, cookie isolation, CSP, script rewriting and status passed.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve=>upstream.close(resolve));
}
