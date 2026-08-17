const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const sessions = new Map();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname, { extensions: ["html"] }));

async function db(query, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(query, params);
  } finally {
    client.release();
  }
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is missing. The app cannot persist orders until a Postgres database is connected.");
    return;
  }

  await db(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      profit_usd NUMERIC(10,2) NOT NULL DEFAULT 5,
      ship_per_item_usd NUMERIC(10,2) NOT NULL DEFAULT 4,
      exchange_rate NUMERIC(12,2) NOT NULL DEFAULT 1310
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      governorate TEXT NOT NULL,
      address TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'طلب جديد',
      purchase_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
      profit_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
      expense_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
      shipping_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
      customer_total_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      size TEXT DEFAULT '',
      color TEXT DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 1,
      price_usd NUMERIC(10,2) NOT NULL DEFAULT 0
    );

    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_usd NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_total_usd NUMERIC(10,2) NOT NULL DEFAULT 0;
  `);
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "غير مصرح" });
  next();
}

function orderNo() {
  return "DARK-" + Date.now().toString().slice(-8) + "-" + Math.floor(10 + Math.random() * 90);
}

function clean(v, max = 1000) {
  return String(v ?? "").trim().slice(0, max);
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "customer.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/health", (req, res) => res.json({ ok: true, service: "DARK" }));

app.get("/api/settings", async (req, res) => {
  try {
    const r = await db("SELECT profit_usd AS profit, ship_per_item_usd AS \"shipPerItem\", exchange_rate AS rate FROM settings WHERE id=1");
    res.json(r.rows[0] || { profit: 5, shipPerItem: 4, rate: 1310 });
  } catch {
    res.status(500).json({ error: "تعذر تحميل الإعدادات" });
  }
});

app.post("/api/orders", async (req, res) => {
  const { name, phone, governorate, address, notes, items } = req.body || {};
  if (!clean(name) || !clean(phone) || !clean(governorate) || !clean(address)) {
    return res.status(400).json({ error: "يرجى إكمال بيانات الزبون" });
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    return res.status(400).json({ error: "أضف منتجاً واحداً على الأقل" });
  }

  const normalized = items.map(x => ({
    url: clean(x.url, 2000),
    size: clean(x.size, 100),
    color: clean(x.color, 100),
    qty: Math.max(1, Math.min(99, Number(x.qty) || 1)),
    price: Math.max(0, Number(x.price) || 0)
  })).filter(x => /^https?:\/\//i.test(x.url));

  if (!normalized.length) return res.status(400).json({ error: "تأكد من روابط المنتجات" });

  const settings = (await db("SELECT profit_usd AS profit, ship_per_item_usd AS \"shipPerItem\" FROM settings WHERE id=1")).rows[0];
  const productTotal = normalized.reduce((s, x) => s + x.price * x.qty, 0);
  const qtyTotal = normalized.reduce((s, x) => s + x.qty, 0);
  const shipping = qtyTotal * Number(settings?.shipPerItem || 0);
  const profit = Number(settings?.profit || 0);
  const customerTotal = productTotal + shipping + profit;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const no = orderNo();
    const o = await client.query(
      `INSERT INTO orders
       (order_no,name,phone,governorate,address,notes,profit_usd,shipping_usd,customer_total_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, order_no, created_at`,
      [no, clean(name), clean(phone), clean(governorate), clean(address, 2000), clean(notes, 2000), profit, shipping, customerTotal]
    );

    for (const item of normalized) {
      await client.query(
        `INSERT INTO order_items (order_id,url,size,color,qty,price_usd)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [o.rows[0].id, item.url, item.size, item.color, item.qty, item.price]
      );
    }
    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      orderNo: no,
      estimated: {
        products: Number(productTotal.toFixed(2)),
        shipping: Number(shipping.toFixed(2)),
        total: Number(customerTotal.toFixed(2))
      }
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "تعذر حفظ الطلب" });
  } finally {
    client.release();
  }
});

app.get("/api/orders/:orderNo", async (req, res) => {
  try {
    const r = await db(
      "SELECT order_no,status,created_at FROM orders WHERE order_no=$1",
      [clean(req.params.orderNo, 80)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "الطلب غير موجود" });
    res.json(r.rows[0]);
  } catch {
    res.status(500).json({ error: "تعذر تتبع الطلب" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "لم يتم تعيين كلمة مرور الأدمن في إعدادات السيرفر" });
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  setTimeout(() => sessions.delete(token), 1000 * 60 * 60 * 24 * 7);
  res.json({ token });
});

app.get("/api/admin/orders", auth, async (req, res) => {
  try {
    const orders = await db(`SELECT id,order_no,name,phone,governorate,address,notes,status,
      purchase_usd::float AS purchase_usd,profit_usd::float AS profit_usd,expense_usd::float AS expense_usd,
      shipping_usd::float AS shipping_usd,customer_total_usd::float AS customer_total_usd,
      created_at,updated_at FROM orders ORDER BY created_at DESC`);
    const result = [];
    for (const o of orders.rows) {
      const items = await db(`SELECT id,url,size,color,qty,price_usd::float AS price FROM order_items WHERE order_id=$1 ORDER BY id`, [o.id]);
      result.push({ ...o, items: items.rows });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "تعذر تحميل الطلبات" });
  }
});

app.put("/api/admin/settings", auth, async (req, res) => {
  const profit = Math.max(0, Number(req.body?.profit) || 0);
  const ship = Math.max(0, Number(req.body?.shipPerItem) || 0);
  const rate = Math.max(1, Number(req.body?.rate) || 1310);
  try {
    await db(`UPDATE settings SET profit_usd=$1,ship_per_item_usd=$2,exchange_rate=$3 WHERE id=1`, [profit, ship, rate]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "تعذر حفظ الإعدادات" });
  }
});

app.patch("/api/admin/orders/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = {};
  if (typeof req.body?.status === "string") allowed.status = clean(req.body.status, 50);
  if (req.body?.purchase_usd !== undefined) allowed.purchase_usd = Math.max(0, Number(req.body.purchase_usd) || 0);
  if (req.body?.profit_usd !== undefined) allowed.profit_usd = Math.max(0, Number(req.body.profit_usd) || 0);
  if (req.body?.expense_usd !== undefined) allowed.expense_usd = Math.max(0, Number(req.body.expense_usd) || 0);
  const keys = Object.keys(allowed);
  if (!keys.length) return res.status(400).json({ error: "لا توجد تغييرات" });

  const sets = [];
  const vals = [];
  for (const k of keys) {
    vals.push(allowed[k]);
    sets.push(`${k}=$${vals.length}`);
  }
  vals.push(id);
  try {
    const r = await db(`UPDATE orders SET ${sets.join(",")},updated_at=NOW() WHERE id=$${vals.length} RETURNING id`, vals);
    if (!r.rowCount) return res.status(404).json({ error: "الطلب غير موجود" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "تعذر تحديث الطلب" });
  }
});

initDb().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`DARK running on ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err);
  app.listen(PORT, "0.0.0.0", () => console.log(`DARK running on ${PORT} without DB`));
});
