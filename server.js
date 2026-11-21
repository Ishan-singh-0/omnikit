// OMNIKIT multi-user relay and rescue-alert service. Node 18+, no dependencies.  Each device gets its own key.
// Run:   PORT=8080 node server.js        (data persists in data.json, or DATA_FILE)
// Local demo account (admin/admin) exists ONLY if you start with DEMO=1 (or --demo).
//
// Alerts (optional, set before starting). When a unit reaches danger or critical the relay sends the rescue brief to:
//   ALERT_WEBHOOK=https://...            any JSON endpoint (Slack, Discord, n8n, your own); body has text + content + fields
//   TELEGRAM_TOKEN=... TELEGRAM_CHAT=... a Telegram bot message to one chat or group
// The relay also runs the dead-man's switch: a unit that goes quiet is flagged even if nobody has the dashboard open.
//
// Device uplink (ESP32 + SIM800L or any HTTP client):
//   POST /ingest?key=DEVICE_KEY   body: {"t":27.4,"h":51,"p":1003,"mq":1.4,"mic":62,
//                                        "pitch":-4,"roll":7,"lat":28.61,"lon":77.20,"sats":8,"csq":17,"flags":0}
//   POST /ingest                  header: x-key: DEVICE_KEY
//   GET  /ingest?key=DEVICE_KEY&t=27.4&h=51&p=1003&mq=1.4   (SIM800L GET fallback)
//
// Every field is optional, but a packet must carry at least one sensor reading.
// A sensor that is not fitted or not answering is simply left out by the firmware,
// so the dashboard never shows an invented zero.
//
// Pages:  /  (dashboard)   /login   /s/<share-id>  (read-only live view of one device)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), cr = require('crypto');
const T = require('./twin.js');
const PORT = process.env.PORT || 8080, DB = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEMO = (process.env.DEMO === '1' || process.argv.includes('--demo')) && process.env.NODE_ENV !== 'production';
const HOOK = process.env.ALERT_WEBHOOK, TG_TOKEN = process.env.TELEGRAM_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT;
const SESSION_MS = 30 * 24 * 3600 * 1000;

let db = { users: {}, devices: {} };
try { db = JSON.parse(fs.readFileSync(DB)) } catch {}
db.users = db.users || {}; db.devices = db.devices || {}; db.events = db.events || {};
db.sess = {};                                  // sessions are not kept across restarts: nothing reusable ever sits in data.json
const sess = db.sess, hist = db.hist = db.hist || {};

let dirty = false;
const save = () => {
  if (!dirty) return;
  try {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users: db.users, devices: db.devices, hist, events: db.events }));
    fs.renameSync(tmp, DB);                    // atomic: a power cut cannot leave half a file
    dirty = false;
  } catch (e) { console.error('save failed:', e.message) }
};
const touch = () => { dirty = true };
setInterval(save, 15000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0) });

const hash = (p, s) => cr.scryptSync(p, s, 32).toString('hex'), rid = n => cr.randomBytes(n).toString('hex');
const same = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && cr.timingSafeEqual(A, B) };

if (DEMO && !db.users.admin) {
  const salt = rid(8); db.users.admin = { salt, hash: hash('admin', salt), role: 'admin', demo: true }; touch(); save();
  console.warn('!! DEMO=1: admin/admin is enabled. Never expose this through a public tunnel.');
}
if (!DEMO && db.users.admin && db.users.admin.demo) {   // leftover demo account from an old data.json
  delete db.users.admin; touch(); save();
  console.log('removed the old admin/admin demo account');
}

const SENSORS = ['t', 'h', 'p', 'mq', 'tu', 'mic'];                                    // at least one must be present
const OTHER = ['pitch', 'roll', 'lat', 'lon', 'alt', 'sats', 'flags'];                // stored when sent
const num = v => (typeof v === 'number' ? v : (v === undefined || v === null || v === '' ? NaN : Number(v)));
const deviceByKey = k => k ? Object.keys(db.devices).find(i => same(db.devices[i].key, k)) : undefined;
const PAGES = { '/': 'home.html', '/home': 'home.html', '/app': 'index.html', '/index.html': 'index.html', '/login': 'login.html', '/login.html': 'login.html' };
const STATIC = { '/twin.js': ['twin.js', 'application/javascript; charset=utf-8'] };

// ---- twin: risk state, event log, alerts ------------------------------------
const last = {};                                        // id -> last assessment (memory only)
const optsFor = id => ({ fixed: db.devices[id].kind === 'station', route: db.devices[id].route || null, corridor: db.devices[id].corridor || undefined });
const assessNow = (id, asOf) => T.assess(hist[id] || [], { ...optsFor(id), now: asOf || Date.now() });
const lastSent = {};

function post(urlStr, body, label) {
  let u; try { u = new URL(urlStr) } catch { return console.error('alert: bad URL for ' + label) }
  const lib = u.protocol === 'https:' ? https : http;
  const r = lib.request(u, { method: 'POST', timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    res.resume(); res.on('end', () => { if (res.statusCode >= 300) console.error('alert: ' + label + ' answered HTTP ' + res.statusCode) });
  });
  r.on('timeout', () => r.destroy()); r.on('error', e => console.error('alert: ' + label + ' failed: ' + e.message));
  r.end(body);
}
function sendAlert(id, a, events) {
  const dv = db.devices[id], text = (a.level === 'critical' ? 'CRITICAL: ' : 'WARNING: ') + dv.name + ' - ' + a.headline + '\n\n' + T.brief(dv.name, a);
  console.log('ALERT', dv.name, a.level, a.headline);
  if (Date.now() - (lastSent[id] || 0) < 20000) return;   // never more than one message per 20 s per unit
  lastSent[id] = Date.now();
  const m = a.metrics.pos;
  if (HOOK) post(HOOK, JSON.stringify({ text, content: text, device: dv.name, level: a.level, score: a.score, factors: a.factors.filter(f => f.pts > 0).map(f => f.id), lat: m ? m.lat : null, lon: m ? m.lon : null, ts: Date.now() }), 'webhook');
  if (TG_TOKEN && TG_CHAT) post('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', JSON.stringify({ chat_id: TG_CHAT, text }), 'telegram');
}
// asOf: judge a late (queued) packet at ITS time, so a device coming back from a dead zone is not called silent
function evalDevice(id, notify, asOf) {
  if (!db.devices[id] || !(hist[id] || []).length) return;
  const a = assessNow(id, asOf), evs = T.diffEvents(last[id], a);
  last[id] = a;
  if (!evs.length) return;
  const log = db.events[id] = db.events[id] || [];
  evs.forEach(e => log.push(e)); while (log.length > 200) log.shift();
  touch();
  if (notify && evs.some(e => e.notify && Date.now() - e.ts < 30 * 60000)) sendAlert(id, a, evs);   // stale news is logged, not pushed
}
for (const id of Object.keys(db.devices)) if ((hist[id] || []).length) last[id] = assessNow(id);   // restart must not re-alert
setInterval(() => Object.keys(db.devices).forEach(id => evalDevice(id, true)), 30000);          // the dead-man's switch
const view = (id, v) => ({ id, key: v.key, share: v.share, name: v.name, kind: v.kind || 'person', route: v.route || null, rows: (hist[id] || []).slice(-90), risk: assessNow(id), events: (db.events[id] || []).slice(-60) });

// login throttle: 8 wrong passwords for one username locks it for 5 minutes
const fails = {};
const locked = n => fails[n] && fails[n].c >= 8 && Date.now() < fails[n].until;
const fail = n => { const f = fails[n] = fails[n] || { c: 0, until: 0 }; f.c++; if (f.c >= 8) f.until = Date.now() + 300000 };

http.createServer((q, s) => {
  const j = (c, o) => { if (s.writableEnded) return; s.writeHead(c, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); s.end(JSON.stringify(o)) };
  let b = '', over = false;
  q.on('data', d => { if (over) return; b += d; if (b.length > 8192) { over = true; j(413, { error: 'too large' }); q.destroy() } });
  q.on('error', () => {});
  q.on('end', () => { if (over) return; try { route() } catch (e) { console.error('handler error:', e); j(500, { error: 'server error' }) } });

  function route() {
    let u; try { u = new URL(q.url, 'http://relay') } catch { return j(400, { error: 'bad url' }) }
    const url = u.pathname, qs = u.searchParams;
    let d = {};
    if (b && q.method !== 'GET') { try { d = JSON.parse(b) } catch { return j(400, { error: 'bad json' }) } }
    if (q.method === 'OPTIONS') { s.writeHead(204, { allow: 'GET,POST,OPTIONS' }); return s.end() }

    // ---- device -> server -------------------------------------------------
    if (url === '/ingest') {
      if (q.method !== 'POST' && q.method !== 'GET') return j(405, { error: 'POST only' });
      const id = deviceByKey(q.headers['x-key'] || qs.get('key') || qs.get('k'));
      if (!id) return j(401, { error: 'bad key' });
      const src = q.method === 'GET' ? Object.fromEntries(qs) : d;
      const packet = {};
      for (const k of [...SENSORS, ...OTHER]) { const v = num(src[k]); if (Number.isFinite(v)) packet[k] = v }
      if (!SENSORS.some(k => k in packet)) return j(400, { error: 'bad packet' });
      const csq = num(src.csq); if (Number.isFinite(csq) && csq >= 0 && csq < 99) packet.csq = Math.round(csq);
      // a packet queued on the device while it had no signal says how old it is, so the time series stays honest
      const ago = num(src.ago), ts = Date.now() - (Number.isFinite(ago) && ago >= 0 && ago <= 86400 ? ago * 1000 : 0);
      const h = hist[id] = hist[id] || [];
      h.push({ ...packet, ts });
      if (h.length > 1 && h[h.length - 2].ts > ts) h.sort((a, b) => a.ts - b.ts);
      while (h.length > 700) h.shift();
      touch(); evalDevice(id, true, ago > 30 ? ts : undefined);
      return j(200, { ok: 1, id });      // keep tiny: SIM800L has a small HTTP read buffer
    }

    if (url === '/api/health') return j(200, { ok: 1, t: Date.now() });

    // ---- accounts ---------------------------------------------------------
    if (q.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
      const n = String(d.user || '').toLowerCase().slice(0, 24), p = String(d.pass || '');
      const demoLogin = DEMO && url === '/api/login' && n === 'admin' && p === 'admin' && db.users.admin?.demo === true;
      if (!/^[a-z0-9_]{3,24}$/.test(n) || (p.length < 6 && !demoLogin)) return j(400, { error: 'username 3-24 chars, password 6+' });
      if (locked(n)) return j(429, { error: 'too many tries, wait a few minutes' });
      if (url === '/api/register') {
        if (db.users[n]) return j(409, { error: 'taken' });
        const salt = rid(8); db.users[n] = { salt, hash: hash(p, salt), role: Object.keys(db.users).length ? 'member' : 'admin' }; touch(); save();
      }
      const x = db.users[n];
      if (!x || !same(x.hash, hash(p, x.salt))) { fail(n); return j(401, { error: 'wrong login' }) }
      delete fails[n];
      const t = rid(24); sess[t] = { u: n, exp: Date.now() + SESSION_MS };
      const keys = Object.keys(sess); if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete sess[k]);
      return j(200, { token: t, user: n, role: x.role });
    }

    // ---- read-only share link --------------------------------------------
    if (url.startsWith('/api/public/')) {
      const sid = url.slice('/api/public/'.length);
      const id = sid && Object.keys(db.devices).find(i => db.devices[i].share === sid);
      if (!id) return j(404, { error: 'not found' });
      const v = view(id, db.devices[id]);
      return j(200, { name: v.name, kind: v.kind, route: v.route, rows: (hist[id] || []).slice(-120), risk: v.risk, events: v.events });
    }

    // ---- everything below needs a signed-in session ---------------------
    const token = (q.headers.authorization || '').replace('Bearer ', '');
    const se = token && sess[token];
    if (se && se.exp < Date.now()) delete sess[token];
    const user = se && se.exp >= Date.now() ? se.u : null;
    if (url.startsWith('/api/')) {
      if (url === '/api/logout') { if (token) delete sess[token]; return j(200, { ok: 1 }) }
      if (!user) return j(401, { error: 'sign in' });
      const me = db.users[user];
      if (!me) { delete sess[token]; return j(401, { error: 'sign in' }) }   // token outlived its account
      if (q.method === 'POST' && url === '/api/devices') {
        const id = rid(4);
        db.devices[id] = { owner: user, name: String(d.name || 'device').slice(0, 32), kind: d.kind === 'station' ? 'station' : 'person', key: rid(12), share: rid(8) };
        touch(); save(); return j(200, { id, ...db.devices[id] });
      }
      const dm = url.match(/^\/api\/devices\/([0-9a-f]+)\/(route|share)$/);
      if (q.method === 'POST' && dm) {
        const dv = db.devices[dm[1]];
        if (!dv || (dv.owner !== user && me.role !== 'admin')) return j(404, { error: 'no such device' });
        if (dm[2] === 'share') { dv.share = rid(8); touch(); save(); return j(200, { share: dv.share }) }
        const pts = Array.isArray(d.points) ? d.points.map(p => [Number(p[0]), Number(p[1])]).filter(p => Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180).slice(0, 500) : [];
        dv.route = pts.length > 1 ? pts : null;
        const c = Number(d.corridor); dv.corridor = c >= 20 && c <= 5000 ? c : undefined;
        touch(); save(); last[dm[1]] = undefined; return j(200, { ok: 1, points: pts.length });
      }
      if (q.method === 'GET' && url === '/api/devices') {
        const admin = me.role === 'admin';
        return j(200, Object.entries(db.devices).filter(([, v]) => v.owner === user || admin).map(([id, v]) => view(id, v)));
      }
      return j(404, { error: 'no such route' });
    }

    // ---- pages -----------------------------------------------------------
    if (q.method !== 'GET' && q.method !== 'HEAD') return j(405, { error: 'method not allowed' });
    if (STATIC[url]) return fs.readFile(path.join(__dirname, STATIC[url][0]), (e, f) => {
      if (e) return j(500, { error: 'missing ' + STATIC[url][0] });
      s.writeHead(200, { 'content-type': STATIC[url][1], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); s.end(q.method === 'HEAD' ? undefined : f);
    });
    const file = PAGES[url] || (url.startsWith('/s/') && url.length > 3 ? 'index.html' : null);
    if (!file) return j(404, { error: 'not found' });
    fs.readFile(path.join(__dirname, file), (e, f) => {
      if (e) return j(500, { error: 'missing ' + file });
      if (s.writableEnded) return;
      s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      s.end(q.method === 'HEAD' ? undefined : f);
    });
  }
}).listen(PORT, () => console.log('OMNIKIT relay :' + PORT + (DEMO ? '  (DEMO mode)' : '') + (HOOK || TG_TOKEN ? '  alerts: ' + [HOOK && 'webhook', TG_TOKEN && 'telegram'].filter(Boolean).join('+') : '  alerts: off (set ALERT_WEBHOOK or TELEGRAM_TOKEN+TELEGRAM_CHAT)')));
