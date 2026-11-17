/* DriveHub v142.10 shared shell behaviour. */
(()=>{
  'use strict';
  const HOME_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10.5V20h11v-9.5"/><path d="M10 20v-5h4v5"/></svg>';
  const BRAND_ICON='<svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="120" fill="#E8F1EE"/><rect x="112" y="112" width="288" height="288" rx="84" fill="#15333B"/><path d="M181 254 L232 207 H280 L331 254" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><path d="M203 258 H309 C320 258 329 267 329 278 V320 H183 V278 C183 267 192 258 203 258Z" stroke="#FFFFFF" stroke-width="18" stroke-linejoin="round" fill="none"/><path d="M208 320V341M304 320V341" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round"/><circle cx="256" cy="289" r="25" fill="#87D7C6"/><path d="M256 272V306M239 289H273" stroke="#15333B" stroke-width="10" stroke-linecap="round"/></svg>';

  const init=()=>{
    // The original Car Search app is normally inside the /search/ tool frame.
    // Only show an independent global header if opened directly in a tab.
    if(location.pathname.startsWith('/car-search-app/')){
      if(window.parent!==window)return;
      if(!document.querySelector('link[data-drivehub-header-style]')){
        const style=document.createElement('link');
        style.rel='stylesheet';style.href='/shared/public/drivehub-chrome.css?v=14232';
        style.dataset.drivehubHeaderStyle='true';document.head.appendChild(style);
      }
    }
    if(document.documentElement.dataset.drivehubChrome==='14232')return;
    document.documentElement.dataset.drivehubChrome='14232';

    let sourceNav=null;
    let sourceObserver=null;
    let desktopNav=null;
    let bodyObserver=null;
    let searchNavSource=null, searchDoc=null, searchObserver=null, facebookObserver=null;
    let searchFrame=null;


    const toolFromLabel=label=>{
      const lower=String(label||'').toLowerCase();
      return lower.includes('valuation')?'valuation':lower.includes('road')?'roads':lower.includes('garage')?'garage':lower.includes('search')?'search':'';
    };
    const displayTool=tool=>tool==='garage'?'MyGarage':tool==='valuation'?'Valuation':tool==='roads'?'Road Finder':tool==='search'?'Car Search':'DriveHub';
    const recordRecent=(tool,label)=>{
      if(!tool)return;
      const recent={tool,label:label||displayTool(tool),at:new Date().toISOString()};
      try{localStorage.setItem('drivehub.lastTool.v1',JSON.stringify(recent))}catch{}
      try{if(window.parent!==window)parent.postMessage({type:'drivehub-tool-visited',recent},'*')}catch{}
    };
    const goHome=()=>{
      // Header branding always returns to the DriveHub gateway, not a tool's
      // internal Home section. The standalone file:// launcher uses messages.
      try{
        if(location.protocol==='file:' && window.parent!==window){
          parent.postMessage({type:'drivehub-home'},'*');return;
        }
        location.assign('/');
      }catch{location.href='/'}
    };
    const cleanCloneHtml=el=>{
      const clone=el.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
      return clone.innerHTML;
    };
    const syncDesktopNav=()=>{
      if(!sourceNav||!desktopNav)return;
      const originals=[...sourceNav.querySelectorAll('.nav-btn:not(.gateway-home)')];
      const proxies=[...desktopNav.querySelectorAll('.drivehub-desktop-nav__item')];
      if(originals.length!==proxies.length){buildDesktopNav(sourceNav);return}
      originals.forEach((original,index)=>{
        const proxy=proxies[index];
        const active=original.classList.contains('active')||original.getAttribute('aria-pressed')==='true'||original.getAttribute('aria-current')==='page';
        proxy.classList.toggle('is-active',active);
        proxy.setAttribute('aria-pressed',active?'true':'false');
        proxy.disabled=original.disabled===true;
        const countOriginal=original.querySelector('.nav-count');
        const countProxy=proxy.querySelector('.nav-count');
        if(countOriginal&&countProxy){countProxy.textContent=countOriginal.textContent;countProxy.hidden=countOriginal.hidden}
      });
    };
    // One global header implementation is used by the Home page and every
    // hosted tool. Bottom navigation remains the source of tool-specific
    // actions, which the header mirrors on desktop.
    const routeTool=()=>{
      const explicit=document.body.dataset.drivehubTool;
      if(['garage','valuation','roads','search'].includes(explicit))return explicit;
      const path=location.pathname;
      if(path.startsWith('/garage/'))return 'garage';
      if(path.startsWith('/valuation/'))return 'valuation';
      if(path.startsWith('/roads/'))return 'roads';
      if(path.startsWith('/search/') || path.startsWith('/car-search-app/'))return 'search';
      return '';
    };
    const ensureGlobalHeader=()=>{
      if(desktopNav)return desktopNav;
      const tool=routeTool();
      const context={
        '':['YOUR CAR TOOLS','All tools'],
        garage:['OWNERSHIP','MyGarage'],
        valuation:['MARKET VALUE','Valuation Tool'],
        roads:['GO DRIVE','Road Finder'],
        search:['RESEARCH & SHORTLIST','Car Search']
      }[tool];
      const shell=document.createElement('header');
      shell.className='drivehub-desktop-nav';
      shell.setAttribute('data-global-header','true');
      const brand=document.createElement('button');
      brand.type='button';
      brand.className='drivehub-desktop-nav__brand';
      brand.setAttribute('aria-label','Go to DriveHub home');
      brand.innerHTML=`<span class="drivehub-desktop-nav__mark">${BRAND_ICON}</span><span class="drivehub-desktop-nav__copy"><strong>DriveHub</strong><span>All car tools</span></span>`;
      brand.addEventListener('click',goHome);
      shell.appendChild(brand);
      const heading=document.createElement('div');
      heading.className='drivehub-desktop-nav__context';
      heading.innerHTML='<span class="drivehub-desktop-nav__eyebrow"></span><strong></strong>';
      heading.querySelector('.drivehub-desktop-nav__eyebrow').textContent=context[0];
      heading.querySelector('strong').textContent=context[1];
      shell.appendChild(heading);
      const actions=document.createElement('nav');
      actions.className='drivehub-desktop-nav__actions';
      actions.setAttribute('aria-label','DriveHub tool navigation');
      if(!tool){
        for(const [name,path] of [['MyGarage','/garage/'],['Valuation','/valuation/'],['Road Finder','/roads/'],['Car Search','/search/']]){
          const item=document.createElement('a');
          item.className='drivehub-desktop-nav__item';item.textContent=name;item.href=path;
          actions.appendChild(item);
        }
      }
      shell.appendChild(actions);
      document.body.appendChild(shell);
      desktopNav=shell;
      return shell;
    };

    // Car Search owns the search data and click handlers. Header controls are
    // mirrors: clicking a header tab dispatches to the live original element.
    // This also works through the same-origin /search/ iframe without moving
    // its DOM nodes out of the Python application's document.
    const syncSearchHeader=()=>{
      if(!searchNavSource?.isConnected||!searchDoc)return;
      const actions=ensureGlobalHeader().querySelector('.drivehub-desktop-nav__actions');
      const previous=document.activeElement;
      const focusedView=previous?.dataset?.searchView;
      const focusedAction=previous?.dataset?.searchAction;
      actions.replaceChildren();
      const tabs=document.createElement('nav');
      tabs.className='drivehub-search-tabs';
      tabs.setAttribute('aria-label','Car Search sections');
      const originals=[...searchNavSource.querySelectorAll('button[data-action="view"]')];
      const active=originals.find(b=>b.classList.contains('selected'))?.dataset.view || 'overview';
      for(const original of originals){
        const tab=document.createElement('button');
        tab.type='button';
        tab.className='drivehub-desktop-nav__item drivehub-search-tab';
        tab.dataset.searchView=original.dataset.view;
        const caption=original.querySelector('.nav-text')?.textContent?.trim() || original.textContent.trim();
        const count=original.querySelector('.nav-new,.nav-number')?.textContent?.trim();
        tab.textContent=caption;
        tab.title=count ? caption+' · '+count+' cars/updates' : caption;
        if(original.dataset.view===active){
          tab.classList.add('is-active');
          tab.setAttribute('aria-current','page');
        }
        tab.addEventListener('click',()=>{
          [...searchNavSource.querySelectorAll('button[data-action="view"]')]
            .find(b=>b.dataset.view===tab.dataset.searchView)?.click();
        });
        tabs.appendChild(tab);
      }
      actions.appendChild(tabs);

      // A compact selector keeps all saved searches available on small screens
      // without expanding the global header to multiple lines.
      const selector=document.createElement('select');
      selector.className='drivehub-search-select';
      selector.setAttribute('aria-label','Choose Car Search section');
      for(const original of originals){
        const option=document.createElement('option');
        option.value=original.dataset.view;
        option.textContent=original.querySelector('.nav-text')?.textContent?.trim() || original.textContent.trim();
        selector.appendChild(option);
      }
      selector.value=active;
      selector.addEventListener('change',()=>{
        [...searchNavSource.querySelectorAll('button[data-action="view"]')]
          .find(b=>b.dataset.view===selector.value)?.click();
      });
      actions.appendChild(selector);

      const buttons=document.createElement('div');
      buttons.className='drivehub-search-actions';
      for(const [id,label,short] of [
        ['facebookLoginTop','Facebook','Facebook'],
        ['settingsTop','Settings','Settings'],
        ['newSearchTop','+ New search','+ New']
      ]){
        const original=searchDoc.getElementById(id);
        if(!original)continue;
        const button=document.createElement('button');
        button.type='button';
        button.className='drivehub-desktop-nav__item drivehub-search-action';
        if(id==='newSearchTop')button.classList.add('drivehub-search-primary');
        if(id==='facebookLoginTop'&&original.classList.contains('fb-connected'))
          button.classList.add('drivehub-search-connected');
        button.dataset.searchAction=id;
        button.setAttribute('aria-label',original.getAttribute('aria-label')||label);
        button.title=original.title||label;
        button.textContent=label;
        if(id==='facebookLoginTop')button.textContent=original.classList.contains('fb-connected')?'✓ Facebook':short;
        button.disabled=original.disabled;
        button.addEventListener('click',()=>searchDoc.getElementById(id)?.click());
        buttons.appendChild(button);
      }
      actions.appendChild(buttons);
      // Restore keyboard focus when the Python dashboard re-renders its nav.
      const follow=(focusedView&&actions.querySelectorAll('[data-search-view]'))
        ?[...actions.querySelectorAll('[data-search-view]')].find(x=>x.dataset.searchView===focusedView):null;
      const focusTarget=follow||(focusedAction?[...actions.querySelectorAll('[data-search-action]')]
        .find(x=>x.dataset.searchAction===focusedAction):null);
      if(focusTarget)focusTarget.focus({preventScroll:true});
    };
    const findSearchNav=()=>{
      const tool=routeTool();
      if(tool!=='search')return;
      const frame=document.getElementById('search-frame');
      if(frame&&frame!==searchFrame){
        searchFrame=frame;
        frame.addEventListener('load',findSearchNav);
      }
      const doc=frame?.contentDocument || (location.pathname.startsWith('/car-search-app/')?document:null);
      const nav=doc?.getElementById('searchNav');
      if(!nav || (nav===searchNavSource&&doc===searchDoc))return;
      searchObserver?.disconnect();facebookObserver?.disconnect();
      searchNavSource=nav;searchDoc=doc;
      searchObserver=new MutationObserver(syncSearchHeader);
      searchObserver.observe(nav,{childList:true,subtree:true,attributes:true,
        attributeFilter:['class','aria-current','aria-pressed']});
      const facebook=doc.getElementById('facebookLoginTop');
      if(facebook){
        facebookObserver=new MutationObserver(syncSearchHeader);
        facebookObserver.observe(facebook,{childList:true,subtree:true,attributes:true,
          attributeFilter:['class','title','aria-label','disabled']});
      }
      syncSearchHeader();
    };
    const buildDesktopNav=nav=>{
      if(!nav||nav.closest('.drivehub-desktop-nav'))return;
      sourceNav=nav;
      sourceObserver?.disconnect();
      const shell=ensureGlobalHeader();
      const actions=shell.querySelector('.drivehub-desktop-nav__actions');
      actions.replaceChildren();
      const label=String(nav.getAttribute('aria-label')||'DriveHub').replace(/\s+(?:sections|navigation)$/i,'').trim()||'DriveHub';
      const tool=toolFromLabel(label);
      recordRecent(tool,displayTool(tool));
      [...nav.querySelectorAll('.nav-btn:not(.gateway-home)')].forEach(original=>{
        const proxy=document.createElement('button');
        proxy.type='button';
        proxy.className='drivehub-desktop-nav__item';
        if(original.classList.contains('gateway-home'))proxy.classList.add('gateway-home');
        proxy.innerHTML=cleanCloneHtml(original)||HOME_ICON;
        const labelText=original.getAttribute('aria-label')||original.textContent.trim()||'Navigation item';
        proxy.setAttribute('aria-label',labelText);
        proxy.addEventListener('click',()=>original.click());
        actions.appendChild(proxy);
      });
      sourceObserver=new MutationObserver(syncDesktopNav);
      sourceObserver.observe(nav,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','aria-pressed','aria-current','hidden','disabled']});
      syncDesktopNav();
    };
    const findSourceNav=()=>{
      if(routeTool()==='search'){findSearchNav();return}
      const nav=document.querySelector('body > .bottom-nav, #app > .bottom-nav, .bottom-nav');
      if(nav&&nav!==sourceNav)buildDesktopNav(nav);
    };
    ensureGlobalHeader();
    findSourceNav();
    bodyObserver=new MutationObserver(findSourceNav);
    bodyObserver.observe(document.body,{subtree:true,childList:true});

    const banner=document.createElement('div');
    banner.className='drivehub-network-banner';
    banner.setAttribute('role','status');
    banner.setAttribute('aria-live','polite');
    banner.dataset.visible='false';
    banner.textContent='Offline — saved data is still available, but live lookups and routing may not work.';
    document.body.appendChild(banner);

    const activity=document.createElement('div');
    activity.className='drivehub-activity';
    activity.setAttribute('role','status');
    activity.setAttribute('aria-live','polite');
    activity.dataset.visible='false';
    activity.dataset.state='working';
    activity.innerHTML='<span class="drivehub-activity__spinner" aria-hidden="true"></span><span class="drivehub-activity__status-icon" aria-hidden="true"></span><span class="drivehub-activity__label">Working…</span>';
    document.body.appendChild(activity);
    const activityLabel=activity.querySelector('.drivehub-activity__label');
    const activityStatusIcon=activity.querySelector('.drivehub-activity__status-icon');
    const activities=new Map();
    let activitySeq=0;
    let transient=null;
    let transientSeq=0;
    let transientTimer=0;

    const stateGlyph=state=>state==='success'?'✓':state==='error'?'!':'i';
    const clearTransientTimer=()=>{if(transientTimer){clearTimeout(transientTimer);transientTimer=0}};
    const scheduleTransientHide=()=>{
      clearTransientTimer();
      if(!transient||activities.size)return;
      transientTimer=setTimeout(()=>{
        transient=null;
        transientTimer=0;
        syncActivity();
      },transient.duration);
    };
    const syncActivity=()=>{
      const latest=[...activities.entries()].at(-1);
      if(latest){
        clearTransientTimer();
        activity.dataset.state='working';
        activityLabel.textContent=latest[1]||'Working…';
        activityStatusIcon.textContent='';
        activity.dataset.visible='true';
        document.documentElement.dataset.activity='busy';
        return;
      }
      document.documentElement.dataset.activity='idle';
      if(transient){
        activity.dataset.state=transient.state;
        activityLabel.textContent=transient.label;
        activityStatusIcon.textContent=stateGlyph(transient.state);
        activity.dataset.visible='true';
        scheduleTransientHide();
        return;
      }
      clearTransientTimer();
      activity.dataset.visible='false';
      activity.dataset.state='working';
      activityStatusIcon.textContent='';
      activityLabel.textContent='Working…';
    };
    const beginActivity=label=>{
      const id=++activitySeq;
      activities.set(id,String(label||'Working…'));
      syncActivity();
      let ended=false;
      const release=()=>{
        if(ended)return;
        ended=true;
        activities.delete(id);
        syncActivity();
      };
      release.update=nextLabel=>{
        if(ended||!activities.has(id))return;
        activities.set(id,String(nextLabel||'Working…'));
        syncActivity();
      };
      release.finish=(message,state='success',options={})=>{
        release();
        if(message)showStatus(message,state,options);
      };
      return release;
    };
    const showStatus=(label,state='info',options={})=>{
      const text=String(label||'').trim();
      if(!text){
        transient=null;
        clearTransientTimer();
        syncActivity();
        return ()=>{};
      }
      const safeState=['success','error','info'].includes(state)?state:'info';
      const duration=Math.max(1200,Number(options.duration)||(
        safeState==='error'?Math.max(4200,text.length*60):safeState==='success'?3000:2800
      ));
      const id=++transientSeq;
      transient={id,label:text,state:safeState,duration};
      syncActivity();
      return ()=>{
        if(transient?.id!==id)return;
        transient=null;
        clearTransientTimer();
        syncActivity();
      };
    };
    const clearStatus=()=>showStatus('');
    let legacyRelease=null;
    const setBusy=label=>{
      if(label){
        if(legacyRelease?.update){legacyRelease.update(label);return}
        legacyRelease=beginActivity(label);
      }else{
        legacyRelease?.();
        legacyRelease=null;
      }
    };
    window.DriveHubChrome={...(window.DriveHubChrome||{}),beginActivity,showStatus,clearStatus,setBusy};

    let hideTimer=0;
    const syncNetwork=()=>{
      clearTimeout(hideTimer);
      const offline=navigator.onLine===false;
      document.documentElement.dataset.network=offline?'offline':'online';
      if(offline){
        banner.textContent='Offline — saved data is still available, but live lookups and routing may not work.';
        banner.dataset.visible='true';
      }else if(banner.dataset.visible==='true'){
        banner.textContent='Back online.';
        banner.dataset.visible='true';
        hideTimer=setTimeout(()=>{banner.dataset.visible='false'},1800);
      }
    };
    window.addEventListener('online',syncNetwork);
    window.addEventListener('offline',syncNetwork);
    window.addEventListener('pageshow',event=>{
      if(!event.persisted)return;
      findSourceNav();
      syncDesktopNav();
      syncNetwork();
    });
    window.addEventListener('orientationchange',()=>{
      requestAnimationFrame(()=>{findSourceNav();syncDesktopNav();});
    });
    syncNetwork();
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
