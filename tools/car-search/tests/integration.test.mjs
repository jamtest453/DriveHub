import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {rewriteCarSearchScript} from '../server/proxy.js';

const upstreamPort=20500+(process.pid%2000),drivehubPort=22500+(process.pid%2000);
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
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(drivehubPort),CAR_SEARCH_HUB_URL:`http://127.0.0.1:${upstreamPort}`},stdio:['ignore','pipe','pipe']});
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
  assert.equal(status.carSearch.configured,true);assert.equal(status.carSearch.mode,'same-origin-proxy');
  r=await get('/api/state');assert.equal(r.status,404,'Car Search must not intercept DriveHub API paths');
  assert.ok(rewriteCarSearchScript("fetch(url,{credentials:'same-origin'").includes("fetch('/car-search-app' + url"));
  console.log('Car Search tool, same-origin proxy, cookies, CSP, live status and API isolation passed.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve=>upstream.close(resolve));
}
