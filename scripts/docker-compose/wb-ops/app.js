/* WB ops for OpenReplay — same-origin page, uses the logged-in OR session.
 * chalice API under /api (login/refresh, projects, metadata), Go API under /v2/api (cards, dashboards, sessions). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { jwt: null, user: null, projects: [], project: null, templates: {}, plan: null };

  /* ---------------- API ---------------- */
  // The OpenReplay SPA persists its JWT in localStorage (mobx-persist "UserStore") and the
  // refresh cookie is httpOnly on /api/refresh. /api/refresh wants both: the (possibly expired)
  // bearer and the cookie. We reuse the SPA's token, never store anything ourselves.
  function storedJwt() {
    try { const s = JSON.parse(localStorage.getItem('UserStore') || '{}'); return s.jwt || null; } catch (e) { return null; }
  }
  function jwtExpired(jwt) {
    try { const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return !p.exp || p.exp * 1000 < Date.now() + 30000; } catch (e) { return true; }
  }
  // We never call /api/refresh ourselves: a refresh rotates the user's token generation and
  // logs the SPA out in the other tab. The SPA's token lives ~24 h and the SPA re-persists a
  // fresh one whenever it refreshes, so re-reading localStorage is all the "refresh" we need.
  async function refreshJwt() {
    const jwt = storedJwt();
    if (!jwt) throw new Error('Brak sesji OpenReplay w tej przeglądarce — zaloguj się w OpenReplay i wróć na tę stronę.');
    if (jwtExpired(jwt)) throw new Error('Sesja OpenReplay wygasła — otwórz OpenReplay w nowej karcie (odświeży token) i wróć.');
    state.jwt = jwt;
  }
  async function api(path, opts = {}, retry = true) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts, {
      headers: Object.assign({ Authorization: 'Bearer ' + state.jwt, 'Content-Type': 'application/json' }, opts.headers || {}),
    }));
    // 401/403 "Invalid token": OpenReplay keeps one token generation per user — any login or
    // refresh elsewhere invalidates this one. The SPA tab re-persists a fresh token on its next
    // load, so re-read it; if nothing changed, the user has to reopen OpenReplay.
    if ((r.status === 401 || r.status === 403) && retry) {
      const before = state.jwt; await refreshJwt();
      if (state.jwt === before) throw new Error('OpenReplay odrzucił token (' + r.status + ') — otwórz OpenReplay w nowej karcie (zaloguj się, jeśli poprosi), wróć tutaj i odśwież.');
      return api(path, opts, false);
    }
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = text; }
    if (!r.ok) throw new Error(path + ' → ' + r.status + ' ' + (typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : String(body).slice(0, 300)));
    return body && body.data !== undefined ? body.data : body;
  }
  const v1 = (p) => '/api' + p;
  const v2 = (p) => '/v2/api' + p;
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  /* ---------------- helpers ---------------- */
  function log(el, msg, cls) { const line = document.createElement('div'); line.textContent = msg; if (cls) line.style.color = cls === 'err' ? '#fca5a5' : cls === 'ok' ? '#86efac' : ''; el.appendChild(line); el.scrollTop = el.scrollHeight; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const eventFilter = (name) => ({ name, isEvent: true, operator: 'is', value: [], propertyOrder: 'and', filters: [], autoCaptured: false, dataType: 'string' });
  const dayMs = 864e5;
  const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);

  function cardPayload(def) {
    return {
      name: def.name,
      metricType: def.metricType,
      metricOf: def.metricOf,
      metricFormat: def.metricFormat || 'sessionCount',
      viewType: def.viewType,
      metricValue: [],
      isPublic: true,
      config: {},
      defaultConfig: {},
      series: def.series.map((s, i) => ({ name: s.name, index: i, filter: { eventsOrder: 'then', filters: s.events.map(eventFilter) } })),
    };
  }

  /* ---------------- projects ---------------- */
  async function loadProjects() {
    const list = await api(v1('/projects'));
    state.projects = Array.isArray(list) ? list : [];
    const sel = $('project');
    sel.innerHTML = '';
    state.projects.forEach((p) => { const o = document.createElement('option'); o.value = p.projectId; o.textContent = p.name + ' (' + p.projectKey + ')'; sel.appendChild(o); });
    const remembered = localStorage.getItem('wbops.project');
    if (remembered && state.projects.some((p) => String(p.projectId) === remembered)) sel.value = remembered;
    selectProject();
  }
  function selectProject() {
    const id = $('project').value;
    state.project = state.projects.find((p) => String(p.projectId) === String(id)) || null;
    try { localStorage.setItem('wbops.project', id); } catch (e) {}
    $('s-template').hidden = !state.project;
    $('s-key').hidden = !state.project;
    $('s-export').hidden = !state.project;
    $('plan-out').innerHTML = ''; $('apply-log').textContent = ''; $('apply').disabled = true; state.plan = null;
    if (!state.project) return;
    const p = state.project;
    $('project-info').textContent = 'id ' + p.projectId + ' · utworzony ' + fmtDate(p.createdAt) + ' · sample rate ' + p.sampleRate + '%' + (p.recorded ? ' · nagrywa' : ' · jeszcze bez sesji');
    $('project-key').textContent = p.projectKey;
    $('dash-link').textContent = ''; $('dash-link').removeAttribute('href');
    const from = $('from'), to = $('to');
    if (!from.value) { from.value = fmtDate(Date.now() - 14 * dayMs); to.value = fmtDate(Date.now()); }
  }
  async function createProject() {
    const name = $('new-name').value.trim();
    if (name.length < 2) return alert('Podaj nazwę projektu');
    $('create').disabled = true;
    try {
      const created = await post(v1('/projects'), { name, platform: 'web' });
      await loadProjects();
      const id = created && (created.projectId || (created.data && created.data.projectId));
      if (id) { $('project').value = id; selectProject(); }
      $('new-name').value = '';
    } catch (e) { alert(e.message); } finally { $('create').disabled = false; }
  }

  /* ---------------- template: plan + apply ---------------- */
  async function loadTemplates() {
    const names = ['prestashop'];
    const sel = $('template');
    for (const n of names) {
      const r = await fetch('templates/' + n + '.json?v=' + Date.now());
      state.templates[n] = await r.json();
      const o = document.createElement('option'); o.value = n; o.textContent = state.templates[n].name; sel.appendChild(o);
    }
  }
  async function currentState(pid) {
    const [meta, dashboards, cards] = await Promise.all([
      api(v1('/' + pid + '/metadata')),
      api(v2('/' + pid + '/dashboards')),
      api(v2('/' + pid + '/cards?limit=200&page=1')),
    ]);
    return {
      metadata: (Array.isArray(meta) ? meta : []).map((m) => m.key),
      dashboards: (dashboards && dashboards.dashboards) || (Array.isArray(dashboards) ? dashboards : []),
      cards: (cards && cards.list) || (Array.isArray(cards) ? cards : []),
    };
  }
  async function makePlan() {
    const tpl = state.templates[$('template').value];
    const pid = state.project.projectId;
    $('plan-out').innerHTML = '<p class="muted">Sprawdzam projekt…</p>';
    try {
      const cur = await currentState(pid);
      const metaTodo = tpl.metadata.filter((k) => !cur.metadata.includes(k));
      const freeSlots = 10 - cur.metadata.length;
      const dashboard = cur.dashboards.find((d) => d.name === tpl.dashboard.name) || null;
      const existingCardNames = new Set(cur.cards.map((c) => c.name));
      const cardsTodo = tpl.cards.filter((c) => !existingCardNames.has(c.name));
      const cardsHave = tpl.cards.filter((c) => existingCardNames.has(c.name)).map((c) => cur.cards.find((x) => x.name === c.name));
      state.plan = { tpl, pid, metaTodo, dashboard, cardsTodo, cardsHave, cur };
      const rows = [];
      tpl.metadata.forEach((k) => rows.push(['metadata', esc(k), cur.metadata.includes(k) ? '<span class="tag ok">jest</span>' : '<span class="tag todo">dodam</span>']));
      rows.push(['dashboard', esc(tpl.dashboard.name), dashboard ? '<span class="tag ok">jest (#' + esc(dashboard.dashboardId) + ')</span>' : '<span class="tag todo">dodam</span>']);
      tpl.cards.forEach((c) => rows.push(['karta', esc(c.name) + ' <span class="muted">' + esc(c.metricType + '/' + c.metricOf) + '</span>', existingCardNames.has(c.name) ? '<span class="tag ok">jest</span>' : '<span class="tag todo">dodam</span>']));
      let warn = '';
      if (metaTodo.length > freeSlots) warn = '<p class="tag err">Brakuje slotów metadata: potrzeba ' + metaTodo.length + ', wolnych ' + freeSlots + ' (limit 10). Dodam tylko pierwsze ' + Math.max(0, freeSlots) + '.</p>';
      $('plan-out').innerHTML = warn + '<table><tr><th>typ</th><th>nazwa</th><th>stan</th></tr>' + rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('') + '</table>';
      $('apply').disabled = !(metaTodo.length || !dashboard || cardsTodo.length);
      if ($('apply').disabled) $('plan-out').innerHTML += '<p class="muted">Nic do zrobienia — projekt ma już wszystko z szablonu.</p>';
      if (dashboard) setDashLink(dashboard.dashboardId);
    } catch (e) { $('plan-out').innerHTML = '<p class="tag err">' + esc(e.message) + '</p>'; }
  }
  function setDashLink(id) { const a = $('dash-link'); a.href = '/' + state.project.projectId + '/dashboard/' + id; a.textContent = 'Otwórz dashboard →'; }
  async function applyPlan() {
    const p = state.plan; if (!p) return;
    const out = $('apply-log'); out.textContent = ''; $('apply').disabled = true;
    try {
      const freeSlots = 10 - p.cur.metadata.length;
      for (const key of p.metaTodo.slice(0, Math.max(0, freeSlots))) {
        await post(v1('/' + p.pid + '/metadata'), { key });
        log(out, 'metadata + ' + key, 'ok');
      }
      const cardIds = p.cardsHave.map((c) => c.metricId).filter(Boolean);
      for (const def of p.cardsTodo) {
        const created = await post(v2('/' + p.pid + '/cards'), cardPayload(def));
        const id = created && (created.metricId || created.cardId || (created.card && created.card.metricId));
        if (!id) throw new Error('karta utworzona, ale bez id: ' + JSON.stringify(created).slice(0, 200));
        cardIds.push(id);
        log(out, 'karta + ' + def.name + ' (#' + id + ')', 'ok');
      }
      let dashboardId = p.dashboard ? p.dashboard.dashboardId : null;
      if (!dashboardId) {
        const d = await post(v2('/' + p.pid + '/dashboards'), { name: p.tpl.dashboard.name, description: p.tpl.dashboard.description, isPublic: true, isPinned: true, metrics: cardIds });
        dashboardId = d && (d.dashboard_id || d.dashboardId || (d.dashboard && d.dashboard.dashboardId));
        log(out, 'dashboard + ' + p.tpl.dashboard.name + ' (#' + dashboardId + ')', 'ok');
      }
      // `metrics` on create is not guaranteed to attach anything; add the missing cards explicitly
      const fresh = await api(v2('/' + p.pid + '/dashboards/' + dashboardId));
      const onBoard = new Set(((fresh && (fresh.widgets || fresh.metrics)) || []).map((w) => w.metricId));
      const missing = cardIds.filter((id) => !onBoard.has(id));
      if (missing.length) {
        await post(v2('/' + p.pid + '/dashboards/' + dashboardId + '/cards'), { metric_ids: missing, config: {} });
        log(out, 'dashboard ← ' + missing.length + ' kart (#' + missing.join(', #') + ')', 'ok');
      }
      if (dashboardId) setDashLink(dashboardId);
      log(out, 'Gotowe.', 'ok');
      await makePlan();
    } catch (e) { log(out, 'BŁĄD: ' + e.message, 'err'); $('apply').disabled = false; }
  }

  /* ---------------- export ---------------- */
  async function exportData() {
    const out = $('export-log'); out.textContent = ''; $('downloads').innerHTML = ''; $('export').disabled = true;
    const pid = state.project.projectId;
    const from = new Date($('from').value + 'T00:00:00').getTime();
    const to = new Date($('to').value + 'T23:59:59').getTime();
    const max = Math.max(10, Math.min(2000, parseInt($('max').value, 10) || 300));
    const only = $('only-event').value.trim();
    try {
      const filters = only ? [eventFilter(only)] : [];
      const sessions = [];
      for (let page = 1; sessions.length < max; page++) {
        const res = await post(v2('/' + pid + '/sessions/search'), { startTimestamp: from, endTimestamp: to, filters, limit: 100, page, sort: 'startTs', order: 'desc' });
        const batch = (res && res.sessions) || [];
        sessions.push(...batch);
        log(out, 'sesje: ' + sessions.length + ' / ' + (res && res.total));
        if (batch.length < 100 || (res && sessions.length >= res.total)) break;
      }
      sessions.splice(max);
      const rows = [];
      let i = 0;
      const worker = async () => {
        while (i < sessions.length) {
          const s = sessions[i++];
          let ev = { userEvents: [], issues: [], errors: [] };
          try { ev = await api(v2('/' + pid + '/sessions/' + s.sessionId + '/events')); } catch (e) { log(out, 'events ' + s.sessionId + ': ' + e.message, 'err'); }
          const events = (ev.userEvents || []).map((e) => ({ t: e.timestamp - s.startTs, name: e.name, props: e.properties }));
          const eventNames = new Set(events.map((e) => e.name));
          const issues = (ev.issues || []).filter((x) => x.issueType !== 'custom' || !eventNames.has(x.contextString)).map((x) => ({ t: x.timestamp - s.startTs, type: x.issueType, name: x.contextString }));
          rows.push({
            sessionId: s.sessionId, url: location.origin + '/' + pid + '/session/' + s.sessionId,
            start: new Date(s.startTs).toISOString(), durationSec: Math.round((s.duration || 0) / 1000),
            userId: s.userId || null, device: s.userDeviceType, browser: s.userBrowser, os: s.userOs, country: s.userCountry, city: s.userCity,
            screen: s.screenWidth + 'x' + s.screenHeight, metadata: s.metadata || {}, errorsCount: s.errorsCount, eventsCount: s.eventsCount, issueTypes: s.issueTypes || [],
            events, issues, jsErrors: (ev.errors || []).map((e) => ({ t: e.timestamp - s.startTs, name: e.name, message: (e.message || '').slice(0, 200) })),
          });
          if (rows.length % 25 === 0) log(out, 'pobrano eventy: ' + rows.length + ' / ' + sessions.length);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      rows.sort((a, b) => (a.start < b.start ? 1 : -1));
      const exportJson = { project: { id: pid, name: state.project.name, key: state.project.projectKey }, range: { from: $('from').value, to: $('to').value }, generatedAt: new Date().toISOString(), sessions: rows };
      const digest = buildDigest(exportJson);
      offerDownload('export.json', JSON.stringify(exportJson, null, 1), 'application/json');
      offerDownload('DIGEST.md', digest, 'text/markdown');
      log(out, 'Gotowe: ' + rows.length + ' sesji.', 'ok');
    } catch (e) { log(out, 'BŁĄD: ' + e.message, 'err'); } finally { $('export').disabled = false; }
  }
  function offerDownload(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.textContent = '⬇ ' + name + ' (' + Math.round(content.length / 1024) + ' KB)';
    a.className = 'tag'; $('downloads').appendChild(a);
  }
  function buildDigest(x) {
    const S = x.sessions; const n = S.length || 1;
    const has = (s, name) => s.events.some((e) => e.name === name) || s.issues.some((i) => i.name === name);
    const count = (name) => S.filter((s) => has(s, name)).length;
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0) + '%';
    const steps = ['product_view', 'cart_add', 'checkout_view', 'checkout_submit', 'order_complete'];
    const funnel = steps.map((st) => [st, count(st)]);
    const issueNames = {};
    S.forEach((s) => { const seen = new Set(); s.events.concat(s.issues).forEach((e) => { if (/error|failed|blocked|unavailable/.test(e.name) && !seen.has(e.name)) { seen.add(e.name); issueNames[e.name] = (issueNames[e.name] || 0) + 1; } }); });
    const topIssues = Object.entries(issueNames).sort((a, b) => b[1] - a[1]);
    const sessionsWith = (name, k = 10) => S.filter((s) => has(s, name)).slice(0, k).map((s) => {
      const ev = s.events.find((e) => e.name === name) || {};
      return '- ' + s.url + ' — ' + s.start.slice(0, 16).replace('T', ' ') + ', ' + (s.userId || 'anon') + ', ' + s.device + '/' + s.browser + (ev.props ? ' — `' + JSON.stringify(ev.props).slice(0, 160) + '`' : '');
    }).join('\n');
    const propCounts = (name, key) => { const m = {}; S.forEach((s) => s.events.filter((e) => e.name === name && e.props && e.props[key] !== undefined).forEach((e) => { const v = String(e.props[key]); m[v] = (m[v] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15); };
    const jsErr = {}; S.forEach((s) => s.jsErrors.forEach((e) => { const k = e.name + ': ' + e.message; jsErr[k] = (jsErr[k] || 0) + 1; }));
    const md = [];
    md.push('# ' + x.project.name + ' — OpenReplay digest ' + x.range.from + ' → ' + x.range.to);
    md.push('', 'Sesji w eksporcie: **' + S.length + '** (project ' + x.project.id + ', key ' + x.project.key + '). Każda sesja ma link do nagrania; eventy pochodzą z modułu wb_openreplay (payloady bez danych osobowych).');
    md.push('', '## Lejek (sesje z eventem, % względem product_view)');
    md.push('| krok | sesje | % | spadek |', '|---|---|---|---|');
    funnel.forEach(([st, c], i) => md.push('| ' + st + ' | ' + c + ' | ' + pct(c, funnel[0][1]) + ' | ' + (i ? pct(funnel[i - 1][1] - c, funnel[i - 1][1]) : '—') + ' |'));
    md.push('', '## Problemy na ścieżce (sesje, w których wystąpił)');
    if (!topIssues.length) md.push('brak');
    topIssues.forEach(([k, c]) => md.push('- **' + k + '**: ' + c + ' (' + pct(c, n) + ')'));
    ['checkout_submit_blocked', 'checkout_form_error', 'payment_error', 'cart_add_failed', 'voucher_error'].forEach((name) => { const c = count(name); if (c) { md.push('', '### ' + name + ' — ' + c + ' sesji', sessionsWith(name)); } });
    md.push('', '## Przewoźnicy i płatności (wybory)');
    md.push('- przewoźnik: ' + (propCounts('checkout_carrier_select', 'name').map(([k, c]) => k + ' ×' + c).join(', ') || 'brak danych'));
    md.push('- płatność: ' + (propCounts('checkout_payment_select', 'module').map(([k, c]) => k + ' ×' + c).join(', ') || 'brak danych'));
    md.push('', '## Kody rabatowe');
    md.push('- wpisane: ' + (propCounts('voucher_add', 'code').map(([k, c]) => k + ' ×' + c).join(', ') || 'brak'));
    md.push('- odrzucone: ' + (propCounts('voucher_error', 'code').map(([k, c]) => k + ' ×' + c).join(', ') || 'brak'));
    md.push('', '## Wyszukiwarka');
    md.push('- frazy: ' + (propCounts('search_submit', 'q').map(([k, c]) => '"' + k + '" ×' + c).join(', ') || 'brak'));
    md.push('', '## Błędy JS (top)');
    const je = Object.entries(jsErr).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (!je.length) md.push('brak'); je.forEach(([k, c]) => md.push('- ' + c + '× ' + k));
    md.push('', '## Urządzenia');
    const dev = {}; S.forEach((s) => { dev[s.device] = (dev[s.device] || 0) + 1; });
    md.push(Object.entries(dev).map(([k, c]) => k + ' ' + pct(c, n)).join(', '));
    md.push('', '## Jak czytać', '- `export.json` → `sessions[]` z `events[]` (t = ms od startu sesji, `props` = payload), `issues[]`, `jsErrors[]`, `metadata`.', '- Zamówione sesje: `metadata.order_id` albo event `order_complete`.', '- Klient/koszyk w PrestaShop: `userId` = `customer:<id_customer>` / `guest:<id_guest>`, `metadata.cart_id`.');
    return md.join('\n');
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    try {
      await refreshJwt();
      const acc = await api(v1('/account'));
      state.user = acc; $('who').textContent = (acc && (acc.email || acc.name)) || '';
      $('gate').hidden = true; $('s-project').hidden = false;
      await Promise.all([loadProjects(), loadTemplates()]);
    } catch (e) {
      $('gate-error').textContent = e.message;
      return;
    }
    $('project').addEventListener('change', selectProject);
    $('create').addEventListener('click', createProject);
    $('plan').addEventListener('click', makePlan);
    $('apply').addEventListener('click', applyPlan);
    $('export').addEventListener('click', exportData);
    $('copy-key').addEventListener('click', () => navigator.clipboard.writeText($('project-key').textContent).then(() => { $('copy-key').textContent = 'Skopiowano'; setTimeout(() => ($('copy-key').textContent = 'Kopiuj'), 1500); }));
  }
  boot();
})();
