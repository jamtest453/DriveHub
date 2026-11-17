import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
function section(a,b) {
  const from=source.indexOf(a),to=source.indexOf(b,from+1);
  assert.ok(from>=0&&to>from,'Missing map function: '+a);
  return source.slice(from,to);
}
assert.match(source,/async function ensureMapLibrary\(\)/);
assert.match(source,/unpkg\.com\/leaflet@1\.9\.4/);
assert.match(source,/void showListingsMap\(groups\)\.catch/);
assert.match(source,/redrawListingMap\(groups,0\)/);

let requests=0;
const redraws=[];
const elements={
  mapCount:{textContent:''},mapSubtitle:{textContent:''}
};
const ctx={
  Map,Set,JSON,Number,console,
  mapShown:false,mapRequestId:0,mapSignature:'',resultsLayout:'map',
  listingMap:{invalidateSize(){}},
  $:id=>elements[id],
  requestAnimationFrame:fn=>fn(),
  ensureMapLibrary:async()=>true,
  initListingMap:()=>true,
  mapLocationForCar:car=>String(car?.location||''),
  mapLocationKey:loc=>String(loc||'').toLowerCase(),
  locationPoints:new Map(),
  locationIssues:new Map(),
  rememberLocationResult:row=>ctx.locationPoints.set(
    String(row.location||'').toLowerCase(),row.point||null),
  redrawListingMap:(groups,pending)=>redraws.push({count:groups.length,pending}),
  api:async (path,options)=>{
    assert.equal(path,'/api/map/locations');
    const locations=JSON.parse(options.body).locations;
    assert.deepEqual(locations,['Bristol, BS1 1AA'],
      'map receives full postcode, not just the visible town label');
    requests++;
    return {locations:locations.map(location=>({location,point:{
      lat:51.45,lng:-2.59,label:'Bristol',precision:'Town centre (approx.)'
    }}))};
  }
};
const show=vm.runInNewContext(
  section('async function showListingsMap(groups) {','function mapCarClick(event) {')+
  '\nshowListingsMap',ctx);
const groups=[[{id:'A',location:'Bristol, BS1 1AA',price:23000}]];
await show(groups);
assert.equal(requests,1,'initial map resolves a location');
assert.ok(redraws.length>=2,'map paints while resolving and again when loaded');
const redrawCount=redraws.length;
await show(groups);
assert.equal(requests,1,'same view reuses geocodes');
assert.ok(redraws.length>redrawCount,
  'same data signature must redraw map after returning from list mode');
ctx.ensureMapLibrary=async()=>false;
await show([[{id:'B',location:'London',price:22000}]]);
assert.match(elements.mapCount.textContent,/unavailable/i);
// Regression: distance lookup polling can repaint a map while its original
// geocoder request is pending. The replacement must still finish missing
// locations, even when the listing data signature is identical.
ctx.ensureMapLibrary=async()=>true;
let raceCalls=0,releaseFirst;
const raceGroups=[[{id:'C',location:'Newport',price:17000}]];
ctx.api=async(path,options)=>{
  raceCalls++;
  const locations=JSON.parse(options.body).locations;
  assert.deepEqual(locations,['Newport']);
  if(raceCalls===1) return new Promise(resolve=>{releaseFirst=resolve});
  return {locations:[{location:'Newport',point:{
    lat:51.587,lng:-2.997,label:'Newport',precision:'Town centre (approx.)'
  }}]};
};
const first=show(raceGroups);
// The async function runs in a separate VM microtask context. Flush one
// event-loop tick before asserting the first network request has started.
await new Promise(resolve=>setImmediate(resolve));
assert.equal(raceCalls,1);
await show(raceGroups);
assert.equal(raceCalls,2,'map must continue resolving still-missing towns after an interrupted render');
assert.ok(ctx.locationPoints.has('newport'));
releaseFirst({locations:[{location:'Newport',point:null}]});
await first;
console.log('Map rendering, geocoder lookup and retry checks passed');
