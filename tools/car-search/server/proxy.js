/*
 * DriveHub Car Search integration.
 * The exact backed-up Python Car Search Hub runs as a sidecar process inside
 * the SAME DriveHub Railway container and uses its existing /data volume.
 * This is a fixed local-loopback proxy, never an arbitrary-origin proxy.
 */
import http from 'node:http';
import https from 'node:https';

export const CAR_SEARCH_PREFIX='/car-search-app';
const LOCAL_CAR_SEARCH_ORIGIN='http://127.0.0.1:3213/';
const MAX_REQUEST_BYTES=8_500_000;
const MAX_SCRIPT_BYTES=2_000_000;

function getUpstream(){
  // The upstream must never be configured from a request or a remote URL.
  return new URL(LOCAL_CAR_SEARCH_ORIGIN);
}

export function carSearchIntegrationStatus(){
  try{const origin=getUpstream();return {carSearch:{configured:true,mode:'embedded-python',storage:'DriveHub volume'}}}
  catch{return {carSearch:{configured:false,mode:'embedded-python'}}}
}

function rewriteScript(source){
  // Car Search Hub uses root-relative /api routes internally. Keep its JS
  // working at /car-search-app/ without claiming DriveHub's own /api namespace.
  return source
    .replace("fetch(url,{credentials:'same-origin'", "fetch('/car-search-app' + url,{credentials:'same-origin'")
    .replace("fetch('/api/facebook/connection/preview'", "fetch('/car-search-app/api/facebook/connection/preview'")
    .replace("window.location.href = '/api/export'", "window.location.href = '/car-search-app/api/export'");
}
export {rewriteScript as rewriteCarSearchScript};

function proxyCookies(value){
  return (Array.isArray(value)?value:[value]).filter(cookie=>String(cookie||'').startsWith('carhub_session=')).map(cookie=>
    String(cookie).replace(/;\s*Domain=[^;]*/gi,'')
      .replace(/;\s*Path=[^;]*/gi,'')+'; Path=/car-search-app/');
}

function outgoingHeaders(req,upstream){
  const forwarded={...req.headers};
  for(const name of ['connection','keep-alive','proxy-connection','transfer-encoding',
    'upgrade','host','content-length','accept-encoding','origin','referer'])delete forwarded[name];
  // No DriveHub cookies should ever travel to the separate Car Search service.
  const session=String(req.headers.cookie||'').split(';').map(x=>x.trim())
    .filter(x=>x.startsWith('carhub_session='));
  if(session.length)forwarded.cookie=session.join('; ');
  else delete forwarded.cookie;
  if(req.headers['content-length'])forwarded['content-length']=req.headers['content-length'];
  forwarded.host=upstream.host;
  forwarded['accept-encoding']='identity';
  forwarded['x-forwarded-proto']=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'?'https':'http';
  const origin=String(req.headers.origin||'');
  if(origin){
    // Preserve Python's CSRF check: the host on origin must be the browser's
    // DriveHub host. Do not turn arbitrary cross-site origins into trusted ones.
    try{
      const supplied=new URL(origin);
      const requestedHost=String(req.headers.host||'').toLowerCase();
      if(supplied.host.toLowerCase()!==requestedHost)return null;
      forwarded.origin=upstream.origin;
    }catch{return null}
  }
  return forwarded;
}

export async function handleCarSearchProxy(req,res,requestUrl){
  const path=requestUrl.pathname;
  if(path!==CAR_SEARCH_PREFIX&&!path.startsWith(CAR_SEARCH_PREFIX+'/'))return false;
  if(path===CAR_SEARCH_PREFIX){res.writeHead(308,{location:CAR_SEARCH_PREFIX+'/', 'cache-control':'no-store'});res.end();return true}
  if(!['GET','HEAD','POST','PATCH','DELETE','OPTIONS'].includes(req.method)){
    res.writeHead(405,{'content-type':'text/plain'});res.end('Method not allowed');return true;
  }
  let upstream;
  try{upstream=getUpstream()}catch{
    res.writeHead(503,{'content-type':'text/plain','cache-control':'no-store'});
    res.end('The embedded Car Search service is starting.');return true;
  }
  const headers=outgoingHeaders(req,upstream);
  if(!headers){res.writeHead(403,{'content-type':'text/plain'});res.end('Cross-site request rejected');return true}
  const remainder=path.slice(CAR_SEARCH_PREFIX.length)||'/';
  const destination=new URL(remainder+requestUrl.search,upstream);
  const isJs=path===CAR_SEARCH_PREFIX+'/dashboard.js';
  const requestFn=upstream.protocol==='https:'?https.request:http.request;
  const remote=requestFn(destination,{method:req.method,headers,timeout:30000},remoteResponse=>{
    const responseHeaders={};
    for(const [key,value] of Object.entries(remoteResponse.headers)){
      if(value===undefined||['connection','transfer-encoding','content-length',
        'content-security-policy','x-frame-options','strict-transport-security',
        'content-encoding','set-cookie','location'].includes(key))continue;
      responseHeaders[key]=value;
    }
    const cookies=proxyCookies(remoteResponse.headers['set-cookie']);
    if(cookies.length)responseHeaders['set-cookie']=cookies;
    const originalLocation=remoteResponse.headers.location;
    if(originalLocation){
      try{
        const redirected=new URL(originalLocation,destination);
        responseHeaders.location=redirected.origin===upstream.origin
          ? CAR_SEARCH_PREFIX+redirected.pathname+redirected.search+redirected.hash
          : originalLocation;
      }catch{responseHeaders.location=originalLocation}
    }
    responseHeaders['cache-control']=isJs||remainder==='/'||remainder==='/dashboard.html'
      ? 'no-store, max-age=0':(remoteResponse.headers['cache-control']||'no-cache');
    responseHeaders['x-drivehub-car-search']='proxied';
    if(req.method==='HEAD'){
      res.writeHead(remoteResponse.statusCode||502,responseHeaders);
      res.end();remoteResponse.resume();return;
    }
    if(isJs&&remoteResponse.statusCode===200){
      const chunks=[];let total=0;
      remoteResponse.on('data',chunk=>{
        total+=chunk.length;
        if(total>MAX_SCRIPT_BYTES){remoteResponse.destroy(new Error('Car Search script exceeds safety limit'));return}
        chunks.push(chunk);
      });
      remoteResponse.on('end',()=>{
        const output=Buffer.from(rewriteScript(Buffer.concat(chunks).toString('utf8')),'utf8');
        responseHeaders['content-type']='text/javascript; charset=utf-8';
        responseHeaders['content-length']=output.length;
        res.writeHead(remoteResponse.statusCode,responseHeaders);
        res.end(output);
      });
    }else{
      res.writeHead(remoteResponse.statusCode||502,responseHeaders);
      remoteResponse.pipe(res);
    }
  });
  remote.on('timeout',()=>remote.destroy(new Error('Upstream timed out')));
  remote.on('error',err=>{
    if(!res.headersSent){
      res.writeHead(502,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
      res.end('The embedded Car Search process is temporarily unavailable. Check DriveHub service logs.');
    }else res.destroy();
  });
  if(req.method==='GET'||req.method==='HEAD'||req.method==='OPTIONS')remote.end();
  else{
    let total=0;
    req.on('data',chunk=>{
      total+=chunk.length;
      if(total>MAX_REQUEST_BYTES){
        remote.destroy();
        if(!res.headersSent){res.writeHead(413,{'content-type':'text/plain'});res.end('Request too large')}
        return;
      }
      if(!remote.destroyed)remote.write(chunk);
    });
    req.on('end',()=>{if(!remote.destroyed)remote.end()});
    req.on('error',()=>remote.destroy());
  }
  return true;
}
