import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../legacy/public/dashboard.html',import.meta.url),'utf8');
function section(a,b) {
  const start=src.indexOf(a),end=src.indexOf(b,start+a.length);
  assert.ok(start>=0&&end>start,'Source section: '+a);
  return src.slice(start,end);
}
assert.match(html,/id="retryLocationMap"/);
assert.match(src,/addEventListener\('click', retryUnmappedLocations\)/);
assert.match(src,/data-map-retry="all"/);
assert.match(src,/reasonFor\(item\)/);

const values={mapCount:{textContent:''},mapSubtitle:{textContent:''},
  unmappedCars:{innerHTML:''}};
const coords=new Map();
const issues=new Map([['hayes (157 miles)',{
  status:'ambiguous',
  reason:'Several UK places match this name. A postcode or county would help.',
  retryable:true
}]]);
const ctx={
  Map,Set,Math,Number,
  $:id=>values[id],listingMap:{setView(){},invalidateSize(){}},
  listingMapLayer:{clearLayers(){}},locationPoints:coords,
  locationIssues:issues,resultsLayout:'map',mapRequestId:0,
  lastMapGroups:[],
  mapLocationForGroup:g=>g[0].location||'',
  mapLocationForCar:car=>car.location||'',
  mapLocationKey:loc=>String(loc).toLowerCase(),
  locationForCar:car=>String(car.location||'').replace(/\s*\([^)]*\)/,''),
  requestAnimationFrame:fn=>fn(),
  esc:x=>String(x||'').replaceAll('&','&amp;').replaceAll('<','&lt;')
};
const redraw=vm.runInNewContext(
  section('function redrawListingMap(groups, pending=0, failed=false) {',
    'async function showListingsMap(groups) {')+'\nredrawListingMap',ctx);
const cars=[
  [{id:'a',title:'BMW M2',location:'Hayes (157 miles)'}],
  [{id:'b',title:'Porsche 911',location:''}]
];
redraw(cars,0);
assert.match(values.unmappedCars.innerHTML,/Several UK places match this name/);
assert.match(values.unmappedCars.innerHTML,/data-map-retry="a"/);
assert.match(values.unmappedCars.innerHTML,/data-map-retry="all"/);
assert.match(values.unmappedCars.innerHTML,/No advertised location supplied/);
assert.match(values.mapCount.textContent,/0 of 2 cars mapped/);

ctx.distanceFailures=new Set(['hayes (157 miles)']);
ctx.api=async(url,options)=>{
  assert.equal(url,'/api/map/locations');
  const body=JSON.parse(options.body);
  assert.equal(body.retry,true,'manual retry must skip negative map cache');
  assert.deepEqual(body.locations,['Hayes (157 miles)']);
  return {locations:[{location:'Hayes (157 miles)',status:'mapped',
    point:{lat:51.5,lng:-.4,label:'Hayes'},retryable:false}]};
};
ctx.rememberLocationResult=row=>{
  ctx.locationPoints.set(row.location.toLowerCase(),row.point);
  ctx.locationIssues.set(row.location.toLowerCase(),row);
};
const retry=vm.runInNewContext(section(
  'async function retryMapLocations(locations) {','function mapCarClick(event) {')+
  '\nretryMapLocations',ctx);
await retry(['Hayes (157 miles)']);
assert.ok(coords.get('hayes (157 miles)').lat);
assert.equal(ctx.distanceFailures.has('hayes (157 miles)'),false);
console.log('Map diagnostics and negative-cache retry controls passed');
