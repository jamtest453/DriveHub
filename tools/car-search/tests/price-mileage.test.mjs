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
for (const tier of ['amazing','great','good','average','poor','terrible','unrated'])
  assert.match(css,new RegExp('\\.price-value-'+tier+'\\{'),'each label has its own style');
assert.match(code,/sort==='priceMileage'/);
assert.match(code,/comparePriceMileageGroups\(a,b,valueRatings\)/);
assert.match(code,/valueRatings\.get\(g\[0\]\.id\)/);
assert.match(code,/price-value-indicator/);
assert.doesNotMatch(code,/60%, mileage 40%|\.6\*priceRank|\.4\*milesRank/);

// Run the actual production valuation, mileage cleansing and model matching.
// Deduplicated vehicle groups, not individual source adverts, are the sample.
const actual=section('function vehicleIdentity(','function photoDistance(')+
  '\n'+section('function priceMileageVariant(','function renderResults(');
const ctx={Number,Math,Map,Set,Intl,
  combinedCarDetails:g=>g[0],
  matchesResultFilters:()=>true,
  effectiveTransmission:car=>car.transmission || ''
};
const scoring=vm.runInNewContext(actual+
  '\n({priceMileageRatings,comparePriceMileageGroups,priceMileageTier,priceMileageDepreciation,priceMileageMedian})',ctx);
const car=(id,price,mileage,other={})=>[{
  id,title:'2017 BMW M2 DCT',year:2017,price,mileage,transmission:'automatic',
  ...other
}];
assert.equal(scoring.priceMileageMedian([9,2,5]),5);
assert.equal(scoring.priceMileageMedian([9,2,5,6]),5.5);
for(const [diff,tier] of [
  [-.16,'amazing'],[-.08,'great'],[-.03,'good'],
  [0,'average'],[.06,'poor'],[.16,'terrible']
]) assert.equal(scoring.priceMileageTier(diff),tier);

// Realistic asking-price spread and odometer variance within the same model.
// Lower adjusted asking prices must win regardless of which has more mileage.
// These prices include a true underlying £1,000 / 10k-mile relationship plus
// meaningful premiums/discounts so all ends of the label scale are exercised.
const sample=[
  car('a',17700,65000),car('b',24340,25000),
  car('c',19540,85000),car('d',24500,45000),
  car('e',22460,75000),car('f',28140,35000),
  car('g',27820,55000)
];
const ratings=scoring.priceMileageRatings(sample);
assert.equal(ratings.get('a').label,'Amazing!');
assert.equal(ratings.get('b').label,'Great');
assert.equal(ratings.get('c').label,'Average');
assert.equal(ratings.get('e').label,'Poor');
assert.equal(ratings.get('g').label,'Terrible');
assert.equal(ratings.get('a').peers,7);
assert.ok(ratings.get('a').depreciationPer10000>500);
assert.ok(ratings.get('a').depreciationPer10000<2500);
assert.match(ratings.get('a').reason,/per 10,000 miles/);
assert.match(ratings.get('a').reason,/below the mileage-adjusted median/);
assert.deepEqual([...sample].sort((a,b)=>
  scoring.comparePriceMileageGroups(a,b,ratings)).map(g=>g[0].id),
  ['a','b','c','d','e','f','g']);

// Different model, variant, age or gearbox must not distort comparables.
const separate=scoring.priceMileageRatings([
  ...sample,
  car('comp',18000,15000,{title:'2017 BMW M2 Competition'}),
  car('2021',18500,10000,{year:2021,title:'2021 BMW M2 DCT'}),
  car('other',19500,20000,{title:'2017 BMW M4 DCT'}),
  car('manual',19000,16000,{transmission:'manual'})
]);
for(const id of ['comp','2021','other','manual']) {
  assert.equal(separate.get(id).label,'Not rated',id);
  assert.equal(separate.get(id).score,null,id);
}
assert.equal(separate.get('a').peers,7,'unrelated cars cannot dilute sample');

// Two listings of the same car count as one sample.
const duplicated=[
  [sample[0][0],{...sample[0][0],id:'a2',price:18000,site:'ebay'}],
  ...sample.slice(1)
];
assert.equal(scoring.priceMileageRatings(duplicated).get('a').peers,7);

// Missing/suspect mileage and price cannot receive a reassuring label.
const unknown=scoring.priceMileageRatings([
  ...sample,
  car('unknown',23000,null),
  car('noPrice',null,15000),
  car('distanceNotMiles',22000,100,{location:'Hayes (100 miles)'})
]);
for(const id of ['unknown','noPrice','distanceNotMiles'])
  assert.equal(unknown.get(id).label,'Not rated',id);

// A noisy/mismatched sample now provides a transparent conservative
// estimate, rather than marking all usable cars "Not rated".
const noRelationship=[
  car('n1',20000,20000),car('n2',22000,40000),
  car('n3',24000,60000),car('n4',26000,80000)
];
for(const result of scoring.priceMileageRatings(noRelationship).values()) {
  assert.notEqual(result.label,'Not rated');
  assert.match(result.reason,/Approximate mileage allowance/);
}

// Two cars provide a provisional within-cohort comparison. The badge tooltip
// must distinguish a heuristic from a rate actually observed in same-year ads.
const tiny=[
  car('cheapHighMiles',24000,90000),
  car('slightlyDearerLowMiles',25500,20000)
];
const small=scoring.priceMileageRatings(tiny);
for(const result of small.values()) {
  assert.notEqual(result.label,'Not rated');
  assert.match(result.reason,/Approximate mileage allowance/);
}
assert.deepEqual([...tiny].sort((a,b)=>
  scoring.comparePriceMileageGroups(a,b,small)).map(g=>g[0].id),
  ['slightlyDearerLowMiles','cheapHighMiles']);
// Same model up to two years apart is permitted only when closer-year
// comparables are unavailable.
const nearby=scoring.priceMileageRatings([
  car('twoYearsEarlier',23500,60000,{year:2017}),
  car('twoYearsLater',25500,30000,{year:2019})
]);
assert.equal(nearby.get('twoYearsEarlier').peers,2);
assert.notEqual(nearby.get('twoYearsLater').label,'Not rated');
// Genuinely uncomparable vehicles retain a truthful explanation.
const singleton=scoring.priceMileageRatings([car('single',24500,50000)]);
assert.equal(singleton.get('single').label,'Not rated');
assert.match(singleton.get('single').reason,/No second comparable/);
// The combined vehicle's odometer can be null because different provider
// adverts disagree. A valid individual odometer still supports a valuation.
const mergedWithoutCompositeMileage=vm.runInNewContext(actual+
  '\n({priceMileageRatings,priceMileageObservation})',{
    ...ctx,
    combinedCarDetails:g=>g.length>1 ? {...g[0],mileage:null} : g[0]
  });
const conflicting=[
  car('mergedCheap',23000,52000)[0],
  car('mergedOther',23500,68000,{site:'ebay'})[0]
];
const mixedRatings=mergedWithoutCompositeMileage.priceMileageRatings([
  [conflicting[0],conflicting[1]],...sample
]);
assert.notEqual(mixedRatings.get('mergedCheap').label,'Not rated');
assert.equal(mixedRatings.get('mergedCheap'),mixedRatings.get('mergedOther'),
  'both provider adverts share a single price and mileage rating');
assert.equal(mergedWithoutCompositeMileage.priceMileageObservation(conflicting).mileage,52000,
  'the priced source odometer takes precedence on a conflict');
assert.match(mixedRatings.get('mergedCheap').reason,/Merged adverts disagree on mileage/);

// When the lowest-priced advert has no mileage, use the valid other source.
const partial=[
  car('mergedMissing',22000,null)[0],
  car('mergedWithMiles',22500,54000,{site:'ebay'})[0]
];
assert.equal(mergedWithoutCompositeMileage.priceMileageObservation(partial).mileage,54000);
assert.notEqual(mergedWithoutCompositeMileage.priceMileageRatings([partial,...sample])
  .get('mergedMissing').label,'Not rated');

// Explicitly entered mileage outranks other provider estimates.
const manual=[
  car('mergedSeller',22000,75000)[0],
  car('mergedManual',23500,50000,{manualFields:['mileage'],site:'ebay'})[0]
];
assert.equal(mergedWithoutCompositeMileage.priceMileageObservation(manual).mileage,50000);

console.log('Mileage-derived depreciation, six rating bands and sorting passed');
