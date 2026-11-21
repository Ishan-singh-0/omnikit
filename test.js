// node test.js    (Node 18+, no dependencies)
// Replays a whole simulated mission through the twin engine, then drives the real relay over HTTP.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const T = require('./twin.js');

const T0 = Date.UTC(2026, 5, 1, 6, 0, 0);
const MIN = 60000;

function replay(kind, { seed = 7, keepAlt = true, until = T.sim.END_MIN, route = T.sim.route(), fixed = false } = {}) {
  const rand = T.rng(seed), rows = [], timeline = [];
  let prev = null;
  for (let m = 0; m <= until; m++) {
    const p = T.sim.packet(kind, m, rand);
    if (p) { if (!keepAlt) delete p.alt; rows.push({ ...p, ts: T0 + m * MIN }) }
    if (!rows.length) continue;
    const a = T.assess(rows, { now: T0 + m * MIN, route, fixed });
    timeline.push({ m, a });
    T.diffEvents(prev, a).forEach(e => (e.m = m, timeline.push({ ev: e })));
    prev = a;
  }
  return { rows, timeline, final: timeline.filter(x => x.a).pop().a };
}
const firstMin = (tl, pred) => { const x = tl.find(r => r.a && pred(r.a)); return x ? x.m : null };
const has = (a, id) => a.factors.some(f => f.id === id && f.pts > 0);

test('heat index matches the NWS table', () => {
  assert.ok(Math.abs(T.heatIndex(35, 70) - 51.1) < 1.5);          // 95 F at 70 % RH is about 124 F
  assert.equal(T.heatIndex(20, 50), 20);                          // below 80 F the index is just the temperature
});

test('sea-level correction cancels a climb', () => {
  const low = 1013.25 * Math.pow(1 - 100 / 44330, 5.255), high = 1013.25 * Math.pow(1 - 900 / 44330, 5.255);
  assert.ok(Math.abs(T.slp(low, 100) - 1013.25) < 0.01);
  assert.ok(Math.abs(T.slp(high, 900) - 1013.25) < 0.01);
});

test('route distance', () => {
  const route = [[32, 76], [32, 76.01]];                          // 940 m east-west
  assert.ok(Math.abs(T.distToRoute(32.001, 76.005, route) - 111) < 3);
  assert.ok(Number.isNaN(T.distToRoute(32, 76, null)));
});

test('the hiker story escalates in the right order', () => {
  const { timeline, final } = replay('hiker');
  const tCaution = firstMin(timeline, a => a.level === 'caution'), tDanger = firstMin(timeline, a => a.level === 'danger'), tCrit = firstMin(timeline, a => a.level === 'critical');
  const tStorm = firstMin(timeline, a => has(a, 'storm')), tRoute = firstMin(timeline, a => has(a, 'route')), tFall = firstMin(timeline, a => has(a, 'fall'));
  const tSos = firstMin(timeline, a => has(a, 'sos')), tSilent = firstMin(timeline, a => has(a, 'silent'));
  console.log('  first minute of: caution', tCaution, '| storm', tStorm, '| route', tRoute, '| danger', tDanger, '| fall', tFall, '| critical', tCrit, '| sos', tSos, '| silent', tSilent);
  assert.equal(timeline.find(r => r.a).a.level, 'safe', 'starts calm');
  assert.ok(tCaution !== null && tCaution < T.sim.FALL_MIN, 'a warning arrives BEFORE the fall');
  assert.ok(tStorm !== null && tStorm < T.sim.FALL_MIN, 'storm seen before the incident');
  assert.ok(tRoute !== null && tRoute <= T.sim.FALL_MIN, 'route deviation seen');
  assert.equal(tFall, T.sim.FALL_MIN + 1, 'fall flag one packet after the impact');
  assert.ok(tCrit !== null && tCrit <= T.sim.FALL_MIN + 1, 'critical as soon as the fall is flagged');
  assert.equal(tSos, T.sim.SOS_MIN);
  assert.ok(tSilent !== null && tSilent <= T.sim.LAST_MIN + 6, 'dead-man switch trips within ~6 minutes of the last packet');
  assert.equal(final.level, 'critical');
  assert.ok(final.metrics.pos && Math.abs(final.metrics.pos.lat - 32.2584) < 0.001, 'last known position survives the silence');
});

test('altitude correction stops a climb being called a storm', () => {
  // The first 40 minutes are a climb of 160 m in calm weather (storm only starts at minute 18 and is mild until later).
  const calm = []; const rand = T.rng(3);
  for (let m = 0; m <= 40; m++) { const p = T.sim.packet('buddy', m, rand); p.p = +(1013.2 * Math.pow(1 - (1900 + 4 * m) / 44330, 5.255)).toFixed(2); calm.push({ ...p, ts: T0 + m * MIN, alt: 1900 + 4 * m }) }
  const withAlt = T.assess(calm, { now: T0 + 40 * MIN });
  assert.ok(!has(withAlt, 'storm'), 'no storm when pressure only fell because they climbed');
  const noAlt = calm.map(r => { const c = { ...r }; delete c.alt; return c });
  const naive = T.assess(noAlt, { now: T0 + 40 * MIN });
  const f = naive.factors.find(x => x.id === 'storm');
  assert.ok(f && f.sev === 'caution' && f.pts <= 20, 'without altitude a moving unit is capped at a low-confidence caution, never danger');
});

test('a fixed station is never "inactive"', () => {
  const { final } = replay('base', { fixed: true, route: null });
  assert.ok(!has(final, 'still') && !has(final, 'fall'));
  const person = replay('base', { fixed: false, route: null }).final;
  assert.ok(has(person, 'still'), 'the same data from a person would be flagged');
});

test('diffEvents wakes a human only for danger and above', () => {
  const rows = [{ ts: T0, t: 20, h: 50, p: 900, flags: 0 }];
  const a0 = T.assess(rows, { now: T0 });
  const sos = T.assess([...rows, { ts: T0 + 10000, t: 20, h: 50, p: 900, flags: T.FLAG.SOS }], { now: T0 + 10000 });
  const ev = T.diffEvents(a0, sos);
  assert.ok(ev.some(e => e.id === 'sos' && e.notify));
  assert.ok(!T.diffEvents(sos, sos).length, 'no repeat events for an unchanged state');
});

test('rescue brief carries position, time and reasons', () => {
  const { rows } = replay('hiker');
  const a = T.assess(rows, { now: T0 + 70 * MIN, route: T.sim.route() });
  const b = T.brief('Test hiker', a);
  for (const needle of ['RESCUE BRIEF', 'CRITICAL', 'Last known position: 32.25', 'openstreetmap.org', 'SOS pressed']) assert.ok(b.includes(needle), needle);
});

/* ---------------------------- the relay, for real ---------------------------- */
function req(port, method, url, body, headers = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ port, method, path: url, headers: { 'content-type': 'application/json', ...headers } }, resp => {
      let b = ''; resp.on('data', d => b += d); resp.on('end', () => { let j = null; try { j = JSON.parse(b) } catch {} res({ s: resp.statusCode, j, b }) });
    });
    r.on('error', rej); r.end(body ? JSON.stringify(body) : undefined);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('relay: ingest, store-and-forward timestamps, SOS webhook, share link', async () => {
  const hooks = [];
  const mock = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { hooks.push(JSON.parse(b)); s.end('ok') }) });
  await new Promise(r => mock.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikit-')), port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: port, DATA_FILE: path.join(dir, 'data.json'), ALERT_WEBHOOK: 'http://127.0.0.1:' + mock.address().port + '/hook', DEMO: '' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await req(port, 'GET', '/api/health')).s === 200) break } catch {} await wait(100) }
    assert.equal((await req(port, 'GET', '/twin.js')).s, 200, 'engine is served to the browser');

    const reg = await req(port, 'POST', '/api/register', { user: 'tester', pass: 'secret1' });
    assert.equal(reg.s, 200); const auth = { authorization: 'Bearer ' + reg.j.token };
    const dev = await req(port, 'POST', '/api/devices', { name: 'Trekker 1' }, auth);
    assert.equal(dev.s, 200);
    const key = dev.j.key;

    assert.equal((await req(port, 'POST', '/ingest?key=wrong', { t: 20 })).s, 401);
    assert.equal((await req(port, 'POST', '/ingest?key=' + key, { flags: 0 })).s, 400, 'a packet with no sensor reading is refused');

    // a queued packet that the SIM800L sent 120 s late must land 120 s in the past
    const before = Date.now();
    assert.equal((await req(port, 'POST', '/ingest?key=' + key, { t: 20, h: 50, p: 900, lat: 32.25, lon: 76.33, alt: 1950, flags: 0, ago: 120 })).s, 200);
    let list = (await req(port, 'GET', '/api/devices', null, auth)).j;
    const ts = list[0].rows[0].ts;
    assert.ok(ts <= before - 119000 && ts >= before - 125000, 'ago= shifts the stored timestamp');
    assert.equal(list[0].rows[0].alt, 1950);
    assert.equal(list[0].risk.level, 'safe');
    assert.equal(hooks.length, 0, 'calm data sends no alert');

    // SOS
    assert.equal((await req(port, 'POST', '/ingest?key=' + key, { t: 20, h: 50, p: 900, lat: 32.25, lon: 76.33, flags: 32 })).s, 200);
    for (let i = 0; i < 30 && !hooks.length; i++) await wait(100);
    assert.equal(hooks.length, 1, 'SOS fires exactly one webhook');
    assert.match(hooks[0].text, /SOS pressed/);
    assert.match(hooks[0].text, /32\.25000, 76\.33000/);
    list = (await req(port, 'GET', '/api/devices', null, auth)).j;
    assert.equal(list[0].risk.level, 'critical');
    assert.ok(list[0].events.some(e => e.id === 'sos'));

    // repeated SOS packets do not spam
    await req(port, 'POST', '/ingest?key=' + key, { t: 20, h: 50, p: 900, flags: 32 });
    await wait(300);
    assert.equal(hooks.length, 1);

    // the read-only share link works without a login and exposes the risk state
    const pub = await req(port, 'GET', '/api/public/' + list[0].share);
    assert.equal(pub.s, 200); assert.equal(pub.j.risk.level, 'critical');
    // rotating the link kills the old one
    const rot = await req(port, 'POST', '/api/devices/' + list[0].id + '/share', {}, auth);
    assert.equal(rot.s, 200);
    assert.equal((await req(port, 'GET', '/api/public/' + list[0].share)).s, 404);
    assert.equal((await req(port, 'GET', '/api/public/' + rot.j.share)).s, 200);

    // a second user cannot see the first user's device
    const reg2 = await req(port, 'POST', '/api/register', { user: 'other', pass: 'secret2' });
    const other = (await req(port, 'GET', '/api/devices', null, { authorization: 'Bearer ' + reg2.j.token })).j;
    assert.equal(other.length, 0);
  } finally { srv.kill(); mock.close() }
});
