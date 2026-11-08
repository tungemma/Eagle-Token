/* =========================================
   EAGLE TOKEN — sw.js
   Strategy:
     • Static assets (JS/CSS/HTML/icons): stale-while-revalidate
     • config.json / config.js:           network-only (never cache)
     • API calls (/api/, /eagle/, /_/):   network-only
   ========================================= */

const CACHE_NAME = "eagle-v8";

const STATIC_URLS = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/shared.js",
  // NOTE: /config.js and /config.json deliberately excluded —
  // caching them means a backend URL change can strand clients on
  // a stale PB_URL. The fetch handler routes them network-only.
  "/manifest.json",
  "/vendor/pocketbase.umd.js",

  "/icons/icon-72x72.png",
  "/icons/icon-96x96.png",
  "/icons/icon-144x144.png",
  "/icons/icon-152x152.png",
  "/icons/apple-touch-icon-180x180.png",
  "/icons/icon-192x192.png",
  "/icons/icon-384x384.png",
  "/icons/icon-512x512.png",
  "/icons/icon-maskable-192x192.png",
  "/icons/icon-maskable-512x512.png",
];

const CONFIG_PATHS = new Set(["/config.json", "/config.js"]);

// ── INSTALL ─────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          STATIC_URLS.map((url) =>
            cache.add(url).catch((err) =>
              console.warn("[sw] failed to pre-cache", url, err)
            )
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      // Belt-and-braces: purge any stale config entries that a previous
      // SW version may have cached before this fix shipped.
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        [...CONFIG_PATHS].map((p) => cache.delete(p).catch(() => {}))
      );
      await self.clients.claim();
    })()
  );
});

// ── FETCH ───────────────────────────────
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (
    CONFIG_PATHS.has(url.pathname) ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/eagle/") ||
    url.pathname.startsWith("/_/")
  ) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

// ── STRATEGIES ──────────────────────────
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (err) {
    if (request.headers.get("accept")?.includes("application/json")) {
      return new Response(JSON.stringify({ error: "Network unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Offline", { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    networkPromise; // fire and forget
    return cached;
  }

  const response = await networkPromise;
  if (response) return response;

  if (request.mode === "navigate") {
    const fallback = await cache.match("/index.html");
    if (fallback) return fallback;
  }

  return new Response("Offline", { status: 503 });
}

// ── PUSH ────────────────────────────────
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data = {};
  try {
    data = event.data.json();
  } catch (_) {
    data = { title: "Eagle Token", body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Eagle Token", {
      body: data.body || "",
      icon: "/icons/icon-192x192.png",
      badge: "/icons/icon-72x72.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || "/"));
});