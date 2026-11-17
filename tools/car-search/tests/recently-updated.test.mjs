import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const js=fs.readFileSync(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../legacy/public/dashboard.html',import.meta.url),'utf8');
assert.match(html,/<option value="recentlyUpdated">Most recently updated<\/option>/);
assert.match(js,/sort==='recentlyUpdated'/);
const start=js.indexOf('function listingUpdatedAt(');
const end=js.indexOf('function renderResults()',start);
assert.ok(start>0 && end>start,'last meaningful update helper exists');
const helpers=vm.runInNewContext(js.slice(start,end)+
  '\n({listingUpdatedAt,groupUpdatedAt})',{Date,Math,Array});

const item=(id,firstSeen,lastSeen,priceHistory=[])=>({
  id,firstSeen,lastSeen,priceHistory
});
const newCar=item('new','2026-11-15T15:00:00Z','2026-11-17T12:00:00Z');
const priceChanged=item('changed','2026-11-01T08:00:00Z','2026-11-17T12:00:00Z',[
  {price:22000,at:'2026-11-01T08:00:00Z'},
  {price:21000,at:'2026-11-17T09:00:00Z'}
]);
const unchanged=item('unchanged','2026-11-03T08:00:00Z','2026-11-17T12:00:00Z',[
  {price:22000,at:'2026-11-03T08:00:00Z'}
]);
assert.equal(helpers.listingUpdatedAt(newCar),Date.parse(newCar.firstSeen));
assert.equal(helpers.listingUpdatedAt(priceChanged),Date.parse('2026-11-17T09:00:00Z'));
assert.equal(helpers.listingUpdatedAt(unchanged),Date.parse(unchanged.firstSeen),
  'freshly scanned unchanged listings must not look newly updated');
const multi=item('changedAgain','2026-11-08T09:00:00Z','2026-11-17T11:00:00Z',[
  {price:22000,at:'2026-11-08T09:00:00Z'},
  {price:21500,at:'2026-11-12T12:00:00Z'},
  {price:20500,at:'2026-11-17T11:00:00Z'}
]);
const groups=[[newCar],[priceChanged],[unchanged],[multi,item('sameCarSource','2026-10-01T09:00:00Z','2026-11-17T12:00:00Z')]];
const ordered=groups.sort((a,b)=>helpers.groupUpdatedAt(b)-helpers.groupUpdatedAt(a));
assert.deepEqual(ordered.map(g=>g[0].id),['changedAgain','changed','new','unchanged'],
  'both new listings and latest price reductions rank by the actual event time');
console.log('Most recently updated sorting checks passed');
