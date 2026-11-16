import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const launcherPath=path.join(ROOT,'index.html');
const roadDir=path.join(ROOT,'tools','road-finder','public');
const valuationDir=path.join(ROOT,'tools','valuation','public');
const garageDir=path.join(ROOT,'tools','my-garage','public');
const gatewayDir=path.join(ROOT,'gateway','public');
const sharedDir=path.join(ROOT,'shared','public');
const sharedCss=fs.readFileSync(path.join(sharedDir,'drivehub-chrome.css'),'utf8');
const sharedJs=fs.readFileSync(path.join(sharedDir,'drivehub-chrome.js'),'utf8').replaceAll('</script>','<\\/script>');
const runtimeJs=fs.readFileSync(path.join(sharedDir,'drivehub-runtime.js'),'utf8').replaceAll('</script>','<\\/script>');

function insertBeforeFinalBody(html,content){
  const needle='</body>';
  const at=html.lastIndexOf(needle);
  if(at<0)throw new Error('Cannot build standalone tool: missing closing </body>');
  return html.slice(0,at)+content+'\n'+html.slice(at);
}

function inlineValuation(){
  let html=fs.readFileSync(path.join(valuationDir,'index.html'),'utf8');
  const css=fs.readFileSync(path.join(valuationDir,'styles.css'),'utf8');
  const js=fs.readFileSync(path.join(valuationDir,'app.js'),'utf8').replaceAll('</script>','<\\/script>');
  html=html.replace(/<link rel="stylesheet" href="\.\/styles\.css(\?v=[\w.]+)?">/,`<style>\n${css}\n</style>`);
  html=html.replace(/<link rel="stylesheet" href="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-chrome\.css(\?v=[\w.]+)?">/,`<style>\n${sharedCss}\n</style>`);
  html=html.replace(/<script src="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-runtime\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${runtimeJs}\n</script>`);
  html=html.replace(/<script src="\.\/app\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${js}\n</script>`);
  html=html.replace(/<script src="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-chrome\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${sharedJs}\n</script>`);
  html=html.replace(/href="\.\.\/\.\.\/\.\.\/index\.html"([^>]*)/g,'href="#" data-drivehub-home="true"$1');
  html=insertBeforeFinalBody(html,`<script>document.addEventListener('click',e=>{const a=e.target.closest('[data-drivehub-home]');if(a){e.preventDefault();parent.postMessage({type:'drivehub-home'},'*')}});<\/script>`);
  return html;
}

function inlineRoadFinder(){
  let html=fs.readFileSync(path.join(roadDir,'index.html'),'utf8');
  const css=fs.readFileSync(path.join(roadDir,'style.css'),'utf8');
  html=html.replace(/<link rel="stylesheet" href="style\.css(\?v=[\w.]+)?">/,`<style>\n${css}\n</style>`);
  html=html.replace(/<link rel="stylesheet" href="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-chrome\.css(\?v=[\w.]+)?">/,`<style>\n${sharedCss}\n</style>`);
  html=html.replace(/<script src="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-runtime\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${runtimeJs}\n</script>`);
  for(const file of ['core.js','road-quality.js','routing.js','ui.js','ui-renderers.js','app.js']){
    const js=fs.readFileSync(path.join(roadDir,file),'utf8').replaceAll('</script>','<\\/script>');
    html=html.replace(new RegExp(`<script src="${file.replace('.','\\.')}(\\?v=[\\w.]+)?"></script>`),`<script>\n${js}\n</script>`);
  }
  html=html.replace(/<script src="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-chrome\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${sharedJs}\n</script>`);
  html=html.replace(/href="\.\.\/\.\.\/\.\.\/index\.html"([^>]*)/g,'href="#" data-drivehub-home="true"$1');
  html=insertBeforeFinalBody(html,`<script>document.addEventListener('click',e=>{const a=e.target.closest('[data-drivehub-home]');if(a){e.preventDefault();parent.postMessage({type:'drivehub-home'},'*')}});<\/script>`);
  return html;
}

function inlineGarage(){
  let html=fs.readFileSync(path.join(garageDir,'index.html'),'utf8');
  const styles=fs.readFileSync(path.join(garageDir,'css','styles.css'),'utf8');
  const design=fs.readFileSync(path.join(garageDir,'css','design-system.css'),'utf8');
  const icon=fs.readFileSync(path.join(garageDir,'icons','drivehub-192.png')).toString('base64');
  const logoData=`data:image/png;base64,${icon}`;
  const app=fs.readFileSync(path.join(garageDir,'js','app.bundle.js'),'utf8')
    .replaceAll('icons/drivehub-192.png',logoData)
    .replaceAll('</script>','<\\/script>');
  html=html.replace(/<link rel="manifest"[^>]*>/,'').replace(/<link rel="icon"[^>]*>/,'').replace(/<link rel="apple-touch-icon"[^>]*>/,'');
  html=html.replace(/<link rel="stylesheet" href="css\/styles\.css(\?v=[\w.]+)?" \/>/,`<style>\n${styles}\n</style>`);
  html=html.replace(/<link rel="stylesheet" href="css\/design-system\.css(\?v=[\w.]+)?" \/>/,`<style>\n${design}\n</style>`);
  html=html.replace(/<link rel="stylesheet" href="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-chrome\.css(\?v=[\w.]+)?" \/>/,`<style>\n${sharedCss}\n</style>`);
  html=html.replace(/src="icons\/drivehub-192\.png"/g,`src="${logoData}"`);
  html=html.replace(/<script src="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-runtime\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${runtimeJs}\n</script>`);
  html=html.replace(/<script src="\.\/js\/app\.bundle\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${app}\n</script>`);
  html=html.replace(/<script src="\.\.\/\.\.\/\.\.\/shared\/public\/drivehub-chrome\.js(\?v=[\w.]+)?"><\/script>/,`<script>\n${sharedJs}\n</script>`);
  html=html.replace(/href="\.\.\/\.\.\/\.\.\/index\.html"([^>]*)/g,'href="#" data-drivehub-home="true"$1');
  html=insertBeforeFinalBody(html,`<script>document.addEventListener('click',e=>{const a=e.target.closest('[data-drivehub-home]');if(a){e.preventDefault();parent.postMessage({type:'drivehub-home'},'*')}});<\/script>`);
  return html;
}

function buildLauncher(payload){
  let html=fs.readFileSync(path.join(gatewayDir,'index.html'),'utf8');
  const css=fs.readFileSync(path.join(gatewayDir,'styles.css'),'utf8');
  const gatewayJs=fs.readFileSync(path.join(gatewayDir,'app.js'),'utf8').replaceAll('</script>','<\\/script>');
  const icon=fs.readFileSync(path.join(gatewayDir,'icons','drivehub-192.png')).toString('base64');
  html=html.replace(/<link rel="icon"[^>]*>/,'').replace(/<link rel="apple-touch-icon"[^>]*>/,'');
  html=html.replace(/<link rel="stylesheet" href="styles\.css(\?v=[\w.]+)?">/,`<style>\n${css}\nhtml,body{min-height:100%}#tool-frame{position:fixed;inset:0;width:100%;height:100dvh;border:0;background:#f7f8f5;z-index:9999}#tool-frame[hidden]{display:none}[hidden]{display:none!important}\n</style>`);
  html=html.replace(/src="icons\/drivehub-192\.png"/g,`src="data:image/png;base64,${icon}"`);
  html=html.replace(/<script src="\/shared\/public\/drivehub-runtime\.js(\?v=[\w.]+)?"><\/script>/,'');
  html=html.replace('<body>','<body><div id="gateway-shell">').replace(/\s*<script src="app\.js(\?v=[\w.]+)?"><\/script>\s*<\/body>/,`\n</div><iframe id="tool-frame" title="DriveHub tool" hidden></iframe><script>\nconst DRIVEHUB_TOOLS=${JSON.stringify(payload)};\nconst gateway=document.getElementById('gateway-shell');\nconst frame=document.getElementById('tool-frame');\nfunction decodeTool(name){const raw=atob(DRIVEHUB_TOOLS[name]||'');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));return new TextDecoder().decode(bytes)}\nconst DRIVEHUB_HOSTED_TOOL_URLS={garage:'/garage/',valuation:'/valuation/',roads:'/roads/'};\nconst DRIVEHUB_IS_HOSTED=/^https?:$/.test(location.protocol);\nlet embeddedToolNavSeq=0;\nfunction showHome(updateHash=true){frame.hidden=true;frame.removeAttribute('srcdoc');gateway.hidden=false;if(updateHash&&location.hash)history.pushState(null,'',location.href.split('#')[0]);window.scrollTo(0,0)}\nfunction openTool(name,updateHash=true){if(name==='search'){location.assign(DRIVEHUB_IS_HOSTED?'/search/':'https://drivehub-production-7aa4f6f5.up.railway.app/search/');return}if(!DRIVEHUB_TOOLS[name])return;if(DRIVEHUB_IS_HOSTED){location.assign(DRIVEHUB_HOSTED_TOOL_URLS[name]||'/');return}const navSeq=++embeddedToolNavSeq;gateway.hidden=true;frame.hidden=false;const toolHtml=decodeTool(name);setTimeout(()=>{if(navSeq!==embeddedToolNavSeq)return;frame.onload=()=>{try{frame.contentWindow?.postMessage({type:'drivehub-embedded-visible',tool:name},'*')}catch{}};frame.srcdoc=toolHtml},0);if(updateHash&&location.hash!==('#'+name))history.pushState(null,'','#'+name);window.scrollTo(0,0)}\ndocument.addEventListener('click',e=>{const card=e.target.closest('[data-tool]');if(card){e.preventDefault();openTool(card.dataset.tool)}});\nfunction pushKey(value){const padding='='.repeat((4-value.length%4)%4),raw=atob((value+padding).replace(/-/g,'+').replace(/_/g,'/')),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
async function garagePushRegistration(){if(!('serviceWorker'in navigator)||!('PushManager'in window))throw new Error('Web Push is not supported in this browser.');const reg=await navigator.serviceWorker.register('/garage/service-worker.js?v=14221',{scope:'/garage/',updateViaCache:'none'});try{await reg.update()}catch{}return reg}
window.addEventListener('message',async e=>{if(e.source!==frame.contentWindow)return;const d=e.data||{};if(d.type==='drivehub-home')showHome();if(d.type==='drivehub-open')openTool(d.tool);if(d.type==='drivehub-tool-visited'&&d.recent){try{localStorage.setItem('drivehub.lastTool.v1',JSON.stringify(d.recent))}catch{}window.dispatchEvent(new Event('drivehub-last-tool'))}if(d.type==='drivehub-notification'&&d.requestId){let result=null,error='';try{if(!('Notification'in window)||!window.isSecureContext)throw new Error('Browser notifications need DriveHub to be opened over HTTPS.');if(d.action==='permission'){result=Notification.permission==='default'?await Notification.requestPermission():Notification.permission}else if(d.action==='show'){if(Notification.permission!=='granted')throw new Error('Browser notification permission is not granted.');const n=new Notification(String(d.title||'DriveHub reminder'),d.options||{});n.onclick=()=>{window.focus();openTool('garage')};result=true}else if(d.action==='push-subscribe'){if(Notification.permission!=='granted')throw new Error('Browser notification permission is not granted.');const reg=await garagePushRegistration();let sub=await reg.pushManager.getSubscription();if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:pushKey(String(d.vapidPublicKey||''))});result=sub.toJSON()}else if(d.action==='push-current'){const reg=await navigator.serviceWorker.getRegistration('/garage/');const sub=await reg?.pushManager?.getSubscription();result=sub?.toJSON?.()||null}else if(d.action==='push-unsubscribe'){const reg=await navigator.serviceWorker.getRegistration('/garage/');const sub=await reg?.pushManager?.getSubscription();result=sub?await sub.unsubscribe():false}else throw new Error('Unknown notification action')}catch(err){error=err?.message||String(err)}try{e.source.postMessage({type:'drivehub-notification-response',requestId:d.requestId,result,error},'*')}catch{}}});\nwindow.addEventListener('popstate',()=>{const n=location.hash.slice(1);n&&DRIVEHUB_TOOLS[n]?openTool(n,false):showHome(false)});\n${runtimeJs}\n${gatewayJs}\n(()=>{const n=location.hash.slice(1);if(n&&DRIVEHUB_TOOLS[n])openTool(n,false)})();\n</script></body>`);
  html=html.replace(/href="[^"]*" data-http-href="\/garage\/"/,'href="/garage/" data-http-href="/garage/" data-tool="garage"');
  html=html.replace(/href="[^"]*" data-http-href="\/valuation\/"/,'href="/valuation/" data-http-href="/valuation/" data-tool="valuation"');
  html=html.replace(/href="[^"]*" data-http-href="\/roads\/"/,'href="/roads/" data-http-href="/roads/" data-tool="roads"');
  html=html.replace(/href="[^"]*" data-http-href="\/search\/"/,'href="/search/" data-http-href="/search/" data-tool="search"');
  html=html.replace('href="/release-notes.html"','href="release-notes.html"');
  return html;
}

const payload={
  garage:Buffer.from(inlineGarage(),'utf8').toString('base64'),
  valuation:Buffer.from(inlineValuation(),'utf8').toString('base64'),
  roads:Buffer.from(inlineRoadFinder(),'utf8').toString('base64')
};
fs.writeFileSync(launcherPath,buildLauncher(payload));
// Standalone single-file launcher also offers a readable local release page.
let releaseHtml=fs.readFileSync(path.join(gatewayDir,'release-notes.html'),'utf8');
releaseHtml=releaseHtml.replace(/<link rel="stylesheet" href="styles\.css(\?v=[\w.]+)?">/,`<style>\n${fs.readFileSync(path.join(gatewayDir,'styles.css'),'utf8')}\n</style>`);
releaseHtml=releaseHtml.replace(/href="\/"/g,'href="index.html"');
fs.writeFileSync(path.join(ROOT,'release-notes.html'),releaseHtml);
console.log('Rebuilt standalone DriveHub gateway plus MyGarage, Road Finder, Valuation and shared chrome (DriveHub v142.25)');
