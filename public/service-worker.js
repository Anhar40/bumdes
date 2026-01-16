const CACHE_NAME = "bumdes-v1";
const ASSETS = [
  "/",
  "/home.html",      // Sesuaikan jika file beranda Anda bernama home.html
  "/katalog.html",
  "/manifest.json",
  "/js/app.js",
  "/icons/logo_bumdesa.png" // Pastikan file ini ada di folder public/icons/
];

// --- INSTALL: Simpan aset ke cache ---
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// --- ACTIVATE: Hapus cache lama ---
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

// --- FETCH: Ambil data (Prioritas Cache untuk aset, Network untuk API) ---
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // 1. Jangan cache API dan folder uploads (agar gambar produk selalu segar)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // 2. Strategi Cache First untuk aset statis (CSS, JS, Logo)
  event.respondWith(
    caches.match(event.request).then(res => {
      return res || fetch(event.request);
    })
  );
});

// --- PUSH NOTIFICATION ---
self.addEventListener("push", event => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    
    const options = {
      body: data.body || "Ada pemberitahuan baru untuk Anda.",
      icon: "/icons/logo_bumdesa.png",
      badge: "/icons/logo_bumdesa.png",
      vibrate: [100, 50, 100], // Getaran HP
      data: {
        url: data.url || "/home.html"
      }
    };

    event.waitUntil(
      self.registration.showNotification(data.title || "BUMDes Digital", options)
    );
  } catch (err) {
    console.error("Gagal memproses data push:", err);
  }
});

// --- NOTIFICATION CLICK: Buka halaman ---
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data.url, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(clientList => {
        // Jika tab aplikasi sudah terbuka, fokuskan saja
        for (const client of clientList) {
          if (client.url === targetUrl && "focus" in client) {
            return client.focus();
          }
        }
        // Jika belum terbuka, buka tab baru
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});