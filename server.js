import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream,readFileSync} from 'node:fs';
import {basename,extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleMyGarageApi,googleConfig,myGarageStatus} from './tools/my-garage/server/api.js';
import {handleValuationApi,valuationStatus} from './tools/valuation/server/api.js';
import {handleRoadFinderApi,roadFinderStatus} from './tools/road-finder/server/api.js';
import {handleNotificationRelay,notificationRelayStatus} from './tools/my-garage/server/notifications.js';
import {handleCarSearchProxy,carSearchIntegrationStatus} from './tools/car-search/server/proxy.js';

const ROOT=fileURLToPath(new URL('.',import.meta.url));
function loadLocalEnv(){try{const raw=readFileSync(join(ROOT,'.env'),'utf8');for(const line of raw.split(/\r?\n/)){const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue;const eq=trimmed.indexOf('=');if(eq<1)continue;const key=trimmed.slice(0,eq).trim();let value=trimmed.slice(eq+1).trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);if(process.env[key]===undefined)process.env[key]=value}}catch{}}
loadLocalEnv();
const DRIVEHUB_VERSION='142.35';
const PORT=Number(String(process.env.PORT||8080).trim()||8080);
const rateBuckets=new Map();let rateSweepAt=0;
function json(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data))}
function clientIp(req){return String(req.headers['cf-connecting-ip']||req.headers['x-real-ip']||req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()||'unknown'}
function fixedWindowLimit(scope,subject,max,windowMs){const now=Date.now(),windowStart=Math.floor(now/windowMs)*windowMs,key=`${scope}:${subject}:${windowStart}`,count=(rateBuckets.get(key)||0)+1;rateBuckets.set(key,count);if(now-rateSweepAt>300000){rateSweepAt=now;for(const k of rateBuckets.keys()){const start=Number(k.split(':').at(-1)||0);if(start&&start<now-172800000)rateBuckets.delete(k)}}return {allowed:count<=max,retryAfter:Math.max(1,Math.ceil((windowStart+windowMs-now)/1000))}}
function enforceRateLimits(req,res,scope,{shortMax,shortMs,dailyMax}){const ip=clientIp(req),global=fixedWindowLimit('global','all',300,60000);if(!global.allowed){json(res,429,{error:'DriveHub is receiving too many requests. Try again shortly.',code:'SERVER_BUSY'},{'retry-after':String(global.retryAfter)});return false}const short=fixedWindowLimit(`${scope}-short`,ip,shortMax,shortMs);if(!short.allowed){json(res,429,{error:'Too many requests from this device. Wait a little and try again.',code:'RATE_LIMITED'},{'retry-after':String(short.retryAfter)});return false}const daily=fixedWindowLimit(`${scope}-day`,ip,dailyMax,86400000);if(!daily.allowed){json(res,429,{error:'Daily request limit reached for this device. Try again tomorrow.',code:'DAILY_LIMIT'},{'retry-after':String(daily.retryAfter)});return false}return true}
function securityHeaders(req){const headers={'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':req.url?.startsWith('/car-search-app/')?'SAMEORIGIN':'DENY','permissions-policy':'camera=(self), microphone=(), geolocation=(self)','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleusercontent.com https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://tiles.openfreemap.org; connect-src 'self' https://accounts.google.com https://www.googleapis.com https://oauth2.googleapis.com https://nominatim.openstreetmap.org https://photon.komoot.io https://overpass.kumi.systems https://overpass.openstreetmap.fr https://z.overpass-api.de https://lz4.overpass-api.de https://router.project-osrm.org https://routing.openstreetmap.de https://tiles.openfreemap.org; frame-src 'self' https://accounts.google.com blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"};if(req.url?.startsWith('/car-search-app/')){
  headers['content-security-policy']=headers['content-security-policy']
    .replace("frame-ancestors 'none'","frame-ancestors 'self'")
    .replace("img-src 'self'","img-src 'self' https:");
};if(String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https')headers['strict-transport-security']='max-age=31536000; includeSubDomains';return headers}
function applySecurityHeaders(req,res){for(const [k,v] of Object.entries(securityHeaders(req)))res.setHeader(k,v)}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json; charset=utf-8','.zip':'application/zip'};
const STATIC=[
  {prefix:'/app-updates/bundles/',root:join(ROOT,'app-updates/bundles')},
  {prefix:'/shared/public/',root:join(ROOT,'shared/public')},
  {prefix:'/gateway/',root:join(ROOT,'gateway')},
  {prefix:'/garage/',root:join(ROOT,'tools/my-garage/public')},
  {prefix:'/valuation/',root:join(ROOT,'tools/valuation/public')},
  {prefix:'/roads/',root:join(ROOT,'tools/road-finder/public')},
  {prefix:'/search/',root:join(ROOT,'tools/car-search/public')},
  {prefix:'/',root:join(ROOT,'gateway/public')}
];
function safeRelative(pathname,prefix){let rel=pathname.slice(prefix.length);if(!rel||rel.endsWith('/'))rel+='index.html';rel=decodeURIComponent(rel);const safe=normalize(rel).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/,'');if(!safe||safe.split('/').some(x=>x==='..'||x.startsWith('.')))return null;return safe}
async function serveStatic(req,res,requestUrl){const pathname=requestUrl.pathname;for(const entry of STATIC){if(!pathname.startsWith(entry.prefix))continue;const safe=safeRelative(pathname,entry.prefix);if(!safe)break;const file=join(entry.root,safe);if(!file.startsWith(entry.root))break;try{const info=await stat(file);if(!info.isFile())continue;const ext=extname(file),lower=safe.toLowerCase(),isOtaBundle=pathname.startsWith('/app-updates/bundles/')&&ext==='.zip';let cache='public, max-age=300';if(lower==='index.html'||lower==='service-worker.js'||lower==='manifest.json')cache='no-store, no-cache, must-revalidate';else if((ext==='.js'||ext==='.css')&&requestUrl.searchParams.has('v'))cache='public, max-age=31536000, immutable';else if(isOtaBundle)cache='public, max-age=31536000, immutable';
    else if(ext==='.js'||ext==='.css')cache='no-cache';const headers={'content-type':MIME[ext]||'application/octet-stream','cache-control':cache,'x-drivehub-version':DRIVEHUB_VERSION};if(isOtaBundle)headers['access-control-allow-origin']='*';res.writeHead(200,headers);if(req.method==='HEAD')return res.end();createReadStream(file).pipe(res);return true}catch{}}
  return false
}
async function serveRootIndex(req,res){
  try{
    const file=join(ROOT,'gateway/public/index.html');
    await stat(file);
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store, no-cache, must-revalidate','x-drivehub-version':DRIVEHUB_VERSION});
    if(req.method==='HEAD')return res.end();
    createReadStream(file).pipe(res);return true
  }catch{return false}
}


async function readJsonBody(req,maxBytes=65536){
  return new Promise((resolve,reject)=>{let size=0,raw='';req.setEncoding('utf8');req.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>maxBytes){reject(new Error('BODY_TOO_LARGE'));req.destroy();return}raw+=chunk});req.on('end',()=>{if(!raw.trim())return resolve({});try{resolve(JSON.parse(raw))}catch{reject(new Error('INVALID_JSON'))}});req.on('error',reject)})
}
function publicOrigin(req){const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();const proto=forwarded||(req.socket?.encrypted?'https':'http');const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();return host?`${proto}://${host}`:''}
function semverParts(value){const m=String(value||'').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null}
function semverGte(a,b){const left=semverParts(a),right=semverParts(b);if(!left||!right)return false;for(let i=0;i<3;i++){if(left[i]>right[i])return true;if(left[i]<right[i])return false}return true}
async function handleAppUpdate(req,res,requestUrl){
  const cors={'access-control-allow-origin':'*'};
  if(req.method==='OPTIONS'){res.writeHead(204,{...cors,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'86400'});return res.end()}
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed',message:'POST required'},{...cors,allow:'POST, OPTIONS'});
  let body;try{body=await readJsonBody(req)}catch(err){return json(res,400,{error:err?.message==='BODY_TOO_LARGE'?'request_too_large':'invalid_request',message:'Invalid update request'},cors)}
  const requestedChannel=String(requestUrl.searchParams.get('channel')||'stable').toLowerCase();
  const channel=['stable','beta'].includes(requestedChannel)?requestedChannel:'stable';
  let channels;try{channels=JSON.parse(await readFile(join(ROOT,'app-updates/channels.json'),'utf8'))}catch{return json(res,200,{error:'no_new_version_available',message:'No update is currently published.'},cors)}
  const release=channels?.[channel];
  if(!release?.enabled||!release?.version||!release?.file||!release?.checksum)return json(res,200,{error:'no_new_version_available',message:'No new version available'},cors);
  if(basename(String(release.file))!==String(release.file))return json(res,200,{error:'no_new_version_available',message:'Published update metadata is invalid.'},cors);
  const nativeCode=Number(body?.version_code||1),minimumNative=Number(release.minimumNativeVersionCode||1);
  if(nativeCode<minimumNative)return json(res,200,{error:'native_update_required',message:'This DriveHub update needs a newer Android app from Google Play.',breaking:true},cors);
  const current=String(body?.version_name||'').trim();
  if(current===String(release.version)||semverGte(current,String(release.version)))return json(res,200,{error:'no_new_version_available',message:'No new version available'},cors);
  const bundleFile=join(ROOT,'app-updates/bundles',release.file);
  try{const info=await stat(bundleFile);if(!info.isFile())throw new Error()}catch{return json(res,200,{error:'no_new_version_available',message:'Published update bundle is not available.'},cors)}
  const origin=publicOrigin(req);if(!origin)return json(res,503,{error:'update_origin_unavailable',message:'DriveHub could not build the update URL.'},cors);
  const payload={version:String(release.version),url:new URL(`/app-updates/bundles/${encodeURIComponent(release.file)}`,origin).href,checksum:String(release.checksum)};
  if(release.sessionKey)payload.session_key=String(release.sessionKey);
  return json(res,200,payload,cors)
}

async function handler(req,res){applySecurityHeaders(req,res);try{const requestUrl=new URL(req.url,`http://${req.headers.host||'localhost'}`),pathname=requestUrl.pathname;
  if((pathname==='/'||pathname==='/index.html')&&await serveRootIndex(req,res))return;
  if(pathname==='/garage'||pathname==='/valuation'||pathname==='/roads'||pathname==='/search'){res.writeHead(308,{location:`${pathname}/`,'cache-control':'no-store'});return res.end()}
  if(pathname.startsWith('/car-search-app')){if(await handleCarSearchProxy(req,res,requestUrl))return}
  if(pathname==='/api/vehicle'){if(!enforceRateLimits(req,res,'vehicle',{shortMax:30,shortMs:600000,dailyMax:120}))return;return handleMyGarageApi(req,res,pathname)}
  if(pathname==='/api/valuation'){if(!enforceRateLimits(req,res,'valuation',{shortMax:10,shortMs:600000,dailyMax:50}))return;return handleValuationApi(req,res,pathname,requestUrl)}
  if(pathname==='/api/ebay/account-deletion')return handleValuationApi(req,res,pathname,requestUrl);
  if(pathname==='/api/google-config')return handleMyGarageApi(req,res,pathname);
  if(pathname==='/api/integrations/status')return json(res,200,{...myGarageStatus(),...valuationStatus(),...roadFinderStatus(),...notificationRelayStatus(),...carSearchIntegrationStatus()});
  if(pathname==='/api/app/update')return handleAppUpdate(req,res,requestUrl);
  if(pathname.startsWith('/api/notifications/')){if(!enforceRateLimits(req,res,'notifications',{shortMax:20,shortMs:600000,dailyMax:120}))return;const handled=await handleNotificationRelay(req,res,pathname);if(handled!==false)return}
  if(pathname.startsWith('/api/roads/')){if(pathname==='/api/roads/a2b'&&!enforceRateLimits(req,res,'roads-route',{shortMax:30,shortMs:600000,dailyMax:180}))return;const handled=await handleRoadFinderApi(req,res,pathname,requestUrl);if(handled)return}
  if(pathname.startsWith('/api/'))return json(res,404,{error:'API endpoint not found'});
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end()}
  if(await serveStatic(req,res,requestUrl))return;
  res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found');
 }catch(err){console.error('DriveHub request failed',err);if(!res.headersSent)json(res,500,{error:'DriveHub request failed'})}}
http.createServer(handler).listen(PORT,()=>console.log(`DriveHub v${DRIVEHUB_VERSION} running at http://localhost:${PORT}`));
