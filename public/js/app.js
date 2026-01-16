if ("serviceWorker" in navigator && "PushManager" in window) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js")
      .then(() => console.log("✅ PWA aktif"))
      .catch(err => console.error("❌ SW gagal", err));
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function requestNotificationPermission() {
    // 1. Cek apakah browser mendukung Notifikasi DAN Service Worker
    // Keduanya wajib ada untuk sistem Push Notification yang stabil
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        alert("Browser Anda tidak mendukung fitur notifikasi.");
        return;
    }

    try {
        // 2. Minta izin ke user
        const permission = await Notification.requestPermission();

        if (permission === "granted") {
            console.log("✅ Izin diberikan!");
            
            // Beri feedback visual ke user
            alert("Notifikasi berhasil diaktifkan! Anda akan menerima update saldo & pinjaman.");

            // 3. Sembunyikan tombol secara otomatis agar tidak diklik dua kali
            const btn = document.getElementById('btn-notif');
            if (btn) btn.style.display = 'none';

            // 4. Daftarkan user ke sistem push (Service Worker)
            subscribeUser();
            
        } else if (permission === "denied") {
            alert("Izin notifikasi ditolak. Anda tidak akan menerima update otomatis.");
            console.warn("❌ Notifikasi ditolak oleh user.");
        }

    } catch (error) {
        console.error("Terjadi kesalahan saat meminta izin:", error);
        alert("Gagal memproses izin notifikasi.");
    }
}

async function subscribeUser() {
  try {
    const registration = await navigator.serviceWorker.ready;

    // ❗ Cegah subscribe dobel
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          "BLYIbLCIlu-yCl9f4gRB2RtuslOCtj78DLUXFsMdrA_SrriX2DYBTX3ew_VlpY4n3ZS1PcQTuA9FVRuQKwuITo0"
        )
      });
    }

    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription)
    });

    if (!res.ok) throw new Error("Gagal simpan subscription");

    console.log("✅ Subscription tersimpan");
  } catch (err) {
    console.error("❌ Subscribe gagal:", err);
  }
}
