/* =============================================================================
   OMNIKIT twin engine: turns raw telemetry into an explainable survival-risk state.

   One file, no dependencies. The relay (server.js) and the dashboard (index.html)
   load the SAME code, so what the judge sees on screen is what the server alerts on.
   `node test.js` replays a whole simulated mission through it.

   Every rule is a published, checkable threshold, not a black box:
     storm      sea-level pressure trend  (UK Met Office / WMO tendency: 3.6 hPa per 3 h = "falling rapidly",
                                           6 hPa per 3 h = "very rapidly")
     heat       NWS Rothfusz heat index   (32 C extreme caution, 41 C danger, 54 C extreme danger)
     cold       ambient temperature       (5 C / 0 C)
     impact     fall flag raised ON the ESP32 (impact > 2.2 g, then no movement for 15 s)
     SOS        deliberate 3 s hold of the BOOT key
     inactivity no movement from GPS speed / tilt / shake
     route      distance from the planned trail
     silence    no packet for N minutes   (the dead-man's switch)
   These are decision-support flags, not a medical or meteorological diagnosis.
   ========================================================================== */
(function (root, factory) {
  const T = factory();
  if (typeof module === 'object' && module.exports) module.exports = T; else root.Twin = T;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FLAG = { MQ: 1, WARM: 2, HOT: 4, LOUD: 8, SHAKE: 16, SOS: 32, FALL: 64 };
  const RANK = { safe: 0, info: 0, caution: 1, danger: 2, critical: 3 };
  const DEFAULTS = {
    mq: 2.2, mic: 78,                       // mirror esp32_gateway.ino
    trendMin: 45, trendMinSpan: 15,         // pressure window, and the least data (minutes) before we trust a slope
    stormWarn: 1.2, stormDanger: 2.0,       // hPa per hour, falling
    heatWarn: 32, heatDanger: 41, heatCritical: 54,
    coldWarn: 5, coldDanger: 0,
    inactiveWarn: 10, inactiveDanger: 25,   // minutes without movement
    silentWarn: 5, silentDanger: 15,        // minutes without a packet
    moveMps: 0.5, moveDeg: 8,               // what counts as "moving"
    corridor: 150,                          // metres either side of the planned route
    fixed: false,                           // true for a base station: it is not a person, so no inactivity or fall logic
    route: null, now: null
  };

  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v, d) => { const k = Math.pow(10, d || 0); return Math.round(v * k) / k };

  /* ------------------------------- physics -------------------------------- */
  // Rothfusz regression (NWS). Input and output in degrees C.
  function heatIndex(t, h) {
    if (!fin(t)) return NaN;
    if (!fin(h)) return t;
    const T = t * 9 / 5 + 32;
    if (T < 80) return t;
    let HI = -42.379 + 2.04901523 * T + 10.14333127 * h - 0.22475541 * T * h - 0.00683783 * T * T
      - 0.05481717 * h * h + 0.00122874 * T * T * h + 0.00085282 * T * h * h - 0.00000199 * T * T * h * h;
    if (h < 13 && T <= 112) HI -= ((13 - h) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (h > 85 && T <= 87) HI += ((h - 85) / 10) * ((87 - T) / 5);
    return (HI - 32) * 5 / 9;
  }

  // Station pressure -> sea-level pressure, given GPS altitude in metres.
  // Climbing 8 m costs about 1 hPa, so without this a hiker gaining height looks like an approaching storm.
  const slp = (p, alt) => (fin(p) && fin(alt)) ? p / Math.pow(1 - alt / 44330, 5.255) : p;

  function dist(aLat, aLon, bLat, bLon) {             // metres, equirectangular: fine under a few km
    const k = Math.cos((aLat + bLat) / 2 * Math.PI / 180), dy = (bLat - aLat) * 111320, dx = (bLon - aLon) * 111320 * k;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distToRoute(lat, lon, route) {
    if (!route || route.length < 2) return NaN;
    const k = Math.cos(lat * Math.PI / 180), P = route.map(q => [(q[1] - lon) * 111320 * k, (q[0] - lat) * 111320]);
    let best = Infinity;
    for (let i = 1; i < P.length; i++) {
      const [ax, ay] = P[i - 1], [bx, by] = P[i], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const u = L ? clamp(-(ax * dx + ay * dy) / L, 0, 1) : 0, px = ax + u * dx, py = ay + u * dy;
      best = Math.min(best, Math.sqrt(px * px + py * py));
    }
    return best;
  }

  function slope(pts) {                                // least squares, x in hours -> units per hour
    const n = pts.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y }
    const d = n * sxx - sx * sx;
    return d ? (n * sxy - sx * sy) / d : 0;
  }

  /* ------------------------------- assessment ----------------------------- */
  function assess(rows, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const now = fin(o.now) ? o.now : Date.now();
    const res = { asOf: now, level: 'nodata', score: 0, factors: [], metrics: {}, headline: 'Waiting for the first packet' };
    if (!rows || !rows.length) return res;

    const last = rows[rows.length - 1], m = res.metrics, fl = last.flags | 0;
    const add = (id, pts, sev, label, detail, action) => res.factors.push({ id, pts, sev, label, detail, action });

    // ---- what we know ----
    m.lastTs = last.ts;
    m.ageSec = Math.max(0, Math.round((now - last.ts) / 1000));
    let pos = null;
    for (let i = rows.length - 1; i >= 0; i--) if (fin(rows[i].lat) && fin(rows[i].lon)) { pos = rows[i]; break }
    if (pos) m.pos = { lat: pos.lat, lon: pos.lon, sats: pos.sats, alt: fin(pos.alt) ? pos.alt : null, ts: pos.ts, ageSec: Math.max(0, Math.round((now - pos.ts) / 1000)) };
    for (const k of ['t', 'h', 'p', 'mq', 'mic', 'csq']) { for (let i = rows.length - 1; i >= 0; i--) if (fin(rows[i][k])) { m[k] = rows[i][k]; break } }

    const moving = (a, b) => {
      if ((b.flags | 0) & FLAG.SHAKE) return true;
      const dt = (b.ts - a.ts) / 1000;
      if (dt <= 0 || dt > 300) return false;           // a long gap says nothing about movement
      if (fin(a.lat) && fin(b.lat) && fin(a.lon) && fin(b.lon) && dist(a.lat, a.lon, b.lat, b.lon) / dt >= o.moveMps) return true;
      if (fin(a.pitch) && fin(b.pitch) && Math.abs(b.pitch - a.pitch) >= o.moveDeg) return true;
      if (fin(a.roll) && fin(b.roll) && Math.abs(b.roll - a.roll) >= o.moveDeg) return true;
      return false;
    };
    let lastMove = rows[0].ts;
    for (let i = rows.length - 1; i >= 1; i--) if (moving(rows[i - 1], rows[i])) { lastMove = rows[i].ts; break }
    m.inactiveMin = Math.round((now - lastMove) / 60000);

    // ---- SOS and fall: raised by the device itself, so they work with no cloud ----
    if (fl & FLAG.SOS) {
      let since = last.ts; for (let i = rows.length - 1; i >= 0 && ((rows[i].flags | 0) & FLAG.SOS); i--) since = rows[i].ts;
      add('sos', 100, 'critical', 'SOS pressed on the device', 'Held BOOT for 3 s at ' + new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. A person asked for help.', 'Dispatch now. Send the rescue brief.');
    }
    if (!o.fixed && (fl & FLAG.FALL)) {
      add('fall', 85, 'critical', 'Fall suspected', 'The unit felt an impact above 2.2 g, then no movement for 15 s. Decided on the ESP32, no network needed.', 'Call or radio them. If there is no answer, treat as an injury.');
    }

    // ---- weather: pressure trend, corrected for altitude ----
    const win = rows.filter(r => fin(r.p) && r.ts >= last.ts - o.trendMin * 60000);
    if (win.length >= 6 && (win[win.length - 1].ts - win[0].ts) >= o.trendMinSpan * 60000) {
      const corrected = win.every(r => fin(r.alt));
      let anyMove = false; for (let i = 1; i < win.length && !anyMove; i++) anyMove = moving(win[i - 1], win[i]);
      const t0 = win[0].ts, s = slope(win.map(r => [(r.ts - t0) / 3.6e6, corrected ? slp(r.p, r.alt) : r.p]));
      const conf = (corrected || !anyMove) ? 'high' : 'low';
      const spanMin = Math.round((win[win.length - 1].ts - t0) / 60000);
      m.pressure = { slope: round(s, 2), corrected, confidence: conf, spanMin };
      const drop = -s;
      if (drop >= o.stormWarn) {
        const hard = drop >= o.stormDanger;
        const how = (corrected ? 'Sea-level pressure' : 'Pressure') + ' falling ' + round(drop, 1) + ' hPa/h over ' + spanMin + ' min';
        if (conf === 'low') add('storm', 20, 'caution', 'Pressure falling fast', how + ', but the unit is moving and has no GPS altitude, so this may only be a climb.', 'Check the sky. Wait for a GPS fix to confirm.');
        else add('storm', hard ? 50 : 28, hard ? 'danger' : 'caution', hard ? 'Storm front approaching' : 'Weather turning', how + (corrected ? ' (altitude-corrected).' : ' (unit is stationary).'), hard ? 'Get below the ridgeline and into shelter before it arrives.' : 'Plan a lower, sheltered route.');
      }
    }

    // ---- heat and cold ----
    if (fin(m.t)) {
      const hi = heatIndex(m.t, m.h); m.heatIndex = round(hi, 1);
      if (hi >= o.heatCritical) add('heat', 85, 'critical', 'Extreme heat', 'Heat index ' + round(hi, 0) + ' C. Heat stroke is likely.', 'Stop, shade, water, cool the body.');
      else if (hi >= o.heatDanger) add('heat', 55, 'danger', 'Dangerous heat', 'Heat index ' + round(hi, 0) + ' C (' + round(m.t, 1) + ' C at ' + round(m.h || 0, 0) + ' % RH).', 'Rest in shade, drink, stop climbing.');
      else if (hi >= o.heatWarn) add('heat', 28, 'caution', 'Heat stress building', 'Heat index ' + round(hi, 0) + ' C.', 'Take it slower and drink more.');
      if (m.t <= o.coldDanger) add('cold', 50, 'danger', 'Freezing', round(m.t, 1) + ' C. Hypothermia risk, worse if wet or windy.', 'Insulate, get out of the wind, keep moving if able.');
      else if (m.t <= o.coldWarn) add('cold', 28, 'caution', 'Cold exposure', round(m.t, 1) + ' C' + (fin(m.h) && m.h > 85 ? ' and damp air' : '') + '. Hypothermia risk if they stop moving.', 'Add layers before you cool down.');
    }

    // ---- air and noise (indicators only: MQ-135 cannot name a gas, the mic is uncalibrated) ----
    const warm = (fl & FLAG.WARM) > 0;
    if (!warm && ((fl & FLAG.MQ) || (fin(last.mq) && last.mq > o.mq))) add('air', 30, 'caution', 'Air response elevated', 'MQ-135 at ' + round(last.mq, 2) + ' V. Smoke or fumes are possible. The sensor cannot say which gas.', 'Move upwind and check for fire.');
    if ((fl & FLAG.LOUD) || (fin(last.mic) && last.mic > o.mic)) add('noise', 8, 'info', 'Loud environment', 'Sound index ' + round(last.mic, 0) + ' (relative, uncalibrated).', null);

    // ---- route ----
    if (pos && o.route && o.route.length > 1) {
      const off = distToRoute(pos.lat, pos.lon, o.route); m.offRoute = round(off, 0);
      if (off >= o.corridor * 2) add('route', 40, 'danger', 'Far off the planned route', Math.round(off) + ' m from the trail (limit ' + o.corridor + ' m).', 'Ask them to retrace to the trail, or send a team to the last fix.');
      else if (off >= o.corridor) add('route', 25, 'caution', 'Off the planned route', Math.round(off) + ' m from the trail (limit ' + o.corridor + ' m).', 'Confirm they know where they are.');
    }

    // ---- inactivity (people only) ----
    if (!o.fixed) {
      if (m.inactiveMin >= o.inactiveDanger) add('still', 50, 'danger', 'No movement for ' + m.inactiveMin + ' min', 'No GPS travel, tilt change or shake. They may be hurt, asleep or have left the unit behind.', 'Try to reach them.');
      else if (m.inactiveMin >= o.inactiveWarn) add('still', 28, 'caution', 'Stopped for ' + m.inactiveMin + ' min', 'No GPS travel, tilt change or shake.', 'Probably a rest. Watch for more flags.');
    }

    // ---- dead-man's switch ----
    const ageMin = m.ageSec / 60;
    if (ageMin >= o.silentDanger) add('silent', 50, 'danger', (o.fixed ? 'Station' : 'No contact') + ' for ' + Math.round(ageMin) + ' min', 'Last packet at ' + new Date(last.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. The last known position and conditions are kept below.', 'Go to the last known position.');
    else if (ageMin >= o.silentWarn) add('silent', 30, 'caution', 'No contact for ' + Math.round(ageMin) + ' min', 'Likely a dead zone or a low battery. The twin keeps the last known state.', 'Try them by phone.');
    if (fin(m.csq) && m.csq < 8 && ageMin < o.silentWarn) add('signal', 0, 'info', 'Weak signal', 'CSQ ' + m.csq + '. Packets may queue on the device and arrive late.', null);

    // ---- fusion: a single odd reading is noise, a combination is a pattern ----
    const ids = new Set(res.factors.filter(f => f.pts > 0 && RANK[f.sev] >= 1).map(f => f.id));
    const core = ['fall', 'still', 'route', 'storm', 'cold', 'heat', 'silent'].filter(k => ids.has(k));
    if (core.length >= 3) {
      const names = { fall: 'impact', still: 'no movement', route: 'off route', storm: 'storm', cold: 'cold', heat: 'heat', silent: 'no contact' };
      add('pattern', 15, 'danger', 'Compound distress pattern', core.map(k => names[k]).join(' + ') + '. Each alone is common; together they match an incident.', 'Treat as a live emergency.');
    }

    res.factors.sort((a, b) => b.pts - a.pts);
    res.score = Math.min(100, res.factors.reduce((s, f) => s + f.pts, 0));
    res.level = res.score >= 80 ? 'critical' : res.score >= 50 ? 'danger' : res.score >= 25 ? 'caution' : 'safe';
    res.headline = res.factors.find(f => f.pts > 0) ? res.factors.find(f => f.pts > 0).label : 'All clear';
    return res;
  }

  // What changed between two assessments. `notify` marks events worth waking a human for.
  function diffEvents(prev, next) {
    const ev = [], ts = next.asOf;
    if (!next || next.level === 'nodata') return ev;
    const before = new Map(((prev && prev.factors) || []).map(f => [f.id, f]));
    const after = new Map(next.factors.map(f => [f.id, f]));
    if (!prev || prev.level !== next.level) ev.push({ ts, id: 'level', sev: next.level, text: 'Status ' + next.level.toUpperCase(), detail: next.headline, notify: false });
    for (const f of next.factors) {
      const p = before.get(f.id);
      if (!p || RANK[f.sev] > RANK[p.sev]) ev.push({ ts, id: f.id, sev: f.sev, text: f.label, detail: f.detail, notify: RANK[f.sev] >= 2 });
    }
    for (const p of before.values()) if (!after.has(p.id) && RANK[p.sev] >= 1) ev.push({ ts, id: p.id, sev: 'info', text: p.label + ' cleared', detail: '', notify: false });
    return ev;
  }

  /* ------------------------------- rescue brief --------------------------- */
  function brief(name, a, extra) {
    const m = a.metrics, hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const L = ['OMNIKIT RESCUE BRIEF', 'Unit: ' + name, 'Status: ' + (a.level || 'nodata').toUpperCase() + ' (risk ' + a.score + '/100)'];
    const act = a.factors.filter(f => f.pts > 0);
    if (act.length) { L.push('Why:'); act.forEach(f => L.push(' - ' + f.label + ': ' + f.detail)) }
    if (m.lastTs) L.push('Last contact: ' + hhmm(m.lastTs) + ' (' + (m.ageSec < 90 ? m.ageSec + ' s' : Math.round(m.ageSec / 60) + ' min') + ' ago)');
    if (m.pos) {
      const la = m.pos.lat.toFixed(5), lo = m.pos.lon.toFixed(5);
      L.push('Last known position: ' + la + ', ' + lo + (m.pos.sats ? ' (' + m.pos.sats + ' satellites)' : '') + ', fix ' + (m.pos.ageSec < 90 ? m.pos.ageSec + ' s' : Math.round(m.pos.ageSec / 60) + ' min') + ' old');
      if (m.pos.alt != null) L.push('Altitude: ' + Math.round(m.pos.alt) + ' m');
      L.push('Map: https://www.openstreetmap.org/?mlat=' + la + '&mlon=' + lo + '#map=17/' + la + '/' + lo);
      L.push('Navigate: https://www.google.com/maps/search/?api=1&query=' + la + ',' + lo);
    } else L.push('Last known position: none (no GPS fix was ever received)');
    const c = [];
    if (fin(m.t)) c.push(round(m.t, 1) + ' C');
    if (fin(m.h)) c.push(round(m.h, 0) + ' % RH');
    if (fin(m.p)) c.push(round(m.p, 0) + ' hPa');
    if (c.length) L.push('Conditions: ' + c.join(', ') + (m.pressure ? ', pressure ' + (m.pressure.slope < 0 ? 'falling ' : 'rising ') + Math.abs(m.pressure.slope) + ' hPa/h' : ''));
    if (fin(m.offRoute)) L.push('Distance from planned route: ' + m.offRoute + ' m');
    if (fin(m.inactiveMin)) L.push('Last movement: ' + m.inactiveMin + ' min ago');
    L.push('Decision support from a prototype sensor node. Verify before acting.');
    if (extra) L.push(extra);
    return L.join('\n');
  }

  /* ------------------------------- mission simulator ---------------------- */
  // Deterministic, so the demo and the tests tell the same story every run.
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 };
  }

  const START = { lat: 32.2430, lon: 76.3213, alt: 1900 };       // a mountain trail, invented for the demo
  const trail = m => ({ lat: START.lat + 0.00032 * m, lon: START.lon + 0.00040 * m });
  const sim = {
    START,
    FALL_MIN: 48, SOS_MIN: 51, LAST_MIN: 52, END_MIN: 75,
    // the planned route the team filed before leaving
    route() { const r = []; for (let m = 0; m <= 70; m += 5) { const q = trail(m); r.push([q.lat, q.lon]) } return r },
    // kind: 'hiker' (the story), 'buddy' (same weather, no incident), 'base' (fixed station)
    packet(kind, m, rand, inj) {
      inj = inj || {};
      const n = s => (rand() - 0.5) * 2 * s;
      const fixed = kind === 'base';
      const climb = fixed ? 0 : Math.min(m, 40) * 4;
      const alt = START.alt + climb + n(1.5);
      const trueSlp = 1013.2 - (m > 18 ? 0.045 * (m - 18) : 0);
      const p = trueSlp * Math.pow(1 - (START.alt + climb) / 44330, 5.255) + n(0.05);
      const storm = Math.max(0, m - 26);
      let t = 21 - 6.5 * climb / 1000 - 0.4 * storm + n(0.15);
      const h = clamp(55 + (m > 18 ? 0.9 * (m - 18) : 0) + n(1), 20, 95);
      let lat, lon, pitch, roll, flags = 0, mq = 1.35 + n(0.05), mic = 46 + n(5) + (m > 35 ? 10 : 0), csq = clamp(Math.round(17 + n(2)), 8, 26), sats = clamp(Math.round(8 + n(1.2)), 6, 10);
      if (fixed) {
        lat = START.lat + n(0.00002); lon = START.lon + n(0.00002); pitch = n(0.3); roll = n(0.3);
      } else {
        const tr = trail(m), strayMin = kind === 'hiker' ? Math.max(0, Math.min(m, sim.FALL_MIN) - 40) : 0;
        lat = tr.lat + (kind === 'buddy' ? 0.00012 : 0) + n(0.00002);
        lon = tr.lon + (kind === 'buddy' ? 0.00012 : 0) + 0.0006 * strayMin + n(0.00002);
        pitch = -8 + n(5); roll = 4 + n(6);
        if (kind === 'hiker' && m >= sim.FALL_MIN) {
          lat = trail(sim.FALL_MIN).lat + n(0.00002); lon = trail(sim.FALL_MIN).lon + 0.0006 * 8 + n(0.00002);
          if (m === sim.FALL_MIN) { flags |= FLAG.SHAKE | FLAG.LOUD; pitch = 68; roll = -35; mic = 88 }
          else { flags |= FLAG.FALL; pitch = 66 + n(0.3); roll = -33 + n(0.3); mic = 40 + n(3) }
          if (m >= sim.SOS_MIN) flags |= FLAG.SOS;
          if (m >= sim.FALL_MIN + 2) csq = clamp(Math.round(9 + n(1)), 6, 12);
        }
      }
      if (kind === 'hiker' && m > sim.LAST_MIN) return null;           // the radio dies: nothing more arrives
      if (inj.smoke) { mq += 1.2; flags |= FLAG.MQ }
      if (inj.loud) { mic = 92; flags |= FLAG.LOUD }
      if (inj.fall) { flags |= FLAG.FALL | FLAG.SHAKE; pitch = 64; roll = -30 }
      if (inj.sos) flags |= FLAG.SOS;
      if (inj.cold) t = -3;
      if (inj.heat) t = 41;
      return { t: round(t, 2), h: round(h, 1), p: round(p, 2), mq: round(mq, 3), mic: round(mic, 1), pitch: round(pitch, 1), roll: round(roll, 1), lat: round(lat, 6), lon: round(lon, 6), sats, alt: round(alt, 1), flags, csq };
    }
  };

  return { FLAG, DEFAULTS, RANK, assess, diffEvents, brief, heatIndex, slp, dist, distToRoute, rng, sim };
});
