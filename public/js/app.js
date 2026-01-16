if ("serviceWorker" in navigator && "PushManager" in window) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then(() => console.log("✅ PWA aktif"))
      .catch(err => console.error("❌ SW gagal", err));
  });
}

// Fungsi pembantu untuk konversi kunci VAPID (WAJIB ADA)
function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 1. Fungsi Minta Izin (Dipanggil otomatis)
async function requestNotificationPermission() {
    // Cek dukungan browser
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        return; 
    }

    try {
        // Jika sudah pernah diizinkan, langsung subscribe saja
        if (Notification.permission === "granted") {
            await subscribeUser();
            return;
        }

        // Jika belum, minta izin
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
            console.log("✅ Izin diberikan!");
            await subscribeUser();
        }
    } catch (error) {
        console.error("Error notifikasi:", error);
    }
}

// 2. Fungsi Subscribe
async function subscribeUser() {
    try {
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        
        if (!subscription) {
            const publicVapidKey = "BLYIbLCIlu-yCl9f4gRB2RtuslOCtj78DLUXFsMdrA_SrriX2DYBTX3ew_VlpY4n3ZS1PcQTuA9FVRuQKwuITo0";
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
            });
        }

        const token = localStorage.getItem('token');
        await fetch("/api/subscribe", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}` 
            },
            body: JSON.stringify(subscription)
        });

        console.log("✅ Push Notification Aktif");
    } catch (err) {
        console.error("❌ Gagal subscribe:", err);
    }
}