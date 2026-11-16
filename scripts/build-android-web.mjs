import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=path.join(ROOT,'android-shell','web');
const serverSource=fs.readFileSync(path.join(ROOT,'server.js'),'utf8');
const releaseMatch=serverSource.match(/DRIVEHUB_VERSION='([^']+)'/);
if(!releaseMatch)throw new Error('Could not determine DriveHub release from server.js');
const DRIVEHUB_VERSION=releaseMatch[1];
const VERSION=(DRIVEHUB_VERSION.split('.').length===2?`${DRIVEHUB_VERSION}.0`:DRIVEHUB_VERSION);
const DEFAULT_ORIGIN='https://drive-hub-production-6748.up.railway.app';
const API_ORIGIN=String(process.env.DRIVEHUB_APP_ORIGIN||DEFAULT_ORIGIN).replace(/\/+$/,'');

function copyDir(from,to){
  fs.mkdirSync(to,{recursive:true});
  for(const entry of fs.readdirSync(from,{withFileTypes:true})){
    const src=path.join(from,entry.name),dst=path.join(to,entry.name);
    if(entry.isDirectory())copyDir(src,dst);else fs.copyFileSync(src,dst);
  }
}
function injectConfig(file){
  let html=fs.readFileSync(file,'utf8');
  const meta=`<meta name="drivehub-api-origin" content="${API_ORIGIN}">`;
  if(/<meta name="drivehub-api-origin"/i.test(html))html=html.replace(/<meta name="drivehub-api-origin"[^>]*>/i,meta);
  else html=html.replace(/<head(.*?)>/i,match=>`${match}\n  ${meta}`);
  fs.writeFileSync(file,html);
}

fs.rmSync(OUT,{recursive:true,force:true});
fs.mkdirSync(OUT,{recursive:true});
copyDir(path.join(ROOT,'gateway','public'),OUT);
copyDir(path.join(ROOT,'shared','public'),path.join(OUT,'shared','public'));
copyDir(path.join(ROOT,'tools','my-garage','public'),path.join(OUT,'garage'));
copyDir(path.join(ROOT,'tools','valuation','public'),path.join(OUT,'valuation'));
copyDir(path.join(ROOT,'tools','road-finder','public'),path.join(OUT,'roads'));
copyDir(path.join(ROOT,'tools','car-search','public'),path.join(OUT,'search'));
for(const file of [path.join(OUT,'index.html'),path.join(OUT,'garage','index.html'),path.join(OUT,'valuation','index.html'),path.join(OUT,'roads','index.html'),path.join(OUT,'search','index.html')])injectConfig(file);
fs.writeFileSync(path.join(OUT,'drivehub-build.json'),JSON.stringify({webVersion:VERSION,driveHubVersion:DRIVEHUB_VERSION,apiOrigin:API_ORIGIN,builtAt:new Date().toISOString()},null,2));
console.log(`Prepared Android fallback/OTA web bundle v${VERSION} for ${API_ORIGIN}`);
