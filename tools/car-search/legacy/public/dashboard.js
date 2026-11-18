/* Car Search Hub: a responsive website backed by a headless Chromium server. */
'use strict';
const STORE_KEY = 'car_search_hub_v1';
const SITE_NAMES = { autotrader: 'Auto Trader', ebay: 'eBay', pistonheads: 'PistonHeads', facebook: 'Facebook' };
const SITE_TAGS = { autotrader: 'AT', ebay: 'e', pistonheads: 'PH', facebook: 'f' };
const $ = id => document.getElementById(id);
const uid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'csh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,11);
const timeNow = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const fmtPrice = n => Number.isFinite(n) && n > 0 ? '£' + new Intl.NumberFormat('en-GB').format(n) : 'Price unknown';
const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { day:'numeric',month:'short',hour:'2-digit',minute:'2-digit' }) : 'Never';
const older = iso => { if (!iso) return 'Not checked'; const diff = Date.now() - new Date(iso).getTime(); if (diff < 60000) return 'Just now'; if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'; if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'; return when(iso); };
const initial = () => ({ version:1, searches:[], listings:{}, snapshots:{}, manualDuplicates:{}, hiddenBySearch:{}, options:{ pageDepth:3 } });
let state = initial();
let view = 'overview';
let editId = null, noteIds = [], deleteId = null, mergeFrom = null, manualEditId = null;
let detailIds = [], activeCarId = null;
const FILTER_FIELDS = ['priceMin','priceMax','mileageMin','mileageMax','yearMin','yearMax','engineMin','engineMax','bhpMin','bhpMax'];
const RESULT_FILTERS = ['resultPriceMin','resultPriceMax','resultYearMin','resultYearMax',
  'resultMileageMin','resultMileageMax','resultEngineMin','resultEngineMax',
  'resultBhpMin','resultBhpMax','resultColour','resultBodyType','resultTransmission','resultDistanceMax'];
const COLOUR_CHOICES = ['Black','White','Silver','Grey','Blue','Red','Green','Yellow','Orange','Purple','Brown','Gold','Beige','Other'];
const BODY_TYPE_CHOICES = [
  ['coupe','Coupe'],['convertible','Convertible / Roadster'],
  ['saloon','Saloon'],['hatchback','Hatchback'],['estate','Estate'],
  ['suv','SUV / 4x4'],['mpv','MPV'],['pickup','Pick-up'],
  ['van','Van'],['other','Other']
];
function bodyTypeForCar(car) {
  const allowed=BODY_TYPE_CHOICES.map(row=>row[0]);
  const explicit=String(car?.bodyType || '').toLowerCase().trim();
  if (allowed.includes(explicit)) return explicit;
  // Legacy adverts may not have been scanned since body-type extraction
  // was introduced. Only trust recognisable wording in the TITLE.
  const title=String(car?.title || '').toLowerCase();
  const types=[
    ['convertible',/\b(?:convertible|cabriolet|cabrio|roadster|drophead|soft[ -]?top|spyder|spider)\b/],
    ['coupe',/\b(?:coup[eé]|coupe)\b/],
    ['estate',/\b(?:estate|station wagon|touring|sportbrake|shooting brake)\b/],
    ['saloon',/\b(?:saloon|sedan)\b/],
    ['hatchback',/\b(?:hatchback|hatch)\b/],
    ['suv',/\b(?:suv|4x4|crossover)\b/],
    ['mpv',/\b(?:mpv|people carrier|minivan)\b/],
    ['pickup',/\b(?:pick[ -]?up)\b/],
    ['van',/\b(?:panel van|van)\b/]
  ].filter(([_,pattern])=>pattern.test(title));
  return types.length===1 ? types[0][0] : '';
}
function bodyTypeLabel(type) {
  return BODY_TYPE_CHOICES.find(row=>row[0]===type)?.[1] || '';
}
let scanBusy = false, abortScan = false, scanText = '', scanSubtext = '';
let scanSearchIds = [];
let facebookStatusLoaded = false;
// Cache only state-derived groups. UI filters are evaluated live on each change.
let derivedRevision = null;
const derivedVisibleIds = new Map(), derivedSearchGroups = new Map();
const derivedDisplayGroups = new Map(), derivedStats = new Map();
const derivedResultGroups = new Map();
function resetDerivedCache() {
  if (derivedRevision === revision) return;
  derivedRevision = revision;
  derivedVisibleIds.clear(); derivedSearchGroups.clear();
  derivedDisplayGroups.clear(); derivedStats.clear(); derivedResultGroups.clear();
}

let resultsLayout = 'list';
let listingMap = null, listingMapLayer = null;
const locationPoints = new Map();
const locationIssues = new Map();
let lastMapGroups = [];
let activeModalLocationIds = [];
const DEFAULT_DISTANCE_ORIGIN = {lat:53.36397,lng:-2.06781,label:'High Lane, Stockport'};
let DISTANCE_ORIGIN = DEFAULT_DISTANCE_ORIGIN;
function homeShortName() { return String(DISTANCE_ORIGIN.label || 'home').split(',')[0].trim(); }
function applyHomeLocation() {
  const home=state?.options?.home;
  DISTANCE_ORIGIN = home && Number.isFinite(home.lat) && Number.isFinite(home.lng) ? home : DEFAULT_DISTANCE_ORIGIN;
  document.querySelectorAll('.home-label').forEach(el => { el.textContent = homeShortName(); });
  const near=document.querySelector('#sortFilter option[value="distanceNear"]');
  const far=document.querySelector('#sortFilter option[value="distanceFar"]');
  if (near) near.textContent='Distance: nearest to '+homeShortName();
  if (far) far.textContent='Distance: furthest from '+homeShortName();
}
const distanceLookups = new Set();
const distanceFailures = new Set();
let distanceLookupBusy = false;
let mapSignature = '', mapRequestId = 0, mapShown = false;
let locationModalMap = null, locationModalMarker = null, locationModalRequest = 0;


function siteFor(input) {
  try {
    const host = new URL(input).hostname.toLowerCase();
    if (/(^|\.)autotrader\.co\.uk$/.test(host)) return 'autotrader';
    if (/(^|\.)ebay\.(co\.uk|com)$/.test(host)) return 'ebay';
    if (/(^|\.)pistonheads\.com$/.test(host)) return 'pistonheads';
    if (/(^|\.)facebook\.com$/.test(host)) return 'facebook';
  } catch { /* invalid URL */ }
  return null;
}
function cleanSearchUrl(input) {
  try { const u = new URL(input.trim()); if (u.protocol !== 'https:' || !siteFor(u.href)) return null; u.hash = ''; return u.href; }
  catch { return null; }
}
function linkUrl(link) {
  try { const u = new URL(link); return u.protocol === 'https:' && siteFor(u.href) ? u.href : ''; } catch { return ''; }
}
function imageUrl(input) {
  try { const u = new URL(input); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}
let revision=-1, statusPolling=false, seenRunning=false;
function accept(payload) {
  if (payload && payload.state) { state = payload.state; revision = payload.revision; applyHomeLocation(); }
  if (payload && payload.job) {
    scanBusy=!!payload.job.busy;
    abortScan=!!payload.job.stop;
    scanText=payload.job.label || '';
    scanSubtext=payload.job.detail || '';
    scanSearchIds=scanBusy ? (payload.job.searchIds || []) : [];
  }
}
// Google sign-in (when enabled on the server): each person's data lives in
// their own Google Drive. The server needs a fresh Google token about hourly.
const GOOGLE_LOGIN_SCOPE='openid email https://www.googleapis.com/auth/drive.appdata';
let authInfo={mode:'password'}, googleScript=null, googleRefresh=null, googleTokenExpires=0, lastSaveError='';
function loadGoogleScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!googleScript) googleScript=new Promise((resolve,reject) => {
    const tag=document.createElement('script');
    tag.src='https://accounts.google.com/gsi/client'; tag.async=true;
    tag.onload=()=>resolve();
    tag.onerror=()=>{ googleScript=null; reject(new Error('Google sign-in could not load. Check your connection.')); };
    document.head.appendChild(tag);
  });
  return googleScript;
}
async function googleToken(prompt) {
  await loadGoogleScript();
  return new Promise((resolve,reject) => {
    const client=google.accounts.oauth2.initTokenClient({
      client_id:authInfo.googleClientId, scope:GOOGLE_LOGIN_SCOPE,
      callback:reply => reply?.error ? reject(new Error(reply.error_description || 'Google sign-in was not completed.')) : resolve(reply),
      error_callback:error => reject(new Error(error?.type==='popup_closed' ? 'Google sign-in was closed.' :
        error?.type==='popup_failed_to_open' ? 'Allow pop-ups for this site to sign in with Google.' :
        (error?.message || 'Google sign-in was not completed.')))
    });
    client.requestAccessToken({prompt});
  });
}
async function signInWithGoogle(prompt='') {
  if (googleRefresh) return googleRefresh;
  googleRefresh=(async () => {
    const reply=await googleToken(prompt);
    const answer=await rawApi('/api/google/session',{method:'POST',body:JSON.stringify({accessToken:reply.access_token})});
    googleTokenExpires=Date.now()+Number(reply.expires_in || 3600)*1000;
    authInfo.email=answer.email; authInfo.authenticated=true;
    showAccount();
    return answer;
  })();
  try { return await googleRefresh; } finally { googleRefresh=null; }
}
function showAccount() {
  const google=authInfo.mode==='google';
  $('googleAccountLine').classList.toggle('hidden',!google);
  if (google) {
    $('googleAccountLabel').textContent=authInfo.email ? 'Signed in as '+authInfo.email : 'Signed in with Google';
    $('storageHelp').textContent='Your searches, listings, saved cars and notes are kept in your own Google Drive (in a private Car Search app folder), not on this server. They appear on any device where you sign in with the same Google account.';
  }
}
function showLogin(message='') {
  const google=authInfo.mode==='google';
  $('passwordLogin').classList.toggle('hidden',google);
  $('loginSubmit').classList.toggle('hidden',google);
  $('googleLoginButton').classList.toggle('hidden',!google);
  $('loginPassword').required=!google;
  $('loginIntro').textContent=google ?
    'Sign in with your Google account. Your searches and saved cars are kept in your own Google Drive, so each person sees only their own.' :
    'Your searches and saved cars are on your server. Sign in to see them from any device.';
  $('loginError').textContent=message;
  $('loginOverlay').classList.remove('hidden');
}
async function rawApi(url, options={}) {
  const response = await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});
  let body=null;
  try { body=await response.json(); } catch {}
  if (!response.ok) {
    const error=new Error(body?.detail || body?.error || 'Request failed ('+response.status+').');
    error.status=response.status; error.reauth=body?.reauth;
    throw error;
  }
  return body;
}
async function api(url, options={}) {
  try {
    const body=await rawApi(url,options);
    if (body && 'saveError' in body && body.saveError!==lastSaveError) {
      lastSaveError=body.saveError || '';
      if (lastSaveError) toast(lastSaveError,true);
    }
    return body;
  } catch (error) {
    if (error.status===401 && url!=='/api/login' && url!=='/api/google/session') {
      if (error.reauth==='google' && authInfo.authenticated) {
        // Quietly renew the hourly Google sign-in, then retry once.
        try { await signInWithGoogle(''); return await rawApi(url,options); }
        catch (renewError) { authInfo.authenticated=false; showLogin('Your Google sign-in has expired. Sign in again to keep saving to Google Drive.'); }
      } else showLogin();
    }
    throw error;
  }
}
async function load() {
  const payload=await api('/api/state');
  accept(payload); render();
  if (!facebookStatusLoaded) {
    facebookStatusLoaded = true;
    void fbLoadStatus();
  }
}
function toast(msg, isError = false) {
  const el = document.createElement('div'); el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg; $('toastArea').append(el);
  setTimeout(() => { el.remove(); }, 6000);
}
function setNotice(text) {
  $('notice').textContent = text || '';
  $('notice').classList.toggle('hidden', !text);
}
function show(id) { $(id).showModal(); }
function hide(id) { $(id).close(); }
function displaySite(site, cls = '') { return `<span class="site-pill ${esc(site)} ${cls}">${esc(SITE_TAGS[site] || '?')} <span>${esc(SITE_NAMES[site] || 'Unknown')}</span></span>`; }
function availableIds(search) {
  const result = new Set();
  for (const link of search.links || []) for (const id of state.snapshots[link.id]?.ids || []) if (state.listings[id]) result.add(id);
  return [...result];
}
function searchColourMatchesGroup(group, search) {
  const selected = search?.filters?.colours || [];
  if (!selected.length) return true;
  const known = group.map(exteriorColour).filter(Boolean);
  if (!known.length) return search?.filters?.includeUnknownColours === true;
  // Another website may know the paint when this one does not. Require
  // consistent known colours to avoid allowing a blue search to show red cars.
  return known.every(colour => selected.includes(colour));
}
function searchBodyTypeMatchesGroup(group, search) {
  const selected=search?.filters?.bodyTypes || [];
  if (!selected.length) return true;
  const known=group.map(bodyTypeForCar).filter(Boolean);
  // Unlike exterior paint strict mode, missing body style always passes.
  // A confirmed conflicting body type in a merged advert must not pass.
  return !known.length || known.every(type=>selected.includes(type));
}
function normaliseExcludedText(value) {
  // Shared word/phrase matching: case-insensitive, punctuation as whitespace.
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function keywordTerms(value) {
  return [...new Set(String(value || '').split(/[,;\n\r]+/)
    .map(normaliseExcludedText).filter(Boolean))];
}
function keywordGroups(value) {
  // Commas/semicolons separate clauses; | or a standalone OR separates
  // alternatives within each clause. Supports 'C4S OR Carrera 4S, manual'.
  return String(value || '').split(/[,;\n\r]+/)
    .map(clause => [...new Set(clause.split(/\s+\bOR\b\s+|\s*\|\s*/i)
      .map(normaliseExcludedText).filter(Boolean))]).filter(group => group.length);
}
function textHasPhrase(value, term) {
  return (' ' + normaliseExcludedText(value) + ' ').includes(' ' + term + ' ');
}
function keywordMatchInCar(group, term) {
  return group.some(car => textHasPhrase(car.title, term) ||
    textHasPhrase(car.description, term));
}
function searchRequiredGroup(group, search) {
  const clauses = keywordGroups(search?.filters?.requiredKeywords);
  if (!clauses.length) return true;
  const matches = alternatives =>
    alternatives.some(term => keywordMatchInCar(group, term));
  // AND/OR of comma-delimited clauses; each clause can itself contain OR.
  return search?.filters?.requiredKeywordLogic === 'any'
    ? clauses.some(matches) : clauses.every(matches);
}
function searchExcludedGroup(group, search) {
  // Any matched word/phrase anywhere excludes the whole grouped vehicle.
  return keywordGroups(search?.filters?.excludeKeywords).some(alternatives =>
    alternatives.some(term => keywordMatchInCar(group, term)));
}
function preferredKeywords(search) {
  // Existing "Extra keywords" are preserved as preferred when upgrading.
  return search?.filters?.preferredKeywords ?? search?.filters?.keywords ?? '';
}
function searchPreferredScore(group, search) {
  // For alternatives use the best match, not a double reward for synonyms.
  return keywordGroups(preferredKeywords(search)).reduce((score, alternatives) =>
    score + Math.max(0, ...alternatives.map(term =>
      group.some(car => textHasPhrase(car.title, term)) ? 2 :
      group.some(car => textHasPhrase(car.description, term)) ? 1 : 0)), 0);
}
function matchingSearchIds(search) {
  const ids = availableIds(search);
  if (!search?.filters?.colours?.length && !search?.filters?.bodyTypes?.length &&
      !search?.filters?.excludeKeywords && !search?.filters?.requiredKeywords) return ids;
  // Match per grouped vehicle, not per advert; preserve other searches,
  // saved adverts, notes and original provider evidence.
  return grouped(ids.map(id => state.listings[id]).filter(Boolean))
    .filter(group => searchColourMatchesGroup(group, search) &&
      searchBodyTypeMatchesGroup(group, search) &&
      searchRequiredGroup(group, search) && !searchExcludedGroup(group, search))
    .flatMap(group => group.map(car => car.id));
}
function searchHiddenIds(search) {
  return new Set(state.hiddenBySearch?.[search?.id] || []);
}
function groupedSearchCars(search) {
  resetDerivedCache();
  if (derivedSearchGroups.has(search.id)) return derivedSearchGroups.get(search.id);
  const ids=new Set([...matchingSearchIds(search),...searchHiddenIds(search)]);
  const groups=grouped([...ids].map(id=>state.listings[id]).filter(Boolean));
  derivedSearchGroups.set(search.id, groups);
  return groups;
}
function hiddenSearchGroups(search) {
  if (!search) return [];
  const hidden=searchHiddenIds(search);
  return groupedSearchCars(search).filter(group=>
    group.some(row=>hidden.has(row.id)));
}
function visibleSearchIds(search) {
  resetDerivedCache();
  if (derivedVisibleIds.has(search.id)) return derivedVisibleIds.get(search.id);
  const hidden=searchHiddenIds(search);
  const ids=matchingSearchIds(search);
  const groups=groupedSearchCars(search);
  // An old hidden source also hides a newly discovered same-car advert
  // in this search, while it remains visible in other searches.
  const blocked=new Set(groups.filter(group=>group.some(row=>hidden.has(row.id)))
    .flatMap(group=>group.map(row=>row.id)));
  const visible=ids.filter(id=>!blocked.has(id));
  derivedVisibleIds.set(search.id,visible);
  return visible;
}
function currentIds() {
  return [...new Set(state.searches.flatMap(visibleSearchIds))];
}
function visibleGroupedCars(search) {
  resetDerivedCache();
  if (derivedDisplayGroups.has(search.id)) return derivedDisplayGroups.get(search.id);
  const groups=grouped(visibleSearchIds(search).map(id=>state.listings[id]).filter(Boolean));
  derivedDisplayGroups.set(search.id,groups);
  return groups;
}
function getSearch() { return view.startsWith('search:') ? state.searches.find(s => s.id === view.slice(7)) : null; }
function autotraderWriteoff(item) {
  if (!item || item.site !== 'autotrader') return false;
  const text = [item.title, item.description, item.writeOffCategory].filter(Boolean).join(' ');
  const writeOff = /\bcat(?:egory)?\s*[-:]?\s*[NSCDAB]\b|\b(?:previously\s+)?written[\s-]*off\b|\binsurance\s+total\s+loss\b/i;
  return writeOff.test(text);
}
function relevantListings() {
  if (view === 'saved')
    return Object.values(state.listings).filter(item =>
      item.saved && (item.manuallyAdded || !autotraderWriteoff(item)));
  const search = getSearch();
  const ids = search ? visibleSearchIds(search) : currentIds();
  return ids.map(id => state.listings[id]).filter(item =>
    item && !autotraderWriteoff(item));
}
function manualRoot(id) {
  const checked = new Set();
  while (state.manualDuplicates[id] && !checked.has(id)) { checked.add(id); id = state.manualDuplicates[id]; }
  return id;
}
function wordTokens(str) {
  const stop = new Set(['the','a','and','for','used','car','cars','sale','with','euro','s','dr','bhp','automatic','manual','petrol','diesel','miles','coupe','hatchback']);
  return new Set(String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w => w.length >= 2 && !stop.has(w)));
}
function titleSimilarity(a, b) {
  const aa = wordTokens(a), bb = wordTokens(b);
  if (!aa.size || !bb.size) return 0;
  let common = 0; aa.forEach(t => { if (bb.has(t)) common++; });
  return common / Math.max(aa.size, bb.size);
}
function duplicatePairKey(firstId, secondId) {
  // IDs are generated by supported sources and use a fixed site:id format.
  return [String(firstId), String(secondId)].sort().join('|');
}
function hasSeparatedMatches(ids) {
  const choices=new Set(ids);
  return Object.keys(state.separateDuplicates || {}).some(pair =>
    pair.split('|').some(id => choices.has(id)));
}
function normalLocation(raw) {
  return String(raw || '').toLowerCase()
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:miles?|mi)\s*\)/g,'')
    .replace(/^(?:located in|based in|near)\s+/g,'')
    .replace(/,\s*(?:united kingdom|england|uk)\s*$/g,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
}
function normalColour(car) {
  return exteriorColour(car);
}
function vehicleIdentity(title) {
  // Model identity must agree before we trust a price/location match.
  // This is not a make/model search filter: it is only a conservative
  // sanity check to avoid combining, for instance, an M2 with an M4.
  const words = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g,' ')
    .trim().split(/\s+/).filter(Boolean);
  const makes = [
    [['aston','martin'],'astonmartin'], [['land','rover'],'landrover'],
    [['alfa','romeo'],'alfaromeo'], [['mercedes','benz'],'mercedes'],
    [['rolls','royce'],'rollsroyce'], [['range','rover'],'landrover'],
    [['volkswagen'],'volkswagen'], [['mercedes'],'mercedes'],
    [['porsche'],'porsche'], [['jaguar'],'jaguar'], [['lotus'],'lotus'],
    [['bmw'],'bmw'], [['audi'],'audi'], [['ford'],'ford'],
    [['vw'],'volkswagen'], [['mini'],'mini'], [['mazda'],'mazda'],
    [['nissan'],'nissan'], [['toyota'],'toyota'], [['honda'],'honda'],
    [['volvo'],'volvo'], [['hyundai'],'hyundai'], [['kia'],'kia'],
    [['renault'],'renault'], [['peugeot'],'peugeot'], [['citroen'],'citroen'],
    [['seat'],'seat'], [['skoda'],'skoda'], [['tesla'],'tesla'],
    [['lexus'],'lexus'], [['subaru'],'subaru'], [['suzuki'],'suzuki'],
    [['vauxhall'],'vauxhall'], [['maserati'],'maserati'],
    [['bentley'],'bentley'], [['ferrari'],'ferrari'], [['lamborghini'],'lamborghini'],
    [['mclaren'],'mclaren'], [['mg'],'mg']
  ];
  for (let i=0;i<words.length;i++) {
    for (const [alias,make] of makes) {
      if (!alias.every((word,j) => words[i+j]===word)) continue;
      let offset=i+alias.length;
      // Some providers insert a model year or chassis generation.
      while (offset<words.length && /^(?:19\d{2}|20[0-2]\d|f\d{2}|e\d{2}|g\d{2})$/.test(words[offset]))
        offset++;
      let model=words[offset] || '';
      if (model==='series' && /^\d$/.test(words[offset+1] || '')) model=words[offset+1]+'series';
      else if (/^\d$/.test(model) && words[offset+1]==='series') model+='series';
      else if (model==='f' && words[offset+1]==='type') model='ftype';
      else if (model==='range' && words[offset+1]==='rover') model='rangerover';
      if (make==='porsche' && /^(?:996|997|991|992|911)$/.test(model)) model='911';
      if (!model || /^(?:car|cars|used|sale|for|the|sport)$/.test(model)) return null;
      return {make,model};
    }
  }
  return null;
}
function suspectSellerDistanceMileage(car) {
  // Flag legacy data where a recorded "mileage" is exactly the location's
  // distance from the search postcode rather than the odometer reading.
  if (!car || car.mileage===null || car.mileage===undefined || car.mileage==='') return false;
  const distance=String(car.location || '').match(/\(\s*(\d+(?:\.\d+)?)\s*(?:miles?|mi)\s*\)/i);
  const miles=Number(car.mileage);
  return !!(distance && Number.isFinite(miles) && Math.abs(miles-Number(distance[1]))<1);
}
function vehicleMileage(car) {
  if (!car || car.mileage===null || car.mileage===undefined || car.mileage==='') return null;
  const number=Number(car.mileage);
  if (!Number.isFinite(number) || number<=0 || number>=1000000) return null;
  if (suspectSellerDistanceMileage(car)) return null;
  return number;
}
function photoDistance(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string' ||
      !/^[0-9a-f]{16}$/i.test(hexA) || !/^[0-9a-f]{16}$/i.test(hexB))
    return null;
  // Hamming distance between 64-bit image hashes without any ML library.
  const weights=[0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
  let distance=0;
  for (let i=0;i<16;i++)
    distance+=weights[parseInt(hexA[i],16)^parseInt(hexB[i],16)];
  return distance;
}
function photoSimilarity(a, b) {
  const left=a?.photoHash,right=b?.photoHash;
  if (!left || !right || !Array.isArray(left.rgb) || !Array.isArray(right.rgb) ||
      left.rgb.length!==3 || right.rgb.length!==3) return null;
  const p=photoDistance(left.p,right.p),d=photoDistance(left.d,right.d);
  if (p===null || d===null) return null;
  if (![...left.rgb,...right.rgb].every(x=>Number.isFinite(x) && x>=0 && x<=255))
    return null;
  const rgb=Math.round(left.rgb.reduce((sum,value,i)=>sum+
    Math.abs(value-right.rgb[i]),0)/3);
  const score=Math.round(100*(1-(0.65*p+0.35*d)/64));
  // Require two independent classical image hashes and compatible average
  // image colours. No AI, facial/object detection or remote comparison.
  return {score,p,d,rgb,matched:p<=3 && d<=5 && rgb<=38 && score>=94};
}
function bestPhotoMatch(group) {
  let top=null;
  for (let i=0;i<group.length;i++)
    for (let j=i+1;j<group.length;j++) {
      const match=photoSimilarity(group[i],group[j]);
      if (match?.matched && (!top || match.score>top.score)) top=match;
    }
  return top;
}
function duplicateEvidence(a, b) {
  // Colour, mileage and location are the most distinctive public advert
  // attributes. A matching price or title alone is NOT strong enough.
  const colourA=normalColour(a), colourB=normalColour(b);
  const locationA=normalLocation(a.location),locationB=normalLocation(b.location);
  const milesA=vehicleMileage(a), milesB=vehicleMileage(b);
  const mileageKnown=milesA!==null && milesB!==null;
  const mileageGap=mileageKnown ? Math.abs(milesA-milesB) : null;
  // Different websites may round or have slightly different odometer dates.
  // Avoid assuming that two 50k-mile cars are the same when miles differ
  // substantially. 1.8% tolerance, floor 500mi, cap 1,250mi.
  const mileageTolerance=mileageKnown
    ? Math.min(1250,Math.max(500,Math.min(milesA,milesB)*0.018))
    : 0;
  return {
    colourA, colourB,
    colourMatch:!!(colourA && colourB && colourA===colourB),
    locationMatch:!!(locationA && locationB && locationA===locationB),
    mileageKnown,
    mileageMatch:mileageKnown && mileageGap<=mileageTolerance,
    mileageGap,
    mileageTolerance,
    samePrice:Number(a.price)>0 && Number(b.price)>0 &&
      Number(a.price)===Number(b.price),
    titleMatch:titleSimilarity(a.title,b.title)
  };
}
function duplicate(a, b) {
  if (a.id===b.id) return true;
  // User decisions always take priority over the automatic classifier.
  if (manualRoot(a.id)===manualRoot(b.id)) return true;
  if (state.separateDuplicates?.[duplicatePairKey(a.id,b.id)]) return false;
  // Two different adverts on the same website are never combined
  // automatically; manual merge is still possible.
  if (a.site===b.site) return false;
  const regA=String(a.registration || '').replace(/[^a-z0-9]/gi,'').toUpperCase();
  const regB=String(b.registration || '').replace(/[^a-z0-9]/gi,'').toUpperCase();
  if (regA.length>=7 && regB.length>=7) {
    // Registration is a stronger identifier than a seller's asking price.
    return regA===regB;
  }
  // Until the next scan fixes a legacy distance-as-odometer mistake,
  // do not auto-merge the car using weaker colour/location/price evidence.
  if (suspectSellerDistanceMileage(a) || suspectSellerDistanceMileage(b)) return false;
  const identityA=vehicleIdentity(a.title),identityB=vehicleIdentity(b.title);
  if (!identityA || !identityB || identityA.make!==identityB.make ||
      identityA.model!==identityB.model) return false;
  const yearA=Number(a.year)||0,yearB=Number(b.year)||0;
  if (yearA && yearB && Math.abs(yearA-yearB)>1) return false;
  const gearboxA=effectiveTransmission(a),gearboxB=effectiveTransmission(b);
  if (gearboxA && gearboxB && gearboxA!==gearboxB) return false;
  const evidence=duplicateEvidence(a,b);
  if (evidence.colourA && evidence.colourB && !evidence.colourMatch &&
      !(['silver','grey'].includes(evidence.colourA) &&
        ['silver','grey'].includes(evidence.colourB))) return false;
  // Mileage is a high-value identity signal. Meaningfully different
  // odometers are a veto, even if two adverts share a price and town.
  if (evidence.mileageKnown && !evidence.mileageMatch) return false;

  // An exceptionally high photograph match is a separate, strong
  // duplicate signal even if sellers changed the asking price. Preserve the
  // model/VRM/colour/odometer/transmission safeguards above. Requiring one
  // extra advert signal avoids joining two cars using the same stock photo.
  const photo=photoSimilarity(a,b);
  if (photo?.matched && (evidence.locationMatch || evidence.mileageMatch ||
                         evidence.colourMatch || evidence.samePrice))
    return true;

  // The owner's priority: matching exterior colour, mileage and location
  // for the same car is strong enough even if prices have diverged.
  if (evidence.colourMatch && evidence.mileageMatch && evidence.locationMatch)
    return true;

  // Two of the three priority signals require another independent clue.
  if (evidence.mileageMatch && evidence.locationMatch &&
      (evidence.samePrice || evidence.titleMatch>=0.38)) return true;
  if (evidence.mileageMatch && evidence.colourMatch &&
      (evidence.samePrice || (yearA && yearB && yearA===yearB &&
                             evidence.titleMatch>=0.68))) return true;
  // Many cars share a common colour and town. Price and a convincing
  // advert title/year must also agree in this weaker case.
  if (evidence.colourMatch && evidence.locationMatch &&
      evidence.samePrice && yearA && yearB && yearA===yearB &&
      evidence.titleMatch>=0.55) return true;

  // A single strong attribute (mileage OR location) plus identical price
  // and distinctive title is a useful fallback when colour is unknown.
  if (evidence.samePrice && evidence.mileageMatch &&
      evidence.titleMatch>=0.42) return true;
  if (evidence.samePrice && evidence.locationMatch &&
      evidence.titleMatch>=0.72 && yearA && yearB && yearA===yearB)
    return true;
  // Identical price, generic model title, colour or gearbox alone can
  // easily identify two DIFFERENT vehicles. Leave those separate.
  return false;
}

function grouped(items) {
  const groups=[];
  for (const item of items) {
    // Respect explicit user-created groups even when normal criteria differ.
    const manual=groups.find(g => g.some(other => manualRoot(item.id)===manualRoot(other.id)));
    if (manual) { manual.push(item); continue; }
    // Complete-link matching avoids a bridge advert joining two different
    // cars, and prevents two same-site adverts in one automatic group.
    const automatic=groups.find(g => !g.some(other => other.site===item.site) &&
      g.every(other => duplicate(item,other)));
    if (automatic) automatic.push(item);
    else groups.push([item]);
  }
  return groups.map(g => g.sort((a,b) => Number(b.saved)-Number(a.saved) ||
    Number(!!b.image)-Number(!!a.image) || (a.price??Infinity)-(b.price??Infinity)));
}
function statusSets() {
  const list = getSearch() ? [getSearch()] : state.searches;
  return { newIds:new Set(list.flatMap(s => s.lastReport?.newIds || [])), changedIds:new Set(list.flatMap(s => s.lastReport?.changedIds || [])) };
}
function savedCarCount() {
  resetDerivedCache();
  if (derivedStats.has('savedCount')) return derivedStats.get('savedCount');
  const count=grouped(Object.values(state.listings).filter(car=>car.saved)).length;
  derivedStats.set('savedCount',count);
  return count;
}
function baseGroupsForView(lists) {
  resetDerivedCache();
  if (!derivedResultGroups.has(view))
    derivedResultGroups.set(view,grouped(lists));
  return derivedResultGroups.get(view);
}
function priceMileageComparisonGroups(lists) {
  // Display filters (including selected colour, source and keyword) must
  // not shrink the valuation sample or make badges flicker into "Not rated".
  // Compare against the original collected adverts while only rendering
  // the searched-for colours in the results themselves.
  resetDerivedCache();
  const search=getSearch();
  const key='price-mileage-peers:'+view;
  if (!derivedResultGroups.has(key)) {
    const ids=search ? availableIds(search) :
      view==='saved' ? lists.map(car=>car.id) :
      [...new Set(state.searches.flatMap(availableIds))];
    const observations=ids.map(id=>state.listings[id]).filter(car=>
      car && !autotraderWriteoff(car));
    derivedResultGroups.set(key,grouped(observations));
  }
  return derivedResultGroups.get(key);
}
function liveStats() {
  resetDerivedCache();
  if (derivedStats.has(view)) return derivedStats.get(view);
  const ids = currentIds();
  const statuses = statusSets();
  const groups = grouped(ids.map(id => state.listings[id]).filter(Boolean));
  const stats={ carCount:groups.length, newCount:groups.filter(g => g.some(l => statuses.newIds.has(l.id))).length,
    changedCount:groups.filter(g => g.some(l => statuses.changedIds.has(l.id))).length,
    savedCount:savedCarCount() };
  derivedStats.set(view,stats);
  return stats;
}

function render() {
  if (getSearch() === null && view.startsWith('search:')) view = 'searches';
  const search = getSearch();
  const onSearchesPage = view === 'searches';
  const stats = onSearchesPage ? {savedCount:savedCarCount()} : liveStats();
  $('metrics').classList.toggle('hidden', onSearchesPage);
  $('searchSources').classList.toggle('hidden', onSearchesPage);
  $('searchesPage').classList.toggle('hidden', !onSearchesPage);
  $('resultsSection').classList.toggle('hidden', onSearchesPage);
  $('breadcrumbView').textContent = search?.name || (view === 'saved' ? 'Saved cars' : onSearchesPage ? 'Searches' : 'Overview');
  $('eyebrow').textContent = search ? 'YOUR SAVED SEARCH' : view === 'saved' ? 'YOUR SHORTLIST' : onSearchesPage ? 'SAVED SEARCHES' : 'ALL YOUR SEARCHES';
  $('viewTitle').textContent = search?.name || (view === 'saved' ? 'Cars worth keeping.' : onSearchesPage ? 'Your car searches.' : 'Find your next car.');
  $('viewSubtitle').textContent = search ? `Tracking ${search.links.length} car sites from one set of filters. Last checked ${older(search.lastChecked)}.` +
    (search.filters?.colours?.length ? ' Exterior colours: ' +
      search.filters.colours.map(x=>x[0].toUpperCase()+x.slice(1)).join(', ') +
      (search.filters.includeUnknownColours ? ' (including unknown).' : ' (confirmed only).') : '') : view === 'saved' ? 'Your saved cars, prices and private notes — regardless of search.' : onSearchesPage ? 'Check when each search last ran, review updates and open its results.' : 'Listings from all your searches, deduplicated in one place.';
  $('headingActions').innerHTML = search ? `<button class="button quiet" data-action="view" data-view="searches">← All searches</button><button class="button quiet" data-action="edit" data-id="${esc(search.id)}">✎ Edit search criteria</button><button class="button dark" data-action="refresh" data-id="${esc(search.id)}" ${scanBusy?'disabled':''}>↻ Refresh search</button>` : view === 'saved' ? `<button class="button dark" data-action="add-manual">＋ Add car by URL</button><button class="button quiet" data-action="share-saved">↗ Share saved cars</button><button class="button quiet" data-action="export">↓ Export backup</button>` : onSearchesPage ? `<button class="button dark" data-action="new">＋ New search</button><button class="button quiet" data-action="refresh-all" ${scanBusy || !state.searches.length ? 'disabled':''}>↻ Refresh all</button>` : `<button class="button dark" data-action="refresh-all" ${scanBusy || !state.searches.length ? 'disabled':''}>↻ Refresh all searches</button>`;
  if (!onSearchesPage) $('metrics').innerHTML = `<div class="metric"><div class="metric-label">${search ? 'Sources' : view === 'saved' ? 'Saved vehicles' : 'Car searches'}</div><strong>${search ? search.links.length : view === 'saved' ? stats.savedCount : state.searches.length}</strong><span>${search ? 'across supported sites' : view === 'saved' ? 'kept across every search' : 'tracked in one dashboard'}</span></div><div class="metric"><div class="metric-label">${view === 'saved' ? 'Live scan vehicles' : 'Cars tracked'}</div><strong>${search ? visibleGroupedCars(search).length : stats.carCount}</strong><span>deduplicated where confident</span></div><div class="metric"><div class="metric-label">Newly found</div><strong class="accent-green">${search ? grouped(visibleSearchIds(search).map(id => state.listings[id]).filter(Boolean)).filter(g => g.some(l => (search.lastReport?.newIds || []).includes(l.id))).length : stats.newCount}</strong><span>since the previous check</span></div><div class="metric"><div class="metric-label">Price changes</div><strong class="accent-amber">${search ? grouped(visibleSearchIds(search).map(id => state.listings[id]).filter(Boolean)).filter(g => g.some(l => (search.lastReport?.changedIds || []).includes(l.id))).length : stats.changedCount}</strong><span>since the previous check</span></div>`;
  renderNav();
  renderProgress();
  if (onSearchesPage) {
    renderSearchesPage();
    return;
  }
  renderSources(search);
  renderResults();
}

function summaryForSearch(search) {
  // Count vehicles (not duplicated adverts), in line with the opened results.
  const cars = visibleGroupedCars(search);
  const newIds = new Set(search.lastReport?.newIds || []);
  const changedIds = new Set(search.lastReport?.changedIds || []);
  const added = cars.filter(group => group.some(car => newIds.has(car.id))).length;
  const priceChanges = cars.filter(group => group.some(car => changedIds.has(car.id))).length;
  const updates = cars.filter(group => group.some(car =>
    newIds.has(car.id) || changedIds.has(car.id))).length;
  return { found: cars.length, added, priceChanges, updates };
}

function renderSearchesPage() {
  const target = $('searchesPage');
  if (!state.searches.length) {
    target.innerHTML = '<div class="searches-empty"><h2>No saved searches yet</h2><p>Create a search to start tracking new car listings and price changes across websites.</p><button class="button dark" data-action="new">＋ Create a search</button></div>';
    return;
  }
  target.innerHTML = `<div class="saved-search-list">${state.searches.map(search => {
    const stats = summaryForSearch(search);
    const lastRun = search.lastChecked ?
      new Date(search.lastChecked).toLocaleString('en-GB', {
        day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'
      }) : 'Never';
    const details = search.lastChecked ? `${older(search.lastChecked)} · ${lastRun}` : 'Not checked yet';
    const updatesSummary = stats.updates ?
      `<small>${stats.added} new · ${stats.priceChanges} price changes</small>` : '<small>No updates since last scan</small>';
    const refreshing=scanBusy && scanSearchIds.includes(search.id);
    return `<article class="saved-search-row ${refreshing?'is-refreshing':''}">
      <div class="saved-search-main">
        <h2>${esc(search.name)}</h2>
        <div class="saved-search-sites">${[...new Set((search.links || []).map(link => link.site))].map(site => displaySite(site, 'mini')).join('')}</div>
      </div>
      <dl class="saved-search-stats">
        <div><dt>Last checked</dt><dd>${esc(details)}</dd></div>
        <div><dt>Cars found</dt><dd>${stats.found}</dd></div>
        <div><dt>Updates</dt><dd>${stats.updates}${updatesSummary}</dd></div>
      </dl>
      <div class="saved-search-actions">
        <button class="button quiet" type="button" data-action="refresh" data-id="${esc(search.id)}" aria-live="polite" ${scanBusy?'disabled':''}>${refreshing?'↻ Refreshing…':'↻ Refresh now'}</button>
        <button class="button dark" type="button" data-action="view" data-view="search:${esc(search.id)}">Open results →</button>
      </div>
    </article>`;
  }).join('')}</div>`;
}
function syncSearchRefreshControls() {
  // Status polling must not rebuild every card and shared header.
  for (const button of $('searchesPage').querySelectorAll('button[data-action="refresh"]')) {
    const active = scanBusy && scanSearchIds.includes(button.dataset.id);
    const text = active ? '↻ Refreshing…' : '↻ Refresh now';
    if (button.textContent !== text) button.textContent=text;
    button.disabled=scanBusy;
    button.closest('.saved-search-row')?.classList.toggle('is-refreshing',active);
  }
}
function renderNav() {
  const nav = $('searchNav');
  const markup = `<button class="nav-item ${view === 'overview'?'selected':''}" data-action="view" data-view="overview"><span class="nav-icon">⌂</span><span class="nav-text">Overview</span></button><button class="nav-item ${view === 'searches' || view.startsWith('search:')?'selected':''}" data-action="view" data-view="searches"><span class="nav-icon">⌕</span><span class="nav-text">Searches</span><span class="nav-number">${state.searches.length}</span></button><button class="nav-item ${view === 'saved'?'selected':''}" data-action="view" data-view="saved"><span class="nav-icon">♡</span><span class="nav-text">Saved cars</span><span class="nav-number">${savedCarCount()}</span></button>`;
  // Only mutate the navigation when its view/count actually changed. The
  // shared DriveHub header mirrors this element via MutationObserver.
  if (nav.innerHTML !== markup) nav.innerHTML = markup;
}
function renderSources(search) {
  const el = $('searchSources');
  if (!state.searches.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (search) {
    // Preserve the user's expansion only while refreshing this same search.
    const wasOpen = el.dataset.searchId === String(search.id) &&
      el.querySelector('details.search-sources-panel')?.open === true;
    el.dataset.searchId = String(search.id);
    el.innerHTML = `<details class="search-sources-panel" ${wasOpen?'open':''}><summary><span class="sources-panel-title">Search sources <small>${search.links.length} websites</small></span><span class="sources-panel-cue">Show sources</span></summary><div class="sources-panel-content"><div class="sources-head"><span>Source checks and website links</span><button class="text-button" data-action="delete" data-id="${search.id}">Delete search</button></div><div class="source-rows">` + search.links.map(link => {
      const shot = state.snapshots[link.id];
      const title = shot?.error ? `<span class="status-error">⚠ ${esc(shot.error)}</span>` : shot?.lastChecked ? `${shot.ids.length} listings seen · ${older(shot.lastChecked)}` : 'Not checked yet';
      return `<div class="source-row">${displaySite(link.site)}<div class="source-copy"><span>${title}</span><small title="${esc(link.sourceNote || '')}">${esc(link.sourceNote || 'Generated search from vehicle filters')}</small></div><button class="button quiet small" data-action="open-url" data-url="${esc(link.url)}">Visit ↗</button></div>`;
    }).join('') + '</div></div></details>';
  } else el.classList.add('hidden');
}
function renderProgress() {
  $('scanProgress').classList.toggle('hidden', !scanBusy);
  $('scanLabel').textContent = scanText;
  $('scanDetail').textContent = scanSubtext;
  $('stopScan').disabled = abortScan;
  $('stopScan').textContent = abortScan ? 'Stopping…' : 'Stop after this page';
}
function effectiveTransmission(car) {
  const known = String(car.transmission || '').toLowerCase().trim();
  if (known === 'automatic' || known === 'manual') return known;
  if (car.combinedMeta) return '';
  const source = [car.title,car.description].filter(Boolean).join(' ');
  if (/\b(?:automatic|dct|dsg|pdk|cvt|tiptronic|steptronic|dual.clutch)\b/i.test(source)) return 'automatic';
  if (/\b(?:manual gearbox|\d.speed manual|manual transmission|6mt)\b/i.test(source)) return 'manual';
  return '';
}
function exteriorColour(car) {
  // Server supplies broad, vetted exterior colours with provenance.
  // Previously inferred black leather/wheel colours have no source: do not
  // treat those legacy values as a verified exterior until rescanned.
  if (!car || !['explicit','title','manual'].includes(car.colourSource)) return '';
  const value = String(car.colour || '').toLowerCase().trim();
  const canonical = value.replace(/gray/g,'grey');
  return COLOUR_CHOICES.some(name => name.toLowerCase()===canonical)
    ? canonical : '';
}
function combinedCarDetails(group, preferred=null) {
  // Read-only composite for display and filtering. Never overwrite an
  // individual provider advert, its price history, photo or user notes.
  const focus=preferred || group[0];
  if (!focus) return null;
  const combined={...focus}, fields={};
  const labels={
    year:'Year', mileage:'Mileage', colour:'Exterior colour',bodyType:'Body type',
    engine:'Engine', bhp:'Power', transmission:'Transmission',
    location:'Location', registration:'Registration'
  };
  const canonicalLocation=value=>String(value || '').toLowerCase()
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:miles?|mi)\s*\)/gi,'')
    .replace(/,\s*(?:england|united kingdom|uk)\s*$/gi,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
  const readers={
    year:car=>{const n=Number(car.year);return Number.isInteger(n)&&n>=1950&&n<=2035?n:null},
    mileage:car=>vehicleMileage(car),
    colour:car=>exteriorColour(car)||null,
    bodyType:car=>bodyTypeForCar(car)||null,
    engine:car=>{const n=Number(car.engine);return car.engine!=null && n>=0.5 && n<=15?n:null},
    bhp:car=>{const n=Number(car.bhp);return car.bhp!=null && n>=30 && n<=2000?n:null},
    transmission:car=>effectiveTransmission(car)||null,
    location:car=>locationForCar(car)||null,
    registration:car=>String(car.registration || '').trim()||null
  };
  for (const [key,read] of Object.entries(readers)) {
    const observations=group.map(car=>({id:car.id,site:car.site,value:read(car)}))
      .filter(row=>row.value!==null && row.value!=='');
    const normalized=observations.map(row=>{
      const val=row.value;
      return key==='location' ? canonicalLocation(val) :
        key==='registration' ? String(val).replace(/[^a-z0-9]/gi,'').toUpperCase() :
        key==='engine' ? (Math.round(Number(val)*10)/10).toString() :
        key==='bhp' ? String(Math.round(Number(val))) :
        String(val).toLowerCase();
    });
    const unique=[...new Set(normalized)];
    let conflict=unique.length>1;
    const owned = observations.find(row =>
      group.find(car => car.id === row.id)?.manualFields?.includes(key));
    let numberRange=false;
    if (key==='mileage' && observations.length>1) {
      const values=observations.map(row=>row.value);
      const gap=Math.max(...values)-Math.min(...values);
      const tolerance=Math.min(1250,Math.max(500,Math.min(...values)*0.018));
      numberRange=gap>0 && gap<=tolerance;
      conflict=gap>tolerance;
    }
    // Provider values are complementary only when they agree, or the
    // odometer variation fits the existing dedupe tolerance.
    let value=null;
    if (observations.length && !conflict) {
      if (key==='mileage') value=Math.max(...observations.map(row=>row.value));
      else if (key==='location') {
        const sorted=[...observations].sort((a,b)=>{
          const specificity=x=>/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(x)?3:
            /\b[A-Z]{1,2}\d[A-Z\d]?\b/i.test(x)?2:1;
          return specificity(b.value)-specificity(a.value);
        });
        value=sorted[0].value;
      } else if (key==='colour') {
        // An explicit exterior paint label beats a title mention.
        const explicit=observations.find(row=>group.find(x=>x.id===row.id)?.colourSource==='explicit');
        value=(explicit||observations[0]).value;
      } else value=observations[0].value;
    } else if (key==='location' && observations.length) {
      // Show the most precise advertised location but flag discrepancies.
      // Different dealer sites can advertise a nearby city vs town.
      value=observations.find(row=>/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(row.value))?.value
        || observations[0].value;
    }
    if (owned) value = owned.value; // Explicit owner corrections take priority.
    combined[key]=value;
    let display=value;
    if (key==='mileage' && observations.length>1 && (numberRange || conflict) && !owned) {
      const values=observations.map(row=>row.value);
      display=new Intl.NumberFormat('en-GB').format(Math.min(...values)) +
        '–' + new Intl.NumberFormat('en-GB').format(Math.max(...values)) +
        ' miles' + (conflict ? ' (adverts differ)' : '');
    } else if (key==='mileage' && value!==null) {
      display=new Intl.NumberFormat('en-GB').format(value)+' miles';
    } else if (key==='engine' && value!==null) display=value+' litres';
    else if (key==='bhp' && value!==null) display=value+' bhp';
    else if (key==='transmission' && value) display=value==='automatic'?'Automatic':'Manual';
    else if (key==='colour' && value) display=value[0].toUpperCase()+value.slice(1);
    else if (key==='bodyType' && value) display=bodyTypeLabel(value);
    if (conflict && key!=='location' && key!=='mileage' && !owned) display='Differs by advert';
    fields[key]={label:labels[key],value,display,observations,conflict,numberRange,
      manuallyEdited:!!owned};
  }
  // Use the most informative title and an available image from any website.
  combined.title=group.find(row=>row.manualFields?.includes('title') && row.title)?.title ||
    group.map(row=>String(row.title||'').trim())
      .filter(Boolean).sort((a,b)=>b.length-a.length)[0] || focus.title;
  combined.image=group.find(row=>row.manualFields?.includes('image') &&
      imageUrl(row.image))?.image ||
    (imageUrl(focus.image) ? focus.image :
      (group.find(row=>imageUrl(row.image))?.image || ''));
  const validPrices=group.map(row=>Number(row.price))
    .filter(n=>Number.isFinite(n)&&n>0);
  combined.price=group.find(row=>row.manualFields?.includes('price') &&
      Number(row.price)>0)?.price ??
    (validPrices.length?Math.min(...validPrices):null);
  combined.description=group.find(row=>row.manualFields?.includes('description') &&
      row.description)?.description ||
    group.map(row=>String(row.description||'').trim())
      .sort((a,b)=>b.length-a.length)[0]||'';
  combined.colourSource=fields.colour.manuallyEdited ? 'manual' :
    fields.colour.conflict || !fields.colour.value ? 'unknown' :
    group.some(row=>exteriorColour(row)===fields.colour.value && row.colourSource==='explicit')
      ? 'explicit' : group.some(row=>exteriorColour(row)===fields.colour.value && row.colourSource==='title')
      ? 'title' : 'unknown';
  // This object's fields and sources are for presentation only.
  combined.combinedMeta={
    fields,sources:group.map(row=>({
      id:row.id,site:row.site,url:row.url,price:row.price,
      title:row.title,description:row.description,location:row.location,
      image:row.image
    })),
    otherPrices:validPrices.length?Math.max(...validPrices):null
  };
  return combined;
}
function matchesResultFilters(car) {
  const number = name => {
    const input = $(name).value.trim();
    return input === '' ? null : Number(input);
  };
  const priceMin=number('resultPriceMin'), priceMax=number('resultPriceMax');
  const yearMin=number('resultYearMin'), yearMax=number('resultYearMax');
  const mileageMin=number('resultMileageMin'), mileageMax=number('resultMileageMax');
  const engineMin=number('resultEngineMin'), engineMax=number('resultEngineMax');
  const bhpMin=number('resultBhpMin'), bhpMax=number('resultBhpMax');
  // Like the saved-search criteria, a missing value is "not stated", not a
  // failure, unless the user asks to hide cars missing that detail.
  if (!hideUnknownDetails()) {
    const ok=(value,min,max)=>value==null || value==='' ||
      ((min===null || Number(value)>=min) && (max===null || Number(value)<=max));
    if (!ok(car.price,priceMin,priceMax) || !ok(car.year,yearMin,yearMax) ||
        !ok(car.mileage,mileageMin,mileageMax) || !ok(car.engine,engineMin,engineMax) ||
        !ok(car.bhp,bhpMin,bhpMax)) return false;
    const gearbox=$('resultTransmission').value, known=effectiveTransmission(car);
    return gearbox==='any' || !known || known===gearbox;
  }
  if (priceMin !== null && !(car.price != null && Number(car.price)>=priceMin)) return false;
  if (priceMax !== null && !(car.price != null && Number(car.price)<=priceMax)) return false;
  if (yearMin !== null && !(car.year != null && Number(car.year)>=yearMin)) return false;
  if (yearMax !== null && !(car.year != null && Number(car.year)<=yearMax)) return false;
  if (mileageMin !== null && !(car.mileage != null && Number(car.mileage)>=mileageMin)) return false;
  if (mileageMax !== null && !(car.mileage != null && Number(car.mileage)<=mileageMax)) return false;
  if (engineMin !== null && !(car.engine != null && Number(car.engine)>=engineMin)) return false;
  if (engineMax !== null && !(car.engine != null && Number(car.engine)<=engineMax)) return false;
  if (bhpMin !== null && !(car.bhp != null && Number(car.bhp)>=bhpMin)) return false;
  if (bhpMax !== null && !(car.bhp != null && Number(car.bhp)<=bhpMax)) return false;
  if ($('resultTransmission').value !== 'any' &&
      effectiveTransmission(car) !== $('resultTransmission').value) return false;
  return true;
}
function wantsDistanceCoordinates() {
  // The distance label is always shown on listing cards once geocoding succeeds.
  // Only the Searches management page avoids resolving vehicle locations.
  return view !== 'searches';
}
function groupMatchesColour(group) {
  const selected=$('resultColour').value;
  if (selected === 'any') return true;
  const colours=group.map(exteriorColour).filter(Boolean);
  // Unknown means nobody knows the exterior paint, not merely that one
  // of three duplicate adverts omitted the paint specification.
  if (selected === 'unknown') return colours.length === 0;
  return colours.includes(selected);
}
function hideUnknownDetails() { return !!$('resultHideUnknown')?.checked; }
function groupMatchesBodyType(group) {
  const selected=$('resultBodyType').value;
  if (selected==='any') return true;
  const known=group.map(bodyTypeForCar).filter(Boolean);
  // A body-type result filter excludes *known* mismatches only.
  return !known.length || known.every(type=>type===selected);
}
function geoMiles(a,b) {
  const rad=Math.PI/180,lat1=a.lat*rad,lat2=b.lat*rad;
  const p=Math.sin((lat2-lat1)/2)**2+
    Math.cos(lat1)*Math.cos(lat2)*Math.sin((b.lng-a.lng)*rad/2)**2;
  return 3958.8*2*Math.asin(Math.min(1,Math.sqrt(p)));
}
function postcodeOnlyLocation(raw) {
  // Only use a *full* postcode when there is no recognisable town.
  // Partial postcodes like SK12/M2 must not be mistaken for place names.
  const source=String(raw || '').trim();
  const full=source.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
  return full ? full[0].toUpperCase().replace(/\s+/g,' ') : '';
}
function cleanAdvertLocation(raw) {
  // Treat distance hints, postcode fragments, and merge annotations as
  // metadata, not part of the geographic place sent to the map service.
  let place=String(raw || '').replace(/\s+/g,' ').trim();
  if (!place) return '';
  place=place.replace(/\s*(?:[·,;|–—-]\s*)?multiple locations\s*$/gi,'')
    .replace(/\s*\(\s*multiple locations\s*\)\s*$/gi,'')
    .replace(/\s*\(\s*\d+(?:\.\d+)?\s*(?:miles?|mi)\s*\)/gi,'')
    .replace(/\s*(?:[·|,;–—-]\s*)?\d+(?:\.\d+)?\s*(?:miles?|mi)\s*(?:away|from you)?\s*$/gi,'')
    .replace(/\b(?:post\s*code)\s*[:\-]?\s*/gi,'')
    // Remove outward as well as complete postcodes when there IS a town.
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi,'')
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\b/gi,'')
    .replace(/^(?:location\s*[:\-]?|located in|based in)\s*/i,'')
    .replace(/(?:,\s*)?(?:United Kingdom|England|Scotland|Wales|UK)\s*$/gi,'')
    .replace(/\(\s*\)/g,'')
    .replace(/\s*[,;|·]\s*[,;|·]\s*/g,', ')
    .replace(/\s+([,;])/g,'$1')
    .replace(/[,;|·\-\s]+$/g,'')
    .replace(/^[,;|·\-\s]+/g,'').trim();
  if (!place || /^(?:multiple locations|unknown|not specified|various|n\/a|nationwide)$/i.test(place)) return '';
  // Reject leftovers containing seller metadata, rather than searching
  // for a fictional UK town.
  if (/\b(?:miles?|postcode|multiple locations)\b/i.test(place) || /\d/.test(place)) return '';
  return place;
}
function locationForCar(car) {
  // Cards show only the locality, not a postcode or county qualifier.
  return cleanAdvertLocation(car?.location).split(',')[0].trim();
}
function mapLocationForCar(car) {
  const original=String(car?.location||'').replace(/\s+/g,' ').trim();
  if (!cleanAdvertLocation(original) && !postcodeOnlyLocation(original)) return '';
  // Mapping sees the original postcode and mileage evidence. The card's
  // visible place label is independently cleaned by locationForCar().
  return original.replace(/\s*\(\s*multiple locations\s*\)/ig,'')
    .replace(/\s*[·,;|–—-]?\s*multiple locations\s*$/ig,'').trim().slice(0,120);
}
function rememberLocationResult(row) {
  if (!row || typeof row.location!=='string') return;
  const key=mapLocationKey(row.location);
  const point=row.point || null;
  // An older background-distance request must never overwrite a valid
  // position found by a newer explicit retry.
  if (!point && locationPoints.get(key)?.lat) return;
  locationIssues.set(key,{
    status:row.status || (point?'mapped':'unmatched'),
    reason:row.reason || (point?'Approximate advertised area located.':
      'No reliable UK location match was returned.'),
    retryable:row.retryable!==false && !point
  });
  if (point) {
    locationPoints.set(key,point);
    distanceFailures.delete(key);
  } else if (row.status==='temporary') {
    locationPoints.delete(key);
    distanceFailures.add(key);
  } else {
    locationPoints.set(key,null);
  }
}
function milesForGroup(group) {
  const points=group.map(car => locationPoints.get(mapLocationKey(mapLocationForCar(car))))
    .filter(item => item && Number.isFinite(item.lat) && Number.isFinite(item.lng));
  return points.length ? Math.min(...points.map(point => geoMiles(DISTANCE_ORIGIN,point))) : null;
}
function groupMatchesDistance(group) {
  const selected=$('resultDistanceMax').value;
  if (!selected) return true;
  const distance=milesForGroup(group);
  if (distance === null) return !hideUnknownDetails();
  return distance <= Number(selected);
}
async function ensureDistanceLocations(cars) {
  if (!wantsDistanceCoordinates() || distanceLookupBusy) return;
  const locations=[...new Set(cars.map(mapLocationForCar).filter(Boolean))]
    .filter(location => !locationPoints.has(mapLocationKey(location)) &&
      !distanceLookups.has(mapLocationKey(location)) &&
      !distanceFailures.has(mapLocationKey(location)));
  if (!locations.length) return;
  distanceLookupBusy=true;
  for (const loc of locations) distanceLookups.add(mapLocationKey(loc));
  try {
    for (let index=0;index<locations.length;index+=25) {
      const chunk=locations.slice(index,index+25);
      try {
        const answer=await api('/api/map/locations',{
          method:'POST',body:JSON.stringify({locations:chunk})
        });
        for (const row of answer.locations || [])
          rememberLocationResult(row);
        for (const loc of chunk)
          if (!locationPoints.has(mapLocationKey(loc))) {
            rememberLocationResult({location:loc,status:'temporary',
              reason:'The location service did not return a result.',retryable:true});
          }
      } catch(error) {
        console.warn('Could not map some advertised locations:',error.message);
        for (const loc of chunk) {
          distanceFailures.add(mapLocationKey(loc));
          locationIssues.set(mapLocationKey(loc),{
            status:'temporary',reason:'The location lookup failed: '+error.message,
            retryable:true
          });
        }
        // Do not hammer geocoding repeatedly if it is temporarily offline.
      }
      // Avoid re-building every listing card after every 25 geocodes.
      // Apply all resolved locations in one render when the batch finishes.
    }
  } finally {
    for (const loc of locations) distanceLookups.delete(mapLocationKey(loc));
    distanceLookupBusy=false;
    if (wantsDistanceCoordinates()) renderResults();
  }
}
function matchingColourAdvert(group) {
  const selected=$('resultColour').value;
  if (selected==='any') return group.find(matchesResultFilters) || group[0];
  if (selected==='unknown') return group.find(matchesResultFilters) || group[0];
  return group.find(car => matchesResultFilters(car) && exteriorColour(car)===selected) ||
    group.find(matchesResultFilters) || group[0];
}
// Relative price-to-mileage comparison. Comparing asking price divided by
// mileage would perversely reward high-mileage cars, so rank each separately.
// Never compare materially different models, generations, trims or body styles.
function priceMileageVariant(title) {
  const text=String(title || '').toLowerCase();
  const tokens=[
    /\b(?:996|997|991|992)\b/.exec(text)?.[0] || '',
    /\bcompetition\b|\bcomp\b/.test(text) ? 'competition' : '',
    /\b(?:cs|gts|gt3|gt4)\b/.exec(text)?.[0] || '',
    /\b(?:c4s|4s|c2s|2s)\b/.exec(text)?.[0] || '',
    /\bv8\b|\b5[.]0\b/.test(text) ? 'v8' : '',
    /\bv6\b|\b3[.]0\b/.test(text) ? 'v6' : '',
    /\b(?:convertible|cabriolet|cabrio|roadster|drophead)\b/.test(text) ? 'open' : '',
    /\b(?:supercharged)\b/.test(text) ? 'supercharged' : ''
  ];
  return tokens.filter(Boolean).join('/');
}
function priceMileageObservation(group) {
  const combined=combinedCarDetails(group);
  const priced=group.find(car=>car.manualFields?.includes('price') && Number(car.price)>0) ||
    [...group].filter(car=>Number(car.price)>0 && matchesResultFilters(car))
      .sort((a,b)=>Number(a.price)-Number(b.price))[0] ||
    [...group].filter(car=>Number(car.price)>0)
      .sort((a,b)=>Number(a.price)-Number(b.price))[0];
  const price=Number(priced?.price)>0 ? Number(priced.price) : null;
  // A combined vehicle has mileage=null when provider readings disagree.
  // Use the underlying advert whose asking price is being evaluated, then
  // fall back to another credible source instead of losing the whole rating.
  const sourceMileages=group.map(car=>({car,mileage:vehicleMileage(car)}))
    .filter(row=>row.mileage!==null);
  const manualMileage=sourceMileages.find(row=>row.car.manualFields?.includes('mileage'));
  const pricedMileage=sourceMileages.find(row=>row.car.id===priced?.id);
  const mileage=manualMileage?.mileage ?? pricedMileage?.mileage ??
    (sourceMileages.length ? priceMileageMedian(sourceMileages.map(row=>row.mileage)) : null);
  const mileageConflict=sourceMileages.length>1 &&
    Math.max(...sourceMileages.map(row=>row.mileage))-
    Math.min(...sourceMileages.map(row=>row.mileage))>
    Math.min(1250,Math.max(500,Math.min(...sourceMileages.map(row=>row.mileage))*.018));
  const year=Number(combined?.year);
  const identity=vehicleIdentity(combined?.title);
  const family=identity ? identity.make+'/'+identity.model+'/'+priceMileageVariant(combined.title) : null;
  return {id:group[0]?.id,ids:group.map(car=>car.id),price,mileage,year,family,
    mileageConflict,transmission:effectiveTransmission(combined)};
}
function priceMileageMedian(numbers) {
  const sorted=[...numbers].filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
function priceMileageDepreciation(peers) {
  // Estimate a mileage adjustment from pairwise comparable asking prices.
  // If there is not enough evidence for a positive trend, use a deliberately
  // conservative estimate derived from the cohort's typical asking price,
  // and disclose that the result has lower confidence.
  const pairs=[];
  for(let i=0;i<peers.length;i++)for(let j=i+1;j<peers.length;j++) {
    const a=peers[i],b=peers[j];
    if(a.year!==b.year) continue; // Avoid confusing model-year changes with mileage.
    const miles=b.mileage-a.mileage;
    if(Math.abs(miles)<5000) continue;
    pairs.push((a.price-b.price)/miles);
  }
  const typical=priceMileageMedian(peers.map(row=>row.price));
  const upperBound=typical*.10/10000;
  const fromListings=priceMileageMedian(pairs);
  if(pairs.length>=2 && Number.isFinite(fromListings) && fromListings>0) {
    return {rate:Math.min(fromListings,upperBound),estimated:false};
  }
  // A sparse or noisy cohort should still support a *tentative* comparison
  // rather than producing "Not rated" for every valid car. Three percent of
  // the cohort's median asking price per 10k miles is a modest, explicitly
  // disclosed heuristic, not a learned depreciation rate.
  return {rate:typical*.03/10000,estimated:true};
}
function priceMileageTier(relativeDifference) {
  // Relative to the median asking price at a common reference mileage.
  // These bands reflect meaningful £ differences; do not force every
  // group into the six categories when cars are priced almost identically.
  if (relativeDifference<=-.12) return 'amazing';
  if (relativeDifference<=-.055) return 'great';
  if (relativeDifference<=-.02) return 'good';
  if (relativeDifference<.03) return 'average';
  if (relativeDifference<.12) return 'poor';
  return 'terrible';
}
function priceMileageRatings(groups) {
  const rows=groups.map(priceMileageObservation);
  const cohorts=new Map();
  for(const row of rows) {
    if (!row.family || !Number.isInteger(row.year) || row.year<1950 ||
        row.price===null || row.mileage===null) continue;
    if(!cohorts.has(row.family))cohorts.set(row.family,[]);
    cohorts.get(row.family).push(row);
  }
  const rated=new Map();
  for(const row of rows) {
    const eligible=row.price!==null && row.mileage!==null &&
      !!row.family && Number.isInteger(row.year) && row.year>=1950;
    // Keep strong like-for-like comparisons first, then widen the model-year
    // window only where the narrower group cannot supply two priced cars.
    const familyRows=eligible ? (cohorts.get(row.family) || []).filter(peer=>
      !row.transmission || !peer.transmission || row.transmission===peer.transmission) : [];
    const closePeers=familyRows.filter(peer=>Math.abs(peer.year-row.year)<=1);
    const peers=closePeers.length>=2 ? closePeers :
      familyRows.filter(peer=>Math.abs(peer.year-row.year)<=2);
    const adjustment=peers.length>=2 ? priceMileageDepreciation(peers) : null;
    const rate=adjustment?.rate ?? null;
    const baselineMileage=rate!==null ? priceMileageMedian(peers.map(p=>p.mileage)) : null;
    const adjusted=rate!==null ? peers.map(p=>
      p.price+(p.mileage-baselineMileage)*rate) : [];
    const typical=rate!==null ? priceMileageMedian(adjusted) : null;
    const adjustedPrice=rate!==null ?
      row.price+(row.mileage-baselineMileage)*rate : null;
    const relativeDifference=typical>0 ? (adjustedPrice-typical)/typical : null;
    const tier=relativeDifference===null ? 'unrated' : priceMileageTier(relativeDifference);
    const labels={
      amazing:'Amazing!',great:'Great',good:'Good',average:'Average',
      poor:'Poor',terrible:'Terrible',unrated:'Not rated'
    };
    const currency=value=>'£'+Math.round(value).toLocaleString('en-GB');
    const reason=row.price===null ? 'Asking price is unknown.' :
      row.mileage===null ? 'Mileage is missing, contradictory or unreliable.' :
      !row.family || !Number.isInteger(row.year) || row.year<1950 ?
        'Model or year is not reliable enough for a comparison.' :
      peers.length<2 ? 'No second comparable advert with a usable asking price and mileage. Other adverts may lack trustworthy data.' :
      (Math.abs(relativeDifference)*100).toFixed(1)+'% '+
      (relativeDifference<0?'below':relativeDifference>0?'above':'equal to')+
      ' the mileage-adjusted median of '+peers.length+' comparable cars. '+
      'Adjusted to '+Math.round(baselineMileage).toLocaleString('en-GB')+' miles, '+
      'using '+currency(rate*10000)+' per 10,000 miles. '+
      (adjustment.estimated ? 'Approximate mileage allowance (3% of median asking price per 10,000 miles); few reliable same-year observations. ' :
        'Mileage rate estimated from same-year comparable adverts. ')+
      (row.mileageConflict ? 'Merged adverts disagree on mileage; the preferred valid advert reading was used. ' : '')+
      'Asking prices only; not a verified market valuation.';
    const detail={tier,label:labels[tier],
      score:relativeDifference===null?null:-relativeDifference,
      relativeDifference,adjustedCost:adjustedPrice,
      price:row.price,mileage:row.mileage,peers:peers.length,
      depreciationPer10000:rate===null?null:rate*10000,reason};
    // Multi-source cards may show a different preferred advert depending
    // on the active site filter. Give every source of the same car its
    // shared valuation.
    for(const id of row.ids) rated.set(id,detail);
  }
  return rated;
}
function comparePriceMileageGroups(a,b,ratings) {
  const left=ratings.get(a[0]?.id),right=ratings.get(b[0]?.id);
  const scoreA=left?.score ?? null,scoreB=right?.score ?? null;
  // A supported percentage difference beats a speculative comparison.
  if (scoreA!==null && scoreB===null) return -1;
  if (scoreB!==null && scoreA===null) return 1;
  if (scoreA!==null && scoreB!==null && scoreA!==scoreB)
    return scoreB-scoreA;
  // No invented mileage rate when there are too few comparable cars:
  // fall back to asking price, then lowest known mileage.
  const priceA=left?.price ?? Infinity,priceB=right?.price ?? Infinity;
  if(priceA!==priceB) return priceA-priceB;
  return (left?.mileage ?? Infinity)-(right?.mileage ?? Infinity);
}

function listingUpdatedAt(car) {
  // A refresh of an unchanged advert is not a meaningful update. Use the
  // first discovery or a *subsequent* recorded price-history change.
  const first=Date.parse(car.firstSeen || '') || 0;
  const history=Array.isArray(car.priceHistory) ? car.priceHistory : [];
  const changed=history.slice(1).reduce((latest,row)=>{
    const date=Date.parse(row?.at || '') || 0;
    return Math.max(latest,date);
  },0);
  return Math.max(first,changed);
}
function groupUpdatedAt(group) {
  return Math.max(0,...group.map(listingUpdatedAt));
}

function hiddenReasons(allGroups) {
  // Explain the hiding the user is least likely to expect: cars dropped only
  // because a detail is missing rather than because it is wrong.
  if (!hideUnknownDetails()) return '';
  const number=id=>$(id).value.trim()!=='';
  const checks=[['price',['resultPriceMin','resultPriceMax']],['year',['resultYearMin','resultYearMax']],
    ['mileage',['resultMileageMin','resultMileageMax']],['engine size',['resultEngineMin','resultEngineMax'],'engine'],
    ['BHP',['resultBhpMin','resultBhpMax'],'bhp']];
  const parts=[];
  for (const [label,ids,field] of checks) {
    if (!ids.some(number)) continue;
    const key=field||label;
    const n=allGroups.filter(g=>g.every(c=>c[key]==null || c[key]==='')).length;
    if (n) parts.push(`${n} missing ${label}`);
  }
  if ($('resultDistanceMax').value) {
    const n=allGroups.filter(g=>milesForGroup(g)===null).length;
    if (n) parts.push(`${n} location unknown`);
  }
  return parts.length ? ' – including '+parts.join(', ') : '';
}
function renderResults() {
  if (view === 'searches') return;
  const search = getSearch();
  const lists = relevantListings();
  if (wantsDistanceCoordinates()) void ensureDistanceLocations(lists);
  const statuses = statusSets();
  const keyword = $('keywordFilter').value.toLowerCase().trim();
  const site = $('sourceFilter').value;
  const changesOnly = $('changesOnly').checked && view !== 'saved';
  const allGroups = baseGroupsForView(lists);
  let groups = allGroups.filter(g =>
    (site === 'all' || g.some(l => l.site === site)) &&
    (!keyword || g.some(l => (l.title+' '+(l.location || '')+' '+(l.notes || '')+' '+(l.description || '')).toLowerCase().includes(keyword))) &&
    (!changesOnly || g.some(l => statuses.newIds.has(l.id) || statuses.changedIds.has(l.id))) &&
    // A multi-source car needs only one advert meeting the display criteria.
    // These filters do not change the source queries or stored snapshots.
    (g.some(matchesResultFilters) || matchesResultFilters(combinedCarDetails(g))) &&
    groupMatchesColour(g) && groupMatchesBodyType(g) && groupMatchesDistance(g));
  const sort = $('sortFilter').value;
  const valueRatings=priceMileageRatings(priceMileageComparisonGroups(lists));
  groups.sort((a,b) => {
    if (sort==='priceMileage') {
      const value=comparePriceMileageGroups(a,b,valueRatings);
      if (value) return value;
    }
    if (sort==='recentlyUpdated') {
      const updated=groupUpdatedAt(b)-groupUpdatedAt(a);
      if (updated) return updated;
    }
    if (sort==='preferred' && search) {
      const difference = searchPreferredScore(b, search) - searchPreferredScore(a, search);
      if (difference) return difference;
    }
    if (sort==='distanceNear' || sort==='distanceFar') {
      const aMiles=milesForGroup(a),bMiles=milesForGroup(b);
      // Unmapped cars belong last in BOTH directions, never at zero miles.
      if (aMiles===null) return bMiles===null ? 0 : 1;
      if (bMiles===null) return -1;
      if (aMiles!==bMiles) return sort==='distanceNear' ?
        aMiles-bMiles : bMiles-aMiles;
    }
    const mina = Math.min(...a.map(x => x.price || Infinity)), minb = Math.min(...b.map(x => x.price || Infinity));
    if (sort === 'priceLow' || sort === 'priceHigh') {
      // Cars with no asking price go last in both directions.
      if (mina === Infinity || minb === Infinity) {
        if (mina !== minb) return mina === Infinity ? 1 : -1;
      } else if (mina !== minb) return sort === 'priceLow' ? mina - minb : minb - mina;
    }
    if (sort === 'year') return Math.max(...b.map(x=>x.year || 0)) - Math.max(...a.map(x=>x.year || 0));
    const af = Number(a.some(l => statuses.newIds.has(l.id) || statuses.changedIds.has(l.id)));
    const bf = Number(b.some(l => statuses.newIds.has(l.id) || statuses.changedIds.has(l.id)));
    if (bf !== af) return bf - af;
    return Math.max(...b.map(l => Date.parse(l.firstSeen || 0))) - Math.max(...a.map(l => Date.parse(l.firstSeen || 0)));
  });
  $('resultsTitle').textContent = view === 'saved' ? 'Your saved listings' : search ? 'Combined results' : 'Listings across searches';
  const hiddenCount = allGroups.length - groups.length;
  $('resultsSubtitle').textContent = `${groups.length} ${groups.length === 1 ? 'car' : 'cars'} shown` +
    (hiddenCount > 0 ? ` of ${allGroups.length} (${hiddenCount} hidden by filters${hiddenReasons(allGroups)})` : '') +
    ` · ${lists.length} source listings · same-car matches grouped` +
    (sort === 'preferred' && search && keywordTerms(preferredKeywords(search)).length ?
      ' · preferred keyword matches first' : '') +
    (sort === 'priceMileage' ? ' · asking prices adjusted for mileage using comparable adverts' : '') +
    (sort === 'recentlyUpdated' ? ' · newest adverts and price changes first' : '') +
    (wantsDistanceCoordinates() ? (distanceLookupBusy ? ' · locating adverts…' :
      ` · straight-line distance from ${homeShortName()} (unknown locations last)`) : '');
  $('listModeButton').classList.toggle('active', resultsLayout === 'list');
  $('mapModeButton').classList.toggle('active', resultsLayout === 'map');
  $('listModeButton').setAttribute('aria-pressed', String(resultsLayout === 'list'));
  $('mapModeButton').setAttribute('aria-pressed', String(resultsLayout === 'map'));
  $('listingGrid').classList.toggle('hidden', resultsLayout === 'map');
  $('listingMapPanel').classList.toggle('hidden', resultsLayout !== 'map');
  renderHiddenResults(search,statuses);
  if (resultsLayout === 'map') {
    void showListingsMap(groups).catch(error=>{
      console.warn('Could not render the car results map:',error);
      $('mapCount').textContent='Map unavailable';
      $('mapSubtitle').textContent='The map could not be displayed. Try switching to List and back to Map.';
    });
    return;
  }
  if (!state.searches.length && view !== 'saved') {
    $('listingGrid').innerHTML = `<div class="empty-state"><div class="empty-illustration">⌕</div><h2>Start with a car you're looking for.</h2><p>Choose a car and set your own filters. The dashboard will generate searches for all selected sites and show the deduplicated results here.</p><button class="button dark" data-action="new">＋ Add your first search</button></div>`;
    return;
  }
  if (mergeFrom) {
    const original = state.listings[mergeFrom];
    $('resultsSubtitle').textContent = `Select “Merge here” on the matching car to combine it with ${original?.title || 'your selection'}.`;
  }
  if (!groups.length) {
    $('listingGrid').innerHTML = `<div class="empty-state"><div class="empty-illustration">${view === 'saved'?'♡':'◌'}</div><h2>${view === 'saved' ? 'Your shortlist is empty.' : keyword || changesOnly || site !== 'all' ? 'No matches for this filter.' : 'No listings recorded yet.'}</h2><p>${view === 'saved' ? 'Save any listing from a search, or paste an individual advert URL to add one yourself.' : keyword || changesOnly || site !== 'all' ? 'Try clearing a filter or changing the source.' : 'Refresh your search to establish a baseline and discover the cars currently shown.'}</p>${view === 'saved' ? '<button class="button dark" data-action="add-manual">＋ Add a car by URL</button>' : ''}${view !== 'saved' && !keyword && !changesOnly ? `<button class="button dark" data-action="${search?'refresh':'refresh-all'}" ${search?`data-id="${search.id}"`:''} ${scanBusy?'disabled':''}>↻ Refresh now</button>`:''}</div>`;
    return;
  }
  $('listingGrid').innerHTML = groups.map(g => renderCard(g,statuses,false,valueRatings.get(g[0].id))).join('');
  $('listingGrid').querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
    img.style.display='none'; img.parentElement.classList.add('image-failed');
  }, { once:true }));
}

function mapLocationForGroup(group) {
  const locations=[...new Set(group.map(mapLocationForCar).filter(Boolean))];
  if (!locations.length) return '';
  // Prefer a reliable full postcode over an ambiguous town name. If the
  // postcode failed to resolve, use any other independently mapped source.
  const ranked=[...locations].sort((a,b)=>
    Number(!!postcodeOnlyLocation(b))-Number(!!postcodeOnlyLocation(a)) ||
    Number(b.includes(','))-Number(a.includes(',')));
  return ranked.find(loc=>locationPoints.get(mapLocationKey(loc))?.lat) || ranked[0];
}
function mapLocationKey(location) {
  // Do not collapse a full postcode or mileage hint into a generic town:
  // "Hayes (40 miles)" is not necessarily the same Hayes as 157 miles.
  return String(location||'').trim().replace(/\s+/g,' ').toLowerCase();
}
let leafletFallbackPromise=null;
async function ensureMapLibrary() {
  if (window.L?.map && window.L?.tileLayer) return true;
  // CDN CSS/JS can be unavailable on some devices. Keep the normal
  // jsDelivr preload, but recover using a different established host.
  if (!leafletFallbackPromise) {
    leafletFallbackPromise=new Promise(resolve=>{
      const css=document.createElement('link');
      css.rel='stylesheet';
      css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const script=document.createElement('script');
      script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.async=true;
      script.onload=()=>resolve(!!window.L?.map);
      script.onerror=()=>resolve(false);
      document.head.appendChild(script);
    });
  }
  return leafletFallbackPromise;
}
async function showCarLocation(ids) {
  const rows=ids.map(id=>state.listings[id]).filter(Boolean);
  activeModalLocationIds=[...ids];
  const location=mapLocationForGroup(rows);
  if (!location) { toast('This listing has no advertised location to map.',true); return; }
  const serial=++locationModalRequest;
  $('locationModalTitle').textContent=locationForCar({location}) || 'Advertised area';
  $('locationMapDescription').textContent='Finding the approximate advertised area…';
  $('retryLocationMap').classList.add('hidden');
  const dialog=$('locationDialog');
  if (!dialog.open) show('locationDialog');
  const wrap=$('locationMiniMap');
  if (!await ensureMapLibrary()) {
    $('locationMapDescription').textContent='The map could not load. Check your connection and try opening the location again.';
    leafletFallbackPromise=null; // Allow a later manual retry.
    return;
  }
  if (serial!==locationModalRequest || !dialog.open) return;
  if (!locationModalMap) {
    locationModalMap=L.map(wrap,{scrollWheelZoom:false,zoomControl:true,minZoom:4,maxZoom:14});
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
    }).addTo(locationModalMap);
  }
  if (locationModalMarker) {locationModalMarker.remove();locationModalMarker=null;}
  locationModalMap.setView([54.4,-3],6);
  requestAnimationFrame(()=>locationModalMap.invalidateSize());
  let point=locationPoints.get(mapLocationKey(location));
  if (point === undefined) {
    try {
      const data=await api('/api/map/locations',{
        method:'POST',body:JSON.stringify({locations:[location]})
      });
      const row=(data.locations||[]).find(item=>item.location===location);
      if(row) rememberLocationResult(row);
      point=row?.point || null;
    } catch(error) {
      $('locationMapDescription').textContent='Location lookup failed: '+error.message;
      locationIssues.set(mapLocationKey(location),{status:'temporary',
        reason:'Location lookup failed: '+error.message,retryable:true});
      $('retryLocationMap').classList.remove('hidden');
      return;
    }
  }
  if (serial!==locationModalRequest || !dialog.open) return;
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) ||
      point.lat<49 || point.lat>61.5 || point.lng< -9 || point.lng>2.6) {
    const issue=locationIssues.get(mapLocationKey(location));
    $('locationMapDescription').textContent=issue?.reason ||
      'The advertised area could not be located confidently.';
    $('retryLocationMap').classList.remove('hidden');
    return;
  }
  // A regional zoom (not street zoom) makes the surrounding area clear.
  const areaLabel=locationForCar({location}) || cleanAdvertLocation(point.label) || 'Advertised area';
  $('locationModalTitle').textContent=areaLabel;
  locationModalMap.setView([point.lat,point.lng],7);
  locationModalMarker=L.marker([point.lat,point.lng]).addTo(locationModalMap)
    .bindPopup(esc(areaLabel)+'<br>Approximate advertised area').openPopup();
  $('locationMapDescription').textContent='Showing the area around '+areaLabel+'. Zoom or pan to explore the region.';
  requestAnimationFrame(()=>locationModalMap.invalidateSize());
}

function initListingMap() {
  if (listingMap) return true;
  if (!window.L) {
    $('mapCount').textContent = 'Map could not load';
    $('mapSubtitle').textContent = 'Map resources are unavailable. Check that your browser can load Leaflet and OpenStreetMap.';
    return false;
  }
  listingMap = L.map('listingMap', {scrollWheelZoom:false, zoomControl:true, minZoom:4, maxZoom:14});
  listingMap.setView([54.4,-3.0],6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:18, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
  }).addTo(listingMap);
  listingMapLayer = L.layerGroup().addTo(listingMap);
  return true;
}
function redrawListingMap(groups, pending=0, failed=false) {
  if (!listingMap || !listingMapLayer) return;
  listingMapLayer.clearLayers();
  const clusters = new Map();
  const unmapped = [];
  for (const group of groups) {
    const location = mapLocationForGroup(group);
    const item = location ? locationPoints.get(mapLocationKey(location)) : null;
    if (item && Number.isFinite(item.lat) && Number.isFinite(item.lng)
      && item.lat >= 49 && item.lat <= 61.5 && item.lng >= -9 && item.lng <= 2.6) {
      // Coordinates describe an area/town centre, NOT a vehicle's precise location.
      const key = item.lat.toFixed(4) + ',' + item.lng.toFixed(4);
      if (!clusters.has(key)) clusters.set(key, {point:item, cars:[]});
      clusters.get(key).cars.push(group);
    } else {
      unmapped.push({group,location});
    }
  }
  const bounds = [];
  let mappedCars = 0;
  for (const value of clusters.values()) {
    const point = value.point;
    const count = value.cars.length;
    mappedCars += count;
    const cls = count > 1 ? 'map-pin-many' : '';
    const icon = L.divIcon({
      className:'map-pin '+cls,
      html:'<span>' + count + '</span>',
      iconSize:[34,34], iconAnchor:[17,17]
    });
    const marker = L.marker([point.lat,point.lng], {icon});
    const rows = value.cars.map(group => {
      const main = combinedCarDetails(group,group.find(car => car.price > 0) || group[0]);
      const ids = group.map(car => car.id).join(',');
      const price = Math.min(...group.filter(car => car.price > 0).map(car => car.price));
      const photo = group.find(car => imageUrl(car.image));
      const thumbnail = photo ? '<img class="map-car-thumbnail" src="' +
        esc(imageUrl(photo.image)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' :
        '<span class="map-car-thumbnail map-no-thumbnail" aria-hidden="true">▱</span>';
      return '<button type="button" class="map-car-item" data-map-ids="' + esc(ids) +
        '">' + thumbnail + '<span class="map-car-summary"><span>' + esc(main.title) +
        '</span><strong>' + (Number.isFinite(price) ? fmtPrice(price) : 'Price unknown') +
        '</strong><small class="map-car-sites">' +
        esc([...new Set(group.map(car => SITE_NAMES[car.site] || car.site))].join(' · ')) +
        '</small></span></button>';
    }).join('');
    const popup = '<div class="map-popup"><strong>' +
      esc(locationForCar({location:point.label}) || 'Advertised area') +
      '</strong><small>' + esc(point.precision || 'Approximate area') +
      '</small><div class="map-popup-cars">' + rows + '</div></div>';
    marker.bindPopup(popup, {maxWidth:330, minWidth:210, maxHeight:330}).addTo(listingMapLayer);
    marker.bindTooltip(count + (count===1?' car':' cars') + ' near ' +
      (locationForCar({location:point.label}) || 'this area'));
    bounds.push([point.lat,point.lng]);
  }
  if (bounds.length > 1) listingMap.fitBounds(bounds,{padding:[40,40],maxZoom:10});
  else if (bounds.length === 1) listingMap.setView(bounds[0],9);
  else listingMap.setView([54.4,-3.0],6);
  $('mapCount').textContent = mappedCars + ' of ' + groups.length + ' cars mapped';
  $('mapSubtitle').textContent = pending
    ? 'Finding ' + pending + ' advertised locations…'
    : failed ? 'Some locations could not be checked right now.'
    : (clusters.size + ' approximate locations · ' + unmapped.length + ' cars without a map position');
  const missingLocation=unmapped.filter(({group,location})=>
    !location && !group.some(car=>String(car.location||'').trim())).length;
  const availableRetries=unmapped.filter(({group})=>
    group.some(car=>locationIssues.get(mapLocationKey(mapLocationForCar(car)))?.retryable)).length;
  const reasonFor=({group,location})=>{
    if (!location) return group.some(car=>String(car.location||'').trim()) ?
      'The advertised text is not a usable UK location.' :
      'No advertised location supplied.';
    const issues=group.map(mapLocationForCar).filter(Boolean)
      .map(loc=>locationIssues.get(mapLocationKey(loc))).filter(Boolean);
    // Report a real failure before a speculative pending status.
    const issue=issues.find(row=>row.status==='ambiguous') ||
      issues.find(row=>row.status==='temporary') ||
      issues.find(row=>row.status==='invalid_postcode') ||
      issues.find(row=>row.status==='unsupported') ||
      issues.find(row=>row.status==='unmatched') ||
      issues[0];
    return issue?.reason || (pending ? 'Checking advertised location…' :
      'Location has not yet been checked.');
  };
  $('unmappedCars').innerHTML = unmapped.length ? (
    '<details class="unmapped-details"><summary>' + unmapped.length +
    (unmapped.length===1?' car':' cars') +
    ' not placed on the map <span>— ' + missingLocation +
    ' with no advertised location' + (pending?' · Checking locations…':'') +
    '</span></summary>' +
    (availableRetries?
      '<div class="unmapped-actions"><button type="button" class="button quiet" data-map-retry="all">Retry ' +
      availableRetries + ' unresolved ' +
      (availableRetries===1?'car':'cars') + '</button></div>' : '') +
    '<div class="unmapped-list">' + unmapped.map(item=>{
      const {group,location}=item;
      const primary=group[0];
      const hasFailure=group.some(car=>
        locationIssues.get(mapLocationKey(mapLocationForCar(car)))?.retryable);
      const ids=esc(group.map(car=>car.id).join(','));
      return '<div class="unmapped-row"><button type="button" class="unmapped-item" data-map-ids="' +
        ids + '"><span>' + esc(primary.title) +
        '</span><small>' + esc(locationForCar({location}) || 'Advertised area unavailable') +
        ' · ' + esc(reasonFor(item)) + '</small></button>' +
        (hasFailure ? '<button type="button" class="button quiet unmapped-retry" data-map-retry="' +
          ids + '">Retry</button>' : '') + '</div>';
    }).join('') + '</div></details>'
  ) : '';
  requestAnimationFrame(() => listingMap.invalidateSize());
}
async function showListingsMap(groups) {
  mapShown = true;
  lastMapGroups=groups;
  const ticket=++mapRequestId;
  $('mapCount').textContent='Preparing map…';
  if (!await ensureMapLibrary()) {
    $('mapCount').textContent='Map library unavailable';
    $('mapSubtitle').textContent='The map library did not load. Try switching to List and back to Map.';
    leafletFallbackPromise=null;
    return;
  }
  if (ticket!==mapRequestId || resultsLayout!=='map') return;
  if (!initListingMap()) return;
  requestAnimationFrame(() => listingMap.invalidateSize());
  const signature = JSON.stringify(groups.map(g => g.map(car => [car.id,car.location,car.price])));
  // A previous map request can be interrupted when background distance
  // geocoding causes a re-render. The listing signature may still be
  // unchanged even though some positions have never been resolved.
  // Always repaint AND query any still-missing places, even on same-signature
  // refreshes; cached coordinates prevent needless calls.
  mapSignature = signature;
  // Check locations from every source advert in a grouped car. If one
  // website only says "Ripley", another may have a precise postcode.
  const places = [...new Set(groups.flatMap(group => group.map(mapLocationForCar).filter(Boolean)))];
  const missing = places.filter(location => !locationPoints.has(mapLocationKey(location)));
  redrawListingMap(groups, missing.length);
  let failed = false;
  for (let start=0; start<missing.length; start+=25) {
    if (ticket !== mapRequestId || resultsLayout !== 'map') return;
    const chunk = missing.slice(start,start+25);
    try {
      const answer = await api('/api/map/locations',{
        method:'POST',body:JSON.stringify({locations:chunk})
      });
      for (const row of answer.locations || []) rememberLocationResult(row);
      for (const location of chunk)
        if (!locationPoints.has(mapLocationKey(location)) &&
            !locationIssues.has(mapLocationKey(location)))
          rememberLocationResult({location,status:'temporary',
            reason:'The location service returned no result.',retryable:true});
    } catch (error) {
      failed = true;
      console.warn('Advert location map lookup failed:', error.message);
      // Retain all affected cars as unlocated rather than inventing pins.
      // Do not cache a transient network failure as a permanent missing
      // location: switching map views must be able to retry it.
    }
    if (ticket !== mapRequestId || resultsLayout !== 'map') return;
    const remaining = missing.slice(start+25).filter(location => !locationPoints.has(mapLocationKey(location))).length;
    redrawListingMap(groups,remaining,failed);
  }
  if (!missing.length) redrawListingMap(groups,0);
}
async function retryMapLocations(locations) {
  const unique=[...new Set(locations.filter(Boolean))];
  if (!unique.length) return;
  ++mapRequestId; // Ignore in-flight older geocoding results.
  for(const loc of unique) {
    const key=mapLocationKey(loc);
    locationPoints.delete(key);
    locationIssues.delete(key);
    distanceFailures.delete(key);
  }
  for(let index=0;index<unique.length;index+=25) {
    const chunk=unique.slice(index,index+25);
    try {
      const response=await api('/api/map/locations',{
        method:'POST',body:JSON.stringify({locations:chunk,retry:true})
      });
      for(const row of response.locations || []) rememberLocationResult(row);
    } catch(error) {
      for(const location of chunk) {
        const key=mapLocationKey(location);
        distanceFailures.add(key);
        locationIssues.set(key,{status:'temporary',
          reason:'Retry failed: '+error.message,retryable:true});
      }
    }
  }
}
async function retryUnmappedLocations(event) {
  const button=event.target.closest('[data-map-retry]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const all=button.dataset.mapRetry==='all';
  const ids=all?null:new Set(button.dataset.mapRetry.split(','));
  const groups=lastMapGroups.filter(g=>
    !ids || g.some(car=>ids.has(car.id)));
  const unresolved=groups.filter(g=>{
    const location=mapLocationForGroup(g);
    return location && !locationPoints.get(mapLocationKey(location))?.lat;
  });
  const locations=unresolved.flatMap(g=>g.map(mapLocationForCar).filter(Boolean));
  button.disabled=true;
  button.textContent='Retrying…';
  await retryMapLocations(locations);
  if (resultsLayout==='map') renderResults();
}
async function retryModalLocation() {
  const rows=activeModalLocationIds.map(id=>state.listings[id]).filter(Boolean);
  await retryMapLocations(rows.map(mapLocationForCar).filter(Boolean));
  await showCarLocation(activeModalLocationIds);
}
function mapCarClick(event) {
  const element = event.target.closest('[data-map-ids]');
  if (!element) return;
  event.preventDefault();
  const ids = (element.dataset.mapIds || '').split(',').filter(Boolean);
  openCarDetails(ids);
}

function renderHiddenResults(search,statuses) {
  const panel=$('hiddenResultsPanel');
  if (!search) {
    panel.classList.add('hidden');
    panel.open=false;
    return;
  }
  const groups=hiddenSearchGroups(search).filter(group=>
    group.some(car=>!autotraderWriteoff(car)));
  panel.classList.remove('hidden');
  $('hiddenResultsCount').textContent=String(groups.length);
  const grid=$('hiddenListingGrid');
  grid.innerHTML=groups.length ?
    groups.map(group=>renderCard(group,statuses,true)).join('') :
    '<p class="helper hidden-empty">No cars hidden in this search.</p>';
}
function renderCard(g, statuses, inHiddenSection=false, valueRating=null) {
  // Make one comprehensive, read-only vehicle view from the source adverts.
  const car = combinedCarDetails(g, matchingColourAdvert(g));
  const ids = g.map(x => x.id);
  const saved = g.some(x => x.saved), note = g.find(x => x.notes)?.notes || '';
  const hasNew = g.some(x => statuses.newIds.has(x.id));
  const changedItems = g.filter(x => statuses.changedIds.has(x.id));
  const cheapest = g.find(x => x.manualFields?.includes('price') && x.price > 0) ||
    [...g].filter(x => x.price && matchesResultFilters(x))
      .sort((a,b) => a.price-b.price)[0] || car;
  const distance=milesForGroup(g);
  const changed = changedItems[0];
  const diff = changed ? changed.price - (changed.previousPrice || changed.price) : 0;
  const activeMerge = !!mergeFrom;
  // Avoid repeating details already present in the advert title.
  const titleText = String(car.title || '');
  const inTitle = value => !!value && titleText.toLowerCase().replace(/[^a-z0-9]/g,'').includes(String(value).toLowerCase().replace(/[^a-z0-9]/g,''));
  const mileage = car.combinedMeta.fields.mileage.display;
  const transmission = effectiveTransmission(car);
  const locationLabel = locationForCar(car) || g.map(locationForCar).find(Boolean) ||
    locationForCar({location:locationPoints.get(mapLocationKey(mapLocationForGroup(g)))?.label}) || '';
  const hasMapLocation=!!mapLocationForGroup(g);
  const cardSpecs = [
    car.year && !inTitle(car.year) ? `<span>${car.year}</span>` : '',
    mileage && !inTitle(mileage) ? `<span>${esc(mileage)}</span>` : '',
    hasMapLocation ? `<button type="button" class="car-location-link" data-action="location-map" data-ids="${esc(ids.join(','))}" title="Show the approximate advertised location on a map; distances are straight-line from ${esc(homeShortName())}"><svg viewBox="0 0 24 24" aria-hidden="true" class="location-pin"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.7"/></svg><span>${esc(locationLabel || 'View advertised area')}${distance !== null ? ` <span class="car-location-distance">(${Math.round(distance)} miles)</span>` : ''}</span></button>` : '',
    exteriorColour(car) && !inTitle(exteriorColour(car)) ? `<span title="${car.colourSource==='manual'?'Entered by you':'From advert text'}">${esc(exteriorColour(car))}</span>` : '',
    !exteriorColour(car) && getSearch()?.filters?.colours?.length &&
      getSearch()?.filters?.includeUnknownColours ?
      '<span title="This advert has no reliable exterior paint colour; your search includes unconfirmed colours.">Colour unconfirmed</span>' : '',
    bodyTypeForCar(car) && !inTitle(bodyTypeLabel(bodyTypeForCar(car))) ?
      `<span>${esc(bodyTypeLabel(bodyTypeForCar(car)))}</span>` : '',
    car.bhp && !inTitle(`${car.bhp} bhp`) ? `<span>${esc(car.bhp)} bhp</span>` : '',
    transmission && !inTitle(transmission) && !inTitle('DCT') && !inTitle('DSG') && !inTitle('PDK') ? `<span>${transmission==='automatic'?'Automatic':'Manual'}</span>` : ''
  ].filter(Boolean).join('');
  const valueBadge=valueRating ? `<span class="price-value-indicator price-value-${valueRating.tier}" title="${esc(valueRating.reason)}" aria-label="${esc(valueRating.label + '. ' + valueRating.reason)}">${esc(valueRating.label)}</span>` : '';
  const photo=bestPhotoMatch(g);
  const photoBadge=photo ? `<span class="photo-duplicate-label" title="Near-identical advert photo: perceptual image similarity ${photo.score}%. No AI used.">▣ ${photo.score}% photo match</span>` : '';
  const mergeAction = activeMerge ? (ids.includes(mergeFrom) ? `<button class="card-tool" data-action="cancel-merge">Cancel merge</button>` : `<button class="card-tool merge-target" data-action="merge-here" data-id="${esc(car.id)}">Merge here</button>`) : `<button class="card-tool" data-action="merge" data-id="${esc(car.id)}" title="Manually combine duplicate adverts">Merge</button>`;
  return `<article class="listing-card clickable-car" role="button" tabindex="0" aria-label="View details for ${esc(car.title)}. Right-click to open the original advert in a new tab." data-action="car-details" data-ids="${esc(ids.join(','))}" data-url="${esc(linkUrl(car.url))}">
    <div class="listing-image">${imageUrl(car.image) ? `<img src="${esc(imageUrl(car.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="no-image">▱<small>No photo</small></div>`}<div class="image-badges">${inHiddenSection ? '<span class="flag archived">◌ Hidden</span>' : ''}${hasNew && !inHiddenSection ? `<span class="flag new">● New</span>` : ''}${changedItems.length && !inHiddenSection ? `<span class="flag changed">↘ Price move</span>` : ''}</div><button class="heart ${saved?'on':''}" data-action="save" data-ids="${esc(ids.join(','))}" aria-label="${saved?'Remove from saved cars':'Save car'}" title="${saved?'Remove from shortlist':'Save to shortlist'}">${saved?'♥':'♡'}</button></div>
    <div class="listing-info"><div class="listing-head"><div class="listing-sites">${g.length > 1 ? `<span class="crosslist">${g.length} adverts</span>` : ''}${photoBadge}</div></div>
    <h3 title="${esc(car.title)}">${esc(car.title)}</h3><div class="car-specs">${cardSpecs}</div>
        ${saved && g.some(x => ['queued','running'].includes(x.enrichStatus)) ? '<span class="enrich-indicator">Checking advert details…</span>' : ''}
    <div class="car-price"><strong>${fmtPrice(cheapest.price)}</strong>${valueBadge}${changed && diff!==0 ? `<span class="price-move ${diff<0?'drop':'rise'}">${diff<0?'↓':'↑'} ${fmtPrice(Math.abs(diff))} ${diff<0?'drop':'rise'}</span>` : ''}</div>
    ${note ? `<div class="note-preview">✎ ${esc(note.length > 115 ? note.slice(0,115)+'…' : note)}</div>` : ''}
    <div class="listing-links" aria-label="Adverts available for this car">${g.map(item => `<button type="button" class="source-preview" data-action="car-source" data-ids="${esc(ids.join(','))}" data-id="${esc(item.id)}" title="Preview ${esc(SITE_NAMES[item.site] || item.site)} advert in this page">${esc(SITE_NAMES[item.site] || item.site)}${g.length > 1 && item.price ? ' · '+fmtPrice(item.price) : ''}</button>`).join('')}</div>
    <div class="card-footer">${getSearch()? `<button class="card-tool" data-action="hide-listing" data-hidden="${inHiddenSection?'true':'false'}" data-search-id="${esc(getSearch().id)}" data-ids="${esc(ids.join(','))}">${inHiddenSection?'↶ Restore':'◌ Hide'}</button>` : ''}<button class="card-tool" data-action="note" data-ids="${esc(ids.join(','))}">✎ ${note?'Edit note':'Add note'}</button>${saved ? `<button class="card-tool" data-action="share-car" data-ids="${esc(ids.join(','))}">↗ Share</button>` : ''}<button class="card-tool" data-action="edit-car" data-id="${esc(g.find(x=>x.saved)?.id || car.id)}">✎ Edit details</button>${mergeAction}${g.length > 1 ? `<button class="card-tool" data-action="separate" data-ids="${esc(ids.join(','))}" title="These are different cars. Keep their adverts separate in future.">Not same car</button>` : ''}${g.some(x => state.manualDuplicates[x.id]) ? `<button class="card-tool" data-action="unmerge" data-ids="${esc(ids.join(','))}">Unmerge</button>` : ''}${hasSeparatedMatches(ids) ? `<button class="card-tool" data-action="allow-match" data-ids="${esc(ids.join(','))}" title="Remove your automatic duplicate exclusions for this advert">Allow matching</button>` : ''}<span class="first-seen">Found ${when(car.firstSeen)}</span></div>
    </div></article>`;
}

function openCarDetails(ids, selectedId = null) {
  detailIds = ids.filter(id => state.listings[id] &&
    (state.listings[id].manuallyAdded || !autotraderWriteoff(state.listings[id])));
  if (!detailIds.length) return;
  activeCarId = selectedId && detailIds.includes(selectedId) ? selectedId : detailIds[0];
  renderCarDetails();
  show('carDialog');
}
function combinedDetailFieldsMarkup(combined) {
  const fields=combined.combinedMeta.fields;
  const sourceName=site=>SITE_NAMES[site]||site;
  return Object.values(fields).map(field=>{
    const summary=field.display!=null && field.display!=='' ?
      field.display : field.conflict?'Different values':'Not specified';
    const sites=[...new Set(field.observations.map(row=>sourceName(row.site)))].join(', ');
    const evidence=field.conflict || field.numberRange ?
      '<div class="detail-source-evidence">' +
      field.observations.map(row=>{
        const value=field.label==='Mileage' ?
          new Intl.NumberFormat('en-GB').format(row.value)+' miles' :
          field.label==='Power' ? row.value+' bhp' :
          field.label==='Engine' ? row.value+' litres' : String(row.value);
        return '<div><b>'+esc(sourceName(row.site))+'</b><span>'+esc(value)+'</span></div>';
      }).join('')+'</div>' : '';
    return '<div class="'+(field.conflict?'detail-conflict':'')+'"><span>'+
      esc(field.label)+'</span><strong>'+esc(summary)+'</strong>'+
      (field.manuallyEdited ? '<small class="detail-field-sources">Entered by you</small>' :
        sites ? '<small class="detail-field-sources">From '+esc(sites)+'</small>' : '')+
      evidence+'</div>';
  }).join('');
}
function combinedDescriptionsMarkup(variants) {
  const descriptions=[],seen=new Set();
  for(const row of variants) {
    const description=String(row.description||'').trim().slice(0,1400);
    if(!description || seen.has(description)) continue;
    seen.add(description);
    descriptions.push({row,description});
  }
  if(!descriptions.length) return '';
  return '<details class="combined-descriptions"><summary>Read descriptions from '+
    descriptions.length+' '+(descriptions.length===1?'advert':'adverts')+
    '</summary>'+descriptions.map(({row,description})=>
      '<div class="combined-description"><h5>'+esc(SITE_NAMES[row.site]||row.site)+
      '</h5><p>'+esc(description)+'</p>'+
      (linkUrl(row.url)?'<a href="'+esc(linkUrl(row.url))+
        '" target="_blank" rel="noopener noreferrer">Read full original advert ↗</a>':'')+
      '</div>').join('')+'</details>';
}
function renderCarDetails() {
  const variants = detailIds.map(id => state.listings[id]).filter(Boolean);
  const car = variants.find(x => x.id === activeCarId) || variants[0];
  if (!car) return;
  const combined=combinedCarDetails(variants,car);
  const note = variants.find(x => x.notes)?.notes || '';
  const saved = variants.some(x => x.saved);
  const image = imageUrl(car.image) || imageUrl(combined.image);
  const otherPrices=combined.combinedMeta.otherPrices;
  const priceSummary=combined.price!=null ? (otherPrices>combined.price ?
    fmtPrice(combined.price)+'–'+fmtPrice(otherPrices) : fmtPrice(combined.price)) :
    'Not specified';
  const disagreement=Object.values(combined.combinedMeta.fields).some(f=>f.conflict);
  $('carDialogBody').innerHTML = `
    <div class="detail-tabs" role="group" aria-label="Choose the advertisement">
      ${variants.map(x => `<button class="detail-tab ${x.id === car.id?'active':''}" data-action="car-variant" data-id="${esc(x.id)}">${esc(SITE_NAMES[x.site] || x.site)}${x.price?' · '+fmtPrice(x.price):''}</button>`).join('')}
    </div>
    <div class="detail-hero">
      <div class="detail-photo">${image ? `<img src="${esc(image)}" alt="Vehicle advertised by ${esc(SITE_NAMES[car.site])}" referrerpolicy="no-referrer">` : '<div class="no-image">▱<small>No image available</small></div>'}</div>
      <div class="detail-main"><div class="eyebrow">${esc(SITE_NAMES[car.site])} ADVERT</div>
        <h3>${esc(car.title)}</h3>
        <p class="detail-price">${fmtPrice(car.price)}</p>
        <p class="helper">Combined vehicle specifications from all sites appear below.</p>
        <div class="detail-actions">
          <a class="button dark" href="${esc(linkUrl(car.url))}" target="_blank" rel="noopener noreferrer">Open original advert ↗</a>
          <button class="button quiet" data-action="save" data-ids="${esc(detailIds.join(','))}">${saved?'♥ Saved':'♡ Save car'}</button>
          <button class="button quiet" data-action="note" data-ids="${esc(detailIds.join(','))}">✎ ${note?'Edit notes':'Add notes'}</button>
          ${saved ? `<button class="button quiet" data-action="share-car" data-ids="${esc(detailIds.join(','))}">↗ Share car</button>` : ''}<button class="button quiet" data-action="edit-car" data-id="${esc(car.id)}">✎ Edit details</button>
          ${getSearch() ? `<button class="button quiet" data-action="hide-listing" data-search-id="${esc(getSearch().id)}" data-hidden="${variants.some(x=>searchHiddenIds(getSearch()).has(x.id))?'true':'false'}" data-ids="${esc(detailIds.join(','))}">${variants.some(x=>searchHiddenIds(getSearch()).has(x.id))?'↶ Restore to results':'◌ Hide from this search'}</button>` : ''}
          ${saved ? `<button class="button quiet" data-action="enrich" data-ids="${esc(detailIds.join(','))}">↻ Refresh missing details</button>` : ''}
        </div>
      </div>
    </div>
    <section class="combined-details">
      <div class="combined-details-head"><h4>Combined vehicle details</h4><span>${variants.length} ${variants.length===1?'advert':'adverts'}</span></div>
      <p class="helper">Information from all websites, with the source of each specification. Differing values are shown separately rather than silently reconciled.</p>
      <div class="combined-price"><span>Advertised price range</span><strong>${esc(priceSummary)}</strong></div>
      ${disagreement?'<p class="combined-conflict-note">Some sources disagree — check the original adverts before relying on those values.</p>':''}
      <div class="detail-specs">${combinedDetailFieldsMarkup(combined)}</div>
    </section>
    ${combinedDescriptionsMarkup(variants)}
    ${note ? `<div class="detail-note">✎ ${esc(note)}</div>` : ''}
    ${saved && ['queued','running'].includes(car.enrichStatus) ? '<p class="helper">Checking the original advert for missing vehicle details…</p>' : ''}
    <p class="helper">Some car websites prevent their pages being embedded. Switch adverts above, or open the full original page in a new tab.</p>`;
}
let fbPreviewUrl = '';
let fbLastKind = '';
function fbMessage(text, error=false) {
  $('fbLoginMessage').textContent = text;
  $('fbLoginMessage').classList.toggle('error', error);
}
function fbApplyStatus(status) {
  const kind = status.state || 'not_checked';
  const retry = Number(status.retryAfterSeconds || 0);
  let message = status.message || 'Facebook connection not checked.';
  if (kind === 'cooldown') {
    message = 'Car Search Hub paused further login attempts for ' + retry +
      ' seconds. This is an app safety limit, not a Facebook warning. ' +
      (status.lastOutcome || 'Facebook did not confirm the previous login.');
  }
  fbMessage(message, ['blocked','unverified','error','needs_credentials','invalid_credentials','expired','cooldown'].includes(kind));
  $('fbConnectionDiagnostic').textContent =
    'Last check: ' + (status.stage || 'Not started') +
    (status.lastOutcome ? ' · ' + status.lastOutcome : '') +
    (retry ? ' · Next attempt available in ' + retry + ' seconds' : '');
  $('fbConnect').disabled = retry > 0 || kind === 'connecting' || kind === 'checking_saved';
  const pending = !!status.verificationPending;
  $('fbVerification').classList.toggle('hidden', !pending);
  const facebookButton = $('facebookLoginTop');
  facebookButton.classList.toggle('fb-connected', kind === 'connected');
  if (kind === 'connected') {
    if (fbLastKind !== 'connected') toast('Facebook Marketplace connected.');
    facebookButton.title = 'Facebook Marketplace connected and verified';
    facebookButton.setAttribute('aria-label', 'FB marketplace connected');
    facebookButton.innerHTML = '✓ <span class="fb-label-wide">FB marketplace connected</span><span class="fb-label-small">FB connected</span>';
  } else {
    facebookButton.title = 'Connect Facebook';
    facebookButton.setAttribute('aria-label', 'Connect Facebook');
    facebookButton.innerHTML = 'f <span class="on-wide">Connect Facebook</span>';
  }
  fbLastKind = kind;
  $('fbConnect').textContent = kind === 'connected' ? 'Check connection again' : 'Connect and check Facebook';
}
// Google sign-in mode: each person enters their own Facebook login.
async function fbLoadAccount() {
  if (authInfo.mode!=='google') return;
  try {
    const account=await api('/api/facebook/account');
    showFacebookAccount(account);
  } catch {}
}
function showFacebookAccount(account) {
  $('fbAccountForm').classList.toggle('hidden',!account.personal);
  if (!account.personal) return;
  $('fbResetHelp').textContent='Facebook asking you to sign in again? Clear the old session, then connect again. Saving a new Facebook login above does this for you. Your car searches and notes are not affected.';
  $('fbAccountEmail').value=account.email || '';
  $('fbAccountPassword').value='';
  $('fbAccountPassword').placeholder=account.hasPassword ? 'Saved – leave blank to keep it' : 'Your Facebook password';
  $('fbAccountRemove').classList.toggle('hidden',!account.email && !account.hasPassword);
  $('fbAccountStatus').textContent=account.email && account.hasPassword ?
    'Saved for '+account.email+'. Select Connect Facebook below to sign in.' :
    'Not set yet. Facebook results need your own Facebook login.';
}
$('fbAccountForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('fbAccountSave').disabled=true;
  try {
    const account=await api('/api/facebook/account',{method:'PUT',body:JSON.stringify({
      email:$('fbAccountEmail').value.trim(), password:$('fbAccountPassword').value})});
    showFacebookAccount(account);
    toast('Facebook login saved to your Google Drive. Select Connect Facebook to sign in.');
    void fbLoadStatus();
  } catch (error) { $('fbAccountStatus').textContent=error.message; }
  finally { $('fbAccountSave').disabled=false; }
});
$('fbAccountRemove').addEventListener('click', async () => {
  if (!confirm('Remove your Facebook login and sign Car Search out of your Facebook?')) return;
  try {
    showFacebookAccount(await api('/api/facebook/account',{method:'DELETE'}));
    toast('Facebook login removed.');
    void fbLoadStatus();
  } catch (error) { $('fbAccountStatus').textContent=error.message; }
});
async function fbLoadStatus() {
  try {
    const status = await api('/api/facebook/connection/status');
    fbApplyStatus(status);
    // Restarts preserve the browser cookie on /data, not the in-memory status.
    // A short probe re-verifies actual Marketplace access before showing green.
    if (status.state === 'checking_saved') setTimeout(fbLoadStatus, 2500);
  } catch(e) { fbMessage(e.message,true); }
}
setInterval(() => {
  if ($('facebookDialog').open) fbLoadStatus();
}, 5000);
// Keep the green connected indicator tied to a recently verified session.
setInterval(fbLoadStatus, 300000);
async function fbConnect() {
  if (!$('facebookDialog').open) { show('facebookDialog'); void fbLoadAccount(); }
  fbMessage('Checking Marketplace in Car Search's browser…');
  const button = $('fbConnect');
  button.disabled = true;
  try {
    let status = await api('/api/facebook/connection/connect',{method:'POST',body:'{}'});
    fbApplyStatus(status);
    for (let attempt = 0; attempt < 90 && status.state === 'connecting' && $('facebookDialog').open; attempt++) {
      await delay(1200);
      status = await api('/api/facebook/connection/status');
      fbApplyStatus(status);
    }
    if (status.state === 'connecting') {
      fbMessage('Car Search is still checking Facebook. Close this window and return to check the status shortly.');
    }
  } catch(e) { fbMessage(e.message,true); }
  finally { if (button.disabled) await fbLoadStatus(); }
}
async function fbRecheck() {
  fbMessage('Checking whether Facebook approved the sign-in…');
  $('fbRecheck').disabled = true;
  try { fbApplyStatus(await api('/api/facebook/connection/recheck',{method:'POST',body:'{}'})); }
  catch(e) { fbMessage(e.message,true); }
  finally { $('fbRecheck').disabled = false; }
}
async function fbCode() {
  const code = $('fbApprovalCode').value.trim();
  if (!/^\d{4,10}$/.test(code)) { fbMessage('Enter the numeric verification code (4–10 digits).',true); return; }
  $('fbApprovalCode').value = '';
  $('fbSendCode').disabled = true;
  fbMessage('Submitting the verification code…');
  try { fbApplyStatus(await api('/api/facebook/connection/code',{method:'POST',body:JSON.stringify({code})})); }
  catch(e) { fbMessage(e.message,true); }
  finally { $('fbSendCode').disabled = false; }
}
async function fbPreview() {
  try {
    const response = await fetch('/api/facebook/connection/preview',{credentials:'same-origin',cache:'no-store'});
    if (!response.ok) {
      let error='No Facebook verification screen available.';
      try {error=(await response.json()).detail || error;}catch{}
      throw Error(error);
    }
    const url = URL.createObjectURL(await response.blob());
    if (fbPreviewUrl) URL.revokeObjectURL(fbPreviewUrl);
    fbPreviewUrl = url;
    $('fbPreview').src = url;
    $('fbInteractive').classList.remove('hidden');
  } catch(e) {fbMessage(e.message,true);}
}
async function fbChallengeAction(action) {
  const input = $('fbChallengeText');
  if (action.kind === 'type') {
    action.text = input.value;
    if (!action.text) { fbMessage('Tap the Facebook input and enter a code or text below before typing.', true); return; }
    input.value = '';
  }
  const controls = $('fbInteractive').querySelectorAll('button');
  controls.forEach(button => button.disabled = true);
  try {
    const response = await api('/api/facebook/connection/interact', {
      method:'POST', body:JSON.stringify(action)
    });
    fbApplyStatus(response);
    await fbPreview();
  } catch(error) {
    fbMessage(error.message, true);
  } finally {
    controls.forEach(button => button.disabled = false);
  }
}
function fbTapChallenge(event) {
  const image = $('fbPreview');
  if (!image.naturalWidth || !image.naturalHeight) return;
  const bounds = image.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const x = Math.round((event.clientX - bounds.left) / bounds.width * image.naturalWidth);
  const y = Math.round((event.clientY - bounds.top) / bounds.height * image.naturalHeight);
  fbChallengeAction({kind:'click',x,y});
}
function fbClose() {
  $('fbApprovalCode').value = '';
  $('fbChallengeText').value = '';
  $('fbInteractive').classList.add('hidden');
  if (fbPreviewUrl) URL.revokeObjectURL(fbPreviewUrl);
  fbPreviewUrl='';
  $('fbPreview').removeAttribute('src');
  if ($('facebookDialog').open) hide('facebookDialog');
}

function switchView(next) {
  $('hiddenResultsPanel').open=false;
  view = next;
  mergeFrom = null;
  $('keywordFilter').value = ''; $('sourceFilter').value = 'all';
  const chosen = state.searches.find(s => next === 'search:' + s.id);
  $('sortFilter').value = chosen && keywordTerms(preferredKeywords(chosen)).length ?
    'preferred' : 'seen';
  $('changesOnly').checked = false;
  render();
}
function setupBodyTypeChoices(selected=[]) {
  $('bodyTypeChoices').innerHTML=BODY_TYPE_CHOICES.map(([type,label])=>
    `<label class="body-type-choice"><input type="checkbox" name="carBodyType" value="${type}" ${selected.includes(type)?'checked':''}><span>${esc(label)}</span></label>`).join('');
}
function setupColourChoices(selected=[]) {
  $('colourChoices').innerHTML = COLOUR_CHOICES.map(name => `<label class="colour-choice"><input type="checkbox" name="carColour" value="${name.toLowerCase()}" ${selected.includes(name.toLowerCase())?'checked':''}><span class="swatch swatch-${name.toLowerCase()}"></span><span>${name}</span></label>`).join('');
}
async function importSearchCriteriaFromUrl() {
  const url = $('importSearchUrl').value.trim();
  const status = $('importSearchStatus');
  status.classList.remove('import-error');
  if (!url) {
    status.textContent = 'Paste a car-search results URL first.';
    status.classList.add('import-error');
    return;
  }
  const button = $('importSearchUrlButton');
  button.disabled = true;
  button.textContent = 'Reading…';
  status.textContent = 'Reading search parameters…';
  try {
    const imported = await api('/api/searches/parse-url', {
      method: 'POST', body: JSON.stringify({url})
    });
    $('searchName').value = imported.name || '';
    const filters = imported.filters || {};
    $('carRequiredKeywords').value = filters.requiredKeywords || '';
    $('carPreferredKeywords').value = filters.preferredKeywords || '';
    $('carExcludeKeywords').value = filters.excludeKeywords || '';
    for (const field of FILTER_FIELDS) {
      const id = 'car' + field[0].toUpperCase() + field.slice(1);
      $(id).value = filters[field] ?? '';
    }
    $('carTransmission').value = filters.transmission || 'any';
    setupColourChoices(filters.colours || []);
    setupBodyTypeChoices(filters.bodyTypes || []);
    $('carStrictColour').checked = filters.includeUnknownColours !== false;
    const summary = (imported.applied || []).length ?
      'Imported ' + imported.applied.join(', ') + '.' :
      'No directly transferable filters found.';
    const warning = (imported.warnings || []).length ?
      '\nReview: ' + imported.warnings.join(' ') : '';
    status.textContent = imported.siteLabel + ' search URL. ' + summary +
      ' Check the fields and selected websites, then save.' + warning;
    $('searchFormMessage').textContent = '';
    toast(imported.siteLabel + ' criteria imported. Check the populated filters and review notes before saving.');
    if (!imported.name) $('searchName').focus();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('import-error');
    toast('Could not import search URL: ' + error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Read URL';
  }
}
function searchDialog(id = null) {
  if (scanBusy) { toast('Finish refreshing before editing searches.'); return; }
  editId = id;
  const found = state.searches.find(s => s.id === id);
  $('searchModalTitle').textContent = found ? 'Edit vehicle filters' : 'Create a car search';
  $('importSearchUrl').value = '';
  $('importSearchStatus').textContent = 'Reads supported URL parameters into the fields below. Review any unsupported filters before saving. Your original link is not saved.';
  $('importSearchStatus').classList.remove('import-error');
  $('searchName').value = found?.name || '';
  $('carRequiredKeywords').value = found?.filters?.requiredKeywords || '';
  $('carRequiredLogic').value = found?.filters?.requiredKeywordLogic || 'all';
  const preferred = preferredKeywords(found).trim();
  $('carPreferredKeywords').value = preferred.toLowerCase() ===
    (found?.name || '').trim().toLowerCase() ? '' : preferred;
  $('carExcludeKeywords').value = found?.filters?.excludeKeywords || '';
  for (const field of FILTER_FIELDS) {
    const key = 'car' + field[0].toUpperCase() + field.slice(1);
    $(key).value = found?.filters?.[field] ?? '';
  }
  $('carTransmission').value = found?.filters?.transmission || 'any';
  setupColourChoices(found?.filters?.colours || []);
  setupBodyTypeChoices(found?.filters?.bodyTypes || []);
  $('carStrictColour').checked = found?.filters?.includeUnknownColours ?? true;
  const chosen = found?.sources || ['autotrader','ebay','pistonheads','facebook'];
  document.querySelectorAll('[name=carSite]').forEach(input => input.checked = chosen.includes(input.value));
  $('searchFormMessage').textContent = found && !found.filters ? 'This search still uses legacy URLs. Enter the car make/model as the search name and save to convert it. The first scan establishes a new baseline.' : '';
  show('searchDialog'); $('searchName').focus();
}
async function commitSearch() {
  const name = $('searchName').value.trim();
  const requiredKeywords = $('carRequiredKeywords').value.trim();
  const preferredKeywordsInput = $('carPreferredKeywords').value.trim();
  const excludeKeywords = $('carExcludeKeywords').value.trim();
  if (!name) { $('searchFormMessage').textContent = 'Enter the car make/model as the search name.'; return; }
  const filters = { requiredKeywords, requiredKeywordLogic:$('carRequiredLogic').value,
    preferredKeywords:preferredKeywordsInput,
    excludeKeywords, transmission:$('carTransmission').value,
    includeUnknownColours:$('carStrictColour').checked,
    strictColour:!$('carStrictColour').checked,
    colours:[...document.querySelectorAll('[name=carColour]:checked')].map(x => x.value),
    bodyTypes:[...document.querySelectorAll('[name=carBodyType]:checked')].map(x=>x.value) };
  for (const field of FILTER_FIELDS) {
    const key = 'car' + field[0].toUpperCase() + field.slice(1);
    filters[field] = $(key).value === '' ? null : Number($(key).value);
  }
  const sources = [...document.querySelectorAll('[name=carSite]:checked')].map(input => input.value);
  if (!sources.length) { $('searchFormMessage').textContent = 'Select at least one website.'; return; }
  try {
    const payload = await api('/api/searches', { method:'POST', body:JSON.stringify({id:editId,name,filters,sources}) });
    accept(payload); view = 'search:' + payload.searchId;
    $('sortFilter').value = keywordTerms(preferredKeywordsInput).length ? 'preferred' : 'seen';
    hide('searchDialog'); render(); toast(editId ?
      'Search criteria updated. Existing results filtered immediately.' :
      'Vehicle search saved. Refresh to collect results.');
  } catch (error) { $('searchFormMessage').textContent = error.message; }
}
function openNotes(ids) {
  noteIds = ids.filter(id => state.listings[id]);
  if (!noteIds.length) return;
  const item = state.listings[noteIds[0]];
  $('noteCarTitle').textContent = item.title + (item.price?' · '+fmtPrice(item.price):'');
  $('noteText').value = noteIds.map(id => state.listings[id]?.notes).find(Boolean) || '';
  show('noteDialog');
}
async function commitNote() {
  try {
    accept(await api('/api/listings/notes', {method:'POST',body:JSON.stringify({ids:noteIds,notes:$('noteText').value.trim().slice(0,12000)})}));
    hide('noteDialog'); render(); if ($('carDialog').open) renderCarDetails(); toast('Note saved on the server.');
  } catch (error) { toast(error.message,true); }
}
const MANUAL_TEXT_FIELDS = ['title','location','registration','image','description','notes','colour','bodyType','transmission'];
const MANUAL_NUMERIC_FIELDS = ['price','year','mileage','engine','bhp'];

function openManualCarDialog(itemId = null) {
  manualEditId = itemId;
  const car = itemId ? state.listings[itemId] : null;
  if (itemId && !car) { toast('This listing is no longer available.', true); return; }
  $('manualCarForm').reset();
  $('manualCarModalTitle').textContent = car ? 'Edit car details' : 'Add car from a listing URL';
  $('manualCarHelp').textContent = car
    ? 'Update this car’s information. Your changes take precedence over later website scans. Notes stay private.'
    : 'Paste an individual advert link from Auto Trader, eBay, PistonHeads or Facebook. Save it now; the app will try to fetch the missing details automatically. You can fill in anything yourself.';
  $('manualCarUrlBlock').classList.toggle('hidden', !!car);
  $('manualCarUrl').required = !car;
  $('manualCarUrl').value = car?.url || '';
  for (const field of MANUAL_TEXT_FIELDS) {
    $(manualFieldId(field)).value = car?.[field] || '';
  }
  for (const field of MANUAL_NUMERIC_FIELDS) {
    $(manualFieldId(field)).value = car?.[field] ?? '';
  }
  $('manualCarFormMessage').textContent = '';
  $('submitManualCar').textContent = car ? 'Save changes' : 'Add to saved cars';
  if ($('carDialog').open) hide('carDialog');
  show('manualCarDialog');
  (car ? $('manualCarTitle') : $('manualCarUrl')).focus();
}
function manualFieldId(field) {
  return 'manualCar' + field[0].toUpperCase() + field.slice(1);
}
async function commitManualCar() {
  const fields = {};
  for (const field of MANUAL_TEXT_FIELDS) {
    const value = $(manualFieldId(field)).value.trim();
    // Blank fields for newly pasted URLs must remain available for
    // automatic enrichment; editing any tracked car can explicitly clear them.
    if (manualEditId || value) fields[field] = value;
  }
  for (const field of MANUAL_NUMERIC_FIELDS) {
    const raw = $(manualFieldId(field)).value;
    if (manualEditId || raw !== '') fields[field] = raw === '' ? null : Number(raw);
  }
  const button = $('submitManualCar');
  button.disabled = true;
  $('manualCarFormMessage').textContent = manualEditId ?
    'Saving manual changes…' : 'Saving car and preparing advert details…';
  try {
    const payload = manualEditId ?
      await api('/api/listings/manual/' + encodeURIComponent(manualEditId), {
        method:'PATCH', body:JSON.stringify({fields})
      }) :
      await api('/api/listings/manual', {
        method:'POST', body:JSON.stringify({url:$('manualCarUrl').value.trim(),fields})
      });
    accept(payload);
    hide('manualCarDialog');
    if (!manualEditId) {
      view = 'saved';
      $('sortFilter').value = 'seen';
    }
    render();
    toast(manualEditId ? 'Car details updated without changing saved status. Future scans will preserve your changes.' :
      payload.alreadyPresent ? 'That advert was already tracked. It is now in saved cars.' :
      'Car added to Saved cars. Checking the advert for any missing details.');
  } catch(error) {
    $('manualCarFormMessage').textContent = error.message;
    toast('Could not save car: ' + error.message, true);
  } finally {
    button.disabled = false;
  }
}
async function shareSingleSavedCar(ids) {
  const cars = ids.map(id => state.listings[id]).filter(Boolean);
  if (!cars.some(car => car.saved)) return;
  const main = cars.find(car => car.saved && linkUrl(car.url)) ||
    cars.find(car => linkUrl(car.url));
  if (!main) { toast('There is no original advert link to share.', true); return; }
  const url = linkUrl(main.url);
  const text = main.title + (main.price > 0 ? ' — ' + fmtPrice(main.price) : '');
  try {
    if (navigator.share) {
      await navigator.share({title: main.title, text, url});
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text + '\n' + url);
      toast('Car details and advert link copied.');
    } else window.prompt('Copy this car listing:', text + '\n' + url);
  } catch(error) {
    if (error?.name !== 'AbortError') toast('Could not share this car.', true);
  }
}

function savedCarsShareText() {
  const cars = grouped(Object.values(state.listings).filter(car => car.saved && (car.manuallyAdded || !autotraderWriteoff(car))));
  const rows = cars.map((group,i) => {
    const main = group.find(car => car.price > 0) || group[0];
    const price = group.reduce((p,c) => c.price > 0 && c.price < p ? c.price : p, Infinity);
    const urls = [...new Set(group.map(car => linkUrl(car.url)).filter(Boolean))];
    return (i+1) + '. ' + main.title + ' — ' +
      (Number.isFinite(price) ? fmtPrice(price) : 'Price not listed') +
      (main.location ? ' · ' + main.location : '') +
      '\n' + urls.join('\n');
  });
  return 'Car Search Hub — saved cars\n\n' + rows.join('\n\n');
}
async function shareSavedCars() {
  const text = savedCarsShareText();
  if (!grouped(Object.values(state.listings).filter(car => car.saved && (car.manuallyAdded || !autotraderWriteoff(car)))).length) {
    toast('Save at least one car before sharing.', true);
    return;
  }
  try {
    if (navigator.share) {
      await navigator.share({title:'Saved cars',text});
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast('Saved-car list and advert links copied. Paste into a message to share.');
      return;
    }
    // Clipboard is not available in some in-app browsers: show a selectable
    // text prompt rather than creating a public, unauthenticated data link.
    window.prompt('Copy your saved-car list:', text);
  } catch(error) {
    if (error?.name !== 'AbortError') toast('Sharing was cancelled or unavailable.',true);
  }
}
async function refreshSavedDetails(ids) {
  try {
    const payload = await api('/api/listings/enrich',{
      method:'POST',body:JSON.stringify({ids})
    });
    accept(payload);
    render();
    if ($('carDialog').open) renderCarDetails();
    toast('Checking original adverts for missing details.');
  } catch(error) { toast(error.message,true); }
}

async function setHidden(ids,hidden,searchId) {
  const search=getSearch();
  if (!ids.length || !search || search.id!==searchId) {
    toast('Open a saved search to hide or restore its cars.',true);
    return;
  }
  try {
    const payload=await api('/api/listings/hidden',{
      method:'POST',body:JSON.stringify({searchId,ids,hidden})
    });
    accept(payload);
    if ($('carDialog').open) hide('carDialog');
    render();
    toast(hidden ? 'Hidden from this search. Expand Hidden cars below to restore.' :
      'Car restored to this search.');
  } catch(error) { toast(error.message,true); }
}
async function setSaved(ids) {
  const saved = !ids.some(id => state.listings[id]?.saved);
  try {
    accept(await api('/api/listings/saved',{method:'POST',body:JSON.stringify({ids,saved})}));
    render(); if ($('carDialog').open) renderCarDetails(); toast(saved ? 'Saved. Checking original adverts for missing details.' : 'Removed from saved cars.');
  } catch (error) { toast(error.message,true); }
}
async function deleteSearch() {
  if (!deleteId) return;
  try {
    accept(await api('/api/searches/' + encodeURIComponent(deleteId), {method:'DELETE'}));
    deleteId=null; view='overview'; hide('deleteDialog'); render(); toast('Search deleted. Saved cars are retained.');
  } catch (error) { toast(error.message,true); }
}
function openSettings() {
  $('pageDepth').value = String(state.options.pageDepth || 3);
  $('homeLocationInput').value = state.options.home?.label || '';
  show('settingsDialog');
}
async function saveHomeLocation() {
  const place=$('homeLocationInput').value.replace(/\s+/g,' ').trim().slice(0,80);
  if (!place) { toast('Enter a town or postcode.',true); return; }
  try {
    const answer=await api('/api/map/locations',{method:'POST',body:JSON.stringify({locations:[place],retry:true})});
    const point=answer.locations?.[0]?.point;
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      toast('Could not find that place. Try a full postcode.',true); return;
    }
    accept(await api('/api/options',{method:'PATCH',body:JSON.stringify({home:{label:place,lat:point.lat,lng:point.lng}})}));
    render(); toast(`Distances now measured from ${homeShortName()}.`);
  } catch (error) { toast(error.message,true); }
}
function downloadBackup() { window.location.href = '/api/export'; }
async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!confirm('Replace ALL searches, source history, saved cars and notes on the server? Download a backup first.')) return;
    accept(await api('/api/import',{method:'POST',body:JSON.stringify(parsed)}));
    view='overview'; hide('settingsDialog'); render(); toast('Backup imported.');
  } catch (error) { toast('Import failed: ' + error.message,true); }
  finally { $('backupFile').value = ''; }
}
async function refresh(searchId = null) {
  if (scanBusy) { toast('A scan is already running.'); return; }
  if (!state.searches.length) { searchDialog(); return; }
  try {
    const payload = await api('/api/refresh',{method:'POST',body:JSON.stringify({searchId})});
    scanBusy=true; abortScan=false; scanText=payload.job.label; scanSubtext='';
    scanSearchIds=payload.job.searchIds || (searchId ? [searchId] : state.searches.map(s=>s.id));
    seenRunning=true;
    setNotice(''); render();
  } catch (error) { toast('Could not start refresh: ' + error.message,true); }
}
async function syncStatus() {
  if (statusPolling) return;
  statusPolling=true;
  try {
    const payload = await api('/api/status');
    const wasBusy = scanBusy;
    scanBusy=!!payload.job?.busy;
    scanText=payload.job?.label || '';
    scanSubtext=payload.job?.detail || '';
    abortScan=!!payload.job?.stop;
    scanSearchIds=scanBusy ? (payload.job?.searchIds || []) : [];
    if (payload.revision !== revision) await load();
    else if (wasBusy !== scanBusy) render();
    else {
      renderProgress();
      syncSearchRefreshControls();
    }
    if (wasBusy && !scanBusy) {
      setNotice(payload.job?.message || 'Refresh finished.');
      toast(payload.job?.message || 'Refresh complete.', /failed|warnings|stopped/i.test(payload.job?.message||''));
    }
  } catch (error) {
    if (!/Sign in/i.test(error.message)) setNotice('Cannot contact the scanner server: ' + error.message);
  } finally { statusPolling=false; }
}

// Event delegation keeps all card controls working after a refresh.
$('closeLocationDialog').addEventListener('click',()=>hide('locationDialog'));
$('locationDialog').addEventListener('close',()=>{locationModalRequest++;});
document.addEventListener('click', async event => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  if (event.target.closest('a[href]')) return;
  event.preventDefault();
  const action = btn.dataset.action;
  const ids = (btn.dataset.ids || '').split(',').filter(Boolean);
  if (action === 'location-map') await showCarLocation(ids);
  else if (action === 'car-details') openCarDetails(ids);
  else if (action === 'car-source') openCarDetails(ids, btn.dataset.id);
  else if (action === 'car-variant') { activeCarId = btn.dataset.id; renderCarDetails(); }
  else if (action === 'view') switchView(btn.dataset.view);
  else if (action === 'new') searchDialog();
  else if (action === 'edit') searchDialog(btn.dataset.id);
  else if (action === 'refresh') refresh(btn.dataset.id);
  else if (action === 'refresh-all') refresh();
  else if (action === 'save') await setSaved(ids);
  else if (action === 'hide-listing') {
    await setHidden(ids,btn.dataset.hidden!=='true',btn.dataset.searchId);
  }
  else if (action === 'share-saved') await shareSavedCars();
  else if (action === 'share-car') await shareSingleSavedCar(ids);
  else if (action === 'add-manual') openManualCarDialog();
  else if (action === 'edit-car') openManualCarDialog(btn.dataset.id);
  else if (action === 'enrich') await refreshSavedDetails(ids);
  else if (action === 'note') openNotes(ids);
  else if (action === 'export') downloadBackup();
  else if (action === 'open-url') { const url = linkUrl(btn.dataset.url); if (url) window.open(url,'_blank','noopener,noreferrer'); }
  else if (action === 'delete') { if (scanBusy) { toast('Finish refreshing first.'); return; } deleteId = btn.dataset.id; show('deleteDialog'); }
  else if (action === 'merge') { mergeFrom = btn.dataset.id; renderResults(); }
  else if (action === 'cancel-merge') { mergeFrom = null; renderResults(); }
  else if (action === 'merge-here') {
    if (!mergeFrom || mergeFrom === btn.dataset.id) return;
    try {
      accept(await api('/api/duplicates',{method:'POST',body:JSON.stringify({from:mergeFrom,to:manualRoot(btn.dataset.id)})}));
      mergeFrom=null; render(); toast('Ads grouped together.');
    } catch (error) { toast(error.message,true); }
  } else if (action === 'separate') {
    if (ids.length < 2) return;
    if (!window.confirm('Keep these adverts as different cars, even if their details match? You can reverse this later.')) return;
    try {
      accept(await api('/api/duplicates',{method:'POST',body:JSON.stringify({separateIds:ids})}));
      render(); toast('These adverts will be kept separate.');
    } catch (error) { toast(error.message,true); }
  } else if (action === 'allow-match') {
    try {
      accept(await api('/api/duplicates',{method:'POST',body:JSON.stringify({clearSeparateIds:ids})}));
      render(); toast('Automatic matching re-enabled for this advert.');
    } catch (error) { toast(error.message,true); }
  } else if (action === 'unmerge') {
    try {
      accept(await api('/api/duplicates',{method:'POST',body:JSON.stringify({unmergeIds:ids})}));
      render(); toast('Manual grouping removed.');
    } catch (error) { toast(error.message,true); }
  }
});
// Right-click (or middle-click) the car surface to open the original
// advert, while normal left-clicks continue to open our details modal.
// A real anchor is also supplied on the image for native browser context
// menu / open-in-new-tab support.
document.addEventListener('contextmenu', event => {
  const card=event.target.closest('.listing-card');
  if (!card || event.target.closest('button,a,input,select,textarea')) return;
  const url=linkUrl(card.dataset.url);
  if (!url) return;
  event.preventDefault();
  window.open(url,'_blank','noopener,noreferrer');
});
document.addEventListener('auxclick', event => {
  if (event.button !== 1) return;
  const card=event.target.closest('.listing-card');
  if (!card || event.target.closest('button,a,input,select,textarea')) return;
  const url=linkUrl(card.dataset.url);
  if (!url) return;
  event.preventDefault();
  window.open(url,'_blank','noopener,noreferrer');
});
$('closeCarDialog').addEventListener('click', () => hide('carDialog'));
document.addEventListener('keydown', event => {
  if (event.target.matches('.clickable-car') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); openCarDetails((event.target.dataset.ids || '').split(',').filter(Boolean));
  }
});
$('facebookLoginSettings').addEventListener('click', () => {
  hide('settingsDialog'); show('facebookDialog'); fbLoadStatus(); void fbLoadAccount();
});
$('facebookLoginTop').addEventListener('click', () => { show('facebookDialog'); fbLoadStatus(); void fbLoadAccount(); });
$('closeFacebookDialog').addEventListener('click', fbClose);
$('fbCancel').addEventListener('click', fbClose);
$('fbConnect').addEventListener('click', fbConnect);
$('fbReset').addEventListener('click', async () => {
  if (!window.confirm('Clear the saved Facebook session in Car Search? Your car searches, notes and saved adverts will not change.')) return;
  $('fbReset').disabled = true;
  try {
    const status = await api('/api/facebook/connection/reset', {method:'POST',body:'{}'});
    fbApplyStatus(status);
    toast('Old Facebook session cleared.');
  } catch(error) {
    fbMessage(error.message, true);
  } finally {
    $('fbReset').disabled = false;
  }
});
$('fbRecheck').addEventListener('click', fbRecheck);
$('fbSendCode').addEventListener('click', fbCode);
$('fbPreviewButton').addEventListener('click', fbPreview);
$('fbPreview').addEventListener('click', fbTapChallenge);
$('fbChallengeType').addEventListener('click', () => fbChallengeAction({kind:'type'}));
$('fbChallengeEnter').addEventListener('click', () => fbChallengeAction({kind:'key',text:'Enter'}));
$('fbChallengeTab').addEventListener('click', () => fbChallengeAction({kind:'key',text:'Tab'}));
$('fbChallengeScrollUp').addEventListener('click', () => fbChallengeAction({kind:'scroll_up'}));
$('fbChallengeScrollDown').addEventListener('click', () => fbChallengeAction({kind:'scroll_down'}));
$('fbChallengeRefresh').addEventListener('click', fbPreview);
$('newSearchTop').addEventListener('click', () => searchDialog());
$('newSearchSide').addEventListener('click', () => searchDialog());
$('importSearchUrlButton').addEventListener('click', importSearchCriteriaFromUrl);
$('importSearchUrl').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void importSearchCriteriaFromUrl();
  }
});
$('settingsSide').addEventListener('click', openSettings);
$('settingsTop').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => hide('settingsDialog'));
$('stopScan').addEventListener('click', async () => {
  try { await api('/api/refresh/stop',{method:'POST',body:'{}'}); abortScan=true; renderProgress(); }
  catch(error) {toast(error.message,true);}
});
$('searchForm').addEventListener('submit', event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') hide('searchDialog'); else commitSearch();
});
$('closeManualCarDialog').addEventListener('click', () => hide('manualCarDialog'));
$('cancelManualCarDialog').addEventListener('click', () => hide('manualCarDialog'));
$('manualCarForm').addEventListener('submit', event => {
  event.preventDefault();
  void commitManualCar();
});
$('noteForm').addEventListener('submit', event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') hide('noteDialog'); else commitNote();
});
$('confirmDelete').addEventListener('click', deleteSearch);
$('cancelDelete').addEventListener('click', () => hide('deleteDialog'));
$('closeDelete').addEventListener('click', () => hide('deleteDialog'));
$('pageDepth').addEventListener('change', async event => {
  try { accept(await api('/api/options',{method:'PATCH',body:JSON.stringify({pageDepth:Number(event.target.value)})})); toast('Scan depth saved on the server.'); }
  catch(error) {toast(error.message,true);}
});
$('exportBackup').addEventListener('click', downloadBackup);
$('importBackup').addEventListener('click', () => $('backupFile').click());
$('backupFile').addEventListener('change', event => importBackup(event.target.files[0]));
$('listModeButton').addEventListener('click', () => {
  resultsLayout = 'list'; mapRequestId++; renderResults();
});
$('mapModeButton').addEventListener('click', () => {
  resultsLayout = 'map'; mapSignature = ''; renderResults();
});
$('listingMap').addEventListener('click', mapCarClick);
$('unmappedCars').addEventListener('click', mapCarClick);
$('unmappedCars').addEventListener('click', retryUnmappedLocations);
$('retryLocationMap').addEventListener('click', retryModalLocation);
['keywordFilter','sourceFilter','sortFilter','changesOnly'].forEach(id => $(id).addEventListener(id === 'keywordFilter'?'input':'change',renderResults));
RESULT_FILTERS.forEach(id => $(id).addEventListener(
  id === 'resultTransmission' || id === 'resultColour' || id === 'resultBodyType' || id === 'resultDistanceMax' ? 'change' : 'input',
  () => {
    if (id === 'resultDistanceMax') distanceFailures.clear();
    renderResults();
  }));
$('resultHideUnknown').addEventListener('change', renderResults);
$('saveHomeLocation').addEventListener('click', saveHomeLocation);
$('homeLocationInput').addEventListener('keydown', event => { if (event.key==='Enter') { event.preventDefault(); saveHomeLocation(); } });
$('resetHomeLocation').addEventListener('click', async () => {
  try {
    accept(await api('/api/options',{method:'PATCH',body:JSON.stringify({home:null})}));
    $('homeLocationInput').value=''; render(); toast('Distances now measured from High Lane, Stockport.');
  } catch (error) { toast(error.message,true); }
});
$('resetResultFilters').addEventListener('click', () => {
  RESULT_FILTERS.forEach(id => $(id).value =
    id === 'resultTransmission' || id === 'resultColour' || id==='resultBodyType' ? 'any' : '');
  $('resultHideUnknown').checked = false;
  renderResults();
  toast('Displayed-result filters cleared. Search criteria are unchanged.');
});
$('loginForm').addEventListener('submit',async event => {
  event.preventDefault();
  $('loginError').textContent='';
  try {
    await api('/api/login',{method:'POST',body:JSON.stringify({password:$('loginPassword').value})});
    $('loginOverlay').classList.add('hidden'); $('loginPassword').value='';
    await load();
  } catch(error) { $('loginError').textContent=error.message; }
});
$('googleLoginButton').addEventListener('click', async () => {
  $('loginError').textContent='';
  $('googleLoginButton').disabled=true;
  try {
    await signInWithGoogle(authInfo.everSignedIn ? '' : 'select_account');
    $('loginOverlay').classList.add('hidden');
    await load(); void syncStatus();
  } catch (error) { $('loginError').textContent=error.message; }
  finally { $('googleLoginButton').disabled=false; }
});
$('googleSignOut').addEventListener('click', async () => {
  try { await rawApi('/api/logout',{method:'POST',body:'{}'}); } catch {}
  authInfo.authenticated=false; authInfo.email=null;
  state=initial(); revision=-1; hide('settingsDialog'); render();
  showLogin('Signed out. Your data stays in your Google Drive.');
});
// Renew the Google sign-in shortly before it expires while the page is in
// use (a click counts as a user gesture, so the renewal pop-up is allowed).
document.addEventListener('click', () => {
  if (authInfo.mode==='google' && authInfo.authenticated && googleTokenExpires &&
      googleTokenExpires-Date.now() < 10*60*1000) void signInWithGoogle('').catch(() => {});
}, true);
async function start() {
  try { authInfo=await rawApi('/api/auth'); } catch { authInfo={mode:'password'}; }
  authInfo.everSignedIn=!!authInfo.authenticated;
  showAccount();
  if (authInfo.mode==='google' && !authInfo.authenticated) { showLogin(); return; }
  await load(); void syncStatus();
}
start().catch(error => setNotice('Unable to load the dashboard: '+error.message));
setInterval(syncStatus,1800);
