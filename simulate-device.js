#!/usr/bin/env node
// Pretend to be the ESP32, so you can see the whole site react with no hardware.
//
//   node simulate-device.js http://localhost:8080 DEVICE_KEY                 # backfill a 52-minute trek that ends now
//   node simulate-device.js https://your-site DEVICE_KEY --history 40        # stop earlier (40 = storm building, no incident yet)
//   node simulate-device.js URL KEY --history 0 --live                       # then send a calm heartbeat every 10 s
//   node simulate-device.js URL KEY --sos                                    # one live SOS packet at the last position
//   node simulate-device.js URL KEY --fall                                   # one live fall packet
//
// Options: --kind hiker|buddy|base (default hiker)   --interval 10 (seconds between live packets)
//          --signed      sign every packet with HMAC-SHA256 like the firmware (uses the device ID, so pass --id DEVICE_ID).
//                        Do not point --signed at a unit that also has real hardware: both share one replay counter.
// It sends exactly what the firmware sends: JSON to /ingest?key=KEY, with "ago" for backfilled packets.
const T = require('./twin.js');
const [url, key, ...rest] = process.argv.slice(2);
if (!url || !key) { console.error('usage: node simulate-device.js <relay-url> <device-key> [--history N] [--live] [--sos] [--fall] [--kind hiker|buddy|base]'); process.exit(1) }
const opt = n => { const i = rest.indexOf('--' + n); return i < 0 ? null : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) };
const kind = opt('kind') || 'hiker', N = opt('history') === null ? T.sim.LAST_MIN : Math.max(0, +opt('history') || 0), every = Math.max(2, +opt('interval') || 10);
const signed = !!opt('signed'), devId = opt('id');
if (signed && typeof devId !== 'string') { console.error('--signed needs --id DEVICE_ID (the device id, not the key)'); process.exit(1) }
const base = url.replace(/\/+$/, '') + (signed ? '/ingest?id=' + encodeURIComponent(devId) : '/ingest?key=' + encodeURIComponent(key));
let counter = Math.floor(Date.now() / 1000);
const crypto = require('crypto');
const rand = T.rng(11);
const send = async body => {
  let text = JSON.stringify(body);
  if (signed) {                                                    // the same wire format as the ESP32: {...,"n":N,"sig":"HEX"}
    const prefix = text.slice(0, -1) + ',"n":' + (++counter);
    text = prefix + ',"sig":"' + crypto.createHmac('sha256', key).update(prefix).digest('hex') + '"}';
  }
  const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  if (!r.ok) { let why = ''; try { why = (await r.json()).error } catch {} console.error('relay answered HTTP ' + r.status + (why ? ': ' + why : '') + (why === 'signature required' ? ' (this device signs its packets: add --signed --id DEVICE_ID)' : '')); process.exit(1) }
};
(async () => {
  let m = 0, lastPacket = null;
  if (N > 0 || (!opt('live') && !opt('sos') && !opt('fall'))) {
    console.log('sending ' + (N + 1) + ' minutes of history…');
    for (m = 0; m <= N; m++) {
      const p = T.sim.packet(kind, m, rand);
      if (!p) break;
      lastPacket = p;
      await send({ ...p, ago: (N - m) * 60 });
    }
    console.log('done. Open the dashboard: the unit now has ' + (N + 1) + ' minutes of track, weather trend and events.');
  }
  if (!lastPacket) lastPacket = T.sim.packet(kind, 10, rand);
  const live = (extra) => ({ ...lastPacket, flags: (lastPacket.flags | 0) & ~(T.FLAG.SHAKE | T.FLAG.LOUD) | (extra || 0), lat: lastPacket.lat + (rand() - .5) * 2e-5, lon: lastPacket.lon + (rand() - .5) * 2e-5 });
  if (opt('sos')) { await send(live(T.FLAG.SOS)); console.log('SOS sent.') }
  if (opt('fall')) { await send(live(T.FLAG.FALL | T.FLAG.SHAKE)); console.log('fall packet sent.') }
  if (opt('live')) {
    console.log('heartbeat every ' + every + ' s. Ctrl-C to stop (the relay will then flag the silence).');
    for (;;) { await send(live(opt('sos') ? T.FLAG.SOS : 0)); await new Promise(r => setTimeout(r, every * 1000)) }
  }
})().catch(e => { console.error('could not reach ' + url + ': ' + e.message); process.exit(1) });
