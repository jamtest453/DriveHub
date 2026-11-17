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
  mapLocationForCar:car=>String(car?.location||'').split(',')[0],
  mapLocationKey:loc=>String(loc||'').toLowerCase(),
  locationPoints:new Map(),
  redrawListingMap:(groups,pending)=>redraws.push({count:groups.length,pending}),
  api:async (path,options)=>{
    assert.equal(path,'/api/map/locations');
    const locations=JSON.parse(options.body).locations;
    assert.deepEqual(locations,['Bristol'],'map only receives cleaned town');
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
assert.equal(redraws.length,redrawCount+1,
  'same data signature must redraw map after returning from list mode');
ctx.ensureMapLibrary=async()=>false;
await show([[{id:'B',location:'London',price:22000}]]);
assert.match(elements.mapCount.textContent,/unavailable/i);
console.log('Map rendering, geocoder lookup and retry checks passed');
