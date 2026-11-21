# OMNIKIT — Wilderness Survival & Rescue Digital Twin

> **Know where they are, and how they are.**
> A pocket ESP32 node that decides on the device, plus a digital twin that explains *why* someone may be in trouble and tells a responder by itself.

A location dot tells a rescuer *where*. It does not tell them *what happened*. OMNIKIT adds the missing context: impact, stillness, weather, route and the last known state, fused into one risk score that shows its working.

## Why this is more than a tracker

| Idea | What it does | Where it runs |
|---|---|---|
| **Edge-first safety** | Fall detection (impact > 2.2 g, then 15 s of stillness, IMU polled every 40 ms) with a **10-second "I'm fine" window** (beeps, LCD says *FALL? PRESS BOOT*) before it escalates, and a 3-second **SOS** hold. | On the ESP32. No network needed. |
| **SOS by SMS** | On SOS or a confirmed fall the SIM800L texts the position and a map link to up to three numbers, and repeats every 10 min. SMS needs only 2G signal, no data plan and no relay. | On the ESP32 |
| **Battery-aware** | A cell on GPIO33 reports charge. Low battery warns. A unit that goes quiet with a flat battery is called *likely battery death*, not a dead zone. | Firmware + `twin.js` |
| **Signed packets** | Each packet carries a counter and an HMAC-SHA256 signature. The secret key never travels, forged or replayed packets are refused, and a device that signs can no longer fall back to the unsigned way. | Firmware + relay |
| **Measured accuracy** | Rescuers close an incident as *Real emergency*, *False alarm* or *Test*. The board shows precision and false alarms per rule, from real answers only. | Relay + dashboard |
| **Climb vs storm** | A hiker gaining height sees pressure fall about 1 hPa per 8 m. We correct pressure to sea level with GPS altitude, so only real weather trips the storm rule. | Relay + dashboard |
| **Explainable risk** | Score 0–100 is the sum of named rules with published thresholds (NWS heat index, WMO pressure tendency). Every point has a reason and a suggested action. | `twin.js` |
| **Compound pattern** | Impact + off-route + storm + stillness together raise a *distress pattern*. Each alone is normal; together they are not. | `twin.js` |
| **Dead-man's switch** | The relay flags a unit that goes quiet (5 / 15 min) even if nobody has the dashboard open, and keeps the last known position and conditions. | `server.js` |
| **Store-and-forward honesty** | Packets queue on the device with no signal. Each carries `ago`, so the relay places it at the real time, not the arrival time. | Firmware + relay |
| **Rescue brief, sent automatically** | On danger or critical the relay posts a ready-to-act message (who, where, why, map link) to a webhook or Telegram. | `server.js` |

One engine, one source of truth: `twin.js` is loaded by both the relay and the browser, and `node test.js` replays a whole simulated trek through it.

## Run it in 60 seconds (no hardware)

Needs Node 18+. No dependencies.

```bash
node server.js --demo        # or: npm run demo
```

Open <http://localhost:8080/?demo=1>. You get a **75-minute simulated trek** running through the real risk engine. Press **Rescue brief** at any moment.

```bash
npm test                      # 9 tests: engine, full simulated trek, relay over HTTP, webhook
```

## Judge demo profile

Start the relay with the demo profile:

```bash
node server.js --demo --seed        # or: npm run demo      (on a host: set SEED_DEMO=1)
```

Open <http://localhost:8080/login> and sign in as **user 1** / **user** (the login page has a "fill it in" link; spaces in usernames are ignored). The account holds four units, rebuilt fresh every start, with the last 52 minutes of history ending now:

| Unit | State | What it shows |
|---|---|---|
| **Trekker 1 · Asha** | **Critical.** An incident in progress | Storm building, left the planned route, fell, pressed SOS. Still down, still transmitting. |
| **Trekker 2 · Ravi** | Same storm, no incident | The twin does not cry wolf: only the weather rule fires. |
| **Base camp** | Fixed station | Its barometer confirms the front. Never flagged "inactive". |
| **Live node · your ESP32** | Empty | The slot for the judges to watch real hardware arrive. |

The three simulated units keep transmitting every 10 s, so the page is alive. Real packets for a unit pause its simulated feed.

### The rescue team profile

Sign in as **rescuer 1** / **rescue** (the login page has a second "fill it in" link). The page becomes a responder console:

- **Incident board:** every unit shared with the rescue team, most dangerous first, with risk, reason, time since contact and response status. Click a row to open it.
- **Response panel** for the selected unit, with everything a responder needs in one place: last known position with *Navigate* (Google Maps), OpenStreetMap and *Copy coordinates*; GPS altitude; time since contact and since last movement; conditions and pressure trend at the unit; distance off the planned route; distance and bearing from base camp; who the unit is registered to; active hazards; recommended actions; suggested kit and approach; and the rescue brief.
- **Respond:** *Acknowledge*, *Dispatch team*, *On scene*, *Resolve* (you must say what it was: **Real emergency**, **False alarm** or **Test or drill**), plus free-text notes. The board header then shows **measured accuracy**: resolved count, precision, false alarms, median time to acknowledge, and accuracy per rule (for example *fall: 3 real / 1 false*). Nothing is pre-filled: it only counts what rescuers really answered, so close a test incident to see it appear. Every action goes in a shared **response log**, and the hiker's own dashboard shows it ("acknowledged", "team dispatched"), so the person who asked for help can see that help is coming. A new danger on a resolved unit re-opens the incident.
- **Privacy:** a rescuer only sees units their owner chose to share (**Team → Share with rescue team**). The demo units are shared by default. Rescuer accounts for a real deployment are created with an invite code: start the relay with `RESCUER_CODE=your-code` and register with that code in the *Rescuer invite code* box.

### What to do, step by step (about 3 minutes)

1. **Sign in** as user 1 / user. The page opens on Asha, red, "SOS pressed on the device". Say: "This is an incident already in progress."
2. **Why this score:** read the reasons top to bottom (SOS, fall, storm, off route, compound pattern). Each has a "Do:" line. "No black box."
3. **Timeline and rules:** scroll to the event timeline. The storm warning came about 15 minutes before the fall. "The twin warned before the accident."
4. **Trends:** show *Sea-level pressure* next to *Station pressure*. Raw pressure falls because she climbed; the corrected line shows only the weather.
5. **Map:** the track leaves the dashed planned route and stops at the red last-known position.
6. **Rescue brief:** press it. Who, where, why, map link, ready for WhatsApp or SMS. "The relay sends this by itself when a unit reaches danger."
7. **Team:** click Trekker 2 and Base camp. Same storm, no incident.
8. **Live hardware:** open **Live node**, then *Connect hardware*. In the ESP32 Serial Monitor type `relay http://HOST:8080` and `key demo-live-node`, then hold BOOT 3 s. The card goes critical within seconds.
   No hardware? `node simulate-device.js http://localhost:8080 demo-live-node --sos`.
9. **The other side:** open a second window, sign in as **rescuer 1** / **rescue**. The board shows Asha red and *NEW · NOT ACKNOWLEDGED*. Press **Acknowledge**, then **Dispatch team** with a note. Back in user 1's window, within 3 seconds, Asha's page shows *TEAM DISPATCHED* and the log. "The loop is closed."
10. **Close** with the rules table and the honest limits.

Device keys: `demo-trekker-1`, `demo-trekker-2`, `demo-base-camp`, `demo-live-node`. The demo account and keys are public by design: use this mode for events, not for real data.

## Architecture

```
 BME280 · MPU-6050 · GPS · MQ-135 · MAX4466
              │
         ESP32 (esp32_gateway/esp32_gateway.ino)
   fall + SOS decided here · LCD · speaker
              │  JSON over GPRS (SIM800L, plain HTTP), queued, stamped with `ago`
              ▼
   relay (server.js) ── twin.js risk engine ── event log ── ALERT_WEBHOOK / Telegram
              │
   dashboard (index.html) ── same twin.js ── rescue brief
```

## The site, and how your hardware updates it

Pages: `/` and `/app` dashboard (`/?demo=1` is the simulated mission) · `/login` · `/s/<id>` read-only share link.

**GitHub Pages (static demo only):** the workflow in `.github/workflows/pages.yml` publishes the dashboard to `https://<your-username>.github.io/omnikit/`. It opens on the **sign-in page** and accepts the two demo accounts, **user 1 / user** (the hiker) and **rescuer 1 / rescue** (the rescue team). With no server, your browser plays the relay: the simulated incident, the rescuer board, acknowledge / dispatch / resolve and the measured-accuracy line all work, and a second tab signed in as the other role sees the response (state is shared through the browser, so sign in as the hiker first, which resets the demo). It has no real accounts and no hardware link, because GitHub cannot run the Node relay. In the repo go to *Settings → Pages → Source: GitHub Actions*, then push to `main`.

**1. Host it** (pick one):
- **Laptop at the venue:** `node server.js`, then `./tunnel.sh` for a public plain-HTTP URL.
- **Render:** push this folder to GitHub, New → Blueprint, pick the repo (`render.yaml` is included, with a 1 GB disk so accounts and history survive restarts). The site gets an `https://` URL.
- **Any Docker host:** `docker build -t omnikit . && docker run -p 8080:8080 -v omnikit:/data omnikit`.

**2. Make a node:** open the site, create an account (the first account is admin), **Add person node**, copy the key.

**3. Point the ESP32 at it.** Flash `esp32_gateway/esp32_gateway.ino` (board *ESP32 Dev Module*, Arduino-ESP32 core 2.x or 3.x; wiring and the two power hazards are in the sketch header). Then in the Serial Monitor (115200, newline):

```
relay https://your-site.onrender.com
id    <device id>
key   <device key>
wifi  MyHotspot MyPassword
sms   +919876543210
```

`id` turns on **signed packets**: the key stays on the board and every packet is signed. Without `id` the old key-in-URL mode is used, which still works until the first signed packet arrives. `sms` adds a number that is texted on SOS or fall (up to three; `sms test` tries it). Lost the board or leaked the key? **Team → Reset device key** issues a new secret and kills the old one.

WiFi is used whenever it is connected (a phone hotspot at the venue is the most reliable demo path, and it works with `https://`). Otherwise the SIM800L takes over, which needs a plain `http://` relay (`relay http://…`, `apn <your apn>`). `sim off` skips the modem. `status` shows what the node is doing. The dashboard's **Connect hardware** panel shows these lines with your real key filled in, and a **Send test packet** button.

**4. No hardware yet?** `node simulate-device.js https://your-site <device key>` backfills a 52-minute trek that ends now, using the firmware's exact packet format. Add `--sos` or `--fall` for a live event, `--live` for a heartbeat every 10 s.

**5.** Set a **planned route** in *Team* to enable the off-route rule. **Connect over USB** on the dashboard also works with the same sketch.

### Alerts

```bash
ALERT_WEBHOOK=https://hooks.example.com/xyz node server.js                         # Slack, Discord, n8n, anything that takes JSON
TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT=-100123456 node server.js                     # Telegram bot
```

Alerts fire on a *new* danger or critical factor, at most one per unit per 20 s. A restart does not re-alert.

### Packet fields

`t h p mq tu mic pitch roll lat lon alt sats bat csq flags ago` and, when signed, `n` and `sig`. All optional, but at least one sensor reading is required. Flags: `1` air · `2` warming up · `4` hot · `8` loud · `16` shake · `32` SOS · `64` fall.

## Honest limits (say these before a judge does)

- **Prototype, decision support.** Not a diagnosis, not a replacement for a map, compass, beacon or trip plan.
- **Fall detection** has not been validated outdoors. Thresholds are first guesses. A dropped unit still looks like a fall, but the 10-second window lets its owner dismiss it. A person who is unconscious cannot cancel, which is the point.
- **Battery percent** is an estimate from the cell voltage curve and sags under load. It needs a 1S Li-ion cell and two 100k resistors on GPIO33 (`BAT_FITTED 0` if not wired).
- **SMS** needs a SIM with SMS credit and 2G coverage. It has not been tested on your board yet.
- **Signed packets** protect against forgery and replay. They do not hide the data: the SIM800L link is still plain HTTP, so the readings can be read in transit.
- **GPS** needs open sky (30–60 s cold start). **SIM800L** is 2G only, plain HTTP, and only works with coverage. It is not satellite. nRF24L01 team relay is **not in this build**.
- **MQ-135** shows that air changed, never which gas. **Microphone** is a relative loudness index.
- **MPU-6050** is used as an accelerometer only (tilt from gravity); the gyro is unused.
- **Share links** show live location to anyone with the link. Use *Reset share link* after the trip.
- Passwords use scrypt, sessions are in memory, login is throttled. The relay speaks plain HTTP so the SIM800L can reach it; put TLS in front for the dashboard in production.

## Before you present — consistency check

The code is the source of truth. These items in the slides and notes disagree with it:

- **GPS pins**: notes say RX32/TX33 and MPU INT on GPIO27. Firmware uses GPS RX **GPIO27**, TX GPIO26, no INT.
- **Slide 5** says the MPU6050 gives "acceleration and gyroscope": the firmware reads acceleration only.
- **nRF24L01** appears in the slides as a link. This build does not use it; say "roadmap".
- **Slide 9** values (30.7405° N, 12.4 °C) are illustrative. Replace them with a screenshot of the dashboard or live data.
- The notes call the speaker "GPIO25 DAC". The sketch drives it with LEDC PWM tone through the LM386. Both reach the same speaker; use the PWM wording.

## Files

| File | Purpose |
|---|---|
| `esp32_gateway/esp32_gateway.ino` | Firmware: sensors, LCD, fall + SOS, SMS, signing, battery, GPRS/WiFi queue |
| `twin.js` | Risk engine, rescue brief, mission simulator (shared by relay and browser) |
| `server.js` | Relay: accounts, ingest, event log, dead-man's switch, alerts |
| `index.html`, `login.html` | Dashboard and sign-in |
| `test.js` | `node test.js` |
| `tunnel.sh` | Public plain-HTTP URL for the relay |
| `dossier/` | React hardware dossier (pinout lab, ADC lab, build tracker). `cd dossier && npm install && npm run dev` |
