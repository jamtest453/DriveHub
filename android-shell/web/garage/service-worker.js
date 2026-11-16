const CACHE='drivehub-mygarage-v14221';
const VERSION='14221';
const CORE=[
  './index.html',
  './css/styles.css?v=14221',
  './css/design-system.css?v=14221',
  './js/app.bundle.js?v=14221',
  '/shared/public/drivehub-runtime.js?v=14221',
  '/shared/public/drivehub-chrome.css?v=14221',
  '/shared/public/drivehub-chrome.js?v=14221',
  './manifest.json',
  './icons/drivehub-192.png',
  './icons/drivehub-512.png'
];
const OPTIONAL=[
  './js/app.js?v=14221',
  './js/storage/database.js',
  './js/storage/assets.js',
  './js/services/vehicleLookup.js',
  './js/services/googleDriveSync.js'
];
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil((async()=>{const cache=await caches.open(CACHE);await Promise.allSettled(CORE.map(url=>cache.add(url)));await Promise.allSettled(OPTIONAL.map(url=>cache.add(url)))})())});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)));await self.clients.claim()})())});
async function cacheResponse(request,response){if(!response||!response.ok)return response;try{const cache=await caches.open(CACHE);await cache.put(request,response.clone())}catch{}return response}
async function networkFirst(request,fallback){try{const response=await fetch(request,{cache:'no-store'});if(response&&response.ok)await cacheResponse(request,response);return response}catch{return (await caches.match(request))||(fallback?await caches.match(fallback):null)||new Response('',{status:504,statusText:'Offline'})}}
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;if(url.pathname.startsWith('/api/'))return;if(request.mode==='navigate'){event.respondWith(networkFirst(request,'./index.html'));return}const shellAsset=/\.(?:js|css)$/i.test(url.pathname);if(shellAsset){event.respondWith(networkFirst(request));return}event.respondWith((async()=>{try{return await cacheResponse(request,await fetch(request,{cache:'no-cache'}))}catch{return (await caches.match(request))||new Response('',{status:504,statusText:'Offline'})}})())});


self.addEventListener('push',event=>{event.waitUntil((async()=>{let payload={};try{payload=event.data?.json?.()||{}}catch{try{payload={body:event.data?.text?.()||''}}catch{}}const title=String(payload.title||'DriveHub reminder'),options={body:String(payload.body||''),tag:String(payload.tag||'drivehub-reminder'),renotify:false,icon:payload.icon||'/garage/icons/drivehub-192.png',badge:payload.badge||'/garage/icons/drivehub-192.png',data:payload.data||{url:'/garage/',screen:'reminders'}};await self.registration.showNotification(title,options)})())});

self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const clientsList=await clients.matchAll({type:'window',includeUncontrolled:true});for(const client of clientsList){if('focus'in client){await client.focus();return}}if(clients.openWindow)await clients.openWindow(event.notification.data?.url||'/garage/')} )())});
