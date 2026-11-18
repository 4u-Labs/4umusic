const CACHE='4umusic-shell-v13';
const SHELL=['./','./index.html','./styles.css','./styles.css?v=20261013-5','./app.js?v=20261013-8','./core.js','./music-session.js?v=20261013-4','./screen-wake-lock.js?v=20261012-4','./assets/icon.svg','./assets/pwa-icon-192.png','./assets/pwa-icon-512.png','./assets/apple-touch-icon.png','./manifest.webmanifest','./tutorial.html','./privacidade.html','./termos.html'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('4umusic-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 // Never cache Google identity, API responses, thumbnails, YouTube video/audio or other apps.
 if(event.request.method!=='GET'||url.origin!==self.location.origin||!SHELL.map(path=>new URL(path,self.registration.scope).href).includes(url.href))return;
 event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}return response;}).catch(()=>caches.match(event.request)));
});
