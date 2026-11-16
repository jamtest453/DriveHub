/* DriveHub v142.21 shared web/native runtime. */
(()=>{
  'use strict';
  if(globalThis.DriveHubRuntime?.version==='142.21')return;

  const cap=globalThis.Capacitor;
  const platform=(()=>{try{return cap?.getPlatform?.()||''}catch{return ''}})();
  const isNative=Boolean((()=>{try{return cap?.isNativePlatform?.()}catch{return false}})())||platform==='android'||platform==='ios';
  const metaOrigin=String(document.querySelector('meta[name="drivehub-api-origin"]')?.content||'').trim();
  const configuredOrigin=String(globalThis.DRIVEHUB_APP_API_ORIGIN||metaOrigin||'').trim();
  const normalizeOrigin=value=>{
    if(!value)return '';
    try{const u=new URL(value);return /^https?:$/.test(u.protocol)?u.origin:''}catch{return ''}
  };
  const apiOrigin=normalizeOrigin(configuredOrigin);
  const ownHosted=/^https?:$/.test(String(location.protocol||''))&&!isNative;
  const hasHostedBackend=Boolean(apiOrigin||ownHosted||(()=>{try{return window.parent!==window&&/^https?:$/.test(parent.location.protocol)}catch{return false}})());

  function apiUrl(path){
    const value=String(path||'');
    if(!value)return value;
    if(/^https?:\/\//i.test(value))return value;
    if(apiOrigin){try{return new URL(value,apiOrigin).href}catch{}}
    if(ownHosted)return value;
    try{
      if(window.parent!==window&&/^https?:$/.test(parent.location.protocol))return new URL(value,parent.location.origin).href;
    }catch{}
    return value;
  }

  function updaterPlugin(){
    if(!isNative||!cap)return null;
    try{
      if(typeof cap.registerPlugin==='function')return cap.registerPlugin('CapacitorUpdater');
      return cap.Plugins?.CapacitorUpdater||null;
    }catch{return cap.Plugins?.CapacitorUpdater||null}
  }

  let readyNotified=false;
  let bootFailed=false;
  async function notifyAppReady(){
    if(readyNotified||bootFailed||!isNative)return false;
    const updater=updaterPlugin();
    if(!updater?.notifyAppReady)return false;
    try{
      await updater.notifyAppReady();
      readyNotified=true;
      return true;
    }catch(err){
      console.warn('DriveHub native updater readiness signal failed',err);
      return false;
    }
  }

  globalThis.DriveHubRuntime={
    version:'142.21',
    platform,
    isNative,
    apiOrigin,
    hasHostedBackend,
    apiUrl,
    notifyAppReady
  };

  // A newly downloaded bundle is only acknowledged after the window finishes
  // loading and survives a short grace period without an uncaught JS failure.
  // If that never happens, the native updater can restore its previous bundle.
  if(isNative){
    window.addEventListener('error',event=>{if(event?.error)bootFailed=true});
    window.addEventListener('unhandledrejection',()=>{bootFailed=true});
    const confirmHealthyBoot=()=>setTimeout(()=>notifyAppReady(),1200);
    if(document.readyState==='complete')confirmHealthyBoot();
    else window.addEventListener('load',confirmHealthyBoot,{once:true});
  }
})();
