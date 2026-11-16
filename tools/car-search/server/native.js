/* Car Search is now a native DriveHub tool. No standalone service or reverse proxy. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  SITES,COLOURS,MAX_CARS,now,uid,stateTemplate,siteFor,advertIdentity,
  validateFields,applyEdits,updateListing,validateSearch,providerLinks,queryImport
} from './core.js';
import {enrichRecord,scanSource} from './providers.js';

const ROOT=fileURLToPath(new URL('../public/',import.meta.url));
const DATA_FILE=process.env.CAR_SEARCH_DATA_FILE||join(process.env.DATA_DIR||(existsSync('/data')?'/data':join(ROOT,'../../.data')),'car-search-hub.json');
const PASSWORD=String(process.env.CAR_SEARCH_PASSWORD||process.env.APP_PASSWORD||'');
const SECRET=process.env.CAR_SEARCH_SESSION_SECRET||randomBytes(32).toString('hex');
const PREFIX='/car-search-app';
const MAX_BODY=8_500_000;
let state=null,revision=0,storeQueue=Promise.resolve();
const job={busy:false,stop:false,label:'',detail:'',message:'',started:null,finished:null};

async function getState(){if(state)return state;
  try{const raw=JSON.parse(await readFile(DATA_FILE,'utf8'));if(raw?.version===1&&Array.isArray(raw.searches)&&raw.listings&&typeof raw.listings==='object')state={...stateTemplate(),...raw};}
  catch(err){if(err.code!=='ENOENT')console.error('Car Search data load error',err)}
  state||=stateTemplate();return state;
}
function snapshot(){return {state,revision,job};}
async function persist(){await mkdir(dirname(DATA_FILE),{recursive:true});const tmp=DATA_FILE+'.tmp';await writeFile(tmp,JSON.stringify(state),'utf8');await rename(tmp,DATA_FILE);revision++;}
async function mutate(task){const work=storeQueue.catch(()=>{}).then(async()=>{await getState();const answer=await task(state);await persist();return answer;});storeQueue=work.catch(()=>{});return work;}
function json(res,code,payload,headers={}){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(payload));}
function fail(res,code,message){json(res,code,{detail:message});}
async function body(req,max=MAX_BODY){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw Object.assign(Error('Request exceeds size limit'),{status:413});chunks.push(chunk)}try{const obj=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error();return obj;}catch{throw Object.assign(Error('Expected a JSON object.'),{status:400})}}
function sessionToken(){const expires=String(Date.now()+30*86400000);return expires+'.'+createHmac('sha256',SECRET).update(expires).digest('hex');}
function isAuthenticated(req){if(!PASSWORD)return true;
  const token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('carhub_session='))?.split('=')[1]||'';
  const [expiry,digest]=token.split('.');if(!/^\d+$/.test(expiry||'')||!digest||Number(expiry)<Date.now())return false;
  const expected=createHmac('sha256',SECRET).update(expiry).digest('hex');
  try{return timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(expected,'hex'))}catch{return false}
}
function sessionCookie(req,value){const secure=/https/i.test(String(req.headers['x-forwarded-proto']||''))||req.socket?.encrypted;return `carhub_session=${value}; Path=${PREFIX}/; Max-Age=2592000; HttpOnly; SameSite=Strict${secure?'; Secure':''}`;}
function originAllowed(req){const origin=String(req.headers.origin||'');if(!origin)return true;try{return new URL(origin).host===req.headers.host}catch{return false}}
function checkIds(data){const ids=data.ids;if(!Array.isArray(ids)||ids.length>100||ids.some(x=>typeof x!=='string'))throw Error('Select up to 100 valid listings.');return [...new Set(ids)];}
function checkSaveId(x){if(typeof x!=='string'||!state.listings[x])throw Object.assign(Error('Car not found.'),{status:404});return state.listings[x]}
function safeImport(data){if(data.version!==1||!Array.isArray(data.searches)||typeof data.listings!=='object'||data.listings===null||typeof data.snapshots!=='object'||data.snapshots===null||data.searches.length>500||Object.keys(data.listings).length>MAX_CARS)throw Error('Invalid or excessively large Car Search backup.');return {...stateTemplate(),...data};}
async function autoEnrich(id){const row=state?.listings?.[id];if(!row||!row.saved||!siteFor(row.url))return;
  try{const details=await enrichRecord(row);await mutate(s=>{const current=s.listings[id];if(!current||!current.saved)return;
    const locks=new Set(current.manualFields||[]);let filled=0;
    for(const key of ['title','price','image','year','mileage','colour','location','description','transmission']){
      if(locks.has(key)||details[key]===undefined||details[key]===null||details[key]==='')continue;
      if(current[key]==null||current[key]===''||(key==='title'&&current.titleSource==='placeholder')){
        current[key]=details[key];if(key==='title')delete current.titleSource;if(key==='colour')current.colourSource='explicit';filled++;
      }
    }current.enrichStatus=filled?'complete':'unavailable';current.enrichedAt=now();});}
  catch(err){console.warn('Car Search detail import unavailable:',String(err.message||err).slice(0,200));await mutate(s=>{if(s.listings[id]){s.listings[id].enrichStatus='unavailable';s.listings[id].enrichError=String(err.message||err).slice(0,200)}}).catch(()=>{});}
}
async function runScan(ids){
  try{for(const sid of ids){if(job.stop)break;const search=state.searches.find(x=>x.id===sid);if(!search)continue;
      const report={newIds:[],changedIds:[],errors:[],scanned:0,sourcesChecked:0};
      for(const link of search.links||[]){if(job.stop)break;job.label=search.name;job.detail=SITES[link.site]||link.site;
        const outcome=await scanSource(link,search.filters||{});
        await mutate(s=>{const live=s.searches.find(x=>x.id===sid);if(!live)return;
          const previous=s.snapshots[link.id],prior=new Set(previous?.ids||[]),fresh=new Set();
          for(const item of outcome.items){if(Object.keys(s.listings).length>=MAX_CARS){report.errors.push('Listing storage limit reached.');break;}
            fresh.add(item.id);const result=updateListing(s,item);
            if(previous?.lastChecked&&!prior.has(item.id))report.newIds.push(item.id);
            if(result.changed)report.changedIds.push(item.id);
          }
          const kept=outcome.incomplete?[...new Set([...prior,...fresh])]:[...fresh];
          s.snapshots[link.id]={ids:kept,lastChecked:now(),incomplete:outcome.incomplete,caveat:outcome.caveat||''};
          report.scanned+=fresh.size;report.sourcesChecked++;
          if(outcome.caveat)report.errors.push(SITES[link.site]+': '+outcome.caveat);
          live.lastReport={...report,newIds:[...new Set(report.newIds)],changedIds:[...new Set(report.changedIds)]};live.lastChecked=now();
        });
      }
      job.message=`${search.name}: ${report.newIds.length} new, ${report.changedIds.length} price changes, ${report.errors.length} source warnings.`;
    }}catch(err){console.error('Car Search scan error',err);job.message='Refresh failed: '+String(err.message||err).slice(0,190)}
  finally{job.busy=false;job.stop=false;job.finished=now();job.detail='';job.label='';}
}
export function carSearchIntegrationStatus(){return {carSearch:{configured:true,mode:'native-drivehub',dataStore:DATA_FILE,passwordProtected:!!PASSWORD}};}
async function handleApi(req,res,path){
  await getState();const method=req.method;
  if(path==='/api/auth'&&method==='GET')return json(res,200,{authenticated:isAuthenticated(req),passwordRequired:!!PASSWORD,securityWarning:!PASSWORD?'Car Search has no password: configure CAR_SEARCH_PASSWORD in Railway before storing private notes.':''});
  if(path==='/api/login'&&method==='POST'){
    const data=await body(req,5000);if(PASSWORD&&data.password!==PASSWORD)return fail(res,401,'Incorrect password.');return json(res,200,{ok:true},{'set-cookie':sessionCookie(req,sessionToken())});
  }
  if(!isAuthenticated(req))return fail(res,401,'Sign in to continue.');
  if(path==='/api/logout'&&method==='POST')return json(res,200,{ok:true},{'set-cookie':`carhub_session=; Path=${PREFIX}/; Max-Age=0; HttpOnly; SameSite=Strict`});
  if(path==='/api/state'&&method==='GET')return json(res,200,snapshot());
  if(path==='/api/status'&&method==='GET')return json(res,200,{revision,job});
  if(path==='/api/export'&&method==='GET'){
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="drivehub-car-search-backup.json"','cache-control':'no-store'});return res.end(JSON.stringify(state,null,2));
  }
  if(path==='/api/import'&&method==='POST'){if(job.busy)return fail(res,409,'Finish refreshing first.');const incoming=safeImport(await body(req,15_000_000));await mutate(()=>{state=incoming});return json(res,200,snapshot());}
  if(path==='/api/searches/parse-url'&&method==='POST'){const data=await body(req,7000);return json(res,200,queryImport(data.url));}
  if(path==='/api/searches'&&method==='POST'){
    if(job.busy)return fail(res,409,'Finish refreshing first.');const data=await body(req,25000),search=validateSearch(data);
    await mutate(s=>{const prior=s.searches.find(x=>x.id===data.id);if(!prior&&s.searches.length>=500)throw Error('Search limit reached.');
      if(prior){prior.name=search.name;prior.filters=search.filters;prior.sources=search.sources;
        const links=providerLinks(search.filters,search.sources);prior.links=links.map(link=>({...link,id:prior.links.find(x=>x.site===link.site)?.id||link.id}));
      }else s.searches.push({...search,id:uid(),links:providerLinks(search.filters,search.sources),createdAt:now(),lastReport:{newIds:[],changedIds:[],errors:[]}});
    });return json(res,200,snapshot());
  }
  if(path.startsWith('/api/searches/')&&method==='DELETE'){
    if(job.busy)return fail(res,409,'Finish refreshing first.');const id=decodeURIComponent(path.slice('/api/searches/'.length));await mutate(s=>{
      const old=s.searches.find(x=>x.id===id);if(!old)throw Object.assign(Error('Search not found.'),{status:404});
      s.searches=s.searches.filter(x=>x.id!==id);for(const link of old.links)s.snapshots[link.id]&&delete s.snapshots[link.id];delete s.hiddenBySearch[id];
    });return json(res,200,snapshot());
  }
  if(path==='/api/refresh'&&method==='POST'){
    const data=await body(req,5000);if(job.busy)return fail(res,409,'A refresh is already running.');const ids=data.searchId?[data.searchId]:state.searches.map(x=>x.id);
    if(ids.some(id=>!state.searches.some(s=>s.id===id)))return fail(res,404,'Search not found.');
    if(!ids.length)return fail(res,400,'Add a car search first.');
    job.busy=true;job.stop=false;job.message='';job.started=now();job.finished=null;job.label='Starting refresh';
    setImmediate(()=>{void runScan(ids)});return json(res,200,snapshot());
  }
  if(path==='/api/refresh/stop'&&method==='POST'){job.stop=true;return json(res,200,{ok:true,job});}
  if(path==='/api/listings/manual'&&method==='POST'){
    const data=await body(req,25000),link=advertIdentity(data.url),fields=validateFields(data.fields||{});let selected,alreadyPresent=false;
    await mutate(s=>{let row=Object.values(s.listings).find(x=>{try{return advertIdentity(x.url).id===link.id}catch{return false}});
      if(row){alreadyPresent=true;row.saved=true;if(Object.keys(fields).length)applyEdits(row,fields);selected=row.id;}
      else{if(Object.keys(s.listings).length>=MAX_CARS)throw Error('Listing limit reached');selected='manual:'+uid();row={id:selected,site:link.site,url:link.url,title:'Car from '+SITES[link.site],titleSource:'placeholder',manualIdentity:link.id,manuallyAdded:true,saved:true,notes:'',price:null,firstSeen:now(),lastSeen:now(),priceHistory:[],enrichStatus:'queued'};if(Object.keys(fields).length)applyEdits(row,fields);s.listings[selected]=row;}
      if(row.enrichStatus!=='running')row.enrichStatus='queued';
    });setImmediate(()=>{void autoEnrich(selected)});return json(res,200,{...snapshot(),carId:selected,alreadyPresent});
  }
  if(path.startsWith('/api/listings/manual/')&&method==='PATCH'){
    const id=decodeURIComponent(path.slice('/api/listings/manual/'.length)),data=await body(req,25000),fields=validateFields(data.fields||{},false);
    await mutate(s=>{const row=checkSaveId(id);if(!row.saved)throw Object.assign(Error('Car must be saved first.'),{status:404});applyEdits(row,fields)});return json(res,200,snapshot());
  }
  if(path==='/api/listings/saved'&&method==='POST'){
    const data=await body(req,5000),ids=checkIds(data),enrich=[];
    await mutate(s=>{for(const id of ids){const row=s.listings[id];if(!row)continue;const was=!!row.saved;row.saved=!!data.saved;if(!was&&row.saved){row.enrichStatus='queued';enrich.push(id);}}});
    for(const id of enrich.slice(0,8))setImmediate(()=>{void autoEnrich(id)});
    return json(res,200,snapshot());
  }
  if(path==='/api/listings/enrich'&&method==='POST'){
    const ids=checkIds(await body(req,5000)).slice(0,8).filter(id=>state.listings[id]?.saved);
    for(const id of ids)setImmediate(()=>{void autoEnrich(id)});return json(res,200,snapshot());
  }
  if(path==='/api/listings/notes'&&method==='POST'){
    const data=await body(req,25000),ids=checkIds(data);if(typeof data.notes!=='string'||data.notes.length>12000)throw Error('Notes exceed 12,000 characters.');
    await mutate(s=>{for(const id of ids)if(s.listings[id])s.listings[id].notes=data.notes});return json(res,200,snapshot());
  }
  if(path==='/api/listings/hidden'&&method==='POST'){
    const data=await body(req,10000),ids=checkIds(data);
    await mutate(s=>{const search=s.searches.find(x=>x.id===data.searchId);if(!search)throw Error('Unknown search.');
      const eligible=new Set(search.links.flatMap(link=>s.snapshots[link.id]?.ids||[]));if(ids.some(x=>!eligible.has(x)))throw Error('Listing does not belong to this search.');
      const hidden=new Set(s.hiddenBySearch[search.id]||[]);for(const id of ids){if(data.hidden)hidden.add(id);else hidden.delete(id)}s.hiddenBySearch[search.id]=[...hidden];
    });return json(res,200,snapshot());
  }
  if(path==='/api/duplicates'&&method==='POST'){
    const data=await body(req,25000);await mutate(s=>{
      if(data.from&&data.to){checkSaveId(data.from);checkSaveId(data.to);s.manualDuplicates[data.from]=data.to;}
      else if(Array.isArray(data.unmergeIds))for(const id of data.unmergeIds)delete s.manualDuplicates[id];
      else if(Array.isArray(data.separateIds)&&data.separateIds.length>=2){const ids=data.separateIds;for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)s.separateDuplicates[[ids[i],ids[j]].sort().join('|')]=true;}
      else if(Array.isArray(data.clearSeparateIds)){for(const id of data.clearSeparateIds)for(const key of Object.keys(s.separateDuplicates))if(key.split('|').includes(id))delete s.separateDuplicates[key];}
      else throw Error('Invalid duplicate action.');
    });return json(res,200,snapshot());
  }
  if(path==='/api/options'&&method==='PATCH'){const data=await body(req,2000);if(![1,2,3,5].includes(Number(data.pageDepth)))return fail(res,400,'Invalid page depth.');await mutate(s=>{s.options.pageDepth=Number(data.pageDepth)});return json(res,200,snapshot());}
  return fail(res,404,'Unknown Car Search endpoint.');
}
export async function handleCarSearchApp(req,res,requestUrl){
  const path=requestUrl.pathname;if(path!==PREFIX&&!path.startsWith(PREFIX+'/'))return false;
  if(path===PREFIX){res.writeHead(308,{location:PREFIX+'/','cache-control':'no-store'});res.end();return true;}
  if(!['GET','HEAD','POST','PATCH','DELETE','OPTIONS'].includes(req.method))return fail(res,405,'Method not allowed.');
  const sub=path.slice(PREFIX.length)||'/';
  if(sub.startsWith('/api/')){
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!originAllowed(req))return fail(res,403,'Cross-site request rejected.');
    try{await handleApi(req,res,sub)}catch(err){const code=err.status||(/not found/i.test(err.message||'')?404:400);console.error('Car Search API:',err.message);if(!res.headersSent)fail(res,code,String(err.message||'Bad request').slice(0,250))}return true;
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return fail(res,405,'Method not allowed.');
  const files={'/':'dashboard.html','/dashboard.html':'dashboard.html','/dashboard.js':'dashboard.js','/styles.css':'styles.css'};
  const file=files[sub];if(!file)return fail(res,404,'Car Search file not found.');
  try{const contents=await readFile(join(ROOT,file));res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store','x-drivehub-car-search':'native'});if(req.method==='HEAD')return res.end();res.end(contents)}
  catch(err){console.error('Car Search UI:',err);fail(res,500,'Car Search interface unavailable.')}
  return true;
}