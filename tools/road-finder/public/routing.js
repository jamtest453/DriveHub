(function(global){'use strict';
const RF=global.RoadFinderCore=global.RoadFinderCore||{};
function normaliseOneway(tags={}){const r=String(tags.oneway||'').trim().toLowerCase();if(r==='-1'||r==='reverse')return-1;if(['yes','1','true'].includes(r))return 1;if(['no','0','false'].includes(r))return 0;if(String(tags.junction||'').toLowerCase()==='roundabout')return 1;return 0}
function extractTurnRestrictions(elements=[]){const index=new Map();index.viaWayRestrictions=[];index.maxContextWays=1;for(const el of elements||[]){if(el?.type!=='relation'||el?.tags?.type!=='restriction')continue;const tags=el.tags||{},except=new Set(String(tags.except||'').toLowerCase().split(/[;,]/).map(x=>x.trim()).filter(Boolean));if(except.has('motorcar')||except.has('motor_vehicle')||except.has('vehicle'))continue;const restriction=String(tags['restriction:motorcar']||tags.restriction||'').toLowerCase();if(!restriction||(!restriction.startsWith('no_')&&!restriction.startsWith('only_')))continue;const members=Array.isArray(el.members)?el.members:[],fromWays=members.filter(m=>m?.type==='way'&&m.role==='from').map(m=>String(m.ref)),toWays=members.filter(m=>m?.type==='way'&&m.role==='to').map(m=>String(m.ref)),viaNodes=members.filter(m=>m?.type==='node'&&m.role==='via').map(m=>String(m.ref)),viaWays=members.filter(m=>m?.type==='way'&&m.role==='via').map(m=>String(m.ref)),kind=restriction.startsWith('only_')?'only':'no';if(!fromWays.length||!toWays.length)continue;if(viaNodes.length){for(const viaNode of viaNodes)for(const fromWay of fromWays){const key=`${viaNode}|${fromWay}`,row={id:String(el.id||''),kind,restriction,toWays:new Set(toWays)};if(!index.has(key))index.set(key,[]);index.get(key).push(row)}}if(viaWays.length){index.maxContextWays=Math.max(index.maxContextWays,viaWays.length+1);for(const fromWay of fromWays)index.viaWayRestrictions.push({id:String(el.id||''),kind,restriction,fromWay,viaWays:[...viaWays],toWays:new Set(toWays)})}}return index}
function turnAllowed(previousEdge,nextEdge,index){if(!previousEdge||!nextEdge||!(index instanceof Map)||!index.size)return true;const via=previousEdge.toNodeId!=null?String(previousEdge.toNodeId):'',from=previousEdge.sourceWayId!=null?String(previousEdge.sourceWayId):'',to=nextEdge.sourceWayId!=null?String(nextEdge.sourceWayId):'';if(!via||!from||!to)return true;const rows=index.get(`${via}|${from}`);if(!rows?.length)return true;for(const row of rows){if(row.kind==='no'&&row.toWays.has(to))return false;if(row.kind==='only'&&!row.toWays.has(to))return false}return true}
function compressedWaySequence(path=[]){const out=[];for(const edge of path||[]){const id=edge?.sourceWayId!=null?String(edge.sourceWayId):'';if(id&&out[out.length-1]!==id)out.push(id)}return out}
function routingStateKey(nodeKey,path,index){if(!(index instanceof Map)||(!index.size&&!(index.viaWayRestrictions||[]).length))return String(nodeKey);const depth=Math.max(1,Number(index?.maxContextWays||1)),seq=compressedWaySequence(path).slice(-depth);return `${nodeKey}|${seq.join('>')}`}
function pathTransitionAllowed(path,nextEdge,index){const previous=Array.isArray(path)&&path.length?path[path.length-1]:null;if(previous&&!turnAllowed(previous,nextEdge,index))return false;if(!(index instanceof Map)||!Array.isArray(index.viaWayRestrictions)||!index.viaWayRestrictions.length)return true;const nextWay=nextEdge?.sourceWayId!=null?String(nextEdge.sourceWayId):'';if(!nextWay)return true;const seq=compressedWaySequence(path);for(const row of index.viaWayRestrictions){const prefix=[String(row.fromWay),...(row.viaWays||[]).map(String)];if(seq.length<prefix.length)continue;let match=true;for(let i=0;i<prefix.length;i++)if(seq[seq.length-prefix.length+i]!==prefix[i]){match=false;break}if(!match)continue;const lastVia=prefix[prefix.length-1];if(nextWay===lastVia)continue;if(row.kind==='no'&&row.toWays.has(nextWay))return false;if(row.kind==='only'&&!row.toWays.has(nextWay))return false}return true}

function pathEdgeKey(edge={}){return String(edge.segmentId||edge.roadId||`${edge.sourceWayId||''}:${edge.fromNodeId||''}>${edge.toNodeId||''}`)}
function pathOverlapRatio(a=[],b=[]){const toMap=path=>{const m=new Map();let total=0;for(const edge of path||[]){const k=pathEdgeKey(edge),len=Math.max(0,Number(edge?.len||0));if(!k||!len)continue;m.set(k,(m.get(k)||0)+len);total+=len}return{m,total}},x=toMap(a),y=toMap(b);if(!x.total||!y.total)return 0;let shared=0;for(const[k,len]of x.m)if(y.m.has(k))shared+=Math.min(len,y.m.get(k));return Math.max(0,Math.min(1,shared/Math.min(x.total,y.total)))}

// Loop routing works over a reduced graph rather than the whole tiled download:
// everything within a plausible loop radius of the search origin, restricted to
// the one connected component that the origin actually sits in. Without the
// component restriction, waypoint selection can pick a node on an unreachable
// island and every path search from it fails.
function nodeKeyCoord(key){const i=String(key).indexOf(',');if(i<0)return null;const lat=Number(String(key).slice(0,i)),lon=Number(String(key).slice(i+1));return Number.isFinite(lat)&&Number.isFinite(lon)?[lat,lon]:null}
function metresBetween(lat1,lon1,lat2,lon2){const R=Math.PI/180,dLat=(lat2-lat1)*R,dLon=(lon2-lon1)*R,x=dLon*Math.cos((lat1+lat2)*0.5*R);return 6371000*Math.sqrt(x*x+dLat*dLat)}
function buildCircularRoutingGraph(fullGraph,origin,maxRouteKm=50){
  if(!(fullGraph instanceof Map)||!fullGraph.size)return{graph:new Map(),nodeKeys:[]};
  const wholeGraph={graph:fullGraph,nodeKeys:[...fullGraph.keys()]};
  const originCoord=Array.isArray(origin)&&Number.isFinite(Number(origin[0]))&&Number.isFinite(Number(origin[1]))?[Number(origin[0]),Number(origin[1])]:null;
  if(!originCoord)return wholeGraph;

  // A closed loop of total length D encloses a region of radius about D/(2*PI).
  // Keep generous headroom so long, lopsided but legitimate loops survive.
  const radiusM=Math.max(3000,Math.min(60000,(Number(maxRouteKm)||50)*1000*0.55));
  const inRange=new Set();
  for(const key of fullGraph.keys()){
    const c=nodeKeyCoord(key);
    if(c&&metresBetween(originCoord[0],originCoord[1],c[0],c[1])<=radiusM)inRange.add(key);
  }
  if(inRange.size<3)return wholeGraph;

  // Keep only edges with both endpoints inside the working area, so a path
  // cannot leave it and silently re-enter through untracked geometry.
  const pruned=new Map(),neighbours=new Map();
  const link=(a,b)=>{if(!neighbours.has(a))neighbours.set(a,new Set());neighbours.get(a).add(b)};
  for(const key of inRange){
    const edges=(fullGraph.get(key)||[]).filter(edge=>inRange.has(edge&&edge.targetKey));
    if(!edges.length)continue;
    pruned.set(key,edges);
    for(const edge of edges){link(key,edge.targetKey);link(edge.targetKey,key)}
  }
  if(pruned.size<3)return wholeGraph;

  // Flood the weakly-connected component containing the node nearest the origin.
  let seed=null,seedDist=Infinity;
  for(const key of pruned.keys()){
    const c=nodeKeyCoord(key);if(!c)continue;
    const d=metresBetween(originCoord[0],originCoord[1],c[0],c[1]);
    if(d<seedDist){seedDist=d;seed=key}
  }
  if(!seed)return wholeGraph;
  const component=new Set([seed]),queue=[seed];
  while(queue.length){
    const key=queue.pop();
    for(const next of neighbours.get(key)||[]){if(component.has(next))continue;component.add(next);queue.push(next)}
  }

  const graph=new Map();
  for(const key of component){
    const edges=(pruned.get(key)||[]).filter(edge=>component.has(edge.targetKey));
    if(edges.length)graph.set(key,edges);
  }
  const nodeKeys=[...graph.keys()];
  return nodeKeys.length>=3?{graph,nodeKeys}:wholeGraph;
}


// Choosing where to snap an A-to-B endpoint onto the graph. Graph nodes are per
// geometry vertex, so the nearest few points to a dropped pin are nearly always
// on one short way — very often a driveway, car-park aisle or service stub that
// is not joined to the through network. Simply taking the N nearest nodes spends
// every snap slot on that dead end, the start and end never share a connected
// component, and routing reports no route where one plainly exists. Capping how
// many candidates any one component or source road may contribute guarantees the
// real road network is represented.
function diversifySnapCandidates(rows=[],options={}){
  const limit=Math.max(1,Number(options.limit)||8);
  const radiusKm=Number(options.radiusKm);
  const perComponentCap=Math.max(1,Number(options.perComponent)||3);
  const perRoadCap=Math.max(1,Number(options.perRoad)||2);
  const usable=rows.filter(row=>row&&Number(row.degree||0)>0)
    .slice()
    .sort((a,b)=>(Number(a.distanceKm||0)-Number(b.distanceKm||0))||(Number(b.degree||0)-Number(a.degree||0)));
  if(!usable.length)return[];
  const componentSeen=new Map(),roadSeen=new Map(),picked=[];
  for(const row of usable){
    const component=String(row.component??''),road=String(row.sourceRoad??'');
    const componentCount=componentSeen.get(component)||0,roadCount=road?(roadSeen.get(road)||0):0;
    if(componentCount>=perComponentCap)continue;
    if(road&&roadCount>=perRoadCap)continue;
    if(picked.length>=limit&&Number.isFinite(radiusKm)&&Number(row.distanceKm||0)>radiusKm)break;
    componentSeen.set(component,componentCount+1);
    if(road)roadSeen.set(road,roadCount+1);
    picked.push(row);
    if(picked.length>=limit*2)break;
  }
  return picked.length?picked:usable.slice(0,limit);
}



// Round-trip anchor selection -------------------------------------------------
// A round trip should be built from the best roads that are actually available
// around the chosen start, not from arbitrary geometric waypoints.  This helper
// ranks one road per angular sector, with Road Score as the dominant signal and
// only modest penalties for being off the ideal loop radius/bearing.  app.js
// then routes through the returned roads and closes the drive back to the start.
function selectScoreChainedRoadAnchors(roads=[],origin,targetRadiusKm,rotation=0,direction=1,options={}){
  const lat0=Number(origin?.[0]),lon0=Number(origin?.[1]),radius=Math.max(.5,Number(targetRadiusKm)||1);
  if(!Number.isFinite(lat0)||!Number.isFinite(lon0)||!Array.isArray(roads)||!roads.length)return[];
  const count=Math.max(2,Math.min(5,Number(options.count)||3));
  const minScore=Math.max(0,Number(options.minScore)||30);
  const maxAngle=Math.max(25,Math.min(85,Number(options.maxAngle)||62));
  const used=new Set(),out=[];
  const bearing=(lat1,lon1,lat2,lon2)=>{const r=Math.PI/180,dLon=(lon2-lon1)*r,a=lat1*r,b=lat2*r;return(Math.atan2(Math.sin(dLon)*Math.cos(b),Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(dLon))/r+360)%360};
  const angleDiff=(a,b)=>Math.abs(((a-b+540)%360)-180);
  const rows=[];
  for(const road of roads){
    if(!road||used.has(String(road.id)))continue;
    const score=Number(road.score||0),coords=road.coords;
    if(score<minScore||!Array.isArray(coords)||coords.length<2)continue;
    const mid=coords[Math.floor((coords.length-1)/2)];
    if(!Array.isArray(mid)||mid.length<2)continue;
    const lat=Number(mid[0]),lon=Number(mid[1]);if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
    const d=metresBetween(lat0,lon0,lat,lon)/1000;
    if(d<Math.max(.35,radius*.22)||d>radius*2.05)continue;
    rows.push({road,score,d,bearing:bearing(lat0,lon0,lat,lon),len:Math.max(0,Number(road.len)||0),confidence:Math.max(0,Math.min(100,Number(road.confidence)||55))});
  }
  if(!rows.length)return[];
  for(let i=0;i<count;i++){
    const target=(Number(rotation)+Number(direction||1)*i*(360/count)+3600)%360;
    let best=null,bestUtility=-Infinity;
    for(const row of rows){
      const id=String(row.road.id);if(used.has(id))continue;
      const aerr=angleDiff(row.bearing,target);if(aerr>maxAngle)continue;
      const radialErr=Math.abs(row.d-radius)/radius;
      // Road Score deliberately dominates.  Radius and angle only stop all
      // anchors collapsing onto one side of the start point.
      const utility=row.score*.64+row.confidence*.07+Math.min(10,row.len)*1.15-aerr*.22-radialErr*16;
      if(utility>bestUtility){bestUtility=utility;best=row}
    }
    if(!best)continue;
    used.add(String(best.road.id));out.push({...best,targetBearing:target,utility:bestUtility});
  }
  return out;
}



// Produce a deliberately small set of strong round-trip road chains before any
// expensive graph routing begins.  v141.8 tried every distance/rotation/
// direction combination (54 chains) and then ran several path searches per
// chain.  On a dense OSM graph that could monopolise the browser for minutes.
// This planner performs the cheap Road Score selection first, de-duplicates the
// resulting chains, and returns only the strongest few for actual routing.
function planScoreChainedRoundTrips(roads=[],origin,targetRadiusKm,options={}){
  const limit=Math.max(1,Math.min(12,Number(options.limit)||8));
  const rotations=Array.isArray(options.rotations)&&options.rotations.length
    ? options.rotations : [0,60,120,180,240,300];
  const directions=Array.isArray(options.directions)&&options.directions.length
    ? options.directions : [1,-1];
  const rows=[],seen=new Set();
  for(const rotation of rotations){
    for(const direction of directions){
      const anchors=selectScoreChainedRoadAnchors(roads,origin,targetRadiusKm,rotation,direction,options);
      if(anchors.length<2)continue;
      const ids=anchors.map(row=>String(row.road?.id||'')).filter(Boolean);
      if(ids.length<2)continue;
      // Direction is irrelevant to uniqueness: the same three roads in reverse
      // order are still the same candidate loop.
      const signature=[...ids].sort().join('|');
      if(seen.has(signature))continue;
      seen.add(signature);
      const avgScore=anchors.reduce((sum,row)=>sum+Number(row.score||row.road?.score||0),0)/anchors.length;
      const avgUtility=anchors.reduce((sum,row)=>sum+Number(row.utility||0),0)/anchors.length;
      rows.push({anchors,rotation,direction,avgScore,utility:avgUtility,signature});
    }
  }
  rows.sort((a,b)=>(b.avgScore-a.avgScore)||(b.utility-a.utility));
  return rows.slice(0,limit);
}

Object.assign(RF,{normaliseOneway,extractTurnRestrictions,turnAllowed,pathTransitionAllowed,routingStateKey,pathEdgeKey,pathOverlapRatio,buildCircularRoutingGraph,diversifySnapCandidates,selectScoreChainedRoadAnchors,planScoreChainedRoundTrips});
})(globalThis);
