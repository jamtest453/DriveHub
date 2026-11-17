import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../legacy/public/dashboard.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../legacy/public/drivehub-theme.css',import.meta.url),'utf8');
const section=(start,end)=>{
  const a=code.indexOf(start), b=code.indexOf(end,a);
  assert.ok(a>=0 && b>a,'Missing dashboard functions: '+start);
  return code.slice(a,b);
};

assert.match(html,/id="searchesPage"/,'dedicated Searches page must exist');
assert.match(css,/\.saved-search-row\{/,'Searches list has a responsive row layout');
assert.match(code,/view === 'searches' \|\| view\.startsWith\('search:'\)/,'detail results highlight Searches tab');
assert.match(code,/if \(onSearchesPage\) \{[\s\S]*renderSearchesPage\(\);[\s\S]*return;/,'Searches page replaces results, not an overlay');
assert.match(code,/return view !== 'searches';/,'distance lookup runs on normal listing views');

// Sample same-car adverts must count as one vehicle, including update totals.
const state={
  searches:[{
    id:'s1',name:'BMW M2',lastChecked:'2026-11-17T08:45:00Z',
    links:[{site:'autotrader'},{site:'ebay'}],
    lastReport:{newIds:['a'],changedIds:['b']}
  }],
  listings:{
    a:{id:'a',group:'car1'},b:{id:'b',group:'car1'},c:{id:'c',group:'car2'}
  }
};
let searchesHtml='';
const context={
  state,scanBusy:false,scanSearchIds:[],Date,Intl,Set,
  $:id=>{assert.equal(id,'searchesPage');return {
    get innerHTML(){return searchesHtml},
    set innerHTML(value){searchesHtml=value}
  }},
  visibleSearchIds:()=>['a','b','c'],
  visibleGroupedCars:()=>[...Map.groupBy(Object.values(state.listings),row=>row.group).values()],
  grouped:rows=>[...Map.groupBy(rows,row=>row.group).values()],
  older:()=> '1h ago',
  esc:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;'),
  displaySite:site=>'<span>'+site+'</span>'
};
const searches=vm.runInNewContext(section('function summaryForSearch(','function renderNav(')+
  '\n({summary:summaryForSearch(state.searches[0]),render:renderSearchesPage})',context);
assert.deepEqual(JSON.parse(JSON.stringify(searches.summary)),{
  found:2,added:1,priceChanges:1,updates:1
},'one deduplicated vehicle with both new and changed advert is one update');
searches.render();
assert.match(searchesHtml,/17 Nov 2026/);
assert.match(searchesHtml,/1h ago/);
assert.match(searchesHtml,/Cars found<\/dt><dd>2/);
assert.match(searchesHtml,/Updates<\/dt><dd>1/);
assert.match(searchesHtml,/1 new · 1 price changes/);
assert.match(searchesHtml,/data-action="refresh" data-id="s1"/);
assert.match(searchesHtml,/data-action="view" data-view="search:s1"/);
assert.match(searchesHtml,/Open results/);
// A search's own button remains visibly refreshing until scan status is complete.
context.scanBusy=true;
context.scanSearchIds=['s1'];
searches.render();
assert.match(searchesHtml,/is-refreshing/);
assert.match(searchesHtml,/↻ Refreshing…/);
assert.equal((searchesHtml.match(/Refreshing…/g)||[]).length,1,
  'only the refresh button shows the active state, not an extra status line');
assert.doesNotMatch(searchesHtml,/saved-search-progress|data-refresh-status/);
assert.doesNotMatch(css,/\.saved-search-progress/);
context.scanBusy=false;
context.scanSearchIds=[];
searches.render();
assert.doesNotMatch(searchesHtml,/is-refreshing/);
assert.match(searchesHtml,/↻ Refresh now/);

assert.match(code,/data-action="edit-car" data-id=/,'Edit details available directly on result cards');
assert.match(code,/function baseGroupsForView\(/,'result grouping is memoised across UI filters');
assert.match(code,/if \(nav.innerHTML !== markup\)/,'shared navigation updated only when content changes');
assert.match(code,/else if \(wasBusy !== scanBusy\) render\(\);/,'polling avoids rebuilding every page while scanning');
assert.match(code,/scanSearchIds=scanBusy \?/,'refresh target updates from server status');
assert.match(code,/if \(!manualEditId\) \{/,'Editing a tracked advert preserves the current page');
assert.doesNotMatch(code,/Select a saved car to edit/);
assert.doesNotMatch(code,/car\.colourSource === 'photo'/);
assert.doesNotMatch(code,/Estimated from photo/);

// Changing tabs must never add every individual search to the header.
let navHtml='';
vm.runInNewContext(section('function renderNav()','function renderSources(')+
  '\nrenderNav()',{
    state,view:'search:s1', $:()=>({
      set innerHTML(value){navHtml=value}
    }),savedCarCount:()=>0
  });
assert.match(navHtml,/data-view="searches"/);
assert.match(navHtml,/data-view="overview"/);
assert.match(navHtml,/data-view="saved"/);
assert.doesNotMatch(navHtml,/data-view="search:s1"/);

// Map location lookups use only the actual place, even when imported adverts
// carry display-only mileage or contradictory-provider indicators.
const placeFns=vm.runInNewContext(section('function postcodeOnlyLocation(','function milesForGroup(')+
  '\n({cleanAdvertLocation,locationForCar,mapLocationForCar,postcodeOnlyLocation})');
assert.equal(placeFns.cleanAdvertLocation('Hayes (157 miles) · multiple locations'),'Hayes');
assert.equal(placeFns.cleanAdvertLocation('Hayes (multiple locations)'),'Hayes');
assert.equal(placeFns.cleanAdvertLocation('Hayes, multiple locations'),'Hayes');
assert.equal(placeFns.cleanAdvertLocation('Hayes (157 mi)'),'Hayes');
assert.equal(placeFns.cleanAdvertLocation('Multiple locations'),'');
assert.equal(placeFns.cleanAdvertLocation('Bristol, BS1 1AA'),'Bristol');
assert.equal(placeFns.cleanAdvertLocation('High Lane, SK12'),'High Lane');
assert.equal(placeFns.cleanAdvertLocation('SK12 2NL, High Lane'),'High Lane');
assert.equal(placeFns.cleanAdvertLocation('Manchester M2 (28 miles)'),'Manchester');
assert.equal(placeFns.cleanAdvertLocation('Sutton Coldfield · 28 miles away'),'Sutton Coldfield');
assert.equal(placeFns.cleanAdvertLocation('Newport, Isle of Wight, PO30'),'Newport, Isle of Wight');
assert.equal(placeFns.cleanAdvertLocation('SW1A 1AA'),'');
assert.equal(placeFns.cleanAdvertLocation('SK12'),'');
assert.equal(placeFns.locationForCar({location:'High Lane, Cheshire, SK12 2NL'}),'High Lane');
assert.equal(placeFns.locationForCar({location:'Bristol BS1 1AA'}),'Bristol');
assert.equal(placeFns.locationForCar({location:'SW1A 1AA'}),'');
assert.equal(placeFns.mapLocationForCar({location:'SK12 2NL'}),'SK12 2NL');
assert.equal(placeFns.mapLocationForCar({location:'M2'}),'');
const mapFns=vm.runInNewContext(section('function mapLocationForGroup(','async function showCarLocation(')+
  '\n({mapLocationForGroup,mapLocationKey})',{
    locationForCar:placeFns.locationForCar,
    mapLocationForCar:placeFns.mapLocationForCar,
    cleanAdvertLocation:placeFns.cleanAdvertLocation,
    postcodeOnlyLocation:placeFns.postcodeOnlyLocation,locationPoints:new Map()
  });
assert.equal(mapFns.mapLocationKey('Hayes (157 miles)'),'hayes (157 miles)');
assert.equal(placeFns.mapLocationForCar({location:'Hayes (157 miles) · multiple locations'}),
  'Hayes (157 miles)');
assert.equal(mapFns.mapLocationForGroup([
  {location:'multiple locations'},{location:'Hayes (157 miles) · multiple locations'}
]),'Hayes (157 miles)');
assert.equal(mapFns.mapLocationForGroup([
  {location:'Manchester (21 miles)'},{location:'SK12 2NL'}
]),'SK12 2NL');
assert.equal(mapFns.mapLocationKey('Bristol, BS1 1AA'),'bristol, bs1 1aa');
assert.equal(mapFns.mapLocationKey('Bristol, BS1'),'bristol, bs1');
assert.equal(mapFns.mapLocationKey('SK12 2NL'),'sk12 2nl');
assert.equal(mapFns.mapLocationForGroup([{location:'SK12 2NL'}]),'SK12 2NL');
assert.equal(mapFns.mapLocationForGroup([{location:'SK12'}]),'');
assert.equal(placeFns.mapLocationForCar({location:'Bristol, BS1 1AA'}),
  'Bristol, BS1 1AA');
assert.equal(placeFns.mapLocationForCar({location:'Hayes · 157 miles away'}),
  'Hayes · 157 miles away');

// Distance stays inside the clickable location, in brackets, with no separate chip.
const car={
  id:'a',title:'BMW M2',year:2017,mileage:52000,location:'Hayes (150 miles) · multiple locations',
  image:'',price:24500,site:'autotrader',
  combinedMeta:{fields:{mileage:{display:'52,000 miles'},location:{conflict:true}}}
};
const cardCtx={
  Set,Intl,Math,SITE_NAMES:{autotrader:'Auto Trader'},
  combinedCarDetails:()=>car,matchingColourAdvert:()=>car,
  matchesResultFilters:()=>true,milesForGroup:()=>157.3,
  effectiveTransmission:()=>'',exteriorColour:()=>'',bodyTypeForCar:()=>'',bestPhotoMatch:()=>null,
  imageUrl:()=>'',linkUrl:()=>'',getSearch:()=>null,
  hasSeparatedMatches:()=>false,when:()=> '17 Nov',
  fmtPrice:()=> '£24,500',esc:value=>String(value),
  locationForCar:placeFns.locationForCar,
  mapLocationForGroup:mapFns.mapLocationForGroup,
  state:{manualDuplicates:{}},mergeFrom:null
};
const renderCard=vm.runInNewContext(section('function renderCard(','function openCarDetails(')+'\nrenderCard',cardCtx);
const result=renderCard([{id:'a',site:'autotrader',price:24500,location:car.location}],{
  newIds:new Set(),changedIds:new Set()
});
assert.match(result,/Hayes <span class="car-location-distance">\(157 miles\)<\/span>/);
assert.doesNotMatch(result,/≈157 mi/);
assert.match(result,/data-action="location-map"/);
assert.doesNotMatch(result,/SK12 2NL|postcode/i);
car.location='Bristol, BS1 1AA';
const namedCard=renderCard([{id:'a',site:'autotrader',price:24500,location:car.location}],{
  newIds:new Set(),changedIds:new Set()
});
assert.match(namedCard,/>Bristol/);
assert.doesNotMatch(namedCard,/BS1 1AA/);
car.location='Hayes (150 miles) · multiple locations';
assert.doesNotMatch(result,/multiple locations/i,
  'provider conflict hints never contaminate listing location or map text');
console.log('Saved Searches page, deduplicated updates and inline distance checks passed');
