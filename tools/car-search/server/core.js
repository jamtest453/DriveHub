import {createHash, randomUUID} from 'node:crypto';

export const SITES={autotrader:'Auto Trader',ebay:'eBay',pistonheads:'PistonHeads',facebook:'Facebook Marketplace'};
export const COLOURS=['black','white','silver','grey','blue','red','green','yellow','orange','purple','brown','gold','beige','other'];
export const SITE_HOSTS={autotrader:['autotrader.co.uk'],ebay:['ebay.co.uk','ebay.com'],pistonheads:['pistonheads.com'],facebook:['facebook.com']};
export const MAX_CARS=100000;
export const now=()=>new Date().toISOString();
export const uid=()=>randomUUID();
export const stateTemplate=()=>({version:1,searches:[],listings:{},snapshots:{},manualDuplicates:{},separateDuplicates:{},hiddenBySearch:{},options:{pageDepth:2}});
export function siteFor(input){
  try{const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password|| (u.port&&u.port!=='443'))return null;
    for(const [site,hosts] of Object.entries(SITE_HOSTS))if(hosts.some(host=>u.hostname===host||u.hostname.endsWith('.'+host)))return site;
  }catch{}return null;
}
export function advertIdentity(input){
  const site=siteFor(input);if(!site)throw Error('Paste a supported HTTPS advert link.');
  const u=new URL(input),p=u.pathname.replace(/\/$/,'');
  const patterns={autotrader:/^\/car-details\/(\d{10,18})$/i,ebay:/^\/itm\/(?:[^/]+\/)?(\d{8,15})$/i,pistonheads:/^\/(?:buy\/listing|classifieds\/used-cars\/[^/]+\/[^/]+)\/([a-z0-9-]{4,100})$/i,facebook:/^\/marketplace\/item\/(\d{6,30})$/i};
  const match=p.match(patterns[site]);if(!match)throw Error('This is not an individual car advert. Paste a listing URL, not a search-results page.');
  u.hash='';u.search='';return {site,id:site+':'+match[1].toLowerCase(),url:u.href};
}
export function textClean(value){return String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
export function phraseMatches(value,phrase){return (' '+textClean(value)+' ').includes(' '+textClean(phrase)+' ');}
export function keywordClauses(value){return String(value||'').split(/[,;\n\r]+/).map(s=>[...new Set(s.split(/\s+OR\s+|\s*\|\s*/i).map(t=>t.trim()).filter(Boolean))]).filter(x=>x.length);}
export function groupMatchesKeywords(rows,filters={}){
  const hay=rows.map(x=>String(x.title||'')+' '+String(x.description||''));
  const includes=word=>hay.some(t=>phraseMatches(t,word));
  const required=keywordClauses(filters.requiredKeywords);
  const clause=words=>words.some(includes);
  if(required.length && !(filters.requiredKeywordLogic==='any'?required.some(clause):required.every(clause)))return false;
  if(keywordClauses(filters.excludeKeywords).some(clause))return false;
  return true;
}
export function preferredScore(rows,filters={}){
  return keywordClauses(filters.preferredKeywords).reduce((sum,words)=>sum+Math.max(0,...words.map(word=>rows.some(row=>phraseMatches(row.title,word))?2:rows.some(row=>phraseMatches(row.description,word))?1:0)),0);
}
export function validateFields(input,allowEmpty=true){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Vehicle details must be a JSON object.');
  const strings={title:220,description:4000,location:120,registration:30,notes:12000,image:1600};
  const numeric={price:[0,1000000],year:[1950,2035],mileage:[0,1000000],engine:[0.1,15],bhp:[1,2000]};
  const names=new Set([...Object.keys(strings),...Object.keys(numeric),'colour','transmission']);
  if(!allowEmpty&&!Object.keys(input).length)throw Error('Enter at least one detail.');
  const out={};for(const [field,value] of Object.entries(input)){
    if(!names.has(field))throw Error('Unsupported field: '+field);
    if(field in strings){if(typeof value!=='string'||value.length>strings[field])throw Error('Invalid '+field);out[field]=value.trim();
      if(field==='image'&&out[field]){const u=new URL(out[field]);if(u.protocol!=='https:'||u.username||u.password)throw Error('Image must use a public HTTPS link.');}}
    else if(field in numeric){if(value===''||value===null){out[field]=null;continue;}if(typeof value==='boolean'||!Number.isFinite(Number(value)))throw Error('Invalid '+field);const n=Number(value);if(n<numeric[field][0]||n>numeric[field][1]||(field!=='engine'&&!Number.isInteger(n)))throw Error('Invalid '+field);out[field]=n;}
    else if(field==='colour'){if(typeof value!=='string'||(value&&!COLOURS.includes(value.toLowerCase())))throw Error('Invalid exterior colour');out[field]=value.toLowerCase();}
    else if(field==='transmission'){if(!['','manual','automatic'].includes(value))throw Error('Invalid transmission');out[field]=value;}
  }return out;
}
export function applyEdits(row,fields){
  const locked=new Set(row.manualFields||[]);for(const [field,value] of Object.entries(fields)){
    if(field==='price'&&value!==row.price&&value!=null){row.previousPrice=row.price??null;row.priceHistory=[...(row.priceHistory||[]),{price:value,at:now(),source:'manual'}].slice(-80);}
    if(field==='colour')row.colourSource=value?'manual':'unknown';
    if(field==='title')delete row.titleSource;
    if(field==='image'&&value!==row.image)delete row.photoHash;
    row[field]=value;locked.add(field);
  }row.manualFields=[...locked];row.manuallyEditedAt=now();return row;
}
export function updateListing(state,item,stamp=now()){
  const original=state.listings[item.id];if(!original){state.listings[item.id]={...item,firstSeen:stamp,lastSeen:stamp,saved:false,notes:'',previousPrice:null,priceHistory:item.price>0?[{price:item.price,at:stamp}]:[]};return {new:true,changed:false};}
  const locked=new Set(original.manualFields||[]);
  const changed=!locked.has('price')&&item.price>0&&original.price>0&&item.price!==original.price;
  if(changed){original.previousPrice=original.price;original.priceHistory=[...(original.priceHistory||[]),{price:item.price,at:stamp}].slice(-80);}
  for(const [key,value] of Object.entries(item))if(!locked.has(key)&&value!==''&&value!==null&&value!==undefined)original[key]=value;
  original.lastSeen=stamp;return {new:false,changed};
}
export function carGroups(listings,manualDuplicates={},separateDuplicates={}){
  const groups=[];const root=id=>{let n=id;const seen=new Set();while(manualDuplicates[n]&&!seen.has(n)){seen.add(n);n=manualDuplicates[n];}return n};
  const normalized=a=>textClean(a).replace(/\s+/g,' ').trim();
  const identity=x=>{const s=normalized(x.title);const make=['bmw','porsche','ford','jaguar','lotus','audi','mercedes','nissan','mazda','toyota','mini','volkswagen','honda','aston martin','fiat','volvo','land rover'].find(w=>s.includes(w));return make ? make+':'+(s.match(/\b(m2|m3|m4|m135i|m140i|911|996|997|evora|mustang|f type|f-type|xkr|qashqai|mx5|mx 5|tt|a3|a4|golf|focus)\b/)?.[0]||'') : ''};
  const same=(a,b)=>{if(root(a.id)===root(b.id))return true;const key=[a.id,b.id].sort().join('|');if(separateDuplicates[key])return false;if(a.site===b.site)return false;
    const reg=x=>String(x.registration||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(reg(a).length>=6&&reg(b).length>=6)return reg(a)===reg(b);
    const ma=identity(a),mb=identity(b);if(!ma||ma!==mb)return false;
    if(a.year&&b.year&&Math.abs(a.year-b.year)>1)return false;
    if(a.transmission&&b.transmission&&a.transmission!==b.transmission)return false;
    const colour=x=>normalized(x.colour),ca=colour(a),cb=colour(b);if(ca&&cb&&ca!==cb)return false;
    const miles=Number(a.mileage),other=Number(b.mileage),known=a.mileage!=null&&b.mileage!=null;const mileage=known&&Math.abs(miles-other)<=Math.min(1250,Math.max(500,Math.min(miles,other)*0.018));if(known&&!mileage)return false;
    const place=x=>normalized(x.location).replace(/\b\d+\s*miles?\b/g,'').trim(),samePlace=place(a)&&place(a)===place(b);
    const samePhoto=a.image&&a.image===b.image;
    const samePrice=a.price>0&&a.price===b.price;
    return Boolean((mileage&&samePlace&&(ca===cb||samePrice))||(mileage&&ca&&ca===cb&&samePrice)||(samePhoto&&(samePlace||mileage))||(samePlace&&samePrice&&ca&&ca===cb&&a.year===b.year));
  };
  for(const row of listings){let g=groups.find(g=>g.some(x=>root(x.id)===root(row.id)));if(!g)g=groups.find(g=>!g.some(x=>x.site===row.site)&&g.every(x=>same(x,row)));if(g)g.push(row);else groups.push([row]);}
  return groups.map(g=>g.sort((a,b)=>Number(b.saved)-Number(a.saved)||Number(!!b.image)-Number(!!a.image)));
}
export function providerLinks(filters,sources){
  const query=[filters.make,filters.model].filter(Boolean).join(' ').trim();if(!query)throw Error('Enter at least a make or model.');
  const links=[];
  for(const site of sources){if(!SITES[site])throw Error('Unsupported source '+site);let url;
    if(site==='autotrader'){
      const u=new URL('https://www.autotrader.co.uk/car-search');u.searchParams.set('make',filters.make||'');if(filters.model)u.searchParams.set('model',filters.model);if(filters.priceMax)u.searchParams.set('price-to',filters.priceMax);if(filters.priceMin)u.searchParams.set('price-from',filters.priceMin);if(filters.mileageMax)u.searchParams.set('maximum-mileage',filters.mileageMax);u.searchParams.set('postcode','SK12 2NL');u.searchParams.set('sort','most-recent');url=u.href;
    }else if(site==='ebay'){
      const u=new URL('https://www.ebay.co.uk/sch/i.html');u.searchParams.set('_nkw',query);u.searchParams.set('_sacat','9801');if(filters.priceMax)u.searchParams.set('_udhi',filters.priceMax);if(filters.priceMin)u.searchParams.set('_udlo',filters.priceMin);u.searchParams.set('_sop','10');url=u.href;
    }else if(site==='pistonheads')url='https://www.pistonheads.com/buy/search?'+new URLSearchParams({q:query}).toString();
    else url='https://www.facebook.com/marketplace/search?'+new URLSearchParams({query}).toString();
    links.push({id:uid(),site,url,sourceNote:'Generated from saved vehicle criteria'});
  }return links;
}
export function validateSearch(raw){
  if(!raw||typeof raw!=='object')throw Error('Invalid search.');const name=String(raw.name||'').trim().slice(0,120);if(!name)throw Error('Give the search a name.');const f=raw.filters||{};
  const filters={make:String(f.make||'').slice(0,70).trim(),model:String(f.model||'').slice(0,90).trim(),requiredKeywords:String(f.requiredKeywords||'').slice(0,500).trim(),requiredKeywordLogic:f.requiredKeywordLogic==='any'?'any':'all',preferredKeywords:String(f.preferredKeywords||'').slice(0,500).trim(),excludeKeywords:String(f.excludeKeywords||'').slice(0,500).trim(),transmission:['manual','automatic'].includes(f.transmission)?f.transmission:'any',colours:Array.isArray(f.colours)?f.colours.filter(x=>COLOURS.includes(x)).slice(0,12):[],includeUnknownColours:!!f.includeUnknownColours};
  for(const key of ['priceMin','priceMax','yearMin','yearMax','mileageMax']){const value=f[key];filters[key]=value==null||value===''?null:Number(value);if(filters[key]!==null&&(!Number.isInteger(filters[key])||filters[key]<0||filters[key]>10000000))throw Error('Invalid '+key);}
  const sources=Array.isArray(raw.sources)&&raw.sources.length?[...new Set(raw.sources)]:Object.keys(SITES);if(sources.length>4||sources.some(x=>!SITES[x]))throw Error('Select valid sources.');
  return {name,filters,sources};
}
export function queryImport(input){
  const site=siteFor(input);if(!site)throw Error('Use a saved search URL from a supported site.');const u=new URL(input),p=u.searchParams;
  const read=(...names)=>names.map(n=>p.get(n)).find(Boolean)||'';
  const filters={make:read('make'),model:read('model'),priceMax:read('price-to','_udhi','maxPrice'),priceMin:read('price-from','_udlo','minPrice'),mileageMax:read('maximum-mileage','mileageTo'),transmission:'any',requiredKeywords:'',preferredKeywords:'',excludeKeywords:''};
  const trim=read('aggregatedTrim');if(trim)filters.requiredKeywords=trim.replace(/\b(996|997)\s+/, '$1, ');
  const transmission=read('transmission');if(/manual/i.test(transmission))filters.transmission='manual';else if(/auto|dct|pdk/i.test(transmission))filters.transmission='automatic';
  if(site==='ebay'&&!filters.make){const tokens=read('_nkw').split(/\s+/);filters.make=tokens.shift()||'';filters.model=tokens.join(' ');}
  if(site==='facebook'&&!filters.make){const tokens=read('query').split(/\s+/);filters.make=tokens.shift()||'';filters.model=tokens.join(' ');}
  return {site,siteLabel:SITES[site],filters,warnings:['Review the extracted filters. Location, body style and postcode may not transfer to other sites.']};
}