import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const js=fs.readFileSync(new URL('../legacy/public/dashboard.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../legacy/public/dashboard.html',import.meta.url),'utf8');
const section=(a,b)=>{
  const start=js.indexOf(a),end=js.indexOf(b,start+1);
  assert.ok(start>=0&&end>start,'Expected code fragment '+a);
  return js.slice(start,end);
};
assert.match(html,/id="bodyTypeChoices"/);
assert.match(html,/id="resultBodyType"/);
assert.match(html,/id="manualCarBodyType"/);
assert.match(js,/bodyTypes:\[\.\.\.document\.querySelectorAll/);
assert.match(js,/setupBodyTypeChoices\(found\?\.filters\?\.bodyTypes/);
assert.match(js,/groupMatchesColour\(g\) && groupMatchesBodyType\(g\)/);
const controls={resultBodyType:{value:'any'}};
const handlers=vm.runInNewContext(
  section('const BODY_TYPE_CHOICES =','let scanBusy')+
  section('function searchBodyTypeMatchesGroup(','function normaliseExcludedText(')+
  section('function groupMatchesBodyType(','function geoMiles(')+
  '\n({bodyTypeForCar,searchBodyTypeMatchesGroup,groupMatchesBodyType})',
  {$:key=>controls[key]});
const unknown={title:'2017 BMW M2 DCT',site:'facebook'};
const coupe={title:'2017 BMW M2 Coupe',site:'autotrader'};
const wrong={title:'2017 BMW M2 Convertible',site:'ebay'};
const selected={filters:{bodyTypes:['coupe']}};
assert.equal(handlers.bodyTypeForCar(coupe),'coupe');
assert.equal(handlers.bodyTypeForCar(unknown),'');
assert.equal(handlers.bodyTypeForCar(wrong),'convertible');
assert.equal(handlers.searchBodyTypeMatchesGroup([coupe],selected),true);
assert.equal(handlers.searchBodyTypeMatchesGroup([unknown],selected),true,
  'unknown body type always included');
assert.equal(handlers.searchBodyTypeMatchesGroup([wrong],selected),false);
assert.equal(handlers.searchBodyTypeMatchesGroup([unknown,coupe],selected),true);
assert.equal(handlers.searchBodyTypeMatchesGroup([unknown,wrong],selected),false);
assert.equal(handlers.searchBodyTypeMatchesGroup([coupe,wrong],selected),false);
controls.resultBodyType.value='coupe';
assert.equal(handlers.groupMatchesBodyType([unknown]),true);
assert.equal(handlers.groupMatchesBodyType([coupe]),true);
assert.equal(handlers.groupMatchesBodyType([wrong]),false);
assert.equal(handlers.groupMatchesBodyType([coupe,wrong]),false);
console.log('Body type saved-search and live-result filters passed');
