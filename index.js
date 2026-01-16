require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const sharp = require('sharp');
const cors = require('cors');
const webPush = require("web-push");


const snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(cors({
  origin: 'https://bumdes-ochre.vercel.app', // sementara, untuk testing
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
// Gunakan createPool, bukan createConnection
const db = new Pool({
    host: process.env.DB_HOST,      // Ambil dari Supabase > Settings > Database
    port: process.env.DB_PORT,      // Biasanya 5432 atau 6543
    user: process.env.DB_USERNAME,  // Biasanya 'postgres'
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, // Biasanya 'postgres'
    ssl: {
        rejectUnauthorized: false // Supabase WAJIB pakai SSL
    }
});

db.connect((err, client, release) => {
    if (err) {
        return console.error('Gagal koneksi ke Supabase (Postgres):', err.stack);
    }
    console.log('✅ Terhubung ke Supabase via PostgreSQL Pool');
    release();
});

// --- KONFIGURASI UPLOAD ---
// Gunakan memoryStorage agar file tidak mampir ke folder, tapi langsung ke RAM
const storage = multer.memoryStorage();

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 } // Batasi misal max 2MB agar DB tidak bengkak
});

// --- MIDDLEWARE AUTH ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token diperlukan' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token tidak valid' });
        req.user = user;
        next();
    });
};


// SET VAPID
webPush.setVapidDetails(
  "mailto:admin@bumdes.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// SIMPAN SUBSCRIPTION (CONTOH SEDERHANA)
app.post("/api/subscribe", authenticateToken, async (req, res) => {
  const subscription = req.body; // Ini adalah objek JSON dari browser
  const userId = req.user.id;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ message: "Subscription tidak valid" });
  }

  // Menggunakan PostgreSQL ($1, $2)
  // Kolom push_subscription di database sebaiknya bertipe JSONB
  const sql = `
    UPDATE users 
    SET push_subscription = $1 
    WHERE id = $2
  `;

  try {
    await db.query(sql, [JSON.stringify(subscription), userId]);
    res.json({ success: true, message: "Subscription berhasil disimpan" });
  } catch (err) {
    console.error("DB Error:", err);
    res.status(500).json({ error: "Gagal menyimpan subscription" });
  }
});



// Register Warga
app.post('/api/register', upload.single('ktp'), async (req, res) => {
    try {
        const { nik, nama, email, password, alamat, no_hp } = req.body;
        let fotoKtpBase64 = null;

        // 1. Hash Password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 2. Proses Gambar KTP (Sharp tetap sama)
        if (req.file) {
            if (!req.file.mimetype.startsWith('image/')) {
                return res.status(400).json({ error: "File KTP harus berupa gambar!" });
            }

            const compressedBuffer = await sharp(req.file.buffer)
                .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            fotoKtpBase64 = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
        }

        // 3. Simpan ke Database (PostgreSQL version)
        // Gunakan $1, $2, ... sebagai pengganti ?
        const sql = `
            INSERT INTO users (nik, nama, email, password, alamat, no_hp, foto_ktp) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        
        // Di library 'pg', tidak perlu .promise(). Cukup db.query()
        await db.query(sql, [nik, nama, email, hashedPassword, alamat, no_hp, fotoKtpBase64]);

        // 4. Respon Berhasil
        res.status(201).json({ 
            message: 'Registrasi berhasil, menunggu verifikasi',
            image_size: fotoKtpBase64 ? `${(fotoKtpBase64.length / 1024).toFixed(2)} KB` : 'No Image'
        });

    } catch (error) {
        console.error("System Error:", error);

        // Cek jika ini error duplikat dari PostgreSQL (Unique Violation kode: 23505)
        if (error.code === '23505') {
            return res.status(400).json({ error: "NIK atau Email sudah terdaftar" });
        }

        res.status(500).json({ error: "Terjadi kesalahan sistem saat registrasi" });
    }
});

// Login (Warga & Admin)
app.post('/api/login', async (req, res) => {
    try {
        const { identity, password, role } = req.body;

        // PostgreSQL menggunakan $1, $2, dst.
        // Query tetap menggunakan kurung agar logika OR tidak bertabrakan dengan AND
        const sql = `SELECT * FROM users WHERE (nik = $1 OR email = $2) AND role = $3`;

        // Menggunakan await db.query untuk library 'pg'
        const result = await db.query(sql, [identity, identity, role]);

        // Cek apakah user ditemukan (di Postgres, data ada di result.rows)
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'User tidak ditemukan atau Role tidak sesuai' });
        }

        const user = result.rows[0];

        // 1. Verifikasi Password
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(401).json({ message: 'Password salah' });

        // 2. Logika Verifikasi Status (Hanya untuk Warga)
        if (user.role === 'warga') {
            if (user.status_verifikasi === 'pending') {
                return res.status(403).json({
                    message: 'Akun Anda sedang menunggu verifikasi admin. Harap bersabar.'
                });
            }
            if (user.status_verifikasi === 'rejected') {
                return res.status(403).json({
                    message: 'Pendaftaran Anda ditolak. Silakan hubungi pengurus desa.'
                });
            }
        }

        // 3. Generate JWT Token
        const token = jwt.sign(
            { id: user.id, role: user.role, status: user.status_verifikasi },
            SECRET_KEY,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            role: user.role,
            name: user.nama,
            status: user.status_verifikasi
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ error: "Terjadi kesalahan pada sistem login" });
    }
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
    // 1. Validasi Role (Pastikan hanya Admin yang bisa melihat daftar warga)
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Akses ditolak' });
    }

    // 2. Query SQL (Sintaks SELECT di Postgres sama dengan MySQL)
    const sql = `
        SELECT 
            id, 
            nik, 
            nama, 
            email, 
            no_hp, 
            saldo, 
            status_verifikasi, 
            created_at 
        FROM users 
        WHERE role = 'warga' 
        ORDER BY created_at DESC`;

    try {
        // 3. Eksekusi Query menggunakan library 'pg'
        const result = await db.query(sql);

        // 4. Kirim hasil (Data ada di result.rows)
        res.json(result.rows);
    } catch (err) {
        console.error("Database Error:", err.message);
        res.status(500).json({ error: "Gagal mengambil data warga" });
    }
});

// Update status verifikasi (Satu endpoint untuk semua aksi verifikasi/reject)
app.put('/api/admin/users/status/:id', authenticateToken, async (req, res) => {
  // 1. Cek Role Admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Akses ditolak' });
  }

  const { status } = req.body; // status: 'verified' atau 'rejected'
  const { id } = req.params;

  try {
    // 2. Update Status User (Gunakan $1, $2 untuk Postgres)
    const updateSql = "UPDATE users SET status_verifikasi = $1 WHERE id = $2";
    await db.query(updateSql, [status, id]);

    // 3. Ambil data subscription untuk notifikasi
    const subSql = "SELECT push_subscription FROM users WHERE id = $1";
    const subResult = await db.query(subSql, [id]);

    // Jika user tidak ditemukan atau tidak ada data subscription
    if (subResult.rows.length === 0 || !subResult.rows[0].push_subscription) {
      return res.json({ message: `User di-${status}, namun user belum mengaktifkan notifikasi` });
    }

    // Di Postgres (JSONB), data sudah otomatis jadi objek, tidak perlu JSON.parse()
    const subscription = subResult.rows[0].push_subscription;

    // 4. Siapkan Payload Notifikasi
    const payload = JSON.stringify({
      title: "BUMDes Digital",
      url: "/login.html",
      body: status === "verified" 
            ? "Akun Anda berhasil diverifikasi! Silakan login." 
            : "Status verifikasi akun Anda ditolak/diperbarui.",
    });

    // 5. Kirim Push Notification
    try {
      // webPush butuh objek subscription, bukan string
      await webPush.sendNotification(subscription, payload);
      res.json({ message: `User berhasil di-${status} dan notifikasi terkirim` });
    } catch (pushErr) {
      console.error("Push Notification Gagal:", pushErr.message);
      // Tetap beri respon berhasil update DB meskipun notif gagal
      res.json({ message: `User di-${status}, tapi notifikasi gagal dikirim` });
    }

  } catch (err) {
    console.error("Database Error:", err.message);
    res.status(500).json({ error: "Gagal memperbarui status user" });
  }
});

// --- ENDPOINT ORDER (TAMBAHAN LOGIKA STOK) ---
app.post('/api/orders/checkout', authenticateToken, async (req, res) => {
    const { total_bayar, items } = req.body;
    const userId = req.user.id;

    if (!items || items.length === 0) {
        return res.status(400).json({ message: "Keranjang kosong" });
    }

    // Menggunakan pool 'db' langsung dengan pg
    const client = await db.connect(); 

    try {
        await client.query('BEGIN'); // PostgreSQL menggunakan BEGIN bukan START TRANSACTION

        // 1. Cek Saldo & Data User
        const userResult = await client.query("SELECT nama, saldo FROM users WHERE id = $1", [userId]);
        if (userResult.rows.length === 0 || Number(userResult.rows[0].saldo) < Number(total_bayar)) {
            throw new Error("Saldo Anda tidak mencukupi.");
        }
        const namaUser = userResult.rows[0].nama;

        // 2. Masukkan ke Tabel Orders
        // Di Postgres, kita pakai RETURNING id untuk mendapatkan ID yang baru dibuat
        const orderInsert = await client.query(
            "INSERT INTO orders (user_id, total_bayar, status_order, tgl_transaksi) VALUES ($1, $2, 'pending', NOW()) RETURNING id",
            [userId, total_bayar]
        );
        const orderId = orderInsert.rows[0].id;

        // 3. Loop Item: Cek Stok, Kurangi Stok, & Simpan Detail
        for (const item of items) {
            const pid = item.product_id || item.id;

            const pResult = await client.query("SELECT stok, nama_produk, harga FROM products WHERE id = $1", [pid]);
            if (pResult.rows.length === 0) throw new Error(`Produk ID ${pid} tidak ditemukan.`);

            const product = pResult.rows[0];
            if (product.stok < item.qty) {
                throw new Error(`Stok '${product.nama_produk}' tidak mencukupi.`);
            }

            // Update Stok
            await client.query("UPDATE products SET stok = stok - $1 WHERE id = $2", [item.qty, pid]);

            // Hitung Subtotal & Simpan Item
            const subtotalItem = product.harga * item.qty;
            await client.query(
                "INSERT INTO order_items (order_id, product_id, qty, subtotal) VALUES ($1, $2, $3, $4)",
                [orderId, pid, item.qty, subtotalItem]
            );
        }

        // 4. Potong Saldo User
        await client.query("UPDATE users SET saldo = saldo - $1 WHERE id = $2", [total_bayar, userId]);

        // 5. PENCATATAN JURNAL KAS
        const lastJurnal = await client.query("SELECT saldo_akhir FROM jurnal_kas ORDER BY id DESC LIMIT 1");
        const saldoKasSekarang = lastJurnal.rows.length > 0 ? Number(lastJurnal.rows[0].saldo_akhir) : 0;
        const saldoKasBaru = saldoKasSekarang + Number(total_bayar);

        await client.query(
            `INSERT INTO jurnal_kas (keterangan, debet, kredit, saldo_akhir, kategori) 
             VALUES ($1, $2, 0, $3, 'belanja')`,
            [`Belanja Toko: ${namaUser} (Order ID: ${orderId})`, total_bayar, saldoKasBaru]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Checkout berhasil dan tercatat di kas!" });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Checkout Error:", error.message);
        res.status(400).json({ message: error.message });
    } finally {
        client.release(); // PENTING: Kembalikan koneksi ke pool
    }
});
// Tambah Produk (Admin Only)
app.post('/api/admin/products', authenticateToken, upload.single('foto'), async (req, res) => {
    // 1. Validasi Role Admin
    if (req.user.role !== 'admin') return res.sendStatus(403);

    try {
        const { nama_produk, deskripsi, harga, stok, kategori } = req.body;
        let fotoBase64 = null;

        // 2. Cek apakah ada file yang diunggah & Proses Gambar (Sharp)
        if (req.file) {
            if (!req.file.mimetype.startsWith('image/')) {
                return res.status(400).json({ error: "File harus berupa gambar!" });
            }

            const compressedBuffer = await sharp(req.file.buffer)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 70 })
                .toBuffer();

            fotoBase64 = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
        }

        // 3. Simpan ke Database (PostgreSQL version)
        const sql = `
            INSERT INTO products (nama_produk, deskripsi, harga, stok, kategori, foto_produk) 
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        // Menggunakan await db.query (library 'pg')
        await db.query(sql, [nama_produk, deskripsi, harga, stok, kategori, fotoBase64]);

        res.json({ 
            message: 'Produk berhasil ditambahkan',
            size_info: fotoBase64 ? `${(fotoBase64.length / 1024).toFixed(2)} KB` : 'No Image'
        });

    } catch (error) {
        console.error("System Error:", error);
        // Error handling spesifik database jika diperlukan
        res.status(500).json({ error: "Terjadi kesalahan sistem saat menyimpan produk" });
    }
});

// 1. Ambil Semua Produk (Untuk Katalog Warga & Tabel Admin)
// Menggunakan async agar bisa menggunakan await
app.get('/api/products', async (req, res) => {
    try {
        // SQL tetap sama, PostgreSQL mendukung sintaks ORDER BY DESC
        const sql = "SELECT * FROM products ORDER BY id DESC";

        // 1. Eksekusi query menggunakan library 'pg'
        // Tidak perlu .promise(), 'pg' sudah berbasis promise secara bawaan
        const result = await db.query(sql);

        // 2. Kirim hasil query (Data ada di dalam result.rows)
        res.json(result.rows);

    } catch (error) {
        // 3. Error handling
        console.error("Error fetching products:", error.message);
        res.status(500).json({ 
            error: "Gagal mengambil data produk",
            message: error.message 
        });
    }
});

// 2. Hapus Produk (Hanya Admin)
app.delete('/api/admin/products/:id', authenticateToken, async (req, res) => {
    // 1. Pastikan hanya admin yang bisa menghapus
    if (req.user.role !== 'admin') return res.sendStatus(403);

    const { id } = req.params;
    
    // PostgreSQL menggunakan $1 sebagai placeholder
    const sql = "DELETE FROM products WHERE id = $1";

    try {
        // 2. Eksekusi query dengan await
        const result = await db.query(sql, [id]);

        // 3. Cek apakah ada baris yang terhapus (di Postgres menggunakan rowCount)
        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Produk tidak ditemukan" });
        }

        res.json({ message: "Produk berhasil dihapus" });

    } catch (err) {
        console.error("Error deleting product:", err.message);
        res.status(500).json({ error: "Gagal menghapus produk dari database" });
    }
});

// --- ENDPOINT SIMPAN PINJAM ---

// Ajukan Pinjaman
app.post('/api/loans/apply', authenticateToken, async (req, res) => {
    // 1. Ambil data dari body
    const { jumlah_pinjaman, tenor_bulan, angsuran_bulanan, tujuan } = req.body;
    const userId = req.user.id;

    // 2. Query SQL (Gunakan $1, $2, dst untuk PostgreSQL)
    // Kolom 'status' tidak perlu diisi karena sudah ada DEFAULT 'pending' di tabel
    const sql = `
        INSERT INTO loans (user_id, jumlah_pinjaman, tenor_bulan, angsuran_bulanan, tujuan) 
        VALUES ($1, $2, $3, $4, $5)
    `;

    try {
        // 3. Eksekusi query dengan library 'pg'
        await db.query(sql, [userId, jumlah_pinjaman, tenor_bulan, angsuran_bulanan, tujuan]);

        // 4. Respon berhasil
        res.json({ message: 'Pengajuan pinjaman berhasil, mohon tunggu verifikasi admin' });

    } catch (err) {
        console.error("Loan Application Error:", err.message);
        res.status(500).json({ 
            error: "Gagal memproses pengajuan pinjaman",
            message: err.message 
        });
    }
});

// Mengambil semua pinjaman yang sedang 'pending' untuk Admin
// Mengambil semua pinjaman yang sedang 'pending' untuk Admin
// Middleware tambahan untuk cek Admin
const isAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: "Akses ditolak. Khusus Admin." });
    }
    next();
};

// 1. Ambil Pinjaman Pending (Ditambah middleware isAdmin)
app.get('/api/admin/loans/pending', authenticateToken, isAdmin, async (req, res) => {
    // SQL tetap menggunakan JOIN untuk mengambil nama dan no_hp warga
    const sql = `
        SELECT l.*, u.nama, u.no_hp 
        FROM loans l 
        JOIN users u ON l.user_id = u.id 
        WHERE l.status = 'pending' 
        ORDER BY l.tgl_pengajuan ASC`;

    try {
        // Eksekusi query dengan library 'pg'
        const result = await db.query(sql);

        // Kirim hasil (di PostgreSQL, data ada di result.rows)
        res.json(result.rows);

    } catch (err) {
        console.error("Database Error:", err.message);
        res.status(500).json({ 
            error: "Gagal mengambil data pengajuan pinjaman",
            message: err.message 
        });
    }
});

app.get('/api/admin/loans', authenticateToken, isAdmin, async (req, res) => {
    // Query SQL tetap sama, mengambil semua kolom pinjaman dan kolom spesifik user
    const sql = `
        SELECT 
            l.*,
            u.nama,
            u.no_hp
        FROM loans l
        JOIN users u ON l.user_id = u.id
        ORDER BY l.tgl_pengajuan DESC
    `;

    try {
        // Eksekusi query menggunakan library 'pg'
        const result = await db.query(sql);

        // Kirim hasil dari properti .rows
        res.json(result.rows);

    } catch (err) {
        console.error("Database Error (Get All Loans):", err.message);
        res.status(500).json({ 
            error: "Gagal mengambil riwayat pinjaman",
            message: err.message 
        });
    }
});


// 2. Update Status Pinjaman (Ditambah middleware isAdmin) // Pastikan sudah di-require di atas

app.put('/api/admin/loans/:id/status', authenticateToken, isAdmin, async (req, res) => {
    const { status, catatan_admin } = req.body;
    const loanId = req.params.id;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Status tidak valid" });
    }

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        // 1. Ambil data pinjaman SEKALIGUS data subscription user
        const loanResult = await client.query(
            `SELECT l.user_id, l.jumlah_pinjaman, u.push_subscription, u.nama 
             FROM loans l 
             JOIN users u ON l.user_id = u.id 
             WHERE l.id = $1`, 
            [loanId]
        );

        if (loanResult.rows.length === 0) {
            throw new Error("Pinjaman tidak ditemukan");
        }

        const { user_id, jumlah_pinjaman, push_subscription, nama } = loanResult.rows[0];

        // 2. Update status pinjaman
        await client.query(
            "UPDATE loans SET status = $1, catatan_admin = $2 WHERE id = $3",
            [status, catatan_admin || null, loanId]
        );

        // 3. Logika Jika Disetujui
        if (status === 'approved') {
            await client.query(
                "UPDATE users SET saldo = saldo + $1 WHERE id = $2",
                [jumlah_pinjaman, user_id]
            );
        }

        await client.query('COMMIT'); 

        // --- PROSES KIRIM NOTIFIKASI (Di luar Transaksi agar tidak menghambat DB) ---
        if (push_subscription) {
            const payload = JSON.stringify({
                title: status === 'approved' ? "Pinjaman Disetujui! 🎉" : "Update Pengajuan Pinjaman",
                body: status === 'approved' 
                    ? `Halo ${nama}, pinjaman Rp ${Number(jumlah_pinjaman).toLocaleString('id-ID')} telah cair ke saldo Anda.`
                    : `Mohon maaf ${nama}, pengajuan pinjaman Anda belum dapat disetujui. Cek catatan admin.`,
                url: "/tagihan.html" // Arahkan warga ke halaman riwayat/tagihan
            });

            // Kirim secara asynchronous (tidak perlu ditunggu/await jika tidak ingin menghambat response)
            webPush.sendNotification(push_subscription, payload)
                .catch(err => console.error("Gagal kirim notif push:", err));
        }

        res.json({ 
            message: status === 'approved' 
                ? "Pinjaman disetujui & saldo warga telah bertambah" 
                : "Pengajuan pinjaman telah ditolak" 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get('/api/profile', authenticateToken, async (req, res) => {
    // 1. Gunakan ID user dari token JWT yang sudah didekripsi oleh middleware authenticateToken
    const userId = req.user.id;

    // 2. Query SQL dengan placeholder PostgreSQL ($1)
    const sql = "SELECT nama, saldo, status_verifikasi FROM users WHERE id = $1";

    try {
        // 3. Eksekusi query menggunakan library 'pg'
        const result = await db.query(sql, [userId]);

        // 4. Cek apakah user ada (PostgreSQL mengembalikan hasil di dalam .rows)
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "User tidak ditemukan" });
        }

        // 5. Kirim data baris pertama (index 0)
        res.json(result.rows[0]);

    } catch (err) {
        console.error("Profile Fetch Error:", err.message);
        res.status(500).json({ error: "Gagal mengambil data profil terbaru" });
    }
});
// Middleware untuk verifikasi JWT (Pastikan Anda sudah punya ini)
// Endpoint Detail Warga untuk Modal Admin
app.get('/api/admin/users/detail/:id', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;

    try {
        // 1. Ambil Data User (Biodata)
        // Gunakan $1 sebagai placeholder PostgreSQL
        const userQuery = 'SELECT id, nama, nik, email, no_hp, saldo, foto_ktp, status_verifikasi FROM users WHERE id = $1';
        const userResult = await db.query(userQuery, [userId]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User tidak ditemukan' });
        }

        // 2. Ambil Pinjaman Aktif (Status 'approved')
        const loanQuery = `
            SELECT id, jumlah_pinjaman, tgl_pengajuan, tenor_bulan, angsuran_bulanan, tujuan 
            FROM loans 
            WHERE user_id = $1 AND status = 'approved' 
            LIMIT 1`;
        const loanResult = await db.query(loanQuery, [userId]);

        let payments = [];
        // 3. Jika ada pinjaman aktif, ambil riwayat angsuran dari tabel 'repayments'
        if (loanResult.rows.length > 0) {
            const repaymentQuery = `
                SELECT jumlah_bayar AS jumlah, tgl_bayar, cicilan_ke 
                FROM repayments 
                WHERE loan_id = $1 
                ORDER BY tgl_bayar DESC`;
            
            const repaymentResult = await db.query(repaymentQuery, [loanResult.rows[0].id]);
            payments = repaymentResult.rows;
        }

        // 4. Kirim Gabungan Data ke Frontend
        // Di PostgreSQL, data selalu diakses lewat .rows
        res.json({
            user: userResult.rows[0],
            loan: loanResult.rows[0] || null,
            payments: payments
        });

    } catch (error) {
        console.error("Error Detail User:", error.message);
        res.status(500).json({ 
            message: 'Terjadi kesalahan server saat mengambil detail warga',
            error: error.message 
        });
    }
});

// ENDPOINT: Ambil Data Profil Lengkap
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    try {
        // Query 1: Data User & Saldo
        const userSql = "SELECT nama, nik, email, no_hp, alamat, saldo, created_at FROM users WHERE id = $1";

        // Query 2: Data Pinjaman Aktif
        const loanSql = "SELECT * FROM loans WHERE user_id = $1 AND status = 'approved' LIMIT 1";

        // Query 3: Riwayat Transaksi (Gabungan Belanja & Simpanan)
        // PostgreSQL mewajibkan placeholder unik ($1, $2) jika nilainya berbeda, 
        // tapi karena di sini nilainya sama (userId), kita bisa pakai $1 di semua tempat.
        const historySql = `
            (SELECT 'belanja' as tipe, total_bayar as jumlah, tgl_transaksi as tgl, CAST(status_order AS TEXT) as info FROM orders WHERE user_id = $1)
            UNION ALL
            (SELECT 'simpanan' as tipe, jumlah, tgl_transaksi as tgl, CAST(tipe AS TEXT) as info FROM savings WHERE user_id = $1 AND status = 'approved')
            ORDER BY tgl DESC LIMIT 5`;

        // Jalankan semua query secara paralel untuk performa lebih cepat
        const [userRes, loanRes, historyRes] = await Promise.all([
            db.query(userSql, [userId]),
            db.query(loanSql, [userId]),
            db.query(historySql, [userId])
        ]);

        // Kirim gabungan data ke frontend
        res.json({
            user: userRes.rows[0],
            loan: loanRes.rows[0] || null,
            transactions: historyRes.rows
        });

    } catch (err) {
        console.error("Error Fetching Full Profile:", err.message);
        res.status(500).json({ error: "Gagal memuat profil lengkap", detail: err.message });
    }
});

// 1. Mengambil riwayat pinjaman milik warga yang sedang login
app.get('/api/my-loans', authenticateToken, async (req, res) => {
    try {
        // Menggunakan $1 untuk PostgreSQL dan mengurutkan dari yang terbaru
        const sql = "SELECT * FROM loans WHERE user_id = $1 ORDER BY tgl_pengajuan DESC";

        // Eksekusi query menggunakan library 'pg'
        const result = await db.query(sql, [req.user.id]);

        // Kirim hasil dari properti .rows
        res.json(result.rows);

    } catch (err) {
        console.error("Error fetching my loans:", err.message);
        res.status(500).json({ 
            error: "Gagal mengambil riwayat pinjaman Anda",
            message: err.message 
        });
    }
});

// 2. Memproses Pembayaran Angsuran (Potong Saldo)
app.post('/api/loans/pay', authenticateToken, async (req, res) => {
    const { loanId, amount } = req.body;
    const userId = req.user.id;

    // Ambil client dari pool untuk transaksi
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        // 1. Ambil Nama User, Saldo, dan hitung cicilan ke-berapa
        const sqlCheck = `
            SELECT u.nama, u.saldo, 
            (SELECT COUNT(*) FROM repayments WHERE loan_id = $1) as sudah_bayar 
            FROM users u WHERE u.id = $2`;

        const checkRes = await client.query(sqlCheck, [loanId, userId]);
        
        if (checkRes.rows.length === 0) {
            throw new Error("Data user tidak ditemukan");
        }

        const { nama, saldo, sudah_bayar } = checkRes.rows[0];
        const cicilanKe = parseInt(sudah_bayar) + 1;

        if (parseFloat(saldo) < parseFloat(amount)) {
            throw new Error("Saldo Anda tidak mencukupi untuk membayar angsuran");
        }

        // 2. Potong Saldo User
        await client.query("UPDATE users SET saldo = saldo - $1 WHERE id = $2", [amount, userId]);

        // 3. Catat di tabel Repayments
        const sqlRepayment = "INSERT INTO repayments (loan_id, user_id, jumlah_bayar, cicilan_ke) VALUES ($1, $2, $3, $4)";
        await client.query(sqlRepayment, [loanId, userId, amount, cicilanKe]);

        // 4. Update status pinjaman jadi 'lunas' jika tenor terpenuhi
        const sqlGetLoan = "SELECT tenor_bulan FROM loans WHERE id = $1";
        const loanRes = await client.query(sqlGetLoan, [loanId]);
        
        if (loanRes.rows.length > 0 && parseInt(loanRes.rows[0].tenor_bulan) <= cicilanKe) {
            await client.query("UPDATE loans SET status = 'lunas' WHERE id = $1", [loanId]);
        }

        // 5. PENCATATAN JURNAL KAS (Uang Masuk ke BUMDes)
        const jurnalRes = await client.query("SELECT saldo_akhir FROM jurnal_kas ORDER BY id DESC LIMIT 1");
        const saldoTerakhir = jurnalRes.rows.length > 0 ? parseFloat(jurnalRes.rows[0].saldo_akhir) : 0;
        const saldoBaru = saldoTerakhir + parseFloat(amount);
        const keteranganJurnal = `Angsuran ke-${cicilanKe}: ${nama} (Loan ID: ${loanId})`;

        const sqlJurnal = `
            INSERT INTO jurnal_kas (keterangan, debet, kredit, saldo_akhir, kategori) 
            VALUES ($1, $2, 0, $3, 'angsuran')`;
        await client.query(sqlJurnal, [keteranganJurnal, amount, saldoBaru]);

        // 6. Selesaikan Transaksi
        await client.query('COMMIT');

        res.json({
            message: `Berhasil membayar cicilan ke-${cicilanKe}`,
            cicilan_ke: cicilanKe
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Payment Error:", error.message);
        res.status(400).json({ error: error.message });
    } finally {
        client.release(); // Sangat penting untuk melepaskan koneksi
    }
});

app.get('/api/transactions/history', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    // Di PostgreSQL, kita bisa menggunakan placeholder $1 berulang kali jika nilainya sama
    const sql = `
        (SELECT 'Pinjaman Cair' as tipe, jumlah_pinjaman as nominal, tgl_pengajuan as tanggal, 'masuk' as arah 
         FROM loans WHERE user_id = $1 AND status = 'approved')
        UNION ALL
        (SELECT 'Bayar Cicilan' as tipe, jumlah_bayar as nominal, tgl_bayar as tanggal, 'keluar' as arah 
         FROM repayments WHERE user_id = $1)
        UNION ALL
        (SELECT 'Belanja Toko' as tipe, total_bayar as nominal, tgl_transaksi as tanggal, 'keluar' as arah 
         FROM orders WHERE user_id = $1)
        UNION ALL
        (SELECT 
            CASE WHEN CAST(tipe AS TEXT) = 'setor' THEN 'Setoran Simpanan' ELSE 'Penarikan Saldo' END as tipe, 
            jumlah as nominal, tgl_transaksi as tanggal, 
            CASE WHEN CAST(tipe AS TEXT) = 'setor' THEN 'masuk' ELSE 'keluar' END as arah
         FROM savings WHERE user_id = $1 AND status = 'approved')
        ORDER BY tanggal DESC LIMIT 30`;

    try {
        // Eksekusi query dengan satu parameter saja ($1)
        const result = await db.query(sql, [userId]);

        // Kirim hasil dari result.rows
        res.json(result.rows);

    } catch (err) {
        console.error("Error fetching transaction history:", err.message);
        res.status(500).json({ 
            error: "Gagal memuat riwayat transaksi",
            message: err.message 
        });
    }
});

app.get('/api/admin/stats', authenticateToken, isAdmin, async (req, res) => {
    try {
        // Kita jalankan semua query secara bersamaan (paralel) agar cepat
        const queries = [
            db.query("SELECT COUNT(*) as count FROM users WHERE role = 'warga'"),
            db.query("SELECT SUM(saldo) as total FROM users"),
            db.query("SELECT COUNT(*) as count FROM loans WHERE status = 'pending'"),
            db.query("SELECT COUNT(*) as count FROM orders WHERE status_order = 'pending'"),
            db.query(`
                SELECT l.id, l.jumlah_pinjaman, l.tujuan, l.tgl_pengajuan, u.nama 
                FROM loans l 
                JOIN users u ON l.user_id = u.id 
                WHERE l.status = 'pending' 
                ORDER BY l.tgl_pengajuan DESC 
                LIMIT 5`),
            db.query(`
                SELECT s.id, s.jumlah, s.tipe, s.tgl_transaksi, u.nama 
                FROM savings s 
                JOIN users u ON s.user_id = u.id 
                WHERE s.status = 'pending' 
                ORDER BY s.tgl_transaksi DESC 
                LIMIT 5`)
        ];

        // Tunggu semua query selesai
        const results = await Promise.all(queries);

        const stats = {
            totalWarga: results[0].rows[0].count,
            // PostgreSQL SUM mengembalikan string, kita ubah ke Number
            totalKas: Number(results[1].rows[0].total) || 0,
            pendingLoans: results[2].rows[0].count,
            pendingOrders: results[3].rows[0].count,
            // PERBAIKAN DI SINI: Gunakan || [] bukannya : []
            recentLoans: results[4].rows || [],
            recentSavings: results[5].rows || []
        };

        res.json(stats);
    } catch (err) {
        console.error("Dashboard Stats Error:", err.message);
        res.status(500).json({ error: "Gagal mengambil statistik dashboard" });
    }
});

app.get('/api/orders/my-history', authenticateToken, async (req, res) => {
    // Filter berdasarkan req.user.id yang didapat dari token JWT
    const userId = req.user.id;

    // Di PostgreSQL:
    // 1. GROUP_CONCAT diganti STRING_AGG
    // 2. Placeholder ? diganti $1
    // 3. CAST ke TEXT diperlukan untuk menggabungkan angka (qty) dengan string
    const sql = `
        SELECT 
            o.id, 
            o.total_bayar, 
            o.status_order, 
            o.tgl_transaksi,
            STRING_AGG(oi.qty || 'x ' || p.nama_produk, ', ') AS rincian
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.tgl_transaksi DESC
    `;

    try {
        const result = await db.query(sql, [userId]);
        
        // Kirim hasil dari result.rows
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching order history:", err.message);
        res.status(500).json({ 
            error: "Gagal mengambil riwayat belanja",
            message: err.message 
        });
    }
});

// Route Edit Produk (Admin Only)
app.put('/api/admin/products/:id', authenticateToken, upload.single('foto'), async (req, res) => {
    // Pastikan hanya admin yang bisa mengedit
    if (req.user.role !== 'admin') return res.sendStatus(403);

    const productId = req.params.id;
    const { nama_produk, deskripsi, harga, stok, kategori } = req.body;

    try {
        // 1. Ambil data lama untuk mengecek keberadaan produk
        const oldProductResult = await db.query("SELECT foto_produk FROM products WHERE id = $1", [productId]);

        if (oldProductResult.rows.length === 0) {
            return res.status(404).json({ message: "Produk tidak ditemukan" });
        }

        // 2. Logika Foto
        let fotoFinal = oldProductResult.rows[0].foto_produk; // Default gunakan foto lama

        // Jika ada file baru yang diunggah, proses dengan Sharp
        if (req.file) {
            if (!req.file.mimetype.startsWith('image/')) {
                return res.status(400).json({ error: "File harus berupa gambar!" });
            }

            const compressedBuffer = await sharp(req.file.buffer)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 70 })
                .toBuffer();

            fotoFinal = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
        }

        // 3. Jalankan Query Update PostgreSQL
        const queryUpdate = `
            UPDATE products 
            SET nama_produk = $1, 
                deskripsi = $2, 
                harga = $3, 
                stok = $4, 
                kategori = $5, 
                foto_produk = $6 
            WHERE id = $7
        `;

        await db.query(queryUpdate, [
            nama_produk,
            deskripsi,
            harga,
            stok,
            kategori,
            fotoFinal,
            productId
        ]);

        res.json({
            success: true,
            message: "Produk berhasil diperbarui!",
            data: { 
                id: productId, 
                nama_produk, 
                foto_produk: req.file ? "Updated to new image" : "Used old image" 
            }
        });

    } catch (error) {
        console.error("Error Update Produk:", error.message);
        res.status(500).json({ message: "Terjadi kesalahan pada server saat memperbarui produk" });
    }
});

app.get('/api/admin/orders', authenticateToken, async (req, res) => {
    // 1. Proteksi Role Admin
    if (req.user.role !== 'admin') return res.sendStatus(403);

    // PostgreSQL Note: 
    // - GROUP_CONCAT diganti STRING_AGG
    // - CONCAT diganti operator || atau fungsi CONCAT
    // - Semua kolom non-agregat harus masuk GROUP BY
    const sql = `
        SELECT 
            o.id, 
            o.total_bayar, 
            o.status_order, 
            o.tgl_transaksi, 
            u.nama AS nama_warga,
            STRING_AGG(oi.qty || 'x ' || p.nama_produk, ', ') AS detail_items
        FROM orders o
        JOIN users u ON o.user_id = u.id
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        GROUP BY o.id, u.nama
        ORDER BY o.tgl_transaksi DESC
    `;

    try {
        const result = await db.query(sql);

        // 2. Kirim data dari result.rows
        res.json(result.rows);

    } catch (err) {
        console.error("Admin Orders Error:", err.message);
        res.status(500).json({ 
            error: "Gagal mengambil daftar pesanan",
            message: err.message 
        });
    }
});

// --- ENDPOINT ADMIN: UPDATE STATUS ---
// UPDATE STATUS PESANAN
app.put('/api/admin/orders/:id/status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { status } = req.body;
    const { id } = req.params;

    try {
        const sql = 'UPDATE orders SET status_order = $1 WHERE id = $2';
        const result = await db.query(sql, [status, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Pesanan tidak ditemukan" });
        }
        
        res.json({ message: `Status berhasil diubah ke ${status}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// AMBIL DETAIL ITEM PESANAN (Untuk Modal Detail)
app.get('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { id } = req.params;

    const sql = `
        SELECT oi.*, p.nama_produk, p.harga 
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = $1
    `;

    try {
        const result = await db.query(sql, [id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// LIST WARGA YANG MENUNGGU VERIFIKASI
app.get('/api/admin/verifikasi-list', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    
    try {
        const sql = "SELECT id, nik, nama, alamat, status_verifikasi FROM users WHERE status_verifikasi = 'pending'";
        const result = await db.query(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PROSES VERIFIKASI (APPROVE/REJECT)
app.put('/api/admin/verify-user/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { status } = req.body; // 'verified' atau 'rejected'
    const userId = req.params.id;

    try {
        const sql = 'UPDATE users SET status_verifikasi = $1 WHERE id = $2';
        await db.query(sql, [status, userId]);
        res.json({ message: `Status user berhasil diperbarui menjadi ${status}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/savings/withdraw', authenticateToken, async (req, res) => {
    const { amount, keterangan } = req.body;
    const userId = req.user.id;

    try {
        // 1. Cek saldo warga di tabel users
        const userRes = await db.query("SELECT saldo FROM users WHERE id = $1", [userId]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User tidak ditemukan." });
        }

        const saldoSaatIni = parseFloat(userRes.rows[0].saldo);

        // Validasi kecukupan saldo
        if (saldoSaatIni < amount) {
            return res.status(400).json({ error: "Saldo Anda tidak mencukupi." });
        }

        // 2. Masukkan ke tabel savings (Tipe: tarik, Status: pending)
        // PostgreSQL menggunakan $1, $2, dst.
        const sql = `
            INSERT INTO savings (user_id, jumlah, tipe, status, keterangan) 
            VALUES ($1, $2, 'tarik', 'pending', $3)
        `;
        
        await db.query(sql, [userId, amount, keterangan]);

        res.json({ 
            status: "success", 
            message: "Pengajuan tarik tunai berhasil dikirim. Menunggu persetujuan admin." 
        });

    } catch (err) {
        console.error("Withdraw Request Error:", err.message);
        res.status(500).json({ error: "Gagal memproses pengajuan tarik tunai." });
    }
});

app.get('/api/admin/withdraw-requests', authenticateToken, isAdmin, async (req, res) => {
    const sql = `
        SELECT s.*, u.nama, u.no_hp, u.saldo as saldo_saat_ini 
        FROM savings s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.tipe = 'tarik' AND s.status = 'pending'
        ORDER BY s.tgl_transaksi ASC`;
    
    try {
        const result = await db.query(sql);
        // PostgreSQL mengembalikan data di dalam properti rows
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Withdraw Requests Error:", err.message);
        res.status(500).json({ error: "Gagal mengambil daftar antrean tarik tunai." });
    }
});

// Proses Persetujuan/Penolakan
app.post('/api/admin/process-withdraw', authenticateToken, isAdmin, async (req, res) => {
    const { id, action } = req.body; // action: 'approved' atau 'rejected'
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        // 1. Ambil data pengajuan
        const selectRes = await client.query("SELECT * FROM savings WHERE id = $1", [id]);
        if (selectRes.rows.length === 0) {
            throw new Error("Data tidak ditemukan");
        }
        
        const data = selectRes.rows[0];
        const statusBaru = action === 'approved' ? 'approved' : 'rejected';

        // 2. Update status di tabel savings
        await client.query("UPDATE savings SET status = $1 WHERE id = $2", [statusBaru, id]);
        
        if (action === 'approved') {
            // 3. Kurangi saldo warga
            await client.query("UPDATE users SET saldo = saldo - $1 WHERE id = $2", [data.jumlah, data.user_id]);

            // 4. Catat ke Jurnal Kas (Kredit/Uang Keluar)
            // Catatan: Anda bisa menambahkan kolom saldo_akhir di sini jika diperlukan seperti di API sebelumnya
            const sqlJurnal = "INSERT INTO jurnal_kas (keterangan, kredit, kategori) VALUES ($1, $2, 'Tarik Tunai')";
            await client.query(sqlJurnal, [`Tarik Tunai Warga ID: ${data.user_id}`, data.jumlah]);

            await client.query('COMMIT');
            res.json({ message: "Penarikan berhasil disetujui dan saldo warga telah dipotong" });
        } else {
            await client.query('COMMIT');
            res.json({ message: "Pengajuan penarikan telah ditolak" });
        }

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Process Withdraw Error:", err.message);
        res.status(err.message === "Data tidak ditemukan" ? 404 : 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/savings/request', authenticateToken, async (req, res) => {
    const { jumlah, tipe, keterangan } = req.body;
    const sql = "INSERT INTO savings (user_id, jumlah, tipe, keterangan) VALUES ($1, $2, $3, $4)";

    try {
        await db.query(sql, [req.user.id, jumlah, tipe, keterangan]);
        res.json({ message: `Permintaan ${tipe} berhasil dikirim. Menunggu verifikasi admin.` });
    } catch (err) {
        console.error("Savings Request Error:", err.message);
        res.status(500).json({ error: "Gagal mengirim permintaan simpanan" });
    }
});

app.get('/api/savings/my', authenticateToken, async (req, res) => {
    const sql = "SELECT * FROM savings WHERE user_id = $1 ORDER BY tgl_transaksi DESC";

    try {
        const result = await db.query(sql, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Database Error:", err.message);
        res.status(500).json({ error: "Gagal mengambil data riwayat simpanan" });
    }
});

// 1. Ambil semua permintaan simpanan yang masih pending
app.get('/api/admin/savings/all', authenticateToken, isAdmin, async (req, res) => {
    const sql = `
        SELECT s.*, u.nama 
        FROM savings s 
        JOIN users u ON s.user_id = u.id 
        ORDER BY s.tgl_transaksi DESC
    `;

    try {
        const result = await db.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch All Savings Error:", err.message);
        res.status(500).json({ error: "Gagal mengambil laporan simpanan" });
    }
});


app.post('/api/midtrans/webhook', async (req, res) => {
    const notif = req.body;
    const client = await db.connect(); // Ambil client untuk transaksi

    try {
        /* ===============================
           1. VERIFIKASI SIGNATURE
        =============================== */
        const serverKey = process.env.MIDTRANS_SERVER_KEY;
        const combinedString = notif.order_id + notif.status_code + notif.gross_amount + serverKey;
        const localSignature = crypto.createHash('sha512').update(combinedString).digest('hex');

        if (localSignature !== notif.signature_key) {
            return res.status(401).json({ message: "Invalid Signature" });
        }

        /* ===============================
           2. CEK STATUS TRANSAKSI
        =============================== */
        if (notif.transaction_status !== 'settlement' && notif.transaction_status !== 'capture') {
            return res.status(200).send('OK');
        }

        const userId = notif.custom_field1;
        const amount = parseInt(notif.gross_amount);
        const ket = notif.custom_field2 || "Setoran Online";

        await client.query('BEGIN'); // MULAI TRANSAKSI

        /* ===============================
           3. CEGAH WEBHOOK DOBEL (IDEMPOTENT)
        =============================== */
        // Di PostgreSQL, kita gunakan LIKE dengan placeholder $1
        const checkRes = await client.query(
            "SELECT id FROM savings WHERE keterangan LIKE $1", 
            [`%${notif.order_id}%`]
        );

        if (checkRes.rows.length > 0) {
            console.log("⚠️ Webhook duplikat diabaikan:", notif.order_id);
            await client.query('ROLLBACK');
            return res.status(200).send('OK');
        }

        /* ===============================
           4. EKSEKUSI DATA (ATOMIC)
        =============================== */

        // A. Ambil Nama User (Untuk Jurnal)
        const userRes = await client.query("SELECT nama FROM users WHERE id = $1", [userId]);
        if (userRes.rows.length === 0) {
            throw new Error("User tidak ditemukan");
        }
        const namaUser = userRes.rows[0].nama;

        // B. Simpan Riwayat Simpanan
        const sqlSavings = `
            INSERT INTO savings (user_id, jumlah, tipe, status, keterangan, tgl_transaksi) 
            VALUES ($1, $2, 'setor', 'approved', $3, NOW())`;
        await client.query(sqlSavings, [userId, amount, `${ket} (${notif.order_id})`]);

        // C. Update Saldo User
        await client.query("UPDATE users SET saldo = saldo + $1 WHERE id = $2", [amount, userId]);

        // D. Catat Jurnal Kas
        const deskripsiKas = `Top Up Simpanan via Midtrans: ${notif.order_id} - ${namaUser} (ID: ${userId})`;
        const sqlJurnal = `
            INSERT INTO jurnal_kas (keterangan, debet, kredit, kategori) 
            VALUES ($1, $2, 0, 'simpanan')`;
        await client.query(sqlJurnal, [deskripsiKas, amount]);

        /* ===============================
           5. COMMIT & SELESAI
        =============================== */
        await client.query('COMMIT');
        console.log(`✅ Midtrans OK | User: ${namaUser} | +Rp${amount}`);
        res.status(200).send('OK');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Webhook Error:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release(); // Kembalikan koneksi ke pool
    }
});

// Endpoint Laporan Kas (Gaya Callback)
app.get('/api/admin/laporan-kas', authenticateToken, isAdmin, async (req, res) => {
    try {
        // 1. Definisikan Query
        // PostgreSQL mengembalikan SUM sebagai string, jadi kita akan mengonversinya nanti
        const sqlSummary = "SELECT SUM(debet) as total_masuk, SUM(kredit) as total_keluar FROM jurnal_kas";
        const sqlJurnal = "SELECT * FROM jurnal_kas ORDER BY created_at DESC LIMIT 50";

        // 2. Jalankan kedua query secara paralel (lebih cepat)
        const [summaryRes, jurnalRes] = await Promise.all([
            db.query(sqlSummary),
            db.query(sqlJurnal)
        ]);

        // 3. Ambil hasil dan konversi angka (Postgres SUM handling)
        const summary = {
            total_masuk: Number(summaryRes.rows[0].total_masuk) || 0,
            total_keluar: Number(summaryRes.rows[0].total_keluar) || 0,
            saldo_neto: (Number(summaryRes.rows[0].total_masuk) || 0) - (Number(summaryRes.rows[0].total_keluar) || 0)
        };

        // 4. Kirim respon
        res.json({
            status: "success",
            summary: summary,
            data: jurnalRes.rows
        });

    } catch (err) {
        console.error("Laporan Kas Error:", err.message);
        res.status(500).json({ error: "Gagal memuat laporan kas" });
    }
});

app.listen(PORT, () => {
    console.log(`Server BUMDes berjalan di http://localhost:${PORT}`);
});
