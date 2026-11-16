const clean=registration=>String(registration||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
async function fetchWithTimeout(url,options={},timeoutMs=6000){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await fetch(url,{...options,signal:controller.signal})}finally{clearTimeout(timer)}}
export async function lookupVehicle(registration){
  const reg=clean(registration);if(!reg)throw new Error('Enter a registration first.');
  if(!(window.DriveHubRuntime?.hasHostedBackend||/^https?:$/.test(location.protocol)))throw new Error('Live vehicle lookup requires DriveHub to be connected to its hosted service.');
  let response;
  try{response=await fetchWithTimeout(window.DriveHubRuntime?.apiUrl?.(`/api/vehicle?registration=${encodeURIComponent(reg)}`)||`/api/vehicle?registration=${encodeURIComponent(reg)}`,{headers:{accept:'application/json'}},18000)}
  catch(err){if(err?.name==='AbortError')throw new Error('Vehicle lookup timed out. You can continue manually or try again.');throw new Error('Could not reach the vehicle lookup service. You can continue manually or try again.')}
  const data=await response.json().catch(()=>({}));
  if(response.ok)return data;
  if(response.status===404)throw new Error('Vehicle not found. Check the registration and try again.');
  if(response.status===429)throw new Error(data.error||'Too many vehicle lookups. Wait a little and try again.');
  if(response.status===503)throw new Error('Live vehicle lookup is not configured on this DriveHub deployment.');
  throw new Error(data.error||`Vehicle lookup failed (${response.status})`);
}
export async function integrationStatus(){if(!(window.DriveHubRuntime?.hasHostedBackend||/^https?:$/.test(location.protocol)))return {localMode:true,dvla:{configured:false},dvsa:{configured:false},ebay:{configured:false}};try{const r=await fetchWithTimeout(window.DriveHubRuntime?.apiUrl?.('/api/integrations/status')||'/api/integrations/status',{},2200);if(!r.ok)return null;return r.json()}catch{return null}}
