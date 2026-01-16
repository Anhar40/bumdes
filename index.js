require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
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
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 50, // Maksimal 10-20 koneksi simultan
    queueLimit: 0
});

// Karena pool menangani koneksi secara otomatis, 
// Anda tidak perlu memanggil db.connect() secara manual.
// Jika ingin mengecek koneksi di awal:
db.getConnection((err, connection) => {
    if (err) {
        console.error('Gagal koneksi database:', err.message);
        return;
    }
    console.log('Terhubung ke Database MySQL (via Pool)');
    connection.release(); // Kembalikan koneksi ke pool
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
app.post("/api/subscribe", authenticateToken, (req, res) => {
  const subscription = req.body;
  const userId = req.user.id;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ message: "Subscription tidak valid" });
  }

  const sql = `
    UPDATE users
    SET push_subscription = ?
    WHERE id = ?
  `;

  db.query(sql, [JSON.stringify(subscription), userId], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});



// Register Warga
app.post('/api/register', upload.single('ktp'), async (req, res) => {
    try {
        const { nik, nama, email, password, alamat, no_hp } = req.body;
        let fotoKtpBase64 = null;

        // 1. Hash Password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 2. Proses Gambar KTP (Jika ada)
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

        // 3. Simpan ke Database menggunakan Promise
        const sql = `INSERT INTO users (nik, nama, email, password, alamat, no_hp, foto_ktp) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        
        // Menggunakan await db.promise().query
        // Koneksi otomatis diambil dari pool dan dilepaskan kembali setelah selesai
        await db.promise().query(sql, [nik, nama, email, hashedPassword, alamat, no_hp, fotoKtpBase64]);

        // 4. Respon Berhasil
        res.status(201).json({ 
            message: 'Registrasi berhasil, menunggu verifikasi',
            image_size: fotoKtpBase64 ? `${(fotoKtpBase64.length / 1024).toFixed(2)} KB` : 'No Image'
        });

    } catch (error) {
        // Semua error (Bcrypt, Sharp, maupun Database) akan ditangkap di sini
        console.error("System Error:", error);

        // Cek jika ini error duplikat dari database
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "NIK atau Email sudah terdaftar" });
        }

        res.status(500).json({ error: "Terjadi kesalahan sistem saat registrasi" });
    }
});

// Login (Warga & Admin)
app.post('/api/login', (req, res) => {
    const { identity, password, role } = req.body;

    // Perbaikan SQL: Gunakan kurung pada (nik = ? OR email = ?) 
    // agar pengecekan role tidak kacau oleh operator OR
    const sql = `SELECT * FROM users WHERE (nik = ? OR email = ?) AND role = ?`;

    db.query(sql, [identity, identity, role], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ message: 'User tidak ditemukan atau Role tidak sesuai' });
        }

        const user = results[0];

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

        // 3. Jika Admin (bebas verifikasi) atau Warga yang sudah 'verified'
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
    });
});

app.get('/api/admin/users', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Akses ditolak' });
    }
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

    db.query(sql, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// Update status verifikasi (Satu endpoint untuk semua aksi verifikasi/reject)
app.put('/api/admin/users/status/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ message: 'Akses ditolak' });

  const { status } = req.body;
  const { id } = req.params;

  const sql = "UPDATE users SET status_verifikasi = ? WHERE id = ?";
  db.query(sql, [status, id], async (err) => {
    if (err) return res.status(500).json({ error: err.message });

    // Ambil subscription user
    const subSql = "SELECT push_subscription FROM users WHERE id = ?";
    db.query(subSql, [id], async (err, rows) => {
      if (err || !rows.length) {
        return res.json({ message: `User di-${status}, tanpa notifikasi` });
      }

      const subscription = rows[0].push_subscription;
      if (!subscription) {
        return res.json({ message: `User di-${status}, user belum aktifkan notif` });
      }

      // Payload notif
      const payload = JSON.stringify({
        title: "BUMDes Digital",
        url: "/login.html",
        body:
          status === "Verified"
            ? "Akun kamu berhasil diverifikasi"
            : "Status akun kamu diperbarui",
      });

      try {
        await webPush.sendNotification(JSON.parse(subscription), payload);
      } catch (e) {
        console.log("Push gagal:", e.message);
      }

      res.json({ message: `User berhasil di-${status} + notifikasi terkirim` });
    });
  });
});


// --- ENDPOINT ORDER (TAMBAHAN LOGIKA STOK) ---
app.post('/api/orders/checkout', authenticateToken, async (req, res) => {
    const { total_bayar, items } = req.body;
    const userId = req.user.id;

    if (!items || items.length === 0) {
        return res.status(400).json({ message: "Keranjang kosong" });
    }

    const connection = db.promise();

    try {
        await connection.query('START TRANSACTION');

        // 1. Cek Saldo & Data User
        const [userRows] = await connection.query("SELECT nama, saldo FROM users WHERE id = ?", [userId]);
        if (userRows.length === 0 || Number(userRows[0].saldo) < Number(total_bayar)) {
            throw new Error("Saldo Anda tidak mencukupi.");
        }
        const namaUser = userRows[0].nama;

        // 2. Masukkan ke Tabel Orders
        const [orderResult] = await connection.query(
            "INSERT INTO orders (user_id, total_bayar, status_order, tgl_transaksi) VALUES (?, ?, 'pending', NOW())",
            [userId, total_bayar]
        );
        const orderId = orderResult.insertId;

        // 3. Loop Item: Cek Stok, Kurangi Stok, & Simpan Detail
        for (const item of items) {
            const pid = item.product_id || item.id;

            const [pRows] = await connection.query("SELECT stok, nama_produk, harga FROM products WHERE id = ?", [pid]);
            if (pRows.length === 0) throw new Error(`Produk ID ${pid} tidak ditemukan.`);

            const product = pRows[0];
            if (product.stok < item.qty) {
                throw new Error(`Stok '${product.nama_produk}' tidak mencukupi.`);
            }

            await connection.query("UPDATE products SET stok = stok - ? WHERE id = ?", [item.qty, pid]);

            const subtotalItem = product.harga * item.qty;
            await connection.query(
                "INSERT INTO order_items (order_id, product_id, qty, subtotal) VALUES (?, ?, ?, ?)",
                [orderId, pid, item.qty, subtotalItem]
            );
        }

        // 4. Potong Saldo User
        await connection.query("UPDATE users SET saldo = saldo - ? WHERE id = ?", [total_bayar, userId]);

        // 5. PENCATATAN JURNAL KAS (Uang Masuk ke BUMDes)
        const [lastJurnal] = await connection.query("SELECT saldo_akhir FROM jurnal_kas ORDER BY id DESC LIMIT 1");
        const saldoKasSekarang = lastJurnal.length > 0 ? Number(lastJurnal[0].saldo_akhir) : 0;
        const saldoKasBaru = saldoKasSekarang + Number(total_bayar);

        await connection.query(
            `INSERT INTO jurnal_kas (keterangan, debet, kredit, saldo_akhir, kategori) 
             VALUES (?, ?, 0, ?, 'belanja')`,
            [`Belanja Toko: ${namaUser} (Order ID: ${orderId})`, total_bayar, saldoKasBaru]
        );

        await connection.query('COMMIT');
        res.json({ success: true, message: "Checkout berhasil dan tercatat di kas!" });

    } catch (error) {
        await connection.query('ROLLBACK');
        console.error("Checkout Error:", error.message);
        res.status(400).json({ message: error.message });
    }
});
// Tambah Produk (Admin Only)
app.post('/api/admin/products', authenticateToken, upload.single('foto'), async (req, res) => {
    // 1. Validasi Role Admin
    if (req.user.role !== 'admin') return res.sendStatus(403);

    try {
        const { nama_produk, deskripsi, harga, stok, kategori } = req.body;
        let fotoBase64 = null;

        // 2. Cek apakah ada file yang diunggah
        if (req.file) {
            // Validasi: Pastikan yang diupload adalah gambar
            if (!req.file.mimetype.startsWith('image/')) {
                return res.status(400).json({ error: "File harus berupa gambar!" });
            }

            // 3. Proses Kompresi Otomatis dengan Sharp
            const compressedBuffer = await sharp(req.file.buffer)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true }) // Maksimal 800px
                .jpeg({ quality: 70 }) // Kompres kualitas ke 70% format JPEG
                .toBuffer();

            // 4. Konversi ke String Base64
            fotoBase64 = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
        }

        // 5. Simpan ke Database
        const sql = `INSERT INTO products (nama_produk, deskripsi, harga, stok, kategori, foto_produk) 
                     VALUES (?, ?, ?, ?, ?, ?)`;
        
        db.query(sql, [nama_produk, deskripsi, harga, stok, kategori, fotoBase64], (err, result) => {
            if (err) {
                console.error("Database Error:", err);
                return res.status(500).json({ error: "Gagal menyimpan ke database" });
            }
            res.json({ 
                message: 'Produk berhasil ditambahkan',
                size_info: fotoBase64 ? `${(fotoBase64.length / 1024).toFixed(2)} KB` : 'No Image'
            });
        });

    } catch (error) {
        console.error("System Error:", error);
        res.status(500).json({ error: "Terjadi kesalahan saat memproses gambar" });
    }
});

// 1. Ambil Semua Produk (Untuk Katalog Warga & Tabel Admin)
// Menggunakan async agar bisa menggunakan await
app.get('/api/products', async (req, res) => {
    try {
        const sql = "SELECT * FROM products ORDER BY id DESC";

        // 1. Menggunakan db.promise().query() 
        // Pool akan otomatis memberikan koneksi dan mengembalikannya setelah selesai
        // Kita menggunakan destructuring [rows] karena mysql2 promise mengembalikan [data, metadata]
        const [rows] = await db.promise().query(sql);

        // 2. Kirim hasil query ke client
        res.json(rows);

    } catch (error) {
        // 3. Error handling jika database sibuk atau terjadi gangguan
        console.error("Error fetching products:", error.message);
        res.status(500).json({ 
            error: "Gagal mengambil data produk",
            message: error.message 
        });
    }
});

// 2. Hapus Produk (Hanya Admin)
app.delete('/api/admin/products/:id', authenticateToken, (req, res) => {
    // Pastikan hanya admin yang bisa menghapus
    if (req.user.role !== 'admin') return res.sendStatus(403);

    const { id } = req.params;
    const sql = "DELETE FROM products WHERE id = ?";

    db.query(sql, [id], (err, result) => {
        if (err) {
            console.error("Error deleting product:", err);
            return res.status(500).json({ error: "Gagal menghapus produk" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Produk tidak ditemukan" });
        }

        res.json({ message: "Produk berhasil dihapus" });
    });
});

// --- ENDPOINT SIMPAN PINJAM ---

// Ajukan Pinjaman
app.post('/api/loans/apply', authenticateToken, (req, res) => {
    // Ambil 'tujuan' juga dari req.body
    const { jumlah_pinjaman, tenor_bulan, angsuran_bulanan, tujuan } = req.body;

    // Sesuaikan query dengan kolom baru
    const sql = `INSERT INTO loans (user_id, jumlah_pinjaman, tenor_bulan, angsuran_bulanan, tujuan) VALUES (?, ?, ?, ?, ?)`;

    db.query(sql, [req.user.id, jumlah_pinjaman, tenor_bulan, angsuran_bulanan, tujuan], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Pengajuan pinjaman berhasil' });
    });
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
app.get('/api/admin/loans/pending', authenticateToken, isAdmin, (req, res) => {
    const sql = `
        SELECT l.*, u.nama, u.no_hp 
        FROM loans l 
        JOIN users u ON l.user_id = u.id 
        WHERE l.status = 'pending' 
        ORDER BY l.tgl_pengajuan ASC`;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/admin/loans', authenticateToken, isAdmin, (req, res) => {
    const sql = `
        SELECT 
            l.*,
            u.nama,
            u.no_hp
        FROM loans l
        JOIN users u ON l.user_id = u.id
        ORDER BY l.tgl_pengajuan DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});


// 2. Update Status Pinjaman (Ditambah middleware isAdmin)
app.put('/api/admin/loans/:id/status', authenticateToken, isAdmin, (req, res) => {
    const { status, catatan_admin } = req.body;
    const loanId = req.params.id;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Status tidak valid" });
    }

    // Mulai Transaksi Database
    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });

        // 1. Ambil data pinjaman terlebih dahulu untuk tahu siapa user & berapa jumlahnya
        const sqlGetLoan = `SELECT user_id, jumlah_pinjaman FROM loans WHERE id = ?`;

        db.query(sqlGetLoan, [loanId], (err, results) => {
            if (err || results.length === 0) {
                return db.rollback(() => res.status(404).json({ message: "Pinjaman tidak ditemukan" }));
            }

            const { user_id, jumlah_pinjaman } = results[0];

            // 2. Update status pinjaman
            const sqlUpdateStatus = `UPDATE loans SET status = ?, catatan_admin = ? WHERE id = ?`;
            db.query(sqlUpdateStatus, [status, catatan_admin || null, loanId], (err, result) => {
                if (err) {
                    return db.rollback(() => res.status(500).json({ error: err.message }));
                }

                // 3. Jika status 'approved', tambahkan saldo ke user
                if (status === 'approved') {
                    const sqlUpdateSaldo = `UPDATE users SET saldo = saldo + ? WHERE id = ?`;
                    db.query(sqlUpdateSaldo, [jumlah_pinjaman, user_id], (err, resSaldo) => {
                        if (err) {
                            return db.rollback(() => res.status(500).json({ error: "Gagal menambah saldo" }));
                        }

                        // Selesai & Simpan (Commit)
                        db.commit((err) => {
                            if (err) return db.rollback(() => res.status(500).json({ error: "Commit Error" }));
                            res.json({ message: "Pinjaman disetujui & saldo warga telah bertambah" });
                        });
                    });
                } else {
                    // Jika status 'rejected', cukup simpan perubahan status saja
                    db.commit((err) => {
                        if (err) return db.rollback(() => res.status(500).json({ error: "Commit Error" }));
                        res.json({ message: "Pengajuan pinjaman telah ditolak" });
                    });
                }
            });
        });
    });
});

app.get('/api/profile', authenticateToken, (req, res) => {
    // Ambil data terbaru dari database (terutama saldo yang mungkin baru diupdate admin)
    const sql = "SELECT nama, saldo, status_verifikasi FROM users WHERE id = ?";
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ message: "User tidak ditemukan" });
        res.json(results[0]);
    });
});
// Middleware untuk verifikasi JWT (Pastikan Anda sudah punya ini)
// Endpoint Detail Warga untuk Modal Admin
app.get('/api/admin/users/detail/:id', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;

    try {
        // Gunakan db.promise() agar bisa menggunakan await
        const connection = db.promise();

        // 1. Ambil Data User (Biodata)
        const [users] = await connection.query(
            'SELECT id, nama, nik, email, no_hp, saldo, foto_ktp, status_verifikasi FROM users WHERE id = ?',
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ message: 'User tidak ditemukan' });
        }

        // 2. Ambil Pinjaman Aktif (Status 'approved' sesuai DB Anda)
        // Kita juga ambil tenor dan angsuran untuk ditampilkan di modal
        const [loans] = await connection.query(
            'SELECT id, jumlah_pinjaman, tgl_pengajuan, tenor_bulan, angsuran_bulanan, tujuan FROM loans WHERE user_id = ? AND status = "approved" LIMIT 1',
            [userId]
        );

        let payments = [];
        // 3. Jika ada pinjaman aktif, ambil riwayat angsuran dari tabel 'repayments'
        if (loans.length > 0) {
            const [rows] = await connection.query(
                `SELECT jumlah_bayar AS jumlah, tgl_bayar, cicilan_ke 
                 FROM repayments 
                 WHERE loan_id = ? 
                 ORDER BY tgl_bayar DESC`,
                [loans[0].id]
            );
            payments = rows;
        }

        // 4. Kirim Gabungan Data ke Frontend
        res.json({
            user: users[0],
            loan: loans[0] || null,
            payments: payments
        });

    } catch (error) {
        console.error("Error Detail User:", error.message);
        res.status(500).json({ message: 'Terjadi kesalahan server saat mengambil detail warga' });
    }
});

// ENDPOINT: Ambil Data Profil Lengkap
app.get('/api/user/profile', authenticateToken, (req, res) => {
    const userId = req.user.id;

    // Query 1: Data User & Saldo
    const userSql = "SELECT nama, nik, email, no_hp, alamat, saldo, created_at FROM users WHERE id = ?";

    // Query 2: Data Pinjaman Aktif
    const loanSql = "SELECT * FROM loans WHERE user_id = ? AND status = 'approved' LIMIT 1";

    // Query 3: Riwayat Transaksi (Gabungan Belanja & Simpanan)
    const historySql = `
        (SELECT 'belanja' as tipe, total_bayar as jumlah, tgl_transaksi as tgl, status_order as info FROM orders WHERE user_id = ?)
        UNION ALL
        (SELECT 'simpanan' as tipe, jumlah, tgl_transaksi as tgl, tipe as info FROM savings WHERE user_id = ? AND status = 'approved')
        ORDER BY tgl DESC LIMIT 5`;

    db.query(userSql, [userId], (err, userResult) => {
        if (err) return res.status(500).json(err);

        db.query(loanSql, [userId], (err, loanResult) => {
            db.query(historySql, [userId, userId], (err, historyResult) => {
                res.json({
                    user: userResult[0],
                    loan: loanResult[0] || null,
                    transactions: historyResult
                });
            });
        });
    });
});

// 1. Mengambil riwayat pinjaman milik warga yang sedang login
app.get('/api/my-loans', authenticateToken, (req, res) => {
    const sql = "SELECT * FROM loans WHERE user_id = ? ORDER BY tgl_pengajuan DESC";
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 2. Memproses Pembayaran Angsuran (Potong Saldo)
app.post('/api/loans/pay', authenticateToken, (req, res) => {
    const { loanId, amount } = req.body;
    const userId = req.user.id;

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });

        // 1. Ambil Nama User, Saldo, dan hitung cicilan ke-berapa
        const sqlCheck = `
            SELECT u.nama, u.saldo, 
            (SELECT COUNT(*) FROM repayments WHERE loan_id = ?) as sudah_bayar 
            FROM users u WHERE u.id = ?`;

        db.query(sqlCheck, [loanId, userId], (err, results) => {
            if (err || results.length === 0) {
                return db.rollback(() => res.status(404).json({ message: "Data tidak ditemukan" }));
            }

            const { nama, saldo, sudah_bayar } = results[0];
            const cicilanKe = sudah_bayar + 1;

            if (saldo < amount) {
                return db.rollback(() => res.status(400).json({ message: "Saldo tidak mencukupi" }));
            }

            // 2. Potong Saldo User
            db.query("UPDATE users SET saldo = saldo - ? WHERE id = ?", [amount, userId], (err) => {
                if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                // 3. Catat di tabel Repayments
                const sqlRepayment = "INSERT INTO repayments (loan_id, user_id, jumlah_bayar, cicilan_ke) VALUES (?, ?, ?, ?)";
                db.query(sqlRepayment, [loanId, userId, amount, cicilanKe], (err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                    // 4. Update status pinjaman jadi 'lunas' jika tenor terpenuhi
                    const sqlGetTenor = "SELECT tenor_bulan FROM loans WHERE id = ?";
                    db.query(sqlGetTenor, [loanId], (err, loanRes) => {
                        if (loanRes && loanRes[0].tenor_bulan <= cicilanKe) {
                            db.query("UPDATE loans SET status = 'lunas' WHERE id = ?", [loanId]);
                        }

                        // 5. PENCATATAN JURNAL KAS (Uang Masuk ke BUMDes)
                        // Ambil saldo terakhir dari jurnal_kas
                        db.query("SELECT saldo_akhir FROM jurnal_kas ORDER BY id DESC LIMIT 1", (err, jurnalRes) => {
                            const saldoTerakhir = jurnalRes.length > 0 ? parseFloat(jurnalRes[0].saldo_akhir) : 0;
                            const saldoBaru = saldoTerakhir + parseFloat(amount);
                            const keteranganJurnal = `Angsuran ke-${cicilanKe}: ${nama} (Loan ID: ${loanId})`;

                            const sqlJurnal = `
                                INSERT INTO jurnal_kas (keterangan, debet, kredit, saldo_akhir, kategori) 
                                VALUES (?, ?, 0, ?, 'angsuran')`;

                            db.query(sqlJurnal, [keteranganJurnal, amount, saldoBaru], (err) => {
                                if (err) return db.rollback(() => res.status(500).json({ error: "Gagal mencatat jurnal" }));

                                // 6. Selesaikan Transaksi
                                db.commit((err) => {
                                    if (err) return db.rollback(() => res.status(500).json({ error: "Commit error" }));
                                    res.json({
                                        message: `Berhasil membayar cicilan ke-${cicilanKe}`,
                                        cicilan_ke: cicilanKe
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.get('/api/transactions/history', authenticateToken, (req, res) => {
    const userId = req.user.id;

    // Menambahkan data dari tabel savings ke dalam mutasi
    const sql = `
        (SELECT 'Pinjaman Cair' as tipe, jumlah_pinjaman as nominal, tgl_pengajuan as tanggal, 'masuk' as arah 
         FROM loans WHERE user_id = ? AND status = 'approved')
        UNION ALL
        (SELECT 'Bayar Cicilan' as tipe, jumlah_bayar as nominal, tgl_bayar as tanggal, 'keluar' as arah 
         FROM repayments WHERE user_id = ?)
        UNION ALL
        (SELECT 'Belanja Toko' as tipe, total_bayar as nominal, tgl_transaksi as tanggal, 'keluar' as arah 
         FROM orders WHERE user_id = ?)
        UNION ALL
        (SELECT 
            CASE WHEN tipe = 'setor' THEN 'Setoran Simpanan' ELSE 'Penarikan Saldo' END as tipe, 
            jumlah as nominal, tgl_transaksi as tanggal, 
            CASE WHEN tipe = 'setor' THEN 'masuk' ELSE 'keluar' END as arah
         FROM savings WHERE user_id = ? AND status = 'approved')
        ORDER BY tanggal DESC LIMIT 30`;

    db.query(sql, [userId, userId, userId, userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/admin/stats', authenticateToken, isAdmin, async (req, res) => {
    try {
        const stats = {};

        // 1. Total Warga (Hanya yang memiliki role 'warga')
        const [warga] = await db.promise().query(
            "SELECT COUNT(*) as count FROM users WHERE role = 'warga'"
        );
        stats.totalWarga = warga[0].count;

        // 2. Total Kas (Jumlah saldo seluruh user di tabel users)
        const [kas] = await db.promise().query(
            "SELECT SUM(saldo) as total FROM users"
        );
        stats.totalKas = kas[0].total || 0;

        // 3. Pending Pinjaman (Data dari tabel loans dengan status 'pending')
        const [loansCount] = await db.promise().query(
            "SELECT COUNT(*) as count FROM loans WHERE status = 'pending'"
        );
        stats.pendingLoans = loansCount[0].count;

        // 4. Pending Toko (Data dari tabel orders dengan status_order 'pending')
        const [ordersCount] = await db.promise().query(
            "SELECT COUNT(*) as count FROM orders WHERE status_order = 'pending'"
        );
        stats.pendingOrders = ordersCount[0].count;

        // 5. Recent Loans (Mengambil kolom 'tujuan' dan 'tgl_pengajuan' dari tabel loans)
        const [recentLoans] = await db.promise().query(`
            SELECT l.id, l.jumlah_pinjaman, l.tujuan, l.tgl_pengajuan, u.nama 
            FROM loans l 
            JOIN users u ON l.user_id = u.id 
            WHERE l.status = 'pending' 
            ORDER BY l.tgl_pengajuan DESC 
            LIMIT 5`);
        stats.recentLoans = recentLoans;

        // 6. Recent Savings (Mengambil kolom 'tipe' dan 'tgl_transaksi' dari tabel savings)
        const [recentSavings] = await db.promise().query(`
            SELECT s.id, s.jumlah, s.tipe, s.tgl_transaksi, u.nama 
            FROM savings s 
            JOIN users u ON s.user_id = u.id 
            WHERE s.status = 'pending' 
            ORDER BY s.tgl_transaksi DESC 
            LIMIT 5`);
        stats.recentSavings = recentSavings;

        res.json(stats);
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ error: "Gagal mengambil statistik dashboard" });
    }
});

// --- ENDPOINT KERANJANG & ORDER ---

// --- ENDPOINT CHECKOUT (USER) ---


// --- ENDPOINT ADMIN PESANAN ---
// --- ENDPOINT RIWAYAT PESANAN (USER) ---
app.get('/api/orders/my-history', authenticateToken, (req, res) => {
    // Filter berdasarkan req.user.id yang didapat dari token JWT
    const sql = `
        SELECT o.*, 
        GROUP_CONCAT(CONCAT(oi.qty, 'x ', p.nama_produk) SEPARATOR ', ') AS rincian
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE o.user_id = ?
        GROUP BY o.id
        ORDER BY o.tgl_transaksi DESC
    `;

    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Route Edit Produk (Admin Only)
app.put('/api/admin/products/:id', authenticateToken, upload.single('foto'), async (req, res) => {
    const productId = req.params.id;
    const { nama_produk, deskripsi, harga, stok, kategori } = req.body;

    try {
        // 1. Ambil data lama untuk mengecek foto lama
        const [oldProduct] = await db.promise().query("SELECT foto_produk FROM products WHERE id = ?", [productId]);

        if (oldProduct.length === 0) {
            return res.status(404).json({ message: "Produk tidak ditemukan" });
        }

        // 2. Tentukan foto yang akan digunakan
        // Jika ada file baru diunggah, gunakan file baru. Jika tidak, gunakan yang lama.
        let namaFoto = oldProduct[0].foto_produk;
        if (req.file) {
            namaFoto = req.file.filename;
        }

        // 3. Jalankan Query Update
        const queryUpdate = `
            UPDATE products 
            SET nama_produk = ?, 
                deskripsi = ?, 
                harga = ?, 
                stok = ?, 
                kategori = ?, 
                foto_produk = ? 
            WHERE id = ?
        `;

        await db.promise().query(queryUpdate, [
            nama_produk,
            deskripsi,
            harga,
            stok,
            kategori,
            namaFoto,
            productId
        ]);

        res.json({
            success: true,
            message: "Produk berhasil diperbarui!",
            data: { id: productId, nama_produk, foto_produk: namaFoto }
        });

    } catch (error) {
        console.error("Error Update Produk:", error.message);
        res.status(500).json({ message: "Terjadi kesalahan pada server" });
    }
});

app.get('/api/admin/orders', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);

    // Query Menggunakan LEFT JOIN agar pesanan tetap muncul meski item produk terhapus
    const sql = `
        SELECT 
            o.id, 
            o.total_bayar, 
            o.status_order, 
            o.tgl_transaksi, 
            u.nama AS nama_warga,
            GROUP_CONCAT(CONCAT(oi.qty, 'x ', p.nama_produk) SEPARATOR ', ') AS detail_items
        FROM orders o
        JOIN users u ON o.user_id = u.id
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        GROUP BY o.id
        ORDER BY o.tgl_transaksi DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// --- ENDPOINT ADMIN: UPDATE STATUS ---
app.put('/api/admin/orders/:id/status', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { status } = req.body;
    const { id } = req.params;

    // Gunakan Transaction jika ingin mengurangi stok saat status berubah jadi 'diproses'
    db.query('UPDATE orders SET status_order = ? WHERE id = ?', [status, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: `Status berhasil diubah ke ${status}` });
    });
});
// AMBIL DETAIL ITEM PESANAN (Untuk Modal Detail)
app.get('/api/admin/orders/:id', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { id } = req.params;

    const sql = `
        SELECT oi.*, p.nama_produk, p.harga 
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = ?
    `;

    db.query(sql, [id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// --- ENDPOINT ADMIN (VERIFIKASI WARGA) ---

app.get('/api/admin/verifikasi-list', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    db.query("SELECT id, nik, nama, alamat, status_verifikasi FROM users WHERE status_verifikasi = 'pending'", (err, results) => {
        res.json(results);
    });
});

app.put('/api/admin/verify-user/:id', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { status } = req.body; // 'verified' atau 'rejected'
    db.query('UPDATE users SET status_verifikasi = ? WHERE id = ?', [status, req.params.id], (err, result) => {
        res.json({ message: 'Status user diperbarui' });
    });
});

app.post('/api/savings/withdraw', authenticateToken, (req, res) => {
    const { amount, keterangan } = req.body;
    const userId = req.user.id;

    // 1. Cek saldo warga di tabel users
    db.query("SELECT saldo FROM users WHERE id = ?", [userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const saldoSaatIni = parseFloat(results[0].saldo);

        if (saldoSaatIni < amount) {
            return res.status(400).json({ error: "Saldo Anda tidak mencukupi." });
        }

        // 2. Masukkan ke tabel savings (Tipe: tarik, Status: pending)
        const sql = `INSERT INTO savings (user_id, jumlah, tipe, status, keterangan) 
                     VALUES (?, ?, 'tarik', 'pending', ?)`;
        
        db.query(sql, [userId, amount, keterangan], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ 
                status: "success", 
                message: "Pengajuan tarik tunai berhasil dikirim. Menunggu persetujuan admin." 
            });
        });
    });
});

// Ambil daftar antrean tarik tunai
app.get('/api/admin/withdraw-requests', authenticateToken, isAdmin, (req, res) => {
    const sql = `
        SELECT s.*, u.nama, u.no_hp, u.saldo as saldo_saat_ini 
        FROM savings s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.tipe = 'tarik' AND s.status = 'pending'
        ORDER BY s.tgl_transaksi ASC`;
    
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Proses Persetujuan/Penolakan
app.post('/api/admin/process-withdraw', authenticateToken, isAdmin, (req, res) => {
    const { id, action } = req.body; // action: 'approved' atau 'rejected'

    db.beginTransaction((err) => {
        // 1. Ambil data pengajuan
        db.query("SELECT * FROM savings WHERE id = ?", [id], (err, results) => {
            if (results.length === 0) return db.rollback(() => res.status(404).send("Data tidak ditemukan"));
            
            const data = results[0];
            const statusBaru = action === 'approved' ? 'approved' : 'rejected';

            // 2. Update status di tabel savings
            db.query("UPDATE savings SET status = ? WHERE id = ?", [statusBaru, id], (err) => {
                
                if (action === 'approved') {
                    // 3. Kurangi saldo warga
                    db.query("UPDATE users SET saldo = saldo - ? WHERE id = ?", [data.jumlah, data.user_id], (err) => {
                        // 4. Catat ke Jurnal Kas (Kredit/Uang Keluar)
                        db.query("INSERT INTO jurnal_kas (keterangan, kredit, kategori) VALUES (?, ?, 'Tarik Tunai')", 
                        [`Tarik Tunai Warga: ${data.user_id}`, data.jumlah], (err) => {
                            db.commit(() => res.json({ message: "Berhasil disetujui" }));
                        });
                    });
                } else {
                    db.commit(() => res.json({ message: "Pengajuan ditolak" }));
                }
            });
        });
    });
});
// 1. Warga mengajukan setoran/tarikan simpanan
app.post('/api/savings/request', authenticateToken, (req, res) => {
    const { jumlah, tipe, keterangan } = req.body;
    const sql = "INSERT INTO savings (user_id, jumlah, tipe, keterangan) VALUES (?, ?, ?, ?)";

    db.query(sql, [req.user.id, jumlah, tipe, keterangan], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: `Permintaan ${tipe} berhasil dikirim. Menunggu verifikasi admin.` });
    });
});

// 2. Ambil riwayat simpanan saya
app.get('/api/savings/my', authenticateToken, (req, res) => {
    const sql = "SELECT * FROM savings WHERE user_id = ? ORDER BY tgl_transaksi DESC";

    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("Database Error:", err);
            return res.status(500).json({ error: "Gagal mengambil data" });
        }
        res.json(results);
    });
});

// 1. Ambil semua permintaan simpanan yang masih pending
app.get('/api/admin/savings/all', authenticateToken, isAdmin, (req, res) => {
    const sql = `
        SELECT s.*, u.nama 
        FROM savings s 
        JOIN users u ON s.user_id = u.id 
        ORDER BY s.tgl_transaksi DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: "Gagal mengambil laporan" });
        }
        res.json(results);
    });
});
// ENDPOINT: BUAT PEMBAYARAN (Tanpa insert ke savings dulu)
// Di file backend Anda (misal: server.js)
app.post('/api/payments/midtrans', authenticateToken, async (req, res) => {
    const { amount, keterangan } = req.body;
    const orderId = 'SETOR-' + Date.now();

    try {
        const [userRows] = await db.promise().query('SELECT nama, email FROM users WHERE id = ?', [req.user.id]);
        const user = userRows[0];

        const parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: parseInt(amount)
            },
            // --- TAMBAHKAN INI AGAR MUNCUL DI DETAIL ORDER MIDTRANS ---
            item_details: [{
                id: 'ITEM1',
                price: parseInt(amount),
                quantity: 1,
                name: keterangan || "Setoran Simpanan Desa" // Teks ini yang akan muncul di HP warga
            }],
            customer_details: {
                first_name: user.nama,
                email: user.email
            },
            // Tetap gunakan custom_field untuk kebutuhan Webhook ke database nanti
            custom_field1: req.user.id,
            custom_field2: keterangan || "Setoran Simpanan Desa"
        };

        const transaction = await snap.createTransaction(parameter);
        res.json({ snapToken: transaction.token });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal membuat sesi pembayaran" });
    }
});

app.post('/api/midtrans/webhook', (req, res) => {
    const notif = req.body;

    /* ===============================
       1. VERIFIKASI SIGNATURE
    =============================== */
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const combinedString =
        notif.order_id +
        notif.status_code +
        notif.gross_amount +
        serverKey;

    const localSignature = crypto
        .createHash('sha512')
        .update(combinedString)
        .digest('hex');

    if (localSignature !== notif.signature_key) {
        return res.status(401).json({ message: "Invalid Signature" });
    }

    /* ===============================
       2. CEK STATUS TRANSAKSI
    =============================== */
    if (
        notif.transaction_status !== 'settlement' &&
        notif.transaction_status !== 'capture'
    ) {
        return res.status(200).send('OK');
    }

    const userId = notif.custom_field1;
    const amount = parseInt(notif.gross_amount);
    const ket = notif.custom_field2 || "Setoran Online";
    const adminId = 1;

    /* ===============================
       3. CEGAH WEBHOOK DOBEL (IDEMPOTENT)
    =============================== */
    db.query(
        "SELECT id FROM savings WHERE keterangan LIKE ?",
        [`%${notif.order_id}%`],
        (err, rows) => {
            if (err) return res.sendStatus(500);
            if (rows.length > 0) {
                console.log("⚠️ Webhook duplikat:", notif.order_id);
                return res.status(200).send('OK');
            }

            /* ===============================
               4. MULAI TRANSAKSI DB
            =============================== */
            db.beginTransaction((err) => {
                if (err) return res.sendStatus(500);

                /* A. SIMPAN RIWAYAT SIMPANAN */
                db.query(
                    `INSERT INTO savings 
                     (user_id, jumlah, tipe, status, keterangan, tgl_transaksi) 
                     VALUES (?, ?, 'setor', 'approved', ?, NOW())`,
                    [userId, amount, `${ket} (${notif.order_id})`],
                    (err) => {
                        if (err) return db.rollback(() => res.sendStatus(500));

                        /* B. UPDATE SALDO USER */
                        db.query(
                            "UPDATE users SET saldo = saldo + ? WHERE id = ?",
                            [amount, userId],
                            (err) => {
                                if (err) return db.rollback(() => res.sendStatus(500));

                                /* D. AMBIL NAMA USER */
                                db.query(
                                    "SELECT nama FROM users WHERE id = ?",
                                    [userId],
                                    (err, rows) => {
                                        if (err || !rows.length) {
                                            return db.rollback(() => res.sendStatus(500));
                                        }

                                        const namaUser = rows[0].nama;

                                        /* E. CATAT JURNAL KAS */
                                        const deskripsiKas =
                                            `Top Up Simpanan via Midtrans: ${notif.order_id} - ${namaUser} (ID: ${userId})`;

                                        db.query(
                                            `INSERT INTO jurnal_kas
                                                     (keterangan, debet, kredit, kategori)
                                                     VALUES (?, ?, 0, 'simpanan')`,
                                            [deskripsiKas, amount],
                                            (err) => {
                                                if (err) {
                                                    console.error("Gagal jurnal kas:", err.message);
                                                    return db.rollback(() => res.sendStatus(500));
                                                }

                                                /* ===============================
                                                   5. COMMIT
                                                =============================== */
                                                db.commit((err) => {
                                                    if (err) {
                                                        return db.rollback(() => res.sendStatus(500));
                                                    }

                                                    console.log(
                                                        `✅ Midtrans OK | User: ${namaUser} | +Rp${amount}`
                                                    );
                                                    res.status(200).send('OK');
                                                });
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            }
            );
        });
}
);

// Endpoint Laporan Kas (Gaya Callback)
app.get('/api/admin/laporan-kas', authenticateToken, isAdmin, (req, res) => {
    // 1. Ambil Ringkasan Total Masuk & Keluar
    const sqlSummary = "SELECT SUM(debet) as total_masuk, SUM(kredit) as total_keluar FROM jurnal_kas";

    db.query(sqlSummary, (err, summaryResults) => {
        if (err) return res.status(500).json({ error: err.message });

        // 2. Ambil 50 Transaksi Terbaru
        const sqlJurnal = "SELECT * FROM jurnal_kas ORDER BY tgl DESC LIMIT 50";
        db.query(sqlJurnal, (err, jurnalResults) => {
            if (err) return res.status(500).json({ error: err.message });

            res.json({
                status: "success",
                summary: summaryResults[0],
                data: jurnalResults
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server BUMDes berjalan di http://localhost:${PORT}`);
});
