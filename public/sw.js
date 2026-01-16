const CACHE_NAME = "bumdes-v1";
const ASSETS = [
  "/",
  "/home.html",
  "/katalog.html",
  "/manifest.json",
  "/js/app.js",
  "/icons/logo_bumdesa.png"
];

// --- INSTALL ---
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// --- ACTIVATE ---
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

// --- FETCH (Optimasi agar data dinamis tidak tersangkut cache) ---
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Strategi: Network First untuk file HTML & API agar data selalu terbaru
  // Strategi: Cache First untuk Gambar, CSS, dan JS agar cepat
  if (event.request.mode === 'navigate' || url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(res => {
      return res || fetch(event.request);
    })
  );
});

// --- PUSH NOTIFICATION ---
self.addEventListener("push", event => {
  let data = { title: "BUMDes Digital", body: "Ada pemberitahuan baru." };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      // Jika data yang dikirim bukan JSON (hanya teks biasa)
      data = { title: "BUMDes Digital", body: event.data.text() };
    }
  }

  const options = {
    body: data.body,
    icon: "/icons/logo_bumdesa.png",
    badge: "/icons/logo_bumdesa.png",
    vibrate: [200, 100, 200],
    tag: "pemberitahuan-bumdes", // Mencegah notifikasi menumpuk jika banyak
    renotify: true,
    data: {
      url: data.url || "/home.html"
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// --- NOTIFICATION CLICK ---
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = event.notification.data.url;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});