/* DGDOC service worker — network-first passthrough (keeps the app always fresh, enables install) */
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  e.respondWith(fetch(e.request).catch(function () {
    return new Response("<h2 style='font-family:sans-serif'>DGDOC is offline — check your connection and reload.</h2>",
      { headers: { "Content-Type": "text/html" } });
  }));
});
