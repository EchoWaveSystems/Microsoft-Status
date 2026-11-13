// Microsoft Status Board — zero-dependency server.
// Proxies status.cloud.microsoft (which sends no CORS headers), caches the feeds,
// and records a change history so the UI can show a timeline across restarts.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

// Auto-load .env file if present
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn('[env] error reading .env:', e.message);
}

let APP_VERSION = '1.0.0';
try {
  APP_VERSION = process.env.APP_VERSION || require('./package.json').version || '1.0.0';
} catch {}

const AUTH_USER = (process.env.AUTH_USERNAME || process.env.AUTH_USER || '').trim();
const AUTH_PASS = (process.env.AUTH_PASSWORD || process.env.AUTH_PASS || '').trim();
const AUTH_ENABLED = Boolean(AUTH_USER);
const AUTH_REQUIRES_PASS = AUTH_ENABLED && Boolean(AUTH_PASS);

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_SECRET_FILE = path.join(DATA_DIR, 'auth.secret');
let AUTH_SECRET = process.env.AUTH_SECRET || '';
if (!AUTH_SECRET) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(AUTH_SECRET_FILE)) {
      AUTH_SECRET = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
    } else {
      AUTH_SECRET = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(AUTH_SECRET_FILE, AUTH_SECRET, 'utf8');
    }
  } catch {
    AUTH_SECRET = crypto.randomBytes(32).toString('hex');
  }
}

function createToken(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + 7 * 24 * 3600 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!AUTH_ENABLED) return true;
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Date.now()) return false;
    if (data.u !== AUTH_USER) return false;
    return true;
  } catch {
    return false;
  }
}

function checkCredentials(username, password) {
  if (!AUTH_ENABLED) return true;
  const u = String(username || '').trim();
  const p = String(password || '').trim();
  const uBuf = Buffer.from(u);
  const authUserBuf = Buffer.from(AUTH_USER);
  if (uBuf.length !== authUserBuf.length || !crypto.timingSafeEqual(uBuf, authUserBuf)) {
    return false;
  }
  if (AUTH_REQUIRES_PASS) {
    const pBuf = Buffer.from(p);
    const authPassBuf = Buffer.from(AUTH_PASS);
    if (pBuf.length !== authPassBuf.length || !crypto.timingSafeEqual(pBuf, authPassBuf)) {
      return false;
    }
  }
  return true;
}

function readBodyJson(req, maxBytes = 10000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        return reject(new Error('payload too large'));
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function getGitStatus() {
  try {
    const out = execSync('git status --porcelain', {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { ok: true, count: files.length, files };
  } catch {
    return { ok: false, count: 0, files: [] };
  }
}

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
    "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      res.setHeader('allow', 'GET, HEAD, POST');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    const { pathname, searchParams } = new URL(req.url, 'http://x');

    // Public auth configuration check
    if (pathname === '/api/auth/mode') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return sendJson(res, 200, {
        enabled: AUTH_ENABLED,
        requiresPassword: AUTH_REQUIRES_PASS,
      });
    }

    // Public login endpoint
    if (pathname === '/api/auth/login') {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (!AUTH_ENABLED) {
        return sendJson(res, 200, { ok: true, token: 'no-auth' });
      }
      const data = await readBodyJson(req).catch(() => null);
      if (!data) return sendJson(res, 400, { error: 'invalid request body' });
      if (!checkCredentials(data.username, data.password)) {
        return sendJson(res, 401, { error: AUTH_REQUIRES_PASS ? 'Invalid username or password' : 'Invalid username' });
      }
      const token = createToken(AUTH_USER);
      return sendJson(res, 200, { ok: true, token, username: AUTH_USER });
    }

    // Auth verification for all protected API endpoints
    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-auth-token'] || '');
      if (AUTH_ENABLED && !verifyToken(token)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
    }

    if (pathname === '/api/status') {
      const wantsRefresh = searchParams.get('refresh') === '1' && Date.now() - lastPollStartedMs >= MIN_FORCED_REFRESH_MS;
      if (wantsRefresh || !lastPollAt) await pollOnce();
      const feeds = Object.fromEntries(Object.entries(FEEDS).map(([k, meta]) => [k, { ...meta, ...(cache[k] || { ok: false, error: 'not fetched yet' }) }]));
      const git = getGitStatus();
      return sendJson(res, 200, { version: APP_VERSION, lastPollAt, pollSeconds: POLL_MS / 1000, feeds, git });
    }
    if (pathname === '/api/git-status') {
      return sendJson(res, 200, getGitStatus());
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
  const authMode = !AUTH_ENABLED ? 'disabled' : AUTH_REQUIRES_PASS ? 'username + password' : 'username only';
  console.log(`Microsoft Status Board v${APP_VERSION} → http://${shown}:${PORT}  (polling every ${POLL_MS / 1000}s, auth: ${authMode})`);
  if (shown !== HOST) console.log(`[security] listening on all interfaces; accepted Host names: ${[...ALLOWED_HOSTS].join(', ')}`);
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
