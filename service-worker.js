var CACHE = "dumanalti-v136";
var ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/mascot.svg",
  "./icons/mascot-surprised.svg",
  "./icons/mascot-love.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/avatar-utku.png",
  "./icons/avatar-gozde.png",
  "./icons/avatar-both.png",
  "./icons/avatar-hepberaber.svg",
  "https://d3js.org/d3.v7.min.js"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  // Farklı origin'leri (Supabase API, CDN) service worker'a takmadan geçir.
  if (url.origin !== self.location.origin) return;

  // Önce ağ: online'ken her zaman en güncel dosyayı getir, önbelleği tazele.
  // İnternet yoksa önbellekten ver; o da yoksa index.html'e düş.
  event.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.status === 200) {
        var clone = resp.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, clone); });
      }
      return resp;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || caches.match("./index.html");
      });
    })
  );
});
