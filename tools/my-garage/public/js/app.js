import {load,save,reset} from './storage/database.js';
import {assetIdFor,putAssetDataUrl,deleteAsset,migrateLegacyAssets,hydrateStateAssets,storageHealth,requestPersistentStorage,pruneAssets} from './storage/assets.js';
import {lookupVehicle,integrationStatus} from './services/vehicleLookup.js';
import {initializeGoogleDriveSync,signInGoogleDrive,restoreGoogleDriveSession,signOutGoogleDrive,syncGoogleDrive,googleDriveSnapshot} from './services/googleDriveSync.js';

let state=load();
let garageView='grid';
try{
 const savedGarageView=localStorage.getItem('garage.ui.view');
 if(['grid','gallery','list'].includes(savedGarageView))garageView=savedGarageView
}catch{}
let route={screen:'garage'};
let routeDepth=Number(history.state?.drivehubDepth||0);
let skipNextPopGuard=false;
let pendingLookup=null;
let integrations=null;
let liveChecks={};
let eventFilterState={};
let googleSyncConfig={configured:false,clientId:''};
let googleUser=null;
let googleSyncStatus={state:'starting',message:'Checking Google sync…'};
let googleSyncTimer=null;
let deferredInstallPrompt=null;
let modalReturnFocus=null;
let storageStatus={supported:'indexedDB' in window,usage:null,quota:null,usageRatio:null,persisted:null};
let installState={
  available:false,
  installed:window.matchMedia?.('(display-mode: standalone)')?.matches||window.navigator.standalone===true
};
const app=document.querySelector('#app');
const NOTIFICATION_EMAIL_IDENTITY_KEY='drivehub.notifications.email.v1';
const NOTIFICATION_PUSH_IDENTITY_KEY='drivehub.notifications.push.v2';
let notificationSyncTimer=null;
let notificationRequestSeq=0;
const notificationRequests=new Map();
let emailRelayConfigured=null;
let pushRelayConfigured=null;
function driveHubHosted(){
 if(window.DriveHubRuntime?.hasHostedBackend)return true;
 if(/^https?:$/.test(location.protocol))return true;
 try{return window.parent!==window&&/^https?:$/.test(parent.location.protocol)}catch{return false}
}
function notificationPrefs(){
 state._prefs=state._prefs||{};
 state._prefs.notifications={enabled:false,...(state._prefs.notifications||{}),channels:{browser:false,email:false,app:false,...(state._prefs.notifications?.channels||{})}};
 return state._prefs.notifications
}
function loadEmailNotificationIdentity(){try{const x=JSON.parse(localStorage.getItem(NOTIFICATION_EMAIL_IDENTITY_KEY)||'null');return x&&typeof x==='object'?x:null}catch{return null}}
function saveEmailNotificationIdentity(value){try{if(value)localStorage.setItem(NOTIFICATION_EMAIL_IDENTITY_KEY,JSON.stringify(value));else localStorage.removeItem(NOTIFICATION_EMAIL_IDENTITY_KEY)}catch{}}
function loadPushNotificationIdentity(){try{const x=JSON.parse(localStorage.getItem(NOTIFICATION_PUSH_IDENTITY_KEY)||'null');return x&&typeof x==='object'?x:null}catch{return null}}
function savePushNotificationIdentity(value){try{if(value)localStorage.setItem(NOTIFICATION_PUSH_IDENTITY_KEY,JSON.stringify(value));else localStorage.removeItem(NOTIFICATION_PUSH_IDENTITY_KEY)}catch{}}
function browserNotificationEmbedded(){return window.parent!==window&&String(location.protocol)==='about:'}
function isIosDevice(){return /iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)}
function isStandaloneWebApp(){return window.matchMedia?.('(display-mode: standalone)')?.matches||window.navigator.standalone===true}
function browserNotificationAvailable(){
 if(window.DriveHubRuntime?.isNative)return false;
 if(!('Notification' in window)||!driveHubHosted())return false;
 if(browserNotificationEmbedded())return true;
 return window.isSecureContext===true&&'serviceWorker'in navigator&&'PushManager'in window
}
function browserNotificationPermission(){return 'Notification' in window?Notification.permission:'unsupported'}
window.addEventListener('message',event=>{
 const data=event.data;if(data?.type!=='drivehub-notification-response'||!data.requestId)return;
 const pending=notificationRequests.get(data.requestId);if(!pending)return;notificationRequests.delete(data.requestId);clearTimeout(pending.timer);data.error?pending.reject(new Error(data.error)):pending.resolve(data.result)
});
function requestParentNotification(action,payload={}){
 return new Promise((resolve,reject)=>{const requestId=`notify-${Date.now()}-${++notificationRequestSeq}`,timer=setTimeout(()=>{notificationRequests.delete(requestId);reject(new Error('Browser notification request timed out'))},12000);notificationRequests.set(requestId,{resolve,reject,timer});parent.postMessage({type:'drivehub-notification',action,requestId,...payload},'*')})
}
async function requestBrowserNotificationPermission(){
 if(!browserNotificationAvailable())throw new Error('Browser notifications need DriveHub to be opened over HTTPS in a browser that supports Web Push.');
 if(isIosDevice()&&!isStandaloneWebApp()&&!browserNotificationEmbedded())throw new Error('On iPhone or iPad, add DriveHub to your Home Screen before enabling browser notifications.');
 if(browserNotificationEmbedded())return requestParentNotification('permission');
 if(Notification.permission==='granted')return 'granted';
 if(Notification.permission==='denied')return 'denied';
 return Notification.requestPermission()
}
function urlBase64ToUint8Array(value){
 const padding='='.repeat((4-value.length%4)%4),base64=(value+padding).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(base64),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out
}
async function directPushSubscription(vapidPublicKey){
 if(!('serviceWorker'in navigator)||!('PushManager'in window))throw new Error('Web Push is not supported in this browser.');
 const registration=await navigator.serviceWorker.register('./service-worker.js?v=14221',{updateViaCache:'none'});try{await registration.update()}catch{}
 let subscription=await registration.pushManager.getSubscription();
 if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(vapidPublicKey)});
 return subscription.toJSON()
}
async function currentPushSubscription(){
 if(browserNotificationEmbedded())return requestParentNotification('push-current');
 if(!('serviceWorker'in navigator))return null;
 const registration=await navigator.serviceWorker.getRegistration('./');if(!registration?.pushManager)return null;const subscription=await registration.pushManager.getSubscription();return subscription?.toJSON?.()||null
}
async function createPushSubscription(vapidPublicKey){return browserNotificationEmbedded()?requestParentNotification('push-subscribe',{vapidPublicKey}):directPushSubscription(vapidPublicKey)}
async function unsubscribePushSubscription(){
 if(browserNotificationEmbedded()){try{return await requestParentNotification('push-unsubscribe')}catch{return false}}
 if(!('serviceWorker'in navigator))return false;const registration=await navigator.serviceWorker.getRegistration('./');const subscription=await registration?.pushManager?.getSubscription();return subscription?subscription.unsubscribe():false
}
function reminderNotificationCandidates(){
 const reminderType={mot_due:'mot',tax_due:'tax',service_due:'service',insurance_due:'insurance'},out=[];
 for(const v of state.vehicles||[]){
  const vehicle=displayVehicleName(v),reg=v.registration?` · ${v.registration}`:'';
  for(const item of systemFeedItems(v)){
   const key=reminderType[item.type];if(!item.future||!key||!systemNudgeEnabled(v,key)||!item.date)continue;
   out.push({key:`system:${item.type}:${v.id}`,title:item.title||activityLabel(item.type),date:String(item.date).slice(0,10),body:`${vehicle}${reg} · Due ${fmtDate(item.date)}`})
  }
 }
 for(const r of activeReminders()){
  if(r.enabled===false||!r.date)continue;const v=vehicleById(r.vehicleId);if(!v)continue;const vehicle=displayVehicleName(v),reg=v.registration?` · ${v.registration}`:'';
  out.push({key:`custom:${r.id}`,title:r.title||'DriveHub reminder',date:String(r.date).slice(0,10),body:`${vehicle}${reg} · Due ${fmtDate(r.date)}`})
 }
 return out
}
function localReminderSendAt(date,daysBefore){const d=new Date(`${String(date).slice(0,10)}T09:00:00`);d.setDate(d.getDate()-daysBefore);return d}
function buildNotificationSchedule(){
 const now=Date.now(),soon=()=>new Date(Date.now()+120000).toISOString(),out=[];
 for(const reminder of reminderNotificationCandidates()){
  const days=daysUntil(reminder.date);if(days===null||days<0)continue;
  const add=(stage,offset,catchUp=false)=>{let at=localReminderSendAt(reminder.date,offset);if(catchUp&&at.getTime()<=now)at=new Date(soon());if(at.getTime()<=now&&!catchUp)return;out.push({key:`${reminder.key}:${reminder.date}:${stage}`,title:reminder.title,body:reminder.body,sendAt:at.toISOString()})};
  if(days<=7)add('week',7,true);
  else if(days<=21){add('three-weeks',21,true);add('week',7,false)}
  else{add('three-weeks',21,false);add('week',7,false)}
 }
 return out.slice(0,200)
}
function buildEmailReminderSchedule(){return buildNotificationSchedule()}
function buildPushReminderSchedule(){return buildNotificationSchedule()}
async function notificationApi(path,payload){
 if(!driveHubHosted())throw new Error('Background notifications need DriveHub to be opened from its hosted service.');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);let r;
 try{r=await fetch(window.DriveHubRuntime?.apiUrl?.(`/api/notifications/${path}`)||`/api/notifications/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload||{}),signal:controller.signal})}catch(err){if(err?.name==='AbortError')throw new Error('The notification relay took too long to respond.');throw new Error('Could not reach the notification relay.')}finally{clearTimeout(timer)}
 const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||`Notification relay failed (${r.status})`);return data
}
async function refreshNotificationRelayStatus(){
 if(!driveHubHosted()){emailRelayConfigured=false;pushRelayConfigured=false;if(route.screen==='reminders')render();return false}
 let relayConfigured=null;
 try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);const r=await fetch(window.DriveHubRuntime?.apiUrl?.('/api/integrations/status')||'/api/integrations/status',{cache:'no-store',signal:controller.signal});clearTimeout(timer);const data=r.ok?await r.json():null;relayConfigured=Boolean(data?.notifications?.configured);emailRelayConfigured=relayConfigured}catch{emailRelayConfigured=null;relayConfigured=null}
 if(relayConfigured){try{await notificationApi('push/config',{});pushRelayConfigured=true}catch{pushRelayConfigured=false}}else pushRelayConfigured=relayConfigured;
 if(route.screen==='reminders')render();return relayConfigured
}
async function syncEmailReminders(){
 const identity=loadEmailNotificationIdentity();if(!identity?.verified||!identity.subscriptionId||!identity.token)return;
 const prefs=notificationPrefs(),reminders=prefs.enabled&&prefs.channels.email?buildEmailReminderSchedule():[];
 try{await notificationApi('sync',{subscriptionId:identity.subscriptionId,token:identity.token,reminders})}catch(err){console.warn('DriveHub email reminder sync failed',err)}
}
async function ensureBrowserPushRegistration({requestPermission=false}={}){
 if(!browserNotificationAvailable())throw new Error('Web Push is not supported in this browser.');
 const config=await notificationApi('push/config',{});
 let permission=browserNotificationPermission();
 if(permission!=='granted'){
  if(!requestPermission)return null;
  permission=await requestBrowserNotificationPermission();if(permission!=='granted')throw new Error(permission==='denied'?'Browser notifications are blocked in browser settings.':'Browser notification permission was not granted.')
 }
 const subscription=await createPushSubscription(config.vapidPublicKey);if(!subscription?.endpoint)throw new Error('The browser did not create a push subscription.');
 const existing=loadPushNotificationIdentity(),currentEndpoint=subscription.endpoint;
 if(existing?.deviceId&&existing?.token&&existing?.endpoint===currentEndpoint)return existing;
 const registered=await notificationApi('push/register',{subscription}),identity={deviceId:registered.deviceId,token:registered.token,endpoint:currentEndpoint,registered:true};savePushNotificationIdentity(identity);return identity
}
async function syncPushReminders(){
 const prefs=notificationPrefs();let identity=loadPushNotificationIdentity();
 if(prefs.enabled&&prefs.channels.browser&&!identity&&browserNotificationPermission()==='granted'){try{identity=await ensureBrowserPushRegistration({requestPermission:false})}catch(err){console.warn('DriveHub Web Push registration refresh failed',err)}}
 if(!identity?.deviceId||!identity?.token)return;
 const reminders=prefs.enabled&&prefs.channels.browser?buildPushReminderSchedule():[];
 try{await notificationApi('push/sync',{deviceId:identity.deviceId,token:identity.token,reminders})}catch(err){if(/not authorised/i.test(String(err?.message||''))&&prefs.enabled&&prefs.channels.browser){savePushNotificationIdentity(null);try{const fresh=await ensureBrowserPushRegistration({requestPermission:false});if(fresh)await notificationApi('push/sync',{deviceId:fresh.deviceId,token:fresh.token,reminders});return}catch{}}console.warn('DriveHub Web Push reminder sync failed',err)}
}
function queueNotificationSync(){clearTimeout(notificationSyncTimer);notificationSyncTimer=setTimeout(()=>Promise.allSettled([syncEmailReminders(),syncPushReminders()]),1200)}
async function enableBrowserPush(){const identity=await ensureBrowserPushRegistration({requestPermission:true});if(!identity)throw new Error('Could not enable Web Push.');return identity}
async function disableBrowserPush(){
 const identity=loadPushNotificationIdentity();if(identity?.deviceId&&identity?.token){try{await notificationApi('push/delete',{deviceId:identity.deviceId,token:identity.token})}catch{}}
 try{await unsubscribePushSubscription()}catch{}savePushNotificationIdentity(null)
}
async function beginEmailVerification(email){const result=await notificationApi('register',{email});saveEmailNotificationIdentity({subscriptionId:result.subscriptionId,email:result.email,pending:true,verified:false});return result}
async function finishEmailVerification(code){const current=loadEmailNotificationIdentity();if(!current?.subscriptionId)throw new Error('Send a verification code first.');const result=await notificationApi('verify',{subscriptionId:current.subscriptionId,code});saveEmailNotificationIdentity({subscriptionId:result.subscriptionId,email:result.email,token:result.token,verified:true,pending:false});queueNotificationSync();return result}
async function clearEmailNotificationIdentity(){const current=loadEmailNotificationIdentity();if(current?.verified&&current.subscriptionId&&current.token){try{await notificationApi('delete',{subscriptionId:current.subscriptionId,token:current.token})}catch{}}saveEmailNotificationIdentity(null)}
function notificationSettingsMarkup(){
 const prefs=notificationPrefs(),identity=loadEmailNotificationIdentity(),pushIdentity=loadPushNotificationIdentity(),permission=browserNotificationPermission(),browserSupported=browserNotificationAvailable(),iosNeedsInstall=isIosDevice()&&!isStandaloneWebApp()&&!browserNotificationEmbedded();
 const browserStatus=!browserSupported?'Not available in this browser':iosNeedsInstall?'Add DriveHub to your Home Screen first':permission==='denied'?'Blocked in browser settings':pushIdentity?.registered?'Background push ready · works when DriveHub is closed':permission==='granted'?'Permission allowed · enable to finish setup':'Permission asked when enabled';
 const emailStatus=identity?.verified?`Verified · ${identity.email}`:identity?.pending?`Code sent · ${identity.email}`:emailRelayConfigured===false?'Relay needs setup':'Verify an email address';
 const childrenDisabled=!prefs.enabled?'disabled':'';
 const browserDisabled=pushRelayConfigured===false?'disabled':'';
 const emailSetup=prefs.enabled&&prefs.channels.email?identity?.verified?`<div class="notification-email-setup verified"><div><strong>${esc(identity.email)}</strong><small>Email reminders are scheduled through your private DriveHub relay.</small></div><button type="button" class="secondary small-btn" data-notification-email-change>Change</button></div>`:`<form class="notification-email-setup" id="notification-email-form"><div class="field"><label>Email address</label><input type="email" name="email" value="${esc(identity?.email||googleUser?.email||'')}" placeholder="you@example.com" required></div>${identity?.pending?`<div class="notification-code-row"><div class="field"><label>Verification code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6-digit code" required></div><button type="button" class="primary" id="verify-notification-email">Verify</button></div><button type="submit" class="notification-resend">Send a new code</button>`:`<button type="submit" class="primary full">Send verification code</button>`}<small class="notification-privacy-note">Only your email address and the minimal reminder schedule are sent to the relay.</small></form>`:'';
 return `<section class="organic-notification-card"><div class="notification-master-row"><div><p class="organic-kicker">NOTIFICATIONS</p><strong>Notifications</strong><small>Turn background reminder channels on or off together.</small></div><label class="organic-switch"><input type="checkbox" data-notifications-master ${prefs.enabled?'checked':''}><span></span></label></div><div class="notification-channel-list ${prefs.enabled?'':'disabled'}"><article><span class="notification-channel-icon">${navIcon('reminders')}</span><div><strong>Browser notifications</strong><small>${esc(browserStatus)}</small></div><label class="organic-switch"><input type="checkbox" data-notification-channel="browser" ${prefs.channels.browser?'checked':''} ${childrenDisabled} ${browserDisabled}><span></span></label></article><article><span class="notification-channel-icon">@</span><div><strong>Email</strong><small>${esc(emailStatus)}</small></div><label class="organic-switch"><input type="checkbox" data-notification-channel="email" ${prefs.channels.email?'checked':''} ${childrenDisabled} ${emailRelayConfigured===false?'disabled':''}><span></span></label></article><article class="future"><span class="notification-channel-icon">▣</span><div><strong>App</strong><small>Coming later · native Android notifications</small></div><label class="organic-switch"><input type="checkbox" disabled><span></span></label></article></div>${emailSetup}<p class="notification-browser-note">Browser reminders use genuine Web Push, so they can arrive even when DriveHub is closed. On iPhone/iPad, install DriveHub to the Home Screen first. Email uses the same Cloudflare schedule.</p></section>`
}
async function refreshPushRegistrationOnLoad(){const prefs=notificationPrefs();if(!prefs.enabled||!prefs.channels.browser||browserNotificationPermission()!=='granted')return;try{await ensureBrowserPushRegistration({requestPermission:false});await syncPushReminders()}catch(err){console.warn('DriveHub Web Push startup refresh failed',err)}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&notificationPrefs().enabled&&notificationPrefs().channels.browser)syncPushReminders()});

function openDriveHubTool(tool){
 try{if(window.parent!==window&&String(location.protocol)==='about:'){parent.postMessage({type:'drivehub-open',tool},'*');return}}catch{}
 const hosted=/^https?:$/.test(location.protocol);
 const targets={valuation:hosted?'/valuation/':'../../valuation/public/index.html',roads:hosted?'/roads/':'../../road-finder/public/index.html'};
 if(targets[tool])location.href=targets[tool]
}
const uid=()=>crypto.randomUUID?.()||String(Date.now()+Math.random());
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function userInitials(){
 const raw=googleUser?.name||googleUser?.email?.split('@')[0]||'You';
 const parts=String(raw).trim().split(/\s+/).filter(Boolean);
 return (parts.length>1?(parts[0][0]+parts.at(-1)[0]):parts[0]?.slice(0,2)||'ME').toUpperCase()
}
const fmtDate=d=>d?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric'}).format(new Date(`${d}`.slice(0,10)+'T12:00:00')):'Not set';
function icsEscape(value){
 return String(value??'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;')
}
function icsDate(value){
 const d=asDate(value);
 return d?`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`:''
}
function icsNextDate(value){
 const d=asDate(value);
 if(!d)return '';
 d.setDate(d.getDate()+1);
 return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
}
function icsStamp(){
 const d=new Date();
 return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}${String(d.getUTCSeconds()).padStart(2,'0')}Z`
}
function icsFold(line){
 const out=[];
 let rest=String(line);
 while(rest.length>72){
  out.push(rest.slice(0,72));
  rest=' '+rest.slice(72)
 }
 out.push(rest);
 return out.join('\r\n')
}
function downloadCalendarEvent({title,date,description='',uid=''}) {
 const start=icsDate(date),end=icsNextDate(date);
 if(!start||!end)return toast('This item does not have a valid date');
 const safeTitle=String(title||'DriveHub reminder').trim()||'DriveHub reminder';
 const safeUid=String(uid||`${safeTitle}-${date}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9._-]+/g,'-');
 const lines=[
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//DriveHub//Vehicle Calendar//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'BEGIN:VEVENT',
  `UID:${safeUid}@garage`,
  `DTSTAMP:${icsStamp()}`,
  `DTSTART;VALUE=DATE:${start}`,
  `DTEND;VALUE=DATE:${end}`,
  `SUMMARY:${icsEscape(safeTitle)}`,
  `DESCRIPTION:${icsEscape(description)}`,
  'TRANSP:TRANSPARENT',
  'END:VEVENT',
  'END:VCALENDAR'
 ].map(icsFold).join('\r\n')+'\r\n';
 const blob=new Blob([lines],{type:'text/calendar;charset=utf-8'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;
 a.download=`${safeTitle.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,54)||'garage-event'}.ics`;
 document.body.appendChild(a);
 a.click();
 a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1500);
 toast('Calendar file downloaded')
}
function calendarButtonMarkup({title,date,description='',uid='',label='Add to calendar'}){
 if(!date||daysUntil(date)<0)return '';
 return `<button type="button" class="organic-calendar-action" data-calendar-download data-calendar-title="${esc(title)}" data-calendar-date="${esc(String(date).slice(0,10))}" data-calendar-description="${esc(description)}" data-calendar-uid="${esc(uid)}">${appGlyph('clock')} ${esc(label)}</button>`
}

function shortDate(d){
 if(!d)return '—';
 try{return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short'}).format(new Date(`${d}`.slice(0,10)+'T12:00:00'))}catch{return '—'}
}
function compactDue(date){
 const days=daysUntil(date);
 if(!date||days===null)return {date:'—',days:'',urgent:false,overdue:false};
 if(days<0)return {date:shortDate(date),days:`${Math.abs(days)}d overdue`,urgent:true,overdue:true};
 return {date:shortDate(date),days:`${days}d`,urgent:days<=30,overdue:false}
}
function relativeAge(value){if(!value)return 'recently';const t=new Date(value).getTime();if(!Number.isFinite(t))return 'recently';const mins=Math.max(0,Math.floor((Date.now()-t)/60000));if(mins<2)return 'just now';if(mins<60)return `${mins}m ago`;const hrs=Math.floor(mins/60);if(hrs<24)return `${hrs}h ago`;const days=Math.floor(hrs/24);if(days<7)return `${days}d ago`;return fmtDate(String(value).slice(0,10))}
const money=n=>n===null||n===undefined||n===''?'—':new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(Number(n));
const miles=n=>Number(String(n??0).replace(/,/g,'')||0).toLocaleString('en-GB');
function parseMileage(value){
 const digits=String(value??'').replace(/[^0-9]/g,'');
 return digits?Number(digits):0
}
function mileageFieldValue(value){
 const n=parseMileage(value);
 return n?miles(n):''
}
function formatMileageField(input){
 if(!input)return;
 const original=String(input.value||'');
 const caret=input.selectionStart??original.length;
 const digitsBefore=original.slice(0,caret).replace(/[^0-9]/g,'').length;
 const digits=original.replace(/[^0-9]/g,'');
 const formatted=digits?Number(digits).toLocaleString('en-GB'):'';
 if(input.value!==formatted)input.value=formatted;
 let next=0,seen=0;
 while(next<formatted.length&&seen<digitsBefore){if(/\d/.test(formatted[next]))seen++;next++}
 try{input.setSelectionRange(next,next)}catch{}
}
function bindMileageFields(root=document){
 root.querySelectorAll?.('[data-mileage-input]').forEach(input=>{
  formatMileageField(input);
  input.addEventListener('input',()=>formatMileageField(input));
  input.addEventListener('blur',()=>formatMileageField(input));
 })
}
function formatRegistrationField(input){
 if(!input)return;
 const value=String(input.value||'').toUpperCase();
 if(input.value!==value){
  const start=input.selectionStart,end=input.selectionEnd;
  input.value=value;
  try{input.setSelectionRange(start,end)}catch{}
 }
}
function bindRegistrationFields(root=document){
 root.querySelectorAll?.('[data-registration-input]').forEach(input=>{
  formatRegistrationField(input);
  input.addEventListener('input',()=>formatRegistrationField(input));
  input.addEventListener('blur',()=>formatRegistrationField(input))
 })
}
function daysUntil(d){if(!d)return null;const target=new Date(`${d}`.slice(0,10)+'T12:00:00');const now=new Date();now.setHours(12,0,0,0);return Math.ceil((target-now)/86400000)}
function toast(msg,type='info'){document.querySelector('.toast')?.remove();const x=document.createElement('div');x.className=`toast ${type}`;x.textContent=msg;x.setAttribute('role','status');x.setAttribute('aria-live','polite');document.body.append(x);setTimeout(()=>{x.classList.add('leaving');setTimeout(()=>x.remove(),180)},2600)}
function currentDirtyForm(){return document.querySelector('form[data-guard-unsaved][data-dirty="true"]')}
function markFormDirty(form){if(form?.matches?.('[data-guard-unsaved]'))form.dataset.dirty='true'}
function bindUnsavedForms(root=document){root.querySelectorAll?.('form[data-guard-unsaved]').forEach(form=>{form.addEventListener('input',()=>markFormDirty(form));form.addEventListener('change',()=>markFormDirty(form))})}
async function confirmDiscardIfNeeded(){if(!currentDirtyForm())return true;return appConfirm({title:'Discard your changes?',message:'You have changes on this screen that have not been saved.',confirmLabel:'Discard changes',cancelLabel:'Keep editing'})}
function navigate(screen,id,tab,replace=false){const previous=route;route={screen,id,tab};routeDepth=replace?routeDepth:routeDepth+1;const next={screen,id:id||null,tab:tab||null,drivehub:true,drivehubDepth:routeDepth};try{replace?history.replaceState(next,''):history.pushState(next,'')}catch{}render();const sameVehicle=previous?.screen==='vehicle'&&screen==='vehicle'&&previous?.id===id;window.scrollTo({top:0,behavior:sameVehicle?'auto':'smooth'})}
async function guardedNavigate(screen,id,tab,replace=false){const same=screen===route.screen&&String(id||'')===String(route.id||'')&&String(tab||'')===String(route.tab||'');if(same){window.scrollTo({top:0,behavior:'smooth'});return}if(!await confirmDiscardIfNeeded())return;navigate(screen,id,tab,replace)}
async function appBack(button){if(!await confirmDiscardIfNeeded())return;if(routeDepth>0){skipNextPopGuard=true;history.back();return}navigate(button?.dataset.backScreen||'garage',button?.dataset.backId||undefined,button?.dataset.backTab||undefined,true)}
function itemTime(x){const t=new Date(x?.updatedAt||x?.createdAt||x?.date||0).getTime();return Number.isFinite(t)?t:0}
function mergeItems(remote=[],local=[]){
 const map=new Map();
 for(const item of [...remote,...local]){
   if(!item?.id)continue;
   const current=map.get(item.id);
   if(!current||itemTime(item)>=itemTime(current))map.set(item.id,item)
 }
 return [...map.values()]
}
function sanitizeSyncedValuation(value){if(!value||typeof value!=='object')return value||null;const out={...value};if(Array.isArray(out.comparables))out.comparables=out.comparables.map(item=>{if(!item||typeof item!=='object')return item;const {sellerName,username,userId,eiasToken,...safe}=item;return safe});return out}
function mergeVehicle(remote,local){
 if(!remote)return local?{...local,valuation:sanitizeSyncedValuation(local.valuation),valuationHistory:(local.valuationHistory||[]).map(sanitizeSyncedValuation)}:local;if(!local)return remote?{...remote,valuation:sanitizeSyncedValuation(remote.valuation),valuationHistory:(remote.valuationHistory||[]).map(sanitizeSyncedValuation)}:remote;
 const newer=itemTime(local)>=itemTime(remote)?local:remote,older=newer===local?remote:local;
 return {...older,...newer,
   valuation:sanitizeSyncedValuation(newer.valuation||older.valuation),
   activity:mergeItems(remote.activity||[],local.activity||[]),
   mileageHistory:mergeItems(remote.mileageHistory||[],local.mileageHistory||[]),
   photos:mergeItems(remote.photos||[],local.photos||[]),
   documents:mergeItems(remote.documents||[],local.documents||[]),
   specification:mergeItems(remote.specification||[],local.specification||[]),
   valuationHistory:[...(remote.valuationHistory||[]),...(local.valuationHistory||[])].filter((x,i,a)=>x?.updatedAt&&a.findIndex(y=>y?.updatedAt===x.updatedAt)===i).sort((a,b)=>new Date(a.updatedAt)-new Date(b.updatedAt)).slice(-24).map(sanitizeSyncedValuation)
 }
}
function mergeGarageData(remote,local){
 const r=remote&&typeof remote==='object'?remote:{vehicles:[],reminders:[]};
 const l=local&&typeof local==='object'?local:{vehicles:[],reminders:[]};
 const ids=new Set([...(r.vehicles||[]).map(v=>v.id),...(l.vehicles||[]).map(v=>v.id)]);
 const rv=new Map((r.vehicles||[]).map(v=>[v.id,v])),lv=new Map((l.vehicles||[]).map(v=>[v.id,v]));
 const deletedVehicles=mergeItems(r.deletedVehicles||[],l.deletedVehicles||[]);
 const tomb=new Map(deletedVehicles.map(x=>[x.id,itemTime(x)]));
 const vehicles=[...ids].map(id=>mergeVehicle(rv.get(id),lv.get(id))).filter(v=>v&&(!tomb.has(v.id)||itemTime(v)>tomb.get(v.id)));
 const _prefs={nudgeDelivery:'app',...(r._prefs||{}),...(l._prefs||{}),systemNudges:{mot:true,service:true,tax:true,insurance:true,...(r._prefs?.systemNudges||{}),...(l._prefs?.systemNudges||{})}};
 return {vehicles,reminders:mergeItems(r.reminders||[],l.reminders||[]),deletedVehicles,_prefs,_meta:{updatedAt:new Date().toISOString()}}
}
function queueGoogleSync(){
 if(!googleUser)return;
 clearTimeout(googleSyncTimer);
 googleSyncTimer=setTimeout(async()=>{
   try{
     const merged=await syncGoogleDrive(state,mergeGarageData);
     if(merged){state=merged;await migrateLegacyAssets(state);await hydrateStateAssets(state);save(state)}
   }catch{}
 },1200)
}
function persist(){try{save(state);queueGoogleSync();queueNotificationSync();setTimeout(refreshStorageHealth,0);return true}catch(err){toast(err?.message||'DriveHub could not save your changes','error');return false}}
async function refreshStorageHealth(){try{storageStatus=await storageHealth();if(route.screen==='settings')render()}catch{}}
async function storePhotoRecord(v,dataUrl,attrs={}){const id=attrs.id||uid(),assetId=assetIdFor('photo',v.id,id);await putAssetDataUrl(assetId,dataUrl,{name:`${v.registration||'vehicle'}-photo`,updatedAt:attrs.updatedAt||attrs.createdAt});return {...attrs,id,assetId,dataUrl}}
async function storeDocumentRecord(v,file,dataUrl,attrs={}){const id=attrs.id||uid(),assetId=assetIdFor('document',v.id,id);await putAssetDataUrl(assetId,dataUrl,{name:file?.name||attrs.name||'document',type:file?.type||attrs.type,size:file?.size||attrs.size,updatedAt:attrs.updatedAt||attrs.createdAt});return {...attrs,id,assetId,dataUrl}}
function vehicleById(id){return state.vehicles.find(x=>x.id===id)}
function activeReminders(){return (state.reminders||[]).filter(r=>!r._deleted)}
function systemNudgeEnabled(v,key){
 const globalEnabled=state._prefs?.systemNudges?.[key]!==false;
 const vehicleEnabled=v?.reminderSettings?.[key]!==false;
 return globalEnabled&&vehicleEnabled
}
function touchVehicle(v){if(v)v.updatedAt=new Date().toISOString()}

const PROVENANCE_LABELS={manual:'Entered by you',dvla:'DVLA',dvsa:'DVSA',ebay:'eBay',timeline:'Timeline',demo:'Demo data',live:'Live vehicle data',saved:'Saved record'};
const PROVENANCE_FIELD_LABELS={registration:'Registration',make:'Make',model:'Model',year:'Year',colour:'Colour',fuelType:'Fuel',engineSize:'Engine',transmission:'Transmission',bodyType:'Body type',mileage:'Mileage','mot.status':'MOT status','mot.expiryDate':'MOT expiry','mot.history':'MOT history','tax.status':'Tax status','tax.expiryDate':'Tax expiry','service.nextServiceDate':'Next service','service.nextServiceMileage':'Next service mileage','insurance.renewalDate':'Insurance renewal','insurance.premium':'Insurance premium','ownership.purchaseDate':'Purchase date','ownership.purchasePrice':'Purchase price',valuation:'Valuation'};
function ensureProvenance(v){if(!v.provenance||typeof v.provenance!=='object')v.provenance={fields:{},lookupAt:''};if(!v.provenance.fields||typeof v.provenance.fields!=='object')v.provenance.fields={};return v.provenance}
function valueAtPath(obj,path){return String(path||'').split('.').reduce((value,key)=>value==null?undefined:value[key],obj)}
function setValueAtPath(obj,path,value){const parts=String(path||'').split('.');let target=obj;for(let i=0;i<parts.length-1;i++){if(!target[parts[i]]||typeof target[parts[i]]!=='object')target[parts[i]]={};target=target[parts[i]]}target[parts.at(-1)]=value}
function provenanceSame(a,b){return String(a??'').trim()===String(b??'').trim()}
function provenanceSourceLabel(source){return PROVENANCE_LABELS[String(source||'').toLowerCase()]||String(source||'').trim()||'Saved record'}
function setFieldProvenance(v,path,source,updatedAt=new Date().toISOString(),extra={}){const p=ensureProvenance(v);p.fields[path]={source,updatedAt,...extra};return p.fields[path]}
function fieldProvenance(v,path){return v?.provenance?.fields?.[path]||null}
function sourceForLiveField(fresh,path){return fresh?.provenance?.fields?.[path]?.source||(String(path).startsWith('tax.')&&fresh?.source?.dvla?'dvla':path==='model'&&fresh?.source?.dvsa?'dvsa':fresh?.source?.demo?'demo':fresh?.source?.live?'live':'saved')}
function prettyProvenanceValue(path,value){if(value===undefined||value===null||value==='')return 'blank';if(/Date|expiryDate|renewalDate|purchaseDate/i.test(path)&&/^\d{4}-\d{2}-\d{2}/.test(String(value)))return fmtDate(value);if(/mileage/i.test(path)&&Number.isFinite(Number(value)))return `${miles(value)} miles`;return String(value)}
function mergeLiveField(v,fresh,path,skipped,lookupAt){if(fresh?.provenance?.fields&& !fresh.provenance.fields[path])return;const next=valueAtPath(fresh,path);if(next===undefined||next===null||next==='')return;const current=valueAtPath(v,path),existing=fieldProvenance(v,path),source=sourceForLiveField(fresh,path);if(existing?.source==='manual'){if(!provenanceSame(current,next)){setFieldProvenance(v,path,'manual',existing.updatedAt||lookupAt,{candidateValue:next,candidateSource:source,candidateUpdatedAt:lookupAt});skipped.push({path,current,next,source})}else setFieldProvenance(v,path,'manual',existing.updatedAt||lookupAt);return}setValueAtPath(v,path,next);setFieldProvenance(v,path,source,lookupAt)}
function markManualIfChanged(v,path,before,after,updatedAt){if(!provenanceSame(before,after))setFieldProvenance(v,path,'manual',updatedAt)}
function seedNewVehicleProvenance(v,fresh,updatedAt){const p=ensureProvenance(v);if(fresh?.provenance?.lookupAt)p.lookupAt=fresh.provenance.lookupAt;if(fresh?.provenance?.fields)p.fields=JSON.parse(JSON.stringify(fresh.provenance.fields));const livePaths=['make','model','year','colour','fuelType','engineSize','transmission','bodyType','mot.status','mot.expiryDate','tax.status','tax.expiryDate'];for(const path of livePaths){const current=valueAtPath(v,path);if(current===undefined||current===null||current==='')continue;const live=fresh?valueAtPath(fresh,path):undefined;if(!fresh||live===undefined||live===null||live===''||!provenanceSame(current,live))setFieldProvenance(v,path,'manual',updatedAt);else if(!fieldProvenance(v,path))setFieldProvenance(v,path,sourceForLiveField(fresh,path),fresh?.provenance?.lookupAt||updatedAt)}if(Array.isArray(v.mot?.history)&&v.mot.history.length&&!fieldProvenance(v,'mot.history'))setFieldProvenance(v,'mot.history',fresh?.source?.dvsa?'dvsa':fresh?.source?.demo?'demo':'saved',fresh?.provenance?.lookupAt||updatedAt);setFieldProvenance(v,'registration','manual',updatedAt);if(Number(v.mileage)>0)setFieldProvenance(v,'mileage','manual',updatedAt);['service.nextServiceDate','service.nextServiceMileage','insurance.renewalDate','insurance.premium','ownership.purchaseDate','ownership.purchasePrice'].forEach(path=>{const value=valueAtPath(v,path);if(value!==undefined&&value!==null&&value!=='')setFieldProvenance(v,path,'manual',updatedAt)})}
function provenanceUpdatedText(entry){return entry?.updatedAt?` · ${fmtDate(entry.updatedAt)}`:''}
function provenanceHint(v,path){const entry=fieldProvenance(v,path);if(!entry)return '';const source=provenanceSourceLabel(entry.source);const candidate=Object.prototype.hasOwnProperty.call(entry,'candidateValue')&&!provenanceSame(valueAtPath(v,path),entry.candidateValue);return `<small class="field-provenance ${entry.source==='manual'?'manual':''} ${candidate?'diff':''}">${esc(source)}${provenanceUpdatedText(entry)}${entry.source==='manual'?' · protected from live refresh':''}${candidate?`<span>${esc(provenanceSourceLabel(entry.candidateSource))} currently says “${esc(prettyProvenanceValue(path,entry.candidateValue))}”</span>`:''}</small>`}
function provenanceTag(v,path,fallbackSource='',fallbackAt=''){const entry=fieldProvenance(v,path)||(fallbackSource?{source:fallbackSource,updatedAt:fallbackAt}:null);return entry?`<span class="organic-source-tag">${esc(provenanceSourceLabel(entry.source))}${provenanceUpdatedText(entry)}</span>`:''}
function provenanceFallback(v,path){const exact=fieldProvenance(v,path);if(exact)return exact;if(path==='mot.history'&&v.source?.dvsa)return {source:'dvsa'};if(String(path).startsWith('tax.')&&v.source?.dvla)return {source:'dvla'};if(['make','year','colour','fuelType','engineSize'].includes(path)&&v.source?.dvla)return {source:'live'};if(path==='model'&&v.source?.dvsa)return {source:'live'};return null}
function provenanceReviewItems(v){return Object.entries(v?.provenance?.fields||{}).filter(([path,entry])=>entry?.source==='manual'&&Object.prototype.hasOwnProperty.call(entry,'candidateValue')&&!provenanceSame(valueAtPath(v,path),entry.candidateValue)).map(([path,entry])=>({path,entry,current:valueAtPath(v,path)}))}
function markServiceProvenance(v,entry,updatedAt){if(!entry)return;setFieldProvenance(v,'service.lastServiceDate','timeline',updatedAt);if(entry.mileage!=null)setFieldProvenance(v,'service.lastServiceMileage','timeline',updatedAt);if(Object.prototype.hasOwnProperty.call(entry,'nextServiceDate'))setFieldProvenance(v,'service.nextServiceDate','timeline',updatedAt);if(Object.prototype.hasOwnProperty.call(entry,'nextServiceMileage'))setFieldProvenance(v,'service.nextServiceMileage','timeline',updatedAt)}
function activeActivity(v){return (v.activity||[]).filter(a=>!a._deleted)}
const SERVICE_TYPES=[['interim','Interim service'],['full','Full service'],['major','Major service'],['oil','Oil change'],['inspection','Inspection'],['custom','Custom']];
function serviceTypeLabel(value){return SERVICE_TYPES.find(([key])=>key===String(value||'').toLowerCase())?.[1]||String(value||'').trim()||'Service'}
function serviceRecords(v){return activeActivity(v).filter(a=>a.type==='service').slice().sort((a,b)=>new Date(b.date||0)-new Date(a.date||0))}
function serviceDuration(days){if(days===null||days===undefined)return '';const n=Math.abs(Number(days)||0);if(n<45)return `${Math.max(0,Math.round(n))} day${Math.round(n)===1?'':'s'}`;const months=Math.max(1,Math.round(n/30.44));return `${months} month${months===1?'':'s'}`}
function servicePlan(v){const records=serviceRecords(v),latest=records[0]||null,currentMileage=Number(v.mileage||0);const lastDate=latest?.date||v.service?.lastServiceDate||'',lastMileage=latest?.mileage??v.service?.lastServiceMileage??null,lastType=latest?.serviceType||v.service?.lastServiceType||'',garageName=latest?.garageName||v.service?.lastGarage||'';const nextDate=(latest&&Object.prototype.hasOwnProperty.call(latest,'nextServiceDate'))?latest.nextServiceDate:(v.service?.nextServiceDate||'');const nextMileage=(latest&&Object.prototype.hasOwnProperty.call(latest,'nextServiceMileage'))?latest.nextServiceMileage:(v.service?.nextServiceMileage??null);const milesSince=lastMileage!==null&&lastMileage!==''&&currentMileage>=Number(lastMileage)?currentMileage-Number(lastMileage):null;const daysRemaining=nextDate?daysUntil(nextDate):null;const milesRemaining=nextMileage!==null&&nextMileage!==''&&currentMileage?Number(nextMileage)-currentMileage:null;let headline='Not set';if(daysRemaining!==null&&milesRemaining!==null){if(daysRemaining<0||milesRemaining<0)headline='Service overdue';else headline=`${miles(milesRemaining)} mi / ${serviceDuration(daysRemaining)}`}else if(milesRemaining!==null)headline=milesRemaining<0?`Overdue by ${miles(Math.abs(milesRemaining))} mi`:`${miles(milesRemaining)} mi`;else if(daysRemaining!==null)headline=daysRemaining<0?`${serviceDuration(daysRemaining)} overdue`:serviceDuration(daysRemaining);const detail=[nextDate?fmtDate(nextDate):'',nextMileage!==null&&nextMileage!==''?`${miles(nextMileage)} miles`:''].filter(Boolean).join(' · ');return {records,latest,lastDate,lastMileage,lastType,garageName,nextDate,nextMileage,milesSince,daysRemaining,milesRemaining,headline,detail}}
function syncServiceFromTimeline(v){v.service=v.service||{lastServiceDate:'',lastServiceMileage:null,nextServiceDate:'',nextServiceMileage:null,history:[]};const latest=serviceRecords(v)[0];if(!latest){v.service.lastServiceDate='';v.service.lastServiceMileage=null;v.service.lastServiceType='';v.service.lastGarage='';return}v.service.lastServiceDate=latest.date||'';v.service.lastServiceMileage=latest.mileage??null;v.service.lastServiceType=latest.serviceType||'';v.service.lastGarage=latest.garageName||'';if(Object.prototype.hasOwnProperty.call(latest,'nextServiceDate'))v.service.nextServiceDate=latest.nextServiceDate||'';if(Object.prototype.hasOwnProperty.call(latest,'nextServiceMileage'))v.service.nextServiceMileage=latest.nextServiceMileage??null}
function recordPhotoActivity(v,photos,addedAt=new Date().toISOString()){
 const added=(photos||[]).filter(p=>p?.id);
 if(!v||!added.length)return;
 v.activity=v.activity||[];
 const count=added.length;
 v.activity.push({
  id:uid(),type:'photo',title:count===1?'Photo added':`${count} photos added`,date:addedAt,
  body:count===1?'Added to Photos.':`Added ${count} photos to Photos.`,photoIds:added.map(p=>p.id),
  system:true,createdAt:addedAt,updatedAt:addedAt
 })
}
function statusClass(days){if(days===null)return '';if(days<0)return 'bad';if(days<=30)return 'warn';return 'good'}
function relativeDue(date){const d=daysUntil(date);if(d===null)return 'Not set';if(d<0)return `${Math.abs(d)} days overdue`;if(d===0)return 'Due today';return `${d} days`}
function asDate(value){if(!value)return null;const d=new Date(`${String(value).slice(0,10)}T12:00:00`);return Number.isNaN(d.getTime())?null:d}
function yearsBetween(a,b){const x=asDate(a),y=asDate(b);if(!x||!y)return null;return Math.max(0,(y-x)/(365.2425*86400000))}
function normaliseDefectType(type,dangerous=false){const t=String(type||'').toUpperCase();if(dangerous||t.includes('DANGEROUS'))return 'dangerous';if(t.includes('MAJOR'))return 'major';if(t.includes('MINOR'))return 'minor';if(t.includes('ADVIS'))return 'advisory';if(t.includes('PRS'))return 'prs';return 'other'}
function defectLabel(type){return ({dangerous:'Dangerous',major:'Major',minor:'Minor',advisory:'Advisory',prs:'PRS',other:'Note'}[type]||'Note')}
function motTests(v){return (v.mot?.history||[]).slice().sort((a,b)=>new Date(b.completedDate)-new Date(a.completedDate))}
function motMileagePoints(v){
 const map=new Map();
 for(const t of motTests(v)){const m=Number(t.odometerValue);if(t.completedDate&&Number.isFinite(m)&&m>0)map.set(String(t.completedDate).slice(0,10),{date:String(t.completedDate).slice(0,10),mileage:m,source:'MOT'})}
 for(const p of (v.mileageHistory||[]).filter(x=>!x._deleted)){const m=Number(p.mileage);if(p.date&&Number.isFinite(m)&&m>0)map.set(String(p.date).slice(0,10),{date:String(p.date).slice(0,10),mileage:m,source:'Recorded'})}
 if(Number(v.mileage)>0){const today=new Date().toISOString().slice(0,10);map.set(today,{date:today,mileage:Number(v.mileage),source:'Current'})}
 return [...map.values()].sort((a,b)=>new Date(a.date)-new Date(b.date));
}
function annualMileageEstimate(v){
 const pts=motMileagePoints(v);if(pts.length<2)return null;
 let best=null;
 for(let i=Math.max(1,pts.length-4);i<pts.length;i++){const a=pts[i-1],b=pts[i];const yrs=yearsBetween(a.date,b.date);const diff=b.mileage-a.mileage;if(yrs&&yrs>.2&&diff>=0){const rate=diff/yrs;if(rate<100000)best=rate}}
 if(best===null){const a=pts[0],b=pts.at(-1),yrs=yearsBetween(a.date,b.date),diff=b.mileage-a.mileage;if(yrs&&diff>=0)best=diff/yrs}
 return best===null?null:Math.round(best/100)*100;
}
function ownershipIntelligence(v){
 const tests=motTests(v),pts=motMileagePoints(v),annual=annualMileageEstimate(v);
 const latest=tests[0]||null,previous=tests[1]||null;
 const latestDefects=(latest?.defects||[]).map(d=>({...d,severity:normaliseDefectType(d.type,d.dangerous)}));
 const currentConcerns=latestDefects.filter(d=>['dangerous','major','minor','advisory'].includes(d.severity));
 const allDefects=tests.flatMap((t,ti)=>(t.defects||[]).map(d=>({...d,testIndex:ti,date:t.completedDate,severity:normaliseDefectType(d.type,d.dangerous)})));
 const key=x=>String(x||'').toLowerCase().replace(/\b(?:nearside|offside|front|rear|left|right|upper|lower)\b/g,'').replace(/\s+/g,' ').trim();
 const counts=new Map();for(const d of allDefects){const k=key(d.text);if(k.length<8)continue;const x=counts.get(k)||{count:0,text:d.text,severity:d.severity,dates:[]};x.count++;x.dates.push(d.date);counts.set(k,x)}
 const repeats=[...counts.values()].filter(x=>x.count>=2).sort((a,b)=>b.count-a.count).slice(0,4);
 const failures=tests.filter(t=>String(t.testResult).toUpperCase().includes('FAIL')).length;
 const passes=tests.filter(t=>String(t.testResult).toUpperCase().includes('PASS')).length;
 const latestMileage=Number(latest?.odometerValue||0),prevMileage=Number(previous?.odometerValue||0);
 const latestInterval=latest&&previous&&latestMileage>=prevMileage?latestMileage-prevMileage:null;
 const ownedYears=yearsBetween(v.ownership?.purchaseDate,new Date().toISOString().slice(0,10));
 const purchaseMileage=(()=>{if(!v.ownership?.purchaseDate)return null;const after=pts.filter(p=>new Date(p.date)>=asDate(v.ownership.purchaseDate));const before=pts.filter(p=>new Date(p.date)<=asDate(v.ownership.purchaseDate));return (before.at(-1)||after[0])?.mileage??null})();
 const milesOwned=purchaseMileage!=null&&Number(v.mileage)>=purchaseMileage?Number(v.mileage)-purchaseMileage:null;
 const suggestions=[];
 for(const d of currentConcerns){if(['dangerous','major'].includes(d.severity))suggestions.push({priority:'urgent',title:d.text,body:'Latest MOT recorded this as a '+defectLabel(d.severity).toLowerCase()+' defect. Arrange inspection or repair before relying on the car.'});else if(d.severity==='minor'||d.severity==='advisory')suggestions.push({priority:'watch',title:d.text,body:'Keep this on the maintenance list and check whether it worsens before the next MOT.'})}
 for(const r of repeats){if(!suggestions.some(s=>key(s.title)===key(r.text)))suggestions.push({priority:'watch',title:`Repeated MOT item: ${r.text}`,body:`A similar issue appears ${r.count} times in the MOT record. Consider resolving the underlying cause rather than waiting for the next test.`})}
 return {tests,pts,annual,latest,latestDefects,currentConcerns,repeats,failures,passes,latestInterval,ownedYears,milesOwned,suggestions:suggestions.slice(0,5)};
}
function ownershipCosts(v){
 const entries=activeActivity(v).filter(a=>Number(a.cost)>0);
 const total=entries.reduce((sum,a)=>sum+Number(a.cost||0),0);
 const byType={};for(const a of entries)byType[a.type]=(byType[a.type]||0)+Number(a.cost||0);
 const ownedYears=yearsBetween(v.ownership?.purchaseDate,new Date().toISOString().slice(0,10));
 const perYear=ownedYears&&ownedYears>.08?total/ownedYears:null;
 const intel=ownershipIntelligence(v);const perMile=intel.milesOwned&&intel.milesOwned>0?total/intel.milesOwned:null;
 return {entries,total,byType,perYear,perMile};
}
function ownershipFinance(v){
 const purchase=Number(v.ownership?.purchasePrice||0),current=Number(v.valuation?.privateSale||0);
 const ownedYears=yearsBetween(v.ownership?.purchaseDate,new Date().toISOString().slice(0,10));
 const ownedMonths=ownedYears?Math.max(1,ownedYears*12):null;
 const valueChange=purchase&&current?current-purchase:null;
 const valueChangePct=valueChange!==null&&purchase?valueChange/purchase*100:null;
 const depreciationPerMonth=valueChange!==null&&valueChange<0&&ownedMonths?Math.abs(valueChange)/ownedMonths:null;
 const costs=ownershipCosts(v);
 const trackedPerMonth=ownedMonths?costs.total/ownedMonths:null;
 const valuationAge=v.valuation?.updatedAt?Math.max(0,Math.floor((Date.now()-new Date(v.valuation.updatedAt).getTime())/86400000)):null;
 return {purchase,current,ownedMonths,valueChange,valueChangePct,depreciationPerMonth,trackedPerMonth,valuationAge};
}
function recordCompleteness(v){
 const checks=[v.registration,v.make,v.model,v.year,v.mileage,v.mot?.expiryDate,v.tax?.status&&v.tax.status!=='Unknown',v.service?.lastServiceDate||v.service?.nextServiceDate,v.ownership?.purchaseDate,v.ownership?.purchasePrice,v.vin,(v.documents||[]).some(d=>!d._deleted)];
 const done=checks.filter(Boolean).length;return {done,total:checks.length,pct:Math.round(done/checks.length*100)};
}

function displayVehicleName(v){
 const base=[v.make,v.model].filter(Boolean).join(' ')||v.model||'My car';
 const nickname=String(v.nickname||'').trim();
 return nickname?`${base} (‘${nickname}’)`:base
}
function fullVehicleName(v){return [v.make,v.model].filter(Boolean).join(' ')||displayVehicleName(v)}
function garageDateLabel(){return new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long'}).format(new Date())}
function serviceSummary(v){
 if(v.service?.lastServiceDate)return `Serviced ${new Intl.DateTimeFormat('en-GB',{month:'short'}).format(new Date(`${v.service.lastServiceDate}T12:00:00`))}`;
 if(v.service?.nextServiceDate)return `Service ${relativeDue(v.service.nextServiceDate).toLowerCase()}`;
 return 'Service not set';
}
function garageStatusTag(v){
 const mot=daysUntil(v.mot?.expiryDate),service=daysUntil(v.service?.nextServiceDate),insurance=daysUntil(v.insurance?.renewalDate),tax=daysUntil(v.tax?.expiryDate);
 const candidates=[
  mot!==null?{days:mot,label:mot<0?'MOT overdue':mot===0?'MOT today':`MOT in ${mot} days`}:null,
  service!==null?{days:service,label:service<0?'Service overdue':service===0?'Service today':`Service in ${service} days`}:null,
  insurance!==null?{days:insurance,label:insurance<0?'Insurance overdue':insurance===0?'Insurance today':`Insurance in ${insurance} days`}:null,
  tax!==null?{days:tax,label:tax<0?'Tax overdue':tax===0?'Tax today':`Tax in ${tax} days`}:null
 ].filter(Boolean).sort((a,b)=>a.days-b.days);
 const first=candidates[0];
 if(first&&first.days<=60)return {tone:'attention',label:first.label};
 return {tone:'clear',label:'Nothing due'};
}
function garageNudge(){
 const rows=[];
 for(const v of state.vehicles){
  const checks=[
   systemNudgeEnabled(v,'mot')?['MOT',v.mot?.expiryDate,'mot']:null,
   systemNudgeEnabled(v,'service')?['service',v.service?.nextServiceDate,'mot']:null,
   systemNudgeEnabled(v,'insurance')?['insurance',v.insurance?.renewalDate,'mot']:null,
   systemNudgeEnabled(v,'tax')?['tax',v.tax?.expiryDate,'mot']:null
  ].filter(Boolean);
  for(const [label,date,tab] of checks){
   const d=daysUntil(date);if(d===null||d>60)continue;
   rows.push({v,label,date,days:d,tab})
  }
 }
 rows.sort((a,b)=>a.days-b.days);
 const x=rows[0];if(!x)return null;
 const name=displayVehicleName(x.v),subject=/^the\s/i.test(name)?name:`The ${name}`;
 const thing=x.label==='MOT'?'an MOT':x.label==='service'?'a service':x.label==='insurance'?'insurance':x.label==='tax'?'tax':x.label.toLowerCase();
 const when=x.days<0?`needs ${thing} — it’s overdue`:x.days===0?`needs ${thing} today`:x.days<=7?`needs ${thing} this week`:x.days<=28?`needs ${thing} in ${Math.ceil(x.days/7)} weeks`:`needs ${thing} soon`;
 return {vehicle:x.v,tab:x.tab,text:`${subject} ${when}`};
}
function ownershipYearsLabel(v){
 const y=yearsBetween(v.ownership?.purchaseDate,new Date().toISOString().slice(0,10));
 if(!y)return '—';
 if(y<1)return `${Math.max(1,Math.round(y*12))} mo`;
 return `${y.toFixed(y<2?1:0)} yr${y>=2?'s':''}`;
}
function currentYearSpend(v){
 const y=String(new Date().getFullYear());
 return activeActivity(v).filter(a=>String(a.date||'').startsWith(y)).reduce((sum,a)=>sum+Number(a.cost||0),0);
}

function nextBestAction(v){
 const mot=daysUntil(v.mot?.expiryDate),service=daysUntil(v.service?.nextServiceDate),insurance=daysUntil(v.insurance?.renewalDate),tax=daysUntil(v.tax?.expiryDate),intel=ownershipIntelligence(v);
 const serviceMiles=v.service?.nextServiceMileage?Number(v.service.nextServiceMileage)-Number(v.mileage||0):null;
 const dateAction=(days,label,date,action='overview',modal=null)=>{
   if(days===null)return null;
   if(days<0)return {level:'urgent',icon:'!',title:`${label} overdue`,body:`Was due ${fmtDate(date)}.`,action,modal,label:label==='MOT'?'Open MOT':'Review'};
   if(days<=60)return {level:'soon',icon:appGlyph('clock'),title:`Time for ${label==='MOT'?'an MOT':label.toLowerCase()} soon`,body:`Due ${fmtDate(date)} — ${days===0?'today':`${days} day${days===1?'':'s'} away`}.`,action,modal,label:label==='MOT'?'Open MOT':'Review'};
   return null;
 };
 if(v.tax?.status&& !['Taxed','Unknown','SORN'].includes(v.tax.status))return {level:'urgent',icon:'!',title:`Tax status: ${v.tax.status}`,body:'Check the vehicle tax status before using the car on the road.',action:'mot',label:'Review'};
 const motAction=dateAction(mot,'MOT',v.mot?.expiryDate,'mot');if(motAction)return motAction;
 const insuranceAction=dateAction(insurance,'Insurance',v.insurance?.renewalDate,'mot');if(insuranceAction)return insuranceAction;
 if(serviceMiles!==null&&serviceMiles<=0)return {level:'urgent',icon:'!',title:'Service mileage reached',body:`Service was planned by ${miles(v.service.nextServiceMileage)} miles.`,action:'mot',label:'Review'};
 const serviceAction=dateAction(service,'Service',v.service?.nextServiceDate,'mot');if(serviceAction)return serviceAction;
 if(serviceMiles!==null&&serviceMiles<=1000)return {level:'soon',icon:appGlyph('clock'),title:'Time for a service soon',body:`About ${miles(serviceMiles)} miles to the next planned service.`,action:'mot',label:'Review'};
 const taxAction=dateAction(tax,'Tax',v.tax?.expiryDate,'mot');if(taxAction)return taxAction;
 const urgentDefect=intel.currentConcerns.find(d=>['dangerous','major'].includes(d.severity));
 if(urgentDefect)return {level:'soon',icon:appGlyph('clock'),title:'MOT item worth following up',body:urgentDefect.text,action:'mot',label:'Review MOT'};
 const custom=(state.reminders||[]).filter(r=>r.vehicleId===v.id&&r.date&&r.enabled!==false).map(r=>({...r,days:daysUntil(r.date)})).filter(r=>r.days!==null&&r.days<=60).sort((a,b)=>a.days-b.days)[0];
 if(custom)return {level:custom.days<0?'urgent':'soon',icon:appGlyph('reminder'),title:custom.title,body:custom.days<0?`${Math.abs(custom.days)} days overdue`:`Due ${fmtDate(custom.date)}`,action:'reminders',label:'Open reminders'};
 return {level:'clear',icon:appGlyph('check'),title:'Nothing needs doing',body:'MOT, tax, service, insurance and your saved reminders look settled.',action:'story',label:''};
}
function actionPicker(v){
 const items=[['fuel','Log a fill-up','Fuel cost and mileage'],['mileage','Update mileage','Keep the odometer current'],['service','Record service','Service date, mileage and cost'],['maintenance','Maintenance','Tyres, brakes and routine jobs'],['repair','Repair','Faults and repairs'],['expense','Expense','Insurance or other costs'],['modification','Modification','Changes made to the car'],['note','Note','Anything else worth keeping']];
 return `<div class="modal-backdrop" id="picker-modal"><div class="modal-sheet"><div class="modal-handle"></div><div class="row"><div><p class="eyebrow">ADD AN EVENT</p><h2>What do you want to record?</h2></div><button class="icon-btn" id="close-modal">✕</button></div><div class="action-picker">${items.map(([type,title,body])=>`<button type="button" data-pick-action="${type}"><span>${activityIcon(type)}</span><div><strong>${title}</strong><small>${body}</small></div><b>›</b></button>`).join('')}</div></div></div>`;
}
function mileageChart(points){
 if(points.length<2)return '<div class="chart-empty"><span>〽</span><p>Add at least two mileage readings to see the trend.</p></div>';
 const w=Math.max(620,points.length*96),h=220,padX=54,padTop=48,padBottom=50,min=Math.min(...points.map(p=>p.mileage)),max=Math.max(...points.map(p=>p.mileage)),span=Math.max(1,max-min);const x=i=>padX+(i/(points.length-1))*(w-padX*2),y=m=>h-padBottom-((m-min)/span)*(h-padTop-padBottom);
 const coords=points.map((p,i)=>`${x(i)},${y(p.mileage)}`).join(' ');
 const dots=points.map((p,i)=>{const px=x(i),py=y(p.mileage),above=py>82&&(py>h-82||i%2===0),labelY=above?py-21:py+27;return `<g class="mileage-point"><circle cx="${px}" cy="${py}" r="5"/><text class="mileage-point-mileage" x="${px}" y="${labelY}" text-anchor="middle">${miles(p.mileage)} mi</text><text class="mileage-point-date" x="${px}" y="${labelY+11}" text-anchor="middle">${fmtDate(p.date)}</text><title>${fmtDate(p.date)} · ${miles(p.mileage)} miles</title></g>`}).join('');
 return `<div class="mileage-chart-wrap"><div class="mileage-chart-inner" style="--mot-chart-width:${w}px"><svg class="mileage-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Mileage history from ${miles(points[0].mileage)} to ${miles(points.at(-1).mileage)} miles"><polyline points="${coords}"/>${dots}</svg><div class="chart-axis"><span>${fmtDate(points[0].date)}</span><strong>${miles(points.at(-1).mileage)} mi</strong><span>${fmtDate(points.at(-1).date)}</span></div></div></div>`;
}


function mainPhoto(v){return (v.photos||[]).find(p=>p.primary)||(v.photos||[])[0]||null}
function photoThumb(v,cls=''){const p=mainPhoto(v);return p?.dataUrl?`<img class="vehicle-photo ${cls}" src="${p.dataUrl}" alt="${esc(v.make)} ${esc(v.model)}">`:''}
function photoGallery(v){const photos=v.photos||[];const main=mainPhoto(v);const mainIndex=main?photos.indexOf(main):-1;return `<section class="card photo-card gallery-card"><div class="row gallery-head"><div><p class="eyebrow">GALLERY</p><h2 class="section-title">${photos.length?`${photos.length} photo${photos.length===1?'':'s'}`:'Your car'}</h2></div><button class="secondary small-btn" id="add-photo">＋ Add photo</button></div>${photos.length?`<button class="gallery-stage" data-photo-index="${mainIndex}" aria-label="Open main photo"><img src="${main.dataUrl}" alt="${esc(main.caption||`${v.make} ${v.model}`)}"><span class="gallery-count">${mainIndex+1} / ${photos.length}</span>${main.caption?`<span class="gallery-caption">${esc(main.caption)}</span>`:''}</button>${photos.length>1?`<div class="gallery-strip" role="list" aria-label="Vehicle photos">${photos.map((p,i)=>`<button class="gallery-thumb ${p===main?'active':''}" data-photo-index="${i}" role="listitem" aria-label="Open photo ${i+1}"><img src="${p.dataUrl}" alt="${esc(p.caption||`Vehicle photo ${i+1}`)}">${p.primary?'<span>Main</span>':''}</button>`).join('')}</div>`:''}<p class="muted small gallery-help">Tap a photo to open the gallery viewer.</p>`:`<button class="photo-empty gallery-empty" id="add-photo-empty"><span class="empty-icon">${appGlyph('camera')}</span><strong>Build your car gallery</strong><small>Add exterior, interior, condition and service photos. They stay private unless you choose to share them later.</small></button>`}</section>`}
function photoModal(){return `<div class="modal-backdrop"><div class="modal-sheet"><div class="modal-handle"></div><div class="row"><div><p class="eyebrow">VEHICLE PHOTO</p><h2>Add a photo</h2></div><button class="icon-btn" id="close-modal">✕</button></div><form id="photo-form" class="stack"><div class="photo-source-grid"><label class="photo-source"><input id="photo-camera" type="file" accept="image/*" capture="environment"><span class="photo-source-icon">${appGlyph('camera')}</span><strong>Take photo</strong><small>Use your camera</small></label><label class="photo-source"><input id="photo-gallery" type="file" accept="image/*" multiple><span>▣</span><strong>Choose existing</strong><small>Select one or more</small></label></div><p class="muted small" id="photo-selection">Choose how you want to add a photo.</p><div class="field"><label>Caption <span class="optional">Optional</span></label><input name="caption" maxlength="80" placeholder="e.g. Front three-quarter"></div><button class="primary full" type="submit">Save photo</button></form></div></div>`}

async function compressPhoto(file){
 if(!file?.type?.startsWith('image/'))throw new Error('Choose an image file');
 const source=await new Promise((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>resolve(reader.result);
   reader.onerror=()=>reject(new Error('Could not read photo'));
   reader.readAsDataURL(file)
 });
 const image=await new Promise((resolve,reject)=>{
   const img=new Image();
   img.onload=()=>resolve(img);
   img.onerror=()=>reject(new Error('This image format could not be opened'));
   img.src=source
 });
 const max=1100;
 const scale=Math.min(1,max/Math.max(image.width,image.height));
 const canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(image.width*scale));
 canvas.height=Math.max(1,Math.round(image.height*scale));
 const ctx=canvas.getContext('2d');
 if(!ctx)throw new Error('Could not prepare photo');
 ctx.drawImage(image,0,0,canvas.width,canvas.height);
 return canvas.toDataURL('image/jpeg',.72)
}

function photoManageModal(v,index){
 const photos=v.photos||[];if(!photos.length)return '';
 const safe=Math.max(0,Math.min(index,photos.length-1)),current=photos[safe];
 return `<div class="modal-backdrop photo-viewer-backdrop"><div class="modal-sheet photo-viewer-sheet photo-gallery-sheet"><div class="photo-gallery-top"><div><p class="eyebrow">GALLERY</p><h2><span id="gallery-current">${safe+1}</span> of ${photos.length}</h2></div><button class="secondary small-btn" id="close-modal">Close</button></div><div class="photo-gallery-frame"><div class="photo-gallery-track" id="photo-gallery-track" aria-label="Vehicle photo gallery">${photos.map((p,i)=>`<div class="photo-gallery-slide" data-gallery-slide="${i}"><img src="${p.dataUrl}" alt="${esc(p.caption||`Vehicle photo ${i+1}`)}"></div>`).join('')}</div>${photos.length>1?`<button class="photo-nav prev" id="photo-prev" aria-label="Previous photo">‹</button><button class="photo-nav next" id="photo-next" aria-label="Next photo">›</button>`:''}</div><p class="photo-viewer-caption" id="gallery-caption">${esc(current.caption||'')}</p><p class="muted small photo-swipe-hint">${photos.length>1?'Swipe left or right to browse photos.':'Tap Close to return.'}</p><div class="photo-viewer-actions"><button class="secondary" id="make-main-photo" ${current.primary?'disabled':''}>${current.primary?'✓ Main photo':'Set as main'}</button><button class="danger" id="remove-photo">Remove</button></div></div></div>`;
}
function activeDocuments(v){return (v.documents||[]).filter(d=>!d._deleted)}
function inferPaperworkCategory(name=''){
 const s=String(name).toLowerCase();
 if(/mot/.test(s))return 'MOT';
 if(/insur/.test(s))return 'Insurance';
 if(/service|servicing/.test(s))return 'Service';
 if(/repair|garage|workshop/.test(s))return 'Repair';
 if(/receipt|invoice/.test(s))return 'Receipt';
 if(/purchase|sale|order/.test(s))return 'Purchase';
 return 'Other';
}

function fileSize(n){const bytes=Number(n||0);if(bytes<1024)return `${bytes} B`;if(bytes<1024*1024)return `${Math.round(bytes/1024)} KB`;return `${(bytes/1024/1024).toFixed(bytes<10*1024*1024?1:0)} MB`}
function readDocumentFile(file){return new Promise((resolve,reject)=>{if(!file)return reject(new Error('Choose a file'));const type=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase(),supported=type==='application/pdf'||type.startsWith('image/')||/\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(name);if(!supported)return reject(new Error(`${file.name} is not a supported PDF or image`));if(file.size>10*1024*1024)return reject(new Error(`${file.name} is larger than the 10 MB DriveHub file limit`));const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error(`Could not read ${file.name}`));r.readAsDataURL(file)})}
async function preparePaperworkFile(file){
 if(!file)throw new Error('Choose a file');
 const type=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase(),isImage=type.startsWith('image/')||/\.(jpe?g|png|webp|heic|heif)$/i.test(name),isPdf=type==='application/pdf'||/\.pdf$/i.test(name);
 if(!isImage&&!isPdf)throw new Error(`${file.name||'That file'} is not a supported PDF or image`);
 if(isPdf){
  if(file.size>10*1024*1024)throw new Error(`${file.name} is larger than the 10 MB DriveHub file limit`);
  return {name:file.name||'Document.pdf',type:'application/pdf',size:Number(file.size||0),dataUrl:await readDocumentFile(file)}
 }
 let dataUrl,storedType=type||'image/jpeg';
 if(file.size>1100*1024){
  try{dataUrl=await compressDocumentImage(file);storedType='image/jpeg'}catch{dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error(`Could not read ${file.name}`));r.readAsDataURL(file)})}
 }else{
  dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error(`Could not read ${file.name}`));r.readAsDataURL(file)})
 }
 return {name:file.name||'Paperwork image',type:storedType,size:Number(file.size||0),dataUrl}
}
async function compressDocumentImage(file){
 const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read paperwork image'));reader.readAsDataURL(file)});
 const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('This image format could not be opened'));img.src=source});
 const max=1800,scale=Math.min(1,max/Math.max(image.width,image.height));
 const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
 const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Could not prepare paperwork image');ctx.drawImage(image,0,0,canvas.width,canvas.height);
 return canvas.toDataURL('image/jpeg',.82)
}
async function choosePaperworkFiles(v,context={}){
 const input=document.createElement('input');input.type='file';input.accept='application/pdf,image/*,.pdf';input.multiple=true;input.setAttribute('aria-hidden','true');input.style.position='fixed';input.style.left='-9999px';input.style.width='1px';input.style.height='1px';input.style.opacity='0';document.body.appendChild(input);
 let handled=false;
 const cleanup=()=>{try{input.remove()}catch{}};
 const handle=async()=>{
  if(handled)return;handled=true;
  const files=Array.from(input.files||[]);if(!files.length){cleanup();return}
  if(activeDocuments(v).length+files.length>30){cleanup();toast('Document limit is 30 per vehicle');return}
  toast(files.length>1?'Preparing paperwork…':'Preparing paperwork…');
  try{
   const prepared=[];for(const file of files)prepared.push(await preparePaperworkFile(file));
   cleanup();showModal(documentModal(v,prepared,context));bindDocumentModal(v,prepared,context)
  }catch(err){cleanup();toast(err?.message||'Could not read that paperwork')}
 };
 input.addEventListener('change',handle,{once:true});input.addEventListener('input',handle,{once:true});input.addEventListener('cancel',cleanup,{once:true});
 input.click()
}
function timelineEvidenceRef(d){return String(d?.timelineRef||d?.activityId||'')}
function timelineLinkableItems(v){return timeFeedItems(v).filter(a=>a&&a.id&&a.type!=='document').sort((a,b)=>new Date(b.date||0)-new Date(a.date||0))}
function timelineEvidenceTarget(v,d){const ref=timelineEvidenceRef(d);if(!ref)return null;return timeFeedItems(v).find(a=>a.id===ref&&a.type!=='document')||null}
function evidenceCategoryForItem(a){return ({service:'Service',service_due:'Service',maintenance:'Maintenance',repair:'Repair',purchase:'Purchase',insurance:'Insurance',insurance_due:'Insurance',mot:'MOT',mot_test:'MOT',mot_due:'MOT',tax:'Receipt',tax_due:'Receipt'}[a?.type]||'Other')}
function evidenceEligible(a){return !!a&&!['document','photo','mileage','valuation','reminder'].includes(a.type)}
function paperworkCategories(){return ['Service','Repair','Maintenance','Purchase','Insurance','MOT','Receipt','Other']}
function documentModal(v,files=[],context={}){
 const events=timelineLinkableItems(v),selectedTarget=String(context.timelineRef||''),selected=Array.from(files||[]),total=selected.reduce((n,f)=>n+Number(f.size||0),0),suggested=context.category||(selected[0]?inferPaperworkCategory(selected[0].name):'Other');
 const categories=paperworkCategories(),fileTitle=selected.length===1?esc(selected[0].name):`${selected.length} files selected`,defaultDate=String(context.date||new Date().toISOString().slice(0,10)).slice(0,10);
 const contextItem=selectedTarget?events.find(a=>a.id===selectedTarget):null;
 return `<div class="modal-backdrop" id="document-modal"><div class="modal-sheet paperwork-editor-sheet"><div class="modal-handle"></div><div class="row paperwork-editor-head"><div><p class="eyebrow">${contextItem?'ADD PAPERWORK':'PAPERWORK'}</p><h2>${contextItem?'Add paperwork':'Add paperwork'}</h2></div><button class="icon-btn" id="close-modal" aria-label="Close">✕</button></div>${contextItem?`<div class="paperwork-evidence-context"><span>${activityIcon(contextItem.type)}</span><div><small>Paperwork for</small><strong>${esc(contextItem.title||activityLabel(contextItem.type))}</strong><b>${fmtDate(contextItem.date)}${contextItem.mileage!=null?` · ${miles(contextItem.mileage)} miles`:''}</b></div></div>`:''}<form id="document-form" class="stack paperwork-editor-form"><div class="document-drop selected-files"><span>${appGlyph('document')}</span><div><strong>${fileTitle}</strong><small>${fileSize(total)} · ${selected.length===1?'1 file':`${selected.length} files`}</small></div></div><button type="button" class="text-btn" id="change-document-files">Choose different files</button><div class="form-grid two"><div class="field"><label>Category</label><select name="category">${categories.map(c=>`<option ${c===suggested?'selected':''}>${c}</option>`).join('')}</select></div><div class="field"><label>Date</label><input name="date" type="date" value="${esc(defaultDate)}"></div></div><div class="field"><label>Note <span class="optional">Optional</span></label><textarea name="note" maxlength="500" placeholder="What does this document prove or record?"></textarea><small class="field-help">Keep useful context with the paperwork, not just the filename.</small></div><div class="field"><label>Attach paperwork to <span class="optional">Optional</span></label><select name="timelineRef"><option value="">Keep as unlinked paperwork</option>${events.map(a=>`<option value="${esc(a.id)}" ${a.id===selectedTarget?'selected':''}>${esc(fmtDate(a.date))} · ${esc(a.title||activityLabel(a.type))}</option>`).join('')}</select></div><button class="primary full" type="submit">${contextItem?'Attach paperwork':'Add paperwork'}</button></form></div></div>`
}
function documentEditModal(v,d){
 const events=timelineLinkableItems(v),categories=paperworkCategories(),selectedTarget=timelineEvidenceRef(d),target=selectedTarget?events.find(a=>a.id===selectedTarget):null;
 return `<div class="modal-backdrop" id="document-edit-modal"><div class="modal-sheet paperwork-editor-sheet"><div class="modal-handle"></div><div class="row paperwork-editor-head"><div><p class="eyebrow">PAPERWORK</p><h2>Edit paperwork</h2></div><button class="icon-btn" id="close-modal" aria-label="Close">✕</button></div>${target?`<div class="paperwork-evidence-context compact"><span>${activityIcon(target.type)}</span><div><small>Paperwork for</small><strong>${esc(target.title||activityLabel(target.type))}</strong><b>${fmtDate(target.date)}</b></div></div>`:''}<form id="document-edit-form" class="stack paperwork-editor-form"><div class="paperwork-edit-summary">${documentThumbMarkup(d,'paperwork-edit-thumb')}<div><strong>${esc(d.name)}</strong><small>${fileSize(d.size)} · ${String(d.type||'').includes('pdf')?'PDF':'Image'}</small></div></div><div class="field"><label>Document name</label><input name="name" value="${esc(d.name)}" maxlength="160" required></div><div class="form-grid two"><div class="field"><label>Category</label><select name="category">${categories.map(c=>`<option ${c===(d.category||'Other')?'selected':''}>${c}</option>`).join('')}</select></div><div class="field"><label>Date</label><input name="date" type="date" value="${esc(d.date||String(d.createdAt||'').slice(0,10))}"></div></div><div class="field"><label>Note <span class="optional">Optional</span></label><textarea name="note" maxlength="500" placeholder="What does this document prove or record?">${esc(d.note||'')}</textarea></div><div class="field"><label>Attach paperwork to <span class="optional">Optional</span></label><select name="timelineRef"><option value="">Keep as unlinked paperwork</option>${events.map(a=>`<option value="${esc(a.id)}" ${a.id===selectedTarget?'selected':''}>${esc(fmtDate(a.date))} · ${esc(a.title||activityLabel(a.type))}</option>`).join('')}</select></div><button class="primary full" type="submit">Save changes</button></form></div></div>`
}
function documentThumbMarkup(d,extraClass=''){
 const type=String(d?.type||'').toLowerCase(),data=d?.dataUrl||'';
 const classes=['organic-doc-thumb','paperwork-thumb',extraClass].filter(Boolean).join(' ');
 if(type.startsWith('image/')&&data)return `<span class="${classes} image"><img src="${data}" alt="" loading="lazy"></span>`;
 if(type.includes('pdf')&&data)return `<span class="${classes} pdf"><object data="${data}#toolbar=0&navpanes=0&scrollbar=0&view=FitH" type="application/pdf" tabindex="-1" aria-hidden="true"></object><span class="paperwork-pdf-badge">PDF</span></span>`;
 return `<span class="${classes}">${appGlyph('document')}</span>`
}
function documentRow(d,v){
 const kind=String(d.type||'').includes('pdf')?'PDF':'Image',note=String(d.note||'').trim(),target=timelineEvidenceTarget(v,d),context=target?`${fmtDate(target.date)} · ${target.title||activityLabel(target.type)}`:'';
 return `<article class="organic-document-row organic-document-openable" data-document-id="${d.id}" data-preview-document="${d.id}" data-document-search="${esc(`${d.name} ${d.category} ${kind} ${note} ${context}`.toLowerCase())}" data-document-category="${esc((d.category||'Other').toLowerCase())}" role="button" tabindex="0" aria-label="Open ${esc(d.name)}">
  <span class="organic-doc-main">${documentThumbMarkup(d)}<span><strong>${esc(d.name)}</strong><small>${kind}${d.date?` · ${fmtDate(d.date)}`:''}</small>${target?`<span class="paperwork-linked-context">Paperwork for · ${esc(context)}</span>`:'<span class="paperwork-unlinked-context">Unlinked paperwork</span>'}${note?`<span class="paperwork-note-preview">${esc(note)}</span>`:''}</span><b>›</b></span>
  <div class="organic-document-row-actions"><button type="button" class="paperwork-edit-action" data-edit-document="${d.id}" aria-label="Edit ${esc(d.name)}">Edit</button><button type="button" class="paperwork-delete-action" data-delete-document="${d.id}" aria-label="Delete ${esc(d.name)}" title="Delete paperwork">${appGlyph('trash')}</button></div>
 </article>`
}
function documentPreviewModal(d,v){const isImage=String(d.type||'').startsWith('image/');const isPdf=String(d.type||'').includes('pdf'),note=String(d.note||'').trim(),target=timelineEvidenceTarget(v,d);return `<div class="modal-backdrop"><div class="modal-sheet document-viewer-sheet"><div class="row"><div><p class="eyebrow">${esc(d.category||'DOCUMENT')}</p><h2>${esc(d.name)}</h2><p class="muted small">${fmtDate(d.date||d.createdAt)} · ${fileSize(d.size)}</p></div><button class="secondary small-btn" id="close-modal">Done</button></div>${target?`<button type="button" class="paperwork-viewer-context" data-open-evidence-event="${esc(target.id)}"><span>${activityIcon(target.type)}</span><div><small>Paperwork for</small><strong>${esc(target.title||activityLabel(target.type))}</strong><b>${fmtDate(target.date)}${target.mileage!=null?` · ${miles(target.mileage)} miles`:''}</b></div><i>›</i></button>`:''}${note?`<div class="paperwork-note-card"><strong>Note</strong><p>${esc(note)}</p></div>`:''}${isImage?`<div class="document-preview-image"><img src="${d.dataUrl}" alt="${esc(d.name)}"></div>`:isPdf?`<div class="document-pdf-preview"><object data="${d.dataUrl}" type="application/pdf"><p>PDF preview is not available in this browser.</p></object></div>`:'<div class="card compact-empty"><p>Preview is not available for this file type.</p></div>'}<div class="actions"><button class="primary" id="document-open-external">Open full document</button><button class="secondary" id="document-save-file">Save copy</button></div></div></div>`}

function documentsTab(v){
 const docs=activeDocuments(v).slice().sort((a,b)=>new Date(b.date||b.createdAt)-new Date(a.date||a.createdAt)),attached=docs.filter(d=>timelineEvidenceTarget(v,d)),unlinked=docs.filter(d=>!timelineEvidenceTarget(v,d));
 return `<section class="organic-paperwork"><div class="paperwork-library-intro"><div><p class="organic-kicker">PAPERWORK</p><h2>${docs.length?`${docs.length} saved item${docs.length===1?'':'s'}`:'Keep paperwork with the history'}</h2><p>Invoices, receipts, policies and other documents are most useful when attached to the Timeline event they support.</p></div><div class="paperwork-library-stats"><span><strong>${attached.length}</strong> attached</span><span><strong>${unlinked.length}</strong> unlinked</span></div></div>${attached.length?`<div class="paperwork-group"><div class="organic-essential-subhead"><span>Attached to Timeline</span><b>${attached.length}</b></div><div class="organic-paperwork-list">${attached.map(d=>documentRow(d,v)).join('')}</div></div>`:''}${unlinked.length?`<div class="paperwork-group unlinked"><div class="organic-essential-subhead"><span>Unlinked paperwork</span><b>${unlinked.length}</b></div><p class="paperwork-group-help">Edit an item to attach it to a service, repair, MOT, purchase or other Timeline event.</p><div class="organic-paperwork-list">${unlinked.map(d=>documentRow(d,v)).join('')}</div></div>`:''}<button class="organic-add-paperwork" id="add-paperwork">${appGlyph('document')}<strong>Add paperwork</strong><span>Add a file now, then attach it to the history it supports.</span></button></section>`
}
function sellerSummary(v,opts={}){const includeReg=opts.reg!==false,includeSpecification=opts.specification!==false,includeKeyDates=opts.keyDates!==false,includeMot=opts.mot!==false,includeHistory=opts.history!==false,includeCosts=!!opts.costs;const services=activeActivity(v).filter(a=>a.type==='service').sort((a,b)=>new Date(b.date)-new Date(a.date));const maintenance=activeActivity(v).filter(a=>['maintenance','repair'].includes(a.type)).sort((a,b)=>new Date(b.date)-new Date(a.date));const customSpecs=(v.specification||[]).filter(s=>s&&!s._deleted).map(s=>[s.label,s.value].filter(Boolean).join(s.label&&s.value?' — ':'').trim()).filter(Boolean);const parts=[`${v.year||''} ${v.make||''} ${v.model||''}${v.derivative?` ${v.derivative}`:''}`.trim(),v.mileage!=null?`${miles(v.mileage)} miles`:null];if(includeReg&&v.registration)parts.push(`Registration: ${v.registration}`);if(includeSpecification){const basics=[v.colour,v.bodyType,v.engineSize,v.fuelType,v.transmission].filter(Boolean);if(basics.length)parts.push(`Specification: ${basics.join(' · ')}`);customSpecs.slice(0,8).forEach(s=>parts.push(`• ${s}`))}if(includeKeyDates){if(v.ownership?.purchaseDate)parts.push(`Purchased: ${fmtDate(v.ownership.purchaseDate)}${v.ownership?.purchasePrice?` · ${money(v.ownership.purchasePrice)}`:''}`);parts.push(`MOT due: ${v.mot?.expiryDate?fmtDate(v.mot.expiryDate):'Not recorded'}`);parts.push(`Tax: ${v.tax?.expiryDate?fmtDate(v.tax.expiryDate):(v.tax?.status||'Not recorded')}`);parts.push(`Service due: ${v.service?.nextServiceDate?fmtDate(v.service.nextServiceDate):'Not set'}`);parts.push(`Insurance renewal: ${v.insurance?.renewalDate?fmtDate(v.insurance.renewalDate):'Not set'}`)}if(includeMot){const motTests=(v.mot?.history||[]).length;parts.push(`MOT history: ${motTests} test${motTests===1?'':'s'} recorded${ownershipIntelligence(v).currentConcerns.length?` · ${ownershipIntelligence(v).currentConcerns.length} latest item(s) to be aware of`:''}`)}if(includeHistory){parts.push(`Service history: ${services.length} record${services.length===1?'':'s'}`);services.slice(0,3).forEach(a=>parts.push(`• ${fmtDate(a.date)}${a.mileage?` · ${miles(a.mileage)} mi`:''} — ${a.title}${a.serviceType?` · ${serviceTypeLabel(a.serviceType)}`:''}${a.garageName?` · ${a.garageName}`:''}`));if(maintenance.length){parts.push('Recent maintenance:');maintenance.slice(0,3).forEach(a=>parts.push(`• ${fmtDate(a.date)} — ${a.title}`))}}if(includeCosts){const c=ownershipCosts(v);parts.push(`Tracked maintenance/ownership spend: ${money(c.total)}`)}return parts.filter(Boolean).join('\n')}
function shareDossierModal(v){return `<div class="modal-backdrop"><div class="modal-sheet share-sheet"><div class="modal-handle"></div><div class="row share-sheet-head"><div><p class="eyebrow">SHARE VEHICLE</p><h2>Share my car</h2></div><button class="icon-btn" id="close-modal" aria-label="Close">✕</button></div><p class="muted small share-sheet-intro">Choose what the other person can see. VIN and private notes are always kept out.</p><section class="share-control-section"><div class="share-control-title"><strong>What to include</strong><span>Turn off anything you would rather keep private.</span></div><div class="share-options"><label class="share-option"><input type="checkbox" data-share-opt="reg" checked><span>Registration</span></label><label class="share-option"><input type="checkbox" data-share-opt="specification" checked><span>Specification</span></label><label class="share-option"><input type="checkbox" data-share-opt="keyDates" checked><span>Ownership & key dates</span></label><label class="share-option"><input type="checkbox" data-share-opt="mot" checked><span>MOT history</span></label><label class="share-option"><input type="checkbox" data-share-opt="history" checked><span>Timeline & maintenance</span></label><label class="share-option"><input type="checkbox" data-share-opt="photos" checked><span>Photos</span></label><label class="share-option"><input type="checkbox" data-share-opt="documents" checked><span>Document index</span></label><label class="share-option"><input type="checkbox" data-share-opt="costs"><span>Tracked costs</span></label></div></section><section class="share-format-section"><div class="share-control-title"><strong>Share as</strong><span>Image is easiest for messages; page keeps the most detail.</span></div><div class="share-format-primary"><button type="button" class="primary share-format-button" id="share-image"><span>IMG</span><div><strong>Share as image</strong><small>One visual summary</small></div></button><button type="button" class="secondary share-format-button" id="share-html"><span>HTML</span><div><strong>Share page</strong><small>Full interactive profile</small></div></button></div></section><details class="share-more-options"><summary>Preview, save or copy instead</summary><div class="share-more-grid"><button class="secondary" id="preview-image">Preview image</button><button class="secondary" id="save-image">Save image</button><button class="secondary" id="preview-html">Preview page</button><button class="secondary" id="save-html">Save page</button><button class="text-btn full share-copy-action" id="copy-summary">Copy text summary</button></div></details></div></div>`}

function shareHtmlDocument(v,opts={}){const includeReg=opts.reg!==false,includeSpecification=opts.specification!==false,includeKeyDates=opts.keyDates!==false,includeMot=opts.mot!==false,includeHistory=opts.history!==false,includeValuation=opts.valuation===true,includePhotos=opts.photos!==false,includeDocuments=opts.documents!==false,includeCosts=!!opts.costs;const activity=activeActivity(v).filter(a=>!['note'].includes(a.type)).sort((a,b)=>new Date(b.date)-new Date(a.date));const services=activity.filter(a=>a.type==='service');const maintenance=activity.filter(a=>['maintenance','repair','modification'].includes(a.type));const motTests=[...(v.mot?.history||[])].sort((a,b)=>new Date(b.completedDate||b.testDate||b.date||0)-new Date(a.completedDate||a.testDate||a.date||0));const intel=ownershipIntelligence(v);const costs=ownershipCosts(v);const photos=includePhotos?(v.photos||[]):[];const docs=includeDocuments?activeDocuments(v).slice().sort((a,b)=>new Date(b.date||b.createdAt)-new Date(a.date||a.createdAt)):[];const customSpecs=(v.specification||[]).filter(s=>s&&!s._deleted).map(s=>[s.label,s.value].filter(Boolean).join(s.label&&s.value?' — ':'').trim()).filter(Boolean);const val=v.valuation||{};const title=[v.year,v.make,v.model,v.derivative].filter(Boolean).join(' ');const safe=x=>esc(x??'');const date=x=>fmtDate(x);const row=(k,value)=>value&&value!=='—'?`<div class="spec"><span>${safe(k)}</span><strong>${safe(value)}</strong></div>`:'';const defectList=t=>{const defects=t.defects||t.rfrAndComments||[];return defects.length?`<ul>${defects.map(d=>`<li><span class="severity">${safe(d.type||d.severity||'Advisory')}</span>${safe(d.text||d.comment||d.description||d)}</li>`).join('')}</ul>`:''};const timeline=activity.slice(0,30).map(a=>`<article class="event"><time>${date(a.date)}</time><div><strong>${safe(a.title||activityLabel(a.type))}</strong><p>${[a.type==='service'&&a.serviceType?serviceTypeLabel(a.serviceType):null,a.type==='service'&&a.garageName?a.garageName:null,a.mileage?`${miles(a.mileage)} miles`:null,a.cost!=null?money(a.cost):null,a.body].filter(Boolean).map(safe).join(' · ')}</p></div></article>`).join('');const photoHtml=photos.length?`<section><div class="section-head"><p>GALLERY</p><h2>${photos.length} vehicle photo${photos.length===1?'':'s'}</h2></div><div class="gallery">${photos.map((p,i)=>`<figure class="${i===0?'wide':''}"><img src="${p.dataUrl}" alt="${safe(p.caption||`Vehicle photo ${i+1}`)}">${p.caption?`<figcaption>${safe(p.caption)}</figcaption>`:''}</figure>`).join('')}</div></section>`:'';return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)} · Vehicle profile</title><style>
:root{
  --bg:#e9f0ee;
  --card:#f7fbf9;
  --surface:#e5eeeb;
  --ink:#14292b;
  --muted:#5c787e;
  --line:rgba(20,49,58,.14);
  --navy:#14313a;
  --green:#1f7754;
  --green-soft:#c9e9d5;
  --blue:#1f6f9c;
  --blue-soft:#cbe4f2;
  --yellow:#b98a12;
  --yellow-soft:#fbe9ae;
  --good:#1f7754;
  --bad:#9f3a2d;
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{
  margin:0;
  background:var(--bg);
  color:var(--ink);
  font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  line-height:1.5;
  -webkit-font-smoothing:antialiased
}
.page{
  width:min(100% - 28px,900px);
  margin:24px auto 48px;
  min-height:calc(100vh - 72px)
}
.hero{
  padding:28px;
  border-radius:32px;
  background:var(--navy);
  color:#f7fbf9
}
.hero .reg{
  display:inline-flex;
  align-items:center;
  min-height:30px;
  padding:6px 12px;
  border-radius:999px;
  background:#f7fbf9;
  color:var(--navy);
  font-size:12px;
  font-weight:800;
  letter-spacing:.09em;
  text-transform:uppercase
}
.hero h1,
.section-head h2,
.value strong,
.status-card strong{
  font-family:Georgia,"Times New Roman",serif;
  font-weight:700
}
.hero h1{
  max-width:760px;
  margin:18px 0 8px;
  font-size:clamp(34px,7vw,60px);
  line-height:.98;
  letter-spacing:-.035em
}
.hero>p{
  margin:0;
  color:#a6bab7;
  font-size:15px
}
.hero-stats{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:8px;
  margin-top:24px
}
.hero-stats.single{
  grid-template-columns:minmax(0,1fr)
}
.hero-stat{
  min-width:0;
  padding:15px;
  border-radius:20px;
  background:rgba(247,251,249,.09)
}
.hero-stat span{
  display:block;
  color:#a6bab7;
  font-size:10px;
  font-weight:800;
  letter-spacing:.1em;
  text-transform:uppercase
}
.hero-stat strong{
  display:block;
  margin-top:5px;
  overflow-wrap:anywhere;
  color:#fff;
  font-size:18px
}
.content{
  padding:16px 0 0
}
section{
  margin:0 0 14px;
  padding:22px;
  border-radius:28px;
  background:var(--card)
}
.section-head p{
  margin:0 0 5px;
  color:var(--green);
  font-size:10px;
  font-weight:800;
  letter-spacing:.14em;
  text-transform:uppercase
}
.section-head h2{
  margin:0 0 18px;
  font-size:26px;
  line-height:1.05;
  letter-spacing:-.025em
}
.spec-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:0 22px
}
.spec{
  min-width:0;
  padding:12px 0;
  display:flex;
  align-items:baseline;
  justify-content:space-between;
  gap:14px;
  border-top:1px solid var(--line)
}
.spec span{
  color:var(--muted);
  font-size:13px
}
.spec strong{
  min-width:0;
  overflow-wrap:anywhere;
  text-align:right;
  font-size:14px
}
.custom-spec-list{
  margin-top:16px;
  display:flex;
  flex-wrap:wrap;
  gap:8px
}
.custom-spec{
  padding:8px 11px;
  border-radius:999px;
  background:var(--surface);
  color:var(--navy);
  font-size:12px;
  font-weight:700
}
.value-grid{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:8px
}
.value{
  padding:16px;
  border-radius:20px;
  background:var(--surface)
}
.value:nth-child(2){
  background:var(--green-soft)
}
.value span{
  display:block;
  color:var(--muted);
  font-size:11px
}
.value strong{
  display:block;
  margin-top:4px;
  color:var(--navy);
  font-size:23px;
  letter-spacing:-.02em
}
.gallery{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:9px
}
.gallery figure{
  min-width:0;
  margin:0
}
.gallery figure.wide{
  grid-column:1/-1
}
.gallery img{
  display:block;
  width:100%;
  aspect-ratio:4/3;
  object-fit:cover;
  border-radius:22px;
  background:var(--surface)
}
.gallery .wide img{
  aspect-ratio:16/9
}
.gallery figcaption{
  padding:6px 4px 0;
  color:var(--muted);
  font-size:12px
}
.status{
  display:grid;
  grid-template-columns:repeat(5,minmax(0,1fr));
  gap:8px
}
.status-card{
  min-width:0;
  padding:16px;
  border-radius:20px;
  background:var(--surface)
}
.status-card:nth-child(2){
  background:var(--blue-soft)
}
.status-card span{
  display:block;
  color:var(--muted);
  font-size:11px
}
.status-card strong{
  display:block;
  margin-top:4px;
  overflow-wrap:anywhere;
  color:var(--navy);
  font-size:18px
}
.status-card small{
  display:block;
  margin-top:5px;
  color:var(--muted)
}
.mot-test{
  padding:15px 0;
  border-top:1px solid var(--line)
}
.mot-test:first-of-type{
  border-top:0
}
.mot-head{
  display:flex;
  align-items:baseline;
  justify-content:space-between;
  gap:16px
}
.mot-head>div{
  min-width:0
}
.pass{color:var(--good)}
.fail{color:var(--bad)}
ul{
  margin:10px 0 0;
  padding-left:19px
}
li{
  margin:6px 0;
  color:var(--muted)
}
.severity{
  display:inline-flex;
  margin-right:7px;
  padding:3px 7px;
  border-radius:999px;
  background:var(--yellow-soft);
  color:#644c0b;
  font-size:9px;
  font-weight:800;
  letter-spacing:.06em;
  text-transform:uppercase
}
.event{
  position:relative;
  display:grid;
  grid-template-columns:106px minmax(0,1fr);
  gap:14px;
  padding:14px 0 14px 20px;
  border-top:1px solid var(--line)
}
.event::before{
  content:"";
  position:absolute;
  left:0;
  top:19px;
  width:9px;
  height:9px;
  border-radius:50%;
  background:var(--blue)
}
.event time{
  color:var(--muted);
  font-size:12px
}
.event strong{
  font-size:14px
}
.event p{
  margin:3px 0 0;
  color:var(--muted);
  font-size:13px
}
.note{
  margin-top:14px;
  padding:15px 17px;
  border-radius:20px;
  background:var(--blue-soft);
  color:#17587d
}
.footer{
  margin-top:4px;
  padding:18px 4px 0;
  border-top:1px solid var(--line);
  color:var(--muted);
  font-size:11px
}
a{color:var(--blue)}
@media(max-width:650px){
  .page{
    width:min(100% - 20px,900px);
    margin:10px auto 32px
  }
  .hero{
    padding:22px;
    border-radius:26px
  }
  .hero-stats,
  .value-grid,
  .status{
    grid-template-columns:1fr
  }
  section{
    padding:18px;
    border-radius:24px
  }
  .spec-grid{
    grid-template-columns:1fr
  }
  .gallery{
    grid-template-columns:1fr
  }
  .gallery figure.wide{
    grid-column:auto
  }
  .event{
    grid-template-columns:1fr;
    gap:2px
  }
}
@media print{
  body{background:#fff}
  .page{
    width:100%;
    margin:0
  }
  .hero,
  section{
    break-inside:avoid
  }
}
</style></head><body><main class="page"><header class="hero">${includeReg?`<span class="reg">${safe(v.registration)}</span>`:''}<h1>${safe(title)}</h1><p>${includeSpecification?[v.colour,v.bodyType,v.transmission,v.fuelType].filter(Boolean).map(safe).join(' · '):''}</p><div class="hero-stats ${includeKeyDates?'':'single'}"><div class="hero-stat"><span>Mileage</span><strong>${miles(v.mileage)} mi</strong></div>${includeKeyDates?`<div class="hero-stat"><span>MOT</span><strong>${v.mot?.expiryDate?date(v.mot.expiryDate):safe(v.mot?.status||'Not recorded')}</strong></div><div class="hero-stat"><span>Service</span><strong>${v.service?.nextServiceDate?date(v.service.nextServiceDate):'No date set'}</strong></div>`:''}</div></header><div class="content">${photoHtml}${includeSpecification?`<section><div class="section-head"><p>VEHICLE</p><h2>Specification</h2></div><div class="spec-grid">${row('Make',v.make)}${row('Model',v.model)}${row('Derivative',v.derivative)}${row('Year',v.year)}${row('Colour',v.colour)}${row('Body type',v.bodyType)}${row('Engine',v.engineSize)}${row('Fuel',v.fuelType)}${row('Transmission',v.transmission)}${row('Current mileage',`${miles(v.mileage)} miles`)}</div>${customSpecs.length?`<div class="custom-spec-list">${customSpecs.map(text=>`<div class="custom-spec">${safe(text)}</div>`).join('')}</div>`:''}</section>`:''}${includeValuation&&val.privateSale?`<section><div class="section-head"><p>MARKET ESTIMATE</p><h2>Current valuation</h2></div><div class="value-grid"><div class="value"><span>Trade / PX</span><strong>${money(val.trade)}</strong></div><div class="value"><span>Private sale</span><strong>${money(val.privateSale)}</strong></div><div class="value"><span>Dealer forecourt</span><strong>${money(val.retail)}</strong></div></div><p class="note">Estimate updated ${date(val.updatedAt)}${val.sourceLabel?` · ${safe(val.sourceLabel)}`:''}${val.comparableCount?` · based on ${safe(val.comparableCount)} comparable listings`:''}. Asking-price estimates are a guide, not a guaranteed sale price.</p></section>`:''}${includeKeyDates?`<section><div class="section-head"><p>OWNERSHIP</p><h2>Ownership & key dates</h2></div><div class="status"><div class="status-card"><span>Purchased</span><strong>${v.ownership?.purchaseDate?date(v.ownership.purchaseDate):'Not recorded'}</strong>${v.ownership?.purchasePrice?`<small>${money(v.ownership.purchasePrice)}</small>`:''}</div><div class="status-card"><span>MOT</span><strong>${v.mot?.expiryDate?date(v.mot.expiryDate):'Not recorded'}</strong></div><div class="status-card"><span>Tax</span><strong>${v.tax?.expiryDate?date(v.tax.expiryDate):safe(v.tax?.status||'Unknown')}</strong>${v.tax?.expiryDate&&v.tax?.status?`<small>${safe(v.tax.status)}</small>`:''}</div><div class="status-card"><span>Next service</span><strong>${v.service?.nextServiceDate?date(v.service.nextServiceDate):'Not set'}</strong>${v.service?.nextServiceMileage?`<small>${miles(v.service.nextServiceMileage)} miles</small>`:''}</div><div class="status-card"><span>Insurance</span><strong>${v.insurance?.renewalDate?date(v.insurance.renewalDate):'Not set'}</strong>${v.insurance?.premium?`<small>${money(v.insurance.premium)} premium</small>`:''}</div></div></section>`:''}${includeMot?`<section><div class="section-head"><p>MOT</p><h2>MOT history</h2></div>${motTests.length?motTests.map(t=>{const result=String(t.testResult||t.result||t.status||'').toUpperCase();const isPass=result.includes('PASS');return `<article class="mot-test"><div class="mot-head"><div><strong class="${isPass?'pass':'fail'}">${safe(result||'MOT test')}</strong><div>${date(t.completedDate||t.testDate||t.date)}</div></div><strong>${t.odometerValue||t.mileage?`${miles(t.odometerValue||t.mileage)} mi`:''}</strong></div>${defectList(t)}</article>`}).join(''):'<p>No MOT test history recorded.</p>'}${intel.currentConcerns?.length?`<p class="note">Latest record contains ${intel.currentConcerns.length} item${intel.currentConcerns.length===1?'':'s'} to be aware of.</p>`:''}</section>`:''}${includeHistory?`<section><div class="section-head"><p>OWNERSHIP RECORD</p><h2>Timeline & maintenance</h2></div>${timeline||'<p>No service or maintenance records have been added.</p>'}</section>`:''}${includeDocuments&&docs.length?`<section><div class="section-head"><p>PAPERWORK</p><h2>${docs.length} saved document${docs.length===1?'':'s'}</h2></div><div class="spec-grid">${docs.map(d=>row(d.category||'Document',`${fmtDate(d.date||d.createdAt)} · ${d.name}`)).join('')}</div><p class="note">This profile lists the paperwork saved in DriveHub but does not embed private document files.</p></section>`:''}${includeCosts?`<section><div class="section-head"><p>TRACKED COSTS</p><h2>${money(costs.total)}</h2></div><p>Recorded service, maintenance, repairs and ownership expenses in this app.</p></section>`:''}<div class="footer">Shared from DriveHub · Generated ${new Intl.DateTimeFormat('en-GB',{dateStyle:'long'}).format(new Date())}. VIN and private notes are intentionally excluded.</div></div></main></body></html>`}
function shareHtmlFile(v,opts){const html=shareHtmlDocument(v,opts);const filename=`${[v.year,v.make,v.model,v.registration].filter(Boolean).join('-').replace(/[^a-z0-9-]+/gi,'-').replace(/-+/g,'-')||'vehicle'}-profile.html`;return new File([html],filename,{type:'text/html'})}
function saveHtmlFile(v,opts){const file=shareHtmlFile(v,opts);const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download=file.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
function shareFileStem(v){return ([v.year,v.make,v.model,v.registration].filter(Boolean).join('-').replace(/[^a-z0-9-]+/gi,'-').replace(/-+/g,'-')||'vehicle').toLowerCase()}
function saveBlobFile(file){const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download=file.name||'drivehub-export';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1800)}
function shareCanvasRoundRect(ctx,x,y,w,h,r=24){const radius=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+radius,y);ctx.arcTo(x+w,y,x+w,y+h,radius);ctx.arcTo(x+w,y+h,x,y+h,radius);ctx.arcTo(x,y+h,x,y,radius);ctx.arcTo(x,y,x+w,y,radius);ctx.closePath()}
function shareCanvasLines(ctx,value,maxWidth,maxLines=3){const words=String(value||'').trim().split(/\s+/).filter(Boolean),lines=[];let line='';for(const word of words){const next=line?`${line} ${word}`:word;if(ctx.measureText(next).width>maxWidth&&line){lines.push(line);line=word;if(lines.length>=maxLines-1)break}else line=next}if(line&&lines.length<maxLines)lines.push(line);if(words.length&&lines.length===maxLines){let last=lines.at(-1);while(last&&ctx.measureText(last+'…').width>maxWidth)last=last.slice(0,-1);lines[lines.length-1]=last+(last!==line?'…':'')}return lines}
function loadShareCanvasImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Could not load vehicle photo'));img.src=src})}
async function shareImageFile(v,opts={}){const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image sharing is not available on this device');canvas.width=1200;canvas.height=2800;const W=canvas.width,pad=54,inner=W-pad*2;ctx.fillStyle='#e9f0ee';ctx.fillRect(0,0,W,canvas.height);const title=[v.year,v.make,v.model,v.derivative].filter(Boolean).join(' ')||'Vehicle profile';let y=pad;shareCanvasRoundRect(ctx,pad,y,inner,330,34);ctx.fillStyle='#14313a';ctx.fill();if(opts.reg!==false&&v.registration){shareCanvasRoundRect(ctx,pad+30,y+28,160,42,21);ctx.fillStyle='#f7fbf9';ctx.fill();ctx.fillStyle='#14313a';ctx.font='800 20px system-ui';ctx.textAlign='center';ctx.fillText(String(v.registration).toUpperCase(),pad+110,y+56);ctx.textAlign='left'}ctx.fillStyle='#f7fbf9';ctx.font='700 48px Georgia, serif';shareCanvasLines(ctx,title,inner-60,2).forEach((line,i)=>ctx.fillText(line,pad+30,y+118+i*54));ctx.fillStyle='#b8cac7';ctx.font='600 20px system-ui';const sub=[opts.specification!==false?v.colour:null,opts.specification!==false?v.bodyType:null,opts.specification!==false?v.transmission:null].filter(Boolean).join(' · ');ctx.fillText(sub||'Vehicle details shared from DriveHub',pad+30,y+225);const stats=[["Mileage",v.mileage!=null?`${miles(v.mileage)} mi`:'Not set'],['MOT',v.mot?.expiryDate?fmtDate(v.mot.expiryDate):v.mot?.status||'Not set'],['Service',v.service?.nextServiceDate?fmtDate(v.service.nextServiceDate):'Not set']];const sw=(inner-80)/3;stats.forEach(([label,value],i)=>{const x=pad+30+i*(sw+10);shareCanvasRoundRect(ctx,x,y+256,sw,54,16);ctx.fillStyle='rgba(247,251,249,.10)';ctx.fill();ctx.fillStyle='#9fb8b4';ctx.font='800 11px system-ui';ctx.fillText(label.toUpperCase(),x+12,y+276);ctx.fillStyle='#ffffff';ctx.font='700 16px system-ui';ctx.fillText(String(value),x+12,y+298)});y+=352;const photo=opts.photos!==false?(v.photos||[]).find(p=>p&&p.dataUrl):null;if(photo){try{const img=await loadShareCanvasImage(photo.dataUrl);const boxH=390;shareCanvasRoundRect(ctx,pad,y,inner,boxH,30);ctx.save();ctx.clip();const scale=Math.max(inner/img.width,boxH/img.height),dw=img.width*scale,dh=img.height*scale;ctx.drawImage(img,pad+(inner-dw)/2,y+(boxH-dh)/2,dw,dh);ctx.restore();y+=boxH+22}catch{}}
 const card=(heading,rows)=>{rows=rows.filter(([,value])=>value!==null&&value!==undefined&&value!==''&&value!=='—');if(!rows.length)return;const h=58+rows.length*48;shareCanvasRoundRect(ctx,pad,y,inner,h,26);ctx.fillStyle='#f7fbf9';ctx.fill();ctx.fillStyle='#1f7754';ctx.font='800 13px system-ui';ctx.fillText(heading.toUpperCase(),pad+24,y+30);let yy=y+58;rows.forEach(([label,value])=>{ctx.fillStyle='#5c787e';ctx.font='600 17px system-ui';ctx.fillText(String(label),pad+24,yy);ctx.fillStyle='#14313a';ctx.font='700 17px system-ui';ctx.textAlign='right';const text=String(value);const clipped=ctx.measureText(text).width>570?text.slice(0,46)+'…':text;ctx.fillText(clipped,pad+inner-24,yy);ctx.textAlign='left';yy+=48});y+=h+18};
 if(opts.specification!==false)card('Specification',[['Registration',opts.reg!==false?v.registration:''],['Mileage',v.mileage!=null?`${miles(v.mileage)} miles`:''],['Colour',v.colour],['Engine',v.engineSize],['Fuel',v.fuelType],['Transmission',v.transmission]]);
 if(opts.keyDates!==false)card('Key dates',[['MOT',v.mot?.expiryDate?fmtDate(v.mot.expiryDate):'Not recorded'],['Tax',v.tax?.expiryDate?fmtDate(v.tax.expiryDate):v.tax?.status||'Not recorded'],['Service',v.service?.nextServiceDate?fmtDate(v.service.nextServiceDate):'Not set'],['Insurance',v.insurance?.renewalDate?fmtDate(v.insurance.renewalDate):'Not set']]);
 if(opts.valuation===true&&v.valuation?.privateSale)card('Valuation',[['Private sale',money(v.valuation.privateSale)],['Dealer retail',money(v.valuation.retail)],['Trade / PX',money(v.valuation.trade)]]);
 if(opts.mot!==false){const intel=ownershipIntelligence(v),score=motHistoryScore(v);card('MOT history',[['MOT score',`${score.score}/100`],['Tests',`${(intel.tests||[]).length}`],['Current advisories',`${(intel.latestDefects||[]).filter(d=>['advisory','minor'].includes(d.severity)).length}`]])}
 if(opts.history!==false){const recent=activeActivity(v).filter(a=>!a._deleted).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,4);card('Recent Timeline',recent.map(a=>[fmtDate(a.date),a.title||activityLabel(a.type)]))}
 if(opts.documents!==false){const count=activeDocuments(v).length;if(count)card('Paperwork',[['Saved paperwork',`${count} document${count===1?'':'s'}`]])}
 if(opts.costs){const total=ownershipCosts(v).total;if(total)card('Tracked costs',[['Recorded spend',money(total)]])}
 const finalHeight=Math.max(1200,Math.min(canvas.height,Math.ceil(y+105))),footerY=finalHeight-48;ctx.fillStyle='#5c787e';ctx.font='600 15px system-ui';ctx.fillText('Shared from DriveHub',pad,footerY);ctx.textAlign='right';ctx.fillText(new Intl.DateTimeFormat('en-GB',{dateStyle:'medium'}).format(new Date()),W-pad,footerY);ctx.textAlign='left';const output=document.createElement('canvas');output.width=W;output.height=finalHeight;output.getContext('2d').drawImage(canvas,0,0,W,finalHeight,0,0,W,finalHeight);return new Promise((resolve,reject)=>output.toBlob(blob=>blob?resolve(new File([blob],`${shareFileStem(v)}-profile.png`,{type:'image/png'})):reject(new Error('Could not create share image')),'image/png',.96))}
function previewShareImage(file,existingWindow=null){const url=URL.createObjectURL(file),win=existingWindow||window.open('','_blank','noopener,noreferrer');if(!win){URL.revokeObjectURL(url);return false}try{win.document.open();win.document.write(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>DriveHub share image</title><style>html,body{margin:0;min-height:100%;background:#0f172a}body{display:grid;place-items:center;padding:18px;box-sizing:border-box}img{display:block;max-width:100%;max-height:calc(100vh - 36px);width:auto;height:auto;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.35)}</style><img src="${url}" alt="DriveHub vehicle share image">`);win.document.close();setTimeout(()=>URL.revokeObjectURL(url),120000);return true}catch{URL.revokeObjectURL(url);return false}}

function backupData(){return {version:1,exportedAt:new Date().toISOString(),data:state}}
function downloadBackup(){const blob=new Blob([JSON.stringify(backupData(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`drivehub-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

function navIcon(type){
 const common='viewBox="0 0 24 24" aria-hidden="true"';
 const icons={
  home:`<svg ${common}><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/></svg>`,
  garage:`<svg ${common}><path d="M5 15l1.6-5A2.4 2.4 0 0 1 8.9 8.3h6.2A2.4 2.4 0 0 1 17.4 10L19 15v3h-3"/><path d="M8 18H5v-3h14"/><circle cx="7.6" cy="18" r="1.6"/><circle cx="16.4" cy="18" r="1.6"/></svg>`,
  reminders:`<svg ${common}><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.5 20a2 2 0 0 0 3 0"/></svg>`,
  docs:`<svg ${common}><path d="M7 3h7l5 5v13H7z"/><path d="M13.5 3.5V9h5"/></svg>`,
  settings:`<svg ${common}><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="M19.1 13.5a7.5 7.5 0 0 0 .1-3l2-1.6-2-3.4-2.4 1a8.3 8.3 0 0 0-2.6-1.5L13.9 2h-3.8l-.4 3a8.3 8.3 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a8.3 8.3 0 0 0 2.6 1.5l.4 3h3.8l.4-3a8.3 8.3 0 0 0 2.6-1.5l2.4 1 2-3.4-2.2-1.6Z"/></svg>`
 };
 return icons[type]||'';
}
function nav(active='garage'){
 const item=(screen,label,icon)=>`<button class="nav-btn ${active===screen?'active':''}" data-nav="${screen}" ${active===screen?'aria-current="page"':''}><span class="nav-icon">${navIcon(icon)}</span><span class="nav-label">${label}</span></button>`;
 const home=`<a class="nav-btn gateway-home" href="../../../index.html" aria-label="DriveHub home"><span class="nav-icon">${navIcon('home')}</span></a>`;
 return `<nav class="bottom-nav" aria-label="MyGarage navigation">${home}${item('garage','MyGarage','garage')}${item('reminders','Reminders','reminders')}${item('settings','Settings','settings')}</nav>`;
}
function shell(content,active='garage',showNav=true){return `<main class="app-shell">${content}</main>${showNav?nav(active):''}`}
function backButton(screen='garage',id='',tab=''){return `<button class="icon-btn" data-app-back data-back-screen="${screen}" ${id?`data-back-id="${id}"`:''} ${tab?`data-back-tab="${tab}"`:''} aria-label="Back">←</button>`}


function vehicleIdentityCard(v,{detail=false}={}){
 const p=mainPhoto(v),searchable=[v.registration,v.nickname,v.make,v.model,v.derivative,v.year,v.colour,v.transmission,v.fuelType].filter(Boolean).join(' ').toLowerCase();
 const meta=[v.year,`${miles(v.mileage)} miles`,v.colour].filter(Boolean).map(esc).join(' · ');
 const dueChip=(label,date,fallback='')=>{const due=compactDue(date),value=due.date==='—'&&fallback?fallback:due.date,tone=String(label||'').toLowerCase();return `<span class="organic-card-due essential-tone-${tone} ${due.urgent?'urgent':''} ${due.overdue?'overdue':''}"><b>${label}</b><span>${esc(value)}${due.days?` <em>(${esc(due.days)})</em>`:''}</span></span>`};
 const detailItem=(label,value)=>value?`<span><b>${esc(label)}</b><em>${esc(value)}</em></span>`:'';
 const listDetails=`<div class="organic-list-details">${detailItem('Trim',v.derivative)}${detailItem('Transmission',v.transmission)}${detailItem('Engine',[v.engineSize,v.fuelType].filter(Boolean).join(' · '))}${detailItem('Mileage',v.mileage?`${miles(v.mileage)} miles`:'')}</div>`;
 const taxFallback=v.tax?.status&&v.tax.status!=='Unknown'?v.tax.status:'';
 const attrs=detail?'':`data-open="${v.id}" data-search="${esc(searchable)}" tabindex="0" role="button" aria-label="Open ${esc(fullVehicleName(v))}"`;
 return `<article class="organic-vehicle-card ${detail?'organic-detail-vehicle-card':''}" ${attrs}><div class="organic-vehicle-photo">${p?`<img src="${p.dataUrl}" alt="${esc(fullVehicleName(v))}">`:`<div class="organic-photo-placeholder">${appGlyph('car')}</div>`}<span class="organic-reg">${esc(v.registration)}</span></div><div class="organic-vehicle-body"><div class="organic-title-row"><h2>${esc(displayVehicleName(v))}</h2></div><p class="organic-meta">${meta}</p>${listDetails}<div class="organic-card-due-row">${dueChip('MOT',v.mot?.expiryDate)}${dueChip('Tax',v.tax?.expiryDate,taxFallback)}${dueChip('Service',v.service?.nextServiceDate)}${dueChip('Insurance',v.insurance?.renewalDate)}</div></div></article>`;
}
function garage(){
 if(!state.vehicles.length){
  const firstRun=`<section class="first-run"><img class="drivehub-first-logo" src="icons/drivehub-192.png" alt="DriveHub"><div><p class="organic-kicker">MYGARAGE</p><h1>Start your<br>garage</h1><p>Add a car and we’ll keep its MOT, tax, service and paperwork straight — and tell you, in good time, when something needs doing.</p></div><div class="first-run-points"><div><span class="green">${appGlyph('check')}</span><strong>One reg is all we need to start</strong></div><div><span class="blue">${appGlyph('check')}</span><strong>MOT history arrives already filled in</strong></div><div><span class="yellow">${appGlyph('check')}</span><strong>Works offline; syncs when you’re back</strong></div></div><div class="first-run-actions"><button class="primary full" data-nav="add">Add your first car</button><button class="text-btn full" id="restore-first-run">Restore from a backup</button><input class="hidden" id="first-run-import-file" type="file" accept="application/json,.json"></div></section>`;
  return shell(firstRun,'garage')
 }
 const nudge=garageNudge();
 const cards=state.vehicles.map(v=>vehicleIdentityCard(v)).join('');
 const tools=state.vehicles.length>6?`<label class="organic-search">${appGlyph('search')}<input id="garage-search" type="search" placeholder="Find a car" autocomplete="off"></label>`:'';
 const viewSwitch=`<div class="garage-view-switch" role="group" aria-label="MyGarage view"><button type="button" data-garage-view="grid" class="${garageView==='grid'?'active':''}" aria-pressed="${garageView==='grid'}">Grid</button><button type="button" data-garage-view="gallery" class="${garageView==='gallery'?'active':''}" aria-pressed="${garageView==='gallery'}">Gallery</button><button type="button" data-garage-view="list" class="${garageView==='list'?'active':''}" aria-pressed="${garageView==='list'}">List</button></div>`;
 const addCar=`<button class="organic-add-car" data-nav="add"><span>＋</span><strong>Add another car</strong></button>`;
 return shell(`<header class="organic-home-head"><div class="drivehub-home-brand"><img src="icons/drivehub-192.png" alt="" aria-hidden="true"><div><p class="organic-kicker">MYGARAGE · ${esc(garageDateLabel())}</p><h1>Your garage</h1></div></div><button class="organic-avatar" data-nav="settings" aria-label="Open your settings">${esc(userInitials())}</button></header>${nudge?`<button class="organic-nudge" data-nav="vehicle" data-id="${nudge.vehicle.id}" data-tab="${nudge.tab}"><i></i><span>${esc(nudge.text)}</span><b>›</b></button>`:''}<div class="garage-view-tools">${tools}${viewSwitch}</div><div class="organic-car-stack garage-view-${garageView}" id="vehicle-stack">${cards}${garageView==='grid'?addCar:''}</div>${garageView==='grid'?'':`<div class="garage-view-add">${addCar}</div>`}<div class="organic-no-results hidden" id="garage-no-results">No cars match that search.</div>`,'garage')
}
function addVehicle(){
 const year=new Date().getFullYear();
 const years=[year,year-1,year-2,year-3,year-4,year-5];
 const presets=(field,items)=>`<div class="organic-wizard-presets">${items.map(x=>`<button type="button" data-wizard-preset="${esc(field)}" data-value="${esc(x)}">${esc(x)}</button>`).join('')}</div>`;
 const reminderToggle=(name,label)=>`<label class="organic-wizard-reminder"><div><span class="organic-wizard-reminder-icon">${navIcon('reminders')}</span><span><strong>Remind me</strong><small>On by default · you can change this later</small></span></div><span class="reminder-switch"><input type="checkbox" name="${esc(name)}" checked aria-label="Remind me about ${esc(label)}"><span></span></span></label>`;
 const question=(field,kicker,title,body,input,extra='')=>`<section class="organic-wizard-question" data-wizard-question="${field}" hidden><p class="organic-kicker">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="organic-wizard-help">${esc(body)}</p>${input}${extra}<div class="organic-wizard-actions"><button type="button" class="organic-wizard-secondary back" data-wizard-back aria-label="Back">←</button><button type="button" class="organic-dark-submit" data-wizard-next>Next</button><button type="button" class="organic-wizard-secondary skip" data-wizard-skip>Skip</button></div></section>`;
 return shell(`<div class="organic-add-flow organic-wizard-flow">
  <header class="organic-add-head">
   <button class="organic-close" data-nav="garage" aria-label="Close">×</button>
   <span id="wizard-progress-label">1 of 17</span>
  </header>
  <div class="organic-wizard-progress" aria-hidden="true"><i id="wizard-progress-bar"></i></div>
  <form id="add-form" novalidate data-guard-unsaved>
   ${question('registration','REGISTRATION','What’s the registration?','Enter the registration and DriveHub will try to fill in the vehicle and MOT details for you.',`<div class="organic-wizard-input"><input id="registration" name="registration" data-registration-input autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AB18 XYZ" enterkeyhint="next"></div><p class="organic-registration-lookup-status hidden" id="registration-lookup-status" aria-live="polite"></p>`)}
   ${question('make','MAKE','What make is it?','Type the manufacturer, for example BMW, Ford or Jaguar.',`<div class="organic-wizard-input"><input name="make" autocomplete="organization" placeholder="e.g. Ford" enterkeyhint="next"></div>`)}
   ${question('model','MODEL','What model is it?','Just the model name is enough for now.',`<div class="organic-wizard-input"><input name="model" placeholder="e.g. Mustang GT" enterkeyhint="next"></div>`)}
   ${question('nickname','NICKNAME','Want to give it a nickname?','Optional — useful if you have more than one similar car.',`<div class="organic-wizard-input"><input name="nickname" placeholder="e.g. Sally" enterkeyhint="next"></div>`)}
   ${question('mileage','MILEAGE','What’s the current mileage?','A rough current figure is fine.',`<div class="organic-wizard-input unit"><input name="mileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input placeholder="74,000" enterkeyhint="next"><span>miles</span></div>`)}
   ${question('year','YEAR','What year is it?','Tap a recent year or type another one.',`<div class="organic-wizard-input"><input name="year" type="number" min="1900" max="${year+1}" inputmode="numeric" placeholder="${year-5}" enterkeyhint="next"></div>`,presets('year',years))}
   ${question('fuelType','FUEL','What does it run on?','One tap and you’re done.',`<input type="hidden" name="fuelType">`,presets('fuelType',['Petrol','Diesel','Electric','Hybrid','Plug-in hybrid','LPG']))}
   ${question('transmission','TRANSMISSION','How does it change gear?','Choose the closest match.',`<input type="hidden" name="transmission">`,presets('transmission',['Automatic','Manual','Semi-auto']))}
   ${question('bodyType','BODY TYPE','What shape is it?','Pick the closest body style.',`<input type="hidden" name="bodyType">`,presets('bodyType',['Hatchback','Saloon','Estate','SUV','Coupe','Convertible','Van','Pickup']))}
   ${question('colour','COLOUR','What colour is it?','Tap a common colour or type your own.',`<div class="organic-wizard-input"><input name="colour" placeholder="e.g. Ruby Red" enterkeyhint="next"></div>`,presets('colour',['Black','White','Grey','Silver','Blue','Red','Green']))}
   ${question('derivative','TRIM','Which version or trim?','Examples: GT, M Sport, R-Dynamic. Skip it if you’re not sure.',`<div class="organic-wizard-input"><input name="derivative" placeholder="e.g. GT" enterkeyhint="next"></div>`)}
   ${question('engineSize','ENGINE','What engine size?','Tap a common size or type the exact engine.',`<div class="organic-wizard-input"><input name="engineSize" placeholder="e.g. 5.0L" enterkeyhint="next"></div>`,presets('engineSize',['1.0L','1.2L','1.5L','1.6L','2.0L','2.5L','3.0L','4.0L','5.0L']))}
   ${question('motExpiry','MOT','When is the MOT due?','Add the expiry date so DriveHub can show it on the car card and in upcoming events.',`<div class="organic-wizard-input date"><input name="motExpiry" type="date"></div>`,reminderToggle('motReminder','MOT'))}
   ${question('nextServiceDate','SERVICE','When is the next service due?','Add the planned service date. You can add service mileage later if needed.',`<div class="organic-wizard-input date"><input name="nextServiceDate" type="date"></div>`,reminderToggle('serviceReminder','service'))}
   ${question('taxExpiry','TAX','When is the tax due?','Add the tax expiry date so DriveHub can track it with the other upcoming dates.',`<div class="organic-wizard-input date"><input name="taxExpiry" type="date"></div>`,reminderToggle('taxReminder','tax'))}
   ${question('insuranceRenewalDate','INSURANCE','When does the insurance renew?','Add the renewal date so DriveHub can keep it with your other essential dates.',`<div class="organic-wizard-input date"><input name="insuranceRenewalDate" type="date"></div>`,reminderToggle('insuranceReminder','insurance'))}
   <section class="organic-wizard-question organic-wizard-finish" data-wizard-question="finish" hidden>
    <p class="organic-kicker">READY</p>
    <h1>That’s enough to get started</h1>
    <p class="organic-wizard-help">You can add ownership, VIN, insurance premium and anything else later from Edit.</p>
    <div class="organic-wizard-summary" id="wizard-summary"></div>
    <div class="organic-wizard-actions finish">
     <button type="button" class="organic-wizard-secondary back" data-wizard-back aria-label="Back">←</button>
     <button class="organic-dark-submit" type="submit">Continue to photos</button>
    </div>
   </section>

   <!-- Details retained in the data model but intentionally deferred from first-run onboarding. -->
   <input type="hidden" name="vin" value="">
   <input type="hidden" name="taxStatus" value="Unknown">
   <input type="hidden" name="purchaseDate" value="">
   <input type="hidden" name="purchasePrice" value="">
   <input type="hidden" name="lastServiceDate" value="">
   <input type="hidden" name="lastServiceMileage" value="">
   <input type="hidden" name="nextServiceMileage" value="">
   <input type="hidden" name="insurancePremium" value="">
  </form>
 </div>`,'garage',false)
}
function vehicleTabs(v,active){
 const tab=(key,label)=>`<button class="tab ${active===key?'active':''}" data-vehicle-tab="${key}" data-id="${v.id}">${label}</button>`;
 return `<div class="organic-car-tabs" role="tablist" aria-label="${esc(displayVehicleName(v))} sections">${tab('overview','Overview')}${tab('mot','Essentials')}${tab('photos','Photos')}${tab('story','Timeline')}${tab('paperwork','Paperwork')}${tab('details','Car details')}</div>`
}
function vehicleHeader(v){
 const p=mainPhoto(v);
 return `<header class="organic-car-compact-header">${backButton('garage')}<div class="organic-car-compact-photo">${p?`<img src="${p.dataUrl}" alt="${esc(fullVehicleName(v))}">`:`<span>${appGlyph('car')}</span>`}</div><div class="organic-car-compact-copy"><strong>${esc(displayVehicleName(v))}</strong><span>${esc(v.registration)}</span></div><button class="organic-detail-edit organic-edit-text" data-nav="edit" data-id="${v.id}" aria-label="Edit ${esc(displayVehicleName(v))}">Edit</button><button type="button" class="organic-car-remove" data-remove-vehicle aria-label="Remove ${esc(displayVehicleName(v))} from garage" title="Remove from garage">${appGlyph('trash')}</button></header>`
}
function compactVehicleHeader(v){return vehicleHeader(v)}
function overviewTab(v){
 const next=nextBestAction(v),spent=currentYearSpend(v),owned=ownershipYearsLabel(v),valuation=v.valuation||{};
 const clear=next.level==='clear';
 const valueTitle=valuation.privateSale?`${money(valuation.privateSale)} private sale`:'Value this car';
 const valueMeta=valuation.privateSale?`Updated ${relativeAge(valuation.updatedAt)} · open the Valuation Tool to refresh or inspect the market`:'Get a current private-sale, PX and retail estimate without re-entering the car.';
 return `<div class="organic-overview"><section class="organic-next-up ${clear?'clear':''}"><div><p class="organic-kicker">${clear?'ALL SET':'NEXT UP'}</p><h2>${esc(next.title)}</h2><p>${esc(next.body)}</p></div>${next.label?`<button class="organic-pill-action" data-next-action="${next.action}" ${next.modal?`data-next-modal="${next.modal}"`:''}>${esc(next.label==='Open MOT'?'Open':next.label)}</button>`:''}</section><section class="organic-overview-section organic-update-section compact"><button type="button" class="organic-add-update-card" data-nav="addupdate" data-id="${v.id}"><span class="organic-tool-icon">＋</span><div><strong>Add an event</strong><small>Fuel, mileage, service, maintenance and more</small></div><b>›</b></button></section><section class="organic-overview-section organic-ownership-section"><div class="organic-overview-section-head compact"><p class="organic-kicker">OWNERSHIP</p><h2>Your snapshot</h2></div><div class="organic-ownership-strip two"><div><strong>${money(spent)}</strong><span>Spent this year</span></div><div><strong>${esc(owned)}</strong><span>Owned</span></div></div></section><section class="organic-overview-section organic-value-section"><div class="organic-overview-section-head compact"><p class="organic-kicker">VALUE</p><h2>Market value</h2></div><button class="organic-overview-tool-card value" id="open-valuation-tool" data-vehicle-id="${esc(v.id)}"><span class="organic-tool-icon">${appGlyph('valuation')}</span><div><strong>${esc(valueTitle)}</strong><small>${esc(valueMeta)}</small></div><b>›</b></button></section><section class="organic-overview-section organic-drive-section"><div class="organic-overview-section-head compact"><p class="organic-kicker">DRIVE</p><h2>Enjoy the car</h2></div><button class="organic-overview-tool-card drive" id="open-road-finder"><span class="organic-tool-icon">${appGlyph('road')}</span><div><strong>Find a great road</strong><small>Open Road Finder to discover the best roads and routes near you.</small></div><b>›</b></button></section><section class="organic-overview-section organic-share-section"><div class="organic-overview-section-head compact"><p class="organic-kicker">SHARE</p><h2>Share this car</h2></div><button class="organic-overview-tool-card share standalone" id="share-car-callout"><span class="organic-tool-icon">${appGlyph('share')}</span><div><strong>Share my car with others</strong><small>Share a clean summary of the car with someone else.</small></div><b>›</b></button></section></div>`
}
function appGlyph(type){
  const common='viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  const icons={
    mileage:`<svg ${common}><path d="M5 17a7 7 0 1 1 14 0"/><path d="m12 14 3-4"/><path d="M7.5 17h9"/></svg>`,
    service:`<svg ${common}><path d="M14.7 6.3a4 4 0 0 0-5 5L4.5 16.5a2.1 2.1 0 0 0 3 3l5.2-5.2a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4Z"/></svg>`,
    maintenance:`<svg ${common}><path d="m14 7 3-3 3 3-3 3"/><path d="M17 4v6"/><path d="M4 20l7.5-7.5"/><path d="m8 10 6 6"/><path d="m6.5 8.5 2-2"/></svg>`,
    repair:`<svg ${common}><path d="M4 21l5-5"/><path d="m14 5 5 5"/><path d="M16 3l5 5-3 3-5-5z"/><path d="m8 13 3 3"/></svg>`,
    expense:`<svg ${common}><path d="M7 8.5c0-1.4 1.2-2.5 3-2.5s3 1.1 3 2.5S11.8 11 10 11s-3 1.1-3 2.5S8.2 16 10 16s3-1.1 3-2.5"/><path d="M10 4v14"/><path d="M4 3h16v18H4z"/></svg>`,
    note:`<svg ${common}><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4"/><path d="M9 11h6M9 15h6"/></svg>`,
    valuation:`<svg ${common}><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M3 19h18"/><path d="m4 7 6-4 6 6 5-4"/></svg>`,
    road:`<svg ${common}><path d="M7 21 11 3M17 21 13 3M9.3 13h5.4M10.2 8h3.6M8.5 17h7"/></svg>`,
    purchase:`<svg ${common}><circle cx="8" cy="15" r="3"/><path d="m10.5 13.5 8-8"/><path d="m16 5 3 3"/><path d="m14.5 9.5 2 2"/></svg>`,
    due:`<svg ${common}><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="m9 15 2 2 4-4"/></svg>`,
    reminder:`<svg ${common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>`,
    modification:`<svg ${common}><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="7"/></svg>`,
    share:`<svg ${common}><path d="M14 5h5v5"/><path d="M10 14 19 5"/><path d="M19 13v6H5V5h6"/></svg>`,
    document:`<svg ${common}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12h6M9 16h6"/></svg>`,
    camera:`<svg ${common}><path d="M4 7h3l1.5-2h7L17 7h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
    clock:`<svg ${common}><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/></svg>`,
    car:`<svg ${common}><path d="M5 11l1.7-4.2A2 2 0 0 1 8.6 5.5h6.8a2 2 0 0 1 1.9 1.3L19 11"/><path d="M4 12h16v5.2A1.8 1.8 0 0 1 18.2 19H17v-2H7v2H5.8A1.8 1.8 0 0 1 4 17.2z"/><path d="M7.5 14.5h2M14.5 14.5h2"/></svg>`,
    search:`<svg ${common}><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>`,
    check:`<svg ${common}><path d="m5 12 4 4L19 6"/></svg>`,
    refresh:`<svg ${common}><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.2 8.5A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 11.8-1.5"/></svg>`,
    fuel:`<svg ${common}><path d="M6 21V5h9v16"/><path d="M6 9h9"/><path d="M4 21h13"/><path d="M15 7h2l3 3v7a2 2 0 0 1-4 0v-4"/></svg>`,
    user:`<svg ${common}><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.3-3.4 4-5 7-5s5.7 1.6 7 5"/></svg>`,
    trash:`<svg ${common}><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>`,
    filter:`<svg ${common}><path d="M4 6h16M7 12h10M10 18h4"/></svg>`

  };
  return icons[type]||icons.note;
}

function activityIcon(type){return appGlyph(({mot:'check',mot_test:'check',mot_due:'due',tax:'due',tax_due:'due',service_due:'due',insurance:'due',insurance_due:'due',document:'document',photo:'camera'}[type]||type))}
function activityLabel(type){return ({fuel:'Fuel',service:'Service',maintenance:'Maintenance',repair:'Repair',expense:'Expense',mileage:'Mileage',modification:'Modification',document:'Paperwork',photo:'Photo',note:'Note',valuation:'Valuation',purchase:'Purchase',mot:'MOT',mot_test:'MOT test',mot_due:'MOT due',tax:'Tax',tax_due:'Tax due',service_due:'Service due',insurance:'Insurance',insurance_due:'Insurance renewal',reminder:'Reminder'}[type]||'Update')}
function essentialEventKey(type){return ({mot_due:'mot',tax_due:'tax',insurance_due:'insurance'}[type]||'')}
function essentialEventDate(v,type){return type==='mot_due'?v.mot?.expiryDate||'':type==='tax_due'?v.tax?.expiryDate||'':type==='insurance_due'?v.insurance?.renewalDate||'':''}
function setEssentialEventDate(v,type,date){
 if(type==='mot_due'){v.mot=v.mot||{status:'Unknown',expiryDate:'',history:[]};v.mot.expiryDate=date}
 else if(type==='tax_due'){v.tax=v.tax||{status:'Unknown',expiryDate:''};v.tax.expiryDate=date}
 else if(type==='insurance_due'){v.insurance=v.insurance||{renewalDate:'',premium:null};v.insurance.renewalDate=date}
}
function recordEssentialRenewal(v,type,previousDate,nextDate,note=''){
 if(!v||!previousDate||!nextDate||String(previousDate).slice(0,10)===String(nextDate).slice(0,10))return;
 const oldDate=asDate(previousDate),newDate=asDate(nextDate),today=new Date();today.setHours(12,0,0,0);
 if(!oldDate||!newDate||oldDate>today||newDate<=oldDate)return;
 const eventType=type==='mot_due'?'mot':type==='tax_due'?'tax':type==='insurance_due'?'insurance':'';
 if(!eventType)return;
 const title=eventType==='mot'?'MOT renewed':eventType==='tax'?'Tax renewed':'Insurance renewed';
 const date=new Date().toISOString().slice(0,10),body=[`Previous due date ${fmtDate(previousDate)} · next due ${fmtDate(nextDate)}.`,note].filter(Boolean).join(' ');
 v.activity=v.activity||[];
 const id=`essential-renewal-${eventType}-${String(previousDate).slice(0,10)}-${String(nextDate).slice(0,10)}`;
 if(v.activity.some(a=>a.id===id&&!a._deleted))return;
 v.activity.push({id,type:eventType,title,date,body,cost:eventType==='insurance'&&Number(v.insurance?.premium)>0?Number(v.insurance.premium):null,system:true,sourceLabel:'Essentials',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})
}
function motTimelineBody(t){
 const defects=t.defects||[],counts={dangerous:0,major:0,minor:0,advisory:0,prs:0,other:0};
 for(const d of defects)counts[normaliseDefectType(d.type,d.dangerous)]++;
 const bits=[];
 if(!defects.length)bits.push('No defects or advisories recorded.');
 else{
  if(counts.dangerous)bits.push(`${counts.dangerous} dangerous`);
  if(counts.major)bits.push(`${counts.major} major`);
  if(counts.minor)bits.push(`${counts.minor} minor`);
  if(counts.advisory)bits.push(`${counts.advisory} ${counts.advisory===1?'advisory':'advisories'}`);
  if(counts.prs)bits.push(`${counts.prs} PRS`);
  if(counts.other)bits.push(`${counts.other} note${counts.other===1?'':'s'}`);
 }
 const details=defects.slice(0,5).map(d=>`${defectLabel(normaliseDefectType(d.type,d.dangerous))}: ${d.text||d.comment||'Issue recorded'}`);
 if(defects.length>5)details.push(`+${defects.length-5} more item${defects.length-5===1?'':'s'}`);
 return [bits.join(' · '),details.join(' · ')].filter(Boolean).join(' — ')
}
function systemFeedItems(v){
 const out=[],now=new Date(),today=now.toISOString().slice(0,10),docs=activeDocuments(v),photos=v.photos||[],active=activeActivity(v);
 const vehicleName=displayVehicleName(v),reg=v.registration?` · ${v.registration}`:'';
 const pushDue=(type,title,date,body)=>{
  if(!date)return;
  const noteKey=essentialEventKey(type),note=noteKey?String(v.essentialEventNotes?.[noteKey]||'').trim():'';
  const displayBody=[body,note?`Note: ${note}`:''].filter(Boolean).join(' ');
  out.push({id:`system-${type}-${v.id}`,vehicleId:v.id,type,title,date:String(date).slice(0,10),body:displayBody,calendarTitle:`${vehicleName} — ${title}`,calendarDescription:`${displayBody||title}${reg}`,system:true,sourceLabel:'Essentials',future:String(date).slice(0,10)>=today})
 };
 if(v.ownership?.purchaseDate)out.push({id:`system-purchase-${v.id}`,vehicleId:v.id,type:'purchase',title:'Vehicle purchased',date:String(v.ownership.purchaseDate).slice(0,10),body:v.ownership?.purchasePrice?`Purchase price ${money(v.ownership.purchasePrice)}`:'Added from ownership details',system:true,sourceLabel:'Ownership',future:false});
 for(const t of motTests(v)){
  if(!t.completedDate)continue;
  const result=String(t.testResult||'').toUpperCase(),passed=result.includes('PASS'),failed=result.includes('FAIL');
  out.push({id:`system-mot-test-${t.motTestNumber||t.completedDate}-${t.odometerValue||''}`,vehicleId:v.id,type:'mot_test',title:passed?'MOT passed':failed?'MOT failed':'MOT test',date:String(t.completedDate).slice(0,10),mileage:t.odometerValue!==undefined&&t.odometerValue!==null&&t.odometerValue!==''?Number(t.odometerValue):null,body:motTimelineBody(t),system:true,sourceLabel:v.source?.dvsa?'DVSA MOT history':'MOT history',future:false,motTestNumber:t.motTestNumber||''})
 }
 const activityIds=new Set(active.map(a=>a.id));
 for(const p of (v.mileageHistory||[]).filter(x=>!x._deleted)){
  if(!p?.date||activityIds.has(p.id)||String(p.source||'').toUpperCase()==='MOT')continue;
  const mileage=Number(p.mileage);if(!Number.isFinite(mileage)||mileage<=0)continue;
  out.push({id:`system-mileage-${p.id||`${p.date}-${mileage}`}`,vehicleId:v.id,type:'mileage',title:String(p.source||'').toLowerCase()==='initial'?'Starting mileage':'Mileage recorded',date:String(p.date).slice(0,10),mileage,body:'Odometer reading saved to the vehicle record.',system:true,sourceLabel:'Mileage history',future:false})
 }
 if(Number(v.mileage)>0&&!(v.mileageHistory||[]).some(x=>!x._deleted&&Number(x.mileage)>0)){
  const date=String(v.createdAt||today).slice(0,10);out.push({id:`system-mileage-legacy-${v.id}`,vehicleId:v.id,type:'mileage',title:'Starting mileage',date,mileage:Number(v.mileage),body:'Current mileage carried forward from the vehicle record.',system:true,sourceLabel:'Vehicle record',future:false})
 }
 const linkedPhotoIds=new Set(active.flatMap(a=>a.photoIds||[]));
 const unlinkedPhotos=photos.filter(p=>p?.id&&!linkedPhotoIds.has(p.id)&&p.createdAt);
 const photoGroups=new Map();
 for(const p of unlinkedPhotos){const date=String(p.createdAt).slice(0,10);if(!date)continue;const group=photoGroups.get(date)||[];group.push(p);photoGroups.set(date,group)}
 for(const [date,group] of photoGroups){const first=group[0],photoIndex=photos.findIndex(p=>p.id===first.id),count=group.length;out.push({id:`system-photo-${date}-${group.map(p=>p.id).join('-')}`,vehicleId:v.id,type:'photo',title:count===1?'Photo added':`${count} photos added`,date,body:count===1?'Saved in Photos.':`${count} photos saved in Photos.`,system:true,sourceLabel:'Photos',future:false,photoPreview:first.dataUrl||'',photoCount:count,photoIndex})}
 const activeIds=new Set(active.map(a=>a.id));
 for(const d of docs){
  if(d.activityId&&activeIds.has(d.activityId))continue;
  const date=String(d.date||d.createdAt||today).slice(0,10);
  out.push({id:`system-document-${d.id}`,vehicleId:v.id,type:'document',title:d.name||'Paperwork added',date,body:[d.category&&d.category!=='Other'?d.category:'',d.note||''].filter(Boolean).join(' · '),documents:[d],system:true,sourceLabel:'Paperwork',future:false})
 }
 pushDue('mot_due','MOT due',v.mot?.expiryDate,v.mot?.expiryDate?`MOT expires ${fmtDate(v.mot.expiryDate)}.`:'');
 pushDue('tax_due','Tax due',v.tax?.expiryDate,v.tax?.expiryDate?`Vehicle tax is due ${fmtDate(v.tax.expiryDate)}.`:'');
 pushDue('service_due','Service due',v.service?.nextServiceDate,v.service?.nextServiceDate?`Planned service date ${fmtDate(v.service.nextServiceDate)}${v.service?.nextServiceMileage?` · ${miles(v.service.nextServiceMileage)} miles`:''}.`:'');
 pushDue('insurance_due','Insurance renewal',v.insurance?.renewalDate,v.insurance?.renewalDate?`Insurance renews ${fmtDate(v.insurance.renewalDate)}.`:'');
 for(const r of activeReminders().filter(r=>r.vehicleId===v.id&&r.date&&r.enabled!==false)){
  const title=r.title||r.kind||'Reminder',body='Custom DriveHub reminder';
  out.push({id:`system-reminder-${r.id}`,vehicleId:v.id,reminderId:r.id,type:'reminder',title,date:String(r.date).slice(0,10),body,calendarTitle:`${vehicleName} — ${title}`,calendarDescription:`${body}${reg}`,system:true,sourceLabel:'Reminder',future:String(r.date).slice(0,10)>=today})
 }
 return out
}
function timeFeedItems(v){
 const docs=activeDocuments(v),photos=v.photos||[];
 const manual=activeActivity(v).map(a=>{const linkedPhotos=(a.photoIds||[]).map(id=>photos.find(p=>p.id===id)).filter(Boolean);const photoIndex=linkedPhotos.length?photos.findIndex(p=>p.id===linkedPhotos[0].id):-1;const legacyDoc=a.documentId?docs.find(d=>d.id===a.documentId):null;const sourceLabel=a.sourceLabel||(a.system?'DriveHub':'Recorded by you');return {...a,vehicleId:v.id,system:!!a.system,sourceLabel,future:false,documents:legacyDoc?[legacyDoc]:[],photoPreview:linkedPhotos[0]?.dataUrl||'',photoCount:linkedPhotos.length,photoIndex}});
 let all=[...manual,...systemFeedItems(v)],ids=new Set(all.filter(a=>a.type!=='document').map(a=>a.id));
 all=all.filter(a=>{if(a.type!=='document')return true;const d=a.documents?.[0];const ref=timelineEvidenceRef(d);return !ref||!ids.has(ref)}).map(a=>{if(a.type==='document')return a;const linked=docs.filter(d=>timelineEvidenceRef(d)===a.id);const merged=[...(a.documents||[]),...linked].filter((d,i,list)=>d&&list.findIndex(x=>x.id===d.id)===i);return {...a,documents:merged}});
 const seen=new Set();return all.filter(a=>{const key=a.id||`${a.type}-${a.date}-${a.title}`;if(seen.has(key))return false;seen.add(key);return true})
}
function eventOpenTarget(a){
 if(a.type==='mot_test'&&a.vehicleId)return {nav:'mothistory',id:a.vehicleId};
 if(a.type==='document'&&a.vehicleId)return {nav:'vehicle',id:a.vehicleId,tab:'paperwork'};
 if(a.type==='photo'&&a.vehicleId&&a.photoIndex>=0)return {nav:'gallery',id:a.vehicleId,tab:String(a.photoIndex)};
 if(a.type==='service_due'&&a.vehicleId)return {nav:'addupdateform',id:a.vehicleId,tab:'service_due'};
 if(['mot_due','tax_due','insurance_due'].includes(a.type)&&a.vehicleId)return {nav:'essentialevent',id:a.vehicleId,tab:a.type};
 if(!a.system&&a.id&&a.vehicleId)return {nav:'editevent',id:a.vehicleId,tab:a.id};
 if(['mot','tax','service','insurance'].includes(a.type)&&a.vehicleId)return {nav:'vehicle',id:a.vehicleId,tab:'mot'};
 if(a.type==='reminder'&&a.reminderId)return {nav:'reminderform',id:a.reminderId};
 if(['purchase','valuation'].includes(a.type)&&a.vehicleId)return {nav:'vehicle',id:a.vehicleId,tab:'overview'};
 return a.vehicleId?{nav:'vehicle',id:a.vehicleId,tab:'story'}:null
}
function activityRow(a){
 const essentialTone=({mot:'mot',mot_test:'mot',mot_due:'mot',tax:'tax',tax_due:'tax',service:'service',service_due:'service',insurance:'insurance',insurance_due:'insurance'}[a.type]||'');
 const meta=[`<span class="story-event-type">${esc(activityLabel(a.type))}</span>`,fmtDate(a.date)];
 if(a.type==='service'&&a.serviceType)meta.push(esc(serviceTypeLabel(a.serviceType)));
 if(a.type==='service'&&a.garageName)meta.push(esc(a.garageName));
 if(a.mileage!==undefined&&a.mileage!==null&&a.mileage!=='')meta.push(`${miles(a.mileage)} miles`);
 if(a.cost!==undefined&&a.cost!==null&&a.cost!=='')meta.push(money(a.cost));
 if(a.sourceLabel)meta.push(`<span class="story-source">${esc(a.sourceLabel)}</span>`);
 const dot=['fuel','photo'].includes(a.type)?'blue':a.type==='note'?'yellow':['service','maintenance','repair','mot_due','service_due'].includes(a.type)?'green':'neutral';
 const evidence=(a.documents||[]).length?`<div class="story-evidence">${a.documents.map(d=>`<button type="button" class="story-document-evidence" data-preview-document="${d.id}">${documentThumbMarkup(d,'story-doc-thumb')}<span><strong>${esc(d.name)}</strong><small>${esc(d.category||'Paperwork')}${d.note?` · ${esc(d.note)}`:''}</small></span></button>`).join('')}</div>`:a.documentId?`<div class="story-evidence"><button type="button" data-open-document="${a.documentId}">${appGlyph('document')} Open document</button></div>`:'';
 const photoPreview=a.photoPreview&&a.photoIndex>=0?`<button type="button" class="story-photo-preview" data-nav="gallery" data-id="${a.vehicleId||''}" data-tab="${a.photoIndex}" aria-label="Open added photo${a.photoCount>1?'s':''}"><img src="${a.photoPreview}" alt="Added vehicle photo">${a.photoCount>1?`<span>+${a.photoCount-1}</span>`:''}</button>`:'';
 const calendar=a.future?calendarButtonMarkup({title:a.calendarTitle||a.title||activityLabel(a.type),date:a.date,description:a.calendarDescription||a.body||'',uid:a.id,label:'Add to calendar'}):'';
 const target=eventOpenTarget(a);
 const targetAttrs=target?` data-event-nav="${esc(target.nav)}"${target.id?` data-event-id="${esc(target.id)}"`:''}${target.tab!==undefined?` data-event-tab="${esc(target.tab)}"`:''} role="button" tabindex="0" aria-label="Open ${esc(a.title||activityLabel(a.type))}"`:'';
 const evidenceAction=evidenceEligible(a)?`<button type="button" class="story-add-evidence" data-add-evidence="${esc(a.id)}">${appGlyph('document')} ${(a.documents||[]).length?'Add more paperwork':'Add paperwork'}</button>`:'';
 return `<article class="story-entry${essentialTone?` essential-tone-${essentialTone}`:''}"><div class="story-gutter"><i class="${dot}"></i><span></span></div><div class="story-card${target?' story-card-openable':''}"${targetAttrs}><div class="story-head"><strong>${esc(a.title||activityLabel(a.type))}</strong>${target?'<span class="story-open" aria-hidden="true">›</span>':''}</div><p class="story-meta">${meta.join(' · ')}</p>${a.body?`<p class="story-body">${esc(a.body)}</p>`:''}${photoPreview}${calendar?`<div class="story-calendar">${calendar}</div>`:''}${evidence}${evidenceAction?`<div class="story-evidence-actions">${evidenceAction}</div>`:''}</div></article>`
}
const EVENT_TYPE_ORDER=['mot_test','service','maintenance','repair','fuel','expense','mileage','document','photo','note','modification','purchase','valuation','mot','tax','insurance','mot_due','tax_due','service_due','insurance_due','reminder'];

function eventFilterOptions(v){
 const present=[...new Set(timeFeedItems(v).map(a=>a.type))];
 const ordered=EVENT_TYPE_ORDER.filter(type=>present.includes(type));
 const extras=present.filter(type=>!EVENT_TYPE_ORDER.includes(type));
 return [...ordered,...extras]
}
function eventTypeEnabled(v,type){return eventFilterState[v.id]?.[type]!==false}
function filteredTimeFeedItems(v){return timeFeedItems(v).filter(a=>eventTypeEnabled(v,a.type))}
function timelinePeriod(a){const d=daysUntil(a?.date);if(d===0)return 'today';return d!==null&&Number.isFinite(d)&&d>0?'upcoming':'past'}
function eventFilterMarkup(v){
 const types=eventFilterOptions(v);
 if(!types.length)return '';
 const hidden=types.filter(type=>!eventTypeEnabled(v,type)).length;
 return `<details class="organic-event-filter"><summary>Filter${hidden?` <span>${hidden}</span>`:''}</summary><div class="organic-event-filter-menu">${types.map(type=>`<label><input type="checkbox" data-event-type="${type}" ${eventTypeEnabled(v,type)?'checked':''}><span>${esc(activityLabel(type))}</span></label>`).join('')}</div></details>`
}


function timelineExportMarkup(){return `<details class="organic-timeline-export"><summary>Export</summary><div class="organic-timeline-export-menu"><button type="button" id="export-timeline-csv"><strong>CSV file</strong><small>Spreadsheet-friendly event data</small></button><button type="button" id="export-timeline-pdf"><strong>PDF file</strong><small>Readable vehicle timeline report</small></button></div></details>`}
function timelineExportItems(v){return timeFeedItems(v).slice().sort((a,b)=>new Date(a.date||0)-new Date(b.date||0))}
function csvCell(value){const text=String(value??'');return `"${text.replace(/"/g,'""')}"`}
function downloadTimelineCsv(v){const items=timelineExportItems(v);if(!items.length)return toast('There are no timeline events to export');const periodLabel=a=>({upcoming:'Upcoming',today:'Today',past:'Past'}[timelinePeriod(a)]||'Past');const rows=[['Period','Date','Event type','Service type','Garage / workshop','Title','Mileage','Cost','Notes','Paperwork','Photos','Source'],...items.map(a=>[periodLabel(a),String(a.date||'').slice(0,10),activityLabel(a.type),a.type==='service'?serviceTypeLabel(a.serviceType||''):'',a.type==='service'?(a.garageName||''):'',a.title||activityLabel(a.type),a.mileage??'',a.cost??'',a.body||'',(a.documents||[]).map(d=>d.name).join('; '),a.photoCount||a.photoIds?.length||0,a.sourceLabel|| (a.system?'Automatic':'Recorded')])];const csv='\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');const file=new File([csv],`${shareFileStem(v)}-timeline.csv`,{type:'text/csv;charset=utf-8'});saveBlobFile(file);toast('Timeline CSV saved')}
function pdfAscii(value){return String(value??'').replace(/£/g,'GBP ').replace(/[–—]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/…/g,'...').normalize('NFKD').replace(/[^\x20-\x7E\n]/g,'').replace(/\s+/g,' ').trim()}
function pdfEscape(value){return pdfAscii(value).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')}
function pdfWrap(value,max=84){const text=pdfAscii(value);if(!text)return [];const words=text.split(/\s+/);const out=[];let line='';for(const word0 of words){let word=word0;while(word.length>max){if(line){out.push(line);line=''}out.push(word.slice(0,max));word=word.slice(max)}const next=line?`${line} ${word}`:word;if(next.length>max){if(line)out.push(line);line=word}else line=next}if(line)out.push(line);return out}
function timelinePdfBlob(v){const items=timelineExportItems(v);if(!items.length)return null;const pages=[];let commands='',y=0;const pageWidth=595,pageHeight=842;const text=(x,yy,size,value,{bold=false,color='0.08 0.19 0.23'}={})=>{commands+=`${color} rg BT /F${bold?2:1} ${size} Tf 1 0 0 1 ${x} ${yy} Tm (${pdfEscape(value)}) Tj ET\n`};const line=(x1,y1,x2,y2,color='0.82 0.86 0.86')=>{commands+=`${color} RG 0.7 w ${x1} ${y1} m ${x2} ${y2} l S\n`};const startPage=()=>{if(commands)pages.push(commands);commands='0.075 0.192 0.227 rg 0 770 595 72 re f\n';text(36,810,18,'DriveHub',{bold:true,color:'1 1 1'});text(36,790,10,'Vehicle timeline export',{color:'0.78 0.87 0.85'});text(36,746,18,displayVehicleName(v),{bold:true});const vehicleMeta=[v.registration,v.mileage!=null?`${miles(v.mileage)} miles`:null].filter(Boolean).join('  |  ');if(vehicleMeta)text(36,727,10,vehicleMeta,{color:'0.35 0.47 0.49'});y=696};const ensure=(needed=60)=>{if(y-needed<60)startPage()};startPage();for(const a of items){const titleLines=pdfWrap(a.title||activityLabel(a.type),64);const noteLines=pdfWrap(a.body||'',88);const evidence=(a.documents||[]).map(d=>d.name).join('; '),photoCount=Number(a.photoCount||a.photoIds?.length||0);const evidenceLines=pdfWrap([evidence?`Paperwork: ${evidence}`:'',photoCount?`Photos: ${photoCount}`:''].filter(Boolean).join('  |  '),88);const meta=[a.type==='service'&&a.serviceType?serviceTypeLabel(a.serviceType):null,a.type==='service'&&a.garageName?a.garageName:null,a.mileage!==undefined&&a.mileage!==null&&a.mileage!==''?`${miles(a.mileage)} miles`:null,a.cost!==undefined&&a.cost!==null&&a.cost!==''?money(a.cost):null,a.sourceLabel||(a.system?'Automatic item':'Recorded event')].filter(Boolean).join('  |  ');const needed=48+titleLines.length*15+(meta?14:0)+noteLines.length*12+evidenceLines.length*12;ensure(Math.min(needed,180));const period=timelinePeriod(a),periodText=period==='today'?'TODAY':period==='upcoming'?'UPCOMING':'PAST';text(36,y,9,`${periodText}  |  ${fmtDate(a.date)}  |  ${activityLabel(a.type).toUpperCase()}`,{bold:true,color:period==='upcoming'?'0.12 0.45 0.34':period==='today'?'0.08 0.19 0.23':'0.35 0.47 0.49'});y-=19;for(const l of titleLines){ensure(24);text(36,y,13,l,{bold:true});y-=15}if(meta){ensure(20);text(36,y,9,meta,{color:'0.35 0.47 0.49'});y-=15}for(const l of noteLines){ensure(18);text(36,y,9,l,{color:'0.20 0.29 0.31'});y-=12}for(const l of evidenceLines){ensure(18);text(36,y,8.5,l,{color:'0.35 0.47 0.49'});y-=12}y-=8;line(36,y,559,y);y-=18}if(commands)pages.push(commands);const generated=pdfAscii(new Intl.DateTimeFormat('en-GB',{dateStyle:'long'}).format(new Date()));for(let i=0;i<pages.length;i++){pages[i]+=`0.35 0.47 0.49 rg BT /F1 8 Tf 1 0 0 1 36 28 Tm (Generated ${pdfEscape(generated)}) Tj ET\n`;pages[i]+=`0.35 0.47 0.49 rg BT /F1 8 Tf 1 0 0 1 500 28 Tm (Page ${i+1} of ${pages.length}) Tj ET\n`}const objects={1:'<< /Type /Catalog /Pages 2 0 R >>',3:'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',4:'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'};const kids=[];pages.forEach((content,i)=>{const pageId=5+i*2,contentId=6+i*2;kids.push(`${pageId} 0 R`);objects[pageId]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;objects[contentId]=`<< /Length ${content.length} >>\nstream\n${content}endstream`});objects[2]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;const maxId=Math.max(...Object.keys(objects).map(Number));let pdf='%PDF-1.4\n% DriveHub timeline\n';const offsets=new Array(maxId+1).fill(0);for(let id=1;id<=maxId;id++){offsets[id]=pdf.length;pdf+=`${id} 0 obj\n${objects[id]}\nendobj\n`}const xref=pdf.length;pdf+=`xref\n0 ${maxId+1}\n0000000000 65535 f \n`;for(let id=1;id<=maxId;id++)pdf+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${maxId+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return new Blob([pdf],{type:'application/pdf'})}
function downloadTimelinePdf(v){const blob=timelinePdfBlob(v);if(!blob)return toast('There are no timeline events to export');saveBlobFile(new File([blob],`${shareFileStem(v)}-timeline.pdf`,{type:'application/pdf'}));toast('Timeline PDF saved')}

function timeFeedMarkup(v){
 const all=timeFeedItems(v),items=filteredTimeFeedItems(v);
 if(!items.length){
  if(!all.length)return `<div class="organic-story-empty polished-empty">${appGlyph('clock')}<strong>Your Timeline starts here</strong><span>MOTs, servicing, paperwork and other history will appear automatically. You can also add something yourself.</span><button type="button" class="secondary" id="timeline-empty-add">Add first event</button></div>`;
  return `<div class="organic-story-empty polished-empty">${appGlyph('filter')}<strong>Nothing matches this filter</strong><span>Your Timeline still has ${all.length} item${all.length===1?'':'s'}.</span><button type="button" class="secondary" id="reset-timeline-filter">Show all Timeline items</button></div>`
 }
 const upcoming=items.filter(a=>timelinePeriod(a)==='upcoming').sort((a,b)=>new Date(a.date)-new Date(b.date));
 const today=items.filter(a=>timelinePeriod(a)==='today').sort((a,b)=>new Date(b.createdAt||b.updatedAt||b.date)-new Date(a.createdAt||a.updatedAt||a.date));
 const past=items.filter(a=>timelinePeriod(a)==='past').sort((a,b)=>new Date(b.date)-new Date(a.date));
 const upcomingHtml=upcoming.length?`<div class="story-period-label"><span>Upcoming</span></div>${upcoming.map(activityRow).join('')}`:'';
 const todayHtml=today.length?`<div class="story-period-label today"><span>Today</span></div>${today.map(activityRow).join('')}`:'';
 const hasLater=upcoming.length||today.length;
 const divider=hasLater&&past.length?`<div class="story-time-divider" role="separator" aria-label="Past events"><span>Past events</span></div>`:'';
 const pastHtml=past.length?`${!hasLater?`<div class="story-period-label past-only"><span>Past events</span></div>`:''}${past.map(activityRow).join('')}`:'';
 return `<div class="story-timeline">${upcomingHtml}${todayHtml}${divider}${pastHtml}</div>`
}
function motDefectRow(d){const sev=normaliseDefectType(d.type,d.dangerous);return `<div class="defect-row ${sev}"><span class="defect-severity">${defectLabel(sev)}</span><p>${esc(d.text||d.comment||'Defect')}</p></div>`}
function motIssueKey(value){return String(value||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\b(?:nearside|offside|front|rear|left|right|upper|lower)\b/g,' ').replace(/\s+/g,' ').trim()}
function motClearedAfterFail(tests,index){
 const current=tests[index];
 if(!current||!String(current.testResult||'').toUpperCase().includes('PASS'))return [];
 const previous=tests[index+1];
 if(!previous||!String(previous.testResult||'').toUpperCase().includes('FAIL'))return [];
 const gap=Math.abs(new Date(current.completedDate||0)-new Date(previous.completedDate||0))/86400000;
 if(!Number.isFinite(gap)||gap>45)return [];
 const currentKeys=new Set((current.defects||[]).map(d=>motIssueKey(d.text||d.comment)).filter(Boolean));
 return (previous.defects||[]).filter(d=>{const key=motIssueKey(d.text||d.comment);return key&&!currentKeys.has(key)});
}
function motTestCard(t,index,tests=[]){
 const passed=String(t.testResult||'').toUpperCase().includes('PASS'),defects=t.defects||[],cleared=motClearedAfterFail(tests,index);
 return `<article class="mot-test-card ${passed?'passed':'failed'}"><div class="mot-test-head"><div><span class="mot-date">${fmtDate(t.completedDate)}</span><strong>${t.odometerValue?`${miles(t.odometerValue)} ${esc(t.odometerUnit||'mi')}`:'Mileage unavailable'}</strong></div><span class="result-pill ${passed?'pass':'fail'}">${passed?'Passed':'Failed'}</span></div>${t.expiryDate?`<p class="mot-expiry">Certificate expiry: ${fmtDate(t.expiryDate)}</p>`:''}${defects.length?`<div class="defect-list">${defects.map(motDefectRow).join('')}</div>`:`<div class="clean-test"><span>✓</span><p>No defects or advisories recorded.</p></div>`}${cleared.length?`<div class="mot-cleared"><strong>Cleared since the previous failed test</strong>${cleared.map(d=>`<div><span>✓</span><p>${esc(d.text||d.comment||'Previous defect')}</p></div>`).join('')}<small>These items appeared on the previous failed MOT and were not recorded on this passing retest.</small></div>`:''}<details class="mot-meta"><summary>Test details</summary><div>${t.motTestNumber?`<span>Test number</span><strong>${esc(t.motTestNumber)}</strong>`:'<span>No test number recorded</span>'}</div></details></article>`
}
function motHistoryScore(v){
 const tests=motTests(v);
 const failures=tests.filter(t=>String(t.testResult||'').toUpperCase().includes('FAIL')).length;
 const failureItems=tests.filter(t=>String(t.testResult||'').toUpperCase().includes('FAIL')).flatMap(t=>(t.defects||[]).filter(d=>!['advisory','minor'].includes(normaliseDefectType(d.type,d.dangerous)))).length;
 const advisories=tests.flatMap(t=>t.defects||[]).filter(d=>['advisory','minor'].includes(normaliseDefectType(d.type,d.dangerous))).length;
 const latest=tests[0];
 const outstanding=(latest?.defects||[]).filter(d=>['advisory','minor'].includes(normaliseDefectType(d.type,d.dangerous))).length;
 const penalties={
  failures:Math.min(28,failures*7),
  failureItems:Math.min(24,failureItems*3),
  advisories:Math.min(15,Math.round(advisories*.75)),
  outstanding:Math.min(20,outstanding*4)
 };
 const totalPenalty=Object.values(penalties).reduce((sum,n)=>sum+n,0);
 const score=Math.max(0,Math.min(100,100-totalPenalty));
 const label=score>=85?'Strong':score>=70?'Good':score>=55?'Mixed':'Needs attention';
 return {score,label,failures,failureItems,advisories,outstanding,penalties,totalPenalty}
}
function motHistoryScreen(id){
 const v=vehicleById(id);if(!v)return garage();
 const intel=ownershipIntelligence(v),tests=intel.tests||[],total=intel.passes+intel.failures,passRate=total?Math.round(intel.passes/total*100):0,score=motHistoryScore(v);
 const motPoints=tests.map(t=>({date:t.completedDate,mileage:Number(t.odometerValue)})).filter(p=>p.date&&Number.isFinite(p.mileage)&&p.mileage>0).sort((a,b)=>new Date(a.date)-new Date(b.date));
 const motAnnualMileage=(()=>{if(motPoints.length<2)return null;const first=motPoints[0],last=motPoints.at(-1),yrs=yearsBetween(first.date,last.date),distance=last.mileage-first.mileage;if(!yrs||yrs<.2||distance<0)return null;const annual=distance/yrs;return annual<100000?Math.round(annual/100)*100:null})();
 const latestAdvisories=(intel.latestDefects||[]).filter(d=>['advisory','minor'].includes(d.severity));
 const latestMileage=motPoints.at(-1)?.mileage||null;
 if(!tests.length)return shell(`<div class="mot-history-page"><header class="organic-edit-head">${backButton('vehicle',v.id,'mot')}<div><p class="organic-kicker">MOT HISTORY</p><h1>${esc(displayVehicleName(v))}</h1></div></header><section class="mot-history-empty"><span>${appGlyph('clock')}</span><h2>No MOT history available</h2><p>Connect live MOT history for this vehicle, then refresh its data from DriveHub.</p></section></div>`,'garage',false);
 return shell(`<div class="mot-history-page">
  <header class="organic-edit-head mot-history-head">${backButton('vehicle',v.id,'mot')}<div><p class="organic-kicker">MOT HISTORY · ${esc(v.registration||'')}</p><h1>${esc(displayVehicleName(v))}</h1><p>${v.source?.dvsa?'Live DVSA MOT history':'Saved MOT history'}</p></div></header>
  <section class="mot-score-card"><div class="mot-score-main"><div><p class="organic-kicker">MOT SCORE</p><div class="mot-score-number"><strong>${score.score}</strong><span>/100</span></div><b>${esc(score.label)}</b></div><p>Starts at 100 and deducts points for failed MOTs, fail-causing items, advisories/minor defects and extra points for items still outstanding on the latest MOT. It reflects MOT history only, not the car’s overall mechanical condition.</p></div><div class="mot-score-breakdown"><div><span>Failed MOTs</span><strong>−${score.penalties.failures}</strong><small>${score.failures} recorded · 7 points each</small></div><div><span>Failure items</span><strong>−${score.penalties.failureItems}</strong><small>${score.failureItems} recorded · 3 points each</small></div><div><span>Advisories</span><strong>−${score.penalties.advisories}</strong><small>${score.advisories} across the history</small></div><div><span>Outstanding</span><strong>−${score.penalties.outstanding}</strong><small>${score.outstanding} on the latest MOT · 4 points each</small></div></div><details class="mot-score-method"><summary>How the score works</summary><p>Failure deductions are capped at 28 points, failure-item deductions at 24, historical advisory deductions at 15 and outstanding-item deductions at 20. The caps keep a long MOT history from being penalised simply for containing more tests.</p></details></section>
  <section class="mot-history-chart-card"><div class="mot-history-section-head"><div><p class="organic-kicker">MILEAGE</p><h2>Mileage over time</h2></div>${motAnnualMileage?`<span>${miles(motAnnualMileage)} mi/yr</span>`:''}</div>${mileageChart(motPoints)}</section>
  <section class="mot-history-summary"><article><span>Tests</span><strong>${tests.length}</strong><small>${intel.passes} passed · ${intel.failures} failed</small></article><article><span>Pass rate</span><strong>${passRate}%</strong><small>Across recorded MOT tests</small></article><article><span>Miles / year</span><strong>${motAnnualMileage?`${miles(motAnnualMileage)} mi`:'—'}</strong><small>Average from recorded MOT mileage</small></article><article><span>Latest mileage</span><strong>${latestMileage?`${miles(latestMileage)} mi`:'—'}</strong><small>${intel.latest?.completedDate?fmtDate(intel.latest.completedDate):'No date'}</small></article><article><span>Current advisories</span><strong>${latestAdvisories.length}</strong><small>On the latest MOT</small></article></section>
  <section class="mot-history-current ${latestAdvisories.length?'has-items':'clear'}"><div class="mot-history-section-head"><div><p class="organic-kicker">LATEST MOT</p><h2>${latestAdvisories.length?'Outstanding advisories':'Nothing outstanding'}</h2></div><span class="result-pill ${String(intel.latest?.testResult||'').toUpperCase().includes('PASS')?'pass':'fail'}">${String(intel.latest?.testResult||'').toUpperCase().includes('PASS')?'Passed':'Failed'}</span></div>${latestAdvisories.length?`<div class="mot-current-list">${latestAdvisories.map(d=>`<div><span>!</span><p>${esc(d.text||d.comment||'Advisory')}</p></div>`).join('')}</div>`:`<p class="mot-current-clear"><span>✓</span>No advisories or minor defects were recorded on the latest MOT.</p>`}</section>
  <section class="mot-history-results"><div class="mot-history-section-head"><div><p class="organic-kicker">TEST HISTORY</p><h2>Every MOT result</h2></div><span>${tests.length} test${tests.length===1?'':'s'}</span></div><div class="mot-timeline">${tests.map((t,i)=>motTestCard(t,i,tests)).join('')}</div></section>
 </div>`,'garage',false)
}

function photosTab(v){
 const photos=v.photos||[],main=mainPhoto(v),mainIndex=main?photos.indexOf(main):0;
 const picker=`<input class="hidden" id="vehicle-photo-picker" type="file" accept="image/*" multiple><p class="organic-photo-add-status hidden" id="vehicle-photo-status" aria-live="polite"></p>`;
 if(!photos.length)return `<section class="organic-photos"><div class="organic-section-row"><p class="organic-kicker">PHOTOS</p><button type="button" class="organic-text-action" id="add-photo">Add</button></div><button type="button" class="organic-photo-empty" id="add-photo-empty">${appGlyph('camera')}<strong>Add your first photo</strong><span>Exterior, interior, condition or service photos.</span></button>${picker}</section>`;
 const rest=photos.filter((_,i)=>i!==mainIndex);
 return `<section class="organic-photos">
  <div class="organic-section-row"><p class="organic-kicker">${photos.length} PHOTO${photos.length===1?'':'S'}${v.ownership?.purchaseDate?` · SINCE ${String(v.ownership.purchaseDate).slice(0,4)}`:''}</p><button type="button" class="organic-text-action" id="add-photo">Add</button></div>
  <button type="button" class="organic-featured-photo" data-nav="gallery" data-id="${v.id}" data-tab="${mainIndex}" aria-label="Open photo ${mainIndex+1} in gallery"><img src="${main.dataUrl}" alt="${esc(main.caption||fullVehicleName(v))}"></button>
  ${rest.length?`<div class="organic-photo-grid">${rest.map(p=>{const i=photos.indexOf(p);return `<button type="button" data-nav="gallery" data-id="${v.id}" data-tab="${i}" aria-label="Open photo ${i+1} in gallery"><img src="${p.dataUrl}" alt="${esc(p.caption||`Photo ${i+1}`)}"></button>`}).join('')}</div>`:''}
  <button type="button" class="organic-photo-fab" id="add-photo-fab">＋ Add photos</button>
  ${picker}
 </section>`
}

function galleryScreen(id,index=0){
 const v=vehicleById(id);if(!v)return garage();
 const photos=v.photos||[];
 if(!photos.length)return shell(`<div class="organic-update-screen"><header class="organic-edit-head">${backButton('vehicle',v.id,'photos')}<div><p class="organic-kicker">GALLERY</p><h1>No photos yet</h1></div></header><button class="primary" data-nav="vehicle" data-id="${v.id}" data-tab="photos">Back to Photos</button></div>`,'garage',false);
 const safeIndex=Math.max(0,Math.min(Number(index)||0,photos.length-1));
 const current=photos[safeIndex];
 return shell(`<div class="organic-gallery-page immersive-gallery" id="gallery-page" data-gallery-index="${safeIndex}" tabindex="-1">
  <div class="photo-gallery-frame">
   <div class="photo-gallery-track" id="photo-gallery-track" aria-label="Vehicle photo gallery">
    ${photos.map((p,i)=>`<div class="photo-gallery-slide" data-gallery-slide="${i}"><img src="${p.dataUrl}" alt="${esc(p.caption||`Vehicle photo ${i+1}`)}" draggable="false"></div>`).join('')}
   </div>
   <div class="gallery-top-chrome">
    <div class="gallery-photo-identity"><strong>${esc(displayVehicleName(v))}</strong><span><b id="gallery-current">${safeIndex+1}</b> / ${photos.length}</span></div>
    <button type="button" class="gallery-close-btn" data-nav="vehicle" data-id="${v.id}" data-tab="photos" aria-label="Close photo viewer">Close</button>
   </div>
   ${photos.length>1?`<button type="button" class="photo-nav prev" id="photo-prev" aria-label="Previous photo">‹</button><button type="button" class="photo-nav next" id="photo-next" aria-label="Next photo">›</button>`:''}
   <div class="gallery-zoom-controls" role="group" aria-label="Photo zoom controls">
    <button type="button" id="photo-zoom-out" aria-label="Zoom out">−</button>
    <button type="button" id="photo-zoom-reset" aria-label="Reset zoom">100%</button>
    <button type="button" id="photo-zoom-in" aria-label="Zoom in">＋</button>
   </div>
  </div>
  <div class="gallery-bottom-panel">
   ${photos.length>1?`<div class="gallery-filmstrip" id="gallery-filmstrip" aria-label="Photo thumbnails">${photos.map((p,i)=>`<button type="button" class="gallery-filmstrip-thumb ${i===safeIndex?'active':''}" data-gallery-thumb="${i}" aria-label="Show photo ${i+1}"><img src="${p.dataUrl}" alt=""></button>`).join('')}</div>`:''}
   <div class="gallery-detail-row">
    <div class="gallery-caption-wrap"><p class="photo-viewer-caption ${current.caption?'':'hidden'}" id="gallery-caption">${esc(current.caption||'')}</p><span class="gallery-view-hint">${photos.length>1?'Swipe to browse · ':''}Use + or double-click to zoom</span></div>
    <div class="photo-viewer-actions">
     <button type="button" class="gallery-main-btn" id="make-main-photo" ${current.primary?'disabled':''}>${current.primary?'✓ Main photo':'Set as main'}</button>
     <button type="button" class="gallery-trash-btn" id="remove-photo" aria-label="Remove photo">${appGlyph('trash')}</button>
    </div>
   </div>
  </div>
 </div>`,'garage',false)
}

function essentialsTab(v){
 const x=ownershipIntelligence(v),latest=x.latest,motDays=daysUntil(v.mot?.expiryDate);
 const latestPassed=latest&&String(latest.testResult||'').toUpperCase().includes('PASS');
 const latestAdvisories=(x.latestDefects||[]).filter(d=>d.severity==='advisory');
 const motDueText=!v.mot?.expiryDate?'Not set':motDays<0?`${Math.abs(motDays)} days overdue`:motDays===0?'Due today':`${motDays} days`;
 const motUrgent=motDays!==null&&motDays<=30;

 const service=servicePlan(v),previousServiceDate=service.lastDate,previousServiceMileage=service.lastMileage,nextServiceDate=service.nextDate,nextServiceDays=service.daysRemaining;
 const serviceUrgent=(nextServiceDays!==null&&nextServiceDays<=30)||(service.milesRemaining!==null&&service.milesRemaining<=1000);

 const taxDate=v.tax?.expiryDate||'';
 const taxDays=daysUntil(taxDate);
 const taxText=!taxDate?'Not set':taxDays<0?`${Math.abs(taxDays)} days overdue`:taxDays===0?'Due today':`${taxDays} days`;
 const taxStatus=v.tax?.status&&v.tax.status!=='Unknown'?v.tax.status:'';
 const taxUrgent=taxDays!==null&&taxDays<=30;

 const insuranceDate=v.insurance?.renewalDate||'';
 const insuranceDays=daysUntil(insuranceDate);
 const insuranceText=!insuranceDate?'Not set':insuranceDays<0?`${Math.abs(insuranceDays)} days overdue`:insuranceDays===0?'Due today':`${insuranceDays} days`;
 const insuranceUrgent=insuranceDays!==null&&insuranceDays<=30;
 const insurancePremium=Number(v.insurance?.premium||0);

 const systemNudges=state._prefs?.systemNudges||{};
 const reminderButton=(key,date,field)=>{
  const hasDate=Boolean(asDate(date));
  const icon=`<span class="organic-essential-reminder-icon">${navIcon('reminders')}</span>`;
  if(!hasDate){
   return `<button type="button" class="organic-essential-reminder needs-date" data-nav="edit" data-id="${v.id}" data-tab="${field}" aria-label="Enter ${esc(key)} date">${icon}<span>Enter date</span></button>`
  }
  const globalEnabled=systemNudges[key]!==false;
  if(!globalEnabled)return `<button type="button" class="organic-essential-reminder" data-nav="reminders" aria-label="Turn on ${esc(key)} reminders">${icon}<span>Reminders off</span></button>`;
  const enabled=systemNudgeEnabled(v,key);
  const label=enabled?'Reminder set':'Remind me';
  return `<button type="button" class="organic-essential-reminder ${enabled?'set':''}" data-vehicle-nudge="${esc(key)}" data-vehicle-id="${v.id}" aria-label="${esc(label)} for ${esc(key)}">${icon}<span>${label}</span></button>`
 };

 const dueCalendar=(kind,date,uid)=>date&&daysUntil(date)>=0?calendarButtonMarkup({
  title:`${displayVehicleName(v)} — ${kind}`,
  date,
  description:`${kind}${v.registration?` · ${v.registration}`:''}`,
  uid,
  label:'Calendar'
 }):'';

 return `<div class="organic-essentials">
  <section class="organic-essentials-intro">
   <p class="organic-kicker">ESSENTIALS</p>
   <h2>The important dates and records for this car</h2>
  </section>

  <section class="organic-essential-area mot-area ${motUrgent?'urgent':''}">
   <div class="organic-essential-area-head">
    <div><p class="organic-kicker">MOT</p><h2>MOT</h2>${provenanceTag(v,'mot.history',v.source?.dvsa?'dvsa':v.source?.dvla?'dvla':'saved',v.provenance?.lookupAt||'')}</div>
    <div class="organic-essential-area-head-actions">${reminderButton('mot',v.mot?.expiryDate,'motExpiry')}</div>
   </div>
   <div class="organic-essential-pair">
    <article class="organic-essential-detail">
     <span class="organic-essential-label">LAST MOT</span>
     <strong>${latest?fmtDate(latest.completedDate):'No MOT recorded'}</strong>
     ${latest?`<small>${latestPassed?'Passed':'Failed'}${latest.odometerValue?` · ${miles(latest.odometerValue)} miles`:''}</small>`:'<small>Add the MOT date manually if needed.</small>'}
    </article>
    <article class="organic-essential-detail next ${motUrgent?'urgent':''}">
     <span class="organic-essential-label">NEXT MOT</span>
     <strong>${esc(motDueText)}</strong>
     <small>${v.mot?.expiryDate?fmtDate(v.mot.expiryDate):'Add an MOT expiry date.'}</small>
     ${dueCalendar('MOT due',v.mot?.expiryDate,`mot-${v.id}-${v.mot?.expiryDate||''}`)}
    </article>
   </div>
   <div class="organic-essential-advisories">
    <div class="organic-essential-subhead"><span>Advisories from last MOT</span><b>${latestAdvisories.length}</b></div>
    ${latestAdvisories.length?`<ul>${latestAdvisories.map(d=>`<li>${esc(d.text||d.comment||'Advisory recorded')}</li>`).join('')}</ul>`:`<p>${latest?'No advisories recorded on the latest MOT.':'No MOT record available yet.'}</p>`}
   </div>
   ${motTests(v).length?`<button type="button" class="organic-mot-history-link" data-nav="mothistory" data-id="${v.id}"><span><strong>View full MOT history</strong><small>MOT score ${motHistoryScore(v).score}/100 · Mileage, advisories and every test result</small></span><b>›</b></button>`:''}
  </section>

  <section class="organic-essential-area service-area ${serviceUrgent?'urgent':''}">
   <div class="organic-essential-area-head"><div><p class="organic-kicker">SERVICE</p><h2>Service & maintenance</h2>${provenanceTag(v,'service.lastServiceDate',service.latest?'timeline':'manual',service.latest?.updatedAt||service.latest?.date||'')}</div><div class="organic-essential-area-head-actions">${reminderButton('service',nextServiceDate,'nextServiceDate')}</div></div>
   <div class="organic-essential-pair service-summary-pair">
    <article class="organic-essential-detail">
     <span class="organic-essential-label">LAST SERVICED</span>
     <strong>${service.milesSince!==null?`${miles(service.milesSince)} miles ago`:previousServiceDate?fmtDate(previousServiceDate):'Not recorded'}</strong>
     <small>${[service.lastType?serviceTypeLabel(service.lastType):'',service.garageName,previousServiceDate?fmtDate(previousServiceDate):'',previousServiceMileage?`at ${miles(previousServiceMileage)} miles`:null].filter(Boolean).map(esc).join(' · ')||'Record a service to start the maintenance history.'}</small>
    </article>
    <article class="organic-essential-detail next ${serviceUrgent?'urgent':''}">
     <span class="organic-essential-label">NEXT SERVICE</span>
     <strong>${esc(service.headline)}</strong>
     <small>${service.detail?`${esc(service.detail)}${service.daysRemaining!==null&&service.milesRemaining!==null?' · whichever comes first':''}`:'Set a date, mileage target, or both when recording a service.'}</small>
     ${dueCalendar('Service due',nextServiceDate,`service-${v.id}-${nextServiceDate}`)}
    </article>
   </div>
   <div class="service-maintenance-actions"><button type="button" class="organic-service-record" data-nav="addupdateform" data-id="${v.id}" data-tab="service"><span>${appGlyph('service')}</span><span><strong>Record service</strong><small>Type, garage, mileage, cost and paperwork</small></span><b>›</b></button></div>
   ${service.records.length?`<div class="service-history-block"><div class="organic-essential-subhead"><span>Service history</span><b>${service.records.length}</b></div><div class="service-history-list">${service.records.slice(0,4).map(item=>{const docs=activeDocuments(v).filter(d=>d.activityId===item.id).length,photos=(item.photoIds||[]).length;return `<button type="button" class="service-history-row" data-nav="editevent" data-id="${v.id}" data-tab="${item.id}"><span class="service-history-date">${fmtDate(item.date)}</span><span class="service-history-main"><strong>${esc((item.serviceType?serviceTypeLabel(item.serviceType):'Service'))}</strong><small>${[item.garageName,item.mileage?`${miles(item.mileage)} mi`:null,item.cost!=null?money(item.cost):null,docs?`${docs} document${docs===1?'':'s'}`:null,photos?`${photos} photo${photos===1?'':'s'}`:null].filter(Boolean).map(esc).join(' · ')}</small></span><b>›</b></button>`}).join('')}</div></div>`:''}
  </section>

  <section class="organic-essential-area tax-area ${taxUrgent?'urgent':''}">
   <div class="organic-essential-area-head"><div><p class="organic-kicker">TAX</p><h2>Tax</h2>${provenanceTag(v,'tax.expiryDate',v.source?.dvla?'dvla':taxDate?'manual':'saved',v.provenance?.lookupAt||'')}</div><div class="organic-essential-area-head-actions">${reminderButton('tax',taxDate,'taxExpiry')}</div></div>
   <article class="organic-essential-detail tax-detail ${taxUrgent?'urgent':''}">
    <span class="organic-essential-label">TAX DUE</span>
    <strong>${esc(taxText)}</strong>
    <small>${taxDate?fmtDate(taxDate):'Add a tax due date.'}${taxStatus?` · ${esc(taxStatus)}`:''}</small>
    ${dueCalendar('Tax due',taxDate,`tax-${v.id}-${taxDate}`)}
   </article>
  </section>

  <section class="organic-essential-area insurance-area ${insuranceUrgent?'urgent':''}">
   <div class="organic-essential-area-head"><div><p class="organic-kicker">INSURANCE</p><h2>Insurance</h2>${provenanceTag(v,'insurance.renewalDate',insuranceDate?'manual':'saved')}</div><div class="organic-essential-area-head-actions">${reminderButton('insurance',insuranceDate,'insuranceRenewalDate')}</div></div>
   <article class="organic-essential-detail insurance-detail ${insuranceUrgent?'urgent':''}">
    <span class="organic-essential-label">RENEWAL DUE</span>
    <strong>${esc(insuranceText)}</strong>
    <small>${insuranceDate?fmtDate(insuranceDate):'Add an insurance renewal date.'}${insurancePremium?` · ${money(insurancePremium)} premium`:''}</small>
    ${dueCalendar('Insurance renewal',insuranceDate,`insurance-${v.id}-${insuranceDate}`)}
   </article>
  </section>

 </div>`
}
function historyTab(v){
 const count=timeFeedItems(v).length;
 return `<section class="organic-story"><div class="organic-story-intro"><div><p class="organic-kicker">COMPLETE HISTORY</p><strong>${count} timeline item${count===1?'':'s'}</strong><span>MOTs, mileage, servicing, photos, paperwork and important dates come together here automatically.</span></div></div><div class="organic-story-top"><div class="organic-story-tools">${eventFilterMarkup(v)}${timelineExportMarkup()}</div><button type="button" class="organic-round-add" id="open-action-picker" data-nav="addupdate" data-id="${v.id}" aria-label="Add event">＋</button></div><div id="history-list">${timeFeedMarkup(v)}</div></section>`
}
function detailRow(label,value){return `<div class="detail-row"><span>${esc(label)}</span><strong>${value?esc(value):'—'}</strong></div>`}
function detailsTab(v){return `<div class="stack"><div class="card"><div class="row"><h2 class="section-title">Vehicle</h2><button class="text-btn" data-nav="edit" data-id="${v.id}">Edit</button></div>${detailRow('Registration',v.registration)}${detailRow('Make',v.make)}${detailRow('Model',v.model)}${detailRow('Derivative / trim',v.derivative)}${detailRow('Year',v.year)}${detailRow('Colour',v.colour)}${detailRow('Body type',v.bodyType)}${detailRow('Engine',v.engineSize)}${detailRow('Fuel',v.fuelType)}${detailRow('Transmission',v.transmission)}${detailRow('VIN',v.vin)}</div><div class="card"><h2 class="section-title">Ownership</h2>${detailRow('Purchase date',v.ownership?.purchaseDate?fmtDate(v.ownership.purchaseDate):'')}${detailRow('Purchase price',v.ownership?.purchasePrice?money(v.ownership.purchasePrice):'')}</div><div class="card"><h2 class="section-title">Service plan</h2>${detailRow('Last service',v.service?.lastServiceDate?fmtDate(v.service.lastServiceDate):'')}${detailRow('Last service mileage',v.service?.lastServiceMileage?`${miles(v.service.lastServiceMileage)} miles`:'')}${detailRow('Next service',v.service?.nextServiceDate?fmtDate(v.service.nextServiceDate):'')}${detailRow('Next service mileage',v.service?.nextServiceMileage?`${miles(v.service.nextServiceMileage)} miles`:'')}</div><button class="danger full" id="delete-car">Remove vehicle</button></div>`}


function carDetailsTab(v){
 return `<section class="organic-car-details">
  <div class="organic-car-details-toolbar">
   <div><p class="organic-kicker">CAR DETAILS</p><h2>Full car profile</h2><p>The same complete profile layout used when sharing this car.</p></div>
   <button type="button" class="organic-car-details-share" id="share-car-details">${appGlyph('share')} Share</button>
  </div>
  <div class="organic-car-details-frame-wrap">
   <iframe id="car-details-frame" class="organic-car-details-frame" title="${esc(displayVehicleName(v))} full car profile"></iframe>
  </div>
 </section>`
}

function vehicle(id,tab='overview'){
 const v=vehicleById(id);if(!v)return garage();
 if(tab==='history')tab='story';else if(tab==='documents')tab='paperwork';
 const displayTab=tab==='story-add'?'story':tab;
 const content=displayTab==='mot'?essentialsTab(v):displayTab==='photos'?photosTab(v):displayTab==='story'?historyTab(v):displayTab==='paperwork'?documentsTab(v):displayTab==='details'?carDetailsTab(v):overviewTab(v);
 return shell(`${vehicleHeader(v)}${vehicleTabs(v,displayTab)}<div class="organic-tab-content">${content}</div>`,'garage')
}

function addVehiclePhotos(id){
 const v=vehicleById(id);if(!v)return garage();
 const photos=v.photos||[],main=mainPhoto(v);
 return shell(`<div class="organic-add-flow organic-add-photos-flow">
  <header class="organic-add-head"><button class="organic-close" data-nav="garage" aria-label="Close">×</button><span>Photos</span></header>
  <section class="organic-photo-onboarding">
   <div class="organic-add-page-title"><h1>Add some photos</h1><p>Pick one or several images now. You can always add more later.</p></div>
   ${main?`<div class="organic-photo-onboarding-preview"><img src="${main.dataUrl}" alt="${esc(fullVehicleName(v))}"><span>${photos.length} photo${photos.length===1?'':'s'} added</span></div>`:`<div class="organic-photo-onboarding-empty">${appGlyph('camera')}<strong>${esc(displayVehicleName(v))}</strong><span>Add exterior, interior or condition photos. You can add up to 8.</span></div>`}
   <button class="organic-photo-onboarding-add" id="add-car-photos" type="button">${appGlyph('camera')}<span><strong>${photos.length?'Add more photos':'Add photos'}</strong><small>Choose one or more images</small></span><b>›</b></button>
   <input class="hidden" id="add-car-photo-picker" type="file" accept="image/*" multiple>
   <p class="organic-photo-onboarding-status hidden" id="add-car-photo-status" aria-live="polite"></p>
   ${photos.length?`<div class="organic-photo-onboarding-thumbs">${photos.slice(0,6).map((p,i)=>`<div><img src="${p.dataUrl}" alt="${esc(p.caption||`Vehicle photo ${i+1}`)}"></div>`).join('')}</div>`:''}
   <div class="organic-photo-onboarding-actions">
    <button class="organic-dark-submit" data-nav="vehicle" data-id="${v.id}" data-tab="overview">${photos.length?'Done':'Skip for now'}</button>
    ${photos.length?`<button class="text-btn full" data-nav="vehicle" data-id="${v.id}" data-tab="photos">Open photo gallery</button>`:''}
   </div>
  </section>
 </div>`,'garage',false)
}
function editVehicle(id){
 const v=vehicleById(id);if(!v)return garage();
 const specs=(v.specification||[]).filter(x=>!x._deleted);
 const specRows=specs.length?specs.map((s,i)=>{const text=[s.label,s.value].filter(Boolean).join(s.label&&s.value?' — ':'');return `<div class="organic-spec-row" data-spec-row data-spec-id="${esc(s.id||'')}"><input class="organic-spec-single" data-spec-text value="${esc(text)}" placeholder="e.g. 420 bhp, Custom Pack, Michelin PS4S"><button type="button" class="organic-spec-remove" data-spec-remove aria-label="Remove specification row">−</button></div>`}).join(''):'';
 return shell(`<div class="organic-edit-head">${backButton('vehicle',v.id,'overview')}<div><p class="organic-kicker">${esc(v.registration)}</p><h1>Edit ${esc(displayVehicleName(v))}</h1></div></div><form id="edit-form" class="stack" data-guard-unsaved><section class="card"><h2>Vehicle</h2><div class="form-grid two"><div class="field"><label>Nickname</label><input name="nickname" value="${esc(v.nickname||'')}" placeholder="e.g. Sally"></div><div class="field"><label>Registration</label><input name="registration" data-registration-input autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(v.registration)}"></div><div class="field"><label>Make</label><input name="make" value="${esc(v.make)}">${provenanceHint(v,'make')}</div><div class="field"><label>Model</label><input name="model" value="${esc(v.model)}">${provenanceHint(v,'model')}</div><div class="field"><label>Derivative / trim</label><input name="derivative" value="${esc(v.derivative)}"></div><div class="field"><label>Year</label><input name="year" value="${esc(v.year)}">${provenanceHint(v,'year')}</div><div class="field"><label>Colour</label><input name="colour" value="${esc(v.colour)}">${provenanceHint(v,'colour')}</div><div class="field"><label>Body type</label><input name="bodyType" value="${esc(v.bodyType)}">${provenanceHint(v,'bodyType')}</div><div class="field"><label>Fuel</label><input name="fuelType" value="${esc(v.fuelType)}">${provenanceHint(v,'fuelType')}</div><div class="field"><label>Engine</label><input name="engineSize" value="${esc(v.engineSize)}">${provenanceHint(v,'engineSize')}</div><div class="field"><label>Transmission</label><input name="transmission" value="${esc(v.transmission)}">${provenanceHint(v,'transmission')}</div><div class="field"><label>Current mileage</label><input name="mileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input value="${mileageFieldValue(v.mileage)}"></div><div class="field"><label>VIN</label><input name="vin" value="${esc(v.vin)}"></div></div></section><section class="card organic-spec-card"><div class="organic-spec-head"><div><p class="organic-kicker">SPECIFICATION</p><h2>Extra details</h2><p>Add anything useful that doesn’t fit the standard fields.</p></div><button type="button" class="organic-spec-add" id="add-spec-row" aria-label="Add specification row">＋</button></div><div class="organic-spec-list" id="spec-list">${specRows}</div><button type="button" class="organic-spec-empty-add ${specs.length?'hidden':''}" id="add-first-spec">＋ Add a specification</button></section><section class="card"><h2>Ownership & dates</h2><div class="form-grid two"><div class="field"><label>MOT expiry</label><input name="motExpiry" type="date" value="${esc(v.mot?.expiryDate||'')}">${provenanceHint(v,'mot.expiryDate')}</div><div class="field"><label>Tax expiry</label><input name="taxExpiry" type="date" value="${esc(v.tax?.expiryDate||'')}">${provenanceHint(v,'tax.expiryDate')}</div><div class="field"><label>Tax status</label><select name="taxStatus"><option ${v.tax?.status==='Unknown'?'selected':''}>Unknown</option><option ${v.tax?.status==='Taxed'?'selected':''}>Taxed</option><option ${v.tax?.status==='SORN'?'selected':''}>SORN</option><option ${v.tax?.status==='Untaxed'?'selected':''}>Untaxed</option></select>${provenanceHint(v,'tax.status')}</div><div class="field"><label>Purchase date</label><input name="purchaseDate" type="date" value="${esc(v.ownership?.purchaseDate||'')}"></div><div class="field"><label>Purchase price</label><input name="purchasePrice" type="number" value="${v.ownership?.purchasePrice??''}"></div><div class="field service-history-managed"><label>Last service</label><div class="service-managed-value"><strong>${servicePlan(v).lastDate?fmtDate(servicePlan(v).lastDate):'Not recorded'}</strong><small>Record or edit completed services from Timeline so the maintenance history stays complete.</small></div></div><div class="field"><label>Next service</label><input name="nextServiceDate" type="date" value="${esc(v.service?.nextServiceDate||'')}"></div><div class="field"><label>Next service mileage</label><input name="nextServiceMileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input value="${mileageFieldValue(v.service?.nextServiceMileage)}"></div><div class="field"><label>Insurance renewal</label><input name="insuranceRenewalDate" type="date" value="${esc(v.insurance?.renewalDate||'')}"></div><div class="field"><label>Insurance premium</label><input name="insurancePremium" type="number" value="${v.insurance?.premium??''}"></div></div></section><div class="organic-form-actions"><button class="organic-dark-submit" type="submit">Save changes</button></div><button class="organic-danger-link" type="button" id="delete-car">Remove vehicle</button></form>`,'garage',false)
}

function addUpdateScreen(id){
 const v=vehicleById(id);if(!v)return garage();
 const items=[
  ['fuel','Log a fill-up','Fuel cost and mileage'],
  ['mileage','Update mileage','Keep the odometer current'],
  ['service','Record service','Service date, mileage and cost'],
  ['maintenance','Maintenance','Tyres, brakes and routine jobs'],
  ['repair','Repair','Faults and repairs'],
  ['expense','Expense','Insurance or other costs'],
  ['modification','Modification','Changes made to the car'],
  ['note','Note','Anything else worth keeping']
 ];
 return shell(`<div class="organic-update-screen">
  <header class="organic-edit-head">
   ${backButton('vehicle',v.id,'story')}
   <div><p class="organic-kicker">${esc(v.registration)}</p><h1>Add an event</h1></div>
  </header>
  <p class="organic-update-screen-intro">What event do you want to record for ${esc(displayVehicleName(v))}?</p>
  <div class="organic-update-type-grid">
   ${items.map(([type,title,body])=>`<button type="button" data-nav="addupdateform" data-id="${v.id}" data-tab="${type}"><span>${activityIcon(type)}</span><div><strong>${title}</strong><small>${body}</small></div><b>›</b></button>`).join('')}
  </div>
 </div>`,'garage',false)
}

function eventFormScreen(v,type='note',existing=null,{backToStory=false}={}){
 const valid=['fuel','mileage','service','maintenance','repair','expense','modification','note'];
 if(!valid.includes(type))type='note';
 const editing=!!existing;
 const isMileage=type==='mileage',isService=type==='service';
 const labels={fuel:'Log a fill-up',note:'Add note',service:'Record service',maintenance:'Add maintenance',repair:'Add repair',expense:'Add expense',mileage:'Update mileage',modification:'Add modification'};
 const back=editing?backButton('vehicle',v.id,'story'):backToStory?backButton('vehicle',v.id,'story'):backButton('addupdate',v.id);
 const title=editing?`Edit ${activityLabel(type).toLowerCase()}`:(labels[type]||'Add event');
 const linkedDocs=editing?activeDocuments(v).filter(d=>d.activityId===existing.id):[];
 const linkedPhotos=editing?(existing.photoIds||[]).map(id=>(v.photos||[]).find(p=>p.id===id)).filter(Boolean):[];
 return shell(`<div class="organic-update-screen organic-update-form-screen">
  <header class="organic-edit-head">
   ${back}
   <div><p class="organic-kicker">${esc(activityLabel(type).toUpperCase())}</p><h1>${esc(title)}</h1></div>
   ${editing?`<button class="organic-event-delete-top" type="button" id="delete-event-screen" aria-label="Delete event" title="Delete event">${appGlyph('trash')}</button>`:''}
  </header>
  <form id="update-screen-form" class="stack" data-guard-unsaved>
   <input type="hidden" name="type" value="${esc(type)}">
   <input type="hidden" name="eventId" value="${esc(existing?.id||'')}">
   <section class="card">
    <div class="organic-event-type-lock"><span>Event type</span><strong>${esc(activityLabel(type))}</strong></div>
    <div class="field"><label>Title</label><input name="title" value="${esc(existing?.title||'')}" placeholder="What happened?" required></div>
    ${isService?`<div class="form-grid two service-detail-fields"><div class="field"><label>Service type</label><select name="serviceType" required><option value="">Choose service type</option>${SERVICE_TYPES.map(([value,label])=>`<option value="${value}" ${String(existing?.serviceType||'')===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="field"><label>Garage / workshop <span class="optional">Optional</span></label><input name="garageName" value="${esc(existing?.garageName||'')}" placeholder="Who carried out the work?"></div></div>`:''}
    <div class="form-grid two">
     <div class="field"><label>Date</label><input name="date" type="date" value="${esc(existing?.date||new Date().toISOString().slice(0,10))}" required></div>
     <div class="field"><label>Mileage${isMileage||isService?'':' (optional)'}</label><input name="mileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input value="${mileageFieldValue(existing?.mileage??((isMileage||isService)?Number(v.mileage||0):''))}" ${isMileage||isService?'required':''}></div>
    </div>
    ${!isMileage?`<div class="field"><label>Cost (optional)</label><input name="cost" type="number" min="0" step="0.01" value="${existing?.cost??''}" placeholder="0"></div>`:''}
    <div class="field"><label>${isService?'Work carried out / notes':'Notes'} (optional)</label><textarea name="body" placeholder="${isService?'Oil, filters, inspection...':'Add useful detail'}">${esc(existing?.body||'')}</textarea></div>
    ${isService?`<div class="service-next-plan"><div><strong>Plan the next service</strong><small>DriveHub will track both targets and show whichever comes first.</small></div><div class="form-grid two"><div class="field"><label>Next service date <span class="optional">Optional</span></label><input name="nextServiceDate" type="date" value="${esc(existing?existing.nextServiceDate||'':'')}"></div><div class="field"><label>Next service mileage <span class="optional">Optional</span></label><input name="nextServiceMileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input value="${mileageFieldValue(existing?existing.nextServiceMileage:'')}"></div></div></div>`:''}
    ${`<div class="event-attachment-grid"><div class="field"><label>Paperwork <span class="optional">Optional</span></label><label class="inline-file-picker"><span>${appGlyph('document')}</span><div><strong>${editing?'Add more paperwork':'Attach invoice or receipt'}</strong><small>PDF or images · multiple files · up to 10 MB each</small></div><input id="update-screen-documents" type="file" accept="application/pdf,image/*,.pdf" multiple></label><p class="muted small" id="update-screen-document-selection">${linkedDocs.length?`${linkedDocs.length} existing document${linkedDocs.length===1?'':'s'} linked to this event.`:'No files selected.'}</p></div><div class="field"><label>Photos <span class="optional">Optional</span></label><label class="inline-file-picker"><span>${appGlyph('camera')}</span><div><strong>${editing?'Add more photos':'Attach photos'}</strong><small>Add condition, work or receipt photos</small></div><input id="update-screen-photos" type="file" accept="image/*" multiple></label><p class="muted small" id="update-screen-photo-selection">${linkedPhotos.length?`${linkedPhotos.length} existing photo${linkedPhotos.length===1?'':'s'} linked to this event.`:'No photos selected.'}</p></div></div>`}
   </section>
   <div class="organic-form-actions"><button class="organic-dark-submit" type="submit">${editing?'Save changes':`Save ${esc(activityLabel(type).toLowerCase())}`}</button></div>
  </form>
 </div>`,'garage',false)
}

function addUpdateFormScreen(id,type='note'){
 const v=vehicleById(id);if(!v)return garage();
 const fromTimeline=type==='service_due';
 return eventFormScreen(v,fromTimeline?'service':type,null,{backToStory:fromTimeline})
}

function editEventScreen(id,eventId=''){
 const v=vehicleById(id);if(!v)return garage();
 const existing=activeActivity(v).find(a=>a.id===eventId);
 if(!existing)return vehicle(id,'story');
 return eventFormScreen(v,existing.type||'note',existing)
}
function essentialEventScreen(id,type='mot_due'){
 const v=vehicleById(id);if(!v)return garage();
 const key=essentialEventKey(type);
 if(!key)return vehicle(id,'story');
 const label=activityLabel(type),date=essentialEventDate(v,type),note=String(v.essentialEventNotes?.[key]||'');
 return shell(`<div class="organic-update-screen organic-update-form-screen essential-event-edit-screen">
  <header class="organic-edit-head">
   ${backButton('vehicle',v.id,'story')}
   <div><p class="organic-kicker">${esc(label.toUpperCase())}</p><h1>Edit ${esc(label.toLowerCase())}</h1></div>
  </header>
  <form id="essential-event-form" class="stack" data-guard-unsaved data-essential-type="${esc(type)}">
   <section class="card">
    <div class="organic-event-type-lock"><span>Timeline item</span><strong>${esc(label)}</strong></div>
    <div class="field"><label>Date</label><input name="date" type="date" value="${esc(date)}" required></div>
    <div class="field"><label>Note <span class="optional">Optional</span></label><textarea name="note" placeholder="Add anything useful about this upcoming ${esc(label.toLowerCase())}">${esc(note)}</textarea></div>
   </section>
   <div class="organic-form-actions"><button class="organic-dark-submit" type="submit">Save changes</button></div>
  </form>
 </div>`,'garage',false)
}
function activityModal(v,type='note',existing=null){
 const isMileage=type==='mileage',isService=type==='service',editing=!!existing;const labels={fuel:'Log a fill-up',note:'Add note',service:'Record service',maintenance:'Add maintenance',repair:'Add repair',expense:'Add expense',mileage:'Update mileage',modification:'Add modification'};const defaults={fuel:'Fuel fill-up',note:'',service:'Service',maintenance:'Maintenance',repair:'Repair',expense:'Expense',mileage:'Mileage update',modification:'Modification'};
 return `<div class="modal-backdrop" id="activity-modal"><div class="modal-sheet"><div class="modal-handle"></div><div class="row"><div><span class="pill">${activityIcon(type)} ${activityLabel(type)}</span><h2>${editing?'Edit '+activityLabel(type).toLowerCase():(labels[type]||'Add event')}</h2></div><button class="icon-btn" id="close-modal">✕</button></div><form id="activity-form" class="stack"><input type="hidden" name="type" value="${type}"><input type="hidden" name="activityId" value="${existing?.id||''}"><div class="field"><label>Title</label><input name="title" value="${esc(existing?.title??defaults[type]??'')}" placeholder="What happened?" required></div><div class="form-grid two"><div class="field"><label>Date</label><input name="date" type="date" value="${esc(existing?.date||new Date().toISOString().slice(0,10))}" required></div><div class="field"><label>Mileage${isMileage?'':' (optional)'}</label><input name="mileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input value="${mileageFieldValue(existing?.mileage??(isMileage?Number(v.mileage||0):''))}" ${isMileage?'required':''}></div></div>${!isMileage?`<div class="field"><label>Cost (optional)</label><input name="cost" type="number" min="0" step="0.01" value="${existing?.cost??''}" placeholder="0"></div>`:''}<div class="field"><label>${isService?'Work carried out / notes':'Notes'} (optional)</label><textarea name="body" placeholder="${isService?'Oil, filters, inspection...':'Add useful detail'}">${esc(existing?.body||'')}</textarea></div>${isService?`<div class="form-grid two"><div class="field"><label>Next service date (optional)</label><input name="nextServiceDate" type="date" value="${esc(existing?.nextServiceDate||'')}"></div><div class="field"><label>Next service mileage (optional)</label><input name="nextServiceMileage" type="text" inputmode="numeric" pattern="[0-9,]*" data-mileage-input value="${mileageFieldValue(existing?.nextServiceMileage)}"></div></div>`:''}${!isMileage?`<div class="field"><label>Paperwork <span class="optional">Optional</span></label><label class="inline-file-picker"><span>${appGlyph('document')}</span><div><strong>Attach invoice or receipt</strong><small>PDF or images · multiple files · up to 10 MB each</small></div><input id="activity-documents" type="file" accept="application/pdf,image/*,.pdf" multiple></label><p class="muted small" id="activity-document-selection">${editing?`${activeDocuments(v).filter(d=>d.activityId===existing?.id).length} existing attachment${activeDocuments(v).filter(d=>d.activityId===existing?.id).length===1?'':'s'}`:'No files selected.'}</p></div>`:''}<button class="primary full" type="submit">${editing?'Save changes':'Save '+activityLabel(type).toLowerCase()}</button>${editing?'<button class="danger full" type="button" id="delete-activity">Delete record</button>':''}</form></div></div>`
}


function reminderDeliveryLabel(){return 'Uses notification settings'}
function reminderDeliveryIcon(value){return value==='email'?'@':value==='both'?'↗':'●'}

function docs(){
 const rows=state.vehicles.flatMap(v=>activeDocuments(v).map(d=>({v,d}))).sort((a,b)=>new Date(b.d.date||b.d.createdAt)-new Date(a.d.date||a.d.createdAt));
 const grouped=state.vehicles.map(v=>({v,docs:rows.filter(x=>x.v.id===v.id)})).filter(x=>x.docs.length);
 return shell(`<header class="organic-screen-head"><p class="organic-kicker">DOCS</p><h1>Your paperwork</h1><p>Everything you’ve kept with your cars, in one place.</p></header>${grouped.length?grouped.map(g=>`<section class="global-doc-group"><div class="organic-group-head"><span>${esc(displayVehicleName(g.v))}</span><button data-nav="vehicle" data-id="${g.v.id}" data-tab="paperwork">Open car</button></div><div class="organic-paperwork-list">${g.docs.slice(0,5).map(({d})=>`<button class="global-doc-row" data-global-document="${d.id}" data-vehicle-id="${g.v.id}" aria-label="Open ${esc(d.name)}">${documentThumbMarkup(d)}<span><strong>${esc(d.name)}</strong><small>${esc(d.category||'Paperwork')} · ${fmtDate(d.date||d.createdAt)}</small>${d.note?`<span class="paperwork-note-preview">${esc(d.note)}</span>`:''}</span><b>›</b></button>`).join('')}</div></section>`).join(''):`<div class="organic-global-empty">${appGlyph('document')}<h2>No paperwork yet</h2><p>Add a document from any car’s Paperwork tab.</p><button class="primary" data-nav="garage">Choose a car</button></div>`}`,'settings')
}

function reminders(){
 const prefs=state._prefs||{nudgeDelivery:'app',systemNudges:{mot:true,service:true,tax:true,insurance:true}};
 const delivery='app',system=prefs.systemNudges||{};
 const deliveryText=notificationPrefs().enabled?'through your enabled channels':'in DriveHub';
 const sysRows=[
  {key:'mot',title:'MOT',body:`Three weeks before · ${deliveryText}`,tone:'mot',icon:appGlyph('clock')},
  {key:'service',title:'Service',body:`Three weeks before · ${deliveryText}`,tone:'service',icon:appGlyph('service')},
  {key:'tax',title:'Tax',body:`Three weeks before · ${deliveryText}`,tone:'tax',icon:'£'},
  {key:'insurance',title:'Insurance',body:`Three weeks before · ${deliveryText}`,tone:'insurance',icon:appGlyph('document')}
 ];
 const custom=activeReminders().map(r=>({...r,enabled:r.enabled!==false,car:vehicleById(r.vehicleId)})).filter(r=>r.car);
 const reminderKeyByType={mot_due:'mot',tax_due:'tax',service_due:'service',insurance_due:'insurance'};
 const upcoming=state.vehicles.flatMap(v=>systemFeedItems(v).filter(x=>x.future&&reminderKeyByType[x.type]&&systemNudgeEnabled(v,reminderKeyByType[x.type])).map(x=>({...x,car:v}))).sort((a,b)=>new Date(a.date)-new Date(b.date));
 return shell(`<header class="organic-screen-head"><p class="organic-kicker">REMINDERS</p><h1>What we’ll tell<br>you about</h1><p>A quiet heads-up three weeks ahead, then again the week before. Nothing else.</p></header>${notificationSettingsMarkup()}<section class="organic-nudge-list">${sysRows.map(r=>`<article><span class="organic-nudge-icon ${system[r.key]===false?'off':r.tone}">${r.icon}</span><div><strong>${r.title}</strong><small>${r.body}</small></div><label class="organic-switch"><input type="checkbox" data-system-nudge="${r.key}" ${system[r.key]!==false?'checked':''}><span></span></label></article>`).join('')}</section>${upcoming.length?`<section class="organic-upcoming-calendar"><p class="organic-kicker">UPCOMING</p>${upcoming.map(x=>{const service=x.type==='service_due';return `<article class="essential-tone-${reminderKeyByType[x.type]||'mot'}"><button type="button" class="organic-upcoming-main" data-nav="${service?'addupdateform':'essentialevent'}" data-id="${x.car.id}" data-tab="${service?'service_due':x.type}"><div><strong>${esc(x.title)}</strong><small>${esc(displayVehicleName(x.car))} · ${fmtDate(x.date)} · ${relativeDue(x.date)}</small></div><b>›</b></button>${calendarButtonMarkup({title:x.calendarTitle,date:x.date,description:x.calendarDescription,uid:x.id,label:'Calendar'})}</article>`}).join('')}</section>`:''}${custom.length?`<section class="organic-custom-nudges"><p class="organic-kicker">YOUR OWN REMINDERS</p>${custom.map(r=>{const cal=r.date&&daysUntil(r.date)>=0?calendarButtonMarkup({title:`${displayVehicleName(r.car)} — ${r.title||'Reminder'}`,date:r.date,description:`DriveHub reminder${r.car.registration?` · ${r.car.registration}`:''}`,uid:`reminder-${r.id}`,label:'Calendar'}):'';return `<article><button type="button" class="organic-custom-main" data-nav="reminderform" data-id="${r.id}"><div><strong>${esc(r.title)}</strong><small>${esc(displayVehicleName(r.car))} · ${r.date?fmtDate(r.date):'No date'} · ${reminderDeliveryLabel(r.delivery||delivery)}</small></div><span>›</span></button>${cal}<label class="organic-switch"><input type="checkbox" data-toggle-reminder="${r.id}" ${r.enabled?'checked':''}><span></span></label></article>`}).join('')}</section>`:''}<button type="button" class="organic-add-nudge" id="add-reminder" data-nav="reminderform">＋ Add your own reminder</button>`,'reminders')
}

function reminderFormScreen(id=''){
 const existing=id?state.reminders.find(r=>r.id===id&&!r._deleted):null;
 if(id&&!existing)return reminders();
 if(!state.vehicles.length){
  return shell(`<div class="organic-reminder-form-screen">
   <header class="organic-edit-head">${backButton('reminders')}<div><p class="organic-kicker">REMINDER</p><h1>Add a vehicle first</h1></div></header>
   <section class="card"><p>Custom reminders need to belong to a vehicle.</p><button type="button" class="organic-dark-submit" data-nav="add">Add a car</button></section>
  </div>`,'reminders',false)
 }
 const editing=!!existing;
 const delivery=existing?.delivery||state._prefs?.nudgeDelivery||'app';
 const enabled=existing?.enabled!==false;
 return shell(`<div class="organic-reminder-form-screen">
  <header class="organic-edit-head">${backButton('reminders')}<div><p class="organic-kicker">REMINDER</p><h1>${editing?'Edit reminder':'Add reminder'}</h1></div></header>
  <form id="reminder-screen-form" class="stack" data-guard-unsaved>
   <input type="hidden" name="reminderId" value="${esc(existing?.id||'')}">
   <section class="card">
    <div class="field"><label>Vehicle</label><select name="vehicleId" required>${state.vehicles.map(v=>`<option value="${v.id}" ${existing?.vehicleId===v.id?'selected':''}>${esc(v.registration)} · ${esc(displayVehicleName(v))}</option>`).join('')}</select></div>
    <div class="field"><label>Reminder</label><input name="title" value="${esc(existing?.title||'')}" placeholder="e.g. Insurance renewal" required></div>
    <div class="field"><label>Date</label><input name="date" type="date" value="${esc(existing?.date||'')}" required></div>
    <input type="hidden" name="delivery" value="app"><div class="reminder-delivery-note"><span class="delivery-choice-icon">●</span><div><strong>Notification settings</strong><p>This reminder always appears in DriveHub and also uses any browser or email channels you enable on the Reminders screen.</p></div></div>
    <label class="reminder-enable-row"><div><strong>Reminder enabled</strong><small>Turn this off without deleting it.</small></div><span class="reminder-switch modal-switch"><input type="checkbox" name="enabled" ${enabled?'checked':''}><span></span></span></label>
   </section>
   <div class="organic-form-actions"><button class="organic-dark-submit" type="submit">${editing?'Save reminder':'Add reminder'}</button></div>
   ${editing?'<button class="organic-danger-link" type="button" id="delete-reminder-screen">Delete reminder</button>':''}
  </form>
 </div>`,'reminders',false)
}

function reminderModal(existing=null){
 const editing=!!existing,delivery=existing?.delivery||state._prefs?.nudgeDelivery||'app',enabled=existing?.enabled!==false;
 return `<div class="modal-backdrop" id="reminder-modal"><div class="modal-sheet"><div class="modal-handle"></div><div class="row"><div><p class="eyebrow">REMINDER</p><h2>${editing?'Edit reminder':'Add reminder'}</h2></div><button class="icon-btn" id="close-modal">✕</button></div><form id="reminder-form" class="stack"><input type="hidden" name="reminderId" value="${existing?.id||''}"><div class="field"><label>Vehicle</label><select name="vehicleId" required>${state.vehicles.map(v=>`<option value="${v.id}" ${existing?.vehicleId===v.id?'selected':''}>${esc(v.registration)} · ${esc(v.make)} ${esc(v.model)}</option>`).join('')}</select></div><div class="field"><label>Reminder</label><input name="title" value="${esc(existing?.title||'')}" placeholder="Insurance renewal" required></div><div class="field"><label>Date</label><input name="date" type="date" value="${esc(existing?.date||'')}" required></div>
    <input type="hidden" name="delivery" value="app"><div class="reminder-delivery-note"><span class="delivery-choice-icon">●</span><div><strong>Notification settings</strong><p>This reminder always appears in DriveHub and also uses any browser or email channels you enable on the Reminders screen.</p></div></div><label class="reminder-enable-row"><div><strong>Reminder enabled</strong><small>Turn this off without deleting the reminder.</small></div><span class="reminder-switch modal-switch"><input type="checkbox" name="enabled" ${enabled?'checked':''}><span></span></span></label><button class="primary full" type="submit">${editing?'Save reminder':'Add reminder'}</button>${editing?'<button class="danger full" type="button" id="delete-reminder">Delete reminder</button>':''}</form></div></div>`}
function liveCheckBadge(key,configured){
 const c=liveChecks[key];if(c?.state==='ok')return `<strong class="good">Live · ${esc(c.detail||'working')}</strong>`;if(c?.state==='error')return `<strong class="bad">Test failed</strong>`;if(c?.state==='testing')return `<strong class="warn">Testing…</strong>`;return `<strong class="${configured?'good':'warn'}">${configured?'Configured · not tested':'Needs setup'}</strong>`;
}

async function installGarage(){
 if(installState.installed)return toast('DriveHub is already installed');
 if(!deferredInstallPrompt)return toast(!/^https?:$/.test(location.protocol)?'Install DriveHub after hosting the PWA':'Install is not available in this browser yet');
 const prompt=deferredInstallPrompt;
 deferredInstallPrompt=null;
 installState.available=false;
 await prompt.prompt();
 const choice=await prompt.userChoice;
 if(choice?.outcome==='accepted')toast('DriveHub installed');
 else toast('Install cancelled');
 if(route.screen==='settings')render()
}

function latestSourceDataAt(source){
 const times=[];
 for(const v of state.vehicles||[]){
  for(const entry of Object.values(v?.provenance?.fields||{}))if(entry?.source===source&&entry.updatedAt)times.push(entry.updatedAt);
  if(source==='dvla'&&v?.source?.dvla&&v?.provenance?.lookupAt)times.push(v.provenance.lookupAt);
  if(source==='dvsa'&&v?.source?.dvsa&&v?.provenance?.lookupAt)times.push(v.provenance.lookupAt);
  if(source==='ebay'&&v?.valuation?.source==='ebay'&&v.valuation.updatedAt)times.push(v.valuation.updatedAt)
 }
 return times.sort((a,b)=>new Date(b)-new Date(a))[0]||''
}
function sourceFreshnessText(source){const at=latestSourceDataAt(source);return at?`Latest saved data ${relativeAge(at)} · ${fmtDate(at)}`:'No saved live data yet'}
function sourceSettingsBadge(key,configured){const check=liveChecks[key];if(check?.state==='ok')return '<span class="live">Live</span>';if(check?.state==='testing')return '<span class="needs">Testing…</span>';if(check?.state==='error')return '<span class="needs">Test failed</span>';return `<span class="${configured?'live':'needs'}">${configured?'Configured':'Needs a key'}</span>`}

function settings(){
 const dvla=integrations?.dvla?.configured,dvsa=integrations?.dvsa?.configured;
 const localFileMode=!/^https?:$/.test(location.protocol),vehicleCount=state.vehicles.length,photoCount=state.vehicles.reduce((n,v)=>n+(v.photos||[]).length,0),docCount=state.vehicles.reduce((n,v)=>n+activeDocuments(v).length,0);
 const installLabel=installState.installed?'Installed':installState.available?'Install DriveHub':'Install DriveHub';
 const installDisabled=installState.installed||!installState.available;
 const installCopy=installState.installed?'DriveHub is installed on this device.':installState.available?'Add DriveHub to your home screen and app launcher.':localFileMode?'Available once DriveHub is hosted as a PWA.':'Your browser will enable this when DriveHub meets its install requirements.';
 const bytes=n=>n==null?'Checking…':n>1024**3?`${(n/1024**3).toFixed(1)} GB`:n>1024**2?`${(n/1024**2).toFixed(1)} MB`:n>1024?`${Math.round(n/1024)} KB`:`${n} B`;
 const storageTight=Number(storageStatus.usageRatio||0)>=.85;
 const storageCopy=!storageStatus.supported?'IndexedDB is not available in this browser. Photos and paperwork cannot be stored reliably.':storageStatus.quota?`${bytes(storageStatus.usage)} used of about ${bytes(storageStatus.quota)} available${storageStatus.persisted?' · protected from routine browser cleanup':''}${storageTight?' · free some device/browser storage soon':''}.`:'Photos and paperwork use DriveHub’s larger IndexedDB file store.';
 const googleConfigured=Boolean(googleSyncConfig?.configured),syncing=googleSyncStatus?.state==='syncing',syncProblem=['error','needs-auth'].includes(googleSyncStatus?.state);
 const protectedCount=state.vehicles.reduce((n,v)=>n+Object.values(v?.provenance?.fields||{}).filter(x=>x?.source==='manual').length,0);
 const differenceCount=state.vehicles.reduce((n,v)=>n+provenanceReviewItems(v).length,0);
 const googleCard=googleUser?`<section class="organic-account-row google-connected"><div class="organic-avatar big">${googleUser.picture?`<img src="${esc(googleUser.picture)}" alt="">`:'G'}</div><div><strong>${esc(googleUser.name||'Google account')}</strong><small>${esc(googleUser.email||'Google Drive sync connected')}</small></div><button id="google-signout" aria-label="Disconnect Google">Disconnect</button></section><section class="organic-sync-card ${syncProblem?'attention':'good'}"><i></i><div><strong>${syncing?'Syncing DriveHub':syncProblem?'Google sync needs attention':'Synced across devices'}</strong><small>${esc(googleSyncStatus?.message||'DriveHub uses a private file in Google Drive app data.')}</small></div><button class="organic-sync-now" id="google-sync-now" ${syncing?'disabled':''}>Sync now</button></section>`:`<section class="organic-account-row"><div class="organic-avatar big google-mark">G</div><div><strong>Sync across devices</strong><small>${googleConfigured?'Keep a private copy of your DriveHub data in Google Drive.':'Add a Google OAuth client ID to enable sign-in.'}</small></div><button id="google-signin" ${(!googleConfigured||localFileMode)?'disabled':''}>Sign in with Google</button></section>`;
 return shell(`<header class="organic-screen-head compact"><p class="organic-kicker">SETTINGS</p><h1>Settings</h1></header><section class="organic-settings-card organic-install-card"><p class="organic-kicker">INSTALL</p><div class="organic-install-row"><div><strong>Install DriveHub</strong><small>${esc(installCopy)}</small></div><button id="install-garage" ${installDisabled?'disabled':''}>${esc(installLabel)}</button></div></section>${googleCard}<section class="organic-sync-card good"><i></i><div><strong>Local-first</strong><small>${vehicleCount} car${vehicleCount===1?'':'s'} · ${photoCount} photo${photoCount===1?'':'s'} · ${docCount} document${docCount===1?'':'s'} saved on this device first.</small></div></section><section class="organic-settings-card"><p class="organic-kicker">LOCAL STORAGE</p><div class="organic-source-row"><div><strong>Photos & paperwork</strong><small>${esc(storageCopy)}</small></div><span class="${storageStatus.supported&&!storageTight?'live':'needs'}">${!storageStatus.supported?'Unsupported':storageTight?'Low space':'IndexedDB'}</span></div></section><section class="organic-settings-card"><p class="organic-kicker">WHERE YOUR DATA COMES FROM</p><div class="organic-source-row"><div><strong>Vehicle & tax</strong><small>DVLA · ${esc(sourceFreshnessText('dvla'))}</small></div>${sourceSettingsBadge('dvla',dvla)}</div><div class="organic-source-row"><div><strong>MOT history</strong><small>DVSA · tests, mileage and advisories · ${esc(sourceFreshnessText('dvsa'))}</small></div>${sourceSettingsBadge('dvsa',dvsa)}</div><div class="organic-source-row"><div><strong>Your entries</strong><small>Manual values are protected from live-data refresh${differenceCount?` · ${differenceCount} live difference${differenceCount===1?'':'s'} to review in car Edit screens`:''}</small></div><span class="${differenceCount?'needs':'live'}">${protectedCount?`${protectedCount} protected`:'No overrides'}</span></div><div class="organic-source-actions"><button class="organic-test-data" id="test-live-integrations" ${localFileMode?'disabled':''}>Test live data</button><button class="organic-test-data" id="refresh-all-vehicle-data" ${(localFileMode||!vehicleCount)?'disabled':''}>Refresh saved vehicle data</button></div></section><section class="organic-settings-card utilities"><button id="export-data"><span>Export everything</span><b>›</b></button><button id="import-data"><span>Restore from a backup</span><b>›</b></button><input class="hidden" id="import-file" type="file" accept="application/json,.json"><button data-nav="docs"><span>All paperwork</span><b>›</b></button><button data-nav="garage"><span>Share a car with someone</span><b>›</b></button><div><span>Units and currency</span><b>Miles · £</b></div></section><p class="organic-local-data-note">DriveHub always saves locally first. Photos and paperwork use IndexedDB on this device. If you connect Google, DriveHub privately syncs the vehicle record and its files through your Google Drive application-data area.</p><button class="organic-danger-link" id="reset-data">Erase data on this device</button>`,'settings')
}
function appConfirm({title='Are you sure?',message='',confirmLabel='Confirm',cancelLabel='Cancel',danger=true}={}){
 return new Promise(resolve=>{
  const previousFocus=document.activeElement;
  const backdrop=document.createElement('div');
  backdrop.className='modal-backdrop garage-confirm-backdrop';
  backdrop.dataset.confirmDialog='';
  backdrop.innerHTML=`<div class="modal-sheet garage-confirm-sheet" role="alertdialog" aria-modal="true" aria-labelledby="garage-confirm-title" aria-describedby="garage-confirm-message"><div class="garage-confirm-icon ${danger?'danger':''}">${danger?appGlyph('trash'):appGlyph('check')}</div><div class="garage-confirm-copy"><p class="organic-kicker">${danger?'PLEASE CONFIRM':'CONFIRM'}</p><h2 id="garage-confirm-title">${esc(title)}</h2><p id="garage-confirm-message">${esc(message)}</p></div><div class="garage-confirm-actions"><button type="button" class="secondary" data-confirm-cancel>${esc(cancelLabel)}</button><button type="button" class="${danger?'danger garage-confirm-danger':'primary'}" data-confirm-accept>${esc(confirmLabel)}</button></div></div>`;
  document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  const cancel=backdrop.querySelector('[data-confirm-cancel]'),accept=backdrop.querySelector('[data-confirm-accept]');
  let settled=false;
  const finish=value=>{
   if(settled)return;settled=true;
   document.removeEventListener('keydown',onKey,true);
   backdrop.remove();
   if(!document.querySelector('.modal-backdrop'))document.body.classList.remove('modal-open');
   if(previousFocus?.isConnected)previousFocus.focus();
   resolve(value)
  };
  const onKey=e=>{
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();finish(false)}
   else if(e.key==='Enter'&&document.activeElement===cancel){e.preventDefault();finish(false)}
  };
  cancel.onclick=()=>finish(false);
  accept.onclick=()=>finish(true);
  backdrop.onclick=e=>{if(e.target===backdrop)finish(false)};
  document.addEventListener('keydown',onKey,true);
  requestAnimationFrame(()=>cancel.focus())
 })
}

function showModal(html){
 modalReturnFocus=document.activeElement;
 document.body.insertAdjacentHTML('beforeend',html);
 document.body.classList.add('modal-open');
 const modal=document.querySelector('.modal-backdrop:last-of-type');
 const sheet=modal?.querySelector('.modal-sheet');
 if(sheet){sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true')}
 if(modal){bindMileageFields(modal);bindFormValidation(modal);const controller=new AbortController();modal._focusController=controller;modal.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const focusable=[...modal.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}},{signal:controller.signal})}
 requestAnimationFrame(()=>modal?.querySelector('#close-modal,input:not([type=hidden]),button,select,textarea')?.focus())
}
function closeModal(){const modal=document.querySelector('.modal-backdrop:last-of-type');modal?._focusController?.abort?.();modal?.remove();if(!document.querySelector('.modal-backdrop'))document.body.classList.remove('modal-open');if(modalReturnFocus?.isConnected)modalReturnFocus.focus();modalReturnFocus=null}


function applyRefreshedVehicleData(v,fresh){
 const oldTaxDate=v.tax?.expiryDate||'',lookupAt=fresh.provenance?.lookupAt||new Date().toISOString(),skipped=[];ensureProvenance(v).lookupAt=lookupAt;
 v.mot=v.mot||{status:'Unknown',expiryDate:'',history:[]};v.tax=v.tax||{status:'Unknown',expiryDate:''};
 if(Array.isArray(fresh.mot?.history)&&fresh.mot.history.length){v.mot.history=fresh.mot.history;setFieldProvenance(v,'mot.history',sourceForLiveField(fresh,'mot.history')||'dvsa',lookupAt)}
 ['mot.status','mot.expiryDate','tax.status','tax.expiryDate','make','model','year','colour','fuelType','engineSize','transmission','bodyType'].forEach(path=>mergeLiveField(v,fresh,path,skipped,lookupAt));
 recordEssentialRenewal(v,'tax_due',oldTaxDate,v.tax?.expiryDate||'','Updated from live vehicle data.');
 v.source={...(v.source||{}),...(fresh.source||{})};
 const latest=motTests(v)[0];if(latest?.odometerValue&&Number(latest.odometerValue)>0&&!v.mileageHistory?.some(p=>p.date===latest.completedDate&&Number(p.mileage)===Number(latest.odometerValue))){v.mileageHistory=v.mileageHistory||[];v.mileageHistory.push({id:uid(),date:latest.completedDate,mileage:Number(latest.odometerValue),source:'MOT',updatedAt:lookupAt})}
 touchVehicle(v);return skipped.length
}
async function refreshVehicleData(v,button){
 const original=button?.textContent||'';if(button){button.disabled=true;button.textContent='…'}
 try{const fresh=await lookupVehicle(v.registration);if(!fresh)throw new Error('Vehicle not found');const kept=applyRefreshedVehicleData(v,fresh);persist();render();toast(kept?`Live data refreshed · ${kept} manual value${kept===1?'':'s'} kept`:'Live vehicle data refreshed')}
 catch(err){toast(err?.message||'Could not refresh vehicle data');render()}
}
async function refreshAllVehicleData(button){
 const cars=state.vehicles.filter(v=>v.registration);if(!cars.length)return toast('Add a car before refreshing live data');
 const original=button?.textContent||'Refresh saved vehicle data';if(button){button.disabled=true;button.textContent='Refreshing…'}
 let refreshed=0,failed=0,protectedKept=0;
 for(const v of cars){try{const fresh=await lookupVehicle(v.registration);if(!fresh)throw new Error('Vehicle not found');protectedKept+=applyRefreshedVehicleData(v,fresh);refreshed++}catch{failed++}}
 if(refreshed)persist();integrations=await integrationStatus().catch(()=>integrations);render();
 const parts=[`${refreshed} car${refreshed===1?'':'s'} refreshed`];if(protectedKept)parts.push(`${protectedKept} manual value${protectedKept===1?'':'s'} kept`);if(failed)parts.push(`${failed} failed`);toast(parts.join(' · '),failed?'info':'info')
}

function bindFormValidation(root=document){root.querySelectorAll?.('form').forEach(form=>{form.addEventListener('invalid',e=>{e.preventDefault();const field=e.target?.closest?.('.field');if(field){field.classList.add('has-error');let msg=field.querySelector('.field-error-text');if(!msg){msg=document.createElement('small');msg.className='field-error-text';field.appendChild(msg)}msg.textContent=e.target.validationMessage||'Check this field'}if(!form.dataset.invalidNotified){form.dataset.invalidNotified='1';requestAnimationFrame(()=>{e.target?.scrollIntoView?.({behavior:'smooth',block:'center'});e.target?.focus?.({preventScroll:true});toast('Check the highlighted field');setTimeout(()=>delete form.dataset.invalidNotified,250)})}},true);form.querySelectorAll('input,select,textarea').forEach(input=>{const clear=()=>{const field=input.closest('.field');field?.classList.remove('has-error');field?.querySelector('.field-error-text')?.remove()};input.addEventListener('input',clear);input.addEventListener('change',clear)})})}

function bind(){
 bindMileageFields(document);
 bindRegistrationFields(document);
 bindUnsavedForms(document);
 bindFormValidation(document);
 document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>guardedNavigate(b.dataset.nav,b.dataset.id||undefined,b.dataset.tab||undefined));
 document.querySelectorAll('[data-app-back]').forEach(b=>b.onclick=()=>appBack(b));
 document.querySelectorAll('.organic-event-filter,.organic-timeline-export').forEach(details=>details.addEventListener('toggle',()=>{if(!details.open)return;document.querySelectorAll('.organic-event-filter[open],.organic-timeline-export[open]').forEach(other=>{if(other!==details)other.open=false})}));
 document.querySelectorAll('[data-global-document]').forEach(b=>b.onclick=()=>{const v=vehicleById(b.dataset.vehicleId),d=activeDocuments(v||{}).find(x=>x.id===b.dataset.globalDocument);if(d&&v)openDocumentViewer(d,v)});
 document.querySelectorAll('[data-open]').forEach(b=>{b.onclick=()=>navigate('vehicle',b.dataset.open,'overview');b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();navigate('vehicle',b.dataset.open,'overview')}}});
 document.querySelectorAll('[data-vehicle-tab]').forEach(b=>b.onclick=()=>navigate('vehicle',b.dataset.id,b.dataset.vehicleTab));


 const add=document.querySelector('#add-form');
 if(add){
  const questions=[...add.querySelectorAll('[data-wizard-question]')];
  let wizardIndex=0;
  let onboardingLookup=null;

  const currentQuestion=()=>questions[wizardIndex]||questions[0];
  const fieldInput=question=>{
   const key=question?.dataset.wizardQuestion;
   return key&&key!=='finish'?add.elements.namedItem(key):null
  };
  const valueFor=key=>{
   const el=add.elements.namedItem(key);
   return el?String(el.value||'').trim():''
  };
  const summaryMarkup=()=>{
   const title=[valueFor('make'),valueFor('model')].filter(Boolean).join(' ')||'Your car';
   const meta=[
    valueFor('registration'),
    valueFor('year'),
    valueFor('fuelType'),
    valueFor('transmission'),
    valueFor('bodyType')
   ].filter(Boolean);
   const dates=[
    valueFor('motExpiry')?`MOT ${shortDate(valueFor('motExpiry'))}`:'',
    valueFor('nextServiceDate')?`Service ${shortDate(valueFor('nextServiceDate'))}`:'',
    valueFor('taxExpiry')?`Tax ${shortDate(valueFor('taxExpiry'))}`:'',
    valueFor('insuranceRenewalDate')?`Insurance ${shortDate(valueFor('insuranceRenewalDate'))}`:''
   ].filter(Boolean);
   return `<strong>${esc(title)}</strong>${meta.length?`<span>${meta.map(esc).join(' · ')}</span>`:'<span>You can fill in anything you skipped later.</span>'}${dates.length?`<span class="organic-wizard-summary-dates">${dates.map(esc).join(' · ')}</span>`:''}`
  };
  const setRegistrationStatus=(message='',stateName='')=>{
   setRegistrationStatus.activityRelease?.();
   setRegistrationStatus.activityRelease=stateName==='loading'?window.DriveHubChrome?.beginActivity?.(message||'Checking vehicle details…')||null:null;
   const status=add.querySelector('#registration-lookup-status');
   if(!status)return;
   status.textContent=message;
   status.className=`organic-registration-lookup-status${message?'':' hidden'}${stateName?` ${stateName}`:''}`
  };
  const setFieldValue=(name,value)=>{
   if(value===undefined||value===null||value==='')return;
   const el=add.elements.namedItem(name);if(el)el.value=String(value)
  };
  const applyVehicleLookup=fresh=>{
   onboardingLookup=fresh||null;
   if(!fresh)return;
   setFieldValue('registration',fresh.registration||valueFor('registration'));
   setFieldValue('make',fresh.make);
   setFieldValue('model',fresh.model);
   setFieldValue('year',fresh.year);
   setFieldValue('colour',fresh.colour);
   setFieldValue('fuelType',fresh.fuelType);
   setFieldValue('engineSize',fresh.engineSize);
   setFieldValue('transmission',fresh.transmission);
   setFieldValue('bodyType',fresh.bodyType);
   setFieldValue('motExpiry',fresh.mot?.expiryDate);
   setFieldValue('taxExpiry',fresh.tax?.expiryDate);
   setFieldValue('taxStatus',fresh.tax?.status);
  };
  const registrationNext=async()=>{
   const regInput=add.elements.namedItem('registration');
   const reg=String(regInput?.value||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
   if(!reg){advance();return}
   if(regInput)regInput.value=reg;
   setRegistrationStatus('Checking vehicle details…','loading');
   const nextButton=currentQuestion()?.querySelector('[data-wizard-next]');
   if(nextButton){nextButton.disabled=true;nextButton.textContent='Checking…'}
   try{
    const status=await integrationStatus();
    if(!status){
     onboardingLookup=null;
     setRegistrationStatus('Live lookup is unavailable. Carry on and add the details manually.','manual');
     toast('Live registration lookup unavailable — continue manually');
     advance();
     return
    }
    const configured=Boolean(status?.dvla?.configured||status?.dvsa?.configured);
    if(!configured){
     onboardingLookup=null;
     setRegistrationStatus('Live lookup is not configured. Carry on and add the details manually.','manual');
     advance();
     return
    }
    const fresh=await lookupVehicle(reg);
    if(!fresh){
     onboardingLookup=null;
     setRegistrationStatus('We couldn’t find a car with that registration. Check it and try again.','error');
     regInput?.focus();regInput?.select?.();
     return
    }
    applyVehicleLookup(fresh);
    setRegistrationStatus('Vehicle found — we’ve filled in what we can.','success');
    advance()
   }catch(err){
    const message=String(err?.message||'');
    if(/not found/i.test(message)){
     onboardingLookup=null;
     setRegistrationStatus('We couldn’t find a car with that registration. Check it and try again.','error');
     regInput?.focus();regInput?.select?.();
     return
    }
    onboardingLookup=null;
    setRegistrationStatus('Live lookup is unavailable. Carry on and add the details manually.','manual');
    toast(/^DVSA (?:authentication|MOT lookup)/i.test(message)?message:'Live registration lookup unavailable — continue manually');
    advance()
   }finally{
    if(nextButton){nextButton.disabled=false;nextButton.textContent='Next'}
   }
  };

  const showWizardStep=(nextIndex,focus=true)=>{
   wizardIndex=Math.max(0,Math.min(questions.length-1,nextIndex));
   questions.forEach((q,i)=>q.hidden=i!==wizardIndex);
   const q=currentQuestion(),key=q?.dataset.wizardQuestion;
   const currentValue=key&&key!=='finish'?valueFor(key):'';
   q?.querySelectorAll('[data-wizard-preset]').forEach(btn=>btn.classList.toggle('selected',String(btn.dataset.value||'')===currentValue));
   const label=document.querySelector('#wizard-progress-label'),bar=document.querySelector('#wizard-progress-bar');
   if(label)label.textContent=key==='finish'?'Ready':`${wizardIndex+1} of ${questions.length}`;
   if(bar)bar.style.width=`${Math.max(7,((wizardIndex+1)/questions.length)*100)}%`;
   if(key==='finish'){
    const summary=document.querySelector('#wizard-summary');
    if(summary)summary.innerHTML=summaryMarkup()
   }
   q?.querySelector('[data-wizard-back]')?.toggleAttribute('disabled',wizardIndex===0);
   if(focus)requestAnimationFrame(()=>q?.querySelector('input:not([type="hidden"]),select')?.focus())
  };
  const advance=()=>showWizardStep(wizardIndex+1);
  const goBack=()=>showWizardStep(wizardIndex-1);
  const nextFromCurrent=()=>currentQuestion()?.dataset.wizardQuestion==='registration'?registrationNext():advance();

  add.querySelectorAll('[data-wizard-next]').forEach(btn=>btn.onclick=nextFromCurrent);
  add.querySelectorAll('[data-wizard-back]').forEach(btn=>btn.onclick=goBack);
  add.querySelectorAll('[data-wizard-skip]').forEach(btn=>btn.onclick=()=>{
   const key=currentQuestion()?.dataset.wizardQuestion;
   const input=fieldInput(currentQuestion());
   if(input)input.value='';
   markFormDirty(add);
   if(key==='registration'){onboardingLookup=null;setRegistrationStatus('')}
   advance()
  });
  add.querySelectorAll('[data-wizard-preset]').forEach(btn=>btn.onclick=()=>{
   const key=btn.dataset.wizardPreset,input=add.elements.namedItem(key);
   if(!input)return;
   input.value=btn.dataset.value||'';
   markFormDirty(add);
   btn.closest('.organic-wizard-presets')?.querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===btn));
   setTimeout(advance,90)
  });
  add.querySelectorAll('.organic-wizard-question input:not([type="hidden"]):not([type="checkbox"])').forEach(input=>{
   input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){
     e.preventDefault();
     nextFromCurrent()
    }
   })
  });

  showWizardStep(0,false);

  add.onsubmit=e=>{
   e.preventDefault();
   const f=new FormData(add),currentMileage=parseMileage(f.get('mileage')),now=new Date().toISOString();
   const value=name=>String(f.get(name)||'').trim();
   const numberOrNull=name=>value(name)!==''?(name.toLowerCase().includes('mileage')?parseMileage(value(name)):Number(value(name))):null;
   const v={
    id:uid(),
    registration:value('registration').replace(/\s+/g,' ').toUpperCase(),
    vin:value('vin'),
    make:value('make'),
    model:value('model'),
    nickname:value('nickname'),
    derivative:value('derivative'),
    year:value('year'),
    colour:value('colour'),
    fuelType:value('fuelType'),
    engineSize:value('engineSize'),
    transmission:value('transmission'),
    bodyType:value('bodyType'),
    mileage:currentMileage,
    mot:{status:onboardingLookup?.mot?.status||(value('motExpiry')?'Valid':'Unknown'),expiryDate:value('motExpiry'),history:Array.isArray(onboardingLookup?.mot?.history)?onboardingLookup.mot.history:[]},
    tax:{status:value('taxStatus')||onboardingLookup?.tax?.status||'Unknown',expiryDate:value('taxExpiry')},
    source:onboardingLookup?.source?{...onboardingLookup.source}:{live:false,manual:true},
    provenance:{fields:{},lookupAt:onboardingLookup?.provenance?.lookupAt||''},
    service:{
     lastServiceDate:value('lastServiceDate'),
     lastServiceMileage:numberOrNull('lastServiceMileage'),
     nextServiceDate:value('nextServiceDate'),
     nextServiceMileage:numberOrNull('nextServiceMileage'),
     history:[]
    },
    insurance:{renewalDate:value('insuranceRenewalDate'),premium:numberOrNull('insurancePremium')},
    ownership:{purchaseDate:value('purchaseDate'),purchasePrice:numberOrNull('purchasePrice')},
    reminderSettings:{
     mot:f.get('motReminder')==='on',
     service:f.get('serviceReminder')==='on',
     tax:f.get('taxReminder')==='on',
     insurance:f.get('insuranceReminder')==='on'
    },
    activity:[],
    mileageHistory:currentMileage?[{id:uid(),date:now.slice(0,10),mileage:currentMileage,source:'initial'}]:[],
    comments:[],
    photos:[],
    documents:[],
    specification:[],
    createdAt:now
   };
   if(v.service.lastServiceDate)v.activity.push({id:uid(),type:'service',title:'Previous service',date:v.service.lastServiceDate,mileage:v.service.lastServiceMileage,body:'Added when vehicle was created'});
   seedNewVehicleProvenance(v,onboardingLookup,now);
   touchVehicle(v);
   state.vehicles.push(v);
   pendingLookup=null;
   persist();
   navigate('addphotos',v.id);
   toast('Car added')
  };
 }


 const essentialEventForm=document.querySelector('#essential-event-form');
 if(essentialEventForm&&route.screen==='essentialevent'){
  const v=vehicleById(route.id),type=String(essentialEventForm.dataset.essentialType||route.tab||''),key=essentialEventKey(type);
  essentialEventForm.onsubmit=e=>{
   e.preventDefault();
   if(!v||!key)return toast('Could not update this timeline item');
   const f=new FormData(essentialEventForm),date=String(f.get('date')||''),note=String(f.get('note')||'').trim(),previousDate=essentialEventDate(v,type);
   if(!date)return toast('Add a date before saving');
   setEssentialEventDate(v,type,date);
   const essentialPath={mot_due:'mot.expiryDate',tax_due:'tax.expiryDate',insurance_due:'insurance.renewalDate'}[type];if(essentialPath)setFieldProvenance(v,essentialPath,'manual',new Date().toISOString());
   recordEssentialRenewal(v,type,previousDate,date,note);
   v.essentialEventNotes=v.essentialEventNotes||{};
   if(note)v.essentialEventNotes[key]=note;else delete v.essentialEventNotes[key];
   touchVehicle(v);persist();
   navigate('vehicle',v.id,'story');
   toast(`${activityLabel(type)} updated`)
  }
 }

 const updateScreenForm=document.querySelector('#update-screen-form');
 if(updateScreenForm&&(route.screen==='addupdateform'||route.screen==='editevent')){
  const v=vehicleById(route.id);
  const evidence=document.querySelector('#update-screen-documents');
  const evidenceLabel=document.querySelector('#update-screen-document-selection');
  const photoEvidence=document.querySelector('#update-screen-photos');
  const photoEvidenceLabel=document.querySelector('#update-screen-photo-selection');
  const eventId=String(updateScreenForm.elements.eventId?.value||'');
  const existing=eventId?activeActivity(v||{}).find(a=>a.id===eventId):null;
  if(evidence)evidence.onchange=()=>{
   const files=Array.from(evidence.files||[]);
   const existingDocs=eventId&&v?activeDocuments(v).filter(d=>d.activityId===eventId).length:0;
   if(evidenceLabel)evidenceLabel.textContent=files.length?`${files.length} new file${files.length===1?'':'s'} selected · ${fileSize(files.reduce((n,f)=>n+f.size,0))}`:existingDocs?`${existingDocs} existing document${existingDocs===1?'':'s'} linked to this event.`:'No files selected.'
  };
  if(photoEvidence)photoEvidence.onchange=()=>{
   const files=Array.from(photoEvidence.files||[]),existingPhotos=existing?.photoIds?.length||0;
   if(photoEvidenceLabel)photoEvidenceLabel.textContent=files.length?`${files.length} new photo${files.length===1?'':'s'} selected`:existingPhotos?`${existingPhotos} existing photo${existingPhotos===1?'':'s'} linked to this event.`:'No photos selected.'
  };
  updateScreenForm.onsubmit=async e=>{
   e.preventDefault();
   if(!v)return toast('Could not save this event');
   const f=new FormData(updateScreenForm),submittedType=String(f.get('type')||''),type=existing?.type||submittedType,now=new Date().toISOString();
   const valid=['fuel','mileage','service','maintenance','repair','expense','modification','note'];
   if(!valid.includes(type))return toast('This event type is not valid');
   const title=String(f.get('title')||'').trim();
   if(!title){
    updateScreenForm.elements.title?.focus();
    return toast('Add a title before saving')
   }
   const entry={
    id:existing?.id||uid(),
    type,
    title,
    date:String(f.get('date')||now.slice(0,10)),
    body:String(f.get('body')||'').trim(),
    mileage:f.get('mileage')!==null&&f.get('mileage')!==''?parseMileage(f.get('mileage')):null,
    cost:f.get('cost')!==null&&f.get('cost')!==''?Number(f.get('cost')):null,
    createdAt:existing?.createdAt||now,
    updatedAt:now
   };
   if(type==='service'){
    entry.serviceType=String(f.get('serviceType')||'').trim();
    entry.garageName=String(f.get('garageName')||'').trim();
    entry.nextServiceDate=String(f.get('nextServiceDate')||'');
    entry.nextServiceMileage=f.get('nextServiceMileage')?parseMileage(f.get('nextServiceMileage')):null
   }
   const btn=e.submitter;
   if(btn){btn.disabled=true;btn.textContent='Saving…'}
   try{
    v.activity=v.activity||[];
    v.mileageHistory=v.mileageHistory||[];
    v.documents=v.documents||[];
    v.photos=v.photos||[];
    v.service=v.service||{lastServiceDate:'',lastServiceMileage:null,nextServiceDate:'',nextServiceMileage:null,history:[]};

    const activityIndex=v.activity.findIndex(a=>a.id===entry.id);
    if(activityIndex>=0)v.activity[activityIndex]=entry;
    else v.activity.push(entry);

    const mileageIndex=v.mileageHistory.findIndex(x=>x.id===entry.id);
    if(entry.mileage){
     if(type==='mileage'||entry.mileage>=Number(v.mileage||0)){v.mileage=entry.mileage;setFieldProvenance(v,'mileage',type==='service'?'timeline':'manual',now)};
     const point={id:entry.id,date:entry.date,mileage:entry.mileage,source:type,updatedAt:now};
     if(mileageIndex>=0)v.mileageHistory[mileageIndex]=point;
     else v.mileageHistory.push(point)
    }else if(mileageIndex>=0){
     v.mileageHistory[mileageIndex]={...v.mileageHistory[mileageIndex],_deleted:true,updatedAt:now}
    }

    if(type==='service'){syncServiceFromTimeline(v);markServiceProvenance(v,entry,now)}

    const files=Array.from(evidence?.files||[]);
    if(files.length){
     if(activeDocuments(v).length+files.length>30)throw new Error('Document limit is 30 per vehicle');
     for(const file of files){
      const dataUrl=await readDocumentFile(file);
      v.documents.push(await storeDocumentRecord(v,file,dataUrl,{
       name:file.name,
       type:file.type||'application/octet-stream',
       size:file.size,
       category:activityLabel(type),
       date:entry.date,
       activityId:entry.id,
       timelineRef:entry.id,
       createdAt:now,
       updatedAt:now
      }))
     }
    }
    const photoFiles=Array.from(photoEvidence?.files||[]);
    if(photoFiles.length){
     const remaining=Math.max(0,8-v.photos.length);
     if(photoFiles.length>remaining)throw new Error(`You can attach ${remaining} more photo${remaining===1?'':'s'} to this car`);
     for(const file of photoFiles){
      const dataUrl=await compressPhoto(file),photo=await storePhotoRecord(v,dataUrl,{caption:entry.title,primary:v.photos.length===0,createdAt:now,updatedAt:now});
      v.photos.push(photo);entry.photoIds.push(photo.id)
     }
     const savedIndex=v.activity.findIndex(a=>a.id===entry.id);if(savedIndex>=0)v.activity[savedIndex]=entry
    }

    touchVehicle(v);
    persist();
    navigate('vehicle',v.id,'story');
    toast(existing?'Event updated':`${activityLabel(type)} saved${files.length?` · ${files.length} document${files.length===1?'':'s'}`:''}${photoFiles.length?` · ${photoFiles.length} photo${photoFiles.length===1?'':'s'}`:''}`)
   }catch(err){
    if(!existing){
     v.activity=v.activity.filter(a=>a.id!==entry.id);
     v.mileageHistory=v.mileageHistory.filter(x=>x.id!==entry.id)
    }
    if(btn){btn.disabled=false;btn.textContent=existing?'Save changes':`Save ${activityLabel(type).toLowerCase()}`}
    toast(err?.message||'Could not save event')
   }
  };
  const deleteEvent=document.querySelector('#delete-event-screen');
  if(deleteEvent)deleteEvent.onclick=async()=>{
   if(!existing||!await appConfirm({title:'Delete event?',message:'This removes the event from this car. Linked paperwork stays in Paperwork and linked photos stay in Photos.',confirmLabel:'Delete event'}))return;
   const now=new Date().toISOString();
   const a=v.activity.find(x=>x.id===existing.id);
   if(a){a._deleted=true;a.updatedAt=now}
   const mileage=v.mileageHistory?.find(x=>x.id===existing.id);
   if(mileage){mileage._deleted=true;mileage.updatedAt=now}
   (v.documents||[]).forEach(d=>{if(d.activityId===existing.id){d.activityId='';d.updatedAt=now}});
   if(existing.type==='service')syncServiceFromTimeline(v);
   touchVehicle(v);persist();
   navigate('vehicle',v.id,'story');
   toast('Event deleted')
  }
 }

 const edit=document.querySelector('#edit-form');
 if(edit){
  const v=vehicleById(route.id);
  const specList=document.querySelector('#spec-list');
  const specEmptyAdd=document.querySelector('#add-first-spec');

  const updateSpecEmptyState=()=>{
   const hasRows=Boolean(specList?.querySelector('[data-spec-row]'));
   specEmptyAdd?.classList.toggle('hidden',hasRows)
  };
  const bindSpecRemove=button=>button.onclick=()=>{
   button.closest('[data-spec-row]')?.remove();
   markFormDirty(edit);
   updateSpecEmptyState()
  };
  const addSpecRow=()=>{
   if(!specList)return;
   const row=document.createElement('div');
   row.className='organic-spec-row';
   row.dataset.specRow='';
   row.dataset.specId='';
   row.innerHTML=`<input class="organic-spec-single" data-spec-text placeholder="e.g. 420 bhp, Custom Pack, Michelin PS4S"><button type="button" class="organic-spec-remove" data-spec-remove aria-label="Remove specification row">−</button>`;
   specList.appendChild(row);
   markFormDirty(edit);
   bindSpecRemove(row.querySelector('[data-spec-remove]'));
   updateSpecEmptyState();
   requestAnimationFrame(()=>row.querySelector('[data-spec-text]')?.focus())
  };

  document.querySelectorAll('[data-spec-remove]').forEach(bindSpecRemove);
  document.querySelector('#add-spec-row')?.addEventListener('click',addSpecRow);
  specEmptyAdd?.addEventListener('click',addSpecRow);
  updateSpecEmptyState();

  edit.onsubmit=e=>{
   e.preventDefault();
   const f=new FormData(edit),oldMileage=Number(v.mileage||0),newMileage=parseMileage(f.get('mileage')),oldMotDate=v.mot?.expiryDate||'',oldTaxDate=v.tax?.expiryDate||'',oldInsuranceDate=v.insurance?.renewalDate||'',now=new Date().toISOString();
   const provenancePaths=["registration","vin","make","model","nickname","derivative","year","colour","bodyType","fuelType","engineSize","transmission","mileage","mot.expiryDate","tax.status","tax.expiryDate","ownership.purchaseDate","ownership.purchasePrice","service.nextServiceDate","service.nextServiceMileage","insurance.renewalDate","insurance.premium"],provenanceBefore=Object.fromEntries(provenancePaths.map(path=>[path,valueAtPath(v,path)]));
   ['registration','vin','make','model','nickname','derivative','year','colour','bodyType','fuelType','engineSize','transmission'].forEach(k=>v[k]=String(f.get(k)||'').trim());
   v.registration=String(v.registration||'').toUpperCase();
   v.mileage=newMileage;
   v.mot.expiryDate=f.get('motExpiry');
   v.mot.status=v.mot.expiryDate?'Valid':'Unknown';
   v.tax.status=f.get('taxStatus');
   v.tax.expiryDate=f.get('taxExpiry')||'';
   v.ownership={purchaseDate:f.get('purchaseDate'),purchasePrice:f.get('purchasePrice')?Number(f.get('purchasePrice')):null};
   v.service={...v.service,nextServiceDate:f.get('nextServiceDate'),nextServiceMileage:f.get('nextServiceMileage')?parseMileage(f.get('nextServiceMileage')):null};
   v.insurance={renewalDate:f.get('insuranceRenewalDate')||'',premium:f.get('insurancePremium')?Number(f.get('insurancePremium')):null};
   recordEssentialRenewal(v,'mot_due',oldMotDate,v.mot.expiryDate);
   recordEssentialRenewal(v,'tax_due',oldTaxDate,v.tax.expiryDate);
   recordEssentialRenewal(v,'insurance_due',oldInsuranceDate,v.insurance.renewalDate);

   provenancePaths.forEach(path=>markManualIfChanged(v,path,provenanceBefore[path],valueAtPath(v,path),now));
   const previousSpecs=Array.isArray(v.specification)?v.specification:[];
   const previousById=new Map(previousSpecs.filter(x=>x?.id).map(x=>[x.id,x]));
   const keptIds=new Set();
   const currentSpecs=[...edit.querySelectorAll('[data-spec-row]')].map(row=>{
    const value=String(row.querySelector('[data-spec-text]')?.value||'').trim();
    if(!value)return null;
    const existingId=row.dataset.specId||'',existing=existingId?previousById.get(existingId):null;
    const id=existingId||uid();
    keptIds.add(id);
    return {id,label:'',value,createdAt:existing?.createdAt||now,updatedAt:now}
   }).filter(Boolean);
   const removed=previousSpecs.filter(x=>x?.id&&!x._deleted&&!keptIds.has(x.id)).map(x=>({...x,_deleted:true,updatedAt:now}));
   const existingTombstones=previousSpecs.filter(x=>x?._deleted&&!currentSpecs.some(y=>y.id===x.id));
   v.specification=[...currentSpecs,...removed,...existingTombstones];

   if(newMileage&&newMileage!==oldMileage){
    const entry={id:uid(),type:'mileage',title:'Mileage updated',date:now.slice(0,10),mileage:newMileage,body:`Updated from ${miles(oldMileage)} miles`};
    v.activity.push(entry);
    v.mileageHistory.push({id:entry.id,date:entry.date,mileage:newMileage,source:'manual'})
   }
   touchVehicle(v);
   persist();
   navigate('vehicle',v.id,'overview');
   toast('Changes saved')
  };

  const editDelete=document.querySelector('#delete-car');
  if(editDelete)editDelete.onclick=async()=>{
   if(!v)return;
   if(await appConfirm({title:'Remove vehicle?',message:'This removes the vehicle, its events and reminders from this garage. This cannot be undone.',confirmLabel:'Remove vehicle'})){
    state.vehicles=state.vehicles.filter(x=>x.id!==v.id);
    state.deletedVehicles=state.deletedVehicles||[];
    state.deletedVehicles.push({id:v.id,updatedAt:new Date().toISOString()});
    state.reminders=state.reminders.map(r=>r.vehicleId===v.id?{...r,_deleted:true,updatedAt:new Date().toISOString()}:r);
    persist();
    navigate('garage')
   }
  }
 }


 if(route.screen==='edit'&&route.tab){
  const requestedField={
   motExpiry:'motExpiry',
   nextServiceDate:'nextServiceDate',
   taxExpiry:'taxExpiry',
   insuranceRenewalDate:'insuranceRenewalDate'
  }[route.tab];
  if(requestedField){
   const target=document.querySelector(`#edit-form [name="${requestedField}"]`);
   if(target){
    requestAnimationFrame(()=>{
     target.scrollIntoView({behavior:'smooth',block:'center'});
     setTimeout(()=>target.focus({preventScroll:true}),220)
    })
   }
  }
 }

 const addCarPhotos=document.querySelector('#add-car-photos'),addCarPhotoPicker=document.querySelector('#add-car-photo-picker'),addCarPhotoStatus=document.querySelector('#add-car-photo-status');
 if(addCarPhotos&&addCarPhotoPicker&&route.screen==='addphotos'){
  const v=vehicleById(route.id);
  if(v){
   addCarPhotos.onclick=()=>{
    if((v.photos||[]).length>=8)return toast('Photo limit reached');
    addCarPhotoPicker.value='';
    addCarPhotoPicker.click()
   };
   addCarPhotoPicker.onchange=async()=>{
    const files=Array.from(addCarPhotoPicker.files||[]);
    if(!files.length)return;
    v.photos=v.photos||[];
    const remaining=Math.max(0,8-v.photos.length),selected=files.slice(0,remaining);
    if(!selected.length)return toast('Photo limit reached');
    addCarPhotos.disabled=true;
    if(addCarPhotoStatus){
     addCarPhotoStatus.classList.remove('hidden');
     addCarPhotoStatus.textContent=selected.length===1?'Adding photo…':`Adding ${selected.length} photos…`
    }
    try{
     const wasEmpty=v.photos.length===0,addedAt=new Date().toISOString(),addedPhotos=[];
     for(let i=0;i<selected.length;i++){
      const dataUrl=await compressPhoto(selected[i]),now=new Date().toISOString();
      const photo=await storePhotoRecord(v,dataUrl,{caption:'',primary:wasEmpty&&i===0,createdAt:now,updatedAt:now});
      v.photos.push(photo);addedPhotos.push(photo)
     }
     recordPhotoActivity(v,addedPhotos,addedAt);
     touchVehicle(v);
     persist();
     render();
     const skipped=files.length-selected.length;
     toast(`${selected.length} photo${selected.length===1?'':'s'} added${skipped?` · ${skipped} skipped`:''}`)
    }catch(err){
     addCarPhotos.disabled=false;
     if(addCarPhotoStatus){
      addCarPhotoStatus.classList.remove('hidden');
      addCarPhotoStatus.textContent=err?.message||'Could not add photos'
     }
     toast(err?.message||'Could not add photos')
    }
   }
  }
 }
 const garageSearch=document.querySelector('#garage-search'),garageSort=document.querySelector('#garage-sort'),vehicleStack=document.querySelector('#vehicle-stack'),garageNoResults=document.querySelector('#garage-no-results');const applyGarageTools=()=>{if(!vehicleStack)return;const q=(garageSearch?.value||'').trim().toLowerCase();const cards=[...vehicleStack.querySelectorAll('.organic-vehicle-card')];cards.forEach(card=>card.classList.toggle('hidden',q&&!card.dataset.search.includes(q)));const visible=cards.filter(c=>!c.classList.contains('hidden'));if(garageNoResults)garageNoResults.classList.toggle('hidden',visible.length>0)};if(garageSearch)garageSearch.oninput=applyGarageTools;if(garageSort)garageSort.onchange=applyGarageTools;document.querySelectorAll('[data-garage-view]').forEach(btn=>btn.onclick=()=>{const next=btn.dataset.garageView;if(!['grid','gallery','list'].includes(next)||next===garageView)return;garageView=next;try{localStorage.setItem('garage.ui.view',next)}catch{}render()});applyGarageTools();
 if(route.screen==='vehicle'){
  const v=vehicleById(route.id);
  if(route.tab==='story-add'&&v){
    navigate('addupdate',v.id,undefined,true);
    return
  }
  document.querySelectorAll('[data-action]').forEach(btn=>btn.onclick=()=>navigate('addupdateform',v.id,btn.dataset.action||'note'));
  const nextBtn=document.querySelector('[data-next-action]');if(nextBtn)nextBtn.onclick=()=>{const target=nextBtn.dataset.nextAction,modal=nextBtn.dataset.nextModal;if(modal){navigate('addupdateform',v.id,modal);return}if(target==='edit')navigate('edit',v.id);else if(target==='reminders')navigate('reminders');else navigate('vehicle',v.id,target||'overview')};
  const refreshLive=document.querySelector('#refresh-live-vehicle');if(refreshLive)refreshLive.onclick=()=>refreshVehicleData(v,refreshLive);const earlier=document.querySelector('#show-earlier-tests');if(earlier)earlier.onclick=()=>{document.querySelectorAll('.earlier-test').forEach(x=>x.classList.remove('hidden'));earlier.remove()};
  const removeVehicle=async()=>{if(await appConfirm({title:'Remove vehicle?',message:'This removes the vehicle, its events and reminders from this garage. This cannot be undone.',confirmLabel:'Remove vehicle'})){state.vehicles=state.vehicles.filter(x=>x.id!==v.id);state.deletedVehicles=state.deletedVehicles||[];state.deletedVehicles.push({id:v.id,updatedAt:new Date().toISOString()});state.reminders=state.reminders.map(r=>r.vehicleId===v.id?{...r,_deleted:true,updatedAt:new Date().toISOString()}:r);persist();navigate('garage')}};document.querySelectorAll('#delete-car,[data-remove-vehicle]').forEach(btn=>btn.onclick=removeVehicle);
  const share=document.querySelector('#share-car'),shareCallout=document.querySelector('#share-car-callout'),shareDetails=document.querySelector('#share-car-details');
  const openShare=()=>{showModal(shareDossierModal(v));bindShareModal(v)};
  if(share)share.onclick=openShare;
  if(shareCallout)shareCallout.onclick=()=>navigate('vehicle',v.id,'details');
  const valuationTool=document.querySelector('#open-valuation-tool');if(valuationTool)valuationTool.onclick=()=>{try{localStorage.setItem('drivehub.valuation.prefillVehicleId',v.id)}catch{}openDriveHubTool('valuation')};
  const roadFinderTool=document.querySelector('#open-road-finder');if(roadFinderTool)roadFinderTool.onclick=()=>openDriveHubTool('roads');
  if(shareDetails)shareDetails.onclick=openShare;

  const detailsFrame=document.querySelector('#car-details-frame');
  if(detailsFrame){
   detailsFrame.onload=()=>{
    try{
     const doc=detailsFrame.contentDocument;
     const height=Math.max(720,doc?.documentElement?.scrollHeight||0,doc?.body?.scrollHeight||0);
     detailsFrame.style.height=`${height+12}px`
    }catch{}
   };
   detailsFrame.srcdoc=shareHtmlDocument(v,{reg:true,mot:true,history:true,valuation:false,photos:true,documents:true,costs:false})
  }

  const addPhoto=document.querySelector('#add-photo'),addPhotoEmpty=document.querySelector('#add-photo-empty'),photoFab=document.querySelector('#add-photo-fab'),photoPicker=document.querySelector('#vehicle-photo-picker'),photoStatus=document.querySelector('#vehicle-photo-status');
  const openPhotoPicker=()=>{
   if(!photoPicker)return toast('Photo picker is unavailable');
   if((v.photos||[]).length>=8)return toast('Photo limit reached');
   photoPicker.value='';
   photoPicker.click()
  };
  if(addPhoto)addPhoto.onclick=openPhotoPicker;
  if(addPhotoEmpty)addPhotoEmpty.onclick=openPhotoPicker;
  if(photoFab)photoFab.onclick=openPhotoPicker;
  if(photoPicker)photoPicker.onchange=async()=>{
   const files=Array.from(photoPicker.files||[]);
   if(!files.length)return;
   v.photos=v.photos||[];
   const remaining=Math.max(0,8-v.photos.length),selected=files.slice(0,remaining);
   if(!selected.length)return toast('Photo limit reached');
   [addPhoto,addPhotoEmpty,photoFab].filter(Boolean).forEach(btn=>btn.disabled=true);
   if(photoStatus){
    photoStatus.classList.remove('hidden');
    photoStatus.textContent=selected.length===1?'Adding photo…':`Adding ${selected.length} photos…`
   }
   try{
    const wasEmpty=v.photos.length===0,addedAt=new Date().toISOString(),addedPhotos=[];
    for(let i=0;i<selected.length;i++){
     const dataUrl=await compressPhoto(selected[i]),now=new Date().toISOString();
     const photo=await storePhotoRecord(v,dataUrl,{caption:'',primary:wasEmpty&&i===0,createdAt:now,updatedAt:now});
     v.photos.push(photo);addedPhotos.push(photo)
    }
    recordPhotoActivity(v,addedPhotos,addedAt);
    touchVehicle(v);
    persist();
    render();
    const skipped=files.length-selected.length;
    toast(`${selected.length} photo${selected.length===1?'':'s'} added${skipped?` · ${skipped} skipped`:''}`)
   }catch(err){
    [addPhoto,addPhotoEmpty,photoFab].filter(Boolean).forEach(btn=>btn.disabled=false);
    if(photoStatus){
     photoStatus.classList.remove('hidden');
     photoStatus.textContent=err?.message||'Could not add photos'
    }
    toast(err?.message||'Could not add photos')
   }
  };


  const bindHistoryActions=()=>{
   const emptyAdd=document.querySelector('#timeline-empty-add');if(emptyAdd)emptyAdd.onclick=()=>navigate('addupdate',v.id);
   const resetFilter=document.querySelector('#reset-timeline-filter');if(resetFilter)resetFilter.onclick=()=>{eventFilterState[v.id]={};document.querySelectorAll('[data-event-type]').forEach(input=>input.checked=true);const list=document.querySelector('#history-list');if(list)list.innerHTML=timeFeedMarkup(v);const summary=document.querySelector('.organic-event-filter>summary');if(summary)summary.textContent='Filter';bindHistoryActions();bindDocumentActions(v)};
   document.querySelectorAll('[data-add-evidence]').forEach(btn=>btn.onclick=e=>{e.preventDefault();e.stopPropagation();const item=timeFeedItems(v).find(a=>a.id===btn.dataset.addEvidence);if(!item)return toast('Could not find that Timeline item');choosePaperworkFiles(v,{timelineRef:item.id,date:item.date,category:evidenceCategoryForItem(item),title:item.title||activityLabel(item.type)})});
   document.querySelectorAll('.story-card[data-event-nav]').forEach(card=>{
    const open=()=>navigate(card.dataset.eventNav,card.dataset.eventId||undefined,card.dataset.eventTab||undefined);
    card.onclick=e=>{if(e.target.closest('button,a,input,select,textarea,label,summary,[contenteditable=\"true\"]'))return;open()};
    card.onkeydown=e=>{if(e.target!==card)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}}
   })
  };bindHistoryActions();bindDocumentActions(v);const paperworkAdd=document.querySelector('#add-paperwork');if(paperworkAdd)paperworkAdd.onclick=()=>choosePaperworkFiles(v);const exportCsv=document.querySelector('#export-timeline-csv'),exportPdf=document.querySelector('#export-timeline-pdf');if(exportCsv)exportCsv.onclick=()=>downloadTimelineCsv(v);if(exportPdf)exportPdf.onclick=()=>downloadTimelinePdf(v);document.querySelectorAll('[data-event-type]').forEach(input=>input.onchange=()=>{eventFilterState[v.id]=eventFilterState[v.id]||{};eventFilterState[v.id][input.dataset.eventType]=input.checked;const list=document.querySelector('#history-list');if(list)list.innerHTML=timeFeedMarkup(v);bindHistoryActions();bindDocumentActions(v);const details=input.closest('.organic-event-filter');const summary=details?.querySelector('summary');if(summary){const types=eventFilterOptions(v),hidden=types.filter(type=>!eventTypeEnabled(v,type)).length;summary.innerHTML=`Filter${hidden?` <span>${hidden}</span>`:''}`}});
 }

 if(route.screen==='gallery'){
  const v=vehicleById(route.id),root=document.querySelector('#gallery-page');
  if(v&&root){
   const photos=v.photos||[],track=root.querySelector('#photo-gallery-track'),frame=root.querySelector('.photo-gallery-frame'),counter=root.querySelector('#gallery-current'),caption=root.querySelector('#gallery-caption'),main=root.querySelector('#make-main-photo'),remove=root.querySelector('#remove-photo'),prev=root.querySelector('#photo-prev'),next=root.querySelector('#photo-next'),zoomOut=root.querySelector('#photo-zoom-out'),zoomReset=root.querySelector('#photo-zoom-reset'),zoomIn=root.querySelector('#photo-zoom-in'),filmstrip=root.querySelector('#gallery-filmstrip');
   let current=Math.max(0,Math.min(Number(route.tab)||0,photos.length-1)),raf=0,scale=1,panX=0,panY=0,drag=null;
   const activeSlide=()=>root.querySelector(`[data-gallery-slide="${current}"]`);
   const activeImage=()=>activeSlide()?.querySelector('img');
   const clampPan=()=>{
    const slide=activeSlide();if(!slide||scale<=1){panX=0;panY=0;return}
    const maxX=Math.max(0,slide.clientWidth*(scale-1)/2),maxY=Math.max(0,slide.clientHeight*(scale-1)/2);
    panX=Math.max(-maxX,Math.min(maxX,panX));panY=Math.max(-maxY,Math.min(maxY,panY))
   };
   const applyZoom=()=>{
    clampPan();const img=activeImage();
    if(img)img.style.transform=`translate3d(${panX}px,${panY}px,0) scale(${scale})`;
    track?.classList.toggle('is-zoomed',scale>1.001);
    if(zoomReset)zoomReset.textContent=`${Math.round(scale*100)}%`;
    if(zoomOut)zoomOut.disabled=scale<=1.001;
    if(zoomIn)zoomIn.disabled=scale>=4
   };
   const resetZoom=()=>{
    root.querySelectorAll('.photo-gallery-slide img').forEach(img=>img.style.transform='');
    scale=1;panX=0;panY=0;drag=null;applyZoom()
   };
   const setZoom=value=>{scale=Math.max(1,Math.min(4,value));if(scale===1){panX=0;panY=0}applyZoom()};
   const update=()=>{
    if(!track||!photos.length)return;
    const width=track.clientWidth||1,previous=current;
    current=Math.max(0,Math.min(photos.length-1,Math.round(track.scrollLeft/width)));
    if(previous!==current)resetZoom();
    const photo=photos[current];route.tab=String(current);
    if(counter)counter.textContent=String(current+1);
    if(caption){caption.textContent=photo?.caption||'';caption.classList.toggle('hidden',!photo?.caption)}
    if(main){main.disabled=!!photo?.primary;main.textContent=photo?.primary?'✓ Main photo':'Set as main'}
    if(prev)prev.disabled=current<=0;if(next)next.disabled=current>=photos.length-1;
    root.querySelectorAll('[data-gallery-thumb]').forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.galleryThumb)===current));
    const activeThumb=root.querySelector(`[data-gallery-thumb="${current}"]`);activeThumb?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'})
   };
   const go=index=>{
    if(!track)return;resetZoom();current=Math.max(0,Math.min(photos.length-1,index));
    track.scrollTo({left:(track.clientWidth||1)*current,behavior:'smooth'});update()
   };
   if(track){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{track.scrollLeft=(track.clientWidth||1)*current;update();applyZoom()}));
    track.addEventListener('scroll',()=>{if(scale>1)return;if(raf)cancelAnimationFrame(raf);raf=requestAnimationFrame(update)},{passive:true});
    track.addEventListener('pointerdown',e=>{
     if(scale<=1)return;const slide=e.target.closest?.('.photo-gallery-slide');if(!slide||Number(slide.dataset.gallerySlide)!==current)return;
     drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,panX,panY};try{slide.setPointerCapture(e.pointerId)}catch{}e.preventDefault()
    });
    track.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;panX=drag.panX+(e.clientX-drag.startX);panY=drag.panY+(e.clientY-drag.startY);applyZoom();e.preventDefault()});
    const endDrag=e=>{if(drag?.id===e.pointerId)drag=null};track.addEventListener('pointerup',endDrag);track.addEventListener('pointercancel',endDrag);
    track.addEventListener('dblclick',e=>{const slide=e.target.closest?.('.photo-gallery-slide');if(!slide||Number(slide.dataset.gallerySlide)!==current)return;setZoom(scale>1?1:2);e.preventDefault()});
   }
   if(frame)frame.addEventListener('wheel',e=>{if(!e.ctrlKey&&scale<=1)return;e.preventDefault();setZoom(scale+(e.deltaY<0?.25:-.25))},{passive:false});
   root.querySelectorAll('[data-gallery-thumb]').forEach(btn=>btn.onclick=e=>{e.preventDefault();go(Number(btn.dataset.galleryThumb)||0)});
   if(prev)prev.onclick=e=>{e.preventDefault();go(current-1)};if(next)next.onclick=e=>{e.preventDefault();go(current+1)};
   if(zoomOut)zoomOut.onclick=()=>setZoom(scale-.5);if(zoomIn)zoomIn.onclick=()=>setZoom(scale+.5);if(zoomReset)zoomReset.onclick=()=>resetZoom();
   root.onkeydown=e=>{
    if(e.key==='Escape'){e.preventDefault();navigate('vehicle',v.id,'photos')}
    else if(e.key==='ArrowLeft'&&scale===1){e.preventDefault();go(current-1)}
    else if(e.key==='ArrowRight'&&scale===1){e.preventDefault();go(current+1)}
    else if(e.key==='+'||e.key==='='){e.preventDefault();setZoom(scale+.5)}
    else if(e.key==='-'){e.preventDefault();setZoom(scale-.5)}
    else if(e.key==='0'){e.preventDefault();resetZoom()}
   };
   requestAnimationFrame(()=>root.focus({preventScroll:true}));
   if(main)main.onclick=()=>{photos.forEach((p,i)=>p.primary=i===current);touchVehicle(v);persist();update();toast('Main photo updated')};
   if(remove)remove.onclick=async()=>{
    const photo=photos[current];if(!photo||!await appConfirm({title:'Remove photo?',message:'This photo will be removed from this car.',confirmLabel:'Remove photo'}))return;
    const wasMain=!!photo.primary;photos.splice(current,1);if(photo.assetId)deleteAsset(photo.assetId);if(wasMain&&photos[0])photos[0].primary=true;touchVehicle(v);persist();
    if(!photos.length){navigate('vehicle',v.id,'photos',true);toast('Photo removed');return}
    const nextIndex=Math.min(current,photos.length-1);navigate('gallery',v.id,String(nextIndex),true);toast('Photo removed')
   }
  }
 }

 document.querySelectorAll('[data-toggle-reminder]').forEach(input=>input.onchange=e=>{e.stopPropagation();const r=state.reminders.find(x=>x.id===input.dataset.toggleReminder);if(!r)return;r.enabled=input.checked;r.updatedAt=new Date().toISOString();persist();render();toast(r.enabled?'Reminder enabled':'Reminder disabled')});
 document.querySelectorAll('[data-vehicle-nudge]').forEach(btn=>btn.onclick=()=>{const v=vehicleById(btn.dataset.vehicleId),key=btn.dataset.vehicleNudge;if(!v||!key)return;v.reminderSettings={...(v.reminderSettings||{})};const enabled=systemNudgeEnabled(v,key);v.reminderSettings[key]=!enabled;touchVehicle(v);persist();render();toast(!enabled?'Reminder enabled':'Reminder disabled')});
 document.querySelectorAll('[data-system-nudge]').forEach(input=>input.onchange=()=>{state._prefs=state._prefs||{};state._prefs.systemNudges={mot:true,service:true,tax:true,insurance:true,...(state._prefs.systemNudges||{})};state._prefs.systemNudges[input.dataset.systemNudge]=input.checked;persist();render()});

 const notificationMaster=document.querySelector('[data-notifications-master]');if(notificationMaster)notificationMaster.onchange=async()=>{const prefs=notificationPrefs();prefs.enabled=notificationMaster.checked;persist();render();if(prefs.enabled&&prefs.channels.browser&&browserNotificationPermission()==='granted'){try{await ensureBrowserPushRegistration({requestPermission:false})}catch{}}queueNotificationSync()};
 document.querySelectorAll('[data-notification-channel]').forEach(input=>input.onchange=async()=>{const channel=input.dataset.notificationChannel,prefs=notificationPrefs();input.disabled=true;if(channel==='browser'){if(input.checked){try{if(pushRelayConfigured===false)throw new Error('Web Push needs the Cloudflare notification relay and VAPID keys to be configured first.');await enableBrowserPush();prefs.channels.browser=true;persist();render();await syncPushReminders();toast('Browser push notifications are ready')}catch(err){prefs.channels.browser=false;persist();render();toast(err?.message||'Browser push notifications are not available','error')}return}else{prefs.channels.browser=false;persist();render();await disableBrowserPush();toast('Browser push notifications turned off');return}}if(channel==='email'&&input.checked&&emailRelayConfigured===false){prefs.channels.email=false;persist();render();toast('Email notifications need the Cloudflare relay to be configured first','error');return}prefs.channels[channel]=input.checked;persist();render();if(channel==='email'&&!input.checked)syncEmailReminders();if(channel==='email'&&input.checked&&emailRelayConfigured===null)refreshNotificationRelayStatus()});
 const emailForm=document.querySelector('#notification-email-form');if(emailForm)emailForm.onsubmit=async e=>{e.preventDefault();const button=e.submitter||emailForm.querySelector('button[type="submit"]'),email=String(new FormData(emailForm).get('email')||'').trim();if(!email)return toast('Enter an email address first','error');button.disabled=true;const old=button.textContent;button.textContent='Sending…';try{await beginEmailVerification(email);render();toast('Verification code sent')}catch(err){button.disabled=false;button.textContent=old;toast(err?.message||'Could not send the verification email','error')}};
 const verifyEmail=document.querySelector('#verify-notification-email');if(verifyEmail)verifyEmail.onclick=async()=>{const form=document.querySelector('#notification-email-form'),code=String(new FormData(form).get('code')||'').trim();if(!/^[0-9]{6}$/.test(code))return toast('Enter the six-digit verification code','error');verifyEmail.disabled=true;verifyEmail.textContent='Verifying…';try{await finishEmailVerification(code);render();toast('Email notifications are ready')}catch(err){verifyEmail.disabled=false;verifyEmail.textContent='Verify';toast(err?.message||'Could not verify that code','error')}};
 const changeEmail=document.querySelector('[data-notification-email-change]');if(changeEmail)changeEmail.onclick=async()=>{changeEmail.disabled=true;await clearEmailNotificationIdentity();render();toast('Email notification address removed')};

 const reminderScreenForm=document.querySelector('#reminder-screen-form');
 if(reminderScreenForm&&route.screen==='reminderform'){
  const existingId=String(reminderScreenForm.elements.reminderId?.value||'');
  reminderScreenForm.onsubmit=e=>{
   e.preventDefault();
   const f=new FormData(reminderScreenForm),id=String(f.get('reminderId')||uid()),now=new Date().toISOString();
   const previous=state.reminders.find(r=>r.id===id);
   const reminder={
    id,
    vehicleId:String(f.get('vehicleId')||''),
    title:String(f.get('title')||'').trim(),
    kind:String(f.get('title')||'').trim(),
    date:String(f.get('date')||''),
    icon:'◷',
    enabled:f.get('enabled')==='on',
    delivery:'app',
    createdAt:previous?.createdAt||now,
    updatedAt:now
   };
   const index=state.reminders.findIndex(r=>r.id===id);
   if(index>=0)state.reminders[index]=reminder;
   else state.reminders.push(reminder);
   persist();
   navigate('reminders',undefined,undefined,true);
   toast(previous?'Reminder updated':'Reminder added')
  };
  const deleteReminder=document.querySelector('#delete-reminder-screen');
  if(deleteReminder)deleteReminder.onclick=async()=>{
   if(!existingId||!await appConfirm({title:'Delete reminder?',message:'This reminder will be removed from your garage.',confirmLabel:'Delete reminder'}))return;
   state.reminders=state.reminders.map(r=>r.id===existingId?{...r,_deleted:true,updatedAt:new Date().toISOString()}:r);
   persist();
   navigate('reminders',undefined,undefined,true);
   toast('Reminder deleted')
  }
 }

 const installBtn=document.querySelector('#install-garage');if(installBtn)installBtn.onclick=installGarage;
 const googleSignin=document.querySelector('#google-signin');if(googleSignin)googleSignin.onclick=async()=>{
   googleSignin.disabled=true;googleSignin.textContent='Signing in…';
   try{
     const result=await signInGoogleDrive();
     googleUser=result.user||null;
     if(result.remote)state=mergeGarageData(result.remote,state);
     await migrateLegacyAssets(state);
     await hydrateStateAssets(state);
     save(state);
     const merged=await syncGoogleDrive(state,mergeGarageData);
     if(merged){state=merged;await migrateLegacyAssets(state);await hydrateStateAssets(state);save(state)}
     render();toast('Google Drive sync connected')
   }catch(err){render();toast(err?.message||'Could not sign in with Google')}
 };
 const googleSignout=document.querySelector('#google-signout');if(googleSignout)googleSignout.onclick=()=>{
   signOutGoogleDrive();googleUser=null;render();toast('Google Drive sync disconnected')
 };
 const googleSyncNow=document.querySelector('#google-sync-now');if(googleSyncNow)googleSyncNow.onclick=async()=>{
   googleSyncNow.disabled=true;
   try{
     const merged=await syncGoogleDrive(state,mergeGarageData);
     if(merged){state=merged;await migrateLegacyAssets(state);await hydrateStateAssets(state);save(state)}
     render();toast('DriveHub synced')
   }catch(err){render();toast(err?.message||'Could not sync DriveHub')}
 };
 const refreshAll=document.querySelector('#refresh-all-vehicle-data');if(refreshAll)refreshAll.onclick=()=>refreshAllVehicleData(refreshAll);
 const liveTest=document.querySelector('#test-live-integrations');if(liveTest)liveTest.onclick=async()=>{const sample=state.vehicles.find(x=>x.registration);liveTest.disabled=true;liveTest.textContent='Testing…';integrations=await integrationStatus();const cfg=integrations||{};liveChecks={dvla:{state:cfg.dvla?.configured?'testing':'error'},dvsa:{state:cfg.dvsa?.configured?'testing':'error'}};render();if(sample){try{const data=await lookupVehicle(sample.registration);liveChecks.dvla=data?.source?.dvla?{state:'ok',detail:'vehicle data returned'}:{state:'error'};liveChecks.dvsa=data?.source?.dvsa?{state:'ok',detail:`${data?.mot?.history?.length||0} MOT tests returned`}:{state:'error'}}catch(e){if(cfg.dvla?.configured)liveChecks.dvla={state:'error',detail:e?.message};if(cfg.dvsa?.configured)liveChecks.dvsa={state:'error',detail:e?.message}}}render();toast('MyGarage live-data test complete')};
 const resetBtn=document.querySelector('#reset-data');if(resetBtn)resetBtn.onclick=async()=>{if(await appConfirm({title:'Erase local data?',message:'This removes all vehicles, events and reminders stored in this browser. This cannot be undone.',confirmLabel:'Erase data'})){reset();state=load();await refreshStorageHealth();navigate('garage');toast('Local data erased')}};
 const firstRestore=document.querySelector('#restore-first-run'),firstFile=document.querySelector('#first-run-import-file');if(firstRestore&&firstFile){firstRestore.onclick=()=>firstFile.click();firstFile.onchange=async()=>{const file=firstFile.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text()),incoming=parsed?.data||parsed;if(!incoming||!Array.isArray(incoming.vehicles))throw new Error('Invalid backup');state=incoming;const migration=await migrateLegacyAssets(state);save(state);await hydrateStateAssets(state);navigate('garage');toast(`Backup restored${migration.migrated?` · ${migration.migrated} file${migration.migrated===1?'':'s'} moved to local storage`:''}`)}catch{toast('That backup file could not be restored')}}};const exportBtn=document.querySelector('#export-data');if(exportBtn)exportBtn.onclick=downloadBackup;const importBtn=document.querySelector('#import-data'),importFile=document.querySelector('#import-file');if(importBtn&&importFile){importBtn.onclick=()=>importFile.click();importFile.onchange=async()=>{const file=importFile.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text());const incoming=parsed?.data||parsed;if(!incoming||!Array.isArray(incoming.vehicles)||!Array.isArray(incoming.reminders))throw new Error('Invalid backup');if(!await appConfirm({title:'Restore this backup?',message:`${incoming.vehicles.length} vehicle${incoming.vehicles.length===1?'':'s'} will replace the garage data currently stored on this device.`,confirmLabel:'Restore backup',danger:false}))return;state=incoming;const migration=await migrateLegacyAssets(state);save(state);await hydrateStateAssets(state);navigate('garage');toast(`Backup restored${migration.migrated?` · ${migration.migrated} file${migration.migrated===1?'':'s'} moved to local storage`:''}`)}catch{toast('That backup file could not be restored')}}}
}

function bindPhotoModal(v){document.querySelector('#close-modal').onclick=closeModal;document.querySelector('.modal-backdrop').onclick=e=>{if(e.target.classList.contains('modal-backdrop'))closeModal()};const camera=document.querySelector('#photo-camera'),gallery=document.querySelector('#photo-gallery'),selection=document.querySelector('#photo-selection');const chooseCamera=()=>{if(camera.files?.[0]){gallery.value='';selection.textContent=`Selected: ${camera.files[0].name||'photo'}`}};const chooseGallery=()=>{if(gallery.files?.length){camera.value='';const count=gallery.files.length;selection.textContent=count===1?`Selected: ${gallery.files[0].name||'photo'}`:`Selected ${count} photos`}};camera.onchange=chooseCamera;gallery.onchange=chooseGallery;document.querySelector('#photo-form').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;const files=camera.files?.length?[camera.files[0]]:Array.from(gallery.files||[]);if(!files.length)return toast('Take a photo or choose existing images first');v.photos=v.photos||[];const remaining=Math.max(0,8-v.photos.length);if(!remaining)return toast('Photo limit reached for this car');const selected=files.slice(0,remaining);btn.disabled=true;btn.textContent=selected.length>1?'Saving photos…':'Saving…';try{const f=new FormData(e.target),caption=f.get('caption')||'',wasEmpty=v.photos.length===0,addedAt=new Date().toISOString(),addedPhotos=[];for(let i=0;i<selected.length;i++){const dataUrl=await compressPhoto(selected[i]);const now=new Date().toISOString();const photo=await storePhotoRecord(v,dataUrl,{caption:selected.length===1?caption:'',primary:wasEmpty&&i===0,createdAt:now,updatedAt:now});v.photos.push(photo);addedPhotos.push(photo)}recordPhotoActivity(v,addedPhotos,addedAt);touchVehicle(v);persist();closeModal();render();const skipped=files.length-selected.length;toast(`${selected.length} photo${selected.length===1?'':'s'} added${skipped?` · ${skipped} skipped (8 photo limit)`:''}`)}catch(err){toast(err?.message||'Could not save photo');btn.disabled=false;btn.textContent='Save photo'}}}
function bindPhotoManage(v,index){
 const backdrop=document.querySelector('.modal-backdrop:last-of-type');if(!backdrop)return;
 const photos=v.photos||[];if(!photos.length)return closeModal();
 const track=backdrop.querySelector('#photo-gallery-track'),counter=backdrop.querySelector('#gallery-current'),caption=backdrop.querySelector('#gallery-caption'),main=backdrop.querySelector('#make-main-photo'),remove=backdrop.querySelector('#remove-photo'),prev=backdrop.querySelector('#photo-prev'),next=backdrop.querySelector('#photo-next'),done=backdrop.querySelector('#close-modal');
 let current=Math.max(0,Math.min(index,photos.length-1)),raf=0,refreshOnClose=false;
 const abort=new AbortController();
 const update=()=>{
   if(!track||!track.clientWidth)return;
   current=Math.max(0,Math.min(photos.length-1,Math.round(track.scrollLeft/track.clientWidth)));
   const p=photos[current];
   if(counter)counter.textContent=String(current+1);
   if(caption){caption.textContent=p?.caption||'';caption.classList.toggle('hidden',!p?.caption)}
   if(main){main.disabled=!!p?.primary;main.textContent=p?.primary?'✓ Main photo':'Set as main'}
 };
 const go=i=>{
   const target=Math.max(0,Math.min(photos.length-1,i));
   current=target;
   track?.scrollTo({left:(track.clientWidth||1)*target,behavior:'smooth'});
   update();
 };
 const cleanup=()=>{abort.abort();if(raf)cancelAnimationFrame(raf)};
 const close=()=>{cleanup();closeModal();if(refreshOnClose)render()};
 if(done)done.onclick=close;
 backdrop.onclick=e=>{if(e.target===backdrop)close()};
 if(track){
   requestAnimationFrame(()=>{track.scrollLeft=(track.clientWidth||1)*current;update()});
   track.addEventListener('scroll',()=>{if(raf)cancelAnimationFrame(raf);raf=requestAnimationFrame(update)},{passive:true,signal:abort.signal});
 }
 if(prev)prev.onclick=e=>{e.stopPropagation();go(current-1)};
 if(next)next.onclick=e=>{e.stopPropagation();go(current+1)};
 document.addEventListener('keydown',e=>{
   if(document.querySelector('[data-confirm-dialog]'))return;
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close()}
   else if(e.key==='ArrowLeft'){e.preventDefault();go(current-1)}
   else if(e.key==='ArrowRight'){e.preventDefault();go(current+1)}
 },{capture:true,signal:abort.signal});
 if(main)main.onclick=()=>{
   photos.forEach((p,i)=>p.primary=i===current);
   refreshOnClose=true;touchVehicle(v);persist();update();toast('Main photo updated')
 };
 if(remove)remove.onclick=async()=>{
   const p=photos[current];if(!p||!await appConfirm({title:'Remove photo?',message:'This photo will be removed from this car.',confirmLabel:'Remove photo'}))return;
   const wasMain=!!p.primary;photos.splice(current,1);if(p.assetId)deleteAsset(p.assetId);
   if(wasMain&&photos[0])photos[0].primary=true;
   touchVehicle(v);persist();cleanup();closeModal();render();
   if(photos.length){const next=Math.min(current,photos.length-1);showModal(photoManageModal(v,next));bindPhotoManage(v,next)}
   toast('Photo removed')
 };
}
function bindDocumentModal(v,selectedFiles=[],context={}){
 const modal=document.querySelector('.modal-backdrop:last-of-type');
 const close=modal?.querySelector('#close-modal');
 if(close)close.onclick=closeModal;
 if(modal)modal.onclick=e=>{if(e.target===modal)closeModal()};
 const change=modal?.querySelector('#change-document-files');
 if(change)change.onclick=()=>{closeModal();choosePaperworkFiles(v,context)};
 const form=modal?.querySelector('#document-form');
 if(form)form.onsubmit=async e=>{
  e.preventDefault();
  const files=Array.from(selectedFiles||[]);
  if(!files.length)return toast('Choose at least one document');
  v.documents=v.documents||[];
  if(activeDocuments(v).length+files.length>30)return toast('Document limit is 30 per vehicle');
  const btn=e.submitter||form.querySelector('button[type="submit"]');
  if(btn){btn.disabled=true;btn.textContent='Adding…'}
  try{
   const f=new FormData(form),now=new Date().toISOString();
   for(const file of files){
    const dataUrl=file.dataUrl||await readDocumentFile(file);
    v.documents.push(await storeDocumentRecord(v,file,dataUrl,{name:file.name,type:file.type||'application/octet-stream',size:file.size,category:f.get('category')||inferPaperworkCategory(file.name),date:f.get('date')||now.slice(0,10),note:String(f.get('note')||'').trim(),activityId:(activeActivity(v).some(a=>a.id===String(f.get('timelineRef')||''))?String(f.get('timelineRef')||''):''),timelineRef:String(f.get('timelineRef')||''),createdAt:now,updatedAt:now}))
   }
   touchVehicle(v);persist();closeModal();render();toast(`${files.length} document${files.length===1?'':'s'} added`)
  }catch(err){
   toast(err?.message||'Could not add paperwork');
   if(btn){btn.disabled=false;btn.textContent='Add paperwork'}
  }
 };
}
function openDocumentExternal(d){if(!d?.dataUrl)return toast('Document is not available on this device');const win=window.open(d.dataUrl,'_blank','noopener,noreferrer');if(!win){const a=document.createElement('a');a.href=d.dataUrl;a.download=d.name||'document';a.click()}}
function openDocumentViewer(d,v){if(!d||!v)return;showModal(documentPreviewModal(d,v));const modal=document.querySelector('.modal-backdrop:last-of-type');if(!modal)return;modal.querySelector('#close-modal').onclick=closeModal;modal.onclick=x=>{if(x.target===modal)closeModal()};modal.querySelector('#document-open-external').onclick=()=>openDocumentExternal(d);modal.querySelector('#document-save-file').onclick=()=>{const a=document.createElement('a');a.href=d.dataUrl;a.download=d.name||'document';a.click()};const context=modal.querySelector('[data-open-evidence-event]');if(context)context.onclick=()=>{const ref=context.dataset.openEvidenceEvent;closeModal();navigate('vehicle',v.id,'story');requestAnimationFrame(()=>requestAnimationFrame(()=>{const button=[...document.querySelectorAll('[data-add-evidence]')].find(x=>x.dataset.addEvidence===ref),entry=button?.closest('.story-entry');if(entry){entry.scrollIntoView({behavior:'smooth',block:'center'});entry.classList.add('evidence-focus');setTimeout(()=>entry.classList.remove('evidence-focus'),1800)}}))}}
function bindDocumentEditModal(v,d){
 const modal=document.querySelector('.modal-backdrop:last-of-type');if(!modal||!d)return;
 const close=modal.querySelector('#close-modal');if(close)close.onclick=closeModal;
 modal.onclick=e=>{if(e.target===modal)closeModal()};
 const form=modal.querySelector('#document-edit-form');if(!form)return;
 form.onsubmit=e=>{e.preventDefault();const f=new FormData(form),now=new Date().toISOString();d.name=String(f.get('name')||'').trim()||d.name;d.category=f.get('category')||'Other';d.date=f.get('date')||d.date||now.slice(0,10);d.note=String(f.get('note')||'').trim();const ref=String(f.get('timelineRef')||'');d.timelineRef=ref;d.activityId=activeActivity(v).some(a=>a.id===ref)?ref:'';d.updatedAt=now;touchVehicle(v);persist();closeModal();render();toast('Paperwork updated')}
}
function bindDocumentActions(v){
 const docs=activeDocuments(v);
 document.querySelectorAll('[data-open-document]').forEach(btn=>btn.onclick=e=>{e.stopPropagation();openDocumentExternal(docs.find(x=>x.id===btn.dataset.openDocument))});
 document.querySelectorAll('[data-preview-document]').forEach(item=>{const open=e=>{const nested=e?.target?.closest?.('button,a,input,select,textarea,label,summary');if(nested&&nested!==item)return;e?.stopPropagation?.();openDocumentViewer(docs.find(x=>x.id===item.dataset.previewDocument),v)};item.onclick=open;item.onkeydown=e=>{if(e.target!==item)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();open(e)}}});
 document.querySelectorAll('[data-edit-document]').forEach(btn=>btn.onclick=e=>{e.stopPropagation();const d=(v.documents||[]).find(x=>x.id===btn.dataset.editDocument&&!x._deleted);if(!d)return;showModal(documentEditModal(v,d));bindDocumentEditModal(v,d)});
 document.querySelectorAll('[data-delete-document]').forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const d=(v.documents||[]).find(x=>x.id===btn.dataset.deleteDocument);if(!d)return;if(!await appConfirm({title:'Remove document?',message:`${d.name} will be removed from this car.`,confirmLabel:'Remove document'}))return;d._deleted=true;d.updatedAt=new Date().toISOString();if(d.assetId)deleteAsset(d.assetId);touchVehicle(v);persist();render();toast('Document removed')});
 const search=document.querySelector('#document-search'),filter=document.querySelector('#document-category-filter'),list=document.querySelector('#document-list'),none=document.querySelector('#document-no-results');const apply=()=>{if(!list)return;const q=(search?.value||'').trim().toLowerCase(),cat=(filter?.value||'').toLowerCase();const rows=[...list.querySelectorAll('.document-row')];rows.forEach(r=>r.classList.toggle('hidden',(q&&!r.dataset.documentSearch.includes(q))||(cat&&r.dataset.documentCategory!==cat)));if(none)none.classList.toggle('hidden',rows.some(r=>!r.classList.contains('hidden')))};if(search)search.oninput=apply;if(filter)filter.onchange=apply;
}

function bindShareModal(v){const modal=document.querySelector('.modal-backdrop:last-of-type');if(!modal)return toast('Could not open sharing');const close=modal.querySelector('#close-modal');if(close)close.onclick=closeModal;modal.onclick=e=>{if(e.target===modal)closeModal()};const opts=()=>Object.fromEntries([...modal.querySelectorAll('[data-share-opt]')].map(x=>[x.dataset.shareOpt,x.checked]));const preview=modal.querySelector('#preview-html'),copy=modal.querySelector('#copy-summary'),save=modal.querySelector('#save-html'),share=modal.querySelector('#share-html'),previewImage=modal.querySelector('#preview-image'),saveImage=modal.querySelector('#save-image'),shareImage=modal.querySelector('#share-image');if(preview)preview.onclick=()=>{const html=shareHtmlDocument(v,opts());const blob=new Blob([html],{type:'text/html'});const url=URL.createObjectURL(blob);const win=window.open(url,'_blank','noopener,noreferrer');if(!win)toast('Pop-up blocked — use Save page to preview');setTimeout(()=>URL.revokeObjectURL(url),60000)};if(copy)copy.onclick=async()=>{const text=sellerSummary(v,opts());try{await navigator.clipboard.writeText(text);toast('Vehicle summary copied')}catch{toast('Could not copy summary')}};if(save)save.onclick=()=>{saveHtmlFile(v,opts());toast('Share page saved')};if(previewImage)previewImage.onclick=async()=>{const win=window.open('','_blank','noopener,noreferrer'),label=previewImage.textContent;previewImage.disabled=true;previewImage.textContent='Preparing…';try{const file=await shareImageFile(v,opts());if(!previewShareImage(file,win)){try{win?.close?.()}catch{}saveBlobFile(file);toast('Preview blocked — image saved instead')}}catch(e){try{win?.close?.()}catch{}toast(e?.message||'Could not create share image')}finally{previewImage.disabled=false;previewImage.textContent=label}};if(saveImage)saveImage.onclick=async()=>{const label=saveImage.textContent;saveImage.disabled=true;saveImage.textContent='Preparing…';try{const file=await shareImageFile(v,opts());saveBlobFile(file);toast('Share image saved')}catch(e){toast(e?.message||'Could not create share image')}finally{saveImage.disabled=false;saveImage.textContent=label}};if(shareImage)shareImage.onclick=async()=>{const selected=opts(),label=shareImage.innerHTML;shareImage.disabled=true;shareImage.innerHTML='<span>IMG</span><div><strong>Preparing…</strong><small>Creating share image</small></div>';try{const file=await shareImageFile(v,selected),title=[v.year,v.make,v.model].filter(Boolean).join(' ')||'My car',text=sellerSummary(v,selected);if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({title,text:'Vehicle details shared from DriveHub.',files:[file]});return}saveBlobFile(file);toast('Share image saved — attach it to your message')}catch(e){if(e?.name!=='AbortError')toast(e?.message||'Could not share image')}finally{shareImage.disabled=false;shareImage.innerHTML=label}};if(share)share.onclick=async()=>{const selected=opts(),text=sellerSummary(v,selected),title=[v.year,v.make,v.model].filter(Boolean).join(' ')||'My car';let file=null;try{file=shareHtmlFile(v,selected)}catch{}try{if(navigator.share){const canShareFile=!!(file&&navigator.canShare&&navigator.canShare({files:[file]}));if(canShareFile){await navigator.share({title,text:'Vehicle details shared from DriveHub.',files:[file]})}else{await navigator.share({title,text})}return}if(navigator.clipboard){await navigator.clipboard.writeText(text);toast('Car details copied — paste them into a message');return}if(file){saveHtmlFile(v,selected);toast('Share page saved — attach it to your message');return}toast('Sharing is not available on this device')}catch(e){if(e?.name==='AbortError')return;try{if(navigator.clipboard){await navigator.clipboard.writeText(text);toast('Could not open sharing — car details copied instead')}else if(file){saveHtmlFile(v,selected);toast('Could not open sharing — share page saved instead')}else toast('Could not share this car')}catch{toast('Could not share this car')}}}}

function bindActionPicker(v){
 const modal=document.querySelector('.modal-backdrop:last-of-type');
 if(!modal)return toast('Could not open the update picker');
 const close=modal.querySelector('#close-modal');
 if(close)close.onclick=closeModal;
 modal.onclick=e=>{if(e.target===modal)closeModal()};
 modal.querySelectorAll('[data-pick-action]').forEach(btn=>btn.onclick=e=>{
  e.preventDefault();
  e.stopPropagation();
  const type=btn.dataset.pickAction;
  closeModal();
  navigate('addupdateform',v.id,type)
 })
}
function bindModal(v){
 document.querySelector('#close-modal').onclick=closeModal;document.querySelector('.modal-backdrop').onclick=e=>{if(e.target.classList.contains('modal-backdrop'))closeModal()};const form=document.querySelector('#activity-form'),evidence=document.querySelector('#activity-documents'),evidenceLabel=document.querySelector('#activity-document-selection');if(evidence)evidence.onchange=()=>{const files=Array.from(evidence.files||[]);evidenceLabel.textContent=files.length?`${files.length} new file${files.length===1?'':'s'} selected · ${fileSize(files.reduce((n,f)=>n+f.size,0))}`:'No new files selected.'};const deleteBtn=document.querySelector('#delete-activity');if(deleteBtn)deleteBtn.onclick=async()=>{const id=form.elements.activityId.value;if(!await appConfirm({title:'Delete history record?',message:'This record will be removed from the car history.',confirmLabel:'Delete record'}))return;const now=new Date().toISOString();const a=(v.activity||[]).find(x=>x.id===id);if(a){a._deleted=true;a.updatedAt=now}else v.activity.push({id,_deleted:true,updatedAt:now});const mp=(v.mileageHistory||[]).find(x=>x.id===id);if(mp){mp._deleted=true;mp.updatedAt=now}touchVehicle(v);persist();closeModal();render();toast('Record deleted')};form.onsubmit=async e=>{e.preventDefault();const f=new FormData(form);const type=f.get('type'),existingId=f.get('activityId');const now=new Date().toISOString();const entry={id:existingId||uid(),type,title:f.get('title'),date:f.get('date'),body:f.get('body')||'',mileage:f.get('mileage')!==''?parseMileage(f.get('mileage')):null,cost:f.get('cost')!==null&&f.get('cost')!==''?Number(f.get('cost')):null,updatedAt:now};const btn=e.submitter;if(btn){btn.disabled=true;btn.textContent='Saving…'}try{if(existingId){const i=(v.activity||[]).findIndex(a=>a.id===existingId);entry.createdAt=v.activity?.[i]?.createdAt||now;if(i>=0)v.activity[i]=entry;else v.activity.push(entry)}else{entry.createdAt=now;v.activity=v.activity||[];v.activity.push(entry)}if(entry.mileage){if(type==='mileage'||entry.mileage>=Number(v.mileage||0))v.mileage=entry.mileage;v.mileageHistory=v.mileageHistory||[];const mi=v.mileageHistory.findIndex(x=>x.id===entry.id);const point={id:entry.id,date:entry.date,mileage:entry.mileage,source:type,updatedAt:now};if(mi>=0)v.mileageHistory[mi]=point;else v.mileageHistory.push(point)}if(type==='service'){v.service.lastServiceDate=entry.date;v.service.lastServiceMileage=entry.mileage;if(f.get('nextServiceDate'))v.service.nextServiceDate=f.get('nextServiceDate');if(f.get('nextServiceMileage'))v.service.nextServiceMileage=parseMileage(f.get('nextServiceMileage'))}const files=Array.from(evidence?.files||[]);if(files.length){v.documents=v.documents||[];if(activeDocuments(v).length+files.length>30)throw new Error('Document limit is 30 per vehicle');for(const file of files){const dataUrl=await readDocumentFile(file);v.documents.push(await storeDocumentRecord(v,file,dataUrl,{name:file.name,type:file.type||'application/octet-stream',size:file.size,category:activityLabel(type),date:entry.date,activityId:entry.id,timelineRef:entry.id,createdAt:now,updatedAt:now}))}}touchVehicle(v);persist();closeModal();render();toast(existingId?'Record updated':`${activityLabel(type)} saved${files.length?` · ${files.length} document${files.length===1?'':'s'} attached`:''}`)}catch(err){if(!existingId){v.activity=v.activity.filter(a=>a.id!==entry.id);v.mileageHistory=v.mileageHistory.filter(x=>x.id!==entry.id)}toast(err?.message||'Could not save record');if(btn){btn.disabled=false;btn.textContent=existingId?'Save changes':'Save '+activityLabel(type).toLowerCase()}}}}

function bindReminderModal(existing=null){
 const modal=document.querySelector('.modal-backdrop:last-of-type');const close=modal?.querySelector('#close-modal');if(close)close.onclick=closeModal;if(modal)modal.onclick=e=>{if(e.target===modal)closeModal()};
 const form=document.querySelector('#reminder-form');const del=document.querySelector('#delete-reminder');if(del)del.onclick=async()=>{if(!await appConfirm({title:'Delete reminder?',message:'This reminder will be removed from your garage.',confirmLabel:'Delete reminder'}))return;state.reminders=state.reminders.map(r=>r.id===existing?.id?{...r,_deleted:true,updatedAt:new Date().toISOString()}:r);persist();closeModal();render();toast('Reminder deleted')};
 form.onsubmit=e=>{e.preventDefault();const f=new FormData(form),id=f.get('reminderId')||uid(),now=new Date().toISOString();const previous=state.reminders.find(r=>r.id===id);const reminder={id,vehicleId:f.get('vehicleId'),title:f.get('title'),kind:f.get('title'),date:f.get('date'),icon:'◷',enabled:f.get('enabled')==='on',delivery:'app',createdAt:previous?.createdAt||now,updatedAt:now};const i=state.reminders.findIndex(r=>r.id===id);if(i>=0)state.reminders[i]=reminder;else state.reminders.push(reminder);persist();closeModal();render();toast(previous?'Reminder updated':'Reminder added')};
}
async function refreshIntegrations(){if(route.screen==='settings'){const next=await integrationStatus();if(JSON.stringify(next)!==JSON.stringify(integrations)){integrations=next;render()}}}
function bindGlobalKeys(){
 if(window.__garageKeysBound)return;
 window.__garageKeysBound=true;
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&document.querySelector('.modal-backdrop'))closeModal()
 });
 document.addEventListener('click',e=>{
  const eventEdit=e.target.closest?.('[data-nav="editevent"]');
  if(eventEdit&&!eventEdit.onclick){
   e.preventDefault();
   e.stopPropagation();
   navigate('editevent',eventEdit.dataset.id,eventEdit.dataset.tab);
   return
  }

  const calendar=e.target.closest?.('[data-calendar-download]');
  if(calendar){
   e.preventDefault();
   e.stopPropagation();
   downloadCalendarEvent({
    title:calendar.dataset.calendarTitle||'DriveHub reminder',
    date:calendar.dataset.calendarDate||'',
    description:calendar.dataset.calendarDescription||'',
    uid:calendar.dataset.calendarUid||''
   });
   return
  }

 })
}
bindGlobalKeys();
window.addEventListener('beforeinstallprompt',e=>{
 e.preventDefault();
 deferredInstallPrompt=e;
 installState.available=true;
 if(route.screen==='settings')render()
});
window.addEventListener('appinstalled',()=>{
 deferredInstallPrompt=null;
 installState={available:false,installed:true};
 if(route.screen==='settings')render()
});
function render(){
 try{
  const views={garage,add:addVehicle,addphotos:()=>addVehiclePhotos(route.id),vehicle:()=>vehicle(route.id,route.tab||'overview'),mothistory:()=>motHistoryScreen(route.id),gallery:()=>galleryScreen(route.id,route.tab||0),addupdate:()=>addUpdateScreen(route.id),addupdateform:()=>addUpdateFormScreen(route.id,route.tab||'note'),editevent:()=>editEventScreen(route.id,route.tab||''),essentialevent:()=>essentialEventScreen(route.id,route.tab||'mot_due'),edit:()=>editVehicle(route.id),reminders,reminderform:()=>reminderFormScreen(route.id||''),docs,settings};
  const titleMap={garage:'MyGarage · DriveHub',add:'Add a car · DriveHub',addphotos:'Add photos · DriveHub',vehicle:'Car · DriveHub',mothistory:'MOT history · DriveHub',gallery:'Gallery · DriveHub',addupdate:'Add event · DriveHub',addupdateform:'Add event · DriveHub',editevent:'Edit event · DriveHub',essentialevent:'Edit timeline item · DriveHub',edit:'Edit car · DriveHub',reminders:'Reminders · DriveHub',reminderform:'Reminder · DriveHub',docs:'Docs · DriveHub',settings:'Settings · DriveHub'};
  document.title=titleMap[route.screen]||'DriveHub';
  document.body.dataset.view=route.screen||'garage';
  app.innerHTML=(views[route.screen]||garage)();
  bind();
  refreshIntegrations();
  if(route.screen==='reminders'&&(emailRelayConfigured===null||pushRelayConfigured===null))setTimeout(refreshNotificationRelayStatus,0)
 }catch(err){
  console.error('DriveHub render failed',err);
  document.body.dataset.view='error';
  app.innerHTML=`<main class="garage-runtime-error"><div><p class="organic-kicker">DRIVEHUB</p><h1>DriveHub couldn’t open</h1><p>Something went wrong while loading this version. Your saved garage has not been erased.</p><button id="garage-reload">Reload DriveHub</button><details><summary>Technical detail</summary><code>${esc(err?.message||String(err))}</code></details></div></main>`;
  document.querySelector('#garage-reload')?.addEventListener('click',()=>location.reload())
 }
}
if(!history.state){try{history.replaceState({screen:route.screen,id:route.id||null,tab:route.tab||null,drivehub:true,drivehubDepth:routeDepth},'')}catch{}}
window.addEventListener('popstate',async e=>{const next=e.state||{screen:'garage',drivehubDepth:0};if(!skipNextPopGuard&&currentDirtyForm()&&!await confirmDiscardIfNeeded()){skipNextPopGuard=true;try{history.go(1)}catch{}return}skipNextPopGuard=false;routeDepth=Number(next.drivehubDepth||0);route={screen:next.screen||'garage',id:next.id||undefined,tab:next.tab||undefined};render();window.scrollTo({top:0,behavior:'auto'})});
window.addEventListener('error',e=>{if(!app?.innerHTML?.trim()){app.innerHTML=`<main class="garage-runtime-error"><div><h1>DriveHub couldn’t open</h1><p>Your saved data is still on this device.</p><button onclick="location.reload()">Reload DriveHub</button></div></main>`}});
async function bootDriveHub(){
 let migration={migrated:0,failed:0};
 try{
  migration=await migrateLegacyAssets(state);
  if(migration.migrated)save(state);
  await hydrateStateAssets(state);
  await requestPersistentStorage();
  storageStatus=await storageHealth();
 }catch(err){console.warn('DriveHub local file storage warning',err)}
 render();
 refreshNotificationRelayStatus();
 refreshPushRegistrationOnLoad();
 queueNotificationSync();
 if(migration.failed)setTimeout(()=>toast(`${migration.failed} existing file${migration.failed===1?'':'s'} could not be moved to IndexedDB. Keep a backup before clearing site data.`,'error'),350);
 initializeGoogleDriveSync((nextStatus,nextUser)=>{
  const snap=googleDriveSnapshot();
  googleSyncConfig=snap.config||googleSyncConfig;
  googleSyncStatus=nextStatus||snap.status||googleSyncStatus;
  googleUser=nextUser||snap.user||null;
  if(route.screen==='settings')render()
 }).then(async cfg=>{googleSyncConfig=cfg||googleSyncConfig;const restored=await restoreGoogleDriveSession();if(restored){googleUser=restored.user||null;if(restored.remote)state=mergeGarageData(restored.remote,state);await migrateLegacyAssets(state);await hydrateStateAssets(state);save(state);const merged=await syncGoogleDrive(state,mergeGarageData);if(merged){state=merged;await migrateLegacyAssets(state);await hydrateStateAssets(state);save(state)}render()}else if(route.screen==='settings')render()}).catch(()=>{});
 if(!window.DriveHubRuntime?.isNative&&/^https?:$/.test(location.protocol)&&'serviceWorker'in navigator){
  navigator.serviceWorker.register('./service-worker.js?v=14221',{updateViaCache:'none'}).then(reg=>reg.update()).catch(()=>{});
 }
}
bootDriveHub();
