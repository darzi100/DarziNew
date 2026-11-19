'use strict';
/* Customer experience: home, designs, order wizard, orders, profile. */
const isCust = () => D.me && D.me.role === 'customer';
const needCustomer = () => { if (!D.me) { D.next = location.hash; go('#/login'); return false; } if (D.me.role !== 'customer') { toast('Please use a customer account for this', true); go('#/'); return false; } return true; };

function designCard(d, favs) {
  const on = favs && favs.has(d.id);
  return `<div class="design"><a href="#/design/${d.id}" style="display:block;color:inherit;text-decoration:none"><div class="pic">${pic(d)}</div>
    <div class="info"><b>${esc(d.name)}</b><span class="small muted">${esc(d.category)}${d.gender !== 'unisex' ? ' · ' + (d.gender === 'men' ? 'Men' : 'Women') : ''}</span><div class="price">from ${inr(d.price)}</div></div></a>
    <button class="fav ${on ? 'on' : ''}" data-act="fav" data-id="${d.id}" aria-label="${on ? 'Remove from' : 'Add to'} favourites" aria-pressed="${!!on}">${on ? ICON.heart : ICON.heartO}</button></div>`;
}
async function loadFavs() { if (!isCust()) return new Set(); try { return new Set((await api('GET', '/api/favorites')).map(f => f.id)); } catch { return new Set(); } }
D.actions.fav = async (el) => {
  if (!isCust()) { D.next = location.hash; toast('Log in to save favourites'); return go('#/login'); }
  const r = await guard(() => api('POST', '/api/favorites/' + el.dataset.id)); if (!r) return;
  el.classList.toggle('on', r.favorite); el.innerHTML = r.favorite ? ICON.heart : ICON.heartO; el.setAttribute('aria-pressed', r.favorite);
  if (parseHash().path === '/profile') render();
};

// ---------- home ----------
route('/', async () => {
  const [feat, orders] = await Promise.all([api('GET', '/api/designs?featured=1'), isCust() ? api('GET', '/api/orders').catch(() => []) : []]);
  const favs = await loadFavs(), cats = D.cfg.categories;
  const popular = [...cats].filter(c => c.orders > 0).sort((a, b) => b.orders - a.orders).slice(0, 3);
  view(`
  <section class="hero"><div><div class="eyebrow">${esc(D.cfg.brand)} · ${esc(D.cfg.hub.name.split(',').pop().trim())}</div><h1>${t('hero_h')}</h1><p class="lead">${t('hero_p')}</p>
    <form class="search" data-form="search" role="search"><input name="q" placeholder="${t('search_ph')}" aria-label="Search designs"><button class="btn">${t('search')}</button></form>
    <div class="row"><a class="btn" href="#/designs">${t('start')}</a><span class="small muted">${t('tagline')}</span></div></div>
    <div class="art"><img src="https://images.pexels.com/photos/325876/pexels-photo-325876.jpeg?auto=compress&cs=tinysrgb&w=900" alt="Bespoke Tailoring"></div></section>
  ${orders.length ? `<section class="block"><div class="row between"><h2>Your recent orders</h2><a href="#/orders">View all</a></div><div class="grid g2">${orders.slice(0, 3).map(orderCard).join('')}</div></section>` : ''}
  <section class="block"><h2>${t('categories')}</h2>
    <div class="grid g3"><a class="catcard" href="#/designs?g=men">${garment('shirts', '#c9d6df')}<b>${t('mens')}</b></a><a class="catcard" href="#/designs?g=women">${garment('blouses', '#c98f8a')}<b>${t('womens')}</b></a>
    ${cats.map(c => `<a class="catcard" href="#/designs?cat=${c.id}">${garment(c.slug, '#d9cdb4')}<b>${esc(c.name)}</b></a>`).join('')}</div>
    ${popular.length ? `<p class="small muted" style="margin-top:12px">Popular right now: ${popular.map(c => `<a href="#/designs?cat=${c.id}">${esc(c.name)}</a>`).join(', ')}</p>` : ''}</section>
  <section class="block"><div class="row between"><h2>${t('featured')}</h2><a href="#/designs">See all designs</a></div><div class="grid g3" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${feat.map(d => designCard(d, favs)).join('')}</div></section>
  <section class="block"><h2>${t('services')}</h2><div class="grid g2">
    <div class="card"><h3>Custom stitching</h3><p class="muted">Choose from our design gallery or upload a photo of what you want. Local tailors stitch it to your size.</p></div>
    <div class="card"><h3>Home measurement</h3><p class="muted">Not sure how to measure? Book a visit for ${inr(D.cfg.fees.home_fee)} and we will take your measurements at home.</p></div>
    <div class="card"><h3>Fabric and pickup</h3><p class="muted">Pick fabric from us, or hand over your own. We collect it from your door.</p></div>
    <div class="card"><h3>Doorstep delivery</h3><p class="muted">Delivery from ${inr(D.cfg.fees.delivery_base)}, shown up front. No hidden charges.</p></div></div></section>
  <section class="block"><h2>${t('how')}</h2><div class="grid g2 steps3">
    <div class="card"><h3>Choose</h3><p class="muted">Pick a design, fabric and colour.</p></div><div class="card"><h3>Share your size</h3><p class="muted">Enter measurements, pick a standard size, or book a home visit.</p></div>
    <div class="card"><h3>We stitch</h3><p class="muted">A verified tailor makes it. You track every step.</p></div><div class="card"><h3>Delivered</h3><p class="muted">Receive it at home and rate your tailor.</p></div></div></section>`);
});
D.forms.search = (f) => go('#/designs?q=' + encodeURIComponent(f.q.value.trim()));


// ---------- designs ----------
route('/designs', async (m, q) => {
  const qs = new URLSearchParams(); ['cat', 'g', 'q'].forEach(k => q[k] && qs.set(k === 'cat' ? 'category' : k === 'g' ? 'gender' : 'q', q[k]));
  const [list, favs] = await Promise.all([api('GET', '/api/designs?' + qs), loadFavs()]);
  const link = (o) => '#/designs?' + new URLSearchParams({ ...q, ...o }).toString().replace(/&?\w+=(&|$)/g, '$1');
  const chip = (label, on, href) => `<a class="chip ${on ? 'on' : ''}" href="${href}" style="text-decoration:none">${label}</a>`;
  view(`<h2>Design gallery</h2>
    <form class="search" data-form="search" role="search" style="max-width:none"><input name="q" value="${esc(q.q || '')}" placeholder="${t('search_ph')}" aria-label="Search designs"><button class="btn">${t('search')}</button></form>
    <div class="chips" style="margin-bottom:10px">${chip('All', !q.g, link({ g: '' }))}${chip("Men's", q.g === 'men', link({ g: 'men' }))}${chip("Women's", q.g === 'women', link({ g: 'women' }))}</div>
    <div class="chips" style="margin-bottom:20px">${chip('All categories', !q.cat, link({ cat: '' }))}${D.cfg.categories.map(c => chip(esc(c.name), q.cat == c.id, link({ cat: c.id }))).join('')}</div>
    ${list.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${list.map(d => designCard(d, favs)).join('')}</div>` : '<div class="empty">No designs match your search. Try another word or category.</div>'}`);
});
route('/design/(\\d+)', async (m) => {
  const d = await api('GET', '/api/designs/' + m[1]); const favs = await loadFavs(); const cat = D.cfg.categories.find(c => c.id === d.category_id);
  view(`<a href="#/designs">← All designs</a><div class="cols" style="margin-top:14px;grid-template-columns:1fr 1fr"><div class="design" style="cursor:default"><div class="pic" style="aspect-ratio:1/1">${pic(d)}</div>
    <button class="fav ${favs.has(d.id) ? 'on' : ''}" data-act="fav" data-id="${d.id}" aria-label="Favourite">${favs.has(d.id) ? ICON.heart : ICON.heartO}</button></div>
    <div class="stack"><div><span class="tag">${esc(d.category)}</span></div><h1 style="font-size:2.4rem">${esc(d.name)}</h1><p>${esc(d.description || '')}</p>
    <div><div class="muted small">Stitching charge</div><div class="price" style="font-size:1.8rem">${inr(d.price)}</div><p class="hint">Fabric, home measurement, pickup and delivery are extra and shown before you pay. This design needs about ${cat ? cat.fabric_m : '?'} m of fabric.</p></div>
    <a class="btn block" href="#/order/${d.id}">Customise and order</a></div></div>`);
});

// ---------- order wizard ----------
const STEPS = ['Fabric', 'Measurements', 'Address', 'Details', 'Review'];
route('/order/(\\d+)', async (m) => {
  if (!needCustomer()) return;
  const id = +m[1]; const design = await api('GET', '/api/designs/' + id);
  const [fabrics, addrs, saved] = await Promise.all([api('GET', '/api/fabrics'), api('GET', '/api/addresses'), api('GET', '/api/measurements')]);
  D.fabrics = fabrics; D.addrs = addrs; D.saved = saved;
  if (!D.draft || D.draft.design.id !== id) D.draft = { design, step: 1, own: false, fabric_id: null, color: '', own_color: '', mode: 'standard', size: '', meas: {}, appt_date: '', appt_slot: '', slots: null, address_id: (addrs.find(a => a.is_default) || addrs[0] || {}).id || null, notes: '', refs: [], saveName: '' };
  D.draft.design = design; drawWizard();
});
const dcat = () => D.cfg.categories.find(c => c.id === D.draft.design.category_id);

function collect() {
  const d = D.draft, f = $('#wz'); if (!f) return;
  const n = (name) => $(`[name="${name}"]`, f);
  if (d.step === 1 && d.own && n('own_color')) d.own_color = n('own_color').value.trim();
  if (d.step === 2) {
    if (d.mode === 'self') $$('[data-mf]', f).forEach(i => d.meas[i.dataset.mf] = i.value);
    if (n('save_chk')) { d.saveChk = n('save_chk').checked; const s = n('save_name').value.trim(); d.saveName = d.saveChk ? s : ''; }
  }
  if (d.step === 4 && n('notes')) { d.notes = n('notes').value; d.refs = JSON.parse(n('refs').value || '[]'); }
}
function drawWizard() {
  const d = D.draft, c = dcat();
  const body = [null, stepFabric, stepMeasure, stepAddress, stepDetails, stepReview][d.step]();
  view(`<a href="#/design/${d.design.id}">← ${esc(d.design.name)}</a>
    <div class="row between" style="margin:12px 0"><h2 style="margin:0">Customise your ${esc(c ? c.name.toLowerCase() : 'order')}</h2><span class="muted small">Step ${d.step} of 5 · ${STEPS[d.step - 1]}</span></div>
    <div class="progress" aria-hidden="true">${STEPS.map((s, i) => `<i class="${i < d.step ? 'on' : ''}"></i>`).join('')}</div>
    <div class="cols"><div><div class="card stack" id="wz">${body}</div>
    <div class="row between" style="margin-top:16px">${d.step > 1 ? `<button class="btn ghost" data-act="wz-back">${t('back')}</button>` : '<span></span>'}${d.step < 5 ? `<button class="btn" data-act="wz-next">${t('continue')}</button>` : `<button class="btn" data-act="wz-place">Place order and pay</button>`}</div></div>
    <aside class="card" aria-label="Your selection"><div class="design" style="border:0;background:none"><div class="pic" style="border-radius:12px;aspect-ratio:4/3">${pic(d.design)}</div></div><h3 style="margin-top:10px">${esc(d.design.name)}</h3>
    <div class="sumrow"><span>Stitching</span><b>${inr(d.design.price)}</b></div>${sideFabric()}<p class="hint" style="margin-top:10px">Pickup, home measurement and delivery charges are added as you choose. The full total is shown at the last step.</p></aside></div>`);
}
function sideFabric() {
  const d = D.draft, c = dcat();
  if (d.own) return `<div class="sumrow"><span>Fabric</span><b>Your own</b></div>`;
  const f = D.fabrics.find(x => x.id === d.fabric_id); if (!f) return '';
  return `<div class="sumrow"><span>${esc(f.name)}, ${esc(d.color)}</span><b>${inr(Math.round(f.price_per_m * c.fabric_m))}</b></div>`;
}
function stepFabric() {
  const d = D.draft, c = dcat();
  return `<div class="grid g2"><label class="pick ${!d.own ? 'on' : ''}" data-act="own-off"><b>Choose fabric from us</b><span class="small muted">Browse fabrics and colours below.</span></label>
    <label class="pick ${d.own ? 'on' : ''}" data-act="own-on"><b>I will give my own fabric</b><span class="small muted">We collect it from your address.</span></label></div>
    ${d.own ? `<div class="banner info"><b>How your own fabric works</b><ol style="margin:8px 0 0 18px;padding:0"><li>Keep at least <b>${c.fabric_m} m</b> of fabric ready for this design.</li><li>After you order and pay, we collect the fabric from your delivery address. A pickup charge applies and is shown in your total.</li><li>The tailor starts only after your fabric has been collected. You can see the pickup status on your order page.</li></ol></div>
      <div class="field"><label>Fabric colour or description (optional)</label><input name="own_color" maxlength="40" value="${esc(d.own_color)}" placeholder="e.g. Maroon silk"></div>` :
    `<div class="stack">${D.fabrics.map(f => `<div class="card flat" style="${f.in_stock ? '' : 'opacity:.55'}"><div class="row between"><div><b>${esc(f.name)}</b><div class="small muted">${esc(f.description || '')}</div></div>
      <div class="right"><div class="price">${inr(Math.round(f.price_per_m * c.fabric_m))}</div><div class="small muted">${inr(f.price_per_m)}/m · ${c.fabric_m} m needed</div></div></div>
      ${f.in_stock ? `<div class="swatches" style="margin-top:10px" role="radiogroup" aria-label="${esc(f.name)} colours">${f.colors.map(col => `<button type="button" class="sw ${d.fabric_id === f.id && d.color === col.name ? 'on' : ''}" style="background:${esc(col.hex)}" data-act="pick-fabric" data-id="${f.id}" data-color="${esc(col.name)}" title="${esc(col.name)}" aria-label="${esc(col.name)}" role="radio" aria-checked="${d.fabric_id === f.id && d.color === col.name}"></button>`).join('')}</div>
      ${d.fabric_id === f.id ? `<div class="small" style="margin-top:6px">Selected: <b>${esc(d.color)}</b></div>` : ''}` : '<div class="tag bad" style="margin-top:8px">Out of stock</div>'}</div>`).join('')}</div>`}`;
}
D.actions['own-on'] = () => { collect(); D.draft.own = true; D.draft.fabric_id = null; D.draft.color = ''; drawWizard(); };
D.actions['own-off'] = () => { collect(); D.draft.own = false; drawWizard(); };
D.actions['pick-fabric'] = (el) => { D.draft.fabric_id = +el.dataset.id; D.draft.color = el.dataset.color; drawWizard(); };

function stepMeasure() {
  const d = D.draft, c = dcat(), f = D.cfg.fees;
  const opt = (m, title, sub) => `<label class="pick ${d.mode === m ? 'on' : ''}" data-act="mode" data-m="${m}"><b>${title}</b><span class="small muted">${sub}</span></label>`;
  let inner = '';
  if (d.mode === 'standard') inner = `<div class="field"><label>Select your size</label><div class="chips" role="radiogroup">${c.sizes.map(s => `<button type="button" class="chip ${d.size === s ? 'on' : ''}" data-act="pick-size" data-s="${esc(s)}" role="radio" aria-checked="${d.size === s}">${esc(s)}</button>`).join('')}</div>
    <p class="hint">Standard sizes use our size chart for ${esc(c.name.toLowerCase())}. Choose self measurement for the best fit.</p></div>`;
  if (d.mode === 'self') {
    const mine = D.saved.filter(s => s.category_id === c.id);
    inner = `${mine.length ? `<div class="field"><label>Use saved measurements</label><select data-change="apply-saved"><option value="">Choose…</option>${mine.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></div>` : ''}
      <div class="form-grid">${c.fields.map(fl => `<div class="field"><label>${esc(fl)} (inches)</label><input type="number" inputmode="decimal" step="0.25" min="3" max="120" data-mf="${esc(fl)}" data-focus="guide" value="${esc(d.meas[fl] || '')}"></div>`).join('')}</div>
      <div id="guide">${guideCard(c.fields[0])}</div>
      <label class="row" style="font-weight:400"><input type="checkbox" name="save_chk" ${d.saveChk ? 'checked' : ''}> Save these measurements to my profile</label>
      <div class="field"><input name="save_name" maxlength="40" placeholder="Name, e.g. My shirt size" value="${esc(d.saveName)}"></div>`;
  }
  if (d.mode === 'home') inner = `<div class="banner info">A measurement expert visits the address you pick in the next step. Service charge: <b>${inr(f.home_fee)}</b>, added to your total. You can track the appointment on your order page.</div>
    <div class="field"><label>Appointment date</label><input type="date" name="appt_date" min="${ymd(1)}" max="${ymd(14)}" value="${esc(d.appt_date)}" data-change="appt-date"></div>
    <div class="field"><label>Time slot</label><div class="chips" id="slots">${slotChips()}</div></div>`;
  return `<div class="grid g2" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${opt('standard', 'Standard size', 'S, M, L, XL…')}${opt('self', 'Self measurement', 'Enter your own measurements')}${opt('home', `Home measurement · ${inr(f.home_fee)}`, 'We visit and measure you')}</div>${inner}`;
}
function slotChips() {
  const d = D.draft; if (!d.appt_date) return '<span class="hint">Pick a date to see available slots.</span>';
  if (!d.slots) return '<span class="hint">Loading slots…</span>';
  return d.slots.map(s => `<button type="button" class="chip ${d.appt_slot === s.slot ? 'on' : ''}" ${s.available ? '' : 'disabled'} data-act="pick-slot" data-s="${esc(s.slot)}">${esc(s.slot)}</button>`).join('');
}
D.actions.mode = (el) => { collect(); D.draft.mode = el.dataset.m; drawWizard(); };
D.actions['pick-size'] = (el) => { D.draft.size = el.dataset.s; $$('[data-act=pick-size]').forEach(b => { b.classList.toggle('on', b === el); b.setAttribute('aria-checked', b === el); }); };
D.actions['pick-slot'] = (el) => { D.draft.appt_slot = el.dataset.s; $('#slots').innerHTML = slotChips(); };
D.changes['appt-date'] = async (el) => {
  const d = D.draft; d.appt_date = el.value; d.appt_slot = ''; d.slots = null; $('#slots').innerHTML = slotChips();
  if (!el.value) return;
  try { d.slots = await api('GET', '/api/slots?date=' + el.value); } catch (e) { toast(e.message, true); d.appt_date = ''; el.value = ''; }
  $('#slots').innerHTML = slotChips();
};
D.changes.guide = (el) => { $('#guide').innerHTML = guideCard(el.dataset.mf); };
D.changes['apply-saved'] = (el) => {
  const s = D.saved.find(x => x.id === +el.value); if (!s) return;
  $$('[data-mf]').forEach(i => { if (s.data[i.dataset.mf] != null) i.value = s.data[i.dataset.mf]; }); toast('Measurements applied');
};

function stepAddress() {
  const d = D.draft;
  return `${D.addrs.length ? `<div class="stack">${D.addrs.map(a => `<label class="pick ${d.address_id === a.id ? 'on' : ''}" data-act="pick-addr" data-id="${a.id}"><div class="row between"><b>${esc(a.label)} ${a.is_default ? '<span class="tag">Default</span>' : ''}</b>${a.lat != null ? '<span class="tag ok">Pinned</span>' : '<span class="tag warn">No map pin</span>'}</div><span class="small">${esc(a.line)}${a.pincode ? ', ' + esc(a.pincode) : ''}</span></label>`).join('')}</div>` : '<p class="muted">Add an address for pickup, home measurement and delivery.</p>'}
    <button class="btn ghost" data-act="add-addr">+ Add new address</button>
    <p class="hint">${d.mode === 'home' ? 'The measurement visit will happen at this address. ' : ''}Delivery charge depends on distance. We serve up to ${D.cfg.hub.radius_km} km around ${esc(D.cfg.hub.name)}. Pin your location on the map for an exact charge.</p>`;
}
D.actions['pick-addr'] = (el) => { D.draft.address_id = +el.dataset.id; $$('[data-act=pick-addr]').forEach(b => b.classList.toggle('on', b === el)); };
D.actions['add-addr'] = () => openAddressModal();
D.forms.address = async (f) => {
  const b = f.querySelector('button:not([type=button])'), data = formData(f); data.is_default = f.is_default.checked; busy(b, true);
  try {
    const id = f.dataset.id; const a = await api(id ? 'PUT' : 'POST', '/api/addresses' + (id ? '/' + id : ''), data);
    closeModal(); toast('Address saved');
    if (D.draft && parseHash().path.startsWith('/order/')) D.draft.address_id = a.id;
    render();
  } catch (e) { toast(e.message, true); busy(b, false); }
};

function stepDetails() {
  const d = D.draft;
  return `<div class="field"><label>Instructions for the tailor (optional)</label><textarea name="notes" maxlength="500" placeholder="e.g. Slightly loose fit, collar style, pocket position">${esc(d.notes)}</textarea></div>
    ${photoField('refs', 'Reference photos (optional)', d.refs, 4)}<p class="hint">Upload a photo of a style you like. The tailor will see it.</p>`;
}
const quoteBody = () => {
  const d = D.draft; return { design_id: d.design.id, fabric_id: d.own ? null : d.fabric_id, color: d.own ? d.own_color : d.color, measure_mode: d.mode, address_id: d.address_id };
};
function stepReview() {
  const d = D.draft, a = D.addrs.find(x => x.id === d.address_id), c = dcat(), q = d.quote;
  const meas = d.mode === 'self' ? `Self measured (${Object.keys(d.meas).length} measurements)` : d.mode === 'standard' ? `Standard size ${esc(d.size)}` : `Home measurement on ${esc(d.appt_date)}, ${esc(d.appt_slot)}`;
  const fab = D.fabrics.find(x => x.id === d.fabric_id);
  return `<div class="row between"><h3 style="margin:0">Order summary</h3><button class="btn ghost sm" data-act="wz-edit">Edit</button></div>
    <div class="sumrow"><span>Clothing</span><b>${esc(c.name)}</b></div><div class="sumrow"><span>Design</span><b>${esc(d.design.name)}</b></div>
    <div class="sumrow"><span>Fabric</span><b>${d.own ? 'Your own fabric' + (d.own_color ? ' (' + esc(d.own_color) + ')' : '') : esc(fab.name)}</b></div>${d.own ? '' : `<div class="sumrow"><span>Colour</span><b>${esc(d.color)}</b></div>`}
    <div class="sumrow"><span>Measurements</span><b>${meas}</b></div><div class="sumrow"><span>Address</span><b style="text-align:right;max-width:60%">${esc(a.label)}: ${esc(a.line)}</b></div>
    ${d.notes ? `<div class="sumrow"><span>Instructions</span><b style="text-align:right;max-width:60%">${esc(d.notes)}</b></div>` : ''}<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
    ${q ? `<div class="sumrow"><span>Stitching charges</span><b>${inr(q.lines.stitching)}</b></div>
      ${d.own ? '' : `<div class="sumrow"><span>Fabric charges</span><b>${inr(q.lines.fabric_charge)}</b></div>`}
      ${d.mode === 'home' ? `<div class="sumrow"><span>Home measurement charges</span><b>${inr(q.lines.home_fee)}</b></div>` : ''}
      ${d.own ? `<div class="sumrow"><span>Fabric pickup charges</span><b>${inr(q.lines.pickup_fee)}</b></div>` : ''}
      <div class="sumrow"><span>Delivery charges${q.distance_km != null ? `<br><small class="muted">${q.distance_km} km from our hub</small>` : '<br><small class="muted">Base charge (no map pin on address)</small>'}</span><b>${inr(q.lines.delivery_fee)}</b></div>
      <div class="sumrow total"><span>Total</span><span>${inr(q.lines.total)}</span></div><p class="hint">Payment is the next step. No other charges will be added.</p>` : '<div class="spin">Calculating…</div>'}`;
}
D.actions['wz-edit'] = () => { D.draft.step = 1; drawWizard(); };
D.actions['wz-back'] = () => { collect(); D.draft.step--; drawWizard(); };
D.actions['wz-next'] = async () => {
  const d = D.draft; collect();
  if (d.step === 1) { if (!d.own && !d.fabric_id) return toast('Choose a fabric and colour, or select your own fabric', true); }
  if (d.step === 2) {
    if (d.mode === 'standard' && !d.size) return toast('Select a size', true);
    if (d.mode === 'self') { const c = dcat(); for (const f of c.fields) { const v = parseFloat(d.meas[f]); if (!(v >= 3 && v <= 120)) return toast(`Enter a valid ${f} measurement in inches`, true); } }
    if (d.mode === 'home' && (!d.appt_date || !d.appt_slot)) return toast('Choose an appointment date and time slot', true);
  }
  if (d.step === 3 && !d.address_id) return toast('Choose or add an address', true);
  if (d.step === 3) { // validate service area early
    const ok = await guard(() => api('POST', '/api/quote', quoteBody())); if (!ok) return;
  }
  d.step++; drawWizard();
  if (d.step === 5) { d.quote = null; const r = await guard(() => api('POST', '/api/quote', quoteBody())); if (r) { d.quote = r; drawWizard(); } else { d.step = 3; drawWizard(); } }
};
D.actions['wz-place'] = async (el) => {
  const d = D.draft; if (!d.quote) return; busy(el, true);
  try {
    const body = { ...quoteBody(), notes: d.notes, ref_photos: d.refs };
    if (d.mode === 'standard') body.size = d.size;
    if (d.mode === 'self') body.measurements = Object.fromEntries(Object.entries(d.meas).map(([k, v]) => [k, parseFloat(v)]));
    if (d.mode === 'home') { body.appt_date = d.appt_date; body.appt_slot = d.appt_slot; }
    const o = await api('POST', '/api/orders', body);
    if (d.mode === 'self' && d.saveChk && d.saveName) await api('POST', '/api/measurements', { label: d.saveName, category_id: d.design.category_id, data: body.measurements }).catch(() => {});
    D.draft = null; go(`#/orders/${o.id}?pay=1`);
  } catch (e) { toast(e.message, true); busy(el, false); }
};

// ---------- orders ----------
function orderCard(o) {
  return `<a class="card" href="#/orders/${o.id}" style="text-decoration:none;color:inherit;display:block"><div class="row between"><b>${esc(o.design)}</b>${statusTag(o.status)}</div>
    <div class="small muted">${esc(o.code)} · ${esc(o.category)} · ${fdate(o.created_at)}</div><div class="row between" style="margin-top:8px"><span class="small">${esc(o.fabric || '')}${o.color ? ', ' + esc(o.color) : ''}</span><span class="price">${inr(o.price.total)}</span></div></a>`;
}
route('/orders', async () => {
  if (!needCustomer()) return;
  const list = await api('GET', '/api/orders');
  view(`<h2>My orders</h2>${list.length ? `<div class="grid g2">${list.map(orderCard).join('')}</div>` : '<div class="empty"><p>You have not placed any orders yet.</p><a class="btn" href="#/designs">Browse designs</a></div>'}`);
});
route('/orders/(\\d+)', async (m, q) => {
  if (!needCustomer()) return;
  const o = await api('GET', '/api/orders/' + m[1]); drawOrder(o, q);
});
function timeline(o) {
  const S = D.cfg.statuses, idx = S.indexOf(o.status), skipM = o.measure_mode !== 'home';
  return `<ol class="timeline">${S.map((s, i) => {
    const skip = skipM && (s === 'Measurement Pending' || s === 'Measurement Completed');
    const ev = o.events.find(e => e.status === s);
    const cls = o.status === 'Cancelled' ? (ev ? 'done' : '') : skip ? 'skip' : i < idx ? 'done' : i === idx ? 'now' : '';
    return `<li class="${cls}"><i></i>${esc(s)}${skip ? ' <span class="small">(not needed)</span>' : ''}${ev ? `<div class="small muted">${ftime(ev.ts)}</div>` : ''}</li>`;
  }).join('')}</ol>`;
}
function payPanel(o) {
  return `<div class="card stack" id="pay">
    <h3 style="margin:0">Pay ${inr(o.price.total)}</h3>
    <p class="hint" style="margin:0">Pay securely via UPI, Cards, Netbanking or Wallets using Razorpay.</p>
    <button type="button" class="btn block" data-act="rzp-pay" data-id="${o.id}">Pay ${inr(o.price.total)} Online</button>
    <hr>
    <h3>Or pay on delivery</h3>
    <p class="small muted">We confirm your order now and the tailor can start. You pay ${inr(o.price.total)} by UPI or cash when your order is delivered.</p>
    <button type="button" class="btn ghost block" data-act="pay-later" data-id="${o.id}">Pay on delivery</button>
  </div>`;
}
D.actions['pay-later'] = async (el) => {
  busy(el, true);
  try {
    const o = await api('POST', `/api/orders/${el.dataset.id}/pay-later`, {});
    toast('Order confirmed. You will pay on delivery.');
    drawOrder(o, D.cfg);
  } catch (e) {
    toast(e.message, true);
    busy(el, false);
  }
};
D.actions['rzp-pay'] = async (el) => {
  const id = el.dataset.id;
  busy(el, true);
  try {
    if (!window.Razorpay) throw new Error('Razorpay checkout failed to load. Please refresh and try again.');
    const cfg = await api('POST', `/api/orders/${id}/razorpay-order`, {});
    const rzp = new window.Razorpay({
      key: cfg.key,
      amount: cfg.amount,
      currency: cfg.currency,
      name: 'Darzi',
      description: `Order ${cfg.code}`,
      order_id: cfg.order_id,
      prefill: cfg.customer,
      theme: { color: '#111111' },
      handler: async (resp) => {
        try {
          const updated = await api('POST', `/api/orders/${id}/razorpay-verify`, resp);
          toast('Payment received! Order confirmed.');
          drawOrder(updated, D.cfg);
        } catch (err) {
          toast(err.message || 'Payment verification failed', true);
          busy(el, false);
        }
      },
      modal: {
        ondismiss: () => {
          busy(el, false);
        }
      }
    });
    rzp.on('payment.failed', (resp) => {
      toast((resp.error && resp.error.description) || 'Payment failed. Please try again.', true);
      busy(el, false);
    });
    rzp.open();
  } catch (e) {
    toast(e.message, true);
    busy(el, false);
  }
};
function drawOrder(o, q) {
  const unpaid = o.status === 'Awaiting Payment', p = o.price, a = o.address;
  view(`<a href="#/orders">← My orders</a>
  <div class="row between" style="margin:12px 0"><div><h2 style="margin:0">${esc(o.design)}</h2><span class="muted small">Order ${esc(o.code)} · placed ${fdate(o.created_at)}</span></div>${statusTag(o.status)}</div>
  ${o.status === 'Cancelled' ? `<div class="banner bad" style="margin-bottom:16px">This order was cancelled${o.cancel_reason ? ': ' + esc(o.cancel_reason) : ''}.${o.payment_status === 'refunded' ? ' Your payment has been refunded.' : ''}</div>` : ''}
  <div class="cols"><div class="stack">
    ${unpaid ? payPanel(o) : ''}
    ${o.payment_status === 'cod' && o.status !== 'Cancelled' ? `<div class="banner info"><b>Pay on delivery.</b> Please pay ${inr(p.total)} by UPI or cash when your clothes are delivered. The team will confirm it on your order.</div>` : ''}
    ${o.status !== 'Cancelled' && !unpaid ? `<div class="card"><h3>Order tracking</h3>${timeline(o)}</div>` : ''}
    ${o.measure_mode === 'home' ? `<div class="card"><h3>Home measurement</h3><div class="sumrow"><span>Date</span><b>${esc(o.appt_date)}</b></div><div class="sumrow"><span>Time</span><b>${esc(o.appt_slot)}</b></div><div class="sumrow"><span>Status</span><b>${esc(o.appt_status)}</b></div></div>` : ''}
    ${o.fabric_own ? `<div class="card"><h3>Your fabric</h3><div class="sumrow"><span>Pickup status</span><b>${esc(o.pickup_status)}</b></div><p class="hint">We collect your fabric from your address. Stitching starts after pickup.</p></div>` : ''}
    <div class="card"><h3>Details</h3><div class="sumrow"><span>Clothing</span><b>${esc(o.category)}</b></div><div class="sumrow"><span>Fabric</span><b>${esc(o.fabric)}${o.color ? ', ' + esc(o.color) : ''}</b></div>
      <div class="sumrow"><span>Measurements</span><b>${o.measure_mode === 'standard' ? 'Size ' + esc(o.size) : o.measure_mode === 'home' ? (o.measurements ? 'Taken at home' : 'Pending home visit') : 'Self measured'}</b></div>
      ${o.measurements ? `<details><summary class="small" style="cursor:pointer;margin:8px 0">View measurements</summary>${measureTable(o.measurements)}</details>` : ''}
      ${o.tailor ? `<div class="sumrow"><span>Tailor</span><b>${esc(o.tailor)}</b></div>` : ''}${o.deadline ? `<div class="sumrow"><span>Expected by</span><b>${fdate(o.deadline)}</b></div>` : ''}
      <div class="sumrow"><span>Address</span><b style="text-align:right;max-width:60%">${esc(a.line)}</b></div>${o.notes ? `<div class="sumrow"><span>Instructions</span><b style="text-align:right;max-width:60%">${esc(o.notes)}</b></div>` : ''}
      ${o.ref_photos.length ? `<div class="thumbs" style="margin-top:10px">${o.ref_photos.map(u => `<img src="${esc(u)}" alt="Reference photo">`).join('')}</div>` : ''}</div>
    ${reviewBlock(o)}${complaintBlock(o)}</div>
  <aside class="stack"><div class="card"><h3>Price</h3>${priceRows(p)}<div class="sumrow" style="border:0"><span class="muted">Payment</span><span class="tag ${o.payment_status === 'paid' ? 'ok' : o.payment_status === 'refunded' ? 'bad' : 'warn'}">${esc(payLabel(o.payment_status))}</span></div></div>
    ${o.can_cancel ? `<button class="btn danger block" data-act="cancel-order" data-id="${o.id}">Cancel order</button>` : ''}</aside></div>`, () => { if (q && q.pay && unpaid) $('#pay').scrollIntoView(); });
}
function reviewBlock(o) {
  if (o.review) return `<div class="card"><h3>Your review</h3><div style="color:#c9962b;font-size:1.3rem">${'★'.repeat(o.review.rating)}${'☆'.repeat(5 - o.review.rating)}</div><p>${esc(o.review.text || '')}</p>${o.review.photos.length ? `<div class="thumbs">${o.review.photos.map(u => `<img src="${esc(u)}" alt="">`).join('')}</div>` : ''}</div>`;
  if (o.status !== 'Delivered') return '';
  return `<div class="card"><h3>Rate your order</h3><p class="muted small">Tell others how your tailor did.</p><form data-form="review" data-id="${o.id}" class="stack">
    <div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-act="star" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}<input type="hidden" name="rating"></div>
    <div class="field"><label>Review</label><textarea name="text" maxlength="1000" placeholder="Fit, finish, delivery…"></textarea></div>${photoField('photos', 'Photos of your finished clothing (optional)', [], 4)}<button class="btn">Submit review</button></form></div>`;
}
D.actions.star = (el) => { const n = +el.dataset.n; $('input[name=rating]', el.closest('form')).value = n; $$('[data-act=star]', el.closest('form')).forEach(b => b.classList.toggle('on', +b.dataset.n <= n)); };
D.forms.review = async (f) => {
  const d = formData(f); if (!d.rating) return toast('Choose a star rating', true); const b = $('button.btn', f); busy(b, true);
  try { await api('POST', `/api/orders/${f.dataset.id}/review`, { rating: +d.rating, text: d.text, photos: JSON.parse(d.photos || '[]') }); toast('Thank you for your review'); render(); } catch (e) { toast(e.message, true); busy(b, false); }
};
function complaintBlock(o) {
  if (o.status === 'Awaiting Payment') return '';
  return `<div class="card"><h3>Help and complaints</h3>${o.complaints.map(c => `<div class="banner ${c.status === 'resolved' ? 'info' : ''}" style="margin-bottom:8px"><b>${esc(c.status)}</b>: ${esc(c.text)}${c.resolution ? `<br><b>Response:</b> ${esc(c.resolution)}` : ''}</div>`).join('')}
    <details><summary style="cursor:pointer">Raise a complaint or give feedback</summary><form data-form="complaint" data-id="${o.id}" class="stack" style="margin-top:10px"><div class="field"><textarea name="text" required minlength="5" maxlength="1000" placeholder="Tell us what went wrong"></textarea></div><button class="btn sm">Send to support</button></form></details></div>`;
}
D.forms.complaint = async (f) => { try { await api('POST', `/api/orders/${f.dataset.id}/complaint`, { text: f.text.value }); toast('Sent. Our team will respond.'); render(); } catch (e) { fail(e); } };
D.actions['cancel-order'] = (el) => modal(`<h3>Cancel this order?</h3><p class="muted">You can cancel until stitching starts. Paid orders are refunded.</p><form data-form="cancel" data-id="${el.dataset.id}" class="stack"><div class="field"><label>Reason (optional)</label><input name="reason" maxlength="200"></div><div class="row"><button class="btn danger">Yes, cancel order</button><button type="button" class="btn ghost" data-act="close-modal">Keep order</button></div></form>`);
D.forms.cancel = async (f) => { try { await api('POST', `/api/orders/${f.dataset.id}/cancel`, { reason: f.reason.value }); toast('Order cancelled'); render(); } catch (e) { fail(e); } };

// ---------- profile ----------
route('/profile', async (m, q) => {
  if (!needCustomer()) return;
  const tab = q.tab || 'details';
  const tabs = [['details', 'Details'], ['addresses', 'Addresses'], ['measurements', 'Measurements'], ['favourites', 'Favourites'], ['payments', 'Payments']];
  let body = '';
  if (tab === 'details') body = `<form data-form="me" class="card stack" style="max-width:480px"><div class="field"><label>Full name</label><input name="name" required value="${esc(D.me.name)}"></div><div class="field"><label>Mobile</label><input value="+91 ${esc(D.me.mobile)}" disabled></div>
    <div class="field"><label>Email (optional)</label><input name="email" type="email" value="${esc(D.me.email || '')}"></div><button class="btn">Save changes</button></form>`;
  if (tab === 'addresses') { const a = await api('GET', '/api/addresses'); D.addrs = a; body = `<div class="row between"><p class="muted">Saved delivery addresses</p><button class="btn sm" data-act="add-addr">+ Add address</button></div><div class="grid g2">${a.map(x => `<div class="card"><div class="row between"><b>${esc(x.label)}</b>${x.is_default ? '<span class="tag">Default</span>' : ''}</div><p class="small">${esc(x.line)}${x.pincode ? ', ' + esc(x.pincode) : ''}</p><div class="row"><button class="btn ghost sm" data-act="edit-addr" data-id="${x.id}">Edit</button>${x.is_default ? '' : `<button class="btn ghost sm" data-act="def-addr" data-id="${x.id}">Make default</button>`}<button class="btn danger sm" data-act="del-addr" data-id="${x.id}">Delete</button></div></div>`).join('') || '<div class="empty">No saved addresses.</div>'}</div>`; }
  if (tab === 'measurements') { const s = await api('GET', '/api/measurements'); body = `<div class="row between"><p class="muted">Saved measurement sets, reusable at checkout</p><button class="btn sm" data-act="add-meas">+ Add measurements</button></div><div class="grid g2">${s.map(x => `<div class="card"><div class="row between"><b>${esc(x.label)}</b><span class="tag">${esc((D.cfg.categories.find(c => c.id === x.category_id) || {}).name || '')}</span></div>${measureTable(x.data)}<button class="btn danger sm" style="margin-top:10px" data-act="del-meas" data-id="${x.id}">Delete</button></div>`).join('') || '<div class="empty">Nothing saved yet.</div>'}</div>`; }
  if (tab === 'favourites') { const f = await api('GET', '/api/favorites'); body = f.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${f.map(d => designCard(d, new Set(f.map(x => x.id)))).join('')}</div>` : '<div class="empty">Tap the heart on any design to save it here.</div>'; }
  if (tab === 'payments') { const p = await api('GET', '/api/payments'); body = p.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Order</th><th>Type</th><th>Method</th><th>Reference</th><th class="right">Amount</th></tr></thead><tbody>${p.map(x => `<tr><td>${ftime(x.ts)}</td><td>${esc(x.code)}</td><td>${x.type === 'refund' ? '<span class="tag bad">Refund</span>' : '<span class="tag ok">Payment</span>'}</td><td>${esc(x.method)}</td><td class="small">${esc(x.ref)}</td><td class="right">${x.type === 'refund' ? '−' : ''}${inr(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No payments yet.</div>'; }
  view(`<h2>Your profile</h2><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<a href="#/profile?tab=${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div>${body}`);
});
D.forms.me = async (f) => { try { const r = await api('PUT', '/api/me', { name: f.name.value, email: f.email.value }); Object.assign(D.me, r); renderChrome(); toast('Saved'); } catch (e) { fail(e); } };
D.actions['edit-addr'] = (el) => openAddressModal(D.addrs.find(a => a.id === +el.dataset.id));
D.actions['def-addr'] = async (el) => { const a = D.addrs.find(x => x.id === +el.dataset.id); await guard(() => api('PUT', '/api/addresses/' + a.id, { ...a, is_default: true })); render(); };
D.actions['del-addr'] = async (el) => { if (!confirm('Delete this address?')) return; if (await guard(() => api('DELETE', '/api/addresses/' + el.dataset.id))) render(); };
D.actions['del-meas'] = async (el) => { if (!confirm('Delete these measurements?')) return; if (await guard(() => api('DELETE', '/api/measurements/' + el.dataset.id))) render(); };
D.actions['add-meas'] = () => measModal(D.cfg.categories[0].id);
function measModal(cid) {
  const c = D.cfg.categories.find(x => x.id === cid);
  modal(`<h3>Add measurements</h3><form data-form="meas" class="stack"><div class="field"><label>Name</label><input name="label" required maxlength="40" placeholder="e.g. My shirt size"></div>
    <div class="field"><label>For</label><select name="category_id" data-change="meas-cat">${D.cfg.categories.map(x => `<option value="${x.id}" ${x.id === cid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="form-grid">${c.fields.map(fl => `<div class="field"><label>${esc(fl)} (in)</label><input type="number" step="0.25" min="3" max="120" required data-mf="${esc(fl)}" data-focus="mguide"></div>`).join('')}</div><div id="mguide">${guideCard(c.fields[0])}</div>
    <div class="row"><button class="btn">Save</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`);
}
D.changes['meas-cat'] = (el) => measModal(+el.value);
D.changes.mguide = (el) => { $('#mguide').innerHTML = guideCard(el.dataset.mf); };
D.forms.meas = async (f) => {
  const data = Object.fromEntries($$('[data-mf]', f).map(i => [i.dataset.mf, parseFloat(i.value)]));
  try { await api('POST', '/api/measurements', { label: f.label.value, category_id: +f.category_id.value, data }); closeModal(); toast('Measurements saved'); render(); } catch (e) { fail(e); }
};
