import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../legacy/public/dashboard.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../legacy/public/drivehub-theme.css',import.meta.url),'utf8');
function section(from,to) {
  const a=code.indexOf(from),b=code.indexOf(to,a+from.length);
  assert.ok(a>=0 && b>a,'Cannot locate implementation: '+from);
  return code.slice(a,b);
}
assert.match(html,/<option value="priceMileage">Best price vs mileage<\/option>/);
assert.match(css,/\.price-value-great\{/);
assert.match(css,/\.price-value-poor\{/);
assert.match(code,/sort==='priceMileage'/);
assert.match(code,/comparePriceMileageGroups\(a,b,valueRatings\)/);
assert.match(code,/valueRatings\.get\(g\[0\]\.id\)/);
assert.match(code,/price-value-indicator/);

// Run actual production scoring and identity logic with minimal UI-independent
// dependencies. One grouped vehicle remains one comparable, not each advert.
const actual=section('function vehicleIdentity(','function photoDistance(')+
  '\n'+section('function priceMileageVariant(','function renderResults(');
const ctx={Number,Math,Map,Set,
  combinedCarDetails:g=>g[0],
  matchesResultFilters:()=>true,
  effectiveTransmission:car=>car.transmission || ''
};
const scoring=vm.runInNewContext(actual+
  '\n({priceMileageRatings,comparePriceMileageGroups,priceMileageVariant})',ctx);
const car=(id,price,mileage,other={})=>[{
  id,title:'2017 BMW M2 DCT',year:2017,price,mileage,transmission:'automatic',
  ...other
}];
const sample=[
  car('a',22000,20000),
  car('b',24500,55000),
  car('c',26000,75000),
  car('d',30000,95000)
];
const ratings=scoring.priceMileageRatings(sample);
assert.equal(ratings.get('a').label,'Great price');
assert.equal(ratings.get('b').label,'Good price');
assert.equal(ratings.get('c').label,'High price');
assert.equal(ratings.get('d').label,'Poor price');
assert.equal(ratings.get('a').peers,4);
assert.deepEqual([...sample].sort((a,b)=>
  scoring.comparePriceMileageGroups(a,b,ratings)).map(g=>g[0].id),['a','b','c','d']);

// Do not mislabel different trims or model years as market comparables.
const separate=scoring.priceMileageRatings([
  ...sample,
  car('comp',18000,15000,{title:'2017 BMW M2 Competition'}),
  car('2021',18500,10000,{year:2021,title:'2021 BMW M2 DCT'}),
  car('other',19500,20000,{title:'2017 BMW M4 DCT'})
]);
for(const id of ['comp','2021','other']) {
  assert.equal(separate.get(id).label,'Not rated',id);
  assert.equal(separate.get(id).score,null,id);
}
assert.equal(separate.get('a').peers,4,'unrelated cars must not dilute the sample');

// Different adverts for one vehicle do not inflate comparison counts.
const duplicated=[
  [sample[0][0],{...sample[0][0],id:'a2',price:22500,site:'ebay'}],
  ...sample.slice(1)
];
assert.equal(scoring.priceMileageRatings(duplicated).get('a').peers,4);

// Unreliable/missing data cannot receive an unwarranted "Great price" badge.
const unknown=scoring.priceMileageRatings([
  ...sample,car('unknown',23000,null),
  car('noPrice',null,15000)
]);
assert.equal(unknown.get('unknown').label,'Not rated');
assert.equal(unknown.get('noPrice').label,'Not rated');

// Sort still works when there are only two ads (not enough for a price badge).
const tiny=[car('cheapHighMiles',24000,90000),
  car('slightlyDearerLowMiles',25500,20000)];
const tinyRating=scoring.priceMileageRatings(tiny);
assert.equal(tinyRating.get('cheapHighMiles').label,'Not rated');
assert.equal(tinyRating.get('slightlyDearerLowMiles').label,'Not rated');
assert.deepEqual([...tiny].sort((a,b)=>
  scoring.comparePriceMileageGroups(a,b,tinyRating)).map(g=>g[0].id),
  ['slightlyDearerLowMiles','cheapHighMiles']);
console.log('Price and mileage badges, cohorts, duplicate handling and sort passed');
