import {getAssetBlob,putAssetBlob,hasAsset,referencedAssetIds,stripAssetPayloads,migrateLegacyAssets} from '../storage/assets.js';
const GOOGLE_SCRIPT='https://accounts.google.com/gsi/client';
const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.appdata openid email profile';
const SYNC_FILE='drivehub-sync.json';
const LEGACY_SYNC_FILE='garage-sync.json';
const ASSET_PREFIX='drivehub-asset-';
const CONNECTED_HINT='drivehub.google.connected';

let config={configured:false,clientId:''};
let scriptPromise=null;
let tokenClient=null;
let accessToken='';
let expiresAt=0;
let syncFileId='';
let user=null;
let status={state:'local',message:'Saved on this device'};
let onStatus=()=>{};

function emit(next){
  status={...status,...next};
  onStatus(status,user);
}

async function loadGoogleScript(){
  if(window.google?.accounts?.oauth2)return;
  if(scriptPromise)return scriptPromise;
  scriptPromise=new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>{if(settled)return;settled=true;scriptPromise=null;reject(new Error('Google sign-in took too long to load. Try again.'))},10000);
    const done=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve()};
    const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);scriptPromise=null;reject(new Error('Could not load Google sign-in'))};
    const existing=document.querySelector('script[data-garage-google]');
    if(existing){
      existing.addEventListener('load',done,{once:true});
      existing.addEventListener('error',fail,{once:true});
      return;
    }
    const s=document.createElement('script');
    s.src=GOOGLE_SCRIPT;
    s.async=true;
    s.defer=true;
    s.dataset.garageGoogle='1';
    s.onload=done;
    s.onerror=fail;
    document.head.appendChild(s);
  });
  return scriptPromise;
}

async function api(url,options={}){
  if(!accessToken||Date.now()>=expiresAt-30000)throw new Error('Google sign-in has expired. Sign in again to resume sync.');
  const headers=new Headers(options.headers||{});
  headers.set('Authorization',`Bearer ${accessToken}`);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  let r;
  try{r=await fetch(url,{...options,headers,signal:controller.signal})}
  catch(err){if(err?.name==='AbortError')throw new Error('Google Drive took too long to respond. Try again.');throw err}
  finally{clearTimeout(timer)}
  if(r.status===401){
    accessToken='';
    emit({state:'needs-auth',message:'Sign in again to resume sync'});
    throw new Error('Google sign-in has expired. Sign in again to resume sync.');
  }
  if(!r.ok){
    let detail='';
    try{detail=(await r.json())?.error?.message||''}catch{}
    throw new Error(detail||`Google Drive sync failed (${r.status})`);
  }
  return r;
}

async function fetchUser(){
  try{
    const r=await api('https://www.googleapis.com/oauth2/v3/userinfo');
    const x=await r.json();
    return {name:x.name||'',email:x.email||'',picture:x.picture||''};
  }catch{
    return {name:'Google account',email:'',picture:''};
  }
}

async function findSyncFile(){
  const q=encodeURIComponent(`(name='${SYNC_FILE.replace(/'/g,"\\'")}' or name='${LEGACY_SYNC_FILE.replace(/'/g,"\\'")}') and trashed=false`);
  const r=await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=1`);
  const x=await r.json();
  const file=x.files?.[0]||null;
  syncFileId=file?.id||'';
  return file;
}


function assetFileName(assetId){return `${ASSET_PREFIX}${encodeURIComponent(assetId)}`}
function assetIdFromName(name){try{return decodeURIComponent(String(name||'').slice(ASSET_PREFIX.length))}catch{return ''}}
async function listRemoteAssets(){
  const q=encodeURIComponent(`name contains '${ASSET_PREFIX}' and trashed=false`),files=[];
  let pageToken='';
  do{
    const suffix=pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:'';
    const r=await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=nextPageToken,files(id,name,size,modifiedTime)&pageSize=1000${suffix}`);
    const x=await r.json();files.push(...(x.files||[]));pageToken=x.nextPageToken||'';
  }while(pageToken);
  return new Map(files.map(f=>[assetIdFromName(f.name),f]).filter(([id])=>id));
}
async function uploadAsset(assetId,blob){
  const boundary=`drivehub_${Math.random().toString(36).slice(2)}`;
  const metadata=JSON.stringify({name:assetFileName(assetId),parents:['appDataFolder']});
  const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${blob.type||'application/octet-stream'}\r\n\r\n`,blob,`\r\n--${boundary}--`],{type:`multipart/related; boundary=${boundary}`});
  const r=await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
  return r.json();
}
async function syncAssetsToDrive(state){
  const ids=[...referencedAssetIds(state)];if(!ids.length)return {uploaded:0,missing:0};
  const remote=await listRemoteAssets();let uploaded=0,missing=0;
  for(const id of ids){if(remote.has(id))continue;const blob=await getAssetBlob(id);if(!blob){missing++;continue}await uploadAsset(id,blob);uploaded++}
  return {uploaded,missing};
}
async function restoreAssetsFromDrive(state){
  const ids=[...referencedAssetIds(state)];if(!ids.length)return {restored:0,missing:0};
  const remote=await listRemoteAssets();let restored=0,missing=0;
  for(const id of ids){if(await hasAsset(id))continue;const file=remote.get(id);if(!file){missing++;continue}const r=await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);const blob=await r.blob();await putAssetBlob(id,blob,{updatedAt:file.modifiedTime||new Date().toISOString()});restored++}
  return {restored,missing};
}

async function readSyncFile(){
  const file=await findSyncFile();
  if(!file)return null;
  const r=await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
  try{const data=await r.json();if(data)await restoreAssetsFromDrive(data);return data}catch{return null}
}

async function createSyncFile(data){
  const boundary=`garage_${Math.random().toString(36).slice(2)}`;
  const metadata=JSON.stringify({name:SYNC_FILE,parents:['appDataFolder'],mimeType:'application/json'});
  const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
  const r=await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime',{
    method:'POST',
    headers:{'Content-Type':`multipart/related; boundary=${boundary}`},
    body
  });
  const x=await r.json();
  syncFileId=x.id||'';
  return x;
}

async function updateSyncFile(data){
  if(!syncFileId)await findSyncFile();
  if(!syncFileId)return createSyncFile(data);
  const r=await api(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(syncFileId)}?uploadType=media&fields=id,modifiedTime`,{
    method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data)
  });
  return r.json();
}

function requestToken(prompt='select_account'){
  return new Promise(async(resolve,reject)=>{
    await loadGoogleScript();
    if(!config.configured||!config.clientId)return reject(new Error('Google sync is not configured'));
    tokenClient=google.accounts.oauth2.initTokenClient({
      client_id:config.clientId,
      scope:DRIVE_SCOPE,
      callback:async response=>{
        if(response?.error)return reject(new Error(response.error_description||response.error));
        accessToken=response.access_token||'';
        expiresAt=Date.now()+Number(response.expires_in||3600)*1000;
        try{
          user=await fetchUser();
          emit({state:'connected',message:'Connected to Google Drive'});
          resolve(user);
        }catch(err){reject(err)}
      },
      error_callback:err=>reject(new Error(err?.message||'Google sign-in was cancelled'))
    });
    tokenClient.requestAccessToken({prompt});
  });
}

export async function initializeGoogleDriveSync(callback){
  onStatus=typeof callback==='function'?callback:()=>{};
  if(!(window.DriveHubRuntime?.hasHostedBackend||/^https?:$/.test(location.protocol))){
    config={configured:false,clientId:'',localFileMode:true};
    emit({state:'local',message:'Google sync is available when DriveHub is hosted'});
    return config;
  }
  try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);let r;
    try{r=await fetch(window.DriveHubRuntime?.apiUrl?.('/api/google-config')||'/api/google-config',{cache:'no-store',signal:controller.signal})}finally{clearTimeout(timer)}
    if(!r.ok)throw new Error();
    config=await r.json();
  }catch{
    config={configured:false,clientId:''};
  }
  emit({state:config.configured?'signed-out':'unconfigured',message:config.configured?'Optional Google sync':'Google sync needs setup'});
  return config;
}

export async function signInGoogleDrive(){
  await requestToken('select_account');
  try{localStorage.setItem(CONNECTED_HINT,'1')}catch{}
  return {user,remote:await readSyncFile()};
}
export async function restoreGoogleDriveSession(){
  let hinted=false;try{hinted=localStorage.getItem(CONNECTED_HINT)==='1'}catch{}
  if(!hinted||!config.configured)return null;
  try{await requestToken('');return {user,remote:await readSyncFile()}}catch{emit({state:'needs-auth',message:'Sign in again to resume sync'});return null}
}

export async function syncGoogleDrive(localState,mergeState){
  if(!user||!accessToken||Date.now()>=expiresAt-30000){
    emit({state:user?'needs-auth':'signed-out',message:user?'Sign in again to resume sync':'Not signed in'});
    return null;
  }
  emit({state:'syncing',message:'Syncing…'});
  try{
    const remote=await readSyncFile();
    const merged=remote&&typeof mergeState==='function'?mergeState(remote,localState):localState;
    await migrateLegacyAssets(merged);
    await restoreAssetsFromDrive(merged);
    emit({state:'syncing',message:'Syncing photos and paperwork…'});
    const assetResult=await syncAssetsToDrive(merged);
    await updateSyncFile(stripAssetPayloads(merged));
    emit({state:'synced',message:assetResult.missing?`Synced · ${assetResult.missing} local file${assetResult.missing===1?'':'s'} unavailable`:'Synced with Google Drive'});
    return merged;
  }catch(err){
    emit({state:'error',message:err?.message||'Google Drive sync failed'});
    throw err;
  }
}

export function signOutGoogleDrive(){
  const token=accessToken;
  accessToken='';
  expiresAt=0;
  syncFileId='';
  user=null;
  try{localStorage.removeItem(CONNECTED_HINT)}catch{}
  if(token&&window.google?.accounts?.oauth2)try{google.accounts.oauth2.revoke(token,()=>{})}catch{}
  emit({state:config.configured?'signed-out':'unconfigured',message:config.configured?'Not signed in':'Google sync needs setup'});
}

export function googleDriveSnapshot(){
  return {config:{...config},user:user?{...user}:null,status:{...status},authenticated:Boolean(user&&accessToken&&Date.now()<expiresAt-30000)};
}
