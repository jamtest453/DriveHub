import {advertIdentity,siteFor,SITES} from './core.js';

const USER_AGENT='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const MAX_BYTES=3_000_000;
const htmlDecode=text=>String(text||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
const trimHtml=text=>htmlDecode(String(text||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
const money=value=>{if(value===undefined||value===null)return null;const n=Number(String(value).replace(/[^\d.]/g,''));return Number.isFinite(n)&&n>0&&n<2000000?Math.round(n):null};
function parseJsonLd(html){
  const entries=[];for(const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    if(match[1].length>250000)continue;
    try{const obj=JSON.parse(match[1]);const visit=(o,depth=0)=>{if(depth>5||!o||typeof o!=='object')return;if(Array.isArray(o))return o.forEach(v=>visit(v,depth+1));if(o['@graph'])visit(o['@graph'],depth+1);if(o.itemListElement)visit(o.itemListElement,depth+1);if(o.item)visit(o.item,depth+1);if(o.url||o.offers||o.name)entries.push(o)};visit(obj)}catch{}
  }return entries;
}
function yearFrom(text){const v=String(text||'').match(/\b(19[89]\d|20[012]\d)\b/);return v?Number(v[1]):null}
function mileageFrom(text){const v=String(text||'').match(/\b([\d,]{2,8})\s*(?:miles?|mi)\b/i);return v?Number(v[1].replace(/,/g,'')):null;}
function trimTitle(text){return String(text||'').replace(/\s*[|–-]\s*(?:Auto Trader|eBay|PistonHeads|Facebook Marketplace).*$/i,'').slice(0,220).trim()}
function normalRecord({site,url,title,price,image,description,location,year,mileage}){
  let key;try{key=advertIdentity(url)}catch{return null};if(key.site!==site)return null;
  const out={id:key.id,site,url:key.url,title:trimTitle(title),price:money(price),description:trimHtml(description||'').slice(0,1200),image:String(image||'').startsWith('https://')?String(image).slice(0,1500):'',location:String(location||'').slice(0,120),year:Number(year)||yearFrom(title),mileage:Number(mileage)||mileageFrom(title+' '+description)};
  if(!out.title||out.title.length<5||/(sign in|log in|captcha|verification|access denied|error occurred)/i.test(out.title))return null;
  return out;
}
export async function getPage(url,{site=siteFor(url),timeout=16000}={}){
  if(!site||site!==siteFor(url))throw Error('Unsupported car website.');let current=url;
  for(let redirects=0;redirects<3;redirects++){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
    let response;try{response=await fetch(current,{redirect:'manual',signal:controller.signal,headers:{'user-agent':USER_AGENT,'accept':'text/html,application/xhtml+xml','accept-language':'en-GB,en;q=0.8','cache-control':'no-cache'}})}finally{clearTimeout(timer)}
    if(response.status>=300&&response.status<400&&response.headers.get('location')){
      const next=new URL(response.headers.get('location'),current);if(siteFor(next.href)!==site)throw Error('Source redirected away from the supported car website.');current=next.href;continue;
    }
    if(response.status===403||response.status===429||response.status===401)throw Error(SITES[site]+' restricted automated access (HTTP '+response.status+').');
    if(!response.ok)throw Error(SITES[site]+' returned HTTP '+response.status+'.');
    if(!String(response.headers.get('content-type')||'').includes('text/html'))throw Error(SITES[site]+' did not return a listing page.');
    const text=await response.text();if(Buffer.byteLength(text)>MAX_BYTES)throw Error('Page too large to process safely.');
    if(/(?:unusual traffic|please enable javascript|we have detected|verify you are human|captcha challenge)/i.test(text.slice(0,5000)))throw Error(SITES[site]+' requested a browser verification.');
    return {html:text,url:current};
  }throw Error('Too many provider redirects.');
}
const meta=(html,prop)=>html.match(new RegExp('<meta\\s+[^>]*(?:property|name)=["\\\']'+prop.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'["\\\'][^>]*content=["\\\']([^"\\\']+)', 'i'))?.[1]||html.match(new RegExp('<meta\\s+[^>]*content=["\\\']([^"\\\']+)["\\\'][^>]*(?:property|name)=["\\\']'+prop+'["\\\']','i'))?.[1]||'';
export function parseDetail(html,url){
  const site=siteFor(url);if(!site)return null;
  const structured=parseJsonLd(html).find(x=>/Car|Vehicle|Product/i.test(String(x['@type']||'')))||{};
  const offers=structured.offers||{};
  const title=structured.name||meta(html,'og:title')||trimHtml(html.match(/<title[^>]*>([^<]+)/i)?.[1]||'');
  const description=structured.description||meta(html,'og:description')||meta(html,'description');
  const image=typeof structured.image==='string'?structured.image:Array.isArray(structured.image)?structured.image[0]:structured.image?.url||meta(html,'og:image');
  const location=structured.seller?.address?.addressLocality||structured.offers?.seller?.address?.addressLocality||'';
  const price=offers.price||offers.lowPrice||meta(html,'product:price:amount')||String(html.match(/£\s?([\d,]{3,8})/)?.[1]||'');
  return normalRecord({site,url,title,price,image,description,location,year:structured.vehicleModelDate,mileage:structured.mileageFromOdometer?.value});
}
function linkCandidates(html,pageUrl,site){
  const entries=[];const base=new URL(pageUrl);
  for(const m of html.matchAll(/<a\b([^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*)>([\s\S]{0,2200}?)<\/a>/gi)){
    let url;try{url=new URL(htmlDecode(m[2]),base).href;advertIdentity(url)}catch{continue}
    const label=trimHtml(m[1].match(/\baria-label=["']([^"']+)/i)?.[1]||m[3].match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i)?.[1]||m[3]);
    const context=html.slice(Math.max(0,m.index-200),Math.min(html.length,m.index+m[0].length+600));
    const img=context.match(/<img[^>]+(?:src|data-src)=["'](https:[^"']+)/i)?.[1]||'';
    const price=context.match(/£\s?([\d,]{3,8})/)?.[1]||null;
    const candidate=normalRecord({site,url,title:label,price,image:img,description:trimHtml(context).slice(0,500)});
    if(candidate)entries.push(candidate);
  }
  for(const obj of parseJsonLd(html)){
    const urls=[obj.url,obj.item?.url].filter(Boolean);
    for(const input of urls){let url;try{url=new URL(input,pageUrl).href;advertIdentity(url)}catch{continue}
      const candidate=normalRecord({site,url,title:obj.name||obj.item?.name||obj.title,price:obj.offers?.price||obj.item?.offers?.price,image:Array.isArray(obj.image)?obj.image[0]:obj.image||obj.item?.image,description:obj.description||obj.item?.description,location:obj.itemLocation?.addressLocality||obj.seller?.address?.addressLocality});
      if(candidate)entries.push(candidate);
    }
  }
  return [...new Map(entries.map(row=>[row.id,row])).values()];
}
export function parseResults(html,pageUrl,filters={}){
  const site=siteFor(pageUrl);if(!site)return [];
  const rows=linkCandidates(html,pageUrl,site),must=[filters.make,filters.model].filter(Boolean).map(x=>String(x).toLowerCase());
  return rows.filter(row=>{
    const title=row.title.toLowerCase();
    // Facebook's broad Marketplace results are especially noisy; require
    // actual requested make/model in the advert title, not the page body.
    if(site==='facebook'&&!must.every(x=>title.includes(x)))return false;
    if(must.length&&!must.some(x=>title.includes(x)))return false;
    if(filters.priceMax&&row.price&&row.price>filters.priceMax)return false;
    if(filters.priceMin&&row.price&&row.price<filters.priceMin)return false;
    if(filters.mileageMax&&row.mileage&&row.mileage>filters.mileageMax)return false;
    if(filters.yearMin&&row.year&&row.year<filters.yearMin)return false;
    if(filters.yearMax&&row.year&&row.year>filters.yearMax)return false;
    if(filters.transmission==='manual'&&/\b(?:automatic|pdk|dct|dsg|tiptronic)\b/i.test(row.title))return false;
    if(filters.transmission==='automatic'&&/\bmanual\b/i.test(row.title))return false;
    return true;
  });
}
export async function scanSource(link,filters={}){
  try{const {html,url}=await getPage(link.url,{site:link.site,timeout:20000});const items=parseResults(html,url,filters);
    if(!items.length)return {items:[],incomplete:true,caveat:SITES[link.site]+' returned no identifiable adverts. The site may require JavaScript or a signed-in session; previous results were retained.'};
    return {items,incomplete:false,caveat:''};
  }catch(err){return {items:[],incomplete:true,caveat:String(err.message||err).slice(0,220)}}
}
export async function enrichRecord(row){
  const {html,url}=await getPage(row.url,{site:row.site,timeout:14000});return parseDetail(html,url)||{};
}