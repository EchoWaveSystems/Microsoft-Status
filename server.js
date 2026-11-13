// Microsoft Status Board — zero-dependency server.
// Proxies status.cloud.microsoft (which sends no CORS headers), caches the feeds,
// and records a change history so the UI can show a timeline across restarts.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 5050;
const POLL_MS = Number(process.env.POLL_SECONDS || 60) * 1000;
const UPSTREAM = 'https://status.cloud.microsoft/api/posts/';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_CAP = 1000;

const FEEDS = {
  mac:          { name: 'Microsoft 365 (Business or Enterprise)', link: 'https://admin.microsoft.com/servicestatus' },
  m365Consumer: { name: 'Microsoft consumer products',            link: 'https://status.cloud.microsoft/' },
  azure:        { name: 'Azure',                                  link: 'https://azure.status.microsoft/en-us/status' },
  ppac:         { name: 'Power Platform & Dynamics 365',          link: 'https://admin.powerplatform.microsoft.com/' },
};

const cache = {};        // feed -> { ok, data, error, fetchedAt }
let lastPollAt = null;
let history = loadHistory();

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return { events: parsed.events || [], fingerprints: parsed.fingerprints || {} };
  } catch {
    return { events: [], fingerprints: {} };
  }
}

function saveHistory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = HISTORY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, HISTORY_FILE);
}

const isHealthy = (status) => /^(available|operational|service ?restored|resolved)$/i.test(String(status || '').trim());

// One feed yields one or more items; a consumer feed has one item per service.
function itemsOf(feed, data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.map((r) => ({
    key: `${feed}:${r.ServiceWorkloadName || feed}`,
    feed,
    service: r.ServiceDisplayName || FEEDS[feed].name,
    status: r.Status || 'Unknown',
    title: r.Title || '',
    // LastUpdatedTime is "now" on some feeds, so the fingerprint uses content only.
    fingerprint: [r.Status, r.Title, r.Message].join('␞'),
  }));
}

// Returns whether anything needs saving, plus the timeline events added (first-seen healthy services
// change the fingerprints but add no event).
function recordChanges(feed, data, at) {
  let changed = false;
  const added = [];
  for (const item of itemsOf(feed, data)) {
    const prev = history.fingerprints[item.key];
    if (prev === undefined) {
      history.fingerprints[item.key] = { fp: item.fingerprint, status: item.status };
      changed = true;
      if (!isHealthy(item.status)) {
        added.push({ at, kind: 'observed', feed, service: item.service, to: item.status, title: item.title });
      }
      continue;
    }
    if (prev.fp === item.fingerprint) continue;
    const kind = prev.status !== item.status
      ? (isHealthy(item.status) ? 'recovered' : isHealthy(prev.status) ? 'incident' : 'status')
      : 'update';
    added.push({ at, kind, feed, service: item.service, from: prev.status, to: item.status, title: item.title });
    history.fingerprints[item.key] = { fp: item.fingerprint, status: item.status };
    changed = true;
  }
  history.events.push(...added);
  if (history.events.length > HISTORY_CAP) history.events = history.events.slice(-HISTORY_CAP);
  return { changed, added };
}

async function fetchFeed(feed) {
  const res = await fetch(UPSTREAM + feed, {
    headers: { accept: 'application/json', 'user-agent': 'ms-status-board/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${UPSTREAM + feed}`);
  return res.json();
}

async function poll() {
  const at = new Date().toISOString();
  const started = Date.now();
  console.log(`[poll] ${at} checking ${Object.keys(FEEDS).join(', ')}…`);
  const results = await Promise.allSettled(Object.keys(FEEDS).map(async (feed) => [feed, await fetchFeed(feed)]));
  let changed = false;
  let added = 0;
  results.forEach((r, i) => {
    const feed = Object.keys(FEEDS)[i];
    if (r.status === 'fulfilled') {
      cache[feed] = { ok: true, data: r.value[1], error: null, fetchedAt: at };
      const res = recordChanges(feed, r.value[1], at);
      changed = res.changed || changed;
      added += res.added.length;
      for (const e of res.added) {
        console.log(`[poll]   ${e.kind}: ${e.service} — ${e.from ? `${e.from} → ` : ''}${e.to}${e.title ? ` (${e.title})` : ''}`);
      }
    } else {
      // Keep the last good payload so a transient upstream failure doesn't blank the board.
      const prev = cache[feed] || {};
      cache[feed] = { ...prev, ok: false, error: String(r.reason?.message || r.reason), errorAt: at };
      console.warn(`[poll] ${feed} failed: ${cache[feed].error}`);
    }
  });
  lastPollAt = at;
  if (changed) saveHistory();
  const summary = Object.keys(FEEDS).map((f) => {
    const c = cache[f];
    if (!c?.ok) return `${f}=FAILED`;
    const rows = Array.isArray(c.data) ? c.data : [c.data];
    const bad = rows.filter((row) => !isHealthy(row.Status)).length;
    return Array.isArray(c.data) ? `${f}=${rows.length - bad}/${rows.length} ok` : `${f}=${rows[0]?.Status}`;
  }).join(' | ');
  const outcome = added ? `${added} new event(s), history.json saved`
    : changed ? 'baseline updated, history.json saved' : 'no changes, history.json untouched';
  console.log(`[poll] done in ${Date.now() - started}ms — ${summary} — ${outcome}`);
}

let inflight = null;
const pollOnce = () => (inflight ??= poll().finally(() => { inflight = null; }));

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/api/status') {
      if (searchParams.get('refresh') === '1' || !lastPollAt) await pollOnce();
      const feeds = Object.fromEntries(Object.entries(FEEDS).map(([k, meta]) => [k, { ...meta, ...(cache[k] || { ok: false, error: 'not fetched yet' }) }]));
      return sendJson(res, 200, { lastPollAt, pollSeconds: POLL_MS / 1000, feeds });
    }
    if (pathname === '/api/history') {
      return sendJson(res, 200, { events: history.events.slice().reverse() });
    }
    const raw = pathname.match(/^\/api\/raw\/(\w+)$/);
    if (raw && FEEDS[raw[1]]) return sendJson(res, 200, cache[raw[1]]?.data ?? null);
    serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Microsoft Status Board → http://localhost:${PORT}  (polling every ${POLL_MS / 1000}s)`);
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
