// Registrasi Service Worker
if ("serviceWorker" in navigator && "PushManager" in window) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js")
            .then(() => {
                console.log("✅ PWA aktif");
                checkNotificationStatus(); // Cek apakah perlu munculkan banner
            })
            .catch(err => console.error("❌ SW gagal", err));
    });
}

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

// Fungsi mengecek status notifikasi saat halaman dimuat
async function checkNotificationStatus() {
    const banner = document.getElementById('notif-banner');
    
    // Jika user belum pernah memilih (default), munculkan banner
    if (Notification.permission === "default") {
        banner.classList.remove('hidden');
    } 
    // Jika sudah diizinkan, pastikan subscription di server tetap sinkron
    else if (Notification.permission === "granted") {
        subscribeUser();
    }
}

async function requestNotificationPermission() {
    if (!("Notification" in window)) return;

    try {
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
            document.getElementById('notif-banner').classList.add('hidden');
            await subscribeUser();
            alert("✅ Notifikasi berhasil diaktifkan!");
        } else {
            document.getElementById('notif-banner').classList.add('hidden');
            console.warn("❌ Izin notifikasi ditolak oleh user.");
        }
    } catch (error) {
        console.error("Error notifikasi:", error);
    }
}

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

        console.log("✅ Push Notification Terdaftar di Server");
    } catch (err) {
        console.error("❌ Gagal subscribe:", err);
    }
}