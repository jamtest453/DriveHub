import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const channelsPath=path.join(ROOT,'app-updates','channels.json');
const testBundle=path.join(ROOT,'app-updates','bundles','drivehub-test-142.22.0.zip');
const originalChannels=fs.readFileSync(channelsPath,'utf8');
const port=19700+(process.pid%700);
const base=`http://127.0.0.1:${port}`;

const runtime=fs.readFileSync(path.join(ROOT,'shared/public/drivehub-runtime.js'),'utf8');
assert.match(runtime,/apiUrl\(path\)/,'shared runtime exposes hosted API URL resolution');
assert.match(runtime,/notifyAppReady/,'shared runtime reports healthy OTA boots');
assert.match(runtime,/const confirmHealthyBoot=\(\)=>setTimeout\(\(\)=>notifyAppReady\(\),1200\)/,'OTA readiness has a successful-load grace period');
assert.match(runtime,/window\.addEventListener\('load',confirmHealthyBoot/,'OTA readiness waits for the page load event');
assert.match(runtime,/unhandledrejection[\s\S]*bootFailed=true/,'uncaught native boot failures prevent an OTA bundle being acknowledged');
assert.match(runtime,/CapacitorUpdater/,'shared runtime bridges the native updater');
assert.match(runtime,/hasHostedBackend/,'shared runtime distinguishes a local native shell from a missing backend');

const capConfig=fs.readFileSync(path.join(ROOT,'android-shell/capacitor.config.ts'),'utf8');
assert.match(capConfig,/appId:'app\.drivehub\.mobile'/,'Android shell has a stable package id placeholder');
assert.match(capConfig,/webDir:'web'/,'Android shell ships a local fallback web bundle');
assert.match(capConfig,/autoUpdate:'atBackground'/,'Android updater downloads and applies web releases outside Play');
assert.match(capConfig,/version:'142\.26\.0'/,'native shell identifies the bundled web baseline to avoid downloading the same release again');
assert.match(capConfig,/DRIVEHUB_OTA_CHANNEL/,'native builds can target stable or beta OTA channels');
assert.match(capConfig,/\/api\/app\/update\?channel=\$\{otaChannel\}/,'Android shell uses DriveHub self-hosted channel-aware update endpoint');
assert.match(capConfig,/statsUrl:''/,'self-hosted updater does not send Capgo usage stats');

const build=spawnSync(process.execPath,['scripts/build-android-web.mjs'],{cwd:ROOT,encoding:'utf8'});
assert.equal(build.status,0,`Android web bundle builds: ${build.stderr||build.stdout}`);
for(const route of ['index.html','garage/index.html','valuation/index.html','roads/index.html']){
  const html=fs.readFileSync(path.join(ROOT,'android-shell/web',route),'utf8');
  assert.match(html,/meta name="drivehub-api-origin" content="https:\/\/drivehub-production-7aa4f6f5\.up\.railway\.app"/i,`${route} carries the hosted API origin into the local native bundle`);
  assert.match(html,route==='index.html'?/drivehub-runtime\.js\?v=14227/:/drivehub-runtime\.js\?v=14221/,`${route} loads the native-aware DriveHub runtime`);
}
assert.equal(fs.existsSync(path.join(ROOT,'android-shell/web/garage/js/app.bundle.js')),true,'Android fallback contains the actual MyGarage application bundle');
assert.ok(fs.existsSync(path.join(ROOT,'android-shell/web/search/index.html')),'Android fallback contains the Car Search tool shell');

// Web requests inside the native shell must be capable of targeting Railway,
// while browser deployments retain relative same-origin URLs.
const gateway=fs.readFileSync(path.join(ROOT,'gateway/public/app.js'),'utf8');
const valuation=fs.readFileSync(path.join(ROOT,'tools/valuation/public/app.js'),'utf8');
const garage=fs.readFileSync(path.join(ROOT,'tools/my-garage/public/js/app.bundle.js'),'utf8');
const roads=fs.readFileSync(path.join(ROOT,'tools/road-finder/public/app.js'),'utf8');
for(const [name,source] of [['Home',gateway],['Valuation',valuation],['MyGarage',garage],['Road Finder',roads]])assert.match(source,/DriveHubRuntime/,`${name} uses the shared native/web runtime`);
assert.match(garage,/if\(!window\.DriveHubRuntime\?\.isNative&&\/\^https\?:\$\/\.test\(location\.protocol\)&&'serviceWorker'in navigator\)/,'native MyGarage does not install the browser service worker over OTA assets');

const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(){for(let i=0;i<60;i++){try{const r=await fetch(`${base}/`);if(r.ok)return}catch{}if(child.exitCode!==null)throw new Error(output);await sleep(50)}throw new Error(`server did not start: ${output}`)}
async function update(body,channel='stable'){return fetch(`${base}/api/app/update?channel=${channel}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})}

try{
  await wait();
  let r=await update({platform:'android',version_code:'1',version_name:'builtin'});
  assert.equal(r.status,200,'disabled OTA channel answers safely');
  assert.equal((await r.json()).error,'no_new_version_available','disabled OTA channel never offers an incomplete bundle');

  fs.mkdirSync(path.dirname(testBundle),{recursive:true});
  fs.writeFileSync(testBundle,'DriveHub updater endpoint test bundle only');
  fs.writeFileSync(channelsPath,JSON.stringify({
    stable:{version:'142.22.0',file:path.basename(testBundle),checksum:'test-checksum',minimumNativeVersionCode:1,sessionKey:'test-session-key',enabled:true},
    beta:{version:'142.22.0',file:'',checksum:'',minimumNativeVersionCode:1,sessionKey:'',enabled:false}
  },null,2));

  r=await update({platform:'android',version_code:'1',version_name:'builtin'});
  let data=await r.json();
  assert.equal(data.version,'142.22.0','older native bundle receives promoted web version');
  assert.equal(data.url,`${base}/app-updates/bundles/${path.basename(testBundle)}`,'update response contains an absolute self-hosted bundle URL');
  assert.equal(data.checksum,'test-checksum','update response carries the integrity checksum');
  assert.equal(data.session_key,'test-session-key','encrypted OTA metadata forwards the Capgo session key when present');

  const bundleResponse=await fetch(data.url);
  assert.equal(bundleResponse.status,200,'published OTA bundle is downloadable');
  assert.equal(bundleResponse.headers.get('access-control-allow-origin'),'*','OTA bundles are CORS-downloadable by the native updater');
  assert.match(bundleResponse.headers.get('cache-control')||'',/immutable/,'published versioned OTA bundles can be cached immutably');

  r=await update({platform:'android',version_code:'1',version_name:'142.22.0'});
  data=await r.json();
  assert.equal(data.error,'no_new_version_available','current web bundle is not re-downloaded');

  r=await update({platform:'android',version_code:'1',version_name:'142.27.0'});
  data=await r.json();
  assert.equal(data.error,'no_new_version_available','a device on a newer web bundle is never downgraded');

  const preflight=await fetch(`${base}/api/app/update?channel=stable`,{method:'OPTIONS',headers:{origin:'https://localhost','access-control-request-method':'POST'}});
  assert.equal(preflight.status,204,'OTA endpoint supports CORS preflight');
  assert.equal(preflight.headers.get('access-control-allow-origin'),'*','OTA preflight allows native/local web origins');

  fs.writeFileSync(channelsPath,JSON.stringify({stable:{version:'142.22.0',file:'../outside.zip',checksum:'test-checksum',minimumNativeVersionCode:1,enabled:true}},null,2));
  r=await update({platform:'android',version_code:'1',version_name:'builtin'});
  data=await r.json();
  assert.equal(data.error,'no_new_version_available','OTA metadata cannot escape the published bundle directory');

  fs.writeFileSync(channelsPath,JSON.stringify({stable:{version:'142.22.0',file:path.basename(testBundle),checksum:'test-checksum',minimumNativeVersionCode:2,sessionKey:'',enabled:true}},null,2));
  r=await update({platform:'android',version_code:'1',version_name:'builtin'});
  data=await r.json();
  assert.equal(data.error,'native_update_required','web release can require a newer Play Store shell');
  assert.equal(data.breaking,true,'native incompatibility is explicit to the updater');

  console.log('Android shell / OTA update checks passed');
} finally {
  child.kill('SIGTERM');
  fs.writeFileSync(channelsPath,originalChannels);
  try{fs.unlinkSync(testBundle)}catch{}
}
