// Kedai Rindang — satu Vercel Function untuk seluruh API.
// Pelanggan: lihat menu dari QR meja, pesan, bayar, pantau status.
// Staf (wajib login): papan pesanan, dapur, menu & stok, QR meja.
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;
const TAX_RATE = 0.10;          // PB1
const SERVICE_RATE = 0.05;      // service charge
const QR_TTL_MIN = 10;          // masa berlaku QRIS dinamis
const CASH_TTL_MIN = 30;        // pesanan tunai belum dibayar dibatalkan otomatis
const MAX_QTY = 20;
const SESSION_HOURS = 12;

const DEFAULT_MENU = [
  ["m01","Espresso","Kopi",18000,"Satu shot, house blend Gayo–Toraja"],
  ["m02","Americano","Kopi",22000,"Espresso dan air panas atau es"],
  ["m03","Kopi Susu Gula Aren","Kopi",25000,"Andalan kedai, susu segar dan aren cair"],
  ["m04","Cappuccino","Kopi",28000,"Foam tebal, panas"],
  ["m05","Caffe Latte","Kopi",28000,"Panas atau es"],
  ["m06","V60 Single Origin","Kopi",32000,"Seduh manual, tanya barista bean hari ini"],
  ["m07","Matcha Latte","Non-Kopi",30000,"Matcha Uji dengan susu segar"],
  ["m08","Cokelat","Non-Kopi",27000,"Cokelat Bali, panas atau es"],
  ["m09","Teh Leci","Non-Kopi",22000,"Teh hitam, sirup leci, buah leci"],
  ["m10","Nasi Goreng Kampung","Makanan",35000,"Telur mata sapi, kerupuk, acar"],
  ["m11","Mie Goreng Jawa","Makanan",32000,"Mie telur, sayur, ayam suwir"],
  ["m12","Roti Bakar Srikaya","Makanan",20000,"Roti tebal, srikaya pandan, mentega"],
  ["m13","Pisang Goreng Keju","Camilan",18000,"Lima potong, keju dan susu kental"],
  ["m14","Kentang Goreng","Camilan",22000,"Saus sambal dan mayones"],
  ["m15","Croissant Butter","Camilan",24000,"Dipanggang pagi ini"]
];
const DEFAULT_TABLES = [
  ["Meja 01","Indoor"],["Meja 02","Indoor"],["Meja 03","Indoor"],["Meja 04","Indoor"],
  ["Meja 05","Teras"],["Meja 06","Teras"],["Meja 07","Teras"],["Bar 01","Bar"]
];

/* ---------------- infrastruktur ---------------- */
let pool = null;
function db() {
  if (!process.env.DATABASE_URL) throw fail(503, "Database belum tersambung. Pasang Neon di Vercel dan hubungkan ke project ini, lalu deploy ulang.");
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10000 });
  return pool;
}
function fail(status, message, extra) { const e = new Error(message); e.status = status; e.expose = true; if (extra) e.extra = extra; return e; }
const token = (n = 9) => crypto.randomBytes(n).toString("base64url");
const q = (text, params) => db().query(text, params);
async function tx(fn) {
  const c = await db().connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; }
  finally { c.release(); }
}

let readyP = null;
function ready() {
  if (!readyP) readyP = migrate().catch(e => { readyP = null; throw e; });
  return readyP;
}
async function migrate() {
  await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(820417)");
    await c.query(`
      CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);
      CREATE TABLE IF NOT EXISTS dining_tables (
        id text PRIMARY KEY, name text NOT NULL, area text, qr_token text NOT NULL UNIQUE,
        active boolean NOT NULL DEFAULT true, sort integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS menu_items (
        id text PRIMARY KEY, name text NOT NULL, cat text NOT NULL, price integer NOT NULL CHECK (price > 0),
        descr text, available boolean NOT NULL DEFAULT true, sort integer NOT NULL DEFAULT 0,
        photo text, photo_ver integer NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL,
        table_id text NOT NULL REFERENCES dining_tables(id), table_name text NOT NULL,
        customer_name text, note text,
        subtotal integer NOT NULL, service integer NOT NULL, tax integer NOT NULL,
        total integer NOT NULL CHECK (total = subtotal + service + tax),
        pay_method text NOT NULL CHECK (pay_method IN ('qris','tunai')),
        pay_status text NOT NULL DEFAULT 'unpaid',
        status text NOT NULL DEFAULT 'menunggu_bayar' CHECK (status IN ('menunggu_bayar','antri','diproses','siap','selesai','batal')),
        device_session text NOT NULL, idem text NOT NULL UNIQUE, ip_hash text,
        pay_ref text, cancelled_by text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        paid_at timestamptz, expires_at timestamptz);
      CREATE INDEX IF NOT EXISTS orders_board ON orders (created_at DESC);
      CREATE INDEX IF NOT EXISTS orders_session ON orders (device_session, created_at DESC);
      CREATE TABLE IF NOT EXISTS order_items (
        id bigserial PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
        menu_id text NOT NULL, name text NOT NULL, price integer NOT NULL,
        qty smallint NOT NULL CHECK (qty BETWEEN 1 AND 20));
      CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);
      CREATE TABLE IF NOT EXISTS waiter_calls (
        table_id text PRIMARY KEY REFERENCES dining_tables(id), table_name text NOT NULL,
        active boolean NOT NULL DEFAULT true, at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS audit_log (
        id bigserial PRIMARY KEY, action text NOT NULL, entity_id text, detail jsonb, ip_hash text,
        at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip_hash text PRIMARY KEY, fails integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now());
    `);
    const { rows: [m] } = await c.query("SELECT count(*)::int AS n FROM menu_items");
    if (m.n === 0) {
      let i = 0;
      for (const [id, name, cat, price, descr] of DEFAULT_MENU)
        await c.query("INSERT INTO menu_items (id,name,cat,price,descr,sort) VALUES ($1,$2,$3,$4,$5,$6)", [id, name, cat, price, descr, i++]);
    }
    const { rows: [t] } = await c.query("SELECT count(*)::int AS n FROM dining_tables");
    if (t.n === 0) {
      let i = 0;
      for (const [name, area] of DEFAULT_TABLES)
        await c.query("INSERT INTO dining_tables (id,name,area,qr_token,sort) VALUES ($1,$2,$3,$4,$5)", ["t" + token(6), name, area, token(9), i++]);
    }
    await c.query("INSERT INTO settings (key,value) VALUES ('brand','Kedai Rindang') ON CONFLICT DO NOTHING");
  });
}

/* ---------------- helpers ---------------- */
function ipHash(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  return crypto.createHash("sha256").update("kr-ip:" + ip).digest("hex").slice(0, 24);
}
function str(v, max, field) {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) throw fail(400, `${field} terlalu panjang (maks. ${max} karakter).`);
  return s;
}
function need(re, v, msg) { if (typeof v !== "string" || !re.test(v)) throw fail(400, msg); return v; }
const RE_SESSION = /^[A-Za-z0-9_-]{16,64}$/;
const RE_TOKEN = /^[A-Za-z0-9_-]{6,40}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_ID = /^[A-Za-z0-9_-]{2,40}$/;
const ms = d => (d ? new Date(d).getTime() : null);
const demoPay = () => process.env.DEMO_PAYMENTS === "1";
const brand = async () => (await q("SELECT value FROM settings WHERE key='brand'")).rows[0]?.value || "Kedai";

function menuOut(r) {
  return { id: r.id, name: r.name, cat: r.cat, price: r.price, desc: r.descr || "", available: r.available,
    photoUrl: r.has_photo ? `/api?photo=${encodeURIComponent(r.id)}&v=${r.photo_ver}` : null };
}
const MENU_SQL = "SELECT id,name,cat,price,descr,available,sort,photo_ver,(photo IS NOT NULL AND photo <> '') AS has_photo FROM menu_items ORDER BY sort, name";

async function loadOrders(where, params, limit = 300) {
  const { rows } = await q(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`, params);
  if (!rows.length) return [];
  const { rows: items } = await q("SELECT order_id, menu_id, name, price, qty FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY id", [rows.map(r => r.id)]);
  const by = new Map(rows.map(r => [r.id, []]));
  for (const i of items) by.get(i.order_id)?.push({ menuId: i.menu_id, name: i.name, price: i.price, qty: i.qty });
  return rows.map(r => ({
    id: r.id, code: r.code, tableId: r.table_id, tableName: r.table_name,
    customerName: r.customer_name || "", note: r.note || "",
    subtotal: r.subtotal, service: r.service, tax: r.tax, total: r.total,
    payMethod: r.pay_method, payStatus: r.pay_status, status: r.status, payRef: r.pay_ref || "",
    cancelledBy: r.cancelled_by || "",
    createdAt: ms(r.created_at), paidAt: ms(r.paid_at), expiresAt: ms(r.expires_at), items: by.get(r.id) || []
  }));
}
async function tableByToken(tok) {
  need(RE_TOKEN, tok, "Kode QR tidak valid.");
  const { rows: [t] } = await q("SELECT id,name,area FROM dining_tables WHERE qr_token=$1 AND active", [tok]);
  if (!t) throw fail(404, "QR tidak dikenali. Minta bantuan kasir, dan jangan membayar ke QR lain.");
  return t;
}
async function audit(req, action, entityId, detail) {
  await q("INSERT INTO audit_log (action, entity_id, detail, ip_hash) VALUES ($1,$2,$3,$4)", [action, entityId || null, detail ? JSON.stringify(detail) : null, ipHash(req)]);
}

/* ---------------- sesi staf ---------------- */
function staffPassword() {
  const p = process.env.STAFF_PASSWORD || "";
  if (p.length < 8) throw fail(503, "Password staf belum diatur. Tambahkan STAFF_PASSWORD (minimal 8 karakter) di Environment Variables Vercel, lalu deploy ulang.");
  return p;
}
const sessKey = () => crypto.createHash("sha256").update("kr-session:" + (process.env.STAFF_PASSWORD || "") + ":" + (process.env.DATABASE_URL || "")).digest();
function signSession(exp) { const p = String(exp); return p + "." + crypto.createHmac("sha256", sessKey()).update(p).digest("base64url"); }
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function isStaff(req) {
  if ((process.env.STAFF_PASSWORD || "").length < 8) return false;
  const tok = readCookie(req, "kr_staff"); if (!tok) return false;
  const [p, mac] = tok.split("."); if (!p || !mac) return false;
  if (!(Number(p) > Date.now())) return false;
  const good = Buffer.from(crypto.createHmac("sha256", sessKey()).update(p).digest("base64url"));
  const got = Buffer.from(mac);
  return got.length === good.length && crypto.timingSafeEqual(got, good);
}
function setSessionCookie(res, value, maxAge) {
  res.setHeader("Set-Cookie", `kr_staff=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

/* ---------------- operasi publik (pelanggan) ---------------- */
const PUBLIC = {
  async table(b) {
    const t = await tableByToken(b.token);
    const { rows } = await q(MENU_SQL);
    return { table: t, brand: await brand(), demoPay: demoPay(), menu: rows.map(menuOut) };
  },

  async order(b, req) {
    const t = await tableByToken(b.token);
    const session = need(RE_SESSION, b.session, "Sesi tidak valid. Muat ulang halaman.");
    const idem = need(/^[A-Za-z0-9_-]{8,64}$/, b.idem, "Permintaan tidak valid.");
    const pay = b.pay === "tunai" ? "tunai" : b.pay === "qris" ? "qris" : null;
    if (!pay) throw fail(400, "Pilih cara bayar.");
    if (pay === "qris" && !demoPay()) throw fail(400, "Pembayaran QRIS belum aktif. Pilih bayar di kasir.");
    const name = str(b.name, 40, "Nama"), note = str(b.note, 200, "Catatan");
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw fail(400, "Keranjang kosong atau terlalu banyak item.");
    const want = new Map();
    for (const it of b.items) {
      const id = need(RE_ID, it && it.menuId, "Item tidak valid.");
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1) throw fail(400, "Jumlah item tidak valid.");
      want.set(id, Math.min(MAX_QTY, (want.get(id) || 0) + qty));
    }
    const ip = ipHash(req);
    return await tx(async c => {
      const { rows: [dupe] } = await c.query("SELECT id FROM orders WHERE idem=$1", [idem]);
      if (dupe) return { order: (await loadOrders("id=$1", [dupe.id]))[0] };
      const { rows: [pending] } = await c.query(
        `SELECT id, code FROM orders WHERE device_session=$1 AND status='menunggu_bayar'
           AND ((pay_method='qris' AND expires_at > now()) OR (pay_method='tunai' AND created_at > now() - interval '${CASH_TTL_MIN} minutes'))
         LIMIT 1`, [session]);
      if (pending) throw fail(409, `Selesaikan dulu pembayaran pesanan ${pending.code}.`, { orderId: pending.id });
      const { rows: [rate] } = await c.query("SELECT count(*)::int AS n FROM orders WHERE ip_hash=$1 AND created_at > now() - interval '10 minutes'", [ip]);
      if (rate.n >= 8) throw fail(429, "Terlalu banyak pesanan dari perangkat ini. Tunggu beberapa menit atau pesan di kasir.");
      const { rows: menu } = await c.query("SELECT id,name,price,available FROM menu_items WHERE id = ANY($1::text[])", [[...want.keys()]]);
      const byId = new Map(menu.map(m => [m.id, m]));
      const items = [];
      for (const [id, qty] of want) {
        const m = byId.get(id);
        if (!m) throw fail(409, "Ada menu yang sudah tidak tersedia. Muat ulang menu.", { refresh: true });
        if (!m.available) throw fail(409, `${m.name} baru saja habis. Hapus dari keranjang dulu.`, { refresh: true });
        items.push({ id, name: m.name, price: m.price, qty });
      }
      const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
      const service = Math.round(subtotal * SERVICE_RATE);
      const tax = Math.round((subtotal + service) * TAX_RATE);
      const total = subtotal + service + tax;
      const prefix = (t.area || "A").trim().charAt(0).toUpperCase() || "A";
      let code = null;
      for (let k = 0; k < 6 && !code; k++) {
        const cand = prefix + "-" + crypto.randomInt(100, 1000);
        const { rows: [x] } = await c.query("SELECT 1 FROM orders WHERE code=$1 AND created_at > now() - interval '18 hours'", [cand]);
        if (!x) code = cand;
      }
      code = code || prefix + "-" + crypto.randomInt(1000, 10000);
      const { rows: [o] } = await c.query(
        `INSERT INTO orders (code, table_id, table_name, customer_name, note, subtotal, service, tax, total, pay_method,
           device_session, idem, ip_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $10='qris' THEN now() + interval '${QR_TTL_MIN} minutes' END)
         RETURNING id`,
        [code, t.id, t.name, name || null, note || null, subtotal, service, tax, total, pay, session, idem, ip]);
      for (const i of items)
        await c.query("INSERT INTO order_items (order_id, menu_id, name, price, qty) VALUES ($1,$2,$3,$4,$5)", [o.id, i.id, i.name, i.price, i.qty]);
      return { orderId: o.id };
    }).then(async r => r.order ? r : { order: (await loadOrders("id=$1", [r.orderId]))[0] });
  },

  async mine(b) {
    const t = await tableByToken(b.token);
    const session = need(RE_SESSION, b.session, "Sesi tidak valid.");
    return { orders: await loadOrders("device_session=$1 AND table_id=$2 AND created_at > now() - interval '24 hours'", [session, t.id], 20) };
  },

  async cancel(b) {
    const session = need(RE_SESSION, b.session, "Sesi tidak valid.");
    const id = need(RE_UUID, b.id, "Pesanan tidak valid.");
    const { rowCount } = await q("UPDATE orders SET status='batal', cancelled_by='pelanggan', updated_at=now() WHERE id=$1 AND device_session=$2 AND status='menunggu_bayar'", [id, session]);
    if (!rowCount) throw fail(409, "Pesanan ini sudah dibayar atau sudah dibatalkan.");
    return { ok: true };
  },

  async simpay(b) {
    if (!demoPay()) throw fail(403, "Simulasi pembayaran dimatikan.");
    const session = need(RE_SESSION, b.session, "Sesi tidak valid.");
    const id = need(RE_UUID, b.id, "Pesanan tidak valid.");
    const { rowCount } = await q(
      `UPDATE orders SET pay_status='paid', status='antri', paid_at=now(), updated_at=now(), pay_ref=$3
        WHERE id=$1 AND device_session=$2 AND status='menunggu_bayar' AND pay_method='qris' AND expires_at > now()`,
      [id, session, "SIM-QRIS-" + token(6).toUpperCase()]);
    if (!rowCount) throw fail(409, "QR sudah kedaluwarsa atau pesanan sudah diproses.");
    return { ok: true };
  },

  async renew(b) {
    const session = need(RE_SESSION, b.session, "Sesi tidak valid.");
    const id = need(RE_UUID, b.id, "Pesanan tidak valid.");
    const { rowCount } = await q(
      `UPDATE orders SET expires_at = now() + interval '${QR_TTL_MIN} minutes', updated_at=now()
        WHERE id=$1 AND device_session=$2 AND status='menunggu_bayar' AND pay_method='qris'`, [id, session]);
    if (!rowCount) throw fail(409, "Pesanan ini tidak menunggu pembayaran.");
    return { ok: true };
  },

  async call(b) {
    const t = await tableByToken(b.token);
    await q(`INSERT INTO waiter_calls (table_id, table_name, active, at) VALUES ($1,$2,true,now())
             ON CONFLICT (table_id) DO UPDATE SET active=true, at=now(), table_name=EXCLUDED.table_name
             WHERE waiter_calls.active=false OR waiter_calls.at < now() - interval '60 seconds'`, [t.id, t.name]);
    return { ok: true };
  },

  async me(b, req) { return { staff: isStaff(req) }; },

  async login(b, req, res) {
    const pw = staffPassword();
    const ip = ipHash(req);
    const { rows: [a] } = await q("SELECT fails, window_start > now() - interval '15 minutes' AS recent FROM login_attempts WHERE ip_hash=$1", [ip]);
    if (a && a.recent && a.fails >= 5) throw fail(429, "Terlalu banyak percobaan. Coba lagi 15 menit lagi.");
    const given = crypto.createHash("sha256").update(String(b.password || "")).digest();
    const real = crypto.createHash("sha256").update(pw).digest();
    if (!crypto.timingSafeEqual(given, real)) {
      await q(`INSERT INTO login_attempts (ip_hash, fails, window_start) VALUES ($1,1,now())
               ON CONFLICT (ip_hash) DO UPDATE SET
                 fails = CASE WHEN login_attempts.window_start > now() - interval '15 minutes' THEN login_attempts.fails + 1 ELSE 1 END,
                 window_start = CASE WHEN login_attempts.window_start > now() - interval '15 minutes' THEN login_attempts.window_start ELSE now() END`, [ip]);
      await audit(req, "login_gagal");
      throw fail(401, "Password salah.");
    }
    await q("DELETE FROM login_attempts WHERE ip_hash=$1", [ip]);
    setSessionCookie(res, signSession(Date.now() + SESSION_HOURS * 3600e3), SESSION_HOURS * 3600);
    await audit(req, "login");
    return { staff: true };
  },

  async logout(b, req, res) { setSessionCookie(res, "", 0); return { staff: false }; }
};

/* ---------------- operasi staf ---------------- */
const NEXT = { diproses: ["antri"], siap: ["diproses"], selesai: ["siap"], batal: ["menunggu_bayar"] };
const STAFF = {
  async board() {
    await q(`UPDATE orders SET status='batal', cancelled_by='sistem', updated_at=now()
              WHERE status='menunggu_bayar' AND pay_method='tunai' AND created_at < now() - interval '${CASH_TTL_MIN} minutes'`);
    const orders = await loadOrders("created_at > now() - interval '24 hours' OR status IN ('antri','diproses','siap')", []);
    const { rows: calls } = await q("SELECT table_id, table_name, at FROM waiter_calls WHERE active ORDER BY at");
    return { orders, calls: calls.map(c => ({ tableId: c.table_id, tableName: c.table_name, at: ms(c.at) })), brand: await brand(), demoPay: demoPay() };
  },
  async status(b, req) {
    const id = need(RE_UUID, b.id, "Pesanan tidak valid.");
    if (typeof b.to !== "string" || !Object.hasOwn(NEXT, b.to)) throw fail(400, "Status tidak valid.");
    const from = NEXT[b.to];
    const { rows: [o] } = await q(
      `UPDATE orders SET status=$2, updated_at=now(), cancelled_by = CASE WHEN $2='batal' THEN 'kasir' ELSE cancelled_by END
        WHERE id=$1 AND status = ANY($3::text[]) RETURNING code`, [id, b.to, from]);
    if (!o) throw fail(409, "Status pesanan sudah berubah. Daftar dimuat ulang.");
    await audit(req, "status_" + b.to, id, { code: o.code });
    return { ok: true };
  },
  async cashpaid(b, req) {
    const id = need(RE_UUID, b.id, "Pesanan tidak valid.");
    const { rows: [o] } = await q(
      `UPDATE orders SET pay_status='paid', status='antri', paid_at=now(), updated_at=now(), pay_ref='TUNAI'
        WHERE id=$1 AND status='menunggu_bayar' AND pay_method='tunai' RETURNING code, total`, [id]);
    if (!o) throw fail(409, "Pesanan ini sudah dibayar atau dibatalkan.");
    await audit(req, "terima_tunai", id, { code: o.code, total: o.total });
    return { ok: true };
  },
  async resolveCall(b) {
    const id = need(RE_ID, b.id, "Meja tidak valid.");
    await q("UPDATE waiter_calls SET active=false WHERE table_id=$1", [id]);
    return { ok: true };
  },
  async menuAll() { const { rows } = await q(MENU_SQL); return { menu: rows.map(menuOut) }; },
  async menuUpdate(b, req) {
    const id = need(RE_ID, b.id, "Menu tidak valid.");
    if (b.price !== undefined) {
      const p = Number(b.price);
      if (!Number.isInteger(p) || p < 1000 || p > 1000000) throw fail(400, "Harga harus antara Rp1.000 dan Rp1.000.000.");
      const { rows: [old] } = await q("SELECT price FROM menu_items WHERE id=$1", [id]);
      if (!old) throw fail(404, "Menu tidak ditemukan.");
      await q("UPDATE menu_items SET price=$2 WHERE id=$1", [id, p]);
      await audit(req, "ubah_harga", id, { dari: old.price, ke: p });
    }
    if (b.available !== undefined) {
      await q("UPDATE menu_items SET available=$2 WHERE id=$1", [id, !!b.available]);
      await audit(req, b.available ? "menu_tersedia" : "menu_habis", id);
    }
    return { ok: true };
  },
  async menuPhoto(b, req) {
    const id = need(RE_ID, b.id, "Menu tidak valid.");
    const d = typeof b.data === "string" ? b.data : "";
    const pre = "data:image/jpeg;base64,";
    if (!d.startsWith(pre) || d.length > 400000) throw fail(400, "Foto harus JPEG dan di bawah 300 KB.");
    const buf = Buffer.from(d.slice(pre.length), "base64");
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw fail(400, "File foto rusak atau bukan JPEG.");
    const { rowCount } = await q("UPDATE menu_items SET photo=$2, photo_ver=photo_ver+1 WHERE id=$1", [id, d]);
    if (!rowCount) throw fail(404, "Menu tidak ditemukan.");
    await audit(req, "ganti_foto", id);
    return { ok: true };
  },
  async menuResetPhoto(b, req) {
    const id = need(RE_ID, b.id, "Menu tidak valid.");
    await q("UPDATE menu_items SET photo=NULL, photo_ver=photo_ver+1 WHERE id=$1", [id]);
    await audit(req, "hapus_foto", id);
    return { ok: true };
  },
  async tables() {
    const { rows } = await q("SELECT id,name,area,qr_token FROM dining_tables WHERE active ORDER BY sort, name");
    return { tables: rows.map(r => ({ id: r.id, name: r.name, area: r.area || "", token: r.qr_token })) };
  },
  async tableAdd(b, req) {
    const { rows: [n] } = await q("SELECT count(*)::int AS n, coalesce(max(sort),0)+1 AS s FROM dining_tables WHERE active");
    const name = str(b.name, 30, "Nama meja") || "Meja " + String(n.n + 1).padStart(2, "0");
    const area = str(b.area, 20, "Area") || "Indoor";
    const id = "t" + token(6);
    await q("INSERT INTO dining_tables (id,name,area,qr_token,sort) VALUES ($1,$2,$3,$4,$5)", [id, name, area, token(9), n.s]);
    await audit(req, "tambah_meja", id, { name });
    return { ok: true };
  },
  async tableRotate(b, req) {
    const id = need(RE_ID, b.id, "Meja tidak valid.");
    const { rowCount } = await q("UPDATE dining_tables SET qr_token=$2 WHERE id=$1", [id, token(9)]);
    if (!rowCount) throw fail(404, "Meja tidak ditemukan.");
    await audit(req, "ganti_qr", id);
    return { ok: true };
  },
  async settingsSave(b, req) {
    const name = str(b.brand, 40, "Nama kedai");
    if (!name) throw fail(400, "Nama kedai wajib diisi.");
    await q("INSERT INTO settings (key,value) VALUES ('brand',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [name]);
    await audit(req, "ubah_nama", null, { name });
    return { ok: true };
  }
};

/* ---------------- foto menu (GET, bisa di-cache) ---------------- */
async function sendPhoto(req, res) {
  const id = String(req.query.photo || "");
  if (!RE_ID.test(id)) return res.status(400).end();
  await ready();
  const { rows: [r] } = await q("SELECT photo FROM menu_items WHERE id=$1", [id]);
  const pre = "data:image/jpeg;base64,";
  if (!r || !r.photo || !r.photo.startsWith(pre)) return res.status(404).end();
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).end(Buffer.from(r.photo.slice(pre.length), "base64"));
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method === "GET" && req.query && req.query.photo) return await sendPhoto(req, res);
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Gunakan POST." });
    if (!String(req.headers["content-type"] || "").includes("application/json")) return res.status(415).json({ error: "Body harus JSON." });
    await ready();
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const op = String(b.op || "");
    let fn = Object.hasOwn(PUBLIC, op) ? PUBLIC[op] : null;
    if (!fn && Object.hasOwn(STAFF, op)) {
      if (!isStaff(req)) return res.status(401).json({ error: "Sesi staf habis. Silakan masuk lagi.", code: "auth" });
      fn = STAFF[op];
    }
    if (!fn) return res.status(404).json({ error: "Operasi tidak dikenal." });
    const out = await fn(b, req, res);
    return res.status(200).json(out || { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && !e.expose) console.error(e);
    return res.status(status).json({ error: e.expose ? e.message : "Terjadi kesalahan di server. Coba lagi.", ...(e.extra || {}) });
  }
}
