
-- 1. Tabel User (Warga & Admin)
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nik VARCHAR(16) UNIQUE NOT NULL,
    nama VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    password VARCHAR(255) NOT NULL,
    alamat TEXT,
    no_hp VARCHAR(15),
    foto_ktp LONGTEXT,
    saldo DECIMAL(15,2) DEFAULT 0.00,
    role ENUM('warga', 'admin') DEFAULT 'warga',
    status_verifikasi ENUM('pending', 'verified', 'rejected') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabel Produk
CREATE TABLE products (
    id INT PRIMARY KEY AUTO_INCREMENT,
    nama_produk VARCHAR(150) NOT NULL,
    deskripsi TEXT,
    harga DECIMAL(12, 2) NOT NULL,
    stok INT NOT NULL,
    foto_produk LONGTEXT,
    kategori VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabel Simpan Pinjam
CREATE TABLE loans (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    jumlah_pinjaman DECIMAL(15, 2) NOT NULL,
    tenor_bulan INT NOT NULL,
    angsuran_bulanan DECIMAL(15, 2) NOT NULL,
    bunga_persen DECIMAL(5, 2) DEFAULT 1.00,
    tujuan TEXT, -- Tambahan: Untuk menyimpan alasan peminjaman
    status ENUM('pending', 'approved', 'rejected', 'lunas') DEFAULT 'pending',
    catatan_admin TEXT, -- Tambahan: Untuk alasan penolakan/instruksi admin
    tgl_pengajuan TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 4. Tabel Transaksi Belanja
CREATE TABLE orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    total_bayar DECIMAL(15, 2) NOT NULL,
    status_order ENUM('pending', 'diproses', 'dikirim', 'selesai') DEFAULT 'pending',
    tgl_transaksi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 5. Tabel Detail Item Belanja
CREATE TABLE order_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT,
    product_id INT,
    qty INT NOT NULL,
    subtotal DECIMAL(15, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 6. Tabel Riwayat Cicilan
CREATE TABLE repayments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    loan_id INT,
    user_id INT,
    jumlah_bayar DECIMAL(15, 2) NOT NULL,
    cicilan_ke INT NOT NULL,
    tgl_bayar TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (loan_id) REFERENCES loans(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 7. Tabel Riwayat Simpanan (Tabungan)
CREATE TABLE savings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    jumlah DECIMAL(15, 2) NOT NULL,
    tipe ENUM('setor', 'tarik') NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    keterangan TEXT,
    tgl_transaksi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    savings_id INT NULL,
    order_id VARCHAR(50) UNIQUE NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    payment_type VARCHAR(50),
    transaction_status ENUM(
        'pending',
        'settlement',
        'expire',
        'cancel',
        'deny',
        'failure'
    ) DEFAULT 'pending',
    transaction_time TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (savings_id) REFERENCES savings(id)
);
CREATE TABLE jurnal_kas (
    id INT PRIMARY KEY AUTO_INCREMENT,
    tgl TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    keterangan VARCHAR(255) NOT NULL,
    debet DECIMAL(15, 2) DEFAULT 0.00,  -- Uang Masuk
    kredit DECIMAL(15, 2) DEFAULT 0.00, -- Uang Keluar
    saldo_akhir DECIMAL(15, 2) DEFAULT 0.00,
    kategori ENUM('simpanan', 'pinjaman', 'angsuran', 'belanja', 'lainnya')
);