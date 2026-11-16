import {createHash,createVerify} from 'node:crypto';
function envValue(name){let value=String(process.env[name]??'').trim();if(value.length>=2&&((value.startsWith('\"')&&value.endsWith('\"'))||(value.startsWith("'")&&value.endsWith("'"))))value=value.slice(1,-1).trim();return value}
function json(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data))}
async function readBody(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)throw new Error('Body too large')}return body?JSON.parse(body):{}}
async function fetchWithTimeout(url,options={},timeoutMs=5000){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(url,{...options,signal:controller.signal})}finally{clearTimeout(timer)}}
let ebayTokenCache={token:'',expiresAt:0};
const EBAY_TOKEN_URL='https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL='https://api.ebay.com/buy/browse/v1/item_summary/search';
const EBAY_CARS_CATEGORY_ID='9801';
const EBAY_NOTIFICATION_PUBLIC_KEY_URL='https://api.ebay.com/commerce/notification/v1/public_key/';
const ebayPublicKeyCache=new Map();
async function ebayToken(){
  const now=Date.now();
  if(ebayTokenCache.token&&ebayTokenCache.expiresAt>now+60000)return ebayTokenCache.token;
  const clientId=envValue('EBAY_CLIENT_ID'),clientSecret=envValue('EBAY_CLIENT_SECRET');
  if(!clientId||!clientSecret)return null;
  const credentials=Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body=new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'});
  const r=await fetchWithTimeout(EBAY_TOKEN_URL,{method:'POST',headers:{Authorization:`Basic ${credentials}`,'content-type':'application/x-www-form-urlencoded'},body},7000);
  if(!r.ok)throw new Error(`eBay token request failed (${r.status})`);
  const data=await r.json();
  ebayTokenCache={token:data.access_token,expiresAt:now+Number(data.expires_in||7200)*1000};
  return ebayTokenCache.token;
}

function ebayNotificationConfig(){
  const endpoint=envValue('EBAY_NOTIFICATION_ENDPOINT'),verificationToken=envValue('EBAY_NOTIFICATION_TOKEN');
  const validEndpoint=/^https:\/\//i.test(endpoint);
  const validToken=/^[A-Za-z0-9_-]{32,80}$/.test(verificationToken);
  return {endpoint,verificationToken,configured:Boolean(validEndpoint&&validToken),validEndpoint,validToken};
}
function ebayChallengeResponse(challengeCode){
  const cfg=ebayNotificationConfig();
  if(!cfg.configured)throw new Error('eBay notification endpoint is not configured');
  return createHash('sha256').update(String(challengeCode||'')).update(cfg.verificationToken).update(cfg.endpoint).digest('hex');
}
function parseEbaySignatureHeader(value){
  const raw=Buffer.from(String(value||''),'base64').toString('ascii');
  const parsed=JSON.parse(raw);
  if(!parsed?.kid||!parsed?.signature)throw new Error('Invalid eBay signature header');
  return parsed;
}
function formatEbayPublicKey(key){
  const text=String(key||'').trim();
  if(!text)return '';
  if(text.includes('\n'))return text;
  return text.replace('-----BEGIN PUBLIC KEY-----','-----BEGIN PUBLIC KEY-----\n').replace('-----END PUBLIC KEY-----','\n-----END PUBLIC KEY-----');
}
async function ebayNotificationPublicKey(keyId){
  const now=Date.now(),cached=ebayPublicKeyCache.get(keyId);
  if(cached&&cached.expiresAt>now)return cached.value;
  const token=await ebayToken();
  if(!token)throw new Error('eBay API is not configured');
  const r=await fetchWithTimeout(`${EBAY_NOTIFICATION_PUBLIC_KEY_URL}${encodeURIComponent(keyId)}`,{headers:{Authorization:`Bearer ${token}`,accept:'application/json'}},7000);
  if(!r.ok)throw new Error(`eBay notification public key request failed (${r.status})`);
  const data=await r.json();
  if(!data?.key)throw new Error('eBay notification public key response was incomplete');
  ebayPublicKeyCache.set(keyId,{value:data,expiresAt:now+3600000});
  return data;
}
async function verifyEbayNotification(message,signatureHeader){
  const signature=parseEbaySignatureHeader(signatureHeader);
  const publicKey=await ebayNotificationPublicKey(signature.kid);
  const verifier=createVerify('ssl3-sha1');
  verifier.update(JSON.stringify(message));
  verifier.end();
  return verifier.verify(formatEbayPublicKey(publicKey.key),signature.signature,'base64');
}
async function apiEbayAccountDeletion(req,res,requestUrl){
  const cfg=ebayNotificationConfig();
  if(req.method==='GET'){
    const challengeCode=requestUrl.searchParams.get('challenge_code');
    if(!challengeCode)return json(res,400,{error:'challenge_code is required'});
    if(!cfg.configured)return json(res,503,{error:'eBay notification endpoint is not configured',code:'NOT_CONFIGURED'});
    return json(res,200,{challengeResponse:ebayChallengeResponse(challengeCode)});
  }
  if(req.method!=='POST')return json(res,405,{error:'GET or POST required'});
  if(!cfg.configured)return json(res,503,{error:'eBay notification endpoint is not configured',code:'NOT_CONFIGURED'});
  let body;
  try{body=await readBody(req)}catch{return json(res,400,{error:'Invalid notification body'})}
  if(body?.metadata?.topic!=='MARKETPLACE_ACCOUNT_DELETION'||!body?.notification?.notificationId)return json(res,400,{error:'Unsupported eBay notification'});
  const signature=req.headers['x-ebay-signature'];
  if(!signature)return json(res,412,{error:'Missing eBay notification signature'});
  try{
    const valid=await verifyEbayNotification(body,signature);
    if(!valid)return json(res,412,{error:'eBay notification signature could not be verified'});
    // DriveHub does not persist eBay account identifiers server-side. Valuation
    // payloads deliberately omit seller usernames, so there is no retained
    // eBay-user profile data to delete after a verified account-deletion event.
    res.writeHead(204,{'cache-control':'no-store'});return res.end();
  }catch(e){return json(res,503,{error:'Could not verify eBay notification',code:'VERIFICATION_UNAVAILABLE'})}
}

function compactWords(values){return values.map(v=>String(v||'').trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim()}
function median(values){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function percentile(values,p){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);const idx=(a.length-1)*p;const lo=Math.floor(idx),hi=Math.ceil(idx);return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(idx-lo)}
function round250(n){return Math.round(Number(n||0)/250)*250}
function cleanText(value){return String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9.]+/g,' ').replace(/\s+/g,' ').trim()}
function normalisedTokens(value){return cleanText(value).split(' ').filter(Boolean)}
function numericYear(value){const m=String(value||'').match(/\b(19\d{2}|20\d{2})\b/);return m?Number(m[1]):null}
function parseMileage(value){
  const text=String(value||'').toLowerCase().replace(/,/g,'');
  let m=text.match(/\b(\d{1,3}(?:\.\d+)?)\s*k\s*(?:miles?|mi)?\b/);if(m)return Math.round(Number(m[1])*1000);
  m=text.match(/\b(\d{4,6})\s*(?:miles?|mi)\b/);if(m)return Number(m[1]);
  if(/^\s*\d{4,6}\s*$/.test(text))return Number(text.trim());
  return null;
}
function transmissionClass(value){
  const t=cleanText(value);
  if(!t)return '';
  if(/\b(manual|mt)\b/.test(t)&&!/semi automatic|automated manual/.test(t))return 'manual';
  if(/\b(automatic|auto|cvt|dsg|dct|pdk|tiptronic|steptronic|selectshift|seleshift|smg|edc|s tronic|dual clutch|semi automatic|automated manual)\b/.test(t))return 'automatic';
  return '';
}
function engineLitres(value){
  const text=String(value||'').toLowerCase();
  let m=text.match(/(\d(?:\.\d)?)\s*(?:l|litre|liter)\b/);if(m)return Number(m[1]);
  m=text.match(/\b(\d{3,4})\s*cc\b/);if(m)return Number(m[1])/1000;
  const n=Number(String(value||'').replace(/[^0-9.]/g,''));if(Number.isFinite(n)&&n>=0.6&&n<=10)return n;if(Number.isFinite(n)&&n>=700&&n<=10000)return n/1000;
  return null;
}
function fuelClass(value){const t=cleanText(value);if(/electric|bev/.test(t))return 'electric';if(/hybrid|phev|mhev/.test(t))return 'hybrid';if(/diesel/.test(t))return 'diesel';if(/petrol|gasoline/.test(t))return 'petrol';return ''}
function bodyTypeClass(value){
  const t=cleanText(value);
  if(!t)return '';
  // Match the distinctive/open body styles before generic words such as coupe or hatch.
  if(/\b(convertible|cabriolet|cabrio|roadster|spyder|spider|drophead|soft top|softtop)\b/.test(t))return 'convertible';
  if(/\btarga\b/.test(t))return 'targa';
  if(/\b(pickup|pick up|pick-up|ute)\b/.test(t))return 'pickup';
  if(/\b(mpv|people carrier|minivan|mini van)\b/.test(t))return 'mpv';
  if(/\b(estate|station wagon|wagon|touring|avant|shooting brake|sport tourer)\b/.test(t))return 'estate';
  if(/\b(saloon|sedan|limousine)\b/.test(t))return 'saloon';
  if(/\b(hatchback|hatch)\b/.test(t))return 'hatchback';
  if(/\b(suv|4x4|sport utility|crossover)\b/.test(t))return 'suv';
  if(/\b(coupe|coupé|fastback)\b/.test(t))return 'coupe';
  return '';
}
function bodyTypeScore(target,value){if(!target)return .7;if(!value)return .38;return target===value?1:0}
function sellerType(item){
  const raw=String(item?.seller?.sellerAccountType||'').toUpperCase();
  if(raw==='BUSINESS')return 'business';
  if(raw==='INDIVIDUAL')return 'individual';
  return 'unknown';
}
function aspectMap(item){
  const map=new Map();
  for(const aspect of (item?.localizedAspects||[])){
    const name=cleanText(aspect?.name);const value=String(aspect?.value||'').trim();
    if(name&&value&&!map.has(name))map.set(name,value);
  }
  return map;
}
function aspectValue(map,names){for(const name of names){const value=map.get(cleanText(name));if(value)return value}return ''}
const TRIM_STOP=new Set(['edition','model','series','door','doors','dr','hatchback','saloon','estate','coupe','convertible','roadster','petrol','diesel','hybrid','automatic','manual','auto','litre','liter','turbo','year']);
function trimTokens(value,vehicle={}){
  const exclude=new Set([...normalisedTokens(vehicle.make),...normalisedTokens(vehicle.model)].filter(Boolean));
  const meaningfulSingle=new Set(['s','r','m']);
  return [...new Set(normalisedTokens(value).filter(t=>(t.length>1||meaningfulSingle.has(t))&&!TRIM_STOP.has(t)&&!exclude.has(t)&&!/^\d+(?:\.\d+)?$/.test(t)))];
}
function targetVehicleProfile(vehicle){
  const custom=Array.isArray(vehicle.specification)?vehicle.specification:[];
  const customTrim=custom.find(s=>/trim|derivative|variant|grade|model/.test(cleanText(s?.label)))?.value||'';
  const derivative=String(vehicle.derivative||customTrim||'').trim();
  return {
    year:numericYear(vehicle.year),make:String(vehicle.make||'').trim(),model:String(vehicle.model||'').trim(),derivative,
    trimTokens:trimTokens(derivative,vehicle),transmission:transmissionClass(vehicle.transmission),transmissionRaw:String(vehicle.transmission||'').trim(),
    mileage:Number(vehicle.mileage)>0?Number(vehicle.mileage):null,engine:engineLitres(vehicle.engineSize),engineRaw:String(vehicle.engineSize||'').trim(),
    fuel:fuelClass(vehicle.fuelType),fuelRaw:String(vehicle.fuelType||'').trim(),bodyType:bodyTypeClass(vehicle.bodyType),bodyTypeRaw:String(vehicle.bodyType||'').trim()
  };
}
function listingProfile(item){
  const aspects=aspectMap(item);const categoryText=(item.categories||[]).map(c=>c?.categoryName||c?.name||'').filter(Boolean).join(' ');const text=compactWords([item.title,item.shortDescription,categoryText]);
  const year=numericYear(aspectValue(aspects,['Year','Model Year'])||text);
  const mileage=parseMileage(aspectValue(aspects,['Mileage','Odometer','Vehicle Mileage']))||parseMileage(text);
  const transmissionRaw=aspectValue(aspects,['Transmission','Gearbox'])||text;
  const engineRaw=aspectValue(aspects,['Engine Size','Engine','Engine Capacity'])||text;
  const fuelRaw=aspectValue(aspects,['Fuel Type','Fuel'])||text;
  const bodyTypeRaw=aspectValue(aspects,['Body Type','Body Style','Vehicle Type','Car Type'])||text;
  const trimRaw=aspectValue(aspects,['Trim','Derivative','Variant','Model'])||'';
  return {year,mileage,transmission:transmissionClass(transmissionRaw),transmissionRaw,engine:engineLitres(engineRaw),engineRaw,fuel:fuelClass(fuelRaw),fuelRaw,bodyType:bodyTypeClass(bodyTypeRaw),bodyTypeRaw,trimRaw,text,aspects};
}
function tokenCoverage(tokens,text){if(!tokens.length)return null;const hay=new Set(normalisedTokens(text));const hit=tokens.filter(t=>hay.has(t)).length;return hit/tokens.length}
function makeModelScore(target,listing){
  const text=cleanText(compactWords([listing.text,aspectValue(listing.aspects,['Make','Manufacturer']),aspectValue(listing.aspects,['Model'])]));
  const makeTokens=normalisedTokens(target.make),modelTokens=normalisedTokens(target.model);
  const makeCoverage=tokenCoverage(makeTokens,text)??1,modelCoverage=tokenCoverage(modelTokens,text)??1;
  const makeHit=makeCoverage===1,modelHit=modelCoverage===1;
  // eBay vehicle titles often omit part of a multi-word manufacturer (for example
  // "Mercedes" rather than "Mercedes-Benz", or "Range Rover" rather than
  // "Land Rover Range Rover"). A complete model match plus at least half of a
  // multi-token make is still strong make/model evidence inside the Cars category.
  if(makeHit&&modelHit)return 1;if(modelHit&&makeCoverage>=.5)return .96;if(modelHit)return .78;if(makeHit)return .38;return 0;
}
const VEHICLE_GENERATION_RULES=[
  {make:/^ford$/,model:/\bmustang\b/,ranges:[[2005,2009,'S197 early'],[2010,2014,'S197 facelift'],[2015,2017,'S550 pre-facelift'],[2018,2023,'S550 facelift'],[2024,2099,'S650']]},
  {make:/^bmw$/,model:/\bm2\b/,ranges:[[2016,2021,'F87'],[2023,2099,'G87']]},
  {make:/^bmw$/,model:/\bm3\b/,ranges:[[2000,2006,'E46'],[2007,2013,'E9x'],[2014,2020,'F80'],[2021,2099,'G80']]},
  {make:/^bmw$/,model:/\b3\s*series\b/,ranges:[[1998,2004,'E46'],[2006,2011,'E9x'],[2012,2018,'F3x'],[2019,2099,'G20']]},
  {make:/^bmw$/,model:/\bz4\b/,ranges:[[2003,2008,'E85/E86'],[2009,2016,'E89'],[2019,2099,'G29']]},
  {make:/^jaguar$/,model:/\bf[- ]?type\b/,ranges:[[2013,2019,'X152 pre-facelift'],[2021,2024,'X152 facelift']]},
  {make:/^jaguar$/,model:/\bxkr\b/,ranges:[[1996,2006,'X100'],[2007,2015,'X150']]},
  {make:/^(land rover|range rover)$/,model:/\brange rover sport\b/,ranges:[[2005,2013,'L320'],[2014,2022,'L494'],[2023,2099,'L461']]},
  {make:/^(land rover|range rover)$/,model:/\brange rover\b/,ranges:[[2002,2012,'L322'],[2013,2021,'L405'],[2022,2099,'L460']]},
  {make:/^volkswagen$/,model:/\bgolf\b/,ranges:[[2004,2008,'Mk5'],[2009,2012,'Mk6'],[2013,2019,'Mk7'],[2020,2099,'Mk8']]},
  {make:/^audi$/,model:/\btt\b/,ranges:[[1998,2006,'8N'],[2007,2014,'8J'],[2015,2023,'8S']]},
  {make:/^mazda$/,model:/\bmx[- ]?5\b/,ranges:[[1990,1998,'NA'],[1999,2005,'NB'],[2006,2015,'NC'],[2016,2099,'ND']]},
  {make:/^porsche$/,model:/\b911\b/,ranges:[[1998,2004,'996'],[2005,2012,'997'],[2012,2019,'991'],[2020,2099,'992']]},
  {make:/^toyota$/,model:/\bsupra\b/,ranges:[[1993,2002,'A80'],[2019,2099,'A90/A91']]},
  {make:/^mercedes(?: benz)?$/,model:/\bc[- ]?class\b/,ranges:[[2000,2007,'W203'],[2008,2014,'W204'],[2015,2021,'W205'],[2022,2099,'W206']]},
  {make:/^ford$/,model:/\bfocus\b/,ranges:[[1998,2004,'Mk1'],[2005,2010,'Mk2'],[2011,2018,'Mk3'],[2019,2099,'Mk4']]},
  {make:/^ford$/,model:/\bfiesta\b/,ranges:[[2002,2008,'Mk6'],[2009,2017,'Mk7'],[2018,2023,'Mk8']]},
  {make:/^mini$/,model:/\b(hatch|cooper|one)\b/,ranges:[[2001,2006,'R50/R53'],[2007,2013,'R56'],[2014,2023,'F56'],[2024,2099,'J01/F66']]}
];
function vehicleGeneration(make,model,year){
  if(!year)return null;const m=cleanText(make),n=cleanText(model);const rule=VEHICLE_GENERATION_RULES.find(r=>r.make.test(m)&&r.model.test(n));if(!rule)return null;const range=rule.ranges.find(([from,to])=>year>=from&&year<=to);return range?{name:range[2],from:range[0],to:range[1]}:null;
}
function yearCompatibility(target,year){
  if(!target.year)return {score:.7,compatible:true,status:'target-year-unavailable',generation:null,delta:null};
  if(!year)return {score:.38,compatible:true,status:'listing-year-unavailable',generation:null,delta:null};
  const delta=Math.abs(target.year-year),targetGen=vehicleGeneration(target.make,target.model,target.year),listingGen=vehicleGeneration(target.make,target.model,year);
  if(targetGen&&listingGen&&targetGen.name!==listingGen.name)return {score:0,compatible:false,status:'generation-mismatch',generation:listingGen,delta};
  if(targetGen&&listingGen&&targetGen.name===listingGen.name){const score=delta===0?1:delta===1?.90:delta===2?.80:delta<=4?.66:.52;return {score,compatible:true,status:delta===0?'exact-year':'same-generation',generation:listingGen,delta}}
  if(delta===0)return {score:1,compatible:true,status:'exact-year',generation:listingGen,delta};
  if(delta===1)return {score:.78,compatible:true,status:'adjacent-year',generation:listingGen,delta};
  if(delta===2)return {score:.52,compatible:true,status:'near-year',generation:listingGen,delta};
  return {score:0,compatible:false,status:'year-too-distant',generation:listingGen,delta};
}
function mileageScore(targetMileage,mileage){if(!targetMileage)return .7;if(!mileage)return .35;const d=Math.abs(targetMileage-mileage);if(d<=7500)return 1;if(d<=15000)return .88;if(d<=25000)return .72;if(d<=40000)return .52;if(d<=60000)return .30;return .08}
function transmissionScore(target,value){if(!target)return .7;if(!value)return .35;return target===value?1:0}
function fuelScore(target,value){if(!target)return .7;if(!value)return .35;return target===value?1:0}
function engineScore(target,value){if(!target)return .7;if(!value)return .38;const d=Math.abs(Number(target)-Number(value));if(d<=.15)return 1;if(d<=.35)return .62;return 0}
function trimScore(target,listing){
  if(!target.trimTokens.length)return .7;
  const combined=compactWords([listing.trimRaw,listing.text]);const coverage=tokenCoverage(target.trimTokens,combined);
  if(coverage==null)return .35;
  const exact=target.derivative&&cleanText(combined).includes(cleanText(target.derivative));
  return Math.min(1,(exact?.25:0)+coverage*(exact?.75:1));
}
const BAD_LISTING=/\b(deposit|breaking|break(?:ing)? for parts|spares|salvage|damaged|repair project|parts only|engine only|gearbox only|monthly payment|finance example|lease|cat(?:egory)?\s*[sn]\b|write off)\b/i;
function valuationMileageTolerance(targetMileage){if(!targetMileage)return null;return Math.round(Math.min(25000,Math.max(7500,targetMileage*.20)))}
function comparableTier(target,{year,bodyType,trim,transmission,engine,fuel}){
  const exactYear=year.status==='exact-year',sameGeneration=year.status==='same-generation',nearYear=['adjacent-year','near-year'].includes(year.status),bodyGood=!target.bodyType||bodyType>=.99,trimGood=!target.trimTokens.length||trim>=.66,gearGood=!target.transmission||transmission>=.99,engineGood=!target.engine||engine>=.62,fuelGood=!target.fuel||fuel>=.99;
  if((exactYear||sameGeneration)&&bodyGood&&trimGood&&gearGood&&engineGood&&fuelGood)return 'excellent';
  if((exactYear||sameGeneration||nearYear)&&bodyGood&&engineGood&&fuelGood&&(trimGood||gearGood))return 'good';
  return 'weak';
}
function scoreComparable(target,item){
  const listing=listingProfile(item);const makeModel=makeModelScore(target,listing),year=yearCompatibility(target,listing.year),bodyType=bodyTypeScore(target.bodyType,listing.bodyType),trim=trimScore(target,listing),transmission=transmissionScore(target.transmission,listing.transmission),mileage=mileageScore(target.mileage,listing.mileage),fuel=fuelScore(target.fuel,listing.fuel),engine=engineScore(target.engine,listing.engine);
  const weighted=[['make/model',30,makeModel],['year/generation',22,target.year?year.score:null],['body type',15,target.bodyType?bodyType:null],['trim',13,target.trimTokens.length?trim:null],['engine',10,target.engine?engine:null],['transmission',5,target.transmission?transmission:null],['fuel',3,target.fuel?fuel:null],['mileage',2,target.mileage?mileage:null]].filter(([,w,v])=>v!==null);
  const totalWeight=weighted.reduce((n,[,w])=>n+w,0)||1;let score=weighted.reduce((n,[,w,v])=>n+w*v,0)/totalWeight*100;
  const text=compactWords([item.title,item.shortDescription]);const reasons=[];
  if(makeModel>=.95)reasons.push('make/model');if(year.status==='exact-year')reasons.push('exact year');else if(year.status==='same-generation')reasons.push('same generation');if(target.bodyType&&listing.bodyType===target.bodyType)reasons.push('body type');if(target.trimTokens.length&&trim>=.66)reasons.push('trim');if(target.engine&&engine>=.62)reasons.push('engine');if(target.transmission&&listing.transmission===target.transmission)reasons.push('transmission');if(target.fuel&&listing.fuel===target.fuel)reasons.push('fuel');if(target.mileage&&listing.mileage&&Math.abs(target.mileage-listing.mileage)<=valuationMileageTolerance(target.mileage))reasons.push('mileage');
  const engineConflict=Boolean(target.engine&&listing.engine&&engine===0),bodyTypeConflict=Boolean(target.bodyType&&listing.bodyType&&bodyType===0),hardMismatch=BAD_LISTING.test(text)||makeModel<.95||!year.compatible||engineConflict||bodyTypeConflict;if(BAD_LISTING.test(text))score-=45;if(engineConflict)score-=25;if(bodyTypeConflict)score-=35;
  const tier=comparableTier(target,{year,bodyType,trim,transmission,engine,fuel});
  return {...item,matchScore:Math.max(0,Math.min(100,Math.round(score))),matchTier:tier,matchReasons:reasons,year:listing.year,mileage:listing.mileage,bodyType:listing.bodyType||'',transmission:listing.transmission||'',trim:listing.trimRaw||'',engineSize:listing.engine||null,fuelType:listing.fuel||'',generation:year.generation?.name||'',yearStatus:year.status,hardMismatch,_match:{makeModel,year:year.score,yearStatus:year.status,yearDelta:year.delta,generation:year.generation?.name||'',bodyType,trim,transmission,mileage,fuel,engine}};
}
function basicComparable(item,forcedSellerType=''){
  return {itemId:item.itemId||'',itemHref:item.itemHref||'',title:item.title||'',shortDescription:item.shortDescription||'',price:Number(item.price?.value),currency:item.price?.currency||'',url:item.itemWebUrl||item.itemAffiliateWebUrl||'',image:item.image?.imageUrl||'',buyingOptions:item.buyingOptions||[],sellerType:forcedSellerType||sellerType(item),localizedAspects:item.localizedAspects||[],categories:item.categories||[]};
}
function validSearchRows(items,forcedSellerType=''){return (items||[]).map(item=>basicComparable(item,forcedSellerType)).filter(x=>x.currency==='GBP'&&Number.isFinite(x.price)&&x.price>=1500&&x.price<=250000&&!x.buyingOptions.includes('AUCTION')&&!BAD_LISTING.test(compactWords([x.title,x.shortDescription])))}
function dedupeRows(rows){const map=new Map();for(const row of rows){const key=row.itemId||row.url||`${row.title}|${row.price}`;if(!map.has(key))map.set(key,row)}return [...map.values()]}
function weightedPercentile(rows,p){const usable=rows.filter(r=>Number.isFinite(r.price)&&Number.isFinite(r.weight)&&r.weight>0).sort((a,b)=>a.price-b.price);if(!usable.length)return null;const total=usable.reduce((n,r)=>n+r.weight,0),target=total*p;let acc=0;for(const row of usable){acc+=row.weight;if(acc>=target)return row.price}return usable.at(-1).price}
function applyPriceOutlierFilter(rows){if(rows.length<5)return rows;const prices=rows.map(x=>x.price),q1=percentile(prices,.25),q3=percentile(prices,.75),iqr=Math.max(500,q3-q1);const low=Math.max(1500,q1-1.5*iqr),high=q3+1.5*iqr;const filtered=rows.filter(x=>x.price>=low&&x.price<=high);return filtered.length>=5?filtered:rows}
function medianNumber(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function mileageAdjustment(rows,targetMileage){
  const base=rows.map(r=>({...r,advertisedPrice:Number(r.price),valuationPrice:Number(r.price),mileageAdjustedPrice:Number(r.price),mileageAdjustment:0}));
  if(!targetMileage)return {rows:base,model:null};
  const usable=rows.filter(r=>Number.isFinite(Number(r.price))&&Number(r.mileage)>0);if(usable.length<4)return {rows:base,model:{targetMileage,comparableMileageCount:usable.length,averageComparableMileage:usable.length?Math.round(usable.reduce((n,r)=>n+Number(r.mileage),0)/usable.length):null,priceEffectPer10000:0,reliable:false}};
  const slopes=[];for(let i=0;i<usable.length;i++){for(let j=i+1;j<usable.length;j++){const a=usable[i],b=usable[j];if(a.sellerType&&b.sellerType&&a.sellerType!==b.sellerType)continue;if(a.transmission&&b.transmission&&a.transmission!==b.transmission)continue;if(a.fuelType&&b.fuelType&&a.fuelType!==b.fuelType)continue;if(a.generation&&b.generation&&a.generation!==b.generation)continue;const dm=Number(b.mileage)-Number(a.mileage);if(Math.abs(dm)<5000)continue;const slope=(Number(b.price)-Number(a.price))/dm;if(Number.isFinite(slope))slopes.push(slope)}}
  const rawSlope=medianNumber(slopes);const medianPrice=medianNumber(usable.map(r=>Number(r.price)))||0;const maxPer10k=medianPrice*.08;let slope=Number.isFinite(rawSlope)&&rawSlope<0?rawSlope:0;slope=Math.max(slope,-maxPer10k/10000);if(Math.abs(slope*10000)<medianPrice*.005)slope=0;
  const adjusted=base.map(r=>{if(!Number(r.mileage)||!slope)return r;const rawDelta=slope*(targetMileage-Number(r.mileage)),cap=Math.abs(Number(r.price))*.30,delta=Math.max(-cap,Math.min(cap,rawDelta)),price=Math.max(1000,Number(r.price)+delta);return {...r,valuationPrice:price,mileageAdjustedPrice:round250(price),mileageAdjustment:round250(delta)}});
  return {rows:adjusted,model:{targetMileage,comparableMileageCount:usable.length,averageComparableMileage:Math.round(usable.reduce((n,r)=>n+Number(r.mileage),0)/usable.length),priceEffectPer10000:Math.round(slope*10000),reliable:Boolean(slope&&slopes.length>=3)}};
}
function marketStats(rows,priceKey='valuationPrice'){
  if(!rows.length)return null;const values=rows.map(r=>Number(r[priceKey]??r.price));const tierWeight={excellent:1.7,good:1,weak:.5};const weighted=rows.map((r,i)=>({...r,price:values[i],weight:Math.max(.15,Math.pow(Number(r.matchScore||50)/100,2)*2*(tierWeight[r.matchTier]||.6))}));const average=values.reduce((n,x)=>n+x,0)/values.length;return {count:rows.length,average,median:weightedPercentile(weighted,.5),low:weightedPercentile(weighted,.2),high:weightedPercentile(weighted,.8),matchQuality:Math.round(rows.reduce((n,r)=>n+Number(r.matchScore||0),0)/rows.length)};
}
function pxFromRetail(retail){const value=Number(retail||0);let marginPct=.085,prep=800;if(value<5000){marginPct=.18;prep=300}else if(value<10000){marginPct=.15;prep=400}else if(value<20000){marginPct=.12;prep=500}else if(value<40000){marginPct=.10;prep=650}return Math.max(1000,value*(1-marginPct)-prep)}
async function ebaySellerSearch(token,query,accountType){const url=new URL(EBAY_BROWSE_URL);url.searchParams.set('q',query);url.searchParams.set('category_ids',EBAY_CARS_CATEGORY_ID);url.searchParams.set('limit','100');url.searchParams.set('fieldgroups','EXTENDED');url.searchParams.set('filter',`sellerAccountTypes:{${accountType}}`);const r=await fetchWithTimeout(url,{headers:{Authorization:`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_GB','Accept-Language':'en-GB'}},7000);if(!r.ok)throw new Error(`eBay Browse ${accountType.toLowerCase()} search failed (${r.status})`);const data=await r.json();return {total:Number(data.total||0),categoryId:EBAY_CARS_CATEGORY_ID,items:validSearchRows(data.itemSummaries||[],accountType==='BUSINESS'?'business':'individual')}}
async function ebayItemDetails(token,row){if(!row.itemId&&!row.itemHref)return row;const url=row.itemHref||`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(row.itemId)}`;try{const r=await fetchWithTimeout(url,{headers:{Authorization:`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_GB','Accept-Language':'en-GB'}},5000);if(!r.ok)return row;const item=await r.json();return {...row,shortDescription:item.shortDescription||row.shortDescription||'',localizedAspects:item.localizedAspects||row.localizedAspects||[],categories:item.categories||row.categories||[]}}catch{return row}}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
function preliminaryScore(target,row){return scoreComparable(target,row).matchScore}
function progressiveComparableSelection(scored,target,minComparables=3){
  const compatible=applyPriceOutlierFilter(scored.filter(row=>!row.hardMismatch&&row._match?.makeModel>=.95));const tierCounts={excellent:compatible.filter(r=>r.matchTier==='excellent').length,good:compatible.filter(r=>r.matchTier==='good').length,weak:compatible.filter(r=>r.matchTier==='weak').length};
  const excellent=compatible.filter(r=>r.matchTier==='excellent'),good=compatible.filter(r=>r.matchTier==='good'),weak=compatible.filter(r=>r.matchTier==='weak');let rows=[],tierUsed='weak';
  if(excellent.length>=minComparables){rows=excellent;tierUsed='excellent'}else if(excellent.length+good.length>=minComparables){rows=[...excellent,...good];tierUsed='good'}else{rows=[...excellent,...good,...weak];tierUsed='weak'}
  rows=rows.sort((a,b)=>(b.matchScore-a.matchScore)||Math.abs((a._match?.yearDelta??99))-(Math.abs(b._match?.yearDelta??99))).slice(0,24);
  const targetGeneration=vehicleGeneration(target.make,target.model,target.year)?.name||'';const criteriaUsed=['Make','Model'];if(target.year){if(targetGeneration)criteriaUsed.push('Generation / era');criteriaUsed.push('Year')}if(target.bodyType)criteriaUsed.push('Body type');if(target.trimTokens.length)criteriaUsed.push('Trim');if(target.engine)criteriaUsed.push('Engine');if(target.transmission)criteriaUsed.push('Transmission');if(target.fuel)criteriaUsed.push('Fuel');criteriaUsed.push('Mileage adjustment');
  const relaxed=tierUsed==='excellent'?[]:tierUsed==='good'?['Exact derivative / specification where unavailable']:['Exact derivative / specification and adjacent-year preference where unavailable'];
  return {rows,criteriaUsed,droppedCriteria:relaxed,unavailableCriteria:target.bodyType?[]:['Body type'],mileageTolerance:target.mileage?valuationMileageTolerance(target.mileage):null,minComparables,tierUsed,tierCounts,targetGeneration,bodyTypePolicy:target.bodyType?'Known conflicting body styles are rejected; missing listing body type lowers match quality rather than causing rejection.':'Subject body type is unavailable, so body-style filtering cannot be applied.',yearPolicy:targetGeneration?'Known generation mismatch is rejected; same-generation years may be used with lower weight.':'Exact/adjacent years are preferred; listings more than two model years away are rejected.'};
}
function confidenceForValuation({rows,matchQuality,selection}){let score=92;if(selection.tierUsed==='good')score-=10;if(selection.tierUsed==='weak')score-=24;if(!selection.targetGeneration)score-=5;if(rows.length<5)score-=(5-rows.length)*8;score+=Math.min(7,Math.max(0,rows.length-5));score+=(Number(matchQuality||0)-75)*.16;score=Math.round(Math.max(25,Math.min(95,score)));return {score,label:score>=78?'high':score>=58?'medium':'low'}}
async function ebayComparables(vehicle){
  const token=await ebayToken();if(!token)return null;if(!vehicle.make||!vehicle.model)throw new Error('Make and model are required for an eBay valuation');
  const target=targetVehicleProfile(vehicle),yearText=target.year?String(target.year):'';
  const broadQuery=compactWords([target.make,target.model]),yearQuery=compactWords([target.make,target.model,yearText]),yearBodyQuery=compactWords([target.make,target.model,yearText,target.bodyTypeRaw]),specificQuery=compactWords([target.make,target.model,target.derivative,yearText,target.bodyTypeRaw,target.engineRaw,target.transmissionRaw,target.fuelRaw]);const queries=[specificQuery,yearBodyQuery,yearQuery,broadQuery].filter(Boolean);const uniqueQueries=[...new Set(queries)];
  const results=await Promise.all(uniqueQueries.flatMap(query=>['BUSINESS','INDIVIDUAL'].map(accountType=>ebaySellerSearch(token,query,accountType).then(result=>({...result,query,accountType})))));const total=results.reduce((n,r)=>n+r.total,0),all=dedupeRows(results.flatMap(r=>r.items));
  const eligible=all.map(row=>scoreComparable(target,row)).filter(row=>row._match?.makeModel>=.95&&!row.hardMismatch);const shortlist=[];for(const seller of ['business','individual'])shortlist.push(...eligible.filter(r=>r.sellerType===seller).sort((a,b)=>b.matchScore-a.matchScore).slice(0,24));if(shortlist.length<48)shortlist.push(...eligible.filter(r=>!shortlist.some(x=>x.itemId===r.itemId&&x.itemId)).sort((a,b)=>b.matchScore-a.matchScore).slice(0,48-shortlist.length));
  const enriched=await mapLimit(dedupeRows(shortlist),6,row=>ebayItemDetails(token,row));const scored=enriched.map(row=>scoreComparable(target,row));const selection=progressiveComparableSelection(scored,target,3);
  return {query:uniqueQueries.join(' | '),queries:uniqueQueries,total,categoryId:EBAY_CARS_CATEGORY_ID,searchCandidateCount:all.length,compatibleCandidateCount:scored.filter(r=>!r.hardMismatch).length,items:selection.rows,target,selection};
}
async function apiValuation(req,res){
  if(req.method!=='POST')return json(res,405,{error:'POST required'});if(!process.env.EBAY_CLIENT_ID||!process.env.EBAY_CLIENT_SECRET)return json(res,503,{error:'eBay API is not configured',code:'NOT_CONFIGURED'});
  try{
    const body=await readBody(req),vehicle=body.vehicle||{},market=await ebayComparables(vehicle),rawRows=market?.items||[];if(rawRows.length<3)return json(res,422,{error:`Only ${rawRows.length} compatible year/generation match${rawRows.length===1?' was':'es were'} available from ${market?.searchCandidateCount||0} eBay Cars listings checked, so DriveHub did not create a valuation`,comparableCount:rawRows.length,searchCandidateCount:market?.searchCandidateCount||0,minimumComparables:3});
    const mileage=mileageAdjustment(rawRows,market.target.mileage),rows=mileage.rows,business=rows.filter(x=>x.sellerType==='business'),individual=rows.filter(x=>x.sellerType==='individual'),unknown=rows.filter(x=>x.sellerType==='unknown');const allStats=marketStats(rows),rawStats=marketStats(rows,'advertisedPrice'),businessStats=marketStats(business),privateStats=marketStats(individual);
    const dealerBasis=businessStats?.count>=3?'business':privateStats?.count>=3?'private-derived':'all-derived';const dealerRaw=dealerBasis==='business'?businessStats.median:dealerBasis==='private-derived'?privateStats.median/0.90:allStats.median;const retail=round250(dealerRaw);const privateBasis=privateStats?.count>=3?'individual':businessStats?.count>=3?'dealer-derived':'all-derived';const privateAsk=privateBasis==='individual'?privateStats.median:privateBasis==='dealer-derived'?businessStats.median*0.91:allStats.median*0.92;const privateSale=round250(privateAsk*0.975),trade=round250(pxFromRetail(retail));
    const centre=businessStats?.median||privateStats?.median||allStats.median;const sorted=[...rows].sort((a,b)=>(b.matchScore-a.matchScore)||Math.abs((a.valuationPrice||a.price)-centre)-Math.abs((b.valuationPrice||b.price)-centre)).slice(0,8);const matchQuality=allStats.matchQuality,confidenceResult=confidenceForValuation({rows,matchQuality,selection:market.selection});
    const sellerBreakdown={business:businessStats?{count:businessStats.count,average:round250(businessStats.average),rawAverage:round250(marketStats(business,'advertisedPrice').average),median:round250(businessStats.median),matchQuality:businessStats.matchQuality,range:{low:round250(businessStats.low),high:round250(businessStats.high)}}:{count:0},individual:privateStats?{count:privateStats.count,average:round250(privateStats.average),rawAverage:round250(marketStats(individual,'advertisedPrice').average),median:round250(privateStats.median),matchQuality:privateStats.matchQuality,range:{low:round250(privateStats.low),high:round250(privateStats.high)}}:{count:0},unknown:{count:unknown.length}};
    const basis={dealer:dealerBasis,private:privateBasis,trade:'dealer-margin-model',matching:'generation-year-body-derivative-weighted-with-mileage-normalisation'};const target=market.target;const note=`DriveHub searches only eBay UK's Cars category (9801). It first looks for the subject car's Make + Model + Year + Body type and close specification, then uses wider searches only to discover additional compatible cars. Known generation/facelift and body-style mismatches are rejected. Where no generation rule is known, listings more than two model years away are rejected. Exact/same-generation body type, derivative, engine, transmission and fuel matches carry the most weight. Mileage adjusts the price of compatible cars rather than deciding vehicle identity.`;
    const cleanComparables=sorted.map(({localizedAspects,categories,itemHref,buyingOptions,hardMismatch,_match,valuationPrice,...row})=>({...row,adjustedPrice:round250(valuationPrice||row.price)}));
    return json(res,200,{trade,privateSale,retail,updatedAt:new Date().toISOString(),source:'ebay',sourceLabel:'eBay Cars · generation-aware market',confidence:confidenceResult.label,confidenceScore:confidenceResult.score,comparableCount:rows.length,searchCandidateCount:market.searchCandidateCount,matchQuality,averageAsk:round250(allStats.average),rawAverageAsk:round250(rawStats.average),medianAsk:round250(allStats.median),query:market.query,range:{low:round250(allStats.low),high:round250(allStats.high)},sellerBreakdown,basis,matchProfile:{make:target.make,model:target.model,year:target.year,generation:market.selection.targetGeneration,bodyType:target.bodyTypeRaw||target.bodyType,trim:target.derivative,engine:target.engineRaw,transmission:target.transmissionRaw,mileage:target.mileage,fuel:target.fuelRaw},matchStrategy:{criteriaUsed:market.selection.criteriaUsed,droppedCriteria:market.selection.droppedCriteria,unavailableCriteria:market.selection.unavailableCriteria,minimumComparables:3,mileageTolerance:market.selection.mileageTolerance,tierUsed:market.selection.tierUsed,tierCounts:market.selection.tierCounts,targetGeneration:market.selection.targetGeneration,bodyTypePolicy:market.selection.bodyTypePolicy,yearPolicy:market.selection.yearPolicy,categoryId:market.categoryId,categoryName:'Cars'},mileageAdjustment:mileage.model,comparables:cleanComparables,note});
  }catch(e){return json(res,502,{error:e.message||'eBay valuation failed'})
  }
}

export function valuationStatus(){return {ebay:{configured:Boolean(envValue('EBAY_CLIENT_ID')&&envValue('EBAY_CLIENT_SECRET')),notificationsConfigured:ebayNotificationConfig().configured}}}
export async function handleValuationApi(req,res,pathname,requestUrl){if(pathname==='/api/valuation')return apiValuation(req,res);if(pathname==='/api/ebay/account-deletion')return apiEbayAccountDeletion(req,res,requestUrl);return false}
