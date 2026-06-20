/* Service worker — caches the app shell so it opens with no signal.
   Bump CACHE when you change app files to force an update. */
const CACHE = "cattle-shell-v2";
const SHELL = [
  "./", "./index.html", "./styles.css", "./config.js", "./offline.js", "./app.js",
  "./manifest.webmanifest", "./icon-180.png", "./icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // never cache writes
  const url = new URL(req.url);

  // Supabase API/storage + the daily market JSON: always go to the network.
  if (url.hostname.endsWith(".supabase.co") || url.pathname.endsWith("market-data.json")) return;

  // App shell + libraries: serve from cache, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && (url.origin === location.origin || url.hostname === "cdn.jsdelivr.net")) {
          const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    }).catch(() => caches.match("./index.html"))
  );
});
