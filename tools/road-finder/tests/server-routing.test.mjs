import assert from 'node:assert/strict';
import {findA2BRoutes} from '../server/api.js';

const start={lat:53.41407,lon:-2.09608}; // Romiley, Stockport
const end={lat:53.2593,lon:-1.9101};     // Buxton
const via={lat:53.335,lon:-2.045};       // representative nearby better-road waypoint

const makeRoute=(coords,km=28,mins=35)=>({
  distance:km*1000,duration:mins*60,geometry:{type:'LineString',coordinates:coords.map(([lat,lon])=>[lon,lat])}
});
const direct=[[53.41407,-2.09608],[53.36,-2.02],[53.30,-1.96],[53.2593,-1.9101]];
const scenic=[[53.41407,-2.09608],[53.37,-2.09],[53.335,-2.045],[53.30,-1.98],[53.2593,-1.9101]];

const urls=[];
const fetchImpl=async(url)=>{
  urls.push(String(url));
  const isVia=String(url).includes(`${via.lon.toFixed(6)},${via.lat.toFixed(6)}`);
  return {ok:true,status:200,json:async()=>({code:'Ok',routes:[makeRoute(isVia?scenic:direct,isVia?32:28,isVia?41:35)]})};
};

const baseline=await findA2BRoutes(start,end,{fetchImpl,providers:['https://example.test/route/v1/driving']});
assert.equal(baseline.length,1,'initial A-to-B lookup should request one direct route');
assert.equal(baseline[0].label,'Direct route');
assert.equal(baseline[0].distanceKm,28);
assert.ok(!urls[0].includes(`${via.lon.toFixed(6)},${via.lat.toFixed(6)}`),'direct route must not invent guide points');

const alternative=await findA2BRoutes(start,end,{via:[via],label:'Better roads via test road',fetchImpl,providers:['https://example.test/route/v1/driving']});
assert.equal(alternative.length,1);
assert.equal(alternative[0].label,'Better roads via test road');
assert.equal(alternative[0].distanceKm,32);
assert.ok(urls[1].includes(`${via.lon.toFixed(6)},${via.lat.toFixed(6)}`),'better-road route must explicitly pass through the selected nearby road');

// A slow/dead first provider must not block a healthy second provider. This is
// the regression for the UI hanging on “Finding the direct route…”.
const started=Date.now();
const concurrentFetch=async(url,{signal}={})=>{
  const slow=String(url).includes('slow.test');
  if(slow){
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,180);
      signal?.addEventListener?.('abort',()=>{clearTimeout(timer);const e=new Error('aborted');e.name='AbortError';reject(e)},{once:true});
    });
  }
  return {ok:true,status:200,json:async()=>({code:'Ok',routes:[makeRoute(direct,28,35)]})};
};
const raced=await findA2BRoutes(start,end,{fetchImpl:concurrentFetch,providers:['https://slow.test/route/v1/driving','https://fast.test/route/v1/driving']});
assert.equal(raced.length,1);
assert.ok(Date.now()-started<120,'healthy routing provider should win without waiting for a slow provider');

console.log('Road Finder direct-route/corridor routing tests passed');
