function envValue(name){let value=String(process.env[name]??'').trim();if(value.length>=2&&((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))))value=value.slice(1,-1).trim();return value}
function json(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data))}
async function readBody(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>160000)throw new Error('Body too large')}return body?JSON.parse(body):{}}
async function fetchWithTimeout(url,options={},timeoutMs=8000){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(url,{...options,signal:controller.signal})}finally{clearTimeout(timer)}}
export function notificationRelayStatus(){const configured=Boolean(envValue('NOTIFICATION_RELAY_URL')&&envValue('NOTIFICATION_RELAY_SECRET'));return {notifications:{configured,channels:{email:configured,browserPush:configured}}}}
export async function handleNotificationRelay(req,res,pathname){
 const base=envValue('NOTIFICATION_RELAY_URL').replace(/\/$/,'');
 const secret=envValue('NOTIFICATION_RELAY_SECRET');
 if(!base||!secret)return json(res,503,{error:'Notification relay is not configured',code:'NOT_CONFIGURED'});
 const routes={
  '/api/notifications/register':'/register',
  '/api/notifications/verify':'/verify',
  '/api/notifications/sync':'/sync',
  '/api/notifications/delete':'/delete',
  '/api/notifications/push/config':'/push/config',
  '/api/notifications/push/register':'/push/register',
  '/api/notifications/push/sync':'/push/sync',
  '/api/notifications/push/delete':'/push/delete'
 };
 const target=routes[pathname];if(!target)return false;
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 let payload;try{payload=await readBody(req)}catch{return json(res,400,{error:'Invalid request'})}
 try{
  const r=await fetchWithTimeout(`${base}${target}`,{method:'POST',headers:{'content-type':'application/json','x-drivehub-relay-secret':secret},body:JSON.stringify(payload)},10000);
  const data=await r.json().catch(()=>({error:`Notification relay failed (${r.status})`}));
  return json(res,r.status,data)
 }catch(err){return json(res,502,{error:err?.name==='AbortError'?'Notification relay timed out':'Could not reach the notification relay'})}
}
