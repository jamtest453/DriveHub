import { buildPushPayload } from '@block65/webcrypto-web-push';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const nowIso=()=>new Date().toISOString();
const normaliseEmail=value=>String(value||'').trim().toLowerCase();
const validEmail=email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254;
const encoder=new TextEncoder();
async function sha(value){const digest=await crypto.subtle.digest('SHA-256',encoder.encode(String(value)));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function randomToken(bytes=24){const a=new Uint8Array(bytes);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function code(){const a=new Uint32Array(1);crypto.getRandomValues(a);return String(100000+(a[0]%900000))}
async function body(request){try{return await request.json()}catch{return {}}}
function authorised(request,env){return Boolean(env.RELAY_SECRET)&&request.headers.get('x-drivehub-relay-secret')===env.RELAY_SECRET}
function vapidReady(env){return Boolean(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT)}
function validPushSubscription(subscription){
 if(!subscription||typeof subscription!=='object')return false;
 const endpoint=String(subscription.endpoint||''),p256dh=String(subscription.keys?.p256dh||''),auth=String(subscription.keys?.auth||'');
 try{const u=new URL(endpoint);if(u.protocol!=='https:')return false}catch{return false}
 return endpoint.length<=1800&&p256dh.length>=20&&p256dh.length<=512&&auth.length>=8&&auth.length<=256;
}
async function sendEmail(env,{to,subject,text,html}){
 if(!env.RESEND_API_KEY||!env.EMAIL_FROM)throw new Error('Email delivery is not configured');
 const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[to],subject,text,html})});
 if(!r.ok){let detail='';try{detail=JSON.stringify(await r.json())}catch{}throw new Error(`Resend ${r.status}${detail?` ${detail.slice(0,300)}`:''}`)}
 return r.json().catch(()=>({}))
}
async function sendPush(env,row){
 if(!vapidReady(env))throw new Error('Web Push VAPID keys are not configured');
 const subscription={endpoint:row.endpoint,expirationTime:null,keys:{p256dh:row.p256dh,auth:row.auth}};
 const message={
  data:JSON.stringify({title:row.title,body:row.body,tag:`drivehub-${row.reminder_key}`,icon:'/garage/icons/drivehub-192.png',badge:'/garage/icons/drivehub-192.png',data:{url:'/garage/',screen:'reminders'}}),
  options:{ttl:86400}
 };
 const payload=await buildPushPayload(message,subscription,{subject:env.VAPID_SUBJECT,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY});
 const response=await fetch(subscription.endpoint,payload);
 if(response.status===404||response.status===410){const error=new Error('Push subscription expired');error.expired=true;throw error}
 if(!response.ok)throw new Error(`Push service ${response.status}`);
 return true;
}

async function registerEmail(request,env){
 const data=await body(request),email=normaliseEmail(data.email);if(!validEmail(email))return json({error:'Enter a valid email address'},400);
 if(!env.RESEND_API_KEY||!env.EMAIL_FROM)return json({error:'Email delivery is not configured'},503);
 const previous=await env.DB.prepare('SELECT id,last_code_sent_at FROM notification_subscriptions WHERE email=? ORDER BY updated_at DESC LIMIT 1').bind(email).first();
 if(previous?.last_code_sent_at&&Date.now()-new Date(previous.last_code_sent_at).getTime()<60000)return json({error:'A verification code was sent recently. Wait a minute and try again.'},429);
 const id=previous?.id||crypto.randomUUID(),verificationCode=code(),sentAt=nowIso(),expiresAt=new Date(Date.now()+15*60000).toISOString();
 await env.DB.prepare(`INSERT INTO notification_subscriptions(id,email,code_hash,code_expires_at,last_code_sent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,code_hash=excluded.code_hash,code_expires_at=excluded.code_expires_at,last_code_sent_at=excluded.last_code_sent_at,updated_at=excluded.updated_at`).bind(id,email,await sha(verificationCode),expiresAt,sentAt,sentAt,sentAt).run();
 await sendEmail(env,{to:email,subject:'Verify your DriveHub reminder email',text:`Your DriveHub verification code is ${verificationCode}. It expires in 15 minutes.`,html:`<div style="font-family:Arial,sans-serif;max-width:520px"><h2>DriveHub</h2><p>Use this code to enable email reminders:</p><p style="font-size:30px;font-weight:700;letter-spacing:5px">${verificationCode}</p><p>This code expires in 15 minutes.</p></div>`});
 return json({subscriptionId:id,email,pending:true})
}
async function verifyEmail(request,env){
 const data=await body(request),id=String(data.subscriptionId||''),verificationCode=String(data.code||'').trim();if(!id||!/^[0-9]{6}$/.test(verificationCode))return json({error:'Enter the six-digit verification code'},400);
 const row=await env.DB.prepare('SELECT * FROM notification_subscriptions WHERE id=?').bind(id).first();if(!row)return json({error:'Verification request not found'},404);if(!row.code_hash||!row.code_expires_at||new Date(row.code_expires_at).getTime()<Date.now())return json({error:'That verification code has expired. Send a new one.'},400);if(await sha(verificationCode)!==row.code_hash)return json({error:'That verification code is not correct'},400);
 const token=randomToken(32),at=nowIso();await env.DB.prepare('UPDATE notification_subscriptions SET verified_at=?,token_hash=?,code_hash=NULL,code_expires_at=NULL,updated_at=? WHERE id=?').bind(at,await sha(token),at,id).run();return json({subscriptionId:id,email:row.email,token,verified:true})
}
async function authenticateEmail(env,id,token){if(!id||!token)return null;const row=await env.DB.prepare('SELECT * FROM notification_subscriptions WHERE id=? AND verified_at IS NOT NULL').bind(id).first();if(!row?.token_hash||await sha(token)!==row.token_hash)return null;return row}
async function syncEmail(request,env){
 const data=await body(request),id=String(data.subscriptionId||''),token=String(data.token||''),sub=await authenticateEmail(env,id,token);if(!sub)return json({error:'Email reminder subscription is not authorised'},401);
 const items=Array.isArray(data.reminders)?data.reminders.slice(0,200):[],at=nowIso();
 const batch=[env.DB.prepare('UPDATE notification_reminders SET active=0,updated_at=? WHERE subscription_id=? AND sent_at IS NULL').bind(at,id)];
 for(const item of items){const key=String(item.key||'').slice(0,180),title=String(item.title||'DriveHub reminder').slice(0,180),message=String(item.body||'').slice(0,600),sendAt=String(item.sendAt||'');if(!key||!sendAt||!Number.isFinite(new Date(sendAt).getTime()))continue;batch.push(env.DB.prepare(`INSERT INTO notification_reminders(subscription_id,reminder_key,title,body,send_at,active,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(subscription_id,reminder_key) DO UPDATE SET title=excluded.title,body=excluded.body,active=1,updated_at=excluded.updated_at,send_at=excluded.send_at,sent_at=CASE WHEN notification_reminders.send_at=excluded.send_at THEN notification_reminders.sent_at ELSE NULL END,attempts=CASE WHEN notification_reminders.send_at=excluded.send_at THEN notification_reminders.attempts ELSE 0 END,last_error=NULL`).bind(id,key,title,message,sendAt,at))}
 if(batch.length)await env.DB.batch(batch);return json({ok:true,scheduled:Math.max(0,batch.length-1),email:sub.email})
}
async function removeEmail(request,env){const data=await body(request),id=String(data.subscriptionId||''),token=String(data.token||''),sub=await authenticateEmail(env,id,token);if(!sub)return json({error:'Email reminder subscription is not authorised'},401);await env.DB.prepare('DELETE FROM notification_subscriptions WHERE id=?').bind(id).run();return json({ok:true})}

async function pushConfig(_request,env){if(!vapidReady(env))return json({error:'Web Push is not configured'},503);return json({vapidPublicKey:env.VAPID_PUBLIC_KEY})}
async function registerPush(request,env){
 if(!vapidReady(env))return json({error:'Web Push is not configured'},503);
 const data=await body(request),subscription=data.subscription;if(!validPushSubscription(subscription))return json({error:'Invalid browser push subscription'},400);
 const endpoint=String(subscription.endpoint),endpointHash=await sha(endpoint),existing=await env.DB.prepare('SELECT id FROM notification_push_devices WHERE endpoint_hash=?').bind(endpointHash).first();
 const id=existing?.id||crypto.randomUUID(),token=randomToken(32),at=nowIso();
 if(existing){
  await env.DB.prepare('UPDATE notification_push_devices SET endpoint=?,p256dh=?,auth=?,token_hash=?,active=1,last_error=NULL,updated_at=? WHERE id=?').bind(endpoint,String(subscription.keys.p256dh),String(subscription.keys.auth),await sha(token),at,id).run();
 }else{
  await env.DB.prepare('INSERT INTO notification_push_devices(id,endpoint,endpoint_hash,p256dh,auth,token_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)').bind(id,endpoint,endpointHash,String(subscription.keys.p256dh),String(subscription.keys.auth),await sha(token),at,at).run();
 }
 return json({deviceId:id,token,registered:true})
}
async function authenticatePush(env,id,token){if(!id||!token)return null;const row=await env.DB.prepare('SELECT * FROM notification_push_devices WHERE id=? AND active=1').bind(id).first();if(!row?.token_hash||await sha(token)!==row.token_hash)return null;return row}
async function syncPush(request,env){
 const data=await body(request),id=String(data.deviceId||''),token=String(data.token||''),device=await authenticatePush(env,id,token);if(!device)return json({error:'Browser push subscription is not authorised'},401);
 const items=Array.isArray(data.reminders)?data.reminders.slice(0,200):[],at=nowIso();
 const batch=[env.DB.prepare('UPDATE notification_push_reminders SET active=0,updated_at=? WHERE device_id=? AND sent_at IS NULL').bind(at,id)];
 for(const item of items){const key=String(item.key||'').slice(0,180),title=String(item.title||'DriveHub reminder').slice(0,180),message=String(item.body||'').slice(0,600),sendAt=String(item.sendAt||'');if(!key||!sendAt||!Number.isFinite(new Date(sendAt).getTime()))continue;batch.push(env.DB.prepare(`INSERT INTO notification_push_reminders(device_id,reminder_key,title,body,send_at,active,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(device_id,reminder_key) DO UPDATE SET title=excluded.title,body=excluded.body,active=1,updated_at=excluded.updated_at,send_at=excluded.send_at,sent_at=CASE WHEN notification_push_reminders.send_at=excluded.send_at THEN notification_push_reminders.sent_at ELSE NULL END,attempts=CASE WHEN notification_push_reminders.send_at=excluded.send_at THEN notification_push_reminders.attempts ELSE 0 END,last_error=NULL`).bind(id,key,title,message,sendAt,at))}
 if(batch.length)await env.DB.batch(batch);return json({ok:true,scheduled:Math.max(0,batch.length-1)})
}
async function removePush(request,env){const data=await body(request),id=String(data.deviceId||''),token=String(data.token||''),device=await authenticatePush(env,id,token);if(!device)return json({error:'Browser push subscription is not authorised'},401);await env.DB.prepare('DELETE FROM notification_push_devices WHERE id=?').bind(id).run();return json({ok:true})}

async function sendDueEmail(env){
 if(!env.RESEND_API_KEY||!env.EMAIL_FROM)return;
 const due=await env.DB.prepare(`SELECT r.subscription_id,r.reminder_key,r.title,r.body,r.send_at,r.attempts,s.email FROM notification_reminders r JOIN notification_subscriptions s ON s.id=r.subscription_id WHERE r.active=1 AND r.sent_at IS NULL AND s.verified_at IS NOT NULL AND r.send_at<=? AND r.attempts<5 ORDER BY r.send_at LIMIT 50`).bind(nowIso()).all();
 for(const row of due.results||[]){try{await sendEmail(env,{to:row.email,subject:`DriveHub reminder: ${row.title}`,text:`${row.title}\n\n${row.body}\n\nOpen DriveHub to review your garage.`,html:`<div style="font-family:Arial,sans-serif;max-width:560px"><p style="font-size:12px;letter-spacing:.12em;color:#667085">DRIVEHUB REMINDER</p><h2>${escapeHtml(row.title)}</h2><p>${escapeHtml(row.body)}</p><p style="color:#667085;font-size:13px">Open DriveHub to review your garage.</p></div>`});await env.DB.prepare('UPDATE notification_reminders SET sent_at=?,last_error=NULL WHERE subscription_id=? AND reminder_key=?').bind(nowIso(),row.subscription_id,row.reminder_key).run()}catch(err){await env.DB.prepare('UPDATE notification_reminders SET attempts=attempts+1,last_error=?,active=CASE WHEN attempts+1>=5 THEN 0 ELSE active END WHERE subscription_id=? AND reminder_key=?').bind(String(err?.message||err).slice(0,500),row.subscription_id,row.reminder_key).run()}}
}
async function sendDuePush(env){
 if(!vapidReady(env))return;
 const due=await env.DB.prepare(`SELECT r.device_id,r.reminder_key,r.title,r.body,r.send_at,r.attempts,d.endpoint,d.p256dh,d.auth FROM notification_push_reminders r JOIN notification_push_devices d ON d.id=r.device_id WHERE r.active=1 AND r.sent_at IS NULL AND d.active=1 AND r.send_at<=? AND r.attempts<5 ORDER BY r.send_at LIMIT 75`).bind(nowIso()).all();
 for(const row of due.results||[]){
  try{await sendPush(env,row);const at=nowIso();await env.DB.batch([env.DB.prepare('UPDATE notification_push_reminders SET sent_at=?,last_error=NULL WHERE device_id=? AND reminder_key=?').bind(at,row.device_id,row.reminder_key),env.DB.prepare('UPDATE notification_push_devices SET last_success_at=?,last_error=NULL,updated_at=? WHERE id=?').bind(at,at,row.device_id)])}
  catch(err){const message=String(err?.message||err).slice(0,500);if(err?.expired){const at=nowIso();await env.DB.batch([env.DB.prepare('UPDATE notification_push_devices SET active=0,last_error=?,updated_at=? WHERE id=?').bind(message,at,row.device_id),env.DB.prepare('UPDATE notification_push_reminders SET active=0,last_error=? WHERE device_id=? AND sent_at IS NULL').bind(message,row.device_id)])}else{await env.DB.prepare('UPDATE notification_push_reminders SET attempts=attempts+1,last_error=?,active=CASE WHEN attempts+1>=5 THEN 0 ELSE active END WHERE device_id=? AND reminder_key=?').bind(message,row.device_id,row.reminder_key).run()}}
 }
}
function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
export default {
 async fetch(request,env){
  if(!authorised(request,env))return json({error:'Not authorised'},401);
  const path=new URL(request.url).pathname;if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(path==='/register')return registerEmail(request,env);
  if(path==='/verify')return verifyEmail(request,env);
  if(path==='/sync')return syncEmail(request,env);
  if(path==='/delete')return removeEmail(request,env);
  if(path==='/push/config')return pushConfig(request,env);
  if(path==='/push/register')return registerPush(request,env);
  if(path==='/push/sync')return syncPush(request,env);
  if(path==='/push/delete')return removePush(request,env);
  return json({error:'Not found'},404)
 },
 async scheduled(_event,env,ctx){ctx.waitUntil(Promise.all([sendDueEmail(env),sendDuePush(env)]))}
};
