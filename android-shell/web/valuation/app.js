const DRIVEHUB_HOST_CONTEXT=(()=>{
  const ownProtocol=String(location.protocol||'');
  if(/^https?:$/.test(ownProtocol))return {protocol:ownProtocol,origin:location.origin};
  if(ownProtocol==='file:')return {protocol:'file:',origin:''};
  try{
    if(window.parent!==window){
      const parentProtocol=String(parent.location.protocol||'');
      if(/^https?:$/.test(parentProtocol))return {protocol:parentProtocol,origin:parent.location.origin};
      if(parentProtocol==='file:')return {protocol:'file:',origin:''};
    }
  }catch{}
  return {protocol:ownProtocol,origin:''};
})();
const DRIVEHUB_HOST_PROTOCOL=DRIVEHUB_HOST_CONTEXT.protocol;
const DRIVEHUB_NATIVE=Boolean(window.DriveHubRuntime?.isNative);
const DRIVEHUB_FILE_MODE=!window.DriveHubRuntime?.hasHostedBackend&&!/^https?:$/.test(DRIVEHUB_HOST_PROTOCOL);
const DRIVEHUB_API_URL=window.DriveHubRuntime?.apiUrl?.('/api/valuation')||(DRIVEHUB_HOST_CONTEXT.origin?new URL('/api/valuation',DRIVEHUB_HOST_CONTEXT.origin).href:'/api/valuation');
const MY_GARAGE_URL=DRIVEHUB_FILE_MODE?'../../my-garage/public/index.html':'/garage/';
const STORAGE_KEY='garage.mvp.v1.anonymous';
const SAVED_VALUATIONS_KEY='drivehub.valuation.saved.v1';
const app=document.getElementById('app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const money=n=>Number.isFinite(Number(n))?new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(Number(n)):'—';
const fmtDate=d=>d?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(d)):'—';
const fmtShortDate=d=>d?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric'}).format(new Date(d)):'previous check';
const miles=n=>Number(n||0).toLocaleString('en-GB');
const carSvg='<svg viewBox="0 0 24 24"><path d="M5 11l1.7-4.2A2 2 0 0 1 8.6 5.5h6.8a2 2 0 0 1 1.9 1.3L19 11"/><path d="M4 12h16v5.2A1.8 1.8 0 0 1 18.2 19H17v-2H7v2H5.8A1.8 1.8 0 0 1 4 17.2z"/><path d="M7.5 14.5h2M14.5 14.5h2"/></svg>';
let state=loadState(),selectedId='',manualSubject=null,result=null,currentView='new',activeSavedId='',lastValuationError='',lastValuationRetryable=true,lastFailedSubject=null,lastFailedVehicleId='',lastFailedSavedId='';
let prefillVehicleId='';
try{prefillVehicleId=localStorage.getItem('drivehub.valuation.prefillVehicleId')||'';localStorage.removeItem('drivehub.valuation.prefillVehicleId')}catch{}
if(prefillVehicleId&&(state.vehicles||[]).some(v=>v.id===prefillVehicleId))selectedId=prefillVehicleId;

function loadState(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')||{vehicles:[],reminders:[],_meta:{}}}catch{return {vehicles:[],reminders:[],_meta:{}}}}
function saveState(){state._meta={...(state._meta||{}),updatedAt:new Date().toISOString()};localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}
function loadSavedValuations(){try{const value=JSON.parse(localStorage.getItem(SAVED_VALUATIONS_KEY)||'[]');return Array.isArray(value)?value:[]}catch{return []}}
function saveSavedValuations(items){localStorage.setItem(SAVED_VALUATIONS_KEY,JSON.stringify((items||[]).slice(0,100)))}
function vehicleTitle(v){return [v.year,v.make,v.model,v.derivative].filter(Boolean).join(' ')||v.registration||'Saved car'}
function vehicleMeta(v){return [v.registration,v.bodyType,v.engineSize,v.transmission,v.mileage?`${miles(v.mileage)} miles`:null].filter(Boolean).join(' · ')}
function subjectTitle(v){return [v?.year,v?.make,v?.model,v?.derivative].filter(Boolean).join(' ')||'Vehicle'}
function subjectMeta(v){return [v?.bodyType,v?.engineSize,v?.transmission,v?.mileage?`${miles(v.mileage)} miles`:null].filter(Boolean).join(' · ')}
function subjectFor(v){return {year:v.year||'',make:v.make||'',model:v.model||'',derivative:v.derivative||'',transmission:v.transmission||'',mileage:Number(v.mileage||0),engineSize:v.engineSize||'',fuelType:v.fuelType||'',bodyType:v.bodyType||'',specification:(v.specification||[]).filter(s=>s&&!s._deleted).map(s=>({label:s.label||'',value:s.value||''})).slice(0,30)}}
function openMyGarage(){
  try{if(window.parent!==window){parent.postMessage({type:'drivehub-open',tool:'garage'},'*');return}}catch{}
  location.href=MY_GARAGE_URL;
}
function toast(text,state='info'){
  if(window.DriveHubChrome?.showStatus){window.DriveHubChrome.showStatus(text,state);return}
  const el=document.getElementById('toast');if(!el)return;el.textContent=text;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,3200)
}
function makeSavedId(){return `val-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`}
function syncNav(){
  const isSaved=currentView==='saved';
  const navNew=document.getElementById('navNewValuation');
  const navSaved=document.getElementById('navSavedValuations');
  if(navNew){navNew.classList.toggle('active',!isSaved);navNew.setAttribute('aria-pressed',String(!isSaved))}
  if(navSaved){navSaved.classList.toggle('active',isSaved);navSaved.setAttribute('aria-pressed',String(isSaved))}
  const count=document.getElementById('savedValuationCount');
  const total=loadSavedValuations().length;
  if(count){count.textContent=String(total);count.hidden=!total}
}
function currentResultContext(){
  const selected=(state.vehicles||[]).find(v=>v.id===selectedId);
  const subject=selected?subjectFor(selected):manualSubject;
  const val=selected?.valuation?.privateSale&&!result?selected.valuation:result;
  return {selected,subject,val};
}
function findSavedSnapshot(subject,val){
  if(!subject||!val)return null;
  const signature=[subject.year,subject.make,subject.model,subject.derivative,subject.mileage,subject.transmission].map(x=>String(x||'').trim().toLowerCase()).join('|');
  return loadSavedValuations().find(item=>item.signature===signature && Number(item.valuation?.privateSale||0)===Number(val.privateSale||0))||null;
}
function saveCurrentValuation(){
  const {selected,subject,val}=currentResultContext();
  if(!subject||!val?.privateSale)return;
  const items=loadSavedValuations();
  const signature=[subject.year,subject.make,subject.model,subject.derivative,subject.mileage,subject.transmission].map(x=>String(x||'').trim().toLowerCase()).join('|');
  const existing=items.find(item=>item.signature===signature && Number(item.valuation?.privateSale||0)===Number(val.privateSale||0));
  if(existing){toast('Valuation already saved');return}
  const now=new Date().toISOString();
  items.unshift({id:makeSavedId(),signature,subject:{...subject},valuation:{...val},createdAt:now,valuedAt:val.updatedAt||now,refreshedAt:now,vehicleId:selected?.id||''});
  saveSavedValuations(items);
  syncNav();
  render();
  toast('Valuation saved');
}

function valuationConfidenceInfo(val={}){
  const score=Math.max(0,Math.min(100,Number(val.confidenceScore||0)||0));
  const count=Number(val.comparableCount||0),quality=Number(val.matchQuality||0);
  const tier=String(val.matchStrategy?.tierUsed||'').toLowerCase();
  const generation=String(val.matchStrategy?.targetGeneration||'').trim();
  const label=score>=78?'High':score>=58?'Medium':'Low';
  const reasons=[];
  if(count>=7)reasons.push(`${count} close matches`);else if(count)reasons.push(`only ${count} close match${count===1?'':'es'}`);
  if(quality)reasons.push(`${quality}% average match quality`);
  if(generation)reasons.push(`${generation} generation matched`);
  if(tier==='weak')reasons.push('broader compatible matches were needed');
  else if(tier==='good')reasons.push('some specification criteria were relaxed');
  else if(tier==='excellent')reasons.push('strict specification matching held');
  let summary='Useful market evidence, with some uncertainty remaining.';
  if(label==='High')summary='Strong market evidence: the estimate is supported by a good sample of closely matched cars.';
  if(label==='Low')summary='Treat this as a guide: the available market evidence is relatively thin or less closely matched.';
  return{score,label,summary,reasons};
}
function mileageEvidenceMarkup(val={}){
  const model=val.mileageAdjustment;if(!model?.targetMileage)return'';
  const target=Number(model.targetMileage||0),average=Number(model.averageComparableMileage||0),effect=Number(model.priceEffectPer10000||0);
  const delta=average&&target?target-average:0;
  let text='Mileage was included, but there were not enough mileage-labelled comparables to derive a reliable market adjustment.';
  if(model.reliable&&effect){
    const direction=effect<0?'lower':'higher';
    text=`Mileage-normalised using ${model.comparableMileageCount||0} comparables. The market model indicates roughly ${money(Math.abs(effect))} ${direction} value per 10,000 additional miles.`;
  }
  const comparison=average?` Your car: ${miles(target)} miles · comparable average: ${miles(average)} miles${delta?` · ${miles(Math.abs(delta))} ${delta>0?'above':'below'} average`:''}.`:'';
  return `<div class="mileage-evidence"><strong>Mileage adjustment</strong><span>${esc(text+comparison)}</span></div>`;
}
function valuationHistoryMarkup(item){
  if(!item)return'';
  const rows=[...(Array.isArray(item.history)?item.history:[]),{valuation:item.valuation,valuedAt:item.valuedAt||item.refreshedAt||item.createdAt}]
    .filter(x=>Number(x?.valuation?.privateSale)>0)
    .slice(-6)
    .reverse();
  if(rows.length<2)return'';
  return `<div class="valuation-history"><div class="valuation-history__head"><strong>Valuation history</strong><span>${rows.length} latest checks</span></div><div class="valuation-history__rows">${rows.map((row,index)=>`<div class="valuation-history__row${index===0?' current':''}"><span>${esc(fmtShortDate(row.valuedAt||row.valuation?.updatedAt))}</span><strong>${money(row.valuation?.privateSale)}</strong></div>`).join('')}</div></div>`;
}
function valuationMovementMarkup(item,detailed=false){
  const current=Number(item?.valuation?.privateSale),previous=Number(item?.previousValuation?.privateSale);
  if(!Number.isFinite(current)||!Number.isFinite(previous)||previous<=0)return'';
  const diff=Math.round(current-previous),abs=Math.abs(diff);
  const tone=diff>0?'up':diff<0?'down':'flat';
  const symbol=diff>0?'↑':diff<0?'↓':'→';
  const label=diff===0?'No change':`${symbol} ${money(abs)}`;
  const context=`since ${fmtShortDate(item.previousValuedAt||item.previousValuation?.updatedAt)}`;
  return `<span class="valuation-movement ${tone}${detailed?' detailed':''}"><strong>${label}</strong><small>${context}</small></span>`;
}
function valuationErrorMarkup(){
  if(!lastValuationError)return'';
  return `<section class="dh-state dh-state--error valuation-error" role="alert"><div class="dh-state__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 17h.01"></path></svg></div><h2>Couldn’t update the valuation</h2><p>${esc(lastValuationError)}</p><div class="dh-state__actions">${lastValuationRetryable?'<button class="dh-state__action" type="button" data-retry-valuation>Try again</button>':''}<button class="dh-state__action dh-state__action--secondary" type="button" data-dismiss-valuation-error>Dismiss</button></div></section>`;
}
function resultMarkup(subject,val,savedVehicle,savedItem=null){
  if(!val?.privateSale)return'';
  const title=subjectTitle(subject),meta=subjectMeta(subject);
  const confidence=valuationConfidenceInfo(val);
  const comps=(val.comparables||[]).slice(0,8).map(c=>`<a class="comparable" href="${esc(c.url||'#')}" target="_blank" rel="noopener"><div><strong>${esc(c.title)}</strong><small>${esc([c.year,c.generation,c.bodyType,c.mileage?`${miles(c.mileage)} mi`:null,c.matchTier?`${c.matchTier} match`:null].filter(Boolean).join(' · '))}</small></div><span>${money(c.adjustedPrice||c.price)}<small>${c.matchScore?`${esc(c.matchScore)}% match`:''}</small></span></a>`).join('');
  const snapshot=findSavedSnapshot(subject,val);
  return `<section class="result"><div class="result-head"><div><p class="kicker" style="color:#d0dedb">CURRENT ESTIMATE</p><h2>${esc(title)}</h2>${meta?`<p>${esc(meta)}</p>`:''}</div><span class="confidence confidence-${confidence.label.toLowerCase()}"><strong>${confidence.label}</strong><small>${confidence.score||'—'} / 100</small></span></div><div class="prices"><div class="price primary-price"><span>Private sale</span><strong>${money(val.privateSale)}</strong><small>Estimated achievable asking price</small></div><div class="price"><span>Part exchange</span><strong>${money(val.trade)}</strong><small>Estimated dealer PX value</small></div><div class="price"><span>Dealer retail</span><strong>${money(val.retail)}</strong><small>Indicative forecourt price</small></div></div><div class="valuation-trust"><div><span class="valuation-trust__label">Confidence</span><strong>${esc(confidence.summary)}</strong></div><ul>${confidence.reasons.slice(0,4).map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul></div><div class="market-meta"><span>${Number(val.comparableCount||0)} close matches</span><span>${fmtDate(val.updatedAt)}</span><span>${Number(val.matchQuality||0)||'—'}% match quality</span></div>${savedItem?valuationMovementMarkup(savedItem,true):''}<div class="result-actions three"><button class="secondary" type="button" data-refresh>${savedVehicle?'Refresh':'Run again'}</button><button class="save-btn ${snapshot?'saved':''}" type="button" data-save-valuation ${snapshot?'disabled':''}>${snapshot?'Saved':'Save valuation'}</button>${savedVehicle?'<button class="text-btn" type="button" data-open-garage>Open in MyGarage</button>':'<button class="text-btn" type="button" data-clear>Value another car</button>'}</div><details class="details"><summary>See valuation evidence</summary><div class="detail-grid"><div><span>Listings checked</span><strong>${Number(val.searchCandidateCount||0)||'—'}</strong></div><div><span>Cars used</span><strong>${Number(val.comparableCount||0)||'—'}</strong></div><div><span>Weighted median</span><strong>${money(val.medianAsk)}</strong></div><div><span>Typical range</span><strong>${val.range?.low&&val.range?.high?`${money(val.range.low)} – ${money(val.range.high)}`:'—'}</strong></div></div>${mileageEvidenceMarkup(val)}${valuationHistoryMarkup(savedItem)}${comps?`<div class="comparables">${comps}</div>`:''}</details></section>`;
}
function savedCarsMarkup(){
  const vehicles=Array.isArray(state.vehicles)?state.vehicles:[];
  if(!vehicles.length)return`<section class="dh-state dh-state--quiet valuation-empty"><div class="dh-state__icon" aria-hidden="true">${carSvg}</div><p class="kicker">MYGARAGE</p><h2>No saved cars yet</h2><p>Add a car in MyGarage and its details will appear here automatically, ready to value without re-entering them.</p><div class="dh-state__actions"><a class="dh-state__action" href="${MY_GARAGE_URL}">Open MyGarage</a></div></section>`;
  return`<section class="panel"><div class="panel-head"><div><p class="kicker">MYGARAGE</p><h2>Value one of my cars</h2><p>Uses the specification already saved in MyGarage.</p></div></div><div class="car-list">${vehicles.map(v=>`<button class="car ${selectedId===v.id?'active':''}" type="button" data-car="${esc(v.id)}"><span class="car-icon">${carSvg}</span><span><strong>${esc(vehicleTitle(v))}</strong><small>${esc(vehicleMeta(v))}</small><em>${v.valuation?.privateSale?money(v.valuation.privateSale):'Not valued yet'}</em></span><b>›</b></button>`).join('')}</div></section>`;
}
function formMarkup(){return`<section class="panel"><div class="panel-head"><div><p class="kicker">ANY CAR</p><h2>Value another car</h2><p>Year and body type help prevent unlike generations or variants being compared.</p></div></div><form id="valuation-form"><div class="field-grid"><div class="field"><label>Make</label><input name="make" required placeholder="e.g. Jaguar"></div><div class="field"><label>Model</label><input name="model" required placeholder="e.g. F-Type"></div><div class="field"><label>Year</label><input name="year" required type="number" min="1900" max="${new Date().getFullYear()+1}" placeholder="2018"></div><div class="field"><label>Mileage <span class="optional">recommended</span></label><input name="mileage" inputmode="numeric" placeholder="45,000"></div><div class="field"><label>Body type <span class="optional">recommended</span></label><select name="bodyType"><option value="">Select</option><option>Hatchback</option><option>Saloon</option><option>Estate</option><option>SUV</option><option>Coupe</option><option>Convertible</option><option>Targa</option><option>Pickup</option></select></div><div class="field"><label>Derivative / trim</label><input name="derivative" placeholder="e.g. V6 S"></div><div class="field"><label>Engine</label><input name="engineSize" placeholder="e.g. 3.0L"></div><div class="field"><label>Transmission</label><select name="transmission"><option value="">Select</option><option>Automatic</option><option>Manual</option><option>Semi-auto</option></select></div><div class="field"><label>Fuel</label><select name="fuelType"><option value="">Select</option><option>Petrol</option><option>Diesel</option><option>Electric</option><option>Hybrid</option><option>Plug-in hybrid</option><option>LPG</option></select></div></div><p class="form-note">Searches are restricted to eBay UK Cars. Known generation/facelift, body-style and engine conflicts are rejected before mileage is used to adjust price.</p><button class="primary" id="submit" type="submit">Get valuation</button></form></section>`}
function savedValuationsMarkup(){
  const items=loadSavedValuations();
  if(!items.length)return`<section class="dh-state dh-state--quiet saved-empty"><div class="dh-state__icon" aria-hidden="true">${carSvg}</div><p class="kicker">SAVED VALUATIONS</p><h2>Nothing saved yet</h2><p>Save any completed valuation and DriveHub will keep the price and date here so you can refresh it later.</p><div class="dh-state__actions"><button class="dh-state__action" type="button" data-new-from-empty>New valuation</button></div></section>`;
  return `<section class="saved-section"><div class="saved-heading"><div><p class="kicker">SAVED VALUATIONS</p><h2>${items.length} saved valuation${items.length===1?'':'s'}</h2></div><p>Refresh any valuation to check the latest market.</p></div><div class="saved-list">${items.map(item=>{const val=item.valuation||{};return`<article class="saved-valuation ${activeSavedId===item.id?'active':''}" data-saved-card="${esc(item.id)}"><button class="saved-main" type="button" data-open-saved="${esc(item.id)}"><span><strong>${esc(subjectTitle(item.subject))}</strong><small>${esc(subjectMeta(item.subject))}</small><em>Done ${esc(fmtDate(item.valuedAt||val.updatedAt||item.refreshedAt||item.createdAt))}</em>${valuationMovementMarkup(item)}</span><span class="saved-price"><small>Private sale</small><strong>${money(val.privateSale)}</strong><b>›</b></span></button><div class="saved-actions"><button class="secondary compact" type="button" data-refresh-saved="${esc(item.id)}">Refresh</button></div></article>`}).join('')}</div></section>`;
}
function renderSavedDetail(){
  if(!activeSavedId)return'';
  const item=loadSavedValuations().find(x=>x.id===activeSavedId);
  if(!item)return'';
  return resultMarkup(item.subject,item.valuation,false,item).replace(/data-refresh/g,`data-refresh-saved-detail="${esc(item.id)}"`).replace(/data-save-valuation(?: disabled)?/g,'data-noop-save disabled').replace('>Run again</button>','>Refresh</button>').replace('>Value another car</button>','>Back to saved valuations</button>');
}
function render(){
  state=loadState();
  const errorState=valuationErrorMarkup();
  if(currentView==='saved'){
    app.innerHTML=errorState+renderSavedDetail()+savedValuationsMarkup();
  }else{
    const {selected,subject,val}=currentResultContext();
    app.innerHTML=errorState+(subject&&val?resultMarkup(subject,val,!!selected):'')+savedCarsMarkup()+(!selectedId?formMarkup():'');
  }
  syncNav();
  bind();
}
function setView(view,{reset=false}={}){
  currentView=view==='saved'?'saved':'new';
  activeSavedId='';
  if(reset&&currentView==='new'){selectedId='';manualSubject=null;result=null;lastValuationError='';lastValuationRetryable=true;lastFailedSubject=null;lastFailedVehicleId='';lastFailedSavedId=''}
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}
function bind(){
  document.querySelectorAll('[data-car]').forEach(btn=>btn.onclick=()=>{selectedId=btn.dataset.car;manualSubject=null;result=null;render();const v=(state.vehicles||[]).find(x=>x.id===selectedId);if(v&&!v.valuation?.privateSale)runValuation(subjectFor(v),v)});
  const form=document.getElementById('valuation-form');
  if(form)form.onsubmit=e=>{e.preventDefault();if(!form.reportValidity())return;const f=new FormData(form);manualSubject={make:String(f.get('make')||'').trim(),model:String(f.get('model')||'').trim(),year:Number(f.get('year')||0)||'',mileage:Number(String(f.get('mileage')||'').replace(/,/g,''))||0,bodyType:String(f.get('bodyType')||''),derivative:String(f.get('derivative')||'').trim(),engineSize:String(f.get('engineSize')||'').trim(),transmission:String(f.get('transmission')||''),fuelType:String(f.get('fuelType')||''),specification:[]};runValuation(manualSubject,null)};
  document.querySelector('[data-refresh]')?.addEventListener('click',()=>{const v=(state.vehicles||[]).find(x=>x.id===selectedId);runValuation(v?subjectFor(v):manualSubject,v||null)});
  document.querySelector('[data-clear]')?.addEventListener('click',()=>{if(currentView==='saved'){activeSavedId='';render();return}selectedId='';manualSubject=null;result=null;render()});
  document.querySelector('[data-open-garage]')?.addEventListener('click',openMyGarage);
  document.querySelector('[data-save-valuation]')?.addEventListener('click',saveCurrentValuation);
  document.querySelector('[data-new-from-empty]')?.addEventListener('click',()=>setView('new',{reset:true}));
  document.querySelectorAll('[data-open-saved]').forEach(btn=>btn.addEventListener('click',()=>{activeSavedId=btn.dataset.openSaved;render();window.scrollTo({top:0,behavior:'smooth'})}));
  document.querySelectorAll('[data-refresh-saved]').forEach(btn=>btn.addEventListener('click',()=>refreshSavedValuation(btn.dataset.refreshSaved,btn)));
  document.querySelector('[data-refresh-saved-detail]')?.addEventListener('click',e=>refreshSavedValuation(e.currentTarget.dataset.refreshSavedDetail,e.currentTarget));
  document.querySelector('[data-dismiss-valuation-error]')?.addEventListener('click',()=>{lastValuationError='';lastValuationRetryable=true;lastFailedSubject=null;lastFailedVehicleId='';lastFailedSavedId='';render()});
  document.querySelector('[data-retry-valuation]')?.addEventListener('click',e=>{
    if(lastFailedSavedId){refreshSavedValuation(lastFailedSavedId,e.currentTarget);return}
    if(!lastFailedSubject)return;
    const vehicle=(state.vehicles||[]).find(v=>v.id===lastFailedVehicleId)||null;
    runValuation(lastFailedSubject,vehicle);
  });
}
async function fetchValuation(subject,button){
  if(DRIVEHUB_FILE_MODE){lastValuationError='Live market valuation is unavailable when DriveHub is opened directly from a local file. Open the hosted/server version to use live market data.';lastValuationRetryable=false;toast(lastValuationError);return null}
  const oldText=button?.textContent;
  const endActivity=window.DriveHubChrome?.beginActivity?.('Checking market…');
  if(button){button.disabled=true;button.textContent='Checking market…'}
  try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),16000);let response;
    try{response=await fetch(DRIVEHUB_API_URL,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({vehicle:subject}),signal:controller.signal})}finally{clearTimeout(timer)}
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      if(response.status===404)throw new Error('This DriveHub deployment does not include the live valuation API. Use the DriveHub server build rather than a static-only deployment.');
      throw new Error(data.error||`Valuation failed (${response.status})`);
    }
    return data;
  }catch(err){lastValuationError=err?.name==='AbortError'?'The market service took too long to respond. Try again.':err.message||'Could not get a valuation right now.';lastValuationRetryable=true;toast(lastValuationError);return null}
  finally{endActivity?.();if(button&&button.isConnected){button.disabled=false;button.textContent=oldText||'Refresh'}}
}
async function runValuation(subject,savedVehicle){
  lastFailedSubject=subject?{...subject}:null;lastFailedVehicleId=savedVehicle?.id||'';lastFailedSavedId='';
  const btn=document.getElementById('submit')||document.querySelector('[data-refresh]');
  const data=await fetchValuation(subject,btn);
  if(!data){render();return}
  lastValuationError='';lastValuationRetryable=true;lastFailedSubject=null;lastFailedVehicleId='';
  result=data;
  if(savedVehicle){state=loadState();const v=(state.vehicles||[]).find(x=>x.id===savedVehicle.id);if(v){v.valuationHistory=Array.isArray(v.valuationHistory)?v.valuationHistory:[];v.valuationHistory.push({...data});v.valuationHistory=v.valuationHistory.slice(-24);v.valuation=data;v.updatedAt=new Date().toISOString();saveState();result=null}}
  render();toast(`${data.comparableCount||0} close matches used`);
}
async function refreshSavedValuation(id,button){
  const items=loadSavedValuations();
  const index=items.findIndex(item=>item.id===id);
  if(index<0)return;
  lastFailedSavedId=id;lastFailedSubject={...items[index].subject};lastFailedVehicleId='';
  const data=await fetchValuation(items[index].subject,button);
  if(!data){render();return}
  const now=new Date().toISOString(),previous={...(items[index].valuation||{})},previousAt=items[index].valuedAt||previous.updatedAt||items[index].refreshedAt||items[index].createdAt||now;
  const history=[...(Array.isArray(items[index].history)?items[index].history:[]),{valuation:previous,valuedAt:previousAt}].slice(-12);
  items[index]={...items[index],previousValuation:previous,previousValuedAt:previousAt,history,valuation:{...data},valuedAt:data.updatedAt||now,refreshedAt:now};
  lastValuationError='';lastValuationRetryable=true;lastFailedSavedId='';lastFailedSubject=null;
  saveSavedValuations(items);
  activeSavedId=id;
  render();
  toast(`Valuation refreshed · ${money(data.privateSale)}`);
}

document.getElementById('navNewValuation')?.addEventListener('click',()=>setView('new',{reset:true}));
document.getElementById('navSavedValuations')?.addEventListener('click',()=>setView('saved'));
render();
if(prefillVehicleId){const v=(state.vehicles||[]).find(x=>x.id===prefillVehicleId);if(v&&!v.valuation?.privateSale)runValuation(subjectFor(v),v)}
