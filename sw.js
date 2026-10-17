/* DGDOC service worker — network-first passthrough (keeps the app always fresh, enables install) */
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  /* v25.12-V: only DGDOC's own files go through the worker — Supabase / TradeGate / AI calls go straight to the network */
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response("<h2 style='font-family:sans-serif'>DGDOC is offline — check your connection and reload.</h2>",
      { headers: { "Content-Type": "text/html" } });
  }));
});
