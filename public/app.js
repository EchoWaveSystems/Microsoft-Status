'use strict';

// Which product name each platform card's icon is resolved from (null = Microsoft four-square logo).
const PLATFORM_ICON = { mac: 'Microsoft 365', m365Consumer: null, azure: 'Azure', ppac: 'Power Platform' };

// Service name → official icon in /icons (".svg" unless an extension is given). First match wins, so the
// specific names come first: "Defender for Office 365" must hit Defender, not Office. Sources: Microsoft's
// Fabric CDN, Learn, and the Azure / Power Platform / Dynamics 365 / Fabric / Entra icon packs; Planner, Lists,
// Defender from Wikimedia Commons; Whiteboard, Phone Link from the Microsoft Store. Graph uses the Graph Explorer
// icon from Learn, as Microsoft publishes no standalone Graph logo. Optional third value: zoom for padded artwork.
// Anything unmatched falls back to an initials monogram.
const PRODUCT_ICONS = [
  // Security, identity, compliance
  [/defender for cloud/, 'defendercloud'], [/defender/, 'defender'], [/sentinel/, 'sentinel'],
  [/purview|information protection|compliance/, 'purview'], [/intune|endpoint manager/, 'intune'],
  [/\bentra id\b|azure (ad|active directory)/, 'entraid'], [/\bentra\b/, 'entra'],
  // Power Platform
  [/power ?bi/, 'powerbi'], [/power apps/, 'powerapps'], [/power automate|\bflow\b/, 'powerautomate'],
  [/power pages/, 'powerpages'], [/copilot studio|power virtual agents/, 'copilotstudio'],
  [/dataverse/, 'dataverse'], [/ai builder/, 'aibuilder'], [/power platform/, 'powerplatform'],
  // Dynamics 365 apps, then the family
  [/business central/, 'd365-businesscentral'], [/customer service/, 'd365-customerservices'],
  [/field service/, 'd365-fieldservice'], [/finance (and|&) operations/, 'd365-financeoperations'],
  [/dynamics.*finance|\bfinance\b/, 'd365-finance'], [/supply chain/, 'd365-supplychainmanagement'],
  [/dynamics.*commerce/, 'd365-commerce'], [/human resources/, 'd365-humanresources'],
  [/project operations/, 'd365-projectoperations'], [/customer insights/, 'd365-customerinsights'],
  [/customer voice/, 'd365-customervoice'], [/contact center/, 'd365-contactcenter'],
  [/dynamics.*sales|sales insights/, 'd365-sales'], [/dynamics/, 'dynamics365'],
  // Viva
  [/viva engage/, 'viva-engage'], [/viva connections/, 'viva-connections'], [/viva insights/, 'viva-insights'],
  [/viva learning/, 'viva-learning'], [/viva goals/, 'viva-goals'], [/viva glint/, 'viva-glint'],
  [/viva pulse/, 'viva-pulse'], [/viva amplify/, 'viva-amplify'],
  // Microsoft 365 apps and services
  [/copilot/, 'copilot'], [/exchange/, 'exchange'], [/outlook/, 'outlook'], [/teams/, 'teams'],
  [/sharepoint/, 'sharepoint'], [/onedrive/, 'onedrive'], [/onenote/, 'onenote'], [/\bto[- ]?do\b/, 'todo'],
  [/planner/, 'planner'], [/\blists\b/, 'lists'], [/whiteboard/, 'whiteboard.png'], [/graph/, 'graph'],
  [/phone link|your ?phone/, 'phonelink.png', 1.45], [/universal print|microsoft print|\bprint\b/, 'universalprint'],
  [/fabric/, 'fabric'], [/\bword\b/, 'word'], [/excel/, 'excel'], [/powerpoint/, 'powerpoint'],
  [/visio/, 'visio'], [/yammer/, 'yammer'], [/stream/, 'stream'], [/\bforms\b/, 'forms'], [/delve/, 'delve'],
  [/\bproject\b/, 'project'], [/\bloop\b/, 'loop'], [/\bsway\b/, 'sway'], [/\baccess\b/, 'access'],
  [/\bedge\b/, 'edge'], [/virtual desktop|\bavd\b/, 'avd'],
  // Platforms and catch-alls last
  [/azure/, 'azure'], [/windows/, 'windows'], [/office/, 'office'], [/microsoft 365|\bm365\b/, 'm365'],
];

const ORDER = ['mac', 'm365Consumer', 'azure', 'ppac'];
const ICONS = {
  ok:   '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  bad:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  unk:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v.01M12 8a2 2 0 0 1 1 3.7c-.6.4-1 .8-1 1.3"/></svg>',
};

const state = { data: null, history: [], fingerprints: null, nextRefreshAt: 0, pollSeconds: 60, notify: false };

/* ---------- helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with the static ICONS above
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function monogram(text, c1 = '#0f6cbd', c2 = '#7b3fe4') {
  return h('span', { class: 'picon mono', style: { '--c1': c1, '--c2': c2 } }, text);
}

/** Official product icon for a service name, or a gradient monogram when Microsoft publishes none we can use. */
function productIcon(name) {
  const n = String(name || '').toLowerCase();
  const hit = PRODUCT_ICONS.find(([re]) => re.test(n));
  const fallbackText = () => n.replace(/^microsoft\s+/, '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  if (!hit) return monogram(fallbackText());
  const [, file, zoom] = hit;
  const wrap = h('span', { class: 'picon' });
  wrap.append(h('img', {
    src: `icons/${/\.\w+$/.test(file) ? file : `${file}.svg`}`, alt: '', loading: 'lazy',
    style: zoom ? { transform: `scale(${zoom})` } : null,
    onerror: () => wrap.replaceWith(monogram(fallbackText())),
  }));
  return wrap;
}

const msLogo = () => h('span', { class: 'ms-logo' }, h('i'), h('i'), h('i'), h('i'));

function level(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return -1;
  if (/available|operational|restored|resolved|healthy/.test(s)) return 0;
  if (/interruption|outage|unavailable|down|critical/.test(s)) return 2;
  return 1; // degradation, investigating, advisory, extended recovery, …
}
const levelIcon = (l) => ICONS[['ok', 'warn', 'bad'][l] || 'unk'];

function validDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) || d.getUTCFullYear() < 1900 ? null : d;
}

function ago(d) {
  if (!d) return '—';
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function duration(ms) {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmt = (d) => d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** Microsoft's messages are HTML (business feed) or CRLF text (consumer feed). Reduce both to lines of plain text. */
function toLines(msg) {
  if (!msg) return [];
  let text = msg;
  if (/<[a-z][\s\S]*>/i.test(msg)) {
    const doc = new DOMParser().parseFromString(msg, 'text/html');
    const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|TR|TABLE|BLOCKQUOTE)$/;
    const out = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out.push(c.nodeValue);
        else if (c.nodeName === 'BR') out.push('\n');
        else if (c.nodeType === 1) {
          const block = BLOCK.test(c.nodeName);
          if (block) out.push('\n');
          if (c.nodeName === 'LI') out.push('- ');
          walk(c);
          if (block) out.push('\n');
        }
      }
    })(doc.body);
    text = out.join('');
  }
  return text.replace(/ /g, ' ').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const LABEL = /^(user impact|more info|current status|scope of impact|root cause|preliminary root cause|next update by|final status|start time|end time|workaround|impact|estimated time to resolve|title)\s*:\s*(.*)$/i;
const BULLET_SVC = /^[-•*]\s*([^:]{2,80}?):\s+(.+)$/;
const BULLET = /^[-•*]\s*(.+)$/;

function parseMessage(msg) {
  const sections = [];
  const affected = [];
  let cur = null;
  for (const line of toLines(msg)) {
    const lab = line.match(LABEL);
    if (lab) {
      cur = { label: lab[1].replace(/\b\w/g, (c) => c.toUpperCase()), paras: [], bullets: [] };
      sections.push(cur);
      if (lab[2]) cur.paras.push(lab[2]);
      continue;
    }
    const svc = line.match(BULLET_SVC);
    if (svc) { affected.push({ name: svc[1].trim(), desc: svc[2].trim() }); continue; }
    if (!cur) { cur = { label: '', paras: [], bullets: [] }; sections.push(cur); }
    const b = line.match(BULLET);
    if (b) cur.bullets.push(b[1]); else cur.paras.push(line);
  }
  const take = (name) => {
    const i = sections.findIndex((s) => s.label.toLowerCase() === name);
    return i < 0 ? null : sections.splice(i, 1)[0];
  };
  const nextUpdate = take('next update by');
  return {
    impact: take('user impact'),
    status: take('current status'),
    rest: sections.filter((s) => s.paras.length || s.bullets.length),
    affected,
    nextUpdateText: nextUpdate?.paras.join(' ') || null,
    nextUpdateAt: parseMsDate(nextUpdate?.paras.join(' ')),
  };
}

/** "Friday, November 13, 2026, at 3:30 AM UTC" → Date */
function parseMsDate(s) {
  if (!s) return null;
  const m = s.match(/([A-Z][a-z]+ \d{1,2}, \d{4}),?\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]M)\s*(UTC|GMT)?/i);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]} UTC`);
  return isNaN(d) ? null : d;
}

/* ---------- model ---------- */

function buildItems(feeds) {
  const items = [];
  for (const key of ORDER) {
    const f = feeds[key];
    if (!f?.data) continue;
    const rows = Array.isArray(f.data) ? f.data : [f.data];
    for (const r of rows) {
      items.push({
        id: `${key}:${r.ServiceWorkloadName || key}`,
        feed: key, feedName: f.name, link: f.link,
        service: r.ServiceDisplayName || f.name,
        status: r.Status || 'Unknown', level: level(r.Status),
        title: r.Title || '', message: r.Message || '',
        authored: validDate(r.AuthoredDateTime), updated: validDate(r.LastUpdatedTime),
        fp: [r.Status, r.Title, r.Message].join('|'),
      });
    }
  }
  return items;
}

function platformSummary(key, f, items) {
  const own = items.filter((i) => i.feed === key);
  const worst = own.reduce((a, i) => Math.max(a, i.level), own.length ? 0 : -1);
  const bad = own.filter((i) => i.level > 0);
  return { key, f, own, worst, bad };
}

/* ---------- render ---------- */

function render() {
  const { feeds, lastPollAt } = state.data;
  const items = buildItems(feeds);
  const plats = ORDER.filter((k) => feeds[k]).map((k) => platformSummary(k, feeds[k], items));
  const incidents = items.filter((i) => i.level > 0);
  const worst = Math.max(-1, ...plats.map((p) => p.worst));
  const failed = ORDER.filter((k) => feeds[k] && !feeds[k].ok);

  renderHero(plats, incidents, items, worst);
  renderPlatforms(plats);
  renderIncidents(incidents);
  renderConsumer(items.filter((i) => i.feed === 'm365Consumer'));
  renderTimeline();
  setFavicon(worst, incidents.length);

  document.getElementById('refreshedLabel').textContent = `Updated ${ago(validDate(lastPollAt))} · auto-refresh every ${state.pollSeconds}s`;
  const bar = document.getElementById('errorBar');
  bar.hidden = !failed.length;
  bar.textContent = failed.length
    ? `Could not reach ${failed.map((k) => `${feeds[k].name} (${feeds[k].error})`).join('; ')}. Showing the last good data where available.`
    : '';
}

function renderHero(plats, incidents, items, worst) {
  const hero = document.getElementById('hero');
  hero.dataset.level = worst;
  document.getElementById('heroIcon').innerHTML = levelIcon(worst);
  const badPlats = plats.filter((p) => p.worst > 0);
  document.getElementById('heroTitle').textContent =
    worst === 0 ? 'All Microsoft services are operating normally'
    : worst < 0 ? 'Status unavailable'
    : `${badPlats.length} of ${plats.length} platforms reporting issues`;
  document.getElementById('heroSub').textContent = badPlats.length
    ? badPlats.map((p) => `${p.f.name}: ${p.bad.map((b) => b.status).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`).join(' · ')
    : 'No active incidents on Microsoft 365, consumer products, Azure or Power Platform.';

  const consumer = items.filter((i) => i.feed === 'm365Consumer');
  const affectedCount = incidents.reduce((n, i) => n + parseMessage(i.message).affected.length, 0);
  const nexts = incidents.map((i) => parseMessage(i.message).nextUpdateAt).filter(Boolean).sort((a, b) => a - b);
  const upcoming = nexts.find((d) => d > Date.now()) || nexts[nexts.length - 1];

  const kpi = (label, value, note, cls = '') => h('div', { class: `kpi ${cls}` },
    h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), note ? h('div', { class: 'kpi-note' }, note) : null);
  const okConsumer = consumer.filter((c) => c.level === 0).length;
  const nextEl = h('span', { 'data-countdown': upcoming ? upcoming.toISOString() : '' }, upcoming ? '' : '—');

  document.getElementById('kpis').replaceChildren(
    kpi('Active incidents', String(incidents.length), incidents.length ? 'across all feeds' : 'all clear', incidents.length ? (worst === 2 ? 'bad' : 'warn') : 'ok'),
    kpi('Platforms healthy', h('span', {}, String(plats.filter((p) => p.worst === 0).length), h('small', {}, ` / ${plats.length}`)), null, badPlats.length ? 'warn' : 'ok'),
    kpi('Consumer services up', h('span', {}, String(okConsumer), h('small', {}, ` / ${consumer.length}`)), null, okConsumer < consumer.length ? 'warn' : 'ok'),
    kpi('Services named in incidents', String(affectedCount), affectedCount ? 'see Affected services' : 'none affected', affectedCount ? 'warn' : ''),
    kpi('Next Microsoft update', nextEl, upcoming ? fmt(upcoming) : 'no update scheduled'),
  );
}

function renderPlatforms(plats) {
  document.getElementById('platforms').replaceChildren(...plats.map(({ key, f, own, worst, bad }) => {
    const isList = Array.isArray(f.data);
    const headline = isList
      ? (bad.length ? `${bad.length} of ${own.length} services impacted` : `All ${own.length} services operational`)
      : (own[0]?.title || (worst === 0 ? 'No active issues' : own[0]?.status));
    const sub = isList ? (bad[0]?.title || '') : (worst === 0 && key === 'azure' ? own[0]?.message : '');
    const statusText = isList ? (bad[0]?.status || 'Operational') : (own[0]?.status || 'Unknown');
    return h('article', { class: `card lvl-${worst}` },
      h('div', { class: 'card-head' },
        h('div', { class: 'plat-icon' }, PLATFORM_ICON[key] ? productIcon(PLATFORM_ICON[key]) : msLogo()),
        h('div', { class: 'card-name' }, f.name)),
      h('div', {}, h('span', { class: `pill lvl-${worst}` }, h('span', { class: 'dot' }), statusText)),
      h('div', { class: 'card-title' }, headline),
      sub ? h('div', { class: 'muted small' }, sub) : null,
      h('div', { class: 'card-foot' },
        !f.ok ? h('span', { class: 'stale' }, `Feed error · last data ${ago(validDate(f.fetchedAt))}`)
          : !isList && own[0]?.title && own[0]?.authored ? h('span', {}, `Posted ${ago(own[0].authored)}`)
          : h('span', {}, `Checked ${ago(validDate(f.fetchedAt))}`),
        bad.length
          ? h('button', { class: 'link-btn', onclick: () => document.getElementById(`inc-${bad[0].id}`)?.scrollIntoView({ behavior: 'smooth' }) }, 'Details ↓')
          : h('a', { href: f.link, target: '_blank', rel: 'noopener' }, 'Official ↗')),
    );
  }));
}

function sectionCallout(sec, primary) {
  if (!sec) return null;
  return h('div', { class: `callout${primary ? ' primary' : ''}` },
    sec.label ? h('h3', {}, sec.label) : null,
    ...sec.paras.map((p) => h('p', {}, p)),
    sec.bullets.length ? h('ul', {}, ...sec.bullets.map((b) => h('li', {}, b))) : null);
}

function renderIncidents(incidents) {
  document.getElementById('incidentCount').textContent = incidents.length ? `${incidents.length} active` : '';
  const host = document.getElementById('incidents');
  if (!incidents.length) {
    host.replaceChildren(h('div', { class: 'empty', html: ICONS.ok + 'No active incidents right now.' }));
    return;
  }
  host.replaceChildren(...incidents.map((inc) => {
    const p = parseMessage(inc.message);
    const meta = [
      inc.authored && h('span', {}, 'Posted ', h('strong', {}, fmt(inc.authored))),
      inc.updated && h('span', {}, 'Last updated ', h('strong', {}, fmt(inc.updated)), ` (${ago(inc.updated)})`),
      p.nextUpdateAt && h('span', { class: 'countdown', 'data-countdown': p.nextUpdateAt.toISOString() }),
      !p.nextUpdateAt && p.nextUpdateText && h('span', {}, 'Next update by ', h('strong', {}, p.nextUpdateText)),
    ];

    let affectedBlock = null;
    if (p.affected.length) {
      const grid = h('div', { class: 'affected' }, ...p.affected.map((a) => h('button', {
        class: 'svc', 'data-q': `${a.name} ${a.desc}`.toLowerCase(),
        onclick: (e) => e.currentTarget.classList.toggle('open'),
      }, h('span', { class: 'svc-name' }, productIcon(a.name), a.name), h('span', { class: 'svc-desc' }, a.desc))));
      const search = h('input', {
        class: 'search', type: 'search', placeholder: `Filter ${p.affected.length} services…`,
        oninput: (e) => { const q = e.target.value.trim().toLowerCase(); for (const b of grid.children) b.hidden = q && !b.dataset.q.includes(q); },
      });
      affectedBlock = h('div', {},
        h('div', { class: 'affected-head' }, h('h3', {}, `Affected services (${p.affected.length})`), search), grid);
    }

    const fallback = !p.impact && !p.status && !p.rest.length && !p.affected.length && inc.message
      ? h('div', { class: 'callout' }, ...toLines(inc.message).map((l) => h('p', {}, l))) : null;

    return h('article', { class: `incident lvl-${inc.level}`, id: `inc-${inc.id}` },
      h('div', { class: 'inc-head' },
        h('div', { class: 'inc-meta' },
          h('span', { class: 'inc-source' }, inc.service === inc.feedName ? inc.feedName : `${inc.feedName} · ${inc.service}`),
          h('span', { class: `pill lvl-${inc.level}` }, h('span', { class: 'dot' }), inc.status)),
        h('div', { class: 'inc-title' }, inc.title || inc.status),
        h('div', { class: 'inc-meta' }, ...meta.filter(Boolean))),
      h('div', { class: 'inc-body' },
        sectionCallout(p.status, true),
        (p.impact || p.rest.length) ? h('div', { class: 'sections' }, sectionCallout(p.impact), ...p.rest.map((s) => sectionCallout(s))) : null,
        affectedBlock, fallback,
        h('div', { class: 'small' }, h('a', { href: inc.link, target: '_blank', rel: 'noopener' }, 'Open in Microsoft ↗'), ' · ',
          h('a', { href: `/api/raw/${inc.feed}`, target: '_blank', rel: 'noopener' }, 'Raw JSON'))),
    );
  }));
  tickCountdowns();
}

function renderConsumer(rows) {
  const ok = rows.filter((r) => r.level === 0).length;
  document.getElementById('consumerCount').textContent = rows.length ? `${ok} of ${rows.length} operational` : '';
  const sorted = rows.slice().sort((a, b) => b.level - a.level || a.service.localeCompare(b.service));
  document.getElementById('consumer').replaceChildren(...sorted.map((r) => h('div', {
    class: `cs lvl-${r.level}`, title: r.title || r.status,
    onclick: r.level > 0 ? () => document.getElementById(`inc-${r.id}`)?.scrollIntoView({ behavior: 'smooth' }) : null,
  }, h('span', { class: 'cs-icon' }, productIcon(r.service), h('span', { class: 'dot' })), h('div', {}, h('div', { class: 'cs-name' }, r.service), h('div', { class: 'cs-status' }, r.status)))));
}

function renderTimeline() {
  const host = document.getElementById('timeline');
  if (!state.history.length) {
    host.replaceChildren(h('li', { class: 'muted small' }, 'No changes recorded yet. Events appear here as statuses change while the server runs.'));
    return;
  }
  const verb = { incident: 'New incident', recovered: 'Recovered', status: 'Status changed', update: 'Update posted', observed: 'Observed' };
  host.replaceChildren(...state.history.slice(0, 80).map((e) => h('li', { class: `tl k-${e.kind}` },
    h('span', { class: 'tl-dot' }),
    h('div', { class: 'tl-time' }, `${fmt(new Date(e.at))} · ${ago(new Date(e.at))}`),
    h('div', { class: 'tl-text' }, h('strong', {}, `${verb[e.kind] || e.kind}: `), e.service,
      e.from && e.from !== e.to ? ` — ${e.from} → ${e.to}` : ` — ${e.to}`),
    e.title ? h('div', { class: 'tl-title' }, e.title) : null)));
}

function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-countdown]')) {
    if (!el.dataset.countdown) continue;
    const diff = new Date(el.dataset.countdown) - Date.now();
    const inKpi = !el.classList.contains('countdown');
    el.classList.toggle('overdue', diff < 0);
    el.textContent = inKpi
      ? (diff >= 0 ? `in ${duration(diff)}` : `${duration(diff)} late`)
      : (diff >= 0 ? `Next update in ${duration(diff)}` : `Next update overdue by ${duration(diff)}`);
  }
}

function setFavicon(worst, count) {
  const color = { 0: '#0e9f4f', 1: '#f59e0b', 2: '#dc2626' }[worst] || '#6b7280';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${color}"/></svg>`;
  document.getElementById('favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  document.title = count ? `(${count}) Microsoft Status Board` : 'Microsoft Status Board';
}

/* ---------- change detection & notifications ---------- */

function detectChanges() {
  const items = buildItems(state.data.feeds);
  const now = Object.fromEntries(items.map((i) => [i.id, i]));
  if (state.fingerprints) {
    for (const i of items) {
      const prev = state.fingerprints[i.id];
      if (!prev || prev.fp === i.fp) continue;
      const msg = prev.status !== i.status ? `${i.service}: ${prev.status} → ${i.status}` : `${i.service}: new update posted`;
      toast(msg);
      if (state.notify && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Microsoft service status', { body: `${msg}${i.title ? `\n${i.title}` : ''}` });
      }
    }
  }
  state.fingerprints = Object.fromEntries(Object.entries(now).map(([k, i]) => [k, { fp: i.fp, status: i.status }]));
}

function toast(text) {
  const t = h('div', { class: 'toast' }, text);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

/* ---------- data loading ---------- */

async function load(force = false) {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  try {
    const [status, hist] = await Promise.all([
      fetch(`/api/status${force ? '?refresh=1' : ''}`).then((r) => { if (!r.ok) throw new Error(`/api/status returned ${r.status}`); return r.json(); }),
      fetch('/api/history').then((r) => r.ok ? r.json() : { events: [] }),
    ]);
    state.data = status;
    state.history = hist.events || [];
    state.pollSeconds = status.pollSeconds || 60;
    detectChanges();
    render();
  } catch (e) {
    const bar = document.getElementById('errorBar');
    bar.hidden = false;
    bar.textContent = `Could not reach the local status server (${e.message}). Is "node server.js" still running?`;
    console.error('[load]', e);
  } finally {
    btn.classList.remove('spinning');
    state.nextRefreshAt = Date.now() + state.pollSeconds * 1000;
  }
}

function tick() {
  const left = Math.max(0, state.nextRefreshAt - Date.now());
  const frac = 1 - left / (state.pollSeconds * 1000);
  document.getElementById('ringFill').style.strokeDashoffset = String(97.4 * (1 - frac));
  tickCountdowns();
  if (state.data) document.getElementById('refreshedLabel').textContent =
    `Updated ${ago(validDate(state.data.lastPollAt))} · next refresh in ${Math.ceil(left / 1000)}s`;
  if (left === 0 && state.nextRefreshAt) { state.nextRefreshAt = 0; load(); }
}

function summaryText() {
  if (!state.data) return '';
  const items = buildItems(state.data.feeds);
  const lines = [`Microsoft service status — ${new Date().toUTCString()}`, ''];
  for (const key of ORDER) {
    const f = state.data.feeds[key]; if (!f) continue;
    const own = items.filter((i) => i.feed === key);
    const bad = own.filter((i) => i.level > 0);
    lines.push(`${f.name}: ${bad.length ? bad.map((b) => `${b.service === f.name ? '' : b.service + ' — '}${b.status}`).join('; ') : 'OK'}`);
    for (const b of bad) {
      const p = parseMessage(b.message);
      if (b.title) lines.push(`  • ${b.title}`);
      if (p.affected.length) lines.push(`    Affected: ${p.affected.map((a) => a.name).join(', ')}`);
      if (p.nextUpdateText) lines.push(`    Next update by: ${p.nextUpdateText}`);
    }
  }
  return lines.join('\n');
}

/* ---------- wiring ---------- */

function initControls() {
  const root = document.documentElement;
  document.getElementById('themeBtn').onclick = () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('msb-theme', root.dataset.theme); } catch {}
  };

  const notifyBtn = document.getElementById('notifyBtn');
  try { state.notify = localStorage.getItem('msb-notify') === '1'; } catch {}
  const syncNotify = () => notifyBtn.classList.toggle('on', state.notify && 'Notification' in window && Notification.permission === 'granted');
  notifyBtn.onclick = async () => {
    if (!('Notification' in window)) return toast('This browser does not support desktop notifications.');
    if (!state.notify && Notification.permission !== 'granted') await Notification.requestPermission();
    state.notify = !state.notify && Notification.permission === 'granted';
    try { localStorage.setItem('msb-notify', state.notify ? '1' : '0'); } catch {}
    syncNotify();
    toast(state.notify ? 'Notifications on — you will be alerted when a status changes.' : 'Notifications off.');
  };
  syncNotify();

  // Fires immediately with the current status, independent of the on/off toggle, to confirm alerts reach the desktop.
  document.getElementById('testNotifyBtn').onclick = async () => {
    if (!('Notification' in window)) return toast('This browser does not support desktop notifications.');
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') {
      return toast('Notifications are blocked for this site. Allow them via the lock icon in the address bar, then try again.');
    }
    const incidents = state.data ? buildItems(state.data.feeds).filter((i) => i.level > 0) : [];
    const body = !state.data ? 'Status not loaded yet.'
      : incidents.length ? incidents.map((i) => `${i.service}: ${i.status}`).join('\n')
      : 'All Microsoft services are operating normally.';
    new Notification(`Microsoft service status (test) — ${incidents.length} active incident${incidents.length === 1 ? '' : 's'}`, { body });
    syncNotify();
    toast('Test notification sent. If nothing appeared, check Windows Focus / Do Not Disturb.');
  };

  // Fetch first so a missing file shows a toast instead of downloading an error body.
  const handleDownloadHistory = async () => {
    try {
      const r = await fetch('/api/history/download');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `server returned ${r.status}`);
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'history.json';
      const url = URL.createObjectURL(await r.blob());
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Downloaded ${name}.`);
    } catch (e) {
      toast(`Download failed: ${e.message}`);
    }
  };
  const dlBtn = document.getElementById('downloadHistoryBtn');
  if (dlBtn) dlBtn.onclick = handleDownloadHistory;
  const dlLink = document.getElementById('downloadHistoryLink');
  if (dlLink) dlLink.onclick = handleDownloadHistory;

  document.getElementById('refreshBtn').onclick = () => load(true);
  document.getElementById('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(summaryText()); toast('Summary copied to clipboard.'); }
    catch (e) { toast(`Copy failed: ${e.message}`); }
  };

  const moreBtn = document.getElementById('moreBtn');
  const moreMenu = document.getElementById('moreMenu');
  if (moreBtn && moreMenu) {
    const toggleMenu = (open) => {
      const willOpen = typeof open === 'boolean' ? open : moreMenu.hidden;
      moreMenu.hidden = !willOpen;
      moreBtn.setAttribute('aria-expanded', String(willOpen));
      moreBtn.classList.toggle('on', willOpen);
    };
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMenu();
    };
    document.addEventListener('click', (e) => {
      if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreBtn) {
        toggleMenu(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !moreMenu.hidden) {
        toggleMenu(false);
        moreBtn.focus();
      }
    });

    const menuCopy = document.getElementById('menuCopyBtn');
    if (menuCopy) menuCopy.onclick = () => {
      toggleMenu(false);
      document.getElementById('copyBtn').click();
    };

    const menuTestNotify = document.getElementById('menuTestNotifyBtn');
    if (menuTestNotify) menuTestNotify.onclick = () => {
      toggleMenu(false);
      document.getElementById('testNotifyBtn').click();
    };

    const menuDownload = document.getElementById('menuDownloadBtn');
    if (menuDownload) menuDownload.onclick = () => {
      toggleMenu(false);
      handleDownloadHistory();
    };
  }
}

document.getElementById('platforms').replaceChildren(...ORDER.map(() => h('div', { class: 'skeleton' })));
initControls();
load();
setInterval(tick, 1000);
