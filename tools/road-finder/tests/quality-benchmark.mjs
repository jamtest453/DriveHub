import assert from 'node:assert/strict';
await import('../public/core.js');
await import('../public/road-quality.js');
await import('../public/routing.js');
const {roadQuality,roadDataConfidence,accessStatus,parseMeasureMeters,routeConfidence,drivingPaceScore,drivingRoadScore,roadClassEnjoymentBonus} = globalThis.RoadFinderCore;

// Deterministic metadata benchmark. This protects the intended ordering while
// live geometry/scenery scoring continues to evolve.
const cases = [
  ['good surfaced two-lane road',{surface:'asphalt',smoothness:'good',lanes:'2',width:'6.2'},0,false],
  ['unknown metadata',{lanes:'2'},3,false],
  ['narrow single lane',{surface:'asphalt',smoothness:'good',lanes:'1',width:'3.0'},21,false],
  ['rough surfaced road',{surface:'asphalt',smoothness:'very_bad',lanes:'2'},14,false],
  ['private road',{surface:'asphalt',motor_vehicle:'private'},0,true],
  ['destination-only road',{surface:'asphalt',motor_vehicle:'destination'},0,true],
  ['ford crossing',{surface:'asphalt',ford:'yes'},0,true],
  ['gravel road',{surface:'gravel',access:'yes'},0,true],
];
for(const [name,tags,minPenalty,reject] of cases){
  const q=roadQuality(tags);
  assert.equal(q.reject,reject,`${name}: reject mismatch`);
  assert.ok((q.penalty||0)+(q.confidencePenalty||0)>=minPenalty,`${name}: penalty too small`);
}

// More-specific motorcar access must override generic access tagging.
assert.equal(accessStatus({access:'no',motorcar:'yes'}).allowed,true);
assert.equal(accessStatus({access:'yes',motorcar:'private'}).allowed,false);
assert.ok(Math.abs(parseMeasureMeters(`6'6"`)-1.9812)<0.01,'imperial width should be converted to metres');

// Confidence must distinguish rich road metadata from sparse/estimated data.
const rich=roadDataConfidence({highway:'secondary',name:'B Road',maxspeed:'60 mph',surface:'asphalt',smoothness:'good',lanes:'2',width:'6.1'},{speedIsEstimated:false,geometryPoints:20,urbanSamples:10});
const sparse=roadDataConfidence({highway:'unclassified'},{speedIsEstimated:true,geometryPoints:5,urbanSamples:2});
assert.ok(rich.score>=78,'rich metadata should be high confidence');
assert.ok(sparse.score<58,'sparse estimated metadata should be low confidence');
assert.ok(rich.score>sparse.score+25,'confidence separation should be meaningful');

// Route confidence rewards rated-road coverage and good underlying evidence.
const strongRoute=routeConfidence({driverRoadRatio:.88,roadDetails:[{isGood:true,len:8,confidence:88},{isGood:true,len:6,confidence:82}]});
const weakRoute=routeConfidence({driverRoadRatio:.42,roadDetails:[{isGood:true,len:2,confidence:48}]});
assert.ok(strongRoute.score>weakRoute.score+20);
assert.equal(strongRoute.label,'High');



// Driving-score calibration: rewarding roads should separate clearly from
// merely fast roads, and 60 mph rural roads are the pace sweet spot rather than
// blindly rewarding the highest speed limit.
assert.ok(drivingPaceScore(60)>drivingPaceScore(70),'60 mph should be the road-enjoyment pace sweet spot');
assert.ok(drivingPaceScore(50)>drivingPaceScore(40),'50 mph roads should no longer hit the old 40/60 scoring cliff');
assert.ok(roadClassEnjoymentBonus('tertiary')>roadClassEnjoymentBonus('trunk'),'smaller rural through-roads should get a modest class advantage over trunk roads');

const greatB=drivingRoadScore({twistScore:72,lengthScore:100,speedMph:60,accelRhythmScore:12,sceneryScore:65,sceneryPts:13,penaltyTotal:0,highwayType:'secondary',urbanExposure:.05,totalLen:6000,lengthMultiplier:1,surfaceKnownGood:true});
const flowingA=drivingRoadScore({twistScore:28,lengthScore:100,speedMph:60,accelRhythmScore:8,sceneryScore:72,sceneryPts:14.4,penaltyTotal:0,highwayType:'primary',urbanExposure:.08,totalLen:9000,lengthMultiplier:1,surfaceKnownGood:true});
const boringA=drivingRoadScore({twistScore:6,lengthScore:100,speedMph:60,accelRhythmScore:2,sceneryScore:18,sceneryPts:3.6,penaltyTotal:0,highwayType:'primary',urbanExposure:.08,totalLen:9000,lengthMultiplier:1,surfaceKnownGood:true});
const urbanRoad=drivingRoadScore({twistScore:50,lengthScore:80,speedMph:30,accelRhythmScore:8,sceneryScore:20,sceneryPts:4,penaltyTotal:14,highwayType:'residential',urbanExposure:.75,totalLen:3000,lengthMultiplier:1,surfaceKnownGood:true});
assert.ok(greatB.score>=80,'a strong rural B-road should reach top-road territory');
assert.ok(greatB.score>flowingA.score,'technical/rhythmic B-road should beat a merely flowing A-road');
assert.ok(flowingA.score>=65,'a scenic flowing A-road should still rank strongly');
assert.ok(boringA.score<50,'fast but boring A-road must not be labelled exceptional');
assert.ok(urbanRoad.score<50,'urban twistiness alone must not dominate the ranking');
assert.ok([greatB,flowingA,boringA,urbanRoad].every(x=>x.score>=0&&x.score<=100),'Road Score remains calibrated to 0–100');

console.log('Road Finder quality benchmark passed');
