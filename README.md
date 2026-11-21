# Kedai Rindang · Pesan dari Meja

Web pemesanan & pembayaran lewat QR di setiap meja untuk coffee shop / tempat makan.
Pelanggan scan QR → lihat menu → pesan → bayar (QRIS atau di kasir) → pantau status pesanan.
Staf memakai dashboard kasir, layar dapur, pengaturan QR meja, serta menu & stok.

- Produksi: https://kedai-rindang-nine.vercel.app
- Halaman staf: https://kedai-rindang-nine.vercel.app/staf
- Link pelanggan: `https://<domain>/m/<token-meja>` (ada di kartu QR tiap meja)

## Alur singkat

1. Pelanggan scan QR meja → `/m/<token>`; token acak per meja, bisa diganti dari dashboard.
2. Checkout → server menghitung ulang harga dari database (harga dari browser diabaikan), menambah service 5% dan PB1 10%.
3. Status pesanan: `menunggu_bayar → antri → diproses → siap → selesai` (atau `batal`).
4. Dapur hanya melihat pesanan yang **sudah lunas**.
5. Pesanan tunai yang tidak dibayar dalam 30 menit dibatalkan otomatis; QRIS dinamis berlaku 10 menit.

## Struktur

| Path | Isi |
| --- | --- |
| `index.html`, `app.css`, `app.js` | Frontend (tanpa framework, tanpa build step) |
| `api/index.js` | Satu Vercel Function untuk semua API (`POST /api` dengan `{op, ...}`) |
| `vercel.json` | Rewrite `/m/:token` & `/staf`, header keamanan + CSP |
| `dev/server.mjs` | Server lokal yang meniru Vercel |
| `dev/apitest.mjs` | 36 tes API & keamanan |

Tabel database dibuat otomatis saat request pertama (`migrate()` di `api/index.js`), termasuk 15 menu contoh dan 8 meja.

## Environment variables (Vercel → Settings → Environment Variables)

| Nama | Wajib | Keterangan |
| --- | --- | --- |
| `DATABASE_URL` | ya | Otomatis dari integrasi Neon (Postgres) |
| `STAFF_PASSWORD` | ya | Password dashboard staf, minimal 8 karakter. Ganti = semua sesi staf keluar |
| `DEMO_PAYMENTS` | tidak | `1` = tombol simulasi QRIS aktif. Hapus setelah payment gateway tersambung |

Setelah mengubah env var, lakukan **Redeploy** agar nilainya terbaca.

## Menjalankan lokal

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/kedai STAFF_PASSWORD=uji-coba-123 DEMO_PAYMENTS=1 node dev/server.mjs
# buka http://localhost:3000/staf
# tes API (database kosong): STAFF_PASSWORD=uji-coba-123 node dev/apitest.mjs
```

## Keamanan yang sudah diterapkan

- Harga & total dihitung ulang di server; `CHECK (total = subtotal + service + tax)` di database.
- Status lunas tidak bisa diset dari HP pelanggan (kecuali mode demo `DEMO_PAYMENTS=1`, hanya untuk pesanan miliknya sendiri).
- Token meja acak 12 karakter, bisa diganti (QR lama langsung mati).
- Dashboard staf wajib login; cookie `HttpOnly; Secure; SameSite=Strict`, sesi 12 jam; login dikunci 15 menit setelah 5 kali salah.
- Idempotency key (klik ganda = 1 pesanan), 1 pesanan belum bayar per perangkat, rate limit 8 pesanan / 10 menit per IP.
- Transisi status divalidasi di server; pesanan lunas tidak bisa dibatalkan.
- Semua output di-escape (anti-XSS) + Content-Security-Policy tanpa script inline.
- `audit_log` untuk login, terima tunai, ubah harga, ganti foto, ganti QR, dan pembatalan.

## Belum ada (lihat dokumen rancangan)

- Integrasi payment gateway sungguhan (Midtrans/Xendit) + webhook bertanda tangan.
- Akun per staf & peran (kasir/dapur/owner), PIN supervisor untuk void.
- Laporan & ekspor Excel, struk thermal, shift kas, multi-outlet.
- Realtime memakai polling 3–4 detik; untuk banyak outlet pertimbangkan WebSocket.
