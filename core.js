'use strict';
/* Core: i18n, helpers, API client, router, shared UI pieces. Everything hangs off global `D`. */
const D = { me: null, cfg: null, routes: [], actions: {}, forms: {}, changes: {}, draft: null, next: null };

// ---- i18n: add a new language by adding a key here and setting D.lang ----
D.lang = 'en';
D.STR = { en: {
  tagline: 'Your Style. Your Size. Your Choice.', designs: 'Designs', orders: 'My orders', profile: 'Profile', home: 'Home',
  login: 'Log in', logout: 'Log out', dashboard: 'Dashboard', admin: 'Admin', search_ph: 'Search shirts, kurtas, blouses…', search: 'Search',
  hero_h: 'Clothes that fit you, stitched by tailors near you.', hero_p: 'Pick a design, choose your fabric, share your size or let us measure you at home. We pick up, stitch and deliver.',
  start: 'Browse designs', categories: 'Shop by category', featured: 'Featured designs', services: 'Our services', how: 'How it works',
  mens: "Men's clothing", womens: "Women's clothing", continue: 'Continue', back: 'Back', save: 'Save', cancel: 'Cancel'
} };
const t = (k) => (D.STR[D.lang] && D.STR[D.lang][k]) || D.STR.en[k] || k;

// ---- helpers ----
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const fdate = (s) => { if (!s) return ''; const d = new Date(/Z|\+/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
const ftime = (s) => { const d = new Date(/Z|\+/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
const ymd = (offset) => { const d = new Date(Date.now() + 5.5 * 3600e3 + offset * 864e5); return d.toISOString().slice(0, 10); };
const stars = (n) => n == null ? '—' : '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)) + ` ${n}`;

async function api(method, url, body) {
  let r;
  try { r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Cannot reach the server. Check your connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
  return j;
}
function toast(msg, err) {
  const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), err ? 5000 : 3000);
}
const fail = (e) => { if (e.status === 401) { D.me = null; renderChrome(); go('#/login'); } toast(e.message, true); };
async function guard(fn) { try { return await fn(); } catch (e) { fail(e); } }
function busy(btn, on) { if (btn) { btn.disabled = on; if (on) { btn.dataset.t = btn.textContent; btn.textContent = 'Please wait…'; } else if (btn.dataset.t) btn.textContent = btn.dataset.t; } }

// ---- modal ----
function modal(html) {
  closeModal();
  const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('mousedown', e => { if (e.target === bg) closeModal(); });
  document.body.append(bg); const f = $('input,select,textarea,button', bg); if (f) f.focus();
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ---- router ----
const route = (re, fn, roles) => D.routes.push({ re: new RegExp('^' + re + '$'), fn, roles });
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
function parseHash() {
  const h = location.hash.slice(1) || '/'; const [p, qs] = h.split('?');
  return { path: p, q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
function view(html, after) {
  const app = $('#app');
  app.classList.remove('view-in');
  void app.offsetWidth;
  app.innerHTML = html;
  app.classList.add('view-in');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  staggerReveal();
  if (after) after();
}
function staggerReveal() {
  $$('#app .design, #app .catcard, #app .card, #app .stat').forEach((el, i) => {
    el.style.setProperty('--stagger', Math.min(i, 12));
    el.classList.add('reveal-item');
  });
}
async function render() {
  closeModal();
  const app = $('#app');
  app.classList.add('view-out');
  await new Promise(r => setTimeout(r, 110));
  app.classList.remove('view-out');
  const { path, q } = parseHash();
  for (const r of D.routes) {
    const m = r.re.exec(path); if (!m) continue;
    if (r.roles && (!D.me || !r.roles.includes(D.me.role))) { D.next = location.hash; return go('#/login'); }
    view('<div class="spin"><div class="loader"></div><p class="muted small" style="margin-top:12px">Preparing atelier…</p></div>');
    try { await r.fn(m, q); } catch (e) { if (e.status === 401) { D.me = null; renderChrome(); D.next = location.hash; return go('#/login'); } view(`<div class="empty"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back home</a></div>`); }
    renderChrome(); return;
  }
  view('<div class="empty"><h2>Page not found</h2><a class="btn" href="#/">Go home</a></div>');
}

window.addEventListener('hashchange', render);

// ---- delegated events ----
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = D.actions[el.dataset.act]; if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault(); const fn = D.forms[f.dataset.form]; if (fn) fn(f, e);
});
document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (el && D.changes[el.dataset.change]) D.changes[el.dataset.change](el, e); });
document.addEventListener('focusin', e => { const el = e.target.closest('[data-focus]'); if (el && D.changes[el.dataset.focus]) D.changes[el.dataset.focus](el, e); });

const formData = (f) => Object.fromEntries(new FormData(f).entries());

// ---- uploads ----
function readAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
async function shrink(file) { // downscale big photos in the browser so uploads stay quick on mobile data
  const url = await readAsDataURL(file);
  if (file.size < 600 * 1024) return url;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const s = Math.min(1, 1400 / Math.max(img.width, img.height)); const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
const GARMENT_PHOTO = {
async function uploadFiles(files, max) {
  const urls = [];
  for (const f of [...files].slice(0, max)) { if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast('Only PNG, JPG or WebP images are allowed', true); continue; } urls.push(await shrink(f)); }
  return urls;
}
function photoField(name, label, urls = [], max = 4) {
  return `<div class="field" data-photos="${name}" data-max="${max}"><label>${label}</label>
    <input type="hidden" name="${name}" value="${esc(JSON.stringify(urls))}">
    <div class="thumbs">${urls.map(u => `<img src="${esc(u)}" alt="">`).join('')}</div>
    <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-change="photos" style="margin-top:8px">
    <div class="hint">Up to ${max} photos, PNG/JPG/WebP.</div></div>`;
}
D.changes.photos = async (el) => {
  const box = el.closest('[data-photos]'), hid = $('input[type=hidden]', box), max = +box.dataset.max;
  const cur = JSON.parse(hid.value || '[]'); el.disabled = true;
  try { const add = await uploadFiles(el.files, max - cur.length); const all = cur.concat(add).slice(0, max); hid.value = JSON.stringify(all); $('.thumbs', box).innerHTML = all.map(u => `<img src="${esc(u)}" alt="">`).join(''); }
  catch (e) { fail(e); } finally { el.disabled = false; el.value = ''; }
};

// ---- garment photography ----
const GARMENT_PHOTO = {
  shirts: 'https://images.pexels.com/photos/297933/pexels-photo-297933.jpeg?auto=compress&cs=tinysrgb&w=800',
  pants: 'https://images.pexels.com/photos/1598507/pexels-photo-1598507.jpeg?auto=compress&cs=tinysrgb&w=800',
  kurtas: 'https://images.pexels.com/photos/2065195/pexels-photo-2065195.jpeg?auto=compress&cs=tinysrgb&w=800',
  suits: 'https://images.pexels.com/photos/325876/pexels-photo-325876.jpeg?auto=compress&cs=tinysrgb&w=800',
  blouses: 'https://images.pexels.com/photos/6311392/pexels-photo-6311392.jpeg?auto=compress&cs=tinysrgb&w=800',
  other: 'https://images.pexels.com/photos/1043474/pexels-photo-1043474.jpeg?auto=compress&cs=tinysrgb&w=800'
};
function garment(slug, color, cls = '') {
  const src = GARMENT_PHOTO[slug] || GARMENT_PHOTO.other;
  return `<div class="garment-thumb ${cls}" style="--tint:${esc(color || '#e9e0cc')}"><img src="${src}" alt="${esc(slug)}" loading="lazy"></div>`;
}
const catSlug = (id) => { const c = D.cfg && D.cfg.categories.find(c => c.id === id); return c ? c.slug : 'other'; };
function pic(d) {
  const src = d.image_url || GARMENT_PHOTO[catSlug(d.category_id)] || GARMENT_PHOTO.other;
  return `<img src="${esc(src)}" alt="${esc(d.name)}" loading="lazy" onload="this.classList.add('loaded')">`;
}
function guideCard(field) {
  const [text, d] = guideFor(field);
  return `<div class="guide" aria-live="polite"><svg viewBox="0 0 200 320" width="120" height="190" aria-hidden="true"><g fill="#e3d9c3" stroke="#8a8f84" stroke-width="2"><circle cx="100" cy="30" r="18"/><path d="M62 62h76l14 20 22 78-12 4-20-62v66l10 130h-30l-8-110-8 110H72l10-130v-66l-20 62-12-4 22-78z"/></g>
    <path d="${d}" fill="none" stroke="#1f3d2f" stroke-width="5" stroke-linecap="round" stroke-dasharray="1 0"/></svg>
    <div><b>${esc(field)}</b><p class="small" style="margin:4px 0 0">${esc(text)}</p><p class="hint">Use a soft tape. Measure in inches over light clothing.</p></div></div>`;
}

// ---- map (Leaflet loaded on demand; manual coordinates remain as fallback) ----
let leafletP;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletP) return leafletP;
  leafletP = new Promise((res, rej) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    l.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; l.crossOrigin = ''; document.head.append(l);
    const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; s.crossOrigin = ''; s.onload = res; s.onerror = () => { leafletP = null; rej(new Error('Map could not load')); };
    document.head.append(s);
  });
  return leafletP;
}
async function mountMap(el, latIn, lngIn) {
  try { await loadLeaflet(); } catch { el.innerHTML = '<p class="hint" style="padding:14px">The map could not load. Enter the coordinates below, or continue without them.</p>'; return; }
  const hub = D.cfg.hub; const lat = parseFloat(latIn.value), lng = parseFloat(lngIn.value);
  const map = L.map(el).setView([isNaN(lat) ? hub.lat : lat, isNaN(lng) ? hub.lng : lng], isNaN(lat) ? 11 : 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  L.circle([hub.lat, hub.lng], { radius: hub.radius_km * 1000, color: '#1f3d2f', weight: 1, fillOpacity: .04, interactive: false }).addTo(map);
  let mk = isNaN(lat) ? null : L.marker([lat, lng], { draggable: true }).addTo(map);
  const set = (la, ln) => { latIn.value = la.toFixed(6); lngIn.value = ln.toFixed(6); if (!mk) { mk = L.marker([la, ln], { draggable: true }).addTo(map); mk.on('dragend', () => { const p = mk.getLatLng(); set(p.lat, p.lng); }); } else mk.setLatLng([la, ln]); };
  if (mk) mk.on('dragend', () => { const p = mk.getLatLng(); set(p.lat, p.lng); });
  map.on('click', e => set(e.latlng.lat, e.latlng.lng));
  el._locate = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => { set(p.coords.latitude, p.coords.longitude); map.setView([p.coords.latitude, p.coords.longitude], 16); }, () => toast('Could not get your location', true)) : toast('Location is not available on this device', true);
  setTimeout(() => map.invalidateSize(), 100);
}
function addressForm(a = {}, formName = 'address') {
  return `<form data-form="${formName}" class="stack" ${a.id ? `data-id="${a.id}"` : ''}>
    <div class="form-grid"><div class="field"><label>Label</label><input name="label" value="${esc(a.label || 'Home')}" maxlength="30"></div>
    <div class="field"><label>Pincode</label><input name="pincode" inputmode="numeric" maxlength="6" value="${esc(a.pincode || '')}" placeholder="110001"></div></div>
    <div class="field"><label>Full address</label><textarea name="line" required maxlength="200" placeholder="House no., street, area">${esc(a.line || '')}</textarea></div>
    <div class="field"><label>Landmark (optional)</label><input name="landmark" value="${esc(a.landmark || '')}" maxlength="100"></div>
    <div><label>Pin your location on the map</label><div class="map" data-map></div>
      <div class="row"><button type="button" class="btn ghost sm" data-act="locate">Use my current location</button><span class="hint">Tap the map to drop a pin. This sets your delivery charge.</span></div>
      <details style="margin-top:8px"><summary class="small">Enter coordinates manually</summary><div class="form-grid" style="margin-top:8px">
      <div class="field"><label>Latitude</label><input name="lat" inputmode="decimal" value="${a.lat ?? ''}"></div><div class="field"><label>Longitude</label><input name="lng" inputmode="decimal" value="${a.lng ?? ''}"></div></div></details></div>
    <label class="row" style="font-weight:400"><input type="checkbox" name="is_default" ${a.is_default ? 'checked' : ''}> Make this my default address</label>
    <div class="row"><button class="btn">Save address</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`;
}
function openAddressModal(a) {
  modal(`<h3>${a ? 'Edit address' : 'Add address'}</h3>${addressForm(a || {})}`);
  const f = $('#modal form'); mountMap($('[data-map]', f), f.lat, f.lng);
}
D.actions['close-modal'] = () => closeModal();
D.actions.locate = (el) => { const m = el.closest('form').querySelector('[data-map]'); if (m._locate) m._locate(); else toast('Map is not ready yet', true); };

// ---- status chip ----
function statusTag(s) {
  const cls = s === 'Delivered' ? 'ok' : s === 'Cancelled' ? 'bad' : s === 'Awaiting Payment' ? 'warn' : 'dark';
  return `<span class="tag ${cls}">${esc(s)}</span>`;
}
function priceRows(p) {
  const r = (l, v, note) => v || l === 'Stitching charges' ? `<div class="sumrow"><span>${l}${note ? `<br><small class="muted">${note}</small>` : ''}</span><b>${inr(v)}</b></div>` : '';
  return r('Stitching charges', p.stitching) + r('Fabric charges', p.fabric || p.fabric_charge) + r('Home measurement', p.home_fee || 0) +
    r('Fabric pickup', p.pickup || p.pickup_fee || 0) + r('Delivery', p.delivery || p.delivery_fee || 0) + `<div class="sumrow total"><span>Total</span><span>${inr(p.total)}</span></div>`;
}
function measureTable(m) {
  return m ? `<table><tbody>${Object.entries(m).map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b> in</td></tr>`).join('')}</tbody></table>` : '';
}
const ICON = {
  home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-8 9 8v10H3z"/></svg>',
  grid: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  bag: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 8h14l-1 13H6z"/><path d="M9 8a3 3 0 016 0"/></svg>',
  user: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 15-5 16 0"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z"/></svg>',
  heartO: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z"/></svg>',
  bell: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 17V11a6 6 0 0112 0v6l2 2H4z"/><path d="M10 21h4"/></svg>'
};

// ---- chrome (header, footer, tab bar) ----
function renderChrome() {
  const me = D.me, path = parseHash().path;
  const on = (p) => path === p || path.startsWith(p + '/') ? 'on' : '';
  let links = '';
  if (!me || me.role === 'customer') links = `<a class="hide-m ${on('/designs')}" href="#/designs">${t('designs')}</a>${me ? `<a class="hide-m ${on('/orders')}" href="#/orders">${t('orders')}</a><a class="hide-m ${on('/profile')}" href="#/profile">${t('profile')}</a>` : ''}`;
  if (me && me.role === 'tailor') links = `<a class="${on('/tailor')}" href="#/tailor">${t('dashboard')}</a>`;
  if (me && me.role === 'admin') links = `<a class="${on('/admin')}" href="#/admin">${t('admin')}</a>`;
  $('#header').innerHTML = `<a class="brand" href="#/" aria-label="${esc(D.cfg.brand)} home">${esc(D.cfg.brand)}<small>Custom tailoring</small></a>
    <nav class="nav" aria-label="Primary">${links}
    ${me ? `<a class="bell" href="#/notifications" aria-label="Notifications">${ICON.bell}${me.unread ? `<b>${me.unread}</b>` : ''}</a><button class="link hide-m" data-act="logout">${t('logout')}</button>` : `<a class="btn sm" href="#/login">${t('login')}</a>`}</nav>`;
  $('#footer').innerHTML = `<div class="row between"><div><b>${esc(D.cfg.brand)}</b> · ${t('tagline')}<br>Serving ${esc(D.cfg.hub.name)} and nearby areas of Delhi.</div>
    <div class="small">${!me ? '<a href="#/login?role=tailor">Join as a tailor</a><br>' : ''}${me ? '<a href="#" data-act="logout">Log out</a>' : ''}</div></div>`;
  const tb = (!me || me.role === 'customer') ? [['/', ICON.home, t('home')], ['/designs', ICON.grid, t('designs')], ['/orders', ICON.bag, t('orders')], ['/profile', ICON.user, t('profile')]]
    : me.role === 'tailor' ? [['/tailor', ICON.grid, t('dashboard')], ['/notifications', ICON.bell, 'Alerts']] : [['/admin', ICON.grid, t('admin')], ['/notifications', ICON.bell, 'Alerts']];
  $('#tabbar').innerHTML = tb.map(([p, i, l]) => `<a href="#${p}" class="${p === '/' ? (path === '/' ? 'on' : '') : on(p)}">${i}${l}</a>`).join('');
}
D.actions.logout = async () => { await guard(() => api('POST', '/api/logout')); D.me = null; go('#/'); toast('You have been logged out'); };

// ---- auth ----
route('/login', async (m, q) => {
  if (D.me) return go(D.me.role === 'tailor' ? '#/tailor' : D.me.role === 'admin' ? '#/admin' : '#/');
  D.auth = { intent: q.role === 'tailor' ? 'tailor' : 'customer', step: 'mobile' }; drawLogin();
});
function drawLogin(extra = {}) {
  const a = D.auth, tailor = a.intent === 'tailor';
  view(`<div class="login card stack"><div><div class="eyebrow">${tailor ? 'For tailors' : 'Welcome'}</div><h2>${tailor ? 'Join as a tailor' : 'Log in or sign up'}</h2>
    <p class="muted">${a.step === 'mobile' ? 'Enter your mobile number. We will send a 6-digit OTP.' : `Enter the OTP sent to +91 ${esc(a.mobile)}.`}</p></div>
    ${a.step === 'mobile' ? `<form data-form="otp-request" class="stack"><div class="field"><label for="mob">Mobile number</label><div class="row" style="flex-wrap:nowrap"><span class="tag" style="padding:12px">+91</span><input id="mob" name="mobile" inputmode="numeric" maxlength="10" autocomplete="tel-national" required placeholder="98XXXXXXXX" value="${esc(a.mobile || '')}"></div></div>
      <button class="btn block">Send OTP</button></form>` : `
      ${a.consoleOtp ? `<div class="banner"><b>TEST MODE.</b> The OTP for this account is shown in the server window on the computer that runs Darzi.</div>` : ''}
      ${a.devOtp ? `<div class="banner"><b>TEST MODE.</b> No SMS is sent in this build. Your OTP is <span class="otpbox">${esc(a.devOtp)}</span></div>` : ''}
      <form data-form="otp-verify" class="stack"><div class="field"><label for="otp">OTP</label><input id="otp" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required placeholder="6-digit code"></div>
      ${a.needsName ? `<div class="banner info">New here? Tell us your name to create your account.</div><div class="field"><label>Full name</label><input name="name" required minlength="2" maxlength="60" autocomplete="name"></div><div class="field"><label>Email (optional)</label><input name="email" type="email" autocomplete="email"></div>` : ''}
      <button class="btn block">${a.needsName ? 'Create account' : 'Verify and continue'}</button>
      <button type="button" class="btn ghost block" data-act="otp-change">Use a different number</button></form>`}
    <p class="small muted center">${tailor ? 'Already a customer? <a href="#/login">Customer login</a>' : 'Are you a tailor? <a href="#/login?role=tailor">Join as a tailor</a>'}</p></div>`,
    () => { const i = $('input'); if (i) i.focus(); });
}
D.forms['otp-request'] = async (f) => {
  const mobile = f.mobile.value.trim(), b = $('button', f); busy(b, true);
  try { const r = await api('POST', '/api/auth/request-otp', { mobile }); D.auth.mobile = mobile; D.auth.step = 'otp'; D.auth.devOtp = r.testMode ? r.devOtp : null; D.auth.consoleOtp = !!r.console; drawLogin(); }
  catch (e) { toast(e.message, true); busy(b, false); }
};
D.actions['otp-change'] = () => { D.auth.step = 'mobile'; D.auth.needsName = false; drawLogin(); };
D.forms['otp-verify'] = async (f) => {
  const b = $('button', f); busy(b, true);
  try {
    const d = formData(f); const r = await api('POST', '/api/auth/verify', { mobile: D.auth.mobile, code: d.code, name: d.name, email: d.email, intent: D.auth.intent });
    if (r.needsName) { D.auth.needsName = true; busy(b, false); return drawLogin(); }
    D.me = r; const next = D.next; D.next = null; toast(`Welcome, ${r.name.split(' ')[0]}`);
    go(next || (r.role === 'tailor' ? '#/tailor' : r.role === 'admin' ? '#/admin' : '#/'));
  } catch (e) { toast(e.message, true); busy(b, false); }
};

// ---- notifications (all roles) ----
route('/notifications', async () => {
  const list = await api('GET', '/api/notifications'); await api('POST', '/api/notifications/read'); D.me.unread = 0;
  const link = (n) => n.order_id ? (D.me.role === 'admin' ? `#/admin/orders/${n.order_id}` : D.me.role === 'tailor' ? '#/tailor' : `#/orders/${n.order_id}`) : null;
  view(`<h2>Notifications</h2>${list.length ? `<div class="stack">${list.map(n => `<div class="card ${n.read ? 'flat' : ''}"><div class="row between"><div>${link(n) ? `<a href="${link(n)}">${esc(n.text)}</a>` : esc(n.text)}</div><span class="small muted">${ftime(n.ts)}</span></div></div>`).join('')}</div>` : '<div class="empty">Nothing here yet. Order updates will appear here.</div>'}`);
}, ['customer', 'tailor', 'admin']);
const payLabel = (s) => (s === 'cod' ? 'pay on delivery' : s);
