const ROUTE_PROVIDERS = [
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  'https://router.project-osrm.org/route/v1/driving'
];

function json(res,status,data){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(data));
}

function finiteCoord(value){
  const parts=String(value||'').split(',').map(Number);
  if(parts.length!==2||!parts.every(Number.isFinite))return null;
  const [lat,lon]=parts;
  if(lat < -90 || lat > 90 || lon < -180 || lon > 180)return null;
  return {lat,lon};
}

function distanceKm(a,b){
  const R=Math.PI/180,dLat=(b.lat-a.lat)*R,dLon=(b.lon-a.lon)*R;
  const x=dLon*Math.cos((a.lat+b.lat)*0.5*R),y=dLat;
  return 6371*Math.sqrt(x*x+y*y);
}

function sampledSignature(coords=[]){
  if(!coords.length)return'';
  const count=Math.min(18,coords.length),parts=[];
  for(let i=0;i<count;i++){
    const idx=Math.round((coords.length-1)*(i/Math.max(1,count-1))),c=coords[idx];
    parts.push(`${Number(c[0]).toFixed(3)},${Number(c[1]).toFixed(3)}`);
  }
  return parts.join('|');
}

function normaliseOsrmRoute(route,source,label='Direct route'){
  const raw=route?.geometry?.coordinates;
  if(!Array.isArray(raw)||raw.length<2)return null;
  const coords=raw.map(c=>[Number(c?.[1]),Number(c?.[0])]).filter(c=>c.every(Number.isFinite));
  if(coords.length<2)return null;
  const distance=Number(route.distance),duration=Number(route.duration);
  if(!Number.isFinite(distance)||distance<=0||!Number.isFinite(duration)||duration<=0)return null;
  return {
    coords,
    distanceKm:distance/1000,
    durationMins:duration/60,
    source,
    label,
    signature:sampledSignature(coords)
  };
}

async function fetchJson(url,fetchImpl,timeoutMs=9000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetchImpl(url,{headers:{'user-agent':'DriveHub-RoadFinder/1.0','accept':'application/json'},signal:controller.signal});
    if(!res.ok)throw new Error(`routing provider ${res.status}`);
    const data=await res.json();
    if(data?.code && data.code!=='Ok')throw new Error(`routing provider ${data.code}`);
    return data;
  }finally{clearTimeout(timer)}
}

function routeUrl(base,points,alternatives=false){
  const path=points.map(p=>`${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const params=new URLSearchParams({overview:'full',geometries:'geojson',steps:'false',continue_straight:'false',alternatives:String(Boolean(alternatives))});
  return `${base}/${path}?${params}`;
}

// Server-side routing is deliberately simple: route the exact points DriveHub
// asks for. The browser owns the higher-level strategy (direct route first,
// then selected high-quality nearby roads as optional waypoints).
export async function findA2BRoutes(start,end,{via=[],fetchImpl=globalThis.fetch,providers=ROUTE_PROVIDERS,label='Direct route',alternatives=false}={}){
  if(typeof fetchImpl!=='function')throw new Error('Routing fetch is unavailable');
  const straight=distanceKm(start,end);
  if(straight>120)throw new Error('Distance is too great for A-to-B routing (>120km).');
  const points=[start,...(Array.isArray(via)?via:[]),end];
  const attempts=providers.map(async provider=>{
    const data=await fetchJson(routeUrl(provider,points,alternatives),fetchImpl,6500);
    const routes=(data?.routes||[]).map(r=>normaliseOsrmRoute(r,provider,label)).filter(Boolean);
    if(!routes.length)throw new Error('Routing provider returned no usable route.');
    return routes.slice(0,alternatives?3:1);
  });
  try{return await Promise.any(attempts)}
  catch(err){
    const reasons=Array.isArray(err?.errors)?err.errors:[];
    throw reasons.find(Boolean)||new Error('No routing provider returned a route.');
  }
}

export function roadFinderStatus(){return {roadFinder:{configured:true,backend:'direct-route-plus-corridor'}}}

export async function handleRoadFinderApi(req,res,pathname,requestUrl){
  if(pathname==='/api/roads/status'&&req.method==='GET'){
    json(res,200,roadFinderStatus());
    return true;
  }
  if(pathname==='/api/roads/a2b'&&req.method==='GET'){
    const url=requestUrl||new URL(req.url,'http://localhost');
    const start=finiteCoord(url.searchParams.get('start')),end=finiteCoord(url.searchParams.get('end'));
    if(!start||!end){json(res,400,{error:'Valid start and end coordinates are required.',code:'INVALID_COORDINATES'});return true}
    const via=url.searchParams.getAll('via').map(finiteCoord).filter(Boolean);
    const label=String(url.searchParams.get('label')|| (via.length?'Better-road alternative':'Direct route')).slice(0,100);
    const alternatives=url.searchParams.get('alternatives')==='1'||url.searchParams.get('alternatives')==='true';
    try{
      const routes=await findA2BRoutes(start,end,{via,label,alternatives});
      json(res,200,{routes,provider:routes[0]?.source||null});
    }catch(err){
      const msg=String(err?.message||'A-to-B routing failed.');
      const status=msg.includes('>120km')?400:502;
      json(res,status,{error:msg,code:status===400?'ROUTE_TOO_LONG':'ROUTING_UNAVAILABLE'});
    }
    return true;
  }
  return false;
}
