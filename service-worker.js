/* Dumanaltı service worker — offline destek */
var CACHE = "dumanalti-v1";
var ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
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
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (resp) {
        // aynı originden gelen kaynakları cache'le
        if (resp && resp.status === 200 && event.request.url.startsWith(self.location.origin)) {
          var clone = resp.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, clone); });
        }
        return resp;
      }).catch(function () {
        return caches.match("./index.html");
      });
    })
  );
});
