(()=>{
  'use strict';
  const frame=document.getElementById('search-frame');
  const loading=document.getElementById('search-loading');
  const recent={tool:'search',label:'Car Search',at:new Date().toISOString()};
  try{localStorage.setItem('drivehub.lastTool.v1',JSON.stringify(recent))}catch{}
  try{if(window.parent!==window)parent.postMessage({type:'drivehub-tool-visited',recent},'*')}catch{}
  let done=false;
  function reveal(){done=true;loading.hidden=true}
  frame.addEventListener('load',reveal,{once:true});
  setTimeout(()=>{
    if(!done){loading.textContent='Car Search is taking longer than usual. You can also open it separately using the link above.';loading.style.background='rgba(247,251,249,.94)'}
  },10000);
})();
