(function(global){'use strict';
const RF=global.RoadFinderCore=global.RoadFinderCore||{};
const BAD_ACCESS=new Set(['no','private','agricultural','forestry']);
const LIMITED_ACCESS=new Set(['destination','customers','delivery','permit']);
const BAD_SURFACES=new Set(['unpaved','gravel','fine_gravel','dirt','earth','ground','grass','grass_paver','mud','sand','woodchips','pebblestone','compacted']);
const ROUGH=new Set(['bad','very_bad','horrible','very_horrible','impassable']);
function accessStatus(tags={}){for(const key of ['motorcar','motor_vehicle','vehicle','access']){if(tags[key]==null||String(tags[key]).trim()==='')continue;const value=String(tags[key]).trim().toLowerCase().split(';')[0].trim();if(BAD_ACCESS.has(value))return{allowed:false,limited:false,reason:`Restricted vehicle access (${value})`,key,value};if(LIMITED_ACCESS.has(value))return{allowed:false,limited:true,reason:`Limited vehicle access (${value})`,key,value};return{allowed:true,limited:false,reason:'',key,value}}return{allowed:true,limited:false,reason:'',key:'',value:''}}
function parseMeasureMeters(v){const s=String(v??'').trim().toLowerCase();if(!s)return null;const ftIn=s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|')\s*(?:(\d+(?:\.\d+)?)\s*(?:in|inches|"))?/);if(ftIn)return Number(ftIn[1])*.3048+(Number(ftIn[2]||0)*.0254);const m=s.match(/-?\d+(?:\.\d+)?/);if(!m)return null;const n=Number(m[0]);if(/cm\b/.test(s))return n/100;if(/mm\b/.test(s))return n/1000;if(/(?:ft|feet)\b/.test(s))return n*.3048;return n}
function num(v){const m=String(v??'').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null}
function roadQuality(tags={}){const access=accessStatus(tags);if(!access.allowed)return{reject:true,reason:access.reason,penalty:0,confidencePenalty:0,flags:[access.limited?'limited-access':'restricted']};if(String(tags.ford||'').toLowerCase()==='yes'||String(tags.highway||'').toLowerCase()==='ford')return{reject:true,reason:'Ford/water crossing',penalty:0,confidencePenalty:0,flags:['ford']};const surface=String(tags.surface||'').toLowerCase(),smooth=String(tags.smoothness||'').toLowerCase(),lanes=num(tags.lanes),width=parseMeasureMeters(tags.width);let penalty=0,confidencePenalty=0;const flags=[];if(surface&&BAD_SURFACES.has(surface))return{reject:true,reason:`Unsuitable road surface (${surface.replaceAll('_',' ')})`,penalty:0,confidencePenalty:0,flags:['surface']};if(smooth&&ROUGH.has(smooth)){if(['horrible','very_horrible','impassable'].includes(smooth))return{reject:true,reason:`Road condition unsuitable (${smooth.replaceAll('_',' ')})`,penalty:0,confidencePenalty:0,flags:['surface']};penalty+=smooth==='very_bad'?14:8;flags.push('rough')}if(String(tags.narrow||'').toLowerCase()==='yes'){penalty+=10;flags.push('narrow')}if(Number.isFinite(width)&&width>0&&width<3.2){penalty+=14;flags.push('very-narrow')}else if(Number.isFinite(width)&&width<4.2){penalty+=7;flags.push('narrow-width')}if(Number.isFinite(lanes)&&lanes<=1){penalty+=7;flags.push('single-lane')}if(!surface)confidencePenalty+=2;if(!smooth)confidencePenalty+=1;return{reject:false,reason:'',penalty,confidencePenalty,flags,widthMeters:width}}

function clamp(n,min=0,max=100){return Math.max(min,Math.min(max,Number(n)||0))}
// Convert the posted/estimated speed into an enjoyment-oriented pace score.
// 60 mph rural roads are the sweet spot; 70 mph is not automatically better,
// and 50 mph roads no longer suffer the old artificial 40/60 scoring cliff.
function drivingPaceScore(speedMph){
  const s=Math.max(0,Number(speedMph)||0);
  if(s<=20)return clamp(s/20*22);
  if(s<=30)return 22+((s-20)/10)*18;
  if(s<=40)return 40+((s-30)/10)*25;
  if(s<=50)return 65+((s-40)/10)*20;
  if(s<=60)return 85+((s-50)/10)*15;
  if(s<=70)return 100-((s-60)/10)*10;
  return 88;
}
function roadClassEnjoymentBonus(highway=''){
  switch(String(highway||'').toLowerCase()){
    case 'tertiary': return 6;
    case 'secondary': return 5;
    case 'unclassified': return 4;
    case 'primary': return 2;
    case 'trunk': return -2;
    case 'residential': return -7;
    case 'living_street': return -12;
    case 'service': return -14;
    default:return 0;
  }
}
// Pure scoring kernel used by the browser scorer and deterministic tests.
// The five positive components sum to 100 before small road-fit bonuses and
// evidence/quality penalties, which keeps Road Score better calibrated and
// avoids large numbers of unrelated roads saturating at 100.
function drivingRoadScore(input={}){
  const twist=clamp(input.twistScore);
  const length=clamp(input.lengthScore);
  const pace=Number.isFinite(Number(input.paceScore))?clamp(input.paceScore):drivingPaceScore(input.speedMph);
  const rhythm=clamp((Number(input.accelRhythmScore)||0)/15*100);
  const scenery=clamp(input.sceneryScore);
  const penalty=Math.max(0,Number(input.penaltyTotal)||0);
  const urban=clamp((Number(input.urbanExposure)||0)*100)/100;
  const speed=Math.max(0,Number(input.speedMph)||0);
  const highway=String(input.highwayType||'').toLowerCase();
  const classBonus=roadClassEnjoymentBonus(highway);
  const ruralFitBonus=urban<=0.12&&speed>=40&&speed<=60?4:urban<=0.25&&speed>=40&&speed<=60?2:0;
  const surfaceBonus=input.surfaceKnownGood?2:0;
  const technicalBaseScore=Math.round(
    twist*.42 + length*.17 + pace*.13 + rhythm*.13 + scenery*.15 +
    classBonus + ruralFitBonus + surfaceBonus - penalty
  );
  const isFlowRoadType=['trunk','primary','secondary','tertiary'].includes(highway);
  const flowCandidate=!input.reason&&urban<.25&&!input.isMotorwayOrDual&&isFlowRoadType&&speed>=50&&Number(input.totalLen||0)>=350;
  let flowBaseScore=0,flowScore=0;
  if(flowCandidate){
    flowBaseScore=Math.round(
      pace*.28 + length*.15 + scenery*.22 + rhythm*.13 + twist*.14 +
      classBonus + ruralFitBonus + surfaceBonus - penalty
    );
    // Fast-but-boring roads should not become "Exceptional" merely because
    // they are rural A-roads. They need bends/rhythm or genuine scenery.
    const lowInterest=twist<12&&rhythm<25&&scenery<45;
    const noScenery=Number(input.sceneryPts||0)<4&&twist<16&&rhythm<35;
    const cap=lowInterest?48:noScenery?58:78;
    flowScore=Math.min(cap,flowBaseScore);
  }
  const technicalScore=Math.round(technicalBaseScore*(Number.isFinite(Number(input.lengthMultiplier))?Number(input.lengthMultiplier):1));
  const scoringMode=flowScore>technicalScore?'flow':'technical';
  const score=clamp(Math.max(technicalScore,flowScore));
  return{score:Math.round(score),technicalBaseScore,technicalScore,flowCandidate,flowBaseScore,flowScore,scoringMode,classBonus,ruralFitBonus,surfaceBonus,paceScore:Math.round(pace),rhythmScore:Math.round(rhythm)};
}

function roadDataConfidence(tags={},options={}){let score=34;const missing=[];const add=(ok,points,label)=>{if(ok)score+=points;else missing.push(label)};add(Boolean(tags.maxspeed),18,'speed limit');add(Boolean(tags.surface),12,'surface');add(Boolean(tags.smoothness),8,'condition');add(Boolean(tags.lanes),9,'lanes');add(Boolean(tags.width),7,'width');add(Boolean(tags.name||tags.ref),6,'road identity');add(Boolean(tags.highway),4,'road class');if(tags.motorcar||tags.motor_vehicle||tags.vehicle||tags.access)score+=2;if(options.speedIsEstimated)score-=10;if(Number(options.geometryPoints||0)>=12)score+=5;else if(Number(options.geometryPoints||0)<6)score-=6;if(Number(options.urbanSamples||0)>=5)score+=2;score-=Math.min(8,Number(options.confidencePenalty||0)*2);score=Math.max(25,Math.min(98,Math.round(score)));return{score,label:RF.confidenceLabel?RF.confidenceLabel(score):(score>=78?'High':score>=58?'Medium':'Low'),missing}}
Object.assign(RF,{accessStatus,roadQuality,roadDataConfidence,parseMeasureMeters,drivingPaceScore,roadClassEnjoymentBonus,drivingRoadScore});
})(globalThis);
