/* Efetivo Diário — Masters · service worker (funcionamento sem internet)
 * Guarda os arquivos do aplicativo no aparelho. NUNCA guarda dados do banco (chamadas ao Supabase passam direto). */
var VERSAO_CACHE = 'efetivo-masters-v1.2.1';
var ARQUIVOS = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest',
  './icons/logo-masters.png', './icons/icon-192.png', './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSAO_CACHE).then(function (c) {
    return Promise.all(ARQUIVOS.map(function (u) { return c.add(u).catch(function () { /* tenta depois */ }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSAO_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (/\.supabase\.co$/.test(url.hostname)) return;            // dados: sempre direto do servidor
  var proprio = url.origin === self.location.origin;
  var permitido = proprio || url.hostname === 'cdn.jsdelivr.net' || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!permitido) return;
  // rede primeiro (pega atualizações); sem internet, usa a cópia guardada
  e.respondWith(fetch(req).then(function (resp) {
    if (resp && (resp.ok || resp.type === 'opaque')) {
      var copia = resp.clone(); caches.open(VERSAO_CACHE).then(function (c) { c.put(req, copia); });
    }
    return resp;
  }).catch(function () {
    return caches.match(req).then(function (r) { return r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined); });
  }));
});
