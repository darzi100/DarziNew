'use strict';
/* Admin dashboard: overview, orders, tailors, customers, pricing, finance, content, complaints. */
const ADM = {};
const tbl = (heads, rows, empty = 'Nothing to show.') => rows.length ? `<div class="tablewrap"><table><thead><tr>${heads.map(h => `<th${h.startsWith('>') ? ' class="right"' : ''}>${esc(h.replace(/^>/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<div class="empty">${empty}</div>`;
const payTag = (s) => `<span class="tag ${s === 'paid' ? 'ok' : s === 'refunded' ? 'bad' : 'warn'}">${esc(payLabel(s))}</span>`;
const adminTabs = [['overview', 'Overview'], ['orders', 'Orders'], ['tailors', 'Tailors'], ['customers', 'Customers'], ['pricing', 'Pricing'], ['finance', 'Finance'], ['content', 'Content'], ['complaints', 'Complaints']];

route('/admin', async (m, q) => {
  const tab = q.tab || 'overview'; let body = '';
  if (tab === 'overview') body = await admOverview();
  if (tab === 'orders') body = await admOrders(q);
  if (tab === 'tailors') body = await admTailors();
  if (tab === 'customers') body = await admCustomers();
  if (tab === 'pricing') body = await admPricing();
  if (tab === 'finance') body = await admFinance();
  if (tab === 'content') body = await admContent(q);
  if (tab === 'complaints') body = await admComplaints();
  view(`<h2>Admin</h2><div class="tabs">${adminTabs.map(([k, l]) => `<a href="#/admin?tab=${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div>${body}`);
}, ['admin']);

async function admOverview() {
  const s = await api('GET', '/api/admin/stats'), max = Math.max(1, ...s.popular.map(p => p.orders));
  const stat = (v, l, href) => `<${href ? `a href="${href}"` : 'div'} class="stat" style="text-decoration:none"><b>${v}</b><span>${l}</span></${href ? 'a' : 'div'}>`;
  return `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">
    ${stat(s.total_orders, 'Total orders', '#/admin?tab=orders')}${stat(inr(s.revenue), 'Platform revenue (delivered)')}${stat(inr(s.gross_collected), 'Net payments collected')}
    ${stat(s.pending_orders, 'Pending orders')}${stat(s.completed_orders, 'Completed orders')}${stat(s.cancelled_orders, 'Cancelled orders')}
    ${stat(s.active_customers, `Active customers (30 days) of ${s.total_customers}`)}${stat(s.active_tailors, 'Active tailors', '#/admin?tab=tailors')}</div>
  <div class="grid g2" style="margin-top:20px"><div class="card"><h3>Needs attention</h3>
    <div class="sumrow"><span>Paid orders awaiting a tailor</span><a href="#/admin?tab=orders&status=Order Confirmed"><b>${s.awaiting_assignment}</b></a></div>
    <div class="sumrow"><span>Tailor applications to review</span><a href="#/admin?tab=tailors"><b>${s.pending_tailors}</b></a></div>
    <div class="sumrow"><span>Open complaints</span><a href="#/admin?tab=complaints"><b>${s.open_complaints}</b></a></div></div>
    <div class="card"><h3>Most popular categories</h3>${s.popular.map(p => `<div style="margin:8px 0"><div class="row between small"><span>${esc(p.name)}</span><b>${p.orders}</b></div><div class="bar"><i style="width:${p.orders / max * 100}%"></i></div></div>`).join('')}</div></div>`;
}

async function admOrders(q) {
  const qs = new URLSearchParams(); if (q.status) qs.set('status', q.status); if (q.q) qs.set('q', q.q);
  const list = await api('GET', '/api/admin/orders?' + qs);
  const statuses = ['Awaiting Payment', ...D.cfg.statuses, 'Cancelled'];
  return `<form class="row" data-form="adm-filter" style="margin-bottom:14px"><select name="status" style="max-width:240px" aria-label="Status"><option value="">All statuses</option>${statuses.map(s => `<option ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <input name="q" placeholder="Order code" value="${esc(q.q || '')}" style="max-width:200px" aria-label="Order code"><button class="btn sm">Filter</button></form>
  ${tbl(['Order', 'Customer', 'Item', 'Status', 'Payment', 'Tailor', '>Total', 'Date'], list.map(o => `<tr><td><a href="#/admin/orders/${o.id}"><b>${esc(o.code)}</b></a></td><td>${esc(o.customer.name)}</td><td>${esc(o.design)}<div class="small muted">${esc(o.category)}</div></td><td>${statusTag(o.status)}</td><td>${payTag(o.payment_status)}</td><td>${esc(o.tailor || '—')}${o.tailor_status === 'new' ? ' <span class="tag warn">awaiting</span>' : ''}</td><td class="right">${inr(o.price.total)}</td><td>${fdate(o.created_at)}</td></tr>`), 'No orders match.')}`;
}
D.forms['adm-filter'] = (f) => go('#/admin?' + new URLSearchParams({ tab: 'orders', status: f.status.value, q: f.q.value }).toString().replace(/&?\w+=(&|$)/g, '$1'));

route('/admin/orders/(\\d+)', async (m) => {
  const o = await api('GET', '/api/admin/orders/' + m[1]); ADM.order = o; drawAdminOrder(o);
}, ['admin']);
function drawAdminOrder(o) {
  const a = o.address, f = o.finance, S = o.status;
  const canAssign = ['paid', 'cod'].includes(o.payment_status) && ['Order Confirmed', 'Measurement Completed', 'Tailor Assigned'].includes(S) && !(o.measure_mode === 'home' && !o.measurements);
  const actions = [];
  if (o.measure_mode === 'home' && S === 'Measurement Pending') actions.push(`<div class="card stack"><h3>Home measurement</h3><div class="small">${esc(o.appt_date)} · ${esc(o.appt_slot)} · <b>${esc(o.appt_status)}</b></div>
    <div class="row">${['Scheduled', 'Confirmed', 'On the way'].map(s => `<button class="btn ghost sm" data-act="adm-appt" data-id="${o.id}" data-s="${s}">${s}</button>`).join('')}</div>
    <form data-form="adm-hm" data-id="${o.id}" class="stack"><p class="hint">Enter the measurements taken at the visit (inches).</p><div class="form-grid">${o.fields.map(fl => `<div class="field"><label>${esc(fl)}</label><input type="number" step="0.25" min="3" max="120" required data-mf="${esc(fl)}"></div>`).join('')}</div><button class="btn">Save measurements and complete visit</button></form></div>`);
  if (canAssign) actions.push(`<div class="card stack"><h3>${o.tailor_id ? 'Reassign tailor' : 'Assign tailor'}</h3>${o.tailor_id ? `<p class="small">Currently: <b>${esc(o.tailor)}</b> (${o.tailor_status === 'new' ? 'awaiting response' : esc(o.tailor_status)})</p>` : ''}
    ${o.candidates.length ? `<form data-form="adm-assign" data-id="${o.id}" class="stack"><select name="tailor_id" required><option value="">Choose a tailor…</option>${o.candidates.map(t => `<option value="${t.id}" ${t.load_today >= t.capacity ? 'disabled' : ''}>${esc(t.name)}: ${t.load_today}/${t.capacity} today, ${t.active} active</option>`).join('')}</select><button class="btn">Assign</button></form>` : '<div class="banner">No approved tailor covers this category.</div>'}</div>`);
  if (o.fabric_own) actions.push(`<div class="card stack"><h3>Customer fabric pickup</h3><p class="small">Status: <b>${esc(o.pickup_status)}</b></p><div class="row">${['Pending pickup', 'Collected'].map(s => `<button class="btn ${o.pickup_status === s ? '' : 'ghost'} sm" data-act="adm-pickup" data-id="${o.id}" data-s="${s}">${s}</button>`).join('')}</div></div>`);
  if (S === 'Ready for Delivery') actions.push(`<div class="card stack"><h3>Delivery</h3><p class="small">Collect from ${esc(o.tailor || 'tailor')} and deliver to the customer.</p><button class="btn" data-act="adm-status" data-id="${o.id}" data-s="Out for Delivery">Mark out for delivery</button></div>`);
  if (S === 'Out for Delivery') actions.push(`<div class="card stack"><h3>Delivery</h3><button class="btn" data-act="adm-status" data-id="${o.id}" data-s="Delivered">Mark delivered</button></div>`);
  if (o.payment_status === 'cod' && S !== 'Cancelled') actions.push(`<div class="card stack"><h3>Payment due on delivery</h3><p class="small">The customer pays <b>${inr(o.price.total)}</b> by UPI or cash. Record it when you receive the money. The order cannot be marked delivered before this.</p><button class="btn" data-act="adm-markpaid" data-id="${o.id}">Record payment received</button></div>`);
  if (!['Delivered', 'Cancelled'].includes(S)) actions.push(`<button class="btn danger block" data-act="adm-cancel" data-id="${o.id}">Cancel order${o.payment_status === 'paid' ? ' and refund' : ''}</button>`);
  view(`<a href="#/admin?tab=orders">← All orders</a><div class="row between" style="margin:12px 0"><div><h2 style="margin:0">${esc(o.design)}</h2><span class="muted small">${esc(o.code)} · ${fdate(o.created_at)}</span></div><div class="row">${statusTag(S)}${payTag(o.payment_status)}</div></div>
  <div class="cols"><div class="stack">
    <div class="card"><h3>Customer and delivery</h3><div class="sumrow"><span>Customer</span><b>${esc(o.customer.name)} · +91 ${esc(o.customer.mobile)}</b></div><div class="sumrow"><span>Address</span><b style="text-align:right;max-width:65%">${esc(a.line)}${a.pincode ? ', ' + esc(a.pincode) : ''}${a.landmark ? ' (' + esc(a.landmark) + ')' : ''}</b></div>
      ${a.lat != null ? `<div class="sumrow"><span>Map</span><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}">Open location</a></div>` : ''}</div>
    <div class="card"><h3>Item</h3><div class="sumrow"><span>Category</span><b>${esc(o.category)}</b></div><div class="sumrow"><span>Fabric</span><b>${esc(o.fabric)}${o.color ? ', ' + esc(o.color) : ''}</b></div>
      <div class="sumrow"><span>Measurements</span><b>${o.measure_mode === 'standard' ? 'Size ' + esc(o.size) : o.measure_mode === 'home' ? 'Home visit ' + esc(o.appt_date) + ', ' + esc(o.appt_slot) : 'Self measured'}</b></div>${o.measurements ? measureTable(o.measurements) : ''}
      ${o.notes ? `<div class="sumrow"><span>Instructions</span><b style="text-align:right;max-width:65%">${esc(o.notes)}</b></div>` : ''}${o.ref_photos.length ? `<div class="thumbs" style="margin-top:8px">${o.ref_photos.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Reference"></a>`).join('')}</div>` : ''}
      ${o.tailor ? `<div class="sumrow"><span>Tailor</span><b>${esc(o.tailor)} (${esc(o.tailor_status || '')})</b></div>` : ''}${o.deadline ? `<div class="sumrow"><span>Deadline</span><b>${fdate(o.deadline)}</b></div>` : ''}</div>
    <div class="card"><h3>History</h3><ol class="timeline">${o.events.map(e => `<li class="done"><i></i>${esc(e.status)}${e.note ? ` <span class="muted small">· ${esc(e.note)}</span>` : ''}<div class="small muted">${ftime(e.ts)}</div></li>`).join('')}</ol></div>
    ${o.complaints.length ? `<div class="card"><h3>Complaints</h3>${o.complaints.map(c => `<div class="banner ${c.status === 'open' ? '' : 'info'}" style="margin-bottom:8px">${esc(c.text)}<br><b>${esc(c.status)}</b>${c.resolution ? ': ' + esc(c.resolution) : ''}</div>`).join('')}<a href="#/admin?tab=complaints">Manage complaints</a></div>` : ''}
  </div><aside class="stack">${actions.join('')}
    <div class="card"><h3>${o.payment_status === 'paid' ? 'Customer paid' : 'Customer pays'}</h3>${priceRows(o.price)}</div>
    <div class="card"><h3>Money split</h3><div class="sumrow"><span>Commission (${f.commission_pct}% of stitching)</span><b>${inr(f.commission)}</b></div><div class="sumrow"><span>Home measurement fee</span><b>${inr(o.price.home_fee)}</b></div><div class="sumrow"><span>Fabric margin</span><b>${inr(o.price.fabric - f.fabric_cost)}</b></div>
      <div class="sumrow"><span><b>Platform revenue</b></span><b>${inr(f.platform_revenue)}</b></div><div class="sumrow"><span>Tailor payable</span><b>${inr(f.tailor_payable)}</b></div><div class="sumrow"><span>Pass-through (delivery, pickup)</span><b>${inr(o.price.delivery + o.price.pickup)}</b></div><p class="hint">Delivery and pickup charges cover logistics costs and are not counted as profit.</p></div>
    ${o.payments.length ? `<div class="card"><h3>Payments</h3>${o.payments.map(p => `<div class="sumrow"><span>${esc(p.type)} · ${esc(p.method)}<br><small class="muted">${esc(p.ref)}</small></span><b>${p.type === 'refund' ? '−' : ''}${inr(p.amount)}</b></div>`).join('')}</div>` : ''}</aside></div>`);
}
const refreshOrder = async (id) => { const o = await api('GET', '/api/admin/orders/' + id); drawAdminOrder(o); };
D.forms['adm-assign'] = async (f) => { if (await guard(() => api('POST', `/api/admin/orders/${f.dataset.id}/assign`, { tailor_id: +f.tailor_id.value }))) { toast('Assigned. The tailor has been notified.'); refreshOrder(f.dataset.id); } };
D.forms['adm-hm'] = async (f) => { const data = Object.fromEntries($$('[data-mf]', f).map(i => [i.dataset.mf, parseFloat(i.value)])); if (await guard(() => api('POST', `/api/admin/orders/${f.dataset.id}/home-measurement`, { data }))) { toast('Measurements saved'); refreshOrder(f.dataset.id); } };
D.actions['adm-appt'] = async (el) => { if (await guard(() => api('POST', `/api/admin/orders/${el.dataset.id}/appointment`, { status: el.dataset.s }))) { toast('Appointment updated'); refreshOrder(el.dataset.id); } };
D.actions['adm-pickup'] = async (el) => { if (await guard(() => api('POST', `/api/admin/orders/${el.dataset.id}/pickup`, { status: el.dataset.s }))) { toast('Pickup updated'); refreshOrder(el.dataset.id); } };
D.actions['adm-status'] = async (el) => { if (await guard(() => api('POST', `/api/admin/orders/${el.dataset.id}/status`, { status: el.dataset.s }))) { toast('Status updated. The customer was notified.'); refreshOrder(el.dataset.id); } };
D.actions['adm-markpaid'] = (el) => modal(`<h3>Record payment received</h3><form data-form="adm-markpaid" data-id="${el.dataset.id}" class="stack"><div class="field"><label>Paid by</label><select name="paid_by" required><option value="cash">Cash</option><option value="upi">UPI</option></select></div><div class="field"><label>Reference (optional)</label><input name="ref" maxlength="60" placeholder="UPI transaction ID"></div><div class="row"><button class="btn">Save payment</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`);
D.forms['adm-markpaid'] = async (f) => { if (await guard(() => api('POST', `/api/admin/orders/${f.dataset.id}/mark-paid`, { method: f.paid_by.value, ref: f.ref.value }))) { closeModal(); toast('Payment recorded'); refreshOrder(f.dataset.id); } };
D.actions['adm-cancel'] = (el) => modal(`<h3>Cancel this order?</h3><p class="muted">Paid orders are refunded in full and fabric stock is restored.</p><form data-form="adm-cancel" data-id="${el.dataset.id}" class="stack"><div class="field"><label>Reason (shown to customer)</label><input name="reason" required minlength="3" maxlength="200"></div><div class="row"><button class="btn danger">Cancel order</button><button type="button" class="btn ghost" data-act="close-modal">Back</button></div></form>`);
D.forms['adm-cancel'] = async (f) => { if (await guard(() => api('POST', `/api/admin/orders/${f.dataset.id}/cancel`, { reason: f.reason.value }))) { closeModal(); toast('Order cancelled'); refreshOrder(f.dataset.id); } };

// ---- tailors ----
async function admTailors() {
  const list = await api('GET', '/api/admin/tailors'); ADM.tailors = list;
  const tag = (s) => `<span class="tag ${s === 'approved' ? 'ok' : s === 'pending' ? 'warn' : s === 'incomplete' ? '' : 'bad'}">${esc(s)}</span>`;
  return tbl(['Tailor', 'Status', 'Experience', 'Rating', 'Completed', 'Active', 'Capacity', ''], list.map(t => `<tr><td><b>${esc(t.name)}</b><div class="small muted">+91 ${esc(t.mobile)}</div></td><td>${tag(t.status)}</td><td>${t.experience ?? '—'} yrs</td><td>${t.rating ? stars(t.rating) + ` (${t.reviews})` : '—'}</td><td>${t.completed}</td><td>${t.active}</td><td>${t.capacity}/day</td><td class="right"><button class="btn ghost sm" data-act="adm-tailor" data-id="${t.id}">${t.status === 'pending' ? 'Review' : 'Manage'}</button></td></tr>`));
}
D.actions['adm-tailor'] = (el) => {
  const t = ADM.tailors.find(x => x.id === +el.dataset.id), cats = D.cfg.categories;
  modal(`<h3>${esc(t.name)}</h3><p class="muted small">+91 ${esc(t.mobile)} · ${t.experience ?? '?'} years · ${t.rejections} rejections · ${t.status}</p>
    <div class="sumrow"><span>Address</span><b style="max-width:65%;text-align:right">${esc(t.address || '—')}</b></div><div class="sumrow"><span>Shop</span><b style="max-width:65%;text-align:right">${esc(t.shop_location || '—')}</b></div>
    <div class="sumrow"><span>Payout</span><b>${esc(t.upi || '')}${t.bank_account ? ' · A/C ' + esc(t.bank_account) + ' ' + esc(t.bank_ifsc) : ''}</b></div>
    ${t.portfolio.length ? `<div class="thumbs" style="margin:10px 0">${t.portfolio.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Portfolio"></a>`).join('')}</div>` : ''}
    <form data-form="adm-tailor-edit" data-id="${t.id}" class="stack"><div class="field"><label>Categories</label><div class="chips">${cats.map(c => `<label class="chip ${t.categories.includes(c.id) ? 'on' : ''}"><input type="checkbox" name="cat" value="${c.id}" ${t.categories.includes(c.id) ? 'checked' : ''} data-change="chip-toggle"> ${esc(c.name)}</label>`).join('')}</div></div>
    <div class="form-grid"><div class="field"><label>Daily capacity</label><input name="capacity" type="number" min="1" max="50" value="${t.capacity}"></div><div class="field"><label>Note (shown to tailor on reject or suspend)</label><input name="note" maxlength="300" value="${esc(t.admin_note || '')}"></div></div>
    <div class="row"><button class="btn sm">Save profile</button>
    ${t.status !== 'approved' && t.status !== 'incomplete' ? `<button type="button" class="btn sm" data-act="adm-tstatus" data-id="${t.id}" data-s="approved">Approve</button>` : ''}
    ${t.status === 'pending' ? `<button type="button" class="btn danger sm" data-act="adm-tstatus" data-id="${t.id}" data-s="rejected">Reject</button>` : ''}
    ${t.status === 'approved' ? `<button type="button" class="btn danger sm" data-act="adm-tstatus" data-id="${t.id}" data-s="suspended">Suspend</button>` : ''}</div></form>`);
};
D.forms['adm-tailor-edit'] = async (f) => { if (await guard(() => api('PUT', '/api/admin/tailors/' + f.dataset.id, { capacity: +f.capacity.value, categories: $$('[name=cat]:checked', f).map(i => +i.value), admin_note: f.note.value }))) { closeModal(); toast('Saved'); render(); } };
D.actions['adm-tstatus'] = async (el) => {
  const f = el.closest('form'), note = f.note.value;
  if (await guard(() => api('POST', `/api/admin/tailors/${el.dataset.id}/status`, { status: el.dataset.s, note }))) { closeModal(); toast('Tailor ' + el.dataset.s); render(); }
};

// ---- customers ----
async function admCustomers() {
  const list = await api('GET', '/api/admin/customers');
  return tbl(['Customer', 'Joined', 'Orders', '>Total spent', 'Status', ''], list.map(c => `<tr><td><b>${esc(c.name)}</b><div class="small muted">+91 ${esc(c.mobile)}${c.email ? ' · ' + esc(c.email) : ''}</div></td><td>${fdate(c.created_at)}</td><td>${c.orders}</td><td class="right">${inr(c.spent)}</td><td><span class="tag ${c.status === 'active' ? 'ok' : 'bad'}">${esc(c.status)}</span></td><td class="right"><button class="btn ghost sm" data-act="adm-cust" data-id="${c.id}">View</button></td></tr>`), 'No customers yet.');
}
D.actions['adm-cust'] = async (el) => {
  const c = await guard(() => api('GET', '/api/admin/customers/' + el.dataset.id)); if (!c) return;
  modal(`<h3>${esc(c.name)}</h3><p class="muted small">+91 ${esc(c.mobile)} · joined ${fdate(c.created_at)} · ${esc(c.status)}</p>
    <h3 style="font-size:1.1rem">Addresses</h3>${c.addresses.map(a => `<div class="small">${esc(a.label)}: ${esc(a.line)}</div>`).join('') || '<p class="muted small">None</p>'}
    <h3 style="font-size:1.1rem;margin-top:14px">Order history</h3>${c.orders.map(o => `<div class="sumrow"><a href="#/admin/orders/${o.id}">${esc(o.code)} · ${esc(o.design)}</a><span>${statusTag(o.status)} ${inr(o.price.total)}</span></div>`).join('') || '<p class="muted small">No orders</p>'}
    <div class="row" style="margin-top:16px"><button class="btn ${c.status === 'active' ? 'danger' : ''} sm" data-act="adm-cstatus" data-id="${c.id}" data-s="${c.status === 'active' ? 'suspended' : 'active'}">${c.status === 'active' ? 'Suspend account' : 'Reactivate account'}</button><button class="btn ghost sm" data-act="close-modal">Close</button></div>`);
};
D.actions['adm-cstatus'] = async (el) => { if (await guard(() => api('POST', `/api/admin/customers/${el.dataset.id}/status`, { status: el.dataset.s }))) { closeModal(); toast('Updated'); render(); } };

// ---- pricing ----
async function admPricing() {
  const s = await api('GET', '/api/admin/settings');
  const n = (name, label, hint, step = 1) => `<div class="field"><label>${label}</label><input name="${name}" type="number" step="${step}" min="0" required value="${esc(s[name])}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  return `<form data-form="adm-settings" class="stack" style="max-width:760px"><div class="card stack"><h3>Fees</h3><div class="form-grid">${n('home_fee', 'Home measurement fee (₹)', 'Suggested range: ₹150 to ₹200')}${n('pickup_fee', 'Fabric pickup charge (₹)', 'Applied when the customer gives their own fabric')}</div></div>
    <div class="card stack"><h3>Delivery</h3><div class="form-grid">${n('delivery_base', 'Base delivery charge (₹)')}${n('delivery_free_km', 'Distance covered by base charge (km)')}${n('delivery_per_km', 'Charge per extra km (₹)')}${n('service_radius_km', `Service radius around ${esc(s.hub_name)} (km)`)}</div></div>
    <div class="card stack"><h3>Platform</h3><div class="form-grid">${n('commission_pct', 'Commission on stitching charge (%)', 'The tailor is paid the rest of the stitching charge', 0.5)}${n('stitch_days', 'Default days to stitch after acceptance')}${n('appt_capacity', 'Home visits per time slot per day')}</div>
      <div class="field"><label>Home measurement time slots (one per line)</label><textarea name="slots" rows="4">${esc(s.slots.join('\n'))}</textarea></div></div>
    <button class="btn">Save pricing</button><p class="hint">Changes apply to new orders only. Existing orders keep the prices they were placed with. Stitching prices are set per design and fabric prices per fabric under <a href="#/admin?tab=content">Content</a>.</p></form>`;
}
D.forms['adm-settings'] = async (f) => { const d = formData(f); d.slots = d.slots.split('\n').map(x => x.trim()).filter(Boolean); if (await guard(() => api('PUT', '/api/admin/settings', d))) toast('Pricing saved'); };

// ---- finance ----
async function admFinance() {
  const F = await api('GET', '/api/admin/finance'), r = F.recognised; ADM.fin = F;
  return `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))"><div class="stat"><b>${inr(F.collected)}</b><span>Customer payments received</span></div><div class="stat"><b>${inr(F.refunded)}</b><span>Refunded</span></div><div class="stat"><b>${inr(F.net_collected)}</b><span>Net collected</span></div></div>
  <div class="grid g2" style="margin-top:18px"><div class="card"><h3>Revenue on delivered orders</h3><div class="sumrow"><span>Commission</span><b>${inr(r.commission)}</b></div><div class="sumrow"><span>Home measurement fees</span><b>${inr(r.home_fees)}</b></div><div class="sumrow"><span>Fabric margin</span><b>${inr(r.fabric_margin)}</b></div><div class="sumrow total"><span>Platform revenue</span><span>${inr(r.platform_revenue)}</span></div></div>
    <div class="card"><h3>Not platform revenue</h3><div class="sumrow"><span>Owed to tailors (stitching minus commission)</span><b>${inr(r.tailor_payable)}</b></div><div class="sumrow"><span>Fabric cost</span><b>${inr(r.fabric_cost)}</b></div><div class="sumrow"><span>Delivery and pickup (pass-through)</span><b>${inr(r.pass_through)}</b></div><p class="hint">Revenue is counted when an order is delivered. Cancelled orders are refunded and excluded.</p></div></div>
  <h3 style="margin-top:24px">Tailor balances</h3>${tbl(['Tailor', 'Payout to', '>Earned', '>Paid', '>Balance', ''], F.tailors.map(t => `<tr><td><b>${esc(t.name)}</b></td><td class="small">${esc(t.upi || '')}${t.bank_account ? '<br>A/C ' + esc(t.bank_account) + ' ' + esc(t.bank_ifsc) : ''}</td><td class="right">${inr(t.earned)}</td><td class="right">${inr(t.paid)}</td><td class="right"><b>${inr(t.balance)}</b></td><td class="right">${t.balance > 0 ? `<button class="btn sm" data-act="adm-payout" data-id="${t.id}">Record payout</button>` : ''}</td></tr>`), 'No tailors yet.')}
  <p class="hint">Payouts are recorded here after you pay the tailor by UPI or bank transfer. Automatic payouts are not built yet.</p>
  <h3 style="margin-top:24px">Transactions</h3>${tbl(['Date', 'Type', 'Order', 'Method', 'Reference', '>Amount'], F.transactions.map(x => `<tr><td>${ftime(x.ts)}</td><td><span class="tag ${x.type === 'payment' ? 'ok' : x.type === 'refund' ? 'bad' : ''}">${esc(x.type)}</span></td><td>${esc(x.code || '—')}</td><td>${esc(x.method)}</td><td class="small">${esc(x.ref || '')}</td><td class="right">${x.type === 'refund' || x.type === 'payout' ? '−' : ''}${inr(x.amount)}</td></tr>`), 'No transactions yet.')}`;
}
D.actions['adm-payout'] = (el) => { const t = ADM.fin.tailors.find(x => x.id === +el.dataset.id); modal(`<h3>Record payout to ${esc(t.name)}</h3><p class="muted">Outstanding balance: <b>${inr(t.balance)}</b>. Pay them first by UPI or bank transfer, then record it here.</p><form data-form="adm-payout" data-id="${t.id}" class="stack"><div class="field"><label>Amount (₹)</label><input name="amount" type="number" min="1" max="${t.balance}" value="${t.balance}" required></div><div class="field"><label>Reference note</label><input name="note" maxlength="100" placeholder="UPI ref / bank txn ID"></div><div class="row"><button class="btn">Record payout</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`); };
D.forms['adm-payout'] = async (f) => { if (await guard(() => api('POST', '/api/admin/payouts', { tailor_id: +f.dataset.id, amount: +f.amount.value, note: f.note.value }))) { closeModal(); toast('Payout recorded'); render(); } };

// ---- complaints ----
async function admComplaints() {
  const list = await api('GET', '/api/admin/complaints');
  return list.length ? `<div class="stack">${list.map(c => `<div class="card"><div class="row between"><b><a href="#/admin/orders/${c.order_id}">${esc(c.code)}</a> · ${esc(c.customer)}</b><span class="tag ${c.status === 'open' ? 'warn' : 'ok'}">${esc(c.status)}</span></div><p>${esc(c.text)}</p><div class="small muted">${ftime(c.ts)}</div>
    ${c.status === 'open' ? `<form data-form="adm-resolve" data-id="${c.id}" class="row" style="margin-top:8px;flex-wrap:nowrap"><input name="resolution" required minlength="3" placeholder="Your response to the customer"><button class="btn sm">Resolve</button></form>` : `<p class="small"><b>Response:</b> ${esc(c.resolution)}</p>`}</div>`).join('')}</div>` : '<div class="empty">No complaints.</div>';
}
D.forms['adm-resolve'] = async (f) => { if (await guard(() => api('POST', '/api/admin/complaints/' + f.dataset.id, { resolution: f.resolution.value }))) { toast('Resolved. The customer was notified.'); render(); } };

// ---- content ----
async function admContent(q) {
  const sub = q.sub || 'designs', subs = [['designs', 'Designs'], ['fabrics', 'Fabrics'], ['categories', 'Categories']];
  let body = '';
  if (sub === 'designs') {
    const [ds, cs] = await Promise.all([api('GET', '/api/admin/designs'), api('GET', '/api/admin/categories')]); ADM.designs = ds; ADM.cats = cs;
    body = `<div class="row between" style="margin-bottom:12px"><p class="muted" style="margin:0">Designs customers can choose from</p><button class="btn sm" data-act="adm-design">+ Add design</button></div>` +
      tbl(['', 'Design', 'Category', '>Stitching', 'Status', ''], ds.filter(d => d.active || true).map(d => `<tr><td style="width:56px"><div style="width:48px;height:48px;border-radius:8px;overflow:hidden;background:#efe8d8;display:grid;place-items:center">${d.image_url ? `<img src="${esc(d.image_url)}" alt="" style="width:100%;height:100%;object-fit:cover">` : garment(catSlug(d.category_id), d.color).replace('<svg', '<svg width="40" height="40"')}</div></td><td><b>${esc(d.name)}</b>${d.featured ? ' <span class="tag">Featured</span>' : ''}</td><td>${esc(d.category)}</td><td class="right">${inr(d.price)}</td><td><span class="tag ${d.active ? 'ok' : 'bad'}">${d.active ? 'Live' : 'Removed'}</span></td><td class="right"><button class="btn ghost sm" data-act="adm-design" data-id="${d.id}">Edit</button> ${d.active ? `<button class="btn danger sm" data-act="adm-del" data-kind="designs" data-id="${d.id}">Remove</button>` : ''}</td></tr>`));
  }
  if (sub === 'fabrics') {
    const fs = await api('GET', '/api/admin/fabrics'); ADM.fabrics = fs;
    body = `<div class="row between" style="margin-bottom:12px"><p class="muted" style="margin:0">Fabric inventory. Margin = price minus cost.</p><button class="btn sm" data-act="adm-fabric">+ Add fabric</button></div>` +
      tbl(['Fabric', 'Colours', '>Price/m', '>Cost/m', '>Stock (m)', 'Status', ''], fs.map(f => `<tr><td><b>${esc(f.name)}</b></td><td><div class="swatches">${f.colors.map(c => `<span class="sw" style="background:${esc(c.hex)};width:20px;height:20px;cursor:default" title="${esc(c.name)}"></span>`).join('')}</div></td><td class="right">${inr(f.price_per_m)}</td><td class="right">${inr(f.cost_per_m)}</td><td class="right ${f.stock_m < 20 ? 'danger' : ''}">${f.stock_m}</td><td><span class="tag ${f.active ? 'ok' : 'bad'}">${f.active ? 'Available' : 'Hidden'}</span></td><td class="right"><button class="btn ghost sm" data-act="adm-fabric" data-id="${f.id}">Edit</button> ${f.active ? `<button class="btn danger sm" data-act="adm-del" data-kind="fabrics" data-id="${f.id}">Hide</button>` : ''}</td></tr>`));
  }
  if (sub === 'categories') {
    const cs = await api('GET', '/api/admin/categories'); ADM.cats = cs;
    body = `<div class="row between" style="margin-bottom:12px"><p class="muted" style="margin:0">Categories control sizes, measurement fields and fabric needed.</p><button class="btn sm" data-act="adm-cat">+ Add category</button></div>` +
      tbl(['Category', 'Sizes', 'Measurements', '>Fabric (m)', 'Status', ''], cs.map(c => `<tr><td><b>${esc(c.name)}</b></td><td class="small">${esc(c.sizes.join(', '))}</td><td class="small">${esc(c.fields.join(', '))}</td><td class="right">${c.fabric_m}</td><td><span class="tag ${c.active ? 'ok' : 'bad'}">${c.active ? 'Active' : 'Hidden'}</span></td><td class="right"><button class="btn ghost sm" data-act="adm-cat" data-id="${c.id}">Edit</button> <button class="btn danger sm" data-act="adm-del" data-kind="categories" data-id="${c.id}">Remove</button></td></tr>`));
  }
  return `<div class="chips" style="margin-bottom:16px">${subs.map(([k, l]) => `<a class="chip ${k === sub ? 'on' : ''}" style="text-decoration:none" href="#/admin?tab=content&sub=${k}">${l}</a>`).join('')}</div>${body}`;
}
D.actions['adm-del'] = async (el) => {
  const k = el.dataset.kind; if (!confirm(k === 'categories' ? 'Remove this category? If it has designs or orders it will be hidden instead.' : 'Remove this item from the customer app? Existing orders are not affected.')) return;
  const r = await guard(() => api('DELETE', `/api/admin/${k}/${el.dataset.id}`)); if (r) { toast(r.deactivated ? 'Category hidden (it is in use)' : 'Removed'); render(); }
};
D.actions['adm-cat'] = (el) => {
  const c = el.dataset.id ? ADM.cats.find(x => x.id === +el.dataset.id) : { name: '', sizes: ['S', 'M', 'L', 'XL', 'XXL'], fields: ['Chest', 'Waist', 'Length'], fabric_m: 2, active: 1 };
  modal(`<h3>${el.dataset.id ? 'Edit' : 'Add'} category</h3><form data-form="adm-cat" data-id="${el.dataset.id || ''}" class="stack"><div class="field"><label>Name</label><input name="name" required maxlength="40" value="${esc(c.name)}"></div>
    <div class="field"><label>Standard sizes (comma separated)</label><input name="sizes" required value="${esc(c.sizes.join(', '))}"></div><div class="field"><label>Measurement fields (comma separated)</label><input name="fields" required value="${esc(c.fields.join(', '))}"><div class="hint">Customers enter these in inches. Use names like Chest, Waist, Sleeve length.</div></div>
    <div class="field"><label>Fabric needed (metres)</label><input name="fabric_m" type="number" step="0.1" min="0.2" required value="${c.fabric_m}"></div><label class="row" style="font-weight:400"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Visible to customers</label>
    <div class="row"><button class="btn">Save</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`);
};
D.forms['adm-cat'] = async (f) => { const id = f.dataset.id; const body = { name: f.name.value, sizes: f.sizes.value, fields: f.fields.value, fabric_m: +f.fabric_m.value, active: f.active.checked }; if (await guard(() => api(id ? 'PUT' : 'POST', '/api/admin/categories' + (id ? '/' + id : ''), body))) { closeModal(); toast('Saved'); await loadConfig(); render(); } };
D.actions['adm-design'] = (el) => {
  const d = el.dataset.id ? ADM.designs.find(x => x.id === +el.dataset.id) : { name: '', category_id: ADM.cats[0].id, gender: 'unisex', price: '', color: '#d9cdb4', description: '', featured: 0, active: 1, image_url: null };
  modal(`<h3>${el.dataset.id ? 'Edit' : 'Add'} design</h3><form data-form="adm-design" data-id="${el.dataset.id || ''}" class="stack"><div class="field"><label>Design name</label><input name="name" required maxlength="80" value="${esc(d.name)}"></div>
    <div class="form-grid"><div class="field"><label>Category</label><select name="category_id">${ADM.cats.map(c => `<option value="${c.id}" ${c.id === d.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>For</label><select name="gender">${['unisex', 'men', 'women'].map(g => `<option ${g === d.gender ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
    <div class="field"><label>Stitching price (₹)</label><input name="price" type="number" min="1" required value="${esc(d.price)}"></div><div class="field"><label>Illustration colour</label><input name="color" type="color" value="${esc(d.color)}" style="padding:2px"></div></div>
    <div class="field"><label>Description</label><textarea name="description" maxlength="300" style="min-height:70px">${esc(d.description || '')}</textarea></div>${photoField('image', 'Design photo', d.image_url ? [d.image_url] : [], 1)}<p class="hint">Without a photo, a simple illustration in the colour above is shown.</p>
    <div class="row"><label class="row" style="font-weight:400"><input type="checkbox" name="featured" ${d.featured ? 'checked' : ''}> Featured on home</label><label class="row" style="font-weight:400"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Live</label></div>
    <div class="row"><button class="btn">Save</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`);
};
D.forms['adm-design'] = async (f) => { const id = f.dataset.id, d = formData(f); const body = { ...d, price: +d.price, category_id: +d.category_id, image_url: JSON.parse(d.image || '[]')[0] || null, featured: f.featured.checked, active: f.active.checked }; if (await guard(() => api(id ? 'PUT' : 'POST', '/api/admin/designs' + (id ? '/' + id : ''), body))) { closeModal(); toast('Saved'); render(); } };
D.actions['adm-fabric'] = (el) => {
  const f = el.dataset.id ? ADM.fabrics.find(x => x.id === +el.dataset.id) : { name: '', description: '', price_per_m: '', cost_per_m: '', colors: [{ name: 'White', hex: '#f4f1ea' }], stock_m: 50, active: 1, image_url: null };
  modal(`<h3>${el.dataset.id ? 'Edit' : 'Add'} fabric</h3><form data-form="adm-fabric" data-id="${el.dataset.id || ''}" class="stack"><div class="field"><label>Fabric name</label><input name="name" required maxlength="60" value="${esc(f.name)}"></div>
    <div class="field"><label>Description</label><textarea name="description" maxlength="300" style="min-height:70px">${esc(f.description || '')}</textarea></div>
    <div class="form-grid"><div class="field"><label>Price per metre (₹)</label><input name="price_per_m" type="number" min="1" required value="${esc(f.price_per_m)}"></div><div class="field"><label>Your cost per metre (₹)</label><input name="cost_per_m" type="number" min="0" required value="${esc(f.cost_per_m)}"></div><div class="field"><label>Stock (metres)</label><input name="stock_m" type="number" min="0" step="0.5" required value="${esc(f.stock_m)}"></div></div>
    <div class="field"><label>Colours (one per line: name then hex)</label><textarea name="colors" rows="4" style="min-height:90px">${esc(f.colors.map(c => `${c.name} ${c.hex}`).join('\n'))}</textarea><div class="hint">Example: Maroon #6e2c35</div></div>
    <label class="row" style="font-weight:400"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Available to customers</label>
    <div class="row"><button class="btn">Save</button><button type="button" class="btn ghost" data-act="close-modal">Cancel</button></div></form>`);
};
D.forms['adm-fabric'] = async (f) => {
  const id = f.dataset.id, d = formData(f);
  const colors = d.colors.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = /^(.*?)\s*(#[0-9a-fA-F]{6})$/.exec(l); return m ? { name: m[1].trim() || 'Colour', hex: m[2] } : { name: l, hex: '#cccccc' }; });
  const body = { name: d.name, description: d.description, price_per_m: +d.price_per_m, cost_per_m: +d.cost_per_m, stock_m: +d.stock_m, colors, active: f.active.checked };
  if (await guard(() => api(id ? 'PUT' : 'POST', '/api/admin/fabrics' + (id ? '/' + id : ''), body))) { closeModal(); toast('Saved'); render(); }
};
