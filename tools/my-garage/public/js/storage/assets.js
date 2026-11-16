const DB_NAME='drivehub-assets-v1';
const DB_VERSION=1;
const STORE='assets';
let dbPromise=null;

function openDb(){
  if(!('indexedDB' in globalThis))return Promise.reject(new Error('This browser does not support the local file store DriveHub needs for photos and paperwork.'));
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Could not open DriveHub local file storage.'));
    request.onblocked=()=>reject(new Error('DriveHub local file storage is blocked by another open version of the app. Close other DriveHub tabs and try again.'));
  });
  return dbPromise;
}
function requestResult(request){return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('Local file storage failed.'))})}
async function withStore(mode,fn){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);let result;try{result=fn(store)}catch(err){reject(err);return}tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||new Error('Local file storage failed.'));tx.onabort=()=>reject(tx.error||new Error('Local file storage was interrupted.'))})}
function dataUrlToBlob(dataUrl){
  const match=String(dataUrl||'').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if(!match)throw new Error('The selected file could not be prepared for local storage.');
  const type=match[1]||'application/octet-stream',isBase64=!!match[2],body=match[3]||'';
  const binary=isBase64?atob(body):decodeURIComponent(body),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type});
}
function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error||new Error('Could not read a locally stored file.'));reader.readAsDataURL(blob)})}
function assetIdFor(kind,vehicleId,itemId){return `${kind}:${String(vehicleId||'vehicle')}:${String(itemId||crypto.randomUUID?.()||Date.now())}`}
async function putAssetBlob(id,blob,meta={}){
  if(!id||!(blob instanceof Blob))throw new Error('DriveHub could not prepare that file for local storage.');
  try{
    await withStore('readwrite',store=>store.put({id,blob,type:blob.type||meta.type||'application/octet-stream',name:meta.name||'',size:Number(blob.size||meta.size||0),updatedAt:meta.updatedAt||new Date().toISOString()}));
    return id;
  }catch(err){
    if(err?.name==='QuotaExceededError')throw new Error('This device is running low on browser storage. Remove some DriveHub files or free device space, then try again.');
    throw new Error(err?.message||'DriveHub could not save that file on this device.');
  }
}
async function putAssetDataUrl(id,dataUrl,meta={}){return putAssetBlob(id,dataUrlToBlob(dataUrl),meta)}
async function getAssetRecord(id){if(!id)return null;const db=await openDb();return requestResult(db.transaction(STORE,'readonly').objectStore(STORE).get(id))}
async function getAssetBlob(id){return (await getAssetRecord(id))?.blob||null}
async function getAssetDataUrl(id){const blob=await getAssetBlob(id);return blob?blobToDataUrl(blob):''}
async function hasAsset(id){return !!(await getAssetRecord(id))}
async function deleteAsset(id){if(!id)return;try{await withStore('readwrite',store=>store.delete(id))}catch{}}
async function clearAssets(){try{await withStore('readwrite',store=>store.clear())}catch{}}
async function allAssetIds(){try{const db=await openDb();return await requestResult(db.transaction(STORE,'readonly').objectStore(STORE).getAllKeys())}catch{return []}}
function referencedAssetIds(state){const ids=new Set();for(const v of state?.vehicles||[]){for(const p of v.photos||[])if(p?.assetId&&!p._deleted)ids.add(p.assetId);for(const d of v.documents||[])if(d?.assetId&&!d._deleted)ids.add(d.assetId)}return ids}
async function pruneAssets(state){const keep=referencedAssetIds(state);for(const id of await allAssetIds())if(!keep.has(id))await deleteAsset(id)}
async function migrateLegacyAssets(state){
  let migrated=0,failed=0;
  for(const v of state?.vehicles||[]){
    for(const p of v.photos||[]){
      if(!p?.dataUrl||p.assetId)continue;
      const id=assetIdFor('photo',v.id,p.id);
      try{await putAssetDataUrl(id,p.dataUrl,{name:`${v.registration||'vehicle'}-photo`,updatedAt:p.updatedAt||p.createdAt});p.assetId=id;migrated++}catch{failed++}
    }
    for(const d of v.documents||[]){
      if(!d?.dataUrl||d.assetId||d._deleted)continue;
      const id=assetIdFor('document',v.id,d.id);
      try{await putAssetDataUrl(id,d.dataUrl,{name:d.name,type:d.type,size:d.size,updatedAt:d.updatedAt||d.createdAt});d.assetId=id;migrated++}catch{failed++}
    }
  }
  return {migrated,failed};
}
async function hydrateStateAssets(state){
  let restored=0,missing=0;
  for(const v of state?.vehicles||[]){
    for(const item of [...(v.photos||[]),...(v.documents||[])]){
      if(item?.dataUrl||!item?.assetId||item._deleted)continue;
      try{const dataUrl=await getAssetDataUrl(item.assetId);if(dataUrl){item.dataUrl=dataUrl;restored++}else missing++}catch{missing++}
    }
  }
  return {restored,missing};
}
function stripAssetPayloads(data){
  const copy=JSON.parse(JSON.stringify(data));
  for(const v of copy?.vehicles||[]){
    for(const p of v.photos||[])if(p?.assetId)delete p.dataUrl;
    for(const d of v.documents||[])if(d?.assetId)delete d.dataUrl;
  }
  return copy;
}
async function storageHealth(){
  const supported='indexedDB' in globalThis;
  let usage=null,quota=null,persisted=null;
  try{if(navigator.storage?.estimate){const e=await navigator.storage.estimate();usage=Number(e.usage||0);quota=Number(e.quota||0)}}catch{}
  try{if(navigator.storage?.persisted)persisted=await navigator.storage.persisted()}catch{}
  return {supported,usage,quota,usageRatio:quota?usage/quota:null,persisted};
}
async function requestPersistentStorage(){try{return navigator.storage?.persist?await navigator.storage.persist():false}catch{return false}}
export {assetIdFor,putAssetBlob,putAssetDataUrl,getAssetBlob,getAssetDataUrl,hasAsset,deleteAsset,clearAssets,pruneAssets,migrateLegacyAssets,hydrateStateAssets,stripAssetPayloads,storageHealth,requestPersistentStorage,referencedAssetIds};
