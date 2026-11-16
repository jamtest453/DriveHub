(()=>{
  'use strict';
  const plural=(n,one,many=`${one}s`)=>`${n} ${n===1?one:many}`;
  const setStatus=(id,text,state='local')=>{const el=document.getElementById(id);if(!el)return;el.textContent=text;el.dataset.state=state};
  const toolDestinations={garage:'/garage/',valuation:'/valuation/',roads:'/roads/',search:'/search/'};

  const syncRecentTool=()=>{
    const resume=document.getElementById('resume-tool'),label=document.getElementById('resume-tool-label');
    if(!resume||!label)return;
    let recent=null;
    try{recent=JSON.parse(localStorage.getItem('drivehub.lastTool.v1')||'null')}catch{}
    const tool=String(recent?.tool||'');
    if(!toolDestinations[tool]){resume.hidden=true;return}
    label.textContent=`Continue in ${recent.label||({garage:'MyGarage',valuation:'Valuation',roads:'Road Finder',search:'Car Search'}[tool])}`;
    resume.href=toolDestinations[tool];
    resume.dataset.tool=tool;
    resume.hidden=false;
  };

  const syncGarageCount=()=>{
    const el=document.getElementById('garage-count');if(!el)return;
    el.textContent='Open MyGarage';
    try{
      const raw=localStorage.getItem('garage.mvp.v1.anonymous');
      const data=raw?JSON.parse(raw):null;
      const count=Array.isArray(data?.vehicles)?data.vehicles.length:0;
      if(count)el.textContent=`${plural(count,'car')} in MyGarage`;
    }catch{}
  };

  const syncValuationCount=()=>{
    const el=document.getElementById('valuation-count');if(!el)return;
    el.textContent='Value any car';
    try{
      const items=JSON.parse(localStorage.getItem('drivehub.valuation.saved.v1')||'[]');
      const count=Array.isArray(items)?items.length:0;
      if(count)el.textContent=`${plural(count,'saved valuation')}`;
    }catch{}
  };

  async function countRoadCaches(){
    if(!('indexedDB' in window)||typeof indexedDB.databases!=='function')return 0;
    try{
      const dbs=await indexedDB.databases();
      if(!dbs.some(db=>db?.name==='RoadFinderDataCache'))return 0;
    }catch{return 0}
    return new Promise(resolve=>{
      let request;
      try{request=indexedDB.open('RoadFinderDataCache')}catch{return resolve(0)}
      request.onerror=()=>resolve(0);
      request.onsuccess=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('api_cache')){db.close();resolve(0);return}
        let count=0;
        const tx=db.transaction('api_cache','readonly');
        const cursor=tx.objectStore('api_cache').openKeyCursor();
        cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;const key=String(row.key||'');if(key.startsWith('search-result:'))count++;row.continue()};
        tx.oncomplete=()=>{db.close();resolve(count)};
        tx.onerror=()=>{db.close();resolve(0)};
      };
    });
  }

  let roadCountSeq=0;
  const syncRoadCacheCount=async()=>{
    const seq=++roadCountSeq;
    const count=await countRoadCaches();
    if(seq!==roadCountSeq)return;
    const el=document.getElementById('roads-cache-count');if(!el)return;
    el.textContent=count?`${plural(count,'cached search','cached searches')} ready`:'Find a road';
  };

  const syncContinuity=()=>{
    syncRecentTool();
    syncGarageCount();
    syncValuationCount();
    syncRoadCacheCount();
  };

  const syncOffline=()=>{
    if(navigator.onLine!==false)return;
    setStatus('garage-live-status','Offline · saved data available','offline');
    setStatus('valuation-live-status','Offline · saved valuations available','offline');
    setStatus('roads-live-status','Offline · cached searches available','offline');
    setStatus('search-live-status','Offline · live searches unavailable','offline');
  };

  let integrationSeq=0;
  async function loadIntegrationStatus(){
    const seq=++integrationSeq;
    if(!(window.DriveHubRuntime?.hasHostedBackend||/^https?:$/.test(location.protocol))){syncOffline();return}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4500);
    try{
      const r=await fetch(window.DriveHubRuntime?.apiUrl?.('/api/integrations/status')||'/api/integrations/status',{cache:'no-store',signal:controller.signal});
      if(!r.ok)throw new Error();
      const data=await r.json();
      if(seq!==integrationSeq)return;
      const vehicleReady=Boolean(data.dvla?.configured||data.dvsa?.configured);
      setStatus('garage-live-status',vehicleReady?'Live vehicle data ready':'Local records ready',vehicleReady?'ready':'local');
      const valuationReady=Boolean(data.ebay?.configured);
      setStatus('valuation-live-status',valuationReady?'Live market data ready':'Saved history available',valuationReady?'ready':'warn');
      const roadsReady=Boolean(data.roadFinder?.configured);
      setStatus('roads-live-status',roadsReady?'Live routing ready':'Cached searches available',roadsReady?'ready':'warn');
      // Reachability is verified separately by the tool proxy's public auth endpoint.
      void checkCarSearchStatus();
    }catch{
      if(seq!==integrationSeq)return;
      if(navigator.onLine===false)syncOffline();
      else{
        setStatus('garage-live-status','Live status unavailable','warn');
        setStatus('valuation-live-status','Live status unavailable','warn');
        setStatus('roads-live-status','Live status unavailable','warn');
        setStatus('search-live-status','Live status unavailable','warn');
      }
    }finally{clearTimeout(timer)}
  }

  async function checkCarSearchStatus(){
    if(!/^https?:$/.test(location.protocol)){
      setStatus('search-live-status','Live service needed','warn');
      return;
    }
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4500);
    try{
      const response=await fetch((window.DriveHubRuntime?.apiUrl?.('/car-search-app/api/auth')||'/car-search-app/api/auth'),
        {cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error('Car Search unavailable');
      const status=await response.json();
      setStatus('search-live-status',status.authenticated?'Your saved searches are ready':'Sign in to Car Search',status.authenticated?'ready':'warn');
      setStatus('search-count','Open Car Search');
    }catch{
      setStatus('search-live-status',navigator.onLine===false?'Offline · live searches unavailable':'Car Search service unavailable','warn');
    }finally{clearTimeout(timer)}
  }

  const refreshGateway=()=>{syncContinuity();loadIntegrationStatus()};
  syncContinuity();
  loadIntegrationStatus();
  if(!/^https?:$/.test(location.protocol))checkCarSearchStatus();
  window.addEventListener('drivehub-last-tool',syncRecentTool);
  window.addEventListener('storage',syncContinuity);
  window.addEventListener('offline',syncOffline);
  window.addEventListener('online',loadIntegrationStatus);
  // Back/Forward Cache restores the old DOM without rerunning this script. Refresh
  // continuity/status on restore so Home never shows pre-navigation counts/state.
  window.addEventListener('pageshow',event=>{if(event.persisted)refreshGateway()});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncContinuity()});

  if(/^https?:$/.test(location.protocol))document.querySelectorAll('[data-http-href]').forEach(a=>a.href=a.dataset.httpHref);
})();
