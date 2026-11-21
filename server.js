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
db.users = db.users || {}; db.devices = db.devices || {}; db.events = db.events || {}; db.incidents = db.incidents || {}; db.outcomes = db.outcomes || [];
db.sess = {};                                  // sessions are not kept across restarts: nothing reusable ever sits in data.json
const sess = db.sess, hist = db.hist = db.hist || {};

let dirty = false;
const save = () => {
  if (!dirty) return;
  try {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users: db.users, devices: db.devices, hist, events: db.events, incidents: db.incidents, outcomes: db.outcomes }));
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
const OTHER = ['pitch', 'roll', 'lat', 'lon', 'alt', 'sats', 'flags', 'bat'];                // stored when sent
const num = v => (typeof v === 'number' ? v : (v === undefined || v === null || v === '' ? NaN : Number(v)));
const deviceByKey = k => k ? Object.keys(db.devices).find(i => same(db.devices[i].key, k)) : undefined;
const PAGES = { '/': 'index.html', '/app': 'index.html', '/index.html': 'index.html', '/login': 'login.html', '/login.html': 'login.html' };
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
  // a new danger opens (or re-opens) an incident for the rescue team; an acknowledged one is left alone
  if (evs.some(e => e.notify)) { const inc = db.incidents[id]; if (!inc || inc.status === 'resolved') db.incidents[id] = { status: 'new', by: null, openedAt: Date.now(), log: (inc && inc.log) || [] } }
  touch();
  if (notify && evs.some(e => e.notify && Date.now() - e.ts < 30 * 60000)) sendAlert(id, a, evs);   // stale news is logged, not pushed
}
for (const id of Object.keys(db.devices)) if ((hist[id] || []).length) last[id] = assessNow(id);   // restart must not re-alert
setInterval(() => Object.keys(db.devices).forEach(id => evalDevice(id, true)), 30000);          // the dead-man's switch
const view = (id, v) => ({ id, key: v.key, share: v.share, name: v.name, kind: v.kind || 'person', route: v.route || null, rows: (hist[id] || []).slice(-90), risk: assessNow(id), events: (db.events[id] || []).slice(-60), incident: db.incidents[id] || null, signed: !!v.signed, rescue: !!(v.rescue || v.demo), mine: v.owner });

// ---- judge demo profile: SEED_DEMO=1 or --seed ---------------------------------------
// Sign in as "user 1" / "user" (spaces are ignored in usernames). The account holds four units:
//   Trekker 1 (an incident in progress: storm, off route, fall, SOS), Trekker 2 (same storm, fine),
//   Base camp (fixed station), and an empty "Live node" slot for the judges' own ESP32.
// The three simulated units keep transmitting every 10 s, so the page is alive. Real packets for a unit pause its feed.
const SEED = process.env.SEED_DEMO === '1' || process.argv.includes('--seed');
const realAt = {}, demoState = {};
const DEMO_KEY = { demo1: 'demo-trekker-1', demo2: 'demo-trekker-2', demo3: 'demo-base-camp', demo4: 'demo-live-node' };
let seedAt = 0;
function seedDemo() {
  const salt = rid(8);
  db.users.user1 = { salt, hash: hash('user', salt), role: 'member', seeded: true };
  const salt2 = rid(8); db.users.rescuer1 = { salt: salt2, hash: hash('rescue', salt2), role: 'rescuer', seeded: true };
  const route = T.sim.route(), M = T.sim.LAST_MIN; seedAt = Date.now();
  const defs = [['demo1', 'Trekker 1 · Asha', 'person', 'hiker', 11], ['demo2', 'Trekker 2 · Ravi', 'person', 'buddy', 23], ['demo3', 'Base camp', 'station', 'base', 37]];
  for (const [id, name, kind, sim, seed] of defs) {
    db.devices[id] = { demo: true, owner: 'user1', name, kind, key: DEMO_KEY[id], share: (db.devices[id] && db.devices[id].share) || rid(8), route: kind === 'station' ? null : route };
    hist[id] = []; db.events[id] = []; db.incidents[id] = undefined; last[id] = undefined;
    const rand = T.rng(seed); demoState[id] = { sim, rand };
    for (let m = 0; m <= M; m++) {                                   // the last 52 minutes, ending now
      const p = T.sim.packet(sim, m, rand); if (!p) break;
      const ts = seedAt - (M - m) * 60000;
      hist[id].push({ ...p, ts }); evalDevice(id, false, ts);
    }
  }
  db.devices.demo4 = { demo: true, owner: 'user1', name: 'Live node · your ESP32', kind: 'person', key: DEMO_KEY.demo4, share: (db.devices.demo4 && db.devices.demo4.share) || rid(8), route };
  hist.demo4 = []; db.events.demo4 = []; last.demo4 = undefined;
  touch(); save();
}
function demoBeat() {
  const now = Date.now(), m = T.sim.LAST_MIN + (now - seedAt) / 60000, fp = T.sim.packet('hiker', T.sim.FALL_MIN + 1, T.rng(5));
  for (const id of ['demo1', 'demo2', 'demo3']) {
    if (!db.devices[id] || now - (realAt[id] || 0) < 120000) continue;
    const st = demoState[id]; if (!st) continue;
    let p;
    if (st.sim === 'hiker') {                                         // Asha is still down, still pressing SOS, weather still worsening
      p = T.sim.packet('buddy', m, st.rand);
      Object.assign(p, { lat: fp.lat + (st.rand() - .5) * 4e-5, lon: fp.lon + (st.rand() - .5) * 4e-5, pitch: 66, roll: -33, mic: 40, flags: T.FLAG.FALL | T.FLAG.SOS, csq: 8 });
    } else p = T.sim.packet(st.sim, m, st.rand);
    const h = hist[id]; h.push({ ...p, ts: now }); while (h.length > 700) h.shift();
    evalDevice(id, false);
  }
  touch();
}
if (SEED) { seedDemo(); setInterval(demoBeat, 10000); console.log('demo profile ready: sign in as  user 1 / user  (a hiker)  or  rescuer 1 / rescue  (the rescue team)   (device keys: ' + Object.values(DEMO_KEY).join(', ') + ')'); }

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
      // Two ways in. SIGNED (preferred): /ingest?id=DEVICE_ID, the body ends with "sig" = HMAC-SHA256(key, everything before it),
      // and carries a counter "n" that must only go up, so a captured packet cannot be replayed and the secret key never travels.
      // LEGACY: ?key=... in the URL. A device that has ever sent a valid signed packet can no longer use the legacy way (no downgrade).
      let id, src;
      const sid = qs.get('id');
      if (sid) {
        const dv = db.devices[sid];
        if (!dv || q.method !== 'POST') return j(401, { error: 'bad key' });
        const k = b.lastIndexOf(',"sig":"');
        if (k < 0 || !b.endsWith('"}')) return j(401, { error: 'signature missing' });
        if (!same(cr.createHmac('sha256', dv.key).update(b.slice(0, k)).digest('hex'), b.slice(k + 8, -2))) return j(401, { error: 'bad signature' });
        const nn = num(d.n);
        if (!Number.isFinite(nn) || nn <= (dv.lastN || 0)) return j(409, { error: 'replay' });
        dv.lastN = nn; dv.signed = true; id = sid; src = d;
      } else {
        id = deviceByKey(q.headers['x-key'] || qs.get('key') || qs.get('k'));
        if (!id) return j(401, { error: 'bad key' });
        if (db.devices[id].signed) return j(401, { error: 'signature required' });
        src = q.method === 'GET' ? Object.fromEntries(qs) : d;
      }
      realAt[id] = Date.now();
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

    if (url === '/api/health') return j(200, { ok: 1, t: Date.now(), demo: SEED });

    // ---- accounts ---------------------------------------------------------
    if (q.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
      const n = String(d.user || '').toLowerCase().replace(/\s+/g, '').slice(0, 24), p = String(d.pass || '');
      const demoLogin = DEMO && url === '/api/login' && n === 'admin' && p === 'admin' && db.users.admin?.demo === true;
      if (!/^[a-z0-9_]{3,24}$/.test(n) || (p.length < 6 && !demoLogin && !(url === '/api/login' && db.users[n] && db.users[n].seeded))) return j(400, { error: 'username 3-24 chars, password 6+' });
      if (locked(n)) return j(429, { error: 'too many tries, wait a few minutes' });
      if (url === '/api/register') {
        if (db.users[n]) return j(409, { error: 'taken' });
        const salt = rid(8); db.users[n] = { salt, hash: hash(p, salt), role: (d.invite && process.env.RESCUER_CODE && same(d.invite, process.env.RESCUER_CODE)) ? 'rescuer' : Object.values(db.users).some(u => u.role === 'admin') ? 'member' : 'admin' }; touch(); save();
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
      const rm = url.match(/^\/api\/devices\/(\w+)\/respond$/);
      if (q.method === 'POST' && rm) {                         // the rescue team answers an alert
        const dv = db.devices[rm[1]];
        if (!dv || !(me.role === 'rescuer' || me.role === 'admin') || !(dv.demo || dv.rescue)) return j(404, { error: 'no such device' });
        const A = { ack: ['ack', 'acknowledged the alert'], dispatch: ['dispatched', 'dispatched a team'], onscene: ['onscene', 'is on scene'], resolve: ['resolved', 'marked it resolved'], note: [null, 'added a note'] }, a = A[d.action];
        if (!a) return j(400, { error: 'unknown action' });
        const inc = db.incidents[rm[1]] = db.incidents[rm[1]] || { status: 'new', by: null, log: [] }, text = String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        let outcome = null;
        if (d.action === 'resolve') {                         // closing an incident says what it was: this is our measured accuracy
          outcome = String(d.outcome || '');
          if (!['real', 'false', 'test'].includes(outcome)) return j(400, { error: 'choose an outcome: real, false or test' });
          const open = inc.openedAt || null, ackSec = inc.ackAt && open ? Math.round((inc.ackAt - open) / 1000) : null;
          db.outcomes.push({ ts: Date.now(), id: rm[1], outcome, ackSec, triggers: ((last[rm[1]] && last[rm[1]].factors) || []).filter(f => f.pts > 0).map(f => f.id) });
          while (db.outcomes.length > 1000) db.outcomes.shift();
          inc.outcome = outcome;
        }
        if (a[0] === 'ack' && !inc.ackAt) inc.ackAt = Date.now();
        if (a[0]) inc.status = a[0];
        if (a[0] && a[0] !== 'resolved') inc.by = user;
        inc.log.push({ ts: Date.now(), by: user, text: user + ' ' + a[1] + (outcome ? ' as ' + ({ real: 'a real emergency', false: 'a false alarm', test: 'a test or drill' })[outcome] : '') + (text ? ': ' + text : '') }); while (inc.log.length > 100) inc.log.shift();
        touch(); save(); return j(200, view(rm[1], dv));
      }
      const dm = url.match(/^\/api\/devices\/(\w+)\/(route|share|rescue|key)$/);
      if (q.method === 'POST' && dm) {
        const dv = db.devices[dm[1]];
        if (!dv || (dv.owner !== user && (me.role !== 'admin' || dv.demo))) return j(404, { error: 'no such device' });
        if (dm[2] === 'share') { dv.share = rid(8); touch(); save(); return j(200, { share: dv.share }) }
        if (dm[2] === 'key') {                                   // rotate the secret: old key and its replay counter are gone
          if (dv.demo) return j(400, { error: 'the demo keys are fixed' });
          dv.key = rid(12); dv.lastN = 0; dv.signed = false; touch(); save(); return j(200, { key: dv.key });
        }
        if (dm[2] === 'rescue') { dv.rescue = !!d.on; touch(); save(); return j(200, { rescue: dv.rescue }) }
        const pts = Array.isArray(d.points) ? d.points.map(p => [Number(p[0]), Number(p[1])]).filter(p => Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180).slice(0, 500) : [];
        dv.route = pts.length > 1 ? pts : null;
        const c = Number(d.corridor); dv.corridor = c >= 20 && c <= 5000 ? c : undefined;
        touch(); save(); last[dm[1]] = undefined; return j(200, { ok: 1, points: pts.length });
      }
      if (q.method === 'GET' && url === '/api/stats') {         // measured accuracy, from what rescuers actually found
        if (!(me.role === 'rescuer' || me.role === 'admin')) return j(404, { error: 'no such route' });
        const O = db.outcomes, count = o => O.filter(x => x.outcome === o).length, by = {};
        for (const x of O) for (const t of x.triggers) { const e = by[t] = by[t] || { real: 0, false: 0, test: 0 }; e[x.outcome]++ }
        const acks = O.map(x => x.ackSec).filter(Number.isFinite).sort((a, b) => a - b), real = count('real'), bad = count('false');
        return j(200, { resolved: O.length, real, false: bad, test: count('test'), precision: real + bad ? real / (real + bad) : null,
          medianAckSec: acks.length ? acks[Math.floor(acks.length / 2)] : null, open: Object.values(db.incidents).filter(i => i && i.status !== 'resolved').length, byTrigger: by });
      }
      if (q.method === 'GET' && url === '/api/devices') {
        const admin = me.role === 'admin';
        return j(200, Object.entries(db.devices).filter(([, v]) => v.owner === user || (admin && !v.demo) || (me.role === 'rescuer' && (v.demo || v.rescue))).map(([id, v]) => view(id, v)));
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
