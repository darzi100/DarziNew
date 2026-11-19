'use strict';
// Darzi: HTTP server + REST API. Zero external dependencies (Node 22+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const OTP_MODE = process.env.OTP_MODE === 'sms' ? 'sms' : 'test';       // 'sms' needs a provider (not built in)
const PAYMENT_MODE = process.env.RAZORPAY_KEY_ID ? 'razorpay' : 'test'; // gateway keys come from env only
const SECRET = process.env.APP_SECRET || (PROD ? null : 'dev-secret-change-me');
if (!SECRET) { console.error('APP_SECRET must be set in production'); process.exit(1); }

const STATUSES = ['Order Confirmed', 'Measurement Pending', 'Measurement Completed', 'Tailor Assigned',
  'Stitching Started', 'Quality Check', 'Ready for Delivery', 'Out for Delivery', 'Delivered'];

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m) => new HttpError(400, m);
const nz = (v) => (v === undefined ? null : v);
const J = JSON.stringify;
const P = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const nowISO = () => new Date().toISOString();
const istDate = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
const run = (sql, ...p) => db.prepare(sql).run(...p.map(nz));
const get = (sql, ...p) => db.prepare(sql).get(...p.map(nz));
const all = (sql, ...p) => db.prepare(sql).all(...p.map(nz));
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

function settings() {
  const o = {}; for (const r of all('SELECT key,value FROM settings')) o[r.key] = P(r.value);
  return o;
}
const str = (v, min, max, label) => {
  if (typeof v !== 'string') throw bad(`${label} is required`);
  v = v.trim(); if (v.length < min || v.length > max) throw bad(`${label} must be ${min}-${max} characters`); return v;
};
const optStr = (v, max, label) => (v == null || v === '' ? null : str(String(v), 0, max, label));
const num = (v, min, max, label) => {
  const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}`); return n;
};
const MOBILE = /^[6-9]\d{9}$/;
const UPLOAD_RE = /^(?:\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)|https:\/\/res\.cloudinary\.com\/[^"'\s]+\.(png|jpg|jpeg|webp))$/;
const photoList = (arr, max) => {
  if (arr == null) return [];
  if (!Array.isArray(arr) || arr.length > max) throw bad(`At most ${max} photos allowed`);
  for (const u of arr) if (typeof u !== 'string' || !UPLOAD_RE.test(u)) throw bad('Invalid image URL');
  return arr;
};

// ---------- notifications ----------
function notify(userId, text, orderId) { run('INSERT INTO notifications(user_id,text,order_id) VALUES(?,?,?)', userId, text, orderId); }
function notifyAdmins(text, orderId) { for (const a of all("SELECT id FROM users WHERE role='admin'")) notify(a.id, text, orderId); }
function logEvent(orderId, status, note, by) { run('INSERT INTO order_events(order_id,status,note,by_user) VALUES(?,?,?,?)', orderId, status, note, by); }
function setStatus(order, status, by, note) {
  run('UPDATE orders SET status=? WHERE id=?', status, order.id);
  logEvent(order.id, status, note || null, by);
  notify(order.user_id, `Order ${order.code}: ${status}`, order.id);
}

// ---------- pricing ----------
function haversine(lat1, lng1, lat2, lng2) {
  const r = (x) => x * Math.PI / 180, R = 6371;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function slotLoad(date, slot) {
  return get("SELECT COUNT(*) n FROM orders WHERE appt_date=? AND appt_slot=? AND status!='Cancelled' AND appt_status!='Cancelled'", date, slot).n;
}
function computeQuote(user, b) {
  const S = settings();
  const design = get(`SELECT d.*, c.fabric_m, c.sizes, c.fields, c.name cat_name FROM designs d JOIN categories c ON c.id=d.category_id
                      WHERE d.id=? AND d.active=1 AND c.active=1`, b.design_id);
  if (!design) throw bad('Design not found');
  let fabric = null, fabric_own = 1;
  if (b.fabric_id) {
    fabric = get('SELECT * FROM fabrics WHERE id=? AND active=1', b.fabric_id);
    if (!fabric) throw bad('Fabric not available');
    if (!P(fabric.colors, []).some(c => c.name === b.color)) throw bad('Please pick an available colour');
    if (fabric.stock_m < design.fabric_m) throw bad('This fabric is out of stock');
    fabric_own = 0;
  }
  const mode = b.measure_mode;
  if (!['self', 'standard', 'home'].includes(mode)) throw bad('Choose a measurement option');
  const addr = b.address_id ? get('SELECT * FROM addresses WHERE id=? AND user_id=?', b.address_id, user.id) : null;
  if (!addr) throw bad('Please choose a delivery address');
  let dist = null;
  if (addr.lat != null && addr.lng != null) {
    dist = haversine(S.hub_lat, S.hub_lng, addr.lat, addr.lng);
    if (dist > S.service_radius_km) throw bad(`Sorry, we do not serve this location yet (we cover ${S.service_radius_km} km around ${S.hub_name}).`);
  }
  const stitching = design.price;
  const fabric_charge = fabric ? Math.round(fabric.price_per_m * design.fabric_m) : 0;
  const fabric_cost = fabric ? Math.round(fabric.cost_per_m * design.fabric_m) : 0;
  const home_fee = mode === 'home' ? S.home_fee : 0;
  const pickup_fee = fabric_own ? S.pickup_fee : 0;
  const delivery_fee = Math.round(S.delivery_base + S.delivery_per_km * Math.max(0, (dist || 0) - S.delivery_free_km));
  const total = stitching + fabric_charge + home_fee + pickup_fee + delivery_fee;
  const commission = Math.round(stitching * S.commission_pct / 100);
  return {
    design, fabric, fabric_own, mode, addr, dist,
    lines: { stitching, fabric_charge, home_fee, pickup_fee, delivery_fee, total },
    internal: {
      fabric_cost, commission_pct: S.commission_pct, commission, tailor_payable: stitching - commission,
      platform_revenue: commission + home_fee + (fabric_charge - fabric_cost) // delivery/pickup are pass-through, not profit
    },
    fabric_m: design.fabric_m
  };
}

// ---------- order shaping ----------
function shapeOrder(o, role) {
  const design = get('SELECT d.name, d.color, d.image_url, d.gender, c.name cat FROM designs d JOIN categories c ON c.id=d.category_id WHERE d.id=?', o.design_id) || {};
  const fabric = o.fabric_id ? get('SELECT name FROM fabrics WHERE id=?', o.fabric_id) : null;
  const out = {
    id: o.id, code: o.code, status: o.status, payment_status: o.payment_status, created_at: o.created_at,
    category: design.cat, design: design.name, design_color: design.color, design_image: design.image_url, gender: design.gender,
    design_id: o.design_id, category_id: o.category_id,
    fabric: o.fabric_own ? 'Your own fabric' : (fabric && fabric.name), fabric_own: !!o.fabric_own, color: o.color,
    measure_mode: o.measure_mode, size: o.size, measurements: P(o.measurements, null), notes: o.notes,
    ref_photos: P(o.ref_photos, []), deadline: o.deadline, pickup_status: o.pickup_status,
    appt_date: o.appt_date, appt_slot: o.appt_slot, appt_status: o.appt_status, delivered_at: o.delivered_at,
    cancel_reason: o.cancel_reason
  };
  if (role === 'tailor') {
    // Tailors only get what they need to stitch: no address, phone or payment details.
    const cu = get('SELECT name FROM users WHERE id=?', o.user_id);
    out.customer_first_name = (cu.name || '').split(' ')[0];
    out.tailor_status = o.tailor_status; out.tailor_payable = o.tailor_payable;
    return out;
  }
  out.price = { stitching: o.stitching, fabric: o.fabric_charge, home_fee: o.home_fee, pickup: o.pickup_fee, delivery: o.delivery_fee, total: o.total };
  out.address = P(o.address, {});
  out.tailor_status = o.tailor_status;
  const t = o.tailor_id && get('SELECT u.name, t.shop_location FROM users u JOIN tailors t ON t.user_id=u.id WHERE u.id=?', o.tailor_id);
  if (role === 'admin') {
    const cu = get('SELECT name, mobile FROM users WHERE id=?', o.user_id);
    out.customer = cu; out.tailor_id = o.tailor_id; out.tailor = t ? t.name : null;
    out.finance = { fabric_cost: o.fabric_cost, commission_pct: o.commission_pct, commission: o.commission, tailor_payable: o.tailor_payable, platform_revenue: o.platform_revenue };
    out.complaints = all('SELECT * FROM complaints WHERE order_id=? ORDER BY id DESC', o.id);
    out.payments = all('SELECT * FROM payments WHERE order_id=? ORDER BY id', o.id);
  } else {
    out.tailor = t && o.tailor_status === 'accepted' ? t.name : null;
    out.complaints = all('SELECT id,text,status,resolution,ts FROM complaints WHERE order_id=? ORDER BY id DESC', o.id);
    out.can_cancel = canCancel(o);
  }
  out.review = get('SELECT rating,text,photos,ts FROM reviews WHERE order_id=?', o.id);
  if (out.review) out.review.photos = P(out.review.photos, []);
  out.events = all('SELECT status,note,ts FROM order_events WHERE order_id=? ORDER BY id', o.id);
  return out;
}
const canCancel = (o) => o.status !== 'Cancelled' && (o.status === 'Awaiting Payment' || STATUSES.indexOf(o.status) < STATUSES.indexOf('Stitching Started'));

function cancelOrder(o, by, reason) {
  tx(() => {
    run("UPDATE orders SET status='Cancelled', cancelled_at=?, cancel_reason=?, tailor_status=CASE WHEN tailor_status IS NULL THEN NULL ELSE 'cancelled' END WHERE id=?", nowISO(), reason, o.id);
    logEvent(o.id, 'Cancelled', reason, by);
    if (o.fabric_id) run('UPDATE fabrics SET stock_m=stock_m+? WHERE id=?', o.fabric_m, o.fabric_id);
    if (o.payment_status === 'paid') {
      run('INSERT INTO payments(order_id,type,amount,method,status,ref) VALUES(?,?,?,?,?,?)', o.id, 'refund', o.total, 'original', 'refunded', 'TEST-RF-' + crypto.randomBytes(4).toString('hex'));
      run("UPDATE orders SET payment_status='refunded' WHERE id=?", o.id);
    }
    notify(o.user_id, `Order ${o.code} was cancelled.${o.payment_status === 'paid' ? ' Your refund has been initiated.' : ''}`, o.id);
    if (o.tailor_id) notify(o.tailor_id, `Order ${o.code} was cancelled.`, o.id);
  });
}

// ---------- uploads ----------
async function saveUpload(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad('Please upload a PNG, JPG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw bad('Image must be under 3 MB');

  if (process.env.CLOUDINARY_CLOUD && process.env.CLOUDINARY_PRESET) {
    const form = new FormData();
    form.append('file', dataUrl);
    form.append('upload_preset', process.env.CLOUDINARY_PRESET);
    const r = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD}/image/upload`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.secure_url) throw new HttpError(502, 'Image upload failed');
    return j.secure_url;
  }

  const isPng = buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  const ext = isPng ? 'png' : isJpg ? 'jpg' : isWebp ? 'webp' : null;
  if (!ext) throw bad('That file is not a valid image');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
  return '/uploads/' + name;
}

// ---------- auth ----------
const hashOtp = (mobile, code) => crypto.createHmac('sha256', SECRET).update(mobile + ':' + code).digest('hex');
function signTok(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  return `${b}.${sig}`;
}
function verifyTok(tok) {
  const [b, sig] = String(tok || '').split('.');
  if (!b || !sig) return null;
  const expSig = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (sig !== expSig) return null;
  const data = P(Buffer.from(b, 'base64url').toString(), null);
  return data && data.exp > Date.now() ? data : null;
}
function startSession(res, userId) {
  const u = get('SELECT mobile FROM users WHERE id=?', userId);
  const token = signTok({ uid: userId, m: u.mobile, exp: Date.now() + 30 * 864e5 });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${PROD ? '; Secure' : ''}`);
}
function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const data = verifyTok(m[1]);
  if (!data) return null;
  let u = get('SELECT id,name,mobile,email,role,status FROM users WHERE mobile=?', data.m);
  if (!u && data.m) {
    // Recreate admin automatically if Render wiped the free SQLite DB on restart
    const admins = (process.env.ADMIN_MOBILE || '').split(',').map(s => s.trim());
    if (admins.includes(data.m)) {
      const id = Number(run('INSERT INTO users(name,mobile,role) VALUES(?,?,?)', 'Admin', data.m, 'admin').lastInsertRowid);
      u = get('SELECT id,name,mobile,email,role,status FROM users WHERE id=?', id);
    }
  }
  if (!u || u.status === 'suspended') return null;
  u.token = m[1]; return u;
}
function meView(u) {
  const out = { id: u.id, name: u.name, mobile: u.mobile, email: u.email, role: u.role };
  if (u.role === 'tailor') out.tailor = get('SELECT status, admin_note FROM tailors WHERE user_id=?', u.id);
  out.unread = get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', u.id).n;
  return out;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, roles, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });
const idp = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw bad('Invalid id'); return n; };

// public
route('GET', '/api/config', null, () => {
  const S = settings();
  return {
    brand: S.brand, tagline: 'Your Style. Your Size. Your Choice.', otpMode: OTP_MODE, paymentMode: PAYMENT_MODE, statuses: STATUSES,
    fees: { home_fee: S.home_fee, pickup_fee: S.pickup_fee, delivery_base: S.delivery_base, delivery_free_km: S.delivery_free_km, delivery_per_km: S.delivery_per_km },
    hub: { name: S.hub_name, lat: S.hub_lat, lng: S.hub_lng, radius_km: S.service_radius_km }, slots: S.slots,
    categories: all(`SELECT c.id,c.slug,c.name,c.sizes,c.fields,c.fabric_m,
      (SELECT COUNT(*) FROM orders o WHERE o.category_id=c.id) orders FROM categories c WHERE c.active=1 ORDER BY c.sort,c.id`)
      .map(c => ({ ...c, sizes: P(c.sizes, []), fields: P(c.fields, []) }))
  };
});
route('GET', '/api/designs', null, ({ query }) => {
  const w = ['d.active=1', 'c.active=1'], p = [];
  if (query.category) { w.push('d.category_id=?'); p.push(idp(query.category)); }
  if (query.gender === 'men' || query.gender === 'women') { w.push("d.gender IN (?, 'unisex')"); p.push(query.gender); }
  if (query.featured) w.push('d.featured=1');
  if (query.q) { w.push('(d.name LIKE ? OR c.name LIKE ? OR d.description LIKE ?)'); const q = '%' + String(query.q).slice(0, 40).replace(/[%_]/g, '') + '%'; p.push(q, q, q); }
  return all(`SELECT d.id,d.name,d.gender,d.price,d.color,d.image_url,d.description,d.featured,d.category_id,c.name category
              FROM designs d JOIN categories c ON c.id=d.category_id WHERE ${w.join(' AND ')} ORDER BY d.featured DESC, d.id`, ...p);
});
route('GET', '/api/designs/:id', null, ({ params }) => {
  const d = get('SELECT d.*, c.name category FROM designs d JOIN categories c ON c.id=d.category_id WHERE d.id=? AND d.active=1', idp(params.id));
  if (!d) throw new HttpError(404, 'Design not found'); return d;
});
route('GET', '/api/fabrics', null, () => all('SELECT id,name,description,price_per_m,colors,image_url,stock_m FROM fabrics WHERE active=1 ORDER BY id')
  .map(f => ({ ...f, colors: P(f.colors, []), in_stock: f.stock_m > 0 })));
route('GET', '/api/slots', null, ({ query }) => {
  const S = settings(), d = String(query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < istDate(1) || d > istDate(14)) throw bad('Choose a date from tomorrow up to 14 days ahead');
  return S.slots.map(s => ({ slot: s, available: slotLoad(d, s) < S.appt_capacity }));
});

// auth
// Real SMS (OTP_MODE=sms). Provider: Fast2SMS "dlt" route. Needs, from your Fast2SMS panel:
//   FAST2SMS_API_KEY, FAST2SMS_SENDER_ID (DLT-approved header), FAST2SMS_MESSAGE_ID (DLT-approved OTP template id,
//   template must contain one {#var#} for the code). All values come from environment variables only.
async function sendSms(mobile, code) {
  const key = process.env.FAST2SMS_API_KEY, sender = process.env.FAST2SMS_SENDER_ID, tpl = process.env.FAST2SMS_MESSAGE_ID;
  if (!key || !sender || !tpl) throw new HttpError(503, 'SMS is not configured on this server');
  const u = new URL('https://www.fast2sms.com/dev/bulkV2');
  u.search = new URLSearchParams({ route: 'dlt', sender_id: sender, message: tpl, variables_values: code, numbers: mobile, flash: '0' });
  let r, j;
  try {
    r = await fetch(u, { headers: { authorization: key }, signal: AbortSignal.timeout(10000) });
    j = await r.json().catch(() => ({}));
  } catch (e) { console.error('SMS request failed:', e.message); throw new HttpError(502, 'Could not send the SMS. Please try again.'); }
  if (!r.ok || j.return !== true) { console.error('SMS provider refused:', r.status, JSON.stringify(j)); throw new HttpError(502, 'Could not send the SMS. Please try again.'); }
}
route('POST', '/api/auth/request-otp', null, async ({ body, req }) => {
  const mobile = String(body.mobile || '').trim();
  if (!MOBILE.test(mobile)) throw bad('Enter a valid 10-digit mobile number');
  const recent = get('SELECT COUNT(*) n FROM otp_log WHERE mobile=? AND ts>?', mobile, Date.now() - 10 * 60e3).n;
  if (recent >= 5) throw new HttpError(429, 'Too many OTP requests. Please try again in a few minutes.');
  const code = String(crypto.randomInt(100000, 1000000));
  
  if (OTP_MODE === 'sms') {
    await sendSms(mobile, code);
    run('INSERT OR REPLACE INTO otps(mobile,code_hash,expires,attempts) VALUES(?,?,?,0)', mobile, hashOtp(mobile, code), Date.now() + 5 * 60e3);
    run('INSERT INTO otp_log(mobile,ts) VALUES(?,?)', mobile, Date.now());
    return { sent: true, testMode: false };
  }

  run('INSERT OR REPLACE INTO otps(mobile,code_hash,expires,attempts) VALUES(?,?,?,0)', mobile, hashOtp(mobile, code), Date.now() + 5 * 60e3);
  run('INSERT INTO otp_log(mobile,ts) VALUES(?,?)', mobile, Date.now());

  const h = req && req.headers ? req.headers : {};
  const viaProxy = !!(h['cf-connecting-ip'] || h['x-forwarded-for'] || h.forwarded);
  const roleRecord = get('SELECT role FROM users WHERE mobile=?', mobile);
  const role = roleRecord ? roleRecord.role : null;

  if (viaProxy && (role === 'admin' || role === 'tailor')) {
    console.log('[TEST OTP] ' + mobile + ': ' + code);
    return { sent: true, testMode: true, console: true };
  }

  return { sent: true, testMode: true, devOtp: code };
});

route('POST', '/api/upload', ['customer', 'tailor', 'admin'], async ({ body }) => ({ url: await saveUpload(body.dataUrl) }));

route('POST', '/api/auth/verify', null, ({ body, res }) => {
  const mobile = String(body.mobile || '').trim();
  const code = String(body.code || '').trim();
  const o = get('SELECT * FROM otps WHERE mobile=?', mobile);
  if (!o || o.expires < Date.now()) throw bad('OTP expired. Please request a new one.');
  if (o.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Request a new OTP.');
  const a = Buffer.from(hashOtp(mobile, code));
  const b = Buffer.from(o.code_hash);
  if (!crypto.timingSafeEqual(a, b)) {
    run('UPDATE otps SET attempts=attempts+1 WHERE mobile=?', mobile);
    throw bad('Incorrect OTP');
  }
  let user = get('SELECT * FROM users WHERE mobile=?', mobile);
  const intent = body.intent === 'tailor' ? 'tailor' : 'customer';
  if (!user) {
    if (!body.name) return { needsName: true };
    const name = str(body.name, 2, 60, 'Name');
    const email = body.email ? str(body.email, 3, 120, 'Email') : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email');
    tx(() => {
      const id = Number(run('INSERT INTO users(name,mobile,email,role) VALUES(?,?,?,?)', name, mobile, email, intent).lastInsertRowid);
      if (intent === 'tailor') run('INSERT INTO tailors(user_id) VALUES(?)', id);
    });
    user = get('SELECT * FROM users WHERE mobile=?', mobile);
  } else if (intent === 'tailor' && user.role === 'customer') {
    throw bad('This mobile number is registered as a customer account.');
  }
  if (user.status === 'suspended') throw new HttpError(403, 'This account is suspended. Please contact support.');
  run('DELETE FROM otps WHERE mobile=?', mobile);
  startSession(res, user.id);
  return meView(user);
});

route('POST', '/api/logout', ['customer', 'tailor', 'admin'], ({ user, res }) => {
  run('DELETE FROM sessions WHERE token=?', user.token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return { ok: true };
});
route('GET', '/api/me', ['customer', 'tailor', 'admin'], ({ user }) => meView(user));
route('PUT', '/api/me', ['customer', 'tailor', 'admin'], ({ user, body }) => {
  const name = str(body.name, 2, 60, 'Name');
  const email = body.email ? str(body.email, 3, 120, 'Email') : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email');
  run('UPDATE users SET name=?, email=? WHERE id=?', name, email, user.id);
  return meView({ ...user, name, email });
});
// notifications
route('GET', '/api/notifications', ['customer', 'tailor', 'admin'], ({ user }) => all('SELECT id,text,order_id,read,ts FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', user.id));
route('POST', '/api/notifications/read', ['customer', 'tailor', 'admin'], ({ user }) => { run('UPDATE notifications SET read=1 WHERE user_id=?', user.id); return { ok: true }; });

// customer: addresses
function addressInput(b) {
  const lat = b.lat === '' || b.lat == null ? null : num(b.lat, -90, 90, 'Latitude');
  const lng = b.lng === '' || b.lng == null ? null : num(b.lng, -180, 180, 'Longitude');
  if ((lat == null) !== (lng == null)) throw bad('Provide both latitude and longitude, or neither');
  const pin = b.pincode ? String(b.pincode).trim() : null;
  if (pin) {
    if (!/^\d{6}$/.test(pin)) throw bad('Pincode must be 6 digits');
  }
  return { label: optStr(b.label, 30, 'Label') || 'Home', line: str(b.line, 5, 200, 'Address'), landmark: optStr(b.landmark, 100, 'Landmark'), pincode: pin, lat, lng };
}

route('GET', '/api/addresses', ['customer'], ({ user }) => all('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id', user.id));
route('POST', '/api/addresses', ['customer'], ({ user, body }) => {
  const a = addressInput(body);
  return tx(() => {
    const first = get('SELECT COUNT(*) n FROM addresses WHERE user_id=?', user.id).n === 0;
    const def = first || body.is_default ? 1 : 0;
    if (def) run('UPDATE addresses SET is_default=0 WHERE user_id=?', user.id);
    const id = Number(run('INSERT INTO addresses(user_id,label,line,landmark,pincode,lat,lng,is_default) VALUES(?,?,?,?,?,?,?,?)', user.id, a.label, a.line, a.landmark, a.pincode, a.lat, a.lng, def).lastInsertRowid);
    return get('SELECT * FROM addresses WHERE id=?', id);
  });
});
route('PUT', '/api/addresses/:id', ['customer'], ({ user, params, body }) => {
  const id = idp(params.id); if (!get('SELECT id FROM addresses WHERE id=? AND user_id=?', id, user.id)) throw new HttpError(404, 'Address not found');
  const a = addressInput(body);
  tx(() => {
    if (body.is_default) run('UPDATE addresses SET is_default=0 WHERE user_id=?', user.id);
    run('UPDATE addresses SET label=?,line=?,landmark=?,pincode=?,lat=?,lng=?,is_default=CASE WHEN ? THEN 1 ELSE is_default END WHERE id=?', a.label, a.line, a.landmark, a.pincode, a.lat, a.lng, body.is_default ? 1 : 0, id);
  });
  return get('SELECT * FROM addresses WHERE id=?', id);
});
route('DELETE', '/api/addresses/:id', ['customer'], ({ user, params }) => {
  const id = idp(params.id); const a = get('SELECT * FROM addresses WHERE id=? AND user_id=?', id, user.id);
  if (!a) throw new HttpError(404, 'Address not found');
  if (get("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status NOT IN ('Delivered','Cancelled') AND json_extract(address,'$.id')=?", user.id, id).n)
    throw bad('This address is used by an active order');
  tx(() => {
    run('DELETE FROM addresses WHERE id=?', id);
    if (a.is_default) run('UPDATE addresses SET is_default=1 WHERE id=(SELECT id FROM addresses WHERE user_id=? ORDER BY id LIMIT 1)', user.id);
  });
  return { ok: true };
});

// customer: saved measurements + favourites
route('GET', '/api/measurements', ['customer'], ({ user }) => all('SELECT id,label,category_id,data,created_at FROM measurements WHERE user_id=? ORDER BY id DESC', user.id).map(m => ({ ...m, data: P(m.data, {}) })));
route('POST', '/api/measurements', ['customer'], ({ user, body }) => {
  const label = str(body.label, 1, 40, 'Name for these measurements');
  const cat = get('SELECT * FROM categories WHERE id=?', idp(body.category_id));
  if (!cat) throw bad('Unknown category');
  const data = cleanMeasurements(body.data, P(cat.fields, []));
  if (get('SELECT COUNT(*) n FROM measurements WHERE user_id=?', user.id).n >= 30) throw bad('You can save up to 30 measurement sets');
  run('INSERT INTO measurements(user_id,label,category_id,data) VALUES(?,?,?,?)', user.id, label, cat.id, J(data));
  return { ok: true };
});
route('DELETE', '/api/measurements/:id', ['customer'], ({ user, params }) => { run('DELETE FROM measurements WHERE id=? AND user_id=?', idp(params.id), user.id); return { ok: true }; });
function cleanMeasurements(d, fields) {
  if (!d || typeof d !== 'object') throw bad('Enter your measurements');
  const out = {};
  for (const f of fields) out[f] = num(d[f], 3, 120, f + ' (inches)');
  return out;
}
route('GET', '/api/favorites', ['customer'], ({ user }) => all(`SELECT d.id,d.name,d.gender,d.price,d.color,d.image_url,d.category_id,c.name category FROM favorites f
  JOIN designs d ON d.id=f.design_id JOIN categories c ON c.id=d.category_id WHERE f.user_id=? AND d.active=1`, user.id));
route('POST', '/api/favorites/:id', ['customer'], ({ user, params }) => {
  const id = idp(params.id);
  if (!get('SELECT id FROM designs WHERE id=?', id)) throw new HttpError(404, 'Design not found');
  const has = get('SELECT 1 x FROM favorites WHERE user_id=? AND design_id=?', user.id, id);
  if (has) run('DELETE FROM favorites WHERE user_id=? AND design_id=?', user.id, id); else run('INSERT INTO favorites(user_id,design_id) VALUES(?,?)', user.id, id);
  return { favorite: !has };
});

// customer: orders
route('POST', '/api/quote', ['customer'], ({ user, body }) => {
  const q = computeQuote(user, body);
  return { lines: q.lines, distance_km: q.dist == null ? null : Math.round(q.dist * 10) / 10, own_fabric: !!q.fabric_own };
});
route('POST', '/api/orders', ['customer'], ({ user, body }) => {
  const q = computeQuote(user, body), S = settings();
  let size = null, meas = null, appt_date = null, appt_slot = null, appt_status = null;
  if (q.mode === 'standard') {
    size = String(body.size || '');
    if (!P(q.design.sizes, []).includes(size)) throw bad('Please choose a size');
  } else if (q.mode === 'self') {
    meas = cleanMeasurements(body.measurements, P(q.design.fields, []));
  } else {
    appt_date = String(body.appt_date || ''); appt_slot = String(body.appt_slot || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appt_date) || appt_date < istDate(1) || appt_date > istDate(14)) throw bad('Choose an appointment date from tomorrow up to 14 days ahead');
    if (!S.slots.includes(appt_slot)) throw bad('Choose a time slot');
    appt_status = 'Scheduled';
  }
  const notes = optStr(body.notes, 500, 'Instructions');
  const refs = photoList(body.ref_photos, 4);
  const addrSnap = { id: q.addr.id, label: q.addr.label, line: q.addr.line, landmark: q.addr.landmark, pincode: q.addr.pincode, lat: q.addr.lat, lng: q.addr.lng, name: user.name, mobile: user.mobile };
  const code = 'DZ' + String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const id = tx(() => {
    if (appt_date && slotLoad(appt_date, appt_slot) >= S.appt_capacity) throw bad('That slot has just been filled. Please choose another.');
    if (q.fabric && get('SELECT stock_m FROM fabrics WHERE id=?', q.fabric.id).stock_m < q.fabric_m) throw bad('This fabric is out of stock');
    const oid = Number(run(`INSERT INTO orders(code,user_id,category_id,design_id,fabric_id,fabric_own,color,measure_mode,size,measurements,notes,ref_photos,address,
        appt_date,appt_slot,appt_status,pickup_status,status,stitching,fabric_charge,fabric_cost,home_fee,pickup_fee,delivery_fee,total,
        commission_pct,commission,tailor_payable,platform_revenue,fabric_m)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      code, user.id, q.design.category_id, q.design.id, q.fabric && q.fabric.id, q.fabric_own, q.fabric ? body.color : optStr(body.color, 40, 'Colour'),
      q.mode, size, meas && J(meas), notes, J(refs), J(addrSnap), appt_date, appt_slot, appt_status,
      q.fabric_own ? 'Pending pickup' : 'Not required', 'Awaiting Payment',
      q.lines.stitching, q.lines.fabric_charge, q.internal.fabric_cost, q.lines.home_fee, q.lines.pickup_fee, q.lines.delivery_fee, q.lines.total,
      q.internal.commission_pct, q.internal.commission, q.internal.tailor_payable, q.internal.platform_revenue, q.fabric ? q.fabric_m : 0).lastInsertRowid);
    if (q.fabric) run('UPDATE fabrics SET stock_m=stock_m-? WHERE id=?', q.fabric_m, q.fabric.id);
    logEvent(oid, 'Awaiting Payment', null, user.id);
    return oid;
  });
  return shapeOrder(get('SELECT * FROM orders WHERE id=?', id), 'customer');
});
route('GET', '/api/orders', ['customer'], ({ user }) => all('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC', user.id).map(o => {
  const s = shapeOrder(o, 'customer'); delete s.events; return s;
}));
function ownOrder(user, id) {
  const o = get('SELECT * FROM orders WHERE id=? AND user_id=?', idp(id), user.id);
  if (!o) throw new HttpError(404, 'Order not found'); return o;
}
route('GET', '/api/orders/:id', ['customer'], ({ user, params }) => shapeOrder(ownOrder(user, params.id), 'customer'));
route('POST', '/api/orders/:id/razorpay-order', ['customer'], async ({ user, params }) => {
  const o = ownOrder(user, params.id);
  if (o.status === 'Cancelled') throw bad('This order was cancelled');
  if (o.payment_status === 'paid') throw bad('This order is already paid');
  const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new HttpError(503, 'Razorpay keys are not configured');

  const amountPaise = Math.round(o.total * 100);
  if (amountPaise < 100) throw bad('Order amount must be at least ₹1');

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: o.code })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new HttpError(401, 'Razorpay authentication failed');
  if (!r.ok || !j.id) throw new HttpError(502, 'Could not start Razorpay checkout');

  return {
    key: keyId,
    order_id: j.id,
    amount: j.amount,
    currency: j.currency,
    code: o.code,
    customer: { name: user.name, contact: user.mobile, email: user.email || '' }
  };
});

route('POST', '/api/orders/:id/razorpay-verify', ['customer'], async ({ user, params, body }) => {
  const o = ownOrder(user, params.id);
  if (o.payment_status === 'paid') return shapeOrder(o, 'customer');

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw bad('Missing payment confirmation details');
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) throw bad('Payment signature verification failed');

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new HttpError(503, 'Razorpay is not configured');
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const check = await fetch(
    `https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpay_order_id)}`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );

  const remoteOrder = await check.json().catch(() => ({}));

  if (!check.ok) {
    throw new HttpError(502, 'Could not verify Razorpay order');
  }

  if (
    remoteOrder.receipt !== o.code ||
    remoteOrder.amount !== Math.round(o.total * 100) ||
    remoteOrder.currency !== 'INR' ||
    remoteOrder.status !== 'paid'
  ) {
    throw bad('Razorpay order does not match this Darzi order');
  }
  
  tx(() => {
    run(
      'INSERT INTO payments(order_id,type,amount,method,status,ref) VALUES(?,?,?,?,?,?)',
      o.id, 'payment', o.total, 'razorpay', 'paid', razorpay_payment_id
    );
    run("UPDATE orders SET payment_status='paid' WHERE id=?", o.id);
    setStatus(o, 'Order Confirmed', user.id, 'Payment received via Razorpay');
    if (o.measure_mode === 'home') {
      setStatus(o, 'Measurement Pending', user.id, `Home measurement ${o.appt_date}, ${o.appt_slot}`);
    }
    notifyAdmins(`New paid order ${o.code}`, o.id);
  });

  return shapeOrder(get('SELECT * FROM orders WHERE id=?', o.id), 'customer');
});
// Pay by UPI or cash on delivery. No gateway involved; the admin records the payment when money is received.
route('POST', '/api/orders/:id/pay-later', ['customer'], ({ user, params }) => {
  const o = ownOrder(user, params.id);
  if (o.status !== 'Awaiting Payment') throw bad('This order is already confirmed or cancelled');
  tx(() => {
    run("UPDATE orders SET payment_status='cod' WHERE id=?", o.id);
    setStatus(o, 'Order Confirmed', user.id, 'Pay by UPI or cash on delivery');
    if (o.measure_mode === 'home') setStatus(o, 'Measurement Pending', user.id, `Home measurement ${o.appt_date}, ${o.appt_slot}`);
    notifyAdmins(`New order ${o.code} (payment on delivery)`, o.id);
  });
  return shapeOrder(get('SELECT * FROM orders WHERE id=?', o.id), 'customer');
});
route('POST', '/api/orders/:id/cancel', ['customer'], ({ user, params, body }) => {
  const o = ownOrder(user, params.id);
  if (!canCancel(o)) throw bad('This order can no longer be cancelled because stitching has started. Please contact support.');
  cancelOrder(o, user.id, optStr(body.reason, 200, 'Reason') || 'Cancelled by customer');
  notifyAdmins(`Order ${o.code} cancelled by customer`, o.id);
  return shapeOrder(get('SELECT * FROM orders WHERE id=?', o.id), 'customer');
});
route('POST', '/api/orders/:id/review', ['customer'], ({ user, params, body }) => {
  const o = ownOrder(user, params.id);
  if (o.status !== 'Delivered' || !o.tailor_id) throw bad('You can review a tailor after your order is delivered');
  if (get('SELECT 1 x FROM reviews WHERE order_id=?', o.id)) throw bad('You have already reviewed this order');
  const rating = num(body.rating, 1, 5, 'Rating');
  if (!Number.isInteger(rating)) throw bad('Rating must be a whole number');
  run('INSERT INTO reviews(order_id,user_id,tailor_id,rating,text,photos) VALUES(?,?,?,?,?,?)', o.id, user.id, o.tailor_id, rating, optStr(body.text, 1000, 'Review'), J(photoList(body.photos, 4)));
  notify(o.tailor_id, `New ${rating}-star review for order ${o.code}`, o.id);
  return { ok: true };
});
route('POST', '/api/orders/:id/complaint', ['customer'], ({ user, params, body }) => {
  const o = ownOrder(user, params.id);
  run('INSERT INTO complaints(order_id,user_id,text) VALUES(?,?,?)', o.id, user.id, str(body.text, 5, 1000, 'Complaint'));
  notifyAdmins(`Complaint on order ${o.code}`, o.id);
  return { ok: true };
});
route('GET', '/api/payments', ['customer'], ({ user }) => all(`SELECT p.id,p.type,p.amount,p.method,p.status,p.ref,p.ts,o.code FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.user_id=? ORDER BY p.id DESC`, user.id));

// tailor
const approvedTailor = ({ user }) => {
  const t = get('SELECT * FROM tailors WHERE user_id=?', user.id);
  if (!t || t.status !== 'approved') throw new HttpError(403, 'Your tailor account is not approved yet');
  return t;
};
route('GET', '/api/tailor/profile', ['tailor'], ({ user }) => {
  const t = get('SELECT * FROM tailors WHERE user_id=?', user.id);
  return { ...t, categories: P(t.categories, []), portfolio: P(t.portfolio, []) };
});
route('PUT', '/api/tailor/profile', ['tailor'], ({ user, body }) => {
  const t = get('SELECT status FROM tailors WHERE user_id=?', user.id);
  if (t.status === 'suspended') throw new HttpError(403, 'Account suspended');
  const validCats = new Set(all('SELECT id FROM categories').map(c => c.id));
  const cats = Array.isArray(body.categories) ? body.categories.map(Number).filter(c => validCats.has(c)) : [];
  if (!cats.length) throw bad('Select at least one clothing category');
  const upi = optStr(body.upi, 60, 'UPI ID'), acct = optStr(body.bank_account, 20, 'Account number'), ifsc = body.bank_ifsc ? String(body.bank_ifsc).trim().toUpperCase() : null;
  if (acct && !/^\d{9,18}$/.test(acct)) throw bad('Account number must be 9-18 digits');
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw bad('Enter a valid IFSC code');
  if (!upi && !(acct && ifsc)) throw bad('Add a UPI ID or bank account details for payouts');
  const lat = body.shop_lat === '' || body.shop_lat == null ? null : num(body.shop_lat, -90, 90, 'Latitude');
  const lng = body.shop_lng === '' || body.shop_lng == null ? null : num(body.shop_lng, -180, 180, 'Longitude');
  const portfolio = photoList(body.portfolio, 8);
  if (portfolio.length < 1) throw bad('Please add at least one portfolio photo');
  run('UPDATE users SET name=? WHERE id=?', str(body.name, 2, 60, 'Name'), user.id);
  run(`UPDATE tailors SET address=?, shop_location=?, shop_lat=?, shop_lng=?, experience=?, categories=?, capacity=?, bank_holder=?, bank_account=?, bank_ifsc=?, upi=?, portfolio=?,
       status=CASE WHEN status='approved' THEN 'approved' ELSE 'pending' END WHERE user_id=?`,
    str(body.address, 5, 200, 'Address'), str(body.shop_location, 5, 200, 'Shop location'), lat, lng, Math.round(num(body.experience, 0, 60, 'Years of experience')),
    J(cats), Math.round(num(body.capacity, 1, 50, 'Daily capacity')), optStr(body.bank_holder, 80, 'Account holder'), acct, ifsc, upi, J(portfolio), user.id);
  if (t.status !== 'approved') notifyAdmins(`Tailor ${user.name} submitted a profile for approval`);
  return { ok: true };
});
route('GET', '/api/tailor/orders', ['tailor'], (ctx) => {
  approvedTailor(ctx);
  const uid = ctx.user.id;
  const rows = all("SELECT * FROM orders WHERE tailor_id=? AND status!='Cancelled' ORDER BY COALESCE(deadline,'9999'), id", uid).map(o => shapeOrder(o, 'tailor'));
  const rejected = all(`SELECT r.ts, r.reason, o.code, d.name design, c.name category FROM tailor_rejections r JOIN orders o ON o.id=r.order_id
    JOIN designs d ON d.id=o.design_id JOIN categories c ON c.id=o.category_id WHERE r.tailor_id=? ORDER BY r.id DESC LIMIT 50`, uid);
  const delivered = all("SELECT tailor_payable, delivered_at FROM orders WHERE tailor_id=? AND status='Delivered'", uid);
  const inprog = all("SELECT tailor_payable FROM orders WHERE tailor_id=? AND tailor_status='accepted' AND status NOT IN ('Delivered','Cancelled')", uid);
  const paid = get('SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE tailor_id=?', uid).s;
  const earned = delivered.reduce((s, o) => s + o.tailor_payable, 0);
  const rt = get('SELECT AVG(rating) a, COUNT(*) n FROM reviews WHERE tailor_id=?', uid);
  return {
    orders: rows, rejected,
    earnings: { earned, paid_out: paid, balance: earned - paid, in_progress: inprog.reduce((s, o) => s + o.tailor_payable, 0) },
    rating: rt.n ? Math.round(rt.a * 10) / 10 : null, reviews: rt.n,
    payouts: all('SELECT amount,note,ts FROM payouts WHERE tailor_id=? ORDER BY id DESC LIMIT 20', uid)
  };
});
function tailorOrder(ctx) {
  approvedTailor(ctx);
  const o = get('SELECT * FROM orders WHERE id=? AND tailor_id=?', idp(ctx.params.id), ctx.user.id);
  if (!o) throw new HttpError(404, 'Order not found'); return o;
}
route('POST', '/api/tailor/orders/:id/respond', ['tailor'], (ctx) => {
  const o = tailorOrder(ctx);
  if (o.tailor_status !== 'new') throw bad('You have already responded to this order');
  const accept = ctx.body.accept === true;
  tx(() => {
    if (accept) {
      const S = settings();
      const deadline = new Date(Date.now() + S.stitch_days * 864e5).toISOString().slice(0, 10);
      run("UPDATE orders SET tailor_status='accepted', deadline=COALESCE(deadline,?) WHERE id=?", deadline, o.id);
      setStatus(o, 'Tailor Assigned', ctx.user.id);
    } else {
      run('INSERT INTO tailor_rejections(order_id,tailor_id,reason) VALUES(?,?,?)', o.id, ctx.user.id, optStr(ctx.body.reason, 200, 'Reason'));
      run('UPDATE orders SET tailor_id=NULL, tailor_status=NULL, assigned_at=NULL WHERE id=?', o.id);
      notifyAdmins(`Tailor ${ctx.user.name} rejected order ${o.code}. Please reassign.`, o.id);
    }
  });
  return { ok: true };
});
route('POST', '/api/tailor/orders/:id/status', ['tailor'], (ctx) => {
  const o = tailorOrder(ctx);
  if (o.tailor_status !== 'accepted') throw bad('Accept the order first');
  const flow = ['Tailor Assigned', 'Stitching Started', 'Quality Check', 'Ready for Delivery'];
  const next = flow[flow.indexOf(o.status) + 1];
  if (flow.indexOf(o.status) < 0 || !next || ctx.body.status !== next) throw bad(next ? `Next step is "${next}"` : 'No further steps for you on this order');
  if (next === 'Stitching Started' && !['Not required', 'Collected'].includes(o.pickup_status)) throw bad('The customer\'s fabric has not been collected yet');
  setStatus(o, next, ctx.user.id);
  if (next === 'Ready for Delivery') notifyAdmins(`Order ${o.code} is ready for pickup from ${ctx.user.name}`, o.id);
  return { ok: true };
});

// admin
const A = ['admin'];
route('GET', '/api/admin/stats', A, () => {
  const c = (w) => get(`SELECT COUNT(*) n FROM orders WHERE ${w}`).n;
  return {
    total_orders: c('1=1'), pending_orders: c("status NOT IN ('Delivered','Cancelled')"), completed_orders: c("status='Delivered'"), cancelled_orders: c("status='Cancelled'"),
    awaiting_assignment: c("payment_status IN ('paid','cod') AND tailor_id IS NULL AND status IN ('Order Confirmed','Measurement Completed')"),
    gross_collected: get("SELECT COALESCE(SUM(CASE WHEN type='payment' THEN amount ELSE -amount END),0) s FROM payments").s,
    revenue: get("SELECT COALESCE(SUM(platform_revenue),0) s FROM orders WHERE status='Delivered'").s,
    active_customers: get("SELECT COUNT(DISTINCT user_id) n FROM orders WHERE created_at>=datetime('now','-30 days')").n,
    total_customers: get("SELECT COUNT(*) n FROM users WHERE role='customer'").n,
    active_tailors: get("SELECT COUNT(*) n FROM tailors WHERE status='approved'").n,
    pending_tailors: get("SELECT COUNT(*) n FROM tailors WHERE status='pending'").n,
    open_complaints: get("SELECT COUNT(*) n FROM complaints WHERE status='open'").n,
    popular: all(`SELECT c.name, COUNT(o.id) orders FROM categories c LEFT JOIN orders o ON o.category_id=c.id AND o.status!='Cancelled' GROUP BY c.id ORDER BY orders DESC, c.sort LIMIT 8`),
    by_status: all("SELECT status, COUNT(*) n FROM orders GROUP BY status")
  };
});
route('GET', '/api/admin/customers', A, () => all(`SELECT u.id,u.name,u.mobile,u.email,u.status,u.created_at,
  (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) orders, (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.user_id=u.id AND o.payment_status='paid') spent
  FROM users u WHERE u.role='customer' ORDER BY u.id DESC`));
route('GET', '/api/admin/customers/:id', A, ({ params }) => {
  const u = get("SELECT id,name,mobile,email,status,created_at FROM users WHERE id=? AND role='customer'", idp(params.id));
  if (!u) throw new HttpError(404, 'Customer not found');
  return { ...u, addresses: all('SELECT * FROM addresses WHERE user_id=?', u.id), orders: all('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC', u.id).map(o => { const s = shapeOrder(o, 'admin'); delete s.events; return s; }) };
});
route('POST', '/api/admin/customers/:id/status', A, ({ params, body }) => {
  if (!['active', 'suspended'].includes(body.status)) throw bad('Invalid status');
  const id = idp(params.id);
  run("UPDATE users SET status=? WHERE id=? AND role='customer'", body.status, id);
  if (body.status === 'suspended') run('DELETE FROM sessions WHERE user_id=?', id);
  return { ok: true };
});
route('GET', '/api/admin/tailors', A, () => all(`SELECT u.id,u.name,u.mobile,t.address,t.shop_location,t.experience,t.categories,t.capacity,t.upi,t.bank_holder,t.bank_account,t.bank_ifsc,t.portfolio,t.status,t.admin_note,
  (SELECT AVG(rating) FROM reviews r WHERE r.tailor_id=u.id) rating, (SELECT COUNT(*) FROM reviews r WHERE r.tailor_id=u.id) reviews,
  (SELECT COUNT(*) FROM orders o WHERE o.tailor_id=u.id AND o.status='Delivered') completed,
  (SELECT COUNT(*) FROM orders o WHERE o.tailor_id=u.id AND o.status NOT IN ('Delivered','Cancelled') AND o.tailor_status='accepted') active,
  (SELECT COUNT(*) FROM tailor_rejections r WHERE r.tailor_id=u.id) rejections
  FROM users u JOIN tailors t ON t.user_id=u.id WHERE u.role='tailor' ORDER BY (t.status='pending') DESC, u.id DESC`)
  .map(t => ({ ...t, categories: P(t.categories, []), portfolio: P(t.portfolio, []), rating: t.rating == null ? null : Math.round(t.rating * 10) / 10 })));
route('POST', '/api/admin/tailors/:id/status', A, ({ params, body }) => {
  if (!['approved', 'rejected', 'suspended'].includes(body.status)) throw bad('Invalid status');
  const id = idp(params.id), t = get('SELECT * FROM tailors WHERE user_id=?', id);
  if (!t) throw new HttpError(404, 'Tailor not found');
  if (t.status === 'incomplete') throw bad('This tailor has not submitted a profile yet');
  run('UPDATE tailors SET status=?, admin_note=? WHERE user_id=?', body.status, optStr(body.note, 300, 'Note'), id);
  if (body.status === 'suspended') run('DELETE FROM sessions WHERE user_id=?', id);
  notify(id, body.status === 'approved' ? 'Your tailor account is approved. You can now receive orders.' : `Your tailor account was ${body.status}.${body.note ? ' Note: ' + body.note : ''}`);
  return { ok: true };
});
route('PUT', '/api/admin/tailors/:id', A, ({ params, body }) => {
  const validCats = new Set(all('SELECT id FROM categories').map(c => c.id));
  const cats = (Array.isArray(body.categories) ? body.categories : []).map(Number).filter(c => validCats.has(c));
  if (!cats.length) throw bad('Select at least one category');
  run('UPDATE tailors SET capacity=?, categories=?, admin_note=? WHERE user_id=?', Math.round(num(body.capacity, 1, 50, 'Capacity')), J(cats), optStr(body.admin_note, 300, 'Note'), idp(params.id));
  return { ok: true };
});
route('GET', '/api/admin/orders', A, ({ query }) => {
  const w = [], p = [];
  if (query.status) { w.push('status=?'); p.push(String(query.status)); }
  if (query.q) { w.push('(code LIKE ?)'); p.push('%' + String(query.q).slice(0, 20).replace(/[%_]/g, '') + '%'); }
  return all(`SELECT * FROM orders ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`, ...p).map(o => { const s = shapeOrder(o, 'admin'); delete s.events; return s; });
});
route('GET', '/api/admin/orders/:id', A, ({ params }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o) throw new HttpError(404, 'Order not found');
  const s = shapeOrder(o, 'admin');
  const cat = get('SELECT fields FROM categories WHERE id=?', o.category_id);
  s.fields = P(cat.fields, []);
  s.candidates = all("SELECT u.id,u.name,t.capacity,t.categories FROM users u JOIN tailors t ON t.user_id=u.id WHERE t.status='approved' AND u.status='active'").filter(t => P(t.categories, []).includes(o.category_id))
    .map(t => ({ id: t.id, name: t.name, capacity: t.capacity,
      load_today: get("SELECT COUNT(*) n FROM orders WHERE tailor_id=? AND date(assigned_at)=date('now') AND status!='Cancelled'", t.id).n,
      active: get("SELECT COUNT(*) n FROM orders WHERE tailor_id=? AND tailor_status IN ('new','accepted') AND status NOT IN ('Delivered','Cancelled')", t.id).n }));
  return s;
});
route('POST', '/api/admin/orders/:id/assign', A, ({ user, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o) throw new HttpError(404, 'Order not found');
  if (o.payment_status !== 'paid' && o.payment_status !== 'cod') throw bad('Order is not confirmed yet');
  const assignable = ['Order Confirmed', 'Measurement Completed', 'Tailor Assigned'];
  if (!assignable.includes(o.status)) throw bad('This order can no longer be reassigned');
  if (o.measure_mode === 'home' && !o.measurements) throw bad('Record the home measurements before assigning a tailor');
  const tid = idp(body.tailor_id);
  const t = get("SELECT t.*, u.name FROM tailors t JOIN users u ON u.id=t.user_id WHERE t.user_id=? AND t.status='approved' AND u.status='active'", tid);
  if (!t) throw bad('Tailor is not approved');
  if (!P(t.categories, []).includes(o.category_id)) throw bad('This tailor does not stitch this category');
  const load = get("SELECT COUNT(*) n FROM orders WHERE tailor_id=? AND date(assigned_at)=date('now') AND status!='Cancelled' AND id!=?", tid, o.id).n;
  if (load >= t.capacity) throw bad(`${t.name} has reached today's capacity (${t.capacity})`);
  tx(() => {
    const prev = o.tailor_id;
    const base = o.measure_mode === 'home' ? 'Measurement Completed' : 'Order Confirmed';
    run("UPDATE orders SET tailor_id=?, tailor_status='new', assigned_at=?, deadline=NULL, status=? WHERE id=?", tid, nowISO(), base, o.id);
    logEvent(o.id, 'Assigned to tailor (awaiting acceptance)', t.name, user.id);
    notify(tid, `New order ${o.code} assigned to you. Please accept or reject.`, o.id);
    if (prev && prev !== tid) notify(prev, `Order ${o.code} was reassigned.`, o.id);
  });
  return { ok: true };
});
route('POST', '/api/admin/orders/:id/mark-paid', A, ({ user, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o) throw new HttpError(404, 'Order not found');
  if (o.status === 'Cancelled') throw bad('This order was cancelled');
  if (o.payment_status !== 'cod') throw bad('This order does not need a manual payment');
  if (body.method !== 'cash' && body.method !== 'upi') throw bad('Choose how the customer paid: cash or UPI');
  const ref = optStr(body.ref, 60, 'Reference') || 'MANUAL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  tx(() => {
    run('INSERT INTO payments(order_id,type,amount,method,status,ref) VALUES(?,?,?,?,?,?)', o.id, 'payment', o.total, body.method, 'paid', ref);
    run("UPDATE orders SET payment_status='paid' WHERE id=?", o.id);
    logEvent(o.id, 'Payment recorded', `${body.method} ${ref}`, user.id);
    notify(o.user_id, `Payment received for order ${o.code}. Thank you.`, o.id);
  });
  return { ok: true };
});
route('POST', '/api/admin/orders/:id/status', A, ({ user, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o) throw new HttpError(404, 'Order not found');
  const want = body.status;
  if (want === 'Delivered' && o.payment_status === 'cod') throw bad('Record the payment before marking this order delivered');
  if (want === 'Out for Delivery' && o.status === 'Ready for Delivery') setStatus(o, want, user.id);
  else if (want === 'Delivered' && o.status === 'Out for Delivery') { run('UPDATE orders SET delivered_at=? WHERE id=?', nowISO(), o.id); setStatus(o, want, user.id); notify(o.user_id, `Order ${o.code} delivered. Tell us how it turned out by leaving a review.`, o.id); }
  else throw bad('That status change is not allowed from the current step');
  return { ok: true };
});
route('POST', '/api/admin/orders/:id/appointment', A, ({ user, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o || o.measure_mode !== 'home') throw bad('Not a home-measurement order');
  if (!['Scheduled', 'Confirmed', 'On the way'].includes(body.status)) throw bad('Invalid status');
  if (o.status !== 'Measurement Pending') throw bad('Appointment can no longer be updated');
  run('UPDATE orders SET appt_status=? WHERE id=?', body.status, o.id);
  notify(o.user_id, `Home measurement for ${o.code}: ${body.status}`, o.id); return { ok: true };
});
route('POST', '/api/admin/orders/:id/home-measurement', A, ({ user, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o || o.measure_mode !== 'home') throw bad('Not a home-measurement order');
  if (o.status !== 'Measurement Pending') throw bad('Order is not waiting for measurements');
  const cat = get('SELECT fields FROM categories WHERE id=?', o.category_id);
  const data = cleanMeasurements(body.data, P(cat.fields, []));
  run("UPDATE orders SET measurements=?, appt_status='Completed' WHERE id=?", J(data), o.id);
  setStatus(o, 'Measurement Completed', user.id); return { ok: true };
});
route('POST', '/api/admin/orders/:id/pickup', A, ({ params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o || !o.fabric_own) throw bad('Order uses platform fabric');
  if (!['Pending pickup', 'Collected'].includes(body.status)) throw bad('Invalid status');
  run('UPDATE orders SET pickup_status=? WHERE id=?', body.status, o.id);
  notify(o.user_id, `Fabric pickup for ${o.code}: ${body.status}`, o.id); return { ok: true };
});
route('POST', '/api/admin/orders/:id/cancel', A, ({ user, params, body }) => {
  const o = get('SELECT * FROM orders WHERE id=?', idp(params.id)); if (!o) throw new HttpError(404, 'Order not found');
  if (o.status === 'Cancelled' || o.status === 'Delivered') throw bad('This order cannot be cancelled');
  cancelOrder(o, user.id, str(body.reason, 3, 200, 'Reason')); return { ok: true };
});
route('GET', '/api/admin/complaints', A, () => all(`SELECT c.*, o.code, u.name customer FROM complaints c JOIN orders o ON o.id=c.order_id JOIN users u ON u.id=c.user_id ORDER BY (c.status='open') DESC, c.id DESC`));
route('POST', '/api/admin/complaints/:id', A, ({ params, body }) => {
  const c = get('SELECT * FROM complaints WHERE id=?', idp(params.id)); if (!c) throw new HttpError(404, 'Not found');
  run("UPDATE complaints SET status='resolved', resolution=? WHERE id=?", str(body.resolution, 3, 500, 'Resolution'), c.id);
  notify(c.user_id, `Your complaint was resolved: ${body.resolution}`, c.order_id); return { ok: true };
});
route('GET', '/api/admin/settings', A, () => settings());
route('PUT', '/api/admin/settings', A, ({ body }) => {
  const rules = { home_fee: [0, 5000], pickup_fee: [0, 5000], delivery_base: [0, 5000], delivery_free_km: [0, 100], delivery_per_km: [0, 500], commission_pct: [0, 60], stitch_days: [1, 60], service_radius_km: [1, 500], appt_capacity: [1, 50] };
  tx(() => {
    for (const [k, [lo, hi]] of Object.entries(rules)) if (body[k] !== undefined) run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', k, J(num(body[k], lo, hi, k)));
    if (body.slots) {
      const s = (Array.isArray(body.slots) ? body.slots : []).map(x => String(x).trim()).filter(Boolean);
      if (!s.length || s.length > 12) throw bad('Provide 1-12 time slots');
      run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', 'slots', J(s));
    }
  });
  return settings();
});
route('GET', '/api/admin/finance', A, () => {
  const d = "status='Delivered'";
  const sum = (col, w) => get(`SELECT COALESCE(SUM(${col}),0) s FROM orders WHERE ${w}`).s;
  const collected = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE type='payment'").s;
  const refunded = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE type='refund'").s;
  const tailors = all("SELECT u.id,u.name, COALESCE((SELECT SUM(tailor_payable) FROM orders o WHERE o.tailor_id=u.id AND o.status='Delivered'),0) earned, COALESCE((SELECT SUM(amount) FROM payouts p WHERE p.tailor_id=u.id),0) paid, t.upi, t.bank_account, t.bank_ifsc FROM users u JOIN tailors t ON t.user_id=u.id WHERE t.status IN ('approved','suspended')")
    .map(t => ({ ...t, balance: t.earned - t.paid }));
  return {
    collected, refunded, net_collected: collected - refunded,
    recognised: { // only delivered orders count as revenue
      commission: sum('commission', d), home_fees: sum('home_fee', d), fabric_margin: sum('fabric_charge-fabric_cost', d), platform_revenue: sum('platform_revenue', d),
      pass_through: sum('delivery_fee+pickup_fee', d), tailor_payable: sum('tailor_payable', d), fabric_cost: sum('fabric_cost', d)
    },
    tailors,
    transactions: all(`SELECT p.ts, p.type, p.amount, p.method, p.status, p.ref, o.code FROM payments p JOIN orders o ON o.id=p.order_id
      UNION ALL SELECT ts,'payout',amount,'manual','paid',note,NULL FROM payouts ORDER BY ts DESC LIMIT 100`)
  };
});
route('POST', '/api/admin/payouts', A, ({ body }) => {
  const tid = idp(body.tailor_id), amount = Math.round(num(body.amount, 1, 1e7, 'Amount'));
  if (!get("SELECT 1 x FROM tailors WHERE user_id=?", tid)) throw bad('Unknown tailor');
  const earned = get("SELECT COALESCE(SUM(tailor_payable),0) s FROM orders WHERE tailor_id=? AND status='Delivered'", tid).s;
  const paid = get('SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE tailor_id=?', tid).s;
  if (amount > earned - paid) throw bad('Amount exceeds the tailor\'s outstanding balance');
  run('INSERT INTO payouts(tailor_id,amount,note) VALUES(?,?,?)', tid, amount, optStr(body.note, 100, 'Note') || 'Payout');
  notify(tid, `Payout of Rs ${amount} recorded`); return { ok: true };
});
// content management
// Admin content: designs
route('POST', '/api/admin/designs', A, ({ body }) => {
  const name = str(body.name || 'Design', 2, 100, 'Name');
  const category_id = idp(body.category_id);
  const gender = ['unisex', 'men', 'women'].includes(body.gender) ? body.gender : 'unisex';
  const price = num(body.price, 0, 1000000, 'Price');
  const description = optStr(body.description, 1000, 'Description');
  const image_url = body.image_url ? String(body.image_url).trim() : null;
  const featured = body.featured ? 1 : 0;
  const active = body.active !== false ? 1 : 0;
  const photos = JSON.stringify(photoList(body.photos, 4));

  const id = Number(run(
    'INSERT INTO designs(name, category_id, gender, price, description, image_url, featured, active, photos) VALUES(?,?,?,?,?,?,?,?,?)',
    name, category_id, gender, price, description, image_url, featured, active, photos
  ).lastInsertRowid);

  return get('SELECT d.*, c.name AS category FROM designs d JOIN categories c ON c.id = d.category_id WHERE d.id=?', id);
});

route('PUT', '/api/admin/designs/:id', A, ({ params, body }) => {
  const id = idp(params.id);
  const existing = get('SELECT id FROM designs WHERE id=?', id);
  if (!existing) throw new HttpError(404, 'Design not found');

  const name = str(body.name || 'Design', 2, 100, 'Name');
  const category_id = idp(body.category_id);
  const gender = ['unisex', 'men', 'women'].includes(body.gender) ? body.gender : 'unisex';
  const price = num(body.price, 0, 1000000, 'Price');
  const description = optStr(body.description, 1000, 'Description');
  const image_url = body.image_url ? String(body.image_url).trim() : null;
  const featured = body.featured ? 1 : 0;
  const active = body.active !== false ? 1 : 0;
  const photos = JSON.stringify(photoList(body.photos, 4));

  run(
    'UPDATE designs SET name=?, category_id=?, gender=?, price=?, description=?, image_url=?, featured=?, active=?, photos=? WHERE id=?',
    name, category_id, gender, price, description, image_url, featured, active, photos, id
  );

  return get('SELECT d.*, c.name AS category FROM designs d JOIN categories c ON c.id = d.category_id WHERE d.id=?', id);
});

route('GET', '/api/admin/designs', A, () =>
  all(`SELECT d.*, c.name category
       FROM designs d
       JOIN categories c ON c.id = d.category_id
       ORDER BY d.id DESC`)
);

// Admin content: fabrics
route('GET', '/api/admin/fabrics', A, () =>
  all('SELECT * FROM fabrics ORDER BY id DESC')
    .map(f => ({ ...f, colors: P(f.colors, []) }))
);
// content management

// Get all designs
route('GET', '/api/admin/designs', A, () =>
  all(`SELECT d.*, c.name AS category
       FROM designs d
       JOIN categories c ON c.id = d.category_id
       ORDER BY d.id DESC`)
);

// Get all fabrics
route('GET', '/api/admin/fabrics', A, () =>
  all('SELECT * FROM fabrics ORDER BY id DESC')
    .map(f => ({ ...f, colors: P(f.colors, []) }))
);

// Existing categories route
route('GET', '/api/admin/categories', A, () =>
  all('SELECT * FROM categories ORDER BY sort,id')
    .map(c => ({ ...c, sizes: P(c.sizes, []), fields: P(c.fields, []) }))
);
route('GET', '/api/admin/categories', A, () => all('SELECT * FROM categories ORDER BY sort,id').map(c => ({ ...c, sizes: P(c.sizes, []), fields: P(c.fields, []) })));
function categoryInput(b) {
  const list = (v, label) => { const a = (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean); if (!a.length || a.length > 20) throw bad(`${label}: add 1-20 items`); return a; };
  return { name: str(b.name, 2, 40, 'Name'), sizes: list(b.sizes, 'Sizes'), fields: list(b.fields, 'Measurement fields'), fabric_m: num(b.fabric_m, 0.2, 20, 'Fabric metres'), active: b.active === false ? 0 : 1 };
}
route('POST', '/api/admin/categories', A, ({ body }) => {
  const c = categoryInput(body); const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cat';
  if (get('SELECT 1 x FROM categories WHERE slug=?', slug)) throw bad('A category with this name already exists');
  run('INSERT INTO categories(slug,name,sizes,fields,fabric_m,active,sort) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM categories))', slug, c.name, J(c.sizes), J(c.fields), c.fabric_m, c.active); return { ok: true };
});
route('PUT', '/api/admin/categories/:id', A, ({ params, body }) => {
  const c = categoryInput(body); run('UPDATE categories SET name=?,sizes=?,fields=?,fabric_m=?,active=? WHERE id=?', c.name, J(c.sizes), J(c.fields), c.fabric_m, c.active, idp(params.id)); return { ok: true };
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const PUB = __dirname;
const CSP = "default-src 'self'; img-src 'self' data: blob: https://res.cloudinary.com https://*.tile.openstreetmap.org https://unpkg.com https://*.razorpay.com https://images.unsplash.com https://images.pexels.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src https://fonts.gstatic.com; script-src 'self' https://unpkg.com https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString()); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(bad('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function serveFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' }); res.end(buf);
  });
}
console.log('PUBLIC DIRECTORY:', PUB);
console.log('INDEX EXISTS:', fs.existsSync(path.join(PUB, 'index.html')));
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://x'); const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      const r = routes.find(r => r.method === req.method && r.re.test(pathname));
      if (!r) throw new HttpError(404, 'Not found');
      const user = sessionUser(req);
      if (r.roles && (!user || !r.roles.includes(user.role))) throw new HttpError(user ? 403 : 401, user ? 'Not allowed' : 'Please log in');
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON required');
        body = await readBody(req);
      }
      const params = r.re.exec(pathname).groups || {};
      return sendJSON(res, 200, await r.fn({ user, body, params, query: Object.fromEntries(url.searchParams), res, req }) ?? {});
    }
    if (pathname.startsWith('/uploads/')) {
      const f = path.join(DATA_DIR, 'uploads', path.basename(pathname));
      if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(path.basename(pathname))) { res.writeHead(404); return res.end(); }
      return serveFile(res, f, 'public, max-age=86400');
    }
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const f = path.normalize(path.join(PUB, rel));
    if (f.startsWith(PUB + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f, 'no-cache');
    return serveFile(res, path.join(PUB, 'index.html'), 'no-cache'); // SPA fallback
  } catch (e) {
    if (e instanceof HttpError) return sendJSON(res, e.code, { error: e.message });
    console.error(e); sendJSON(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});
setInterval(() => { run('DELETE FROM sessions WHERE expires<?', Date.now()); run('DELETE FROM otps WHERE expires<?', Date.now()); run('DELETE FROM otp_log WHERE ts<?', Date.now() - 3600e3); }, 3600e3).unref();
if (require.main === module) server.listen(PORT, () => console.log(`Darzi running on http://localhost:${PORT}  (OTP: ${OTP_MODE}, payments: ${PAYMENT_MODE})`));
module.exports = server;
