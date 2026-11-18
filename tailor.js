'use strict';
/* Tailor experience: registration/profile, approval states, order dashboard. */
const NEXT = { 'Tailor Assigned': ['Stitching Started', 'Start stitching'], 'Stitching Started': ['Quality Check', 'Move to quality check'], 'Quality Check': ['Ready for Delivery', 'Mark ready for delivery'] };

route('/tailor', async (m, q) => {
  const me = await api('GET', '/api/me'); D.me = { ...D.me, ...me };
  const st = me.tailor.status;
  if (st === 'approved') return tailorDash(q);
  const p = await api('GET', '/api/tailor/profile');
  if (st === 'pending' && !q.edit) return view(`<div class="login card stack center"><h2>Application under review</h2><p class="muted">Thanks, ${esc(me.name.split(' ')[0])}. Our team is reviewing your profile. You will get a notification once you are approved. You cannot receive orders until then.</p><a class="btn ghost" href="#/tailor?edit=1">Edit my profile</a></div>`);
  if (st === 'suspended') return view(`<div class="login card stack center"><h2>Account suspended</h2><p class="muted">${esc(p.admin_note || 'Please contact support.')}</p></div>`);
  tailorForm(p, st);
}, ['tailor']);
function tailorForm(p, st) {
  const note = st === 'rejected' ? `<div class="banner bad">Your application was not approved${p.admin_note ? ': ' + esc(p.admin_note) : ''}. Update your details and submit again.</div>` : '';
  view(`<div style="max-width:720px;margin:0 auto"><h2>${st === 'incomplete' ? 'Complete your tailor profile' : 'Edit your profile'}</h2><p class="muted">Your account stays pending until our team approves it. Bank or UPI details are used only for payouts.</p>${note}
  <form data-form="tailor-profile" class="stack" style="margin-top:14px">
    <div class="card stack"><h3>About you</h3><div class="form-grid"><div class="field"><label>Full name</label><input name="name" required value="${esc(D.me.name)}"></div><div class="field"><label>Mobile</label><input value="+91 ${esc(D.me.mobile)}" disabled></div>
      <div class="field"><label>Years of experience</label><input name="experience" type="number" min="0" max="60" required value="${esc(p.experience ?? '')}"></div><div class="field"><label>Orders you can take per day</label><input name="capacity" type="number" min="1" max="50" required value="${esc(p.capacity ?? 3)}"></div></div>
      <div class="field"><label>Home address</label><textarea name="address" required maxlength="200">${esc(p.address || '')}</textarea></div></div>
    <div class="card stack"><h3>Shop</h3><div class="field"><label>Shop address</label><textarea name="shop_location" required maxlength="200">${esc(p.shop_location || '')}</textarea></div>
      <div><label>Shop location on map</label><div class="map" data-map></div><div class="row"><button type="button" class="btn ghost sm" data-act="locate">Use my current location</button></div>
      <input type="hidden" name="shop_lat" value="${p.shop_lat ?? ''}"><input type="hidden" name="shop_lng" value="${p.shop_lng ?? ''}"></div></div>
    <div class="card stack"><h3>What can you stitch?</h3><div class="chips">${D.cfg.categories.map(c => `<label class="chip ${p.categories.includes(c.id) ? 'on' : ''}" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" name="cat" value="${c.id}" ${p.categories.includes(c.id) ? 'checked' : ''} data-change="chip-toggle"> ${esc(c.name)}</label>`).join('')}</div></div>
    <div class="card stack"><h3>Portfolio</h3>${photoField('portfolio', 'Photos of your past work (at least 1)', p.portfolio, 8)}</div>
    <div class="card stack"><h3>Payout details</h3><p class="hint">Provide a UPI ID, or bank account details, or both.</p><div class="form-grid"><div class="field"><label>UPI ID</label><input name="upi" value="${esc(p.upi || '')}" placeholder="name@bank"></div>
      <div class="field"><label>Account holder</label><input name="bank_holder" value="${esc(p.bank_holder || '')}"></div><div class="field"><label>Account number</label><input name="bank_account" inputmode="numeric" value="${esc(p.bank_account || '')}"></div><div class="field"><label>IFSC</label><input name="bank_ifsc" value="${esc(p.bank_ifsc || '')}" style="text-transform:uppercase"></div></div></div>
    <button class="btn block">Submit for approval</button></form></div>`, () => { const f = $('form'); mountMap($('[data-map]', f), f.shop_lat, f.shop_lng); });
}
D.changes['chip-toggle'] = (el) => el.closest('.chip').classList.toggle('on', el.checked);
D.forms['tailor-profile'] = async (f) => {
  const d = formData(f), b = f.querySelector(':scope > button.btn'); busy(b, true);
  try {
    await api('PUT', '/api/tailor/profile', { ...d, categories: $$('[name=cat]:checked', f).map(i => +i.value), portfolio: JSON.parse(d.portfolio || '[]') });
    toast('Submitted for approval'); go('#/tailor');
  } catch (e) { toast(e.message, true); busy(b, false); }
};

async function tailorDash(q) {
  const data = await api('GET', '/api/tailor/orders'), os = data.orders, tab = q.tab || 'new';
  const groups = {
    new: os.filter(o => o.tailor_status === 'new'),
    accepted: os.filter(o => o.tailor_status === 'accepted' && o.status === 'Tailor Assigned'),
    progress: os.filter(o => ['Stitching Started', 'Quality Check'].includes(o.status)),
    completed: os.filter(o => ['Ready for Delivery', 'Out for Delivery', 'Delivered'].includes(o.status)),
    rejected: data.rejected
  };
  const E = data.earnings;
  const tabs = [['new', 'New orders'], ['accepted', 'Accepted'], ['progress', 'In progress'], ['completed', 'Completed'], ['rejected', 'Rejected'], ['earnings', 'Earnings']];
  let body = '';
  if (tab === 'earnings') body = `<div class="grid g3" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))"><div class="stat"><b>${inr(E.earned)}</b><span>Earned (delivered orders)</span></div><div class="stat"><b>${inr(E.paid_out)}</b><span>Paid out to you</span></div><div class="stat"><b>${inr(E.balance)}</b><span>Balance to be paid</span></div><div class="stat"><b>${inr(E.in_progress)}</b><span>In progress</span></div></div>
    <h3 style="margin-top:24px">Payouts</h3>${data.payouts.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Note</th><th class="right">Amount</th></tr></thead><tbody>${data.payouts.map(p => `<tr><td>${fdate(p.ts)}</td><td>${esc(p.note)}</td><td class="right">${inr(p.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No payouts recorded yet.</p>'}
    <p class="hint">Earnings are your stitching charge minus the platform commission, counted when an order is delivered.</p>`;
  else if (tab === 'rejected') body = groups.rejected.length ? `<div class="tablewrap"><table><thead><tr><th>Order</th><th>Item</th><th>Reason</th><th>Date</th></tr></thead><tbody>${groups.rejected.map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.design)} (${esc(r.category)})</td><td>${esc(r.reason || '—')}</td><td>${fdate(r.ts)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No rejected orders.</div>';
  else body = groups[tab].length ? `<div class="grid g2" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${groups[tab].map(tailorOrderCard).join('')}</div>` : `<div class="empty">No orders here right now.</div>`;
  view(`<div class="row between"><h2 style="margin:0">Hello, ${esc(D.me.name.split(' ')[0])}</h2><span class="muted">${data.rating ? `Rating ${stars(data.rating)} (${data.reviews})` : 'No reviews yet'}</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin:16px 0">${[['new', 'New'], ['progress', 'In progress']].map(([k, l]) => `<a class="stat" href="#/tailor?tab=${k}" style="text-decoration:none"><b>${groups[k].length}</b><span>${l}</span></a>`).join('')}<a class="stat" href="#/tailor?tab=earnings" style="text-decoration:none"><b>${inr(E.balance)}</b><span>To be paid</span></a></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/tailor?tab=${k}" class="${k === tab ? 'on' : ''}">${l}${groups[k] && groups[k].length ? ` (${groups[k].length})` : ''}</a>`).join('')}</div>${body}`);
}
function tailorOrderCard(o) {
  const late = o.deadline && o.deadline < ymd(0) && !['Ready for Delivery', 'Out for Delivery', 'Delivered'].includes(o.status);
  const next = NEXT[o.status], waitFabric = o.fabric_own && o.pickup_status !== 'Collected';
  return `<div class="card stack"><div class="row between"><div><b>${esc(o.design)}</b><div class="small muted">${esc(o.code)} · ${esc(o.category)} · for ${esc(o.customer_first_name)}</div></div>${statusTag(o.status)}</div>
    <div class="sumrow"><span>Fabric</span><b>${esc(o.fabric)}${o.color ? ', ' + esc(o.color) : ''}</b></div>
    <div class="sumrow"><span>Deadline</span><b>${o.deadline ? fdate(o.deadline) : 'Set when you accept'} ${late ? '<span class="tag bad">Overdue</span>' : ''}</b></div>
    <div class="sumrow"><span>You earn</span><b>${inr(o.tailor_payable)}</b></div>
    ${waitFabric ? '<div class="banner">The customer\'s fabric has not been collected yet. You can start once it is collected.</div>' : ''}
    ${o.notes ? `<div><div class="small muted">Customer instructions</div><p style="margin:2px 0 0">${esc(o.notes)}</p></div>` : ''}
    ${o.ref_photos.length ? `<div class="thumbs">${o.ref_photos.map(u => `<img src="${esc(u)}" alt="Reference photo">`).join('')}</div>` : ''}
    <details ${o.tailor_status === 'new' ? 'open' : ''}><summary style="cursor:pointer;font-weight:600">${o.measure_mode === 'standard' ? 'Size ' + esc(o.size) : 'Measurements (inches)'}</summary>${o.measurements ? measureTable(o.measurements) : o.size ? '' : '<p class="muted small">Not available yet.</p>'}</details>
    ${o.tailor_status === 'new' ? `<div class="row"><button class="btn" data-act="t-accept" data-id="${o.id}">Accept</button><button class="btn danger" data-act="t-reject" data-id="${o.id}">Reject</button></div>` : ''}
    ${o.tailor_status === 'accepted' && next ? `<button class="btn" data-act="t-next" data-id="${o.id}" data-s="${next[0]}" ${waitFabric && o.status === 'Tailor Assigned' ? 'disabled' : ''}>${next[1]}</button>` : ''}</div>`;
}
D.actions['t-accept'] = async (el) => { if (await guard(() => api('POST', `/api/tailor/orders/${el.dataset.id}/respond`, { accept: true }))) { toast('Order accepted'); go('#/tailor?tab=accepted'); } };
D.actions['t-reject'] = (el) => modal(`<h3>Reject this order?</h3><p class="muted">It will go back to our team for reassignment.</p><form data-form="t-reject" data-id="${el.dataset.id}" class="stack"><div class="field"><label>Reason (optional)</label><input name="reason" maxlength="200" placeholder="e.g. Fully booked this week"></div><div class="row"><button class="btn danger">Reject order</button><button type="button" class="btn ghost" data-act="close-modal">Back</button></div></form>`);
D.forms['t-reject'] = async (f) => { if (await guard(() => api('POST', `/api/tailor/orders/${f.dataset.id}/respond`, { accept: false, reason: f.reason.value }))) { closeModal(); toast('Order rejected'); render(); } };
D.actions['t-next'] = async (el) => { if (await guard(() => api('POST', `/api/tailor/orders/${el.dataset.id}/status`, { status: el.dataset.s }))) { toast('Status updated. The customer was notified.'); render(); } };
