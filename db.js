'use strict';
// Database layer: schema + seed data. Uses Node's built-in SQLite (node:sqlite).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'darzi.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, mobile TEXT UNIQUE NOT NULL, email TEXT,
  role TEXT NOT NULL DEFAULT 'customer', status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS otps(mobile TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS otp_log(mobile TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS addresses(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT, line TEXT NOT NULL,
  landmark TEXT, pincode TEXT, lat REAL, lng REAL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, sizes TEXT NOT NULL, fields TEXT NOT NULL,
  fabric_m REAL NOT NULL DEFAULT 2, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS designs(
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'unisex', price INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '#d9cdb4',
  image_url TEXT, description TEXT, featured INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS fabrics(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, price_per_m INTEGER NOT NULL, cost_per_m INTEGER NOT NULL,
  colors TEXT NOT NULL, image_url TEXT, stock_m REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS measurements(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id), data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL, design_id INTEGER NOT NULL, PRIMARY KEY(user_id, design_id));
CREATE TABLE IF NOT EXISTS tailors(
  user_id INTEGER PRIMARY KEY REFERENCES users(id), address TEXT, shop_location TEXT, shop_lat REAL, shop_lng REAL,
  experience INTEGER, categories TEXT NOT NULL DEFAULT '[]', capacity INTEGER NOT NULL DEFAULT 3,
  bank_holder TEXT, bank_account TEXT, bank_ifsc TEXT, upi TEXT, portfolio TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'incomplete', admin_note TEXT);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER NOT NULL, design_id INTEGER NOT NULL, fabric_id INTEGER, fabric_own INTEGER NOT NULL DEFAULT 0,
  color TEXT, measure_mode TEXT NOT NULL, size TEXT, measurements TEXT, notes TEXT, ref_photos TEXT NOT NULL DEFAULT '[]',
  address TEXT NOT NULL, appt_date TEXT, appt_slot TEXT, appt_status TEXT, pickup_status TEXT NOT NULL DEFAULT 'Not required',
  status TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'unpaid',
  tailor_id INTEGER, tailor_status TEXT, assigned_at TEXT, deadline TEXT,
  stitching INTEGER NOT NULL, fabric_charge INTEGER NOT NULL, fabric_cost INTEGER NOT NULL, home_fee INTEGER NOT NULL,
  pickup_fee INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
  commission_pct REAL NOT NULL, commission INTEGER NOT NULL, tailor_payable INTEGER NOT NULL, platform_revenue INTEGER NOT NULL,
  fabric_m REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, cancelled_at TEXT, cancel_reason TEXT);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, status TEXT NOT NULL, note TEXT, by_user INTEGER, ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT,
  status TEXT NOT NULL, ref TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY, tailor_id INTEGER NOT NULL, amount INTEGER NOT NULL, note TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tailor_rejections(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, tailor_id INTEGER NOT NULL, reason TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY, order_id INTEGER UNIQUE NOT NULL, user_id INTEGER NOT NULL, tailor_id INTEGER NOT NULL,
  rating INTEGER NOT NULL, text TEXT, photos TEXT NOT NULL DEFAULT '[]', ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS complaints(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', resolution TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL, order_id INTEGER, read INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_tailor ON orders(tailor_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
`);

const DEFAULT_SETTINGS = {
  brand: 'Darzi',
  home_fee: 180,            // home measurement fee (Rs 150-200 suggested)
  pickup_fee: 60,           // fabric pickup when customer brings own fabric
  delivery_base: 40,        // flat delivery charge within free radius
  delivery_free_km: 3,      // km covered by the base charge
  delivery_per_km: 8,       // Rs per extra km
  commission_pct: 15,       // platform commission on stitching charge
  stitch_days: 7,           // default deadline after tailor accepts
  service_radius_km: 35,    // service area radius from hub
  hub_name: 'Connaught Place, Delhi',
  hub_lat: 28.6315, hub_lng: 77.2167,
  slots: ['10:00 - 12:00', '12:00 - 14:00', '14:00 - 16:00', '16:00 - 18:00'],
  appt_capacity: 3          // home measurements per slot per day
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, JSON.stringify(v));

function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM categories').get().n) return;
  const J = JSON.stringify;
  const cat = db.prepare('INSERT INTO categories(slug,name,sizes,fields,fabric_m,sort) VALUES(?,?,?,?,?,?)');
  const std = ['S', 'M', 'L', 'XL', 'XXL'];
  const cats = [
    ['shirts', 'Shirts', std, ['Neck', 'Chest', 'Waist', 'Shoulder', 'Sleeve length', 'Shirt length'], 2.0],
    ['pants', 'Pants', ['28', '30', '32', '34', '36', '38'], ['Waist', 'Hip', 'Thigh', 'Inseam', 'Pant length', 'Bottom opening'], 1.3],
    ['kurtas', 'Kurtas', std, ['Neck', 'Chest', 'Waist', 'Hip', 'Shoulder', 'Sleeve length', 'Kurta length'], 2.5],
    ['suits', 'Suits', ['36', '38', '40', '42', '44', '46'], ['Neck', 'Chest', 'Waist', 'Hip', 'Shoulder', 'Sleeve length', 'Jacket length', 'Inseam', 'Pant length'], 3.5],
    ['blouses', 'Blouses', ['32', '34', '36', '38', '40', '42'], ['Chest', 'Waist', 'Shoulder', 'Sleeve length', 'Blouse length', 'Neck depth front', 'Neck depth back'], 1.0],
    ['other', 'Other clothing', std, ['Chest', 'Waist', 'Hip', 'Shoulder', 'Length'], 2.0]
  ];
  cats.forEach((c, i) => cat.run(c[0], c[1], J(c[2]), J(c[3]), c[4], i));
  const cid = Object.fromEntries(db.prepare('SELECT slug,id FROM categories').all().map(r => [r.slug, r.id]));

      const DESIGN_ITEMS = [
    // Men's Shirts (crisp shirt product shots)
    ['shirts', 'Classic Formal Shirt', 'men', 549, '#c9d6df', 'Full sleeve, spread collar, single-needle stitching.', 1, 'https://images.pexels.com/photos/297933/pexels-photo-297933.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['shirts', 'Mandarin Collar Linen Shirt', 'men', 649, '#d9cdb4', 'Band collar, relaxed fit, ideal for summer.', 1, 'https://images.pexels.com/photos/769733/pexels-photo-769733.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['shirts', 'Casual Check Shirt', 'men', 599, '#b9a28a', 'Button-down collar with chest pocket.', 0, 'https://images.pexels.com/photos/769749/pexels-photo-769749.jpeg?auto=compress&cs=tinysrgb&w=800'],
    // Men's Trousers & Chinos (trouser product shots)
    ['pants', 'Slim Fit Trousers', 'men', 699, '#4d5a52', 'Flat front, tapered leg, belt loops.', 1, 'https://images.pexels.com/photos/1598507/pexels-photo-1598507.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['pants', 'Pleated Formal Trousers', 'men', 749, '#6b6f73', 'Double pleat, comfortable rise, side adjusters.', 0, 'https://images.pexels.com/photos/52518/jeans-pants-blue-shop-52518.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['pants', 'Everyday Chinos', 'men', 649, '#c2b08a', 'Slanted pockets, clean finish.', 0, 'https://images.pexels.com/photos/1082529/pexels-photo-1082529.jpeg?auto=compress&cs=tinysrgb&w=800'],
    // Kurtas (gender-matched Men & Women)
    ['kurtas', 'Straight Cotton Kurta', 'men', 799, '#e6dfcf', 'Collar neck, side slits, placket detail.', 1, 'https://images.pexels.com/photos/2897531/pexels-photo-2897531.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['kurtas', 'Pathani Kurta Set', 'men', 1099, '#3f4a44', 'Pathani kurta with matching salwar.', 0, 'https://images.pexels.com/photos/3755706/pexels-photo-3755706.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['kurtas', 'Anarkali Kurta', 'women', 1399, '#8a5a4a', 'Flared silhouette with fitted bodice.', 1, 'https://images.pexels.com/photos/2065195/pexels-photo-2065195.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['kurtas', 'Straight Cut Kurti', 'women', 899, '#9bb0a0', 'Side slits, three-quarter sleeves.', 0, 'https://images.pexels.com/photos/6311612/pexels-photo-6311612.jpeg?auto=compress&cs=tinysrgb&w=800'],
    // Suits (gender-matched Men's tailored suits & Women's suits)
    ['suits', 'Two-Piece Suit', 'men', 4499, '#3a3f45', 'Single-breasted jacket with trousers, half canvas.', 1, 'https://images.pexels.com/photos/325876/pexels-photo-325876.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['suits', 'Three-Piece Suit', 'men', 5999, '#2f3a36', 'Jacket, waistcoat and trousers.', 0, 'https://images.pexels.com/photos/1043474/pexels-photo-1043474.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['suits', "Women's Trouser Suit", 'women', 3999, '#5a5048', 'Tailored blazer with straight trousers.', 0, 'https://images.pexels.com/photos/5325881/pexels-photo-5325881.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['suits', 'Punjabi Salwar Suit', 'women', 1499, '#7d8f86', 'Kameez with salwar and dupatta finishing.', 0, 'https://images.pexels.com/photos/1462637/pexels-photo-1462637.jpeg?auto=compress&cs=tinysrgb&w=800'],
    // Women's Blouses (dedicated women's blouse garment shots, NO men!)
    ['blouses', 'Princess Cut Blouse', 'women', 599, '#a35d4a', 'Princess seams, back hook closure.', 1, 'https://images.pexels.com/photos/6311392/pexels-photo-6311392.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['blouses', 'Boat Neck Blouse', 'women', 649, '#2f4a3b', 'Wide boat neckline, elbow sleeves.', 0, 'https://images.pexels.com/photos/6311650/pexels-photo-6311650.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['blouses', 'Back-Open Designer Blouse', 'women', 899, '#b08d57', 'Deep back with tie-up detail.', 0, 'https://images.pexels.com/photos/6311579/pexels-photo-6311579.jpeg?auto=compress&cs=tinysrgb&w=800'],
    // Other clothing
    ['other', 'Nehru Jacket', 'men', 1799, '#4a4f4c', 'Mandarin collar waistcoat jacket.', 0, 'https://images.pexels.com/photos/1300550/pexels-photo-1300550.jpeg?auto=compress&cs=tinysrgb&w=800'],
    ['other', 'Palazzo Pants', 'women', 549, '#c9b8a0', 'Wide leg with elastic waist.', 0, 'https://images.pexels.com/photos/6311600/pexels-photo-6311600.jpeg?auto=compress&cs=tinysrgb&w=800']
  ];

  const des = db.prepare('INSERT INTO designs(category_id,name,gender,price,color,description,featured,image_url) VALUES(?,?,?,?,?,?,?,?)');
  DESIGN_ITEMS.forEach(d => des.run(cid[d[0]], d[1], d[2], d[3], d[4], d[5], d[6], d[7]));
  
    const fab = db.prepare('INSERT INTO fabrics(name,description,price_per_m,cost_per_m,colors,stock_m) VALUES(?,?,?,?,?,?)');
  const C = (...p) => p.map(x => ({ name: x[0], hex: x[1] }));
  [
    ['Cotton', 'Soft, breathable everyday cotton. Easy to wash.', 220, 160, C(['White', '#f4f1ea'], ['Sky Blue', '#b8cad6'], ['Sand', '#d6c7a8'], ['Olive', '#7a8264']), 200],
    ['Linen', 'Light, airy and textured. Great for summer shirts and kurtas.', 420, 320, C(['Ivory', '#ece4d2'], ['Sage', '#a3b09b'], ['Navy', '#2f3e55'], ['Clay', '#b27e63']), 120],
    ['Cotton Silk', 'Smooth with a soft sheen, suited to kurtas and blouses.', 480, 360, C(['Maroon', '#6e2c35'], ['Bottle Green', '#244233'], ['Mustard', '#c29b34'], ['Charcoal', '#3b3d3f']), 90],
    ['Suiting (Poly-Viscose)', 'Structured suiting fabric that holds a crease.', 650, 500, C(['Charcoal', '#3a3f45'], ['Navy', '#27324a'], ['Grey', '#7b8086']), 80],
    ['Georgette', 'Flowing, lightweight fabric for blouses and dupattas.', 300, 220, C(['Rose', '#c98f8a'], ['Teal', '#2d5f5d'], ['Black', '#1f1f1f']), 100],
    ['Silk Blend', 'Rich drape and shine for festive wear.', 750, 580, C(['Gold', '#b08d57'], ['Wine', '#5c1f2b'], ['Emerald', '#1f5a43']), 60],
    ['Khadi', 'Handspun texture, naturally breathable.', 350, 260, C(['Natural', '#e3d8c1'], ['Indigo', '#33415c']), 70]
  ].forEach(f => fab.run(f[0], f[1], f[2], f[3], J(f[4]), f[5]));
}
seed();

// Backfill real garment photos onto existing Render database designs that still have NULL image_url
(function syncDesignPhotos() {
  const photos = {
    'Classic Formal Shirt': 'https://images.pexels.com/photos/297933/pexels-photo-297933.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Mandarin Collar Linen Shirt': 'https://images.pexels.com/photos/769733/pexels-photo-769733.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Casual Check Shirt': 'https://images.pexels.com/photos/769749/pexels-photo-769749.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Slim Fit Trousers': 'https://images.pexels.com/photos/1598507/pexels-photo-1598507.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Pleated Formal Trousers': 'https://images.pexels.com/photos/52518/jeans-pants-blue-shop-52518.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Everyday Chinos': 'https://images.pexels.com/photos/1082529/pexels-photo-1082529.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Straight Cotton Kurta': 'https://images.pexels.com/photos/2897531/pexels-photo-2897531.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Pathani Kurta Set': 'https://images.pexels.com/photos/3755706/pexels-photo-3755706.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Anarkali Kurta': 'https://images.pexels.com/photos/2065195/pexels-photo-2065195.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Straight Cut Kurti': 'https://images.pexels.com/photos/6311612/pexels-photo-6311612.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Two-Piece Suit': 'https://images.pexels.com/photos/325876/pexels-photo-325876.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Three-Piece Suit': 'https://images.pexels.com/photos/1043474/pexels-photo-1043474.jpeg?auto=compress&cs=tinysrgb&w=800',
    "Women's Trouser Suit": 'https://images.pexels.com/photos/5325881/pexels-photo-5325881.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Punjabi Salwar Suit': 'https://images.pexels.com/photos/1462637/pexels-photo-1462637.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Princess Cut Blouse': 'https://images.pexels.com/photos/6311392/pexels-photo-6311392.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Boat Neck Blouse': 'https://images.pexels.com/photos/6311650/pexels-photo-6311650.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Back-Open Designer Blouse': 'https://images.pexels.com/photos/6311579/pexels-photo-6311579.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Nehru Jacket': 'https://images.pexels.com/photos/1300550/pexels-photo-1300550.jpeg?auto=compress&cs=tinysrgb&w=800',
    'Palazzo Pants': 'https://images.pexels.com/photos/6311600/pexels-photo-6311600.jpeg?auto=compress&cs=tinysrgb&w=800'
  };
  const upd = db.prepare('UPDATE designs SET image_url=? WHERE name=?');
  for (const [name, url] of Object.entries(photos)) upd.run(url, name);
})();


// Demo accounts (development only). Set SEED_DEMO=0 to skip them.
function seedDemo() {
  if (process.env.SEED_DEMO === '0') return;
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return;
  const u = db.prepare('INSERT INTO users(name,mobile,role) VALUES(?,?,?)');
  u.run('Admin', process.env.ADMIN_MOBILE || '9000000001', 'admin');
  const cats = db.prepare('SELECT id FROM categories').all().map(r => r.id);
  const t = db.prepare('INSERT INTO tailors(user_id,address,shop_location,shop_lat,shop_lng,experience,categories,capacity,upi,status) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const mk = (name, mobile, addr, shop, lat, lng, exp, cap) => {
    const id = Number(u.run(name, mobile, 'tailor').lastInsertRowid);
    t.run(id, addr, shop, lat, lng, exp, JSON.stringify(cats), cap, mobile + '@upi', 'approved');
  };
  mk('Ramesh Tailors', '9000000011', 'Karol Bagh, Delhi', 'Shop 12, Ajmal Khan Road, Karol Bagh', 28.6519, 77.1909, 18, 4);
  mk('Sunita Boutique', '9000000012', 'Lajpat Nagar, Delhi', 'Central Market, Lajpat Nagar', 28.5677, 77.2433, 11, 3);
  u.run('Demo Customer', '9000000021', 'customer');
}
seedDemo();

// Real admin: supports comma-separated numbers in ADMIN_MOBILE (e.g. "9876543210,9123456789").
(function bootstrapAdmin() {
  const raw = process.env.ADMIN_MOBILE || '';
  const mobiles = raw.split(',').map(s => s.trim()).filter(m => /^[6-9]\d{9}$/.test(m));
  for (const m of mobiles) {
    const u = db.prepare('SELECT id, role FROM users WHERE mobile=?').get(m);
    if (!u) db.prepare('INSERT INTO users(name,mobile,role) VALUES(?,?,?)').run('Admin', m, 'admin');
    else if (u.role !== 'admin') db.prepare("UPDATE users SET role='admin' WHERE id=?").run(u.id);
  }
})();
module.exports = { db, DATA_DIR, DEFAULT_SETTINGS };

