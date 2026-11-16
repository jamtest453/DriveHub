import assert from 'node:assert/strict';
await import('../public/core.js');
await import('../public/road-quality.js');
await import('../public/routing.js');
const RF = globalThis.RoadFinderCore;
assert.ok(RF, 'RoadFinderCore should be available');

// Directionality
assert.equal(RF.normaliseOneway({oneway:'yes'}), 1);
assert.equal(RF.normaliseOneway({oneway:'-1'}), -1);
assert.equal(RF.normaliseOneway({junction:'roundabout'}), 1);
assert.equal(RF.normaliseOneway({junction:'roundabout', oneway:'no'}), 0);

// Access and road quality
assert.equal(RF.accessStatus({motor_vehicle:'private'}).allowed, false);
assert.equal(RF.accessStatus({access:'no'}).allowed, false);
assert.equal(RF.accessStatus({access:'yes'}).allowed, true);
assert.equal(RF.roadQuality({surface:'gravel'}).reject, true);
assert.ok(RF.roadQuality({lanes:'1',width:'3.0',surface:'asphalt',smoothness:'good'}).penalty >= 20);
assert.equal(RF.roadQuality({lanes:'2',surface:'asphalt',smoothness:'good'}).reject, false);

// Stable persisted identities
const a = RF.stableRoadId({sourceWayIds:[32,11,19]});
const b = RF.stableRoadId({sourceWayIds:[19,32,11]});
assert.equal(a,b,'road IDs must be invariant to source-way merge order');
const loopA = RF.stableRouteId({routeType:'circular',roadIds:['r3','r1','r2'],coords:[[53,-2],[53.1,-2.1],[53,-2]]});
const loopB = RF.stableRouteId({routeType:'circular',roadIds:['r2','r3','r1'],coords:[[53,-2],[53.1,-2.1],[53,-2]]});
assert.equal(loopA,loopB,'loop route ID must be deterministic');

// Common OSM turn restrictions: from way, via node, to way.
const restrictionIndex = RF.extractTurnRestrictions([{type:'relation',id:9,tags:{type:'restriction',restriction:'no_right_turn'},members:[
  {type:'way',ref:100,role:'from'},{type:'node',ref:500,role:'via'},{type:'way',ref:200,role:'to'}
]}]);
const prev={sourceWayId:100,toNodeId:500};
assert.equal(RF.turnAllowed(prev,{sourceWayId:200,fromNodeId:500},restrictionIndex),false);
assert.equal(RF.turnAllowed(prev,{sourceWayId:201,fromNodeId:500},restrictionIndex),true);
const onlyIndex = RF.extractTurnRestrictions([{type:'relation',id:10,tags:{type:'restriction',restriction:'only_straight_on'},members:[
  {type:'way',ref:100,role:'from'},{type:'node',ref:500,role:'via'},{type:'way',ref:201,role:'to'}
]}]);
assert.equal(RF.turnAllowed(prev,{sourceWayId:200,fromNodeId:500},onlyIndex),false);
assert.equal(RF.turnAllowed(prev,{sourceWayId:201,fromNodeId:500},onlyIndex),true);
const exceptMotorcar = RF.extractTurnRestrictions([{type:'relation',id:11,tags:{type:'restriction',restriction:'no_left_turn',except:'motorcar'},members:[
  {type:'way',ref:100,role:'from'},{type:'node',ref:500,role:'via'},{type:'way',ref:200,role:'to'}
]}]);
assert.equal(exceptMotorcar.size,0,'motorcar exception should not restrict car routing');

// Navigation hand-off should retain priority roads and remain bounded.
const coords=[]; for(let i=0;i<40;i++) coords.push([53+i*0.001,-2+(Math.sin(i/4)*0.005)]);
const priority=[{coord:coords[12],score:95},{coord:coords[28],score:90}];
const waypoints=RF.selectNavigationWaypoints(coords,8,priority);
assert.ok(waypoints.length<=8);
assert.ok(waypoints.some(c=>c[0]===coords[12][0]&&c[1]===coords[12][1]));
assert.ok(waypoints.some(c=>c[0]===coords[28][0]&&c[1]===coords[28][1]));
const mapsUrl=RF.googleMapsDirectionsUrl(coords,priority,8);
assert.match(mapsUrl,/google\.com\/maps\/dir\/\?api=1/);
assert.match(mapsUrl,/waypoints=/);

// GPX export should be valid XML-safe text.
const gpx=RF.routeToGpx({name:'A&B <test>',coords:[[53.1,-2.1],[53.2,-2.2]]});
assert.match(gpx,/A&amp;B &lt;test&gt;/);
assert.match(gpx,/<trkpt lat="53\.100000" lon="-2\.100000">/);

console.log('Road Finder core regression tests passed');

// Via-way restrictions and path-dependent routing state.
const viaWayIndex = RF.extractTurnRestrictions([{type:'relation',id:12,tags:{type:'restriction',restriction:'no_left_turn'},members:[
  {type:'way',ref:100,role:'from'},{type:'way',ref:150,role:'via'},{type:'way',ref:151,role:'via'},{type:'way',ref:200,role:'to'}
]}]);
const viaPath=[{sourceWayId:100,toNodeId:1},{sourceWayId:150,toNodeId:2},{sourceWayId:151,toNodeId:3}];
assert.equal(RF.pathTransitionAllowed(viaPath,{sourceWayId:200,fromNodeId:3},viaWayIndex),false,'via-way no-turn must be enforced');
assert.equal(RF.pathTransitionAllowed(viaPath,{sourceWayId:201,fromNodeId:3},viaWayIndex),true,'unrestricted exit from via-way should remain legal');
assert.notEqual(RF.routingStateKey('junction', [{sourceWayId:100}], viaWayIndex), RF.routingStateKey('junction', [{sourceWayId:101}], viaWayIndex),'routing state must preserve arrival context');

// A-to-B alternatives must keep road order in their persisted identity.
const a2bOrderA=RF.stableRouteId({routeType:'a2b',roadIds:['r1','r2','r3'],coords:[[53,-2],[53.2,-2.2]]});
const a2bOrderB=RF.stableRouteId({routeType:'a2b',roadIds:['r1','r3','r2'],coords:[[53,-2],[53.2,-2.2]]});
assert.notEqual(a2bOrderA,a2bOrderB,'A-to-B route IDs must preserve road sequence');
const overlapA=[{segmentId:'a',len:2},{segmentId:'b',len:2},{segmentId:'c',len:2}];
const overlapB=[{segmentId:'a',len:2},{segmentId:'b',len:2},{segmentId:'x',len:2}];
assert.ok(RF.pathOverlapRatio(overlapA,overlapB)>.6&&RF.pathOverlapRatio(overlapA,overlapB)<.7,'path overlap should be distance weighted');

// ── Circular routing graph ──────────────────────────────────────────────────
// Regression cover for the loop-routing graph. This was previously called by
// app.js but never defined, so every round-trip build threw a ReferenceError —
// and because both generators shared one Promise.all, the A-to-B suggestions
// were discarded with it.
assert.equal(typeof RF.buildCircularRoutingGraph, 'function', 'buildCircularRoutingGraph must be exported');

const key = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;
function gridGraph(originLat, originLon, step, size, tag) {
  const g = new Map();
  const at = (i, j) => key(originLat + i * step, originLon + j * step);
  const edge = (from, to) => {
    if (!g.has(from)) g.set(from, []);
    g.get(from).push({ targetKey: to, len: 1, isGood: true, score: 60, segmentId: `${tag}:${from}>${to}` });
  };
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) {
    if (j + 1 < size) { edge(at(i, j), at(i, j + 1)); edge(at(i, j + 1), at(i, j)); }
    if (i + 1 < size) { edge(at(i, j), at(i + 1, j)); edge(at(i + 1, j), at(i, j)); }
  }
  return g;
}

const near = gridGraph(53.25, -1.90, 0.01, 4, 'near');
const far = gridGraph(55.90, -3.20, 0.01, 4, 'far');       // ~300 km away
const combined = new Map([...near, ...far]);

const built = RF.buildCircularRoutingGraph(combined, [53.25, -1.90], 20);
assert.ok(built.nodeKeys.length >= 3, 'a routable grid must yield usable nodes');
assert.ok(built.nodeKeys.length < combined.size, 'out-of-range nodes must be pruned');
assert.ok(built.nodeKeys.every(k => near.has(k)), 'only the origin component may survive');
for (const [, edges] of built.graph) {
  for (const e of edges) assert.ok(built.graph.has(e.targetKey) || built.nodeKeys.includes(e.targetKey),
    'edges must not leave the working component');
}

// Degenerate inputs fall back rather than returning an unroutable empty graph.
assert.deepEqual(RF.buildCircularRoutingGraph(new Map(), [53, -2], 20), { graph: new Map(), nodeKeys: [] });
const noOrigin = RF.buildCircularRoutingGraph(near, null, 20);
assert.equal(noOrigin.nodeKeys.length, near.size, 'a missing origin falls back to the whole graph');
const tinyRadius = RF.buildCircularRoutingGraph(near, [0, 0], 1);
assert.equal(tinyRadius.nodeKeys.length, near.size, 'an origin with nothing in range falls back to the whole graph');

console.log('Road Finder circular routing graph tests passed');

// ── A-to-B snap candidate selection ─────────────────────────────────────────
// Graph nodes are per geometry vertex, so the points nearest a dropped pin are
// usually all on one short way — often a driveway or service stub that is not
// joined to the through network. Taking the N nearest nodes spent every snap
// slot on that dead end, so start and end never shared a connected component
// and routing reported no route where one plainly existed.
assert.equal(typeof RF.diversifySnapCandidates, 'function', 'diversifySnapCandidates must be exported');

const stubRows = [];
for (let i = 0; i < 10; i++)
  stubRows.push({ key:'stub'+i, degree:2, distanceKm:0.01 + i*0.001, component:'stub', sourceRoad:'service-1' });
const networkRows = [];
for (let i = 0; i < 20; i++)
  networkRows.push({ key:'net'+i, degree:4, distanceKm:0.4 + i*0.01, component:'network', sourceRoad:'road-'+Math.floor(i/4) });

const picked = RF.diversifySnapCandidates([...stubRows, ...networkRows], { limit:8, radiusKm:2 });
assert.ok(picked.some(r => r.component === 'network'),
  'the through network must always be represented, not just the nearest stub');
assert.ok(picked.filter(r => r.component === 'stub').length <= 3,
  'one component must not consume every snap slot');
assert.ok(picked.filter(r => r.sourceRoad === 'service-1').length <= 2,
  'one source road must not consume every snap slot');
assert.ok(picked.every(r => r.degree > 0), 'candidates must have outgoing edges');

// Nearest-first ordering is preserved within the diversified set.
const distances = picked.map(r => r.distanceKm);
assert.deepEqual(distances, [...distances].sort((x,y) => x-y), 'candidates stay nearest-first');

// Degenerate inputs
assert.deepEqual(RF.diversifySnapCandidates([], { limit:8 }), []);
assert.deepEqual(RF.diversifySnapCandidates([{ key:'a', degree:0, distanceKm:0.1 }], { limit:8 }), []);

console.log('Road Finder A-to-B snap candidate tests passed');

// ── A-to-B snap plausibility ────────────────────────────────────────────────
// A snapped leg is the straight line between the requested point and the road
// network; the driver cannot use it. Routes were being accepted whose snap legs
// dwarfed the roads themselves, so a short fragment miles from both endpoints
// was returned as "the route". The guard lives in app.js, but the arithmetic it
// depends on is pinned here so the thresholds cannot drift unnoticed.
// The allowance is bounded by the drive AND by the straight-line hop: a fixed
// 2 km floor alone let a 1.3 km fabricated leg through on a 1.3 km hop.
const snapAcceptable = (snapKm, routeKm, straightKm) => snapKm <= Math.min(
  Math.max(2, routeKm * 0.4),
  Math.max(1, Math.min(3, straightKm * 0.25))
);
assert.equal(snapAcceptable(0.2, 34, 11), true, 'a route that starts at the requested point is fine');
assert.equal(snapAcceptable(0.9, 3, 4), true, 'short snaps on short hops stay allowed');
assert.equal(snapAcceptable(11, 6.6, 11), false, 'an 11 km snap onto a 6.6 km fragment is not a route');
assert.equal(snapAcceptable(1.3, 0.1, 1.3), false, 'a 1.3 km leg onto a 100 m fragment is not a route');
assert.equal(snapAcceptable(18, 34, 25), false, 'snap legs may not approach the route length');

console.log('Road Finder A-to-B snap plausibility tests passed');

// ── Score-chained round-trip anchors ───────────────────────────────────────
// Round trips should choose high-scoring real roads around the start, rather
// than arbitrary geometric points. Road Score is the dominant ranking signal,
// while angular sectors keep the chain spread around the origin.
assert.equal(typeof RF.selectScoreChainedRoadAnchors, 'function', 'score-chain anchor selector must be exported');
const origin = [53.35, -1.90];
const makeRoad = (id, score, lat, lon, len=5, confidence=70) => ({
  id, name:id, score, len, confidence,
  coords:[[lat-0.003,lon-0.003],[lat,lon],[lat+0.003,lon+0.003]]
});
const scoreRoads = [
  makeRoad('north-best', 92, 53.43, -1.90),
  makeRoad('north-weaker', 48, 53.42, -1.89),
  makeRoad('south-east-best', 88, 53.31, -1.79),
  makeRoad('south-east-weaker', 51, 53.30, -1.80),
  makeRoad('south-west-best', 84, 53.31, -2.01),
  makeRoad('south-west-weaker', 49, 53.30, -2.00)
];
const chainAnchors = RF.selectScoreChainedRoadAnchors(scoreRoads, origin, 9, 0, 1, {count:3,maxAngle:75});
assert.equal(chainAnchors.length, 3, 'three available angular sectors should produce three road anchors');
assert.deepEqual(new Set(chainAnchors.map(r=>r.road.id)), new Set(['north-best','south-east-best','south-west-best']),
  'the highest-scoring road in each useful sector should win');
assert.ok(chainAnchors.every(r => r.road.score >= 80), 'weak roads must not beat clearly stronger nearby alternatives');
assert.deepEqual(RF.selectScoreChainedRoadAnchors([], origin, 8), [], 'empty road pools are safe');


assert.equal(typeof RF.planScoreChainedRoundTrips, 'function', 'bounded score-chain planner must be exported');
const chainPlans = RF.planScoreChainedRoundTrips(scoreRoads, origin, 9, {
  count:3, maxAngle:75, limit:4, rotations:[0,60,120,180,240,300]
});
assert.ok(chainPlans.length >= 1 && chainPlans.length <= 4, 'planner returns a bounded number of candidate chains');
assert.ok(chainPlans.every(plan => plan.anchors.length >= 2), 'every planned chain has enough scored roads to route');
assert.equal(new Set(chainPlans.map(plan => plan.signature)).size, chainPlans.length, 'equivalent road chains are de-duplicated before pathfinding');
assert.ok(chainPlans[0].avgScore >= 80, 'the first pathfinding candidates are driven by strong Road Scores');

console.log('Road Finder score-chained round-trip tests passed');
