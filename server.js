// Microsoft Status Board — zero-dependency server.
// Proxies status.cloud.microsoft (which sends no CORS headers), caches the feeds,
// and records a change history so the UI can show a timeline across restarts.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let APP_VERSION = '1.0.0';
try {
  APP_VERSION = process.env.APP_VERSION || require('./package.json').version || '1.0.0';
} catch {}

const PORT = Number(process.env.PORT) || 5050;
// Loopback by default so nobody else on the network can reach the board. Set HOST=0.0.0.0 to share it,
// and list the names people will use in ALLOWED_HOSTS (see README).
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]',
  ...String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);
// Never poll faster than every 30s, whatever the env says; a typo of 0 would otherwise hammer Microsoft.
const POLL_MS = Math.max(30, Number(process.env.POLL_SECONDS) || 60) * 1000;
const MIN_FORCED_REFRESH_MS = 15000;     // ?refresh=1 is public, so it is throttled
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
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
const isFeed = (name) => Object.hasOwn(FEEDS, name);

const cache = {};        // feed -> { ok, data, error, fetchedAt }
let lastPollAt = null;
let lastPollStartedMs = 0;
let history = loadHistory();

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    const fingerprints = parsed?.fingerprints && typeof parsed.fingerprints === 'object' ? parsed.fingerprints : {};
    return { events, fingerprints: Object.assign(Object.create(null), fingerprints) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[history] could not read ${HISTORY_FILE}, starting empty: ${e.message}`);
    return { events: [], fingerprints: Object.create(null) };
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
    service: String(r.ServiceDisplayName || FEEDS[feed].name),
    status: String(r.Status || 'Unknown'),
    title: String(r.Title || ''),
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

// Reads at most `max` bytes, so a misbehaving upstream cannot exhaust memory.
async function readCapped(res, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error(`response larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Upstream is expected to be one post object, or an array of them (consumer feed).
function assertFeedShape(data) {
  const isPost = (r) => r && typeof r === 'object' && !Array.isArray(r);
  if (Array.isArray(data) ? data.every(isPost) : isPost(data)) return data;
  throw new Error('unexpected response shape');
}

async function fetchFeed(feed) {
  const res = await fetch(UPSTREAM + feed, {
    headers: { accept: 'application/json', 'user-agent': 'ms-status-board/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${UPSTREAM + feed}`);
  return assertFeedShape(JSON.parse(await readCapped(res, MAX_UPSTREAM_BYTES)));
}

async function poll() {
  const at = new Date().toISOString();
  const started = Date.now();
  lastPollStartedMs = started;
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

// Applied to every response. The page has no inline script or style attributes, so the policy can be strict.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
// Icons opened directly as a document get no script at all, but may keep their own <style> blocks.
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

function send(res, code, headers, body) {
  res.writeHead(code, { ...SECURITY_HEADERS, ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, code, body) {
  send(res, code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

function serveStatic(pathname, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'bad request' }); }
  if (urlPath.includes('\0')) return sendJson(res, 400, { error: 'bad request' });
  const isHtml = urlPath === '/' || urlPath === '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + (isHtml ? 'index.html' : urlPath)));
  // Must be strictly inside public/ — a plain startsWith would also accept a sibling such as "public-old".
  const type = MIME[path.extname(file).toLowerCase()];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) return sendJson(res, 404, { error: 'not found' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    fs.readFile(file, (err2, buf) => {
      if (err2) return sendJson(res, 404, { error: 'not found' });
      const extra = type === 'image/svg+xml' ? { 'content-security-policy': SVG_CSP } : {};
      const cacheControl = isHtml ? 'no-cache, no-store, must-revalidate' : 'no-cache';
      const body = isHtml ? buf.toString('utf8').replace(/\{\{VERSION\}\}/g, APP_VERSION) : buf;
      send(res, 200, { 'content-type': type, 'cache-control': cacheControl, ...extra }, body);
    });
  });
}

// The only file the download endpoint can ever return: a fixed path, never built from the request.
function downloadHistory(res) {
  fs.readFile(HISTORY_FILE, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'history.json has not been written yet — wait for the first poll' });
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    send(res, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="history-${stamp}.json"`,
      'cache-control': 'no-store',
    }, buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Rejecting unknown Host headers blocks DNS-rebinding: a malicious site cannot point its own
    // domain at 127.0.0.1 and read this board from the victim's browser.
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) return sendJson(res, 421, { error: 'unrecognised host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    const { pathname, searchParams } = new URL(req.url, 'http://x');

    if (pathname === '/api/status') {
      const wantsRefresh = searchParams.get('refresh') === '1' && Date.now() - lastPollStartedMs >= MIN_FORCED_REFRESH_MS;
      if (wantsRefresh || !lastPollAt) await pollOnce();
      const feeds = Object.fromEntries(Object.entries(FEEDS).map(([k, meta]) => [k, { ...meta, ...(cache[k] || { ok: false, error: 'not fetched yet' }) }]));
      return sendJson(res, 200, { version: APP_VERSION, lastPollAt, pollSeconds: POLL_MS / 1000, feeds });
    }
    if (pathname === '/api/history') {
      return sendJson(res, 200, { events: history.events.slice().reverse() });
    }
    if (pathname === '/api/history/download') return downloadHistory(res);
    const raw = pathname.match(/^\/api\/raw\/(\w+)$/);
    if (raw && isFeed(raw[1])) return sendJson(res, 200, cache[raw[1]]?.data ?? null);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    serveStatic(pathname, res);
  } catch (e) {
    // Details go to the console only; the client gets a generic message.
    console.error(`[http] ${req.method} ${req.url} failed:`, e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

// Bound slow or oversized requests (slowloris-style connection hogging).
server.headersTimeout = 10000;
server.requestTimeout = 30000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Microsoft Status Board v${APP_VERSION} → http://${shown}:${PORT}  (polling every ${POLL_MS / 1000}s)`);
  if (shown !== HOST) console.log(`[security] listening on all interfaces; accepted Host names: ${[...ALLOWED_HOSTS].join(', ')}`);
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
