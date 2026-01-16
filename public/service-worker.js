const CACHE_NAME = "bumdes-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/js/app.js",
  "/icons/logo_bumdesa.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => key !== CACHE_NAME && caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // ❌ JANGAN cache API
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(res => {
      return res || fetch(event.request);
    })
  );
});

// PUSH NOTIFICATION
self.addEventListener("push", event => {
  if (!event.data) return;

  const data = event.data.json();

  self.registration.showNotification(data.title || "BUMDes Digital", {
    body: data.body || "Ada pemberitahuan baru",
    icon: "/icons/logo_bumdesa.png",
    badge: "/icons/logo_bumdesa.png",
    data: {
      url: data.url || "/index.html"
    }
  });
});

// KLIK NOTIF → BUKA HALAMAN
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl = event.notification.data.url;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes(targetUrl)) {
            return client.focus();
          }
        }
        return clients.openWindow(targetUrl);
      })
  );
});
