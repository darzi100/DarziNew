'use strict';
async function loadConfig() { D.cfg = await api('GET', '/api/config'); }
(async function boot() {
  try {
    await loadConfig();
    try { D.me = await api('GET', '/api/me'); } catch { D.me = null; }
    renderChrome(); await render();
  } catch (e) {
    $('#app').innerHTML = `<div class="empty"><h2>We could not load the app</h2><p>${esc(e.message)}</p><button class="btn" data-act="reload">Try again</button></div>`;
  }
})();
D.actions.reload = () => location.reload();
