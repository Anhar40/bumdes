if ("serviceWorker" in navigator && "PushManager" in window) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then(() => console.log("✅ PWA aktif"))
      .catch(err => console.error("❌ SW gagal", err));
  });
}

// Fungsi pembantu untuk konversi kunci VAPID (WAJIB ADA)
