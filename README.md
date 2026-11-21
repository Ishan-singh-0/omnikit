# OMNIKIT — Wilderness Survival & Rescue Digital Twin

> **Know where they are, and how they are.**
> A pocket ESP32 node that decides on the device, plus a digital twin that explains *why* someone may be in trouble and tells a responder by itself.

A location dot tells a rescuer *where*. It does not tell them *what happened*. OMNIKIT adds the missing context: impact, stillness, weather, route and the last known state, fused into one risk score that shows its working.

## Why this is more than a tracker

| Idea | What it does | Where it runs |
|---|---|---|
| **Edge-first safety** | Fall detection (impact > 2.2 g, then 15 s of stillness, IMU polled every 40 ms) and a 3-second **SOS** hold. Local alarm, LCD message, flag sent. | On the ESP32. No network needed. |
| **Climb vs storm** | A hiker gaining height sees pressure fall about 1 hPa per 8 m. We correct pressure to sea level with GPS altitude, so only real weather trips the storm rule. | Relay + dashboard |
| **Explainable risk** | Score 0–100 is the sum of named rules with published thresholds (NWS heat index, WMO pressure tendency). Every point has a reason and a suggested action. | `twin.js` |
| **Compound pattern** | Impact + off-route + storm + stillness together raise a *distress pattern*. Each alone is normal; together they are not. | `twin.js` |
| **Dead-man's switch** | The relay flags a unit that goes quiet (5 / 15 min) even if nobody has the dashboard open, and keeps the last known position and conditions. | `server.js` |
| **Store-and-forward honesty** | Packets queue on the device with no signal. Each carries `ago`, so the relay places it at the real time, not the arrival time. | Firmware + relay |
| **Rescue brief, sent automatically** | On danger or critical the relay posts a ready-to-act message (who, where, why, map link) to a webhook or Telegram. | `server.js` |

One engine, one source of truth: `twin.js` is loaded by both the relay and the browser, and `node test.js` replays a whole mission through it.

## Run it in 60 seconds (no hardware)

Needs Node 18+. No dependencies.

```bash
node server.js --demo        # or: npm run demo
```

Open <http://localhost:8080/?demo=1>. You get a **75-minute simulated trek** running through the real risk engine. Scrub the slider or jump to *Pressure falling → Off the trail → Fall → SOS → Radio dead*. Press **Rescue brief** at any moment.

```bash
npm test                      # 9 tests: engine, full mission replay, relay over HTTP, webhook
```

## Demo script (3 minutes, two presenters)

1. **(P1, 20 s) Problem.** "A dot on a map doesn't say if someone is resting or hurt."
2. **(P1, 30 s) Hardware.** Show the node: LCD live values, GPS fix. Hold BOOT 3 s: *SOS SENT*, siren, and the red banner appears on the dashboard within seconds.
3. **(P2, 60 s) The twin.** Open Mission replay. Play at 3×. Point at the **score climbing before the fall**: pressure trend (altitude-corrected), off route, then impact. Click *Why this score*.
4. **(P2, 30 s) The dead zone.** Jump to *Radio dead*. The score stays critical, the map keeps the last known position, the timeline shows *No contact for 7 min*.
5. **(P2, 20 s) Close.** Press **Rescue brief** → WhatsApp/SMS-ready text. "The relay sends this on its own when a unit hits danger."
6. **(Both, 20 s) Honesty.** Show the *rules* table: every threshold, who decides it, and the limits below.

Judge questions are answered in the quick-notes PDF. Add these two:
- *"Where is the AI?"* Rule-based fusion on purpose: it is explainable and testable offline. The next step is learning each person's normal pace from history; the twin already stores it.
- *"Does a climb look like a storm?"* No. Show the **Sea-level pressure** chart next to the **raw pressure** chart in Trends.

## Architecture

```
 BME280 · MPU-6050 · GPS · MQ-135 · MAX4466
              │
         ESP32 (esp32_gateway.ino)
   fall + SOS decided here · LCD · speaker
              │  JSON over GPRS (SIM800L, plain HTTP), queued, stamped with `ago`
              ▼
   relay (server.js) ── twin.js risk engine ── event log ── ALERT_WEBHOOK / Telegram
              │
   dashboard (index.html) ── same twin.js ── rescue brief
```

## The site, and how your hardware updates it

Pages: `/` landing page · `/app` dashboard (`/app?demo=1` is the simulated mission) · `/login` · `/s/<id>` read-only share link.

**1. Host it** (pick one):
- **Laptop at the venue:** `node server.js`, then `./tunnel.sh` for a public plain-HTTP URL.
- **Render:** push this folder to GitHub, New → Blueprint, pick the repo (`render.yaml` is included, with a 1 GB disk so accounts and history survive restarts). The site gets an `https://` URL.
- **Any Docker host:** `docker build -t omnikit . && docker run -p 8080:8080 -v omnikit:/data omnikit`.

**2. Make a node:** open the site, create an account (the first account is admin), **Add person node**, copy the key.

**3. Point the ESP32 at it.** Flash `esp32_gateway.ino` (board *ESP32 Dev Module*, Arduino-ESP32 core 2.x or 3.x; wiring and the two power hazards are in the sketch header). Then in the Serial Monitor (115200, newline):

```
relay https://your-site.onrender.com
key   <device key>
wifi  MyHotspot MyPassword
```

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

`t h p mq tu mic pitch roll lat lon alt sats csq flags ago`. All optional, but at least one sensor reading is required. Flags: `1` air · `2` warming up · `4` hot · `8` loud · `16` shake · `32` SOS · `64` fall.

## Honest limits (say these before a judge does)

- **Prototype, decision support.** Not a diagnosis, not a replacement for a map, compass, beacon or trip plan.
- **Fall detection** has not been validated outdoors. Thresholds are first guesses. A unit dropped on a table looks like a fall.
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
- **Slide 9** values (30.7405° N, 12.4 °C) are illustrative. Replace them with a screenshot of the Mission replay or live data.
- The notes call the speaker "GPIO25 DAC". The sketch drives it with LEDC PWM tone through the LM386. Both reach the same speaker; use the PWM wording.

## Files

| File | Purpose |
|---|---|
| `esp32_gateway.ino` | Firmware: sensors, LCD, fall + SOS, GPRS queue |
| `twin.js` | Risk engine, rescue brief, mission simulator (shared by relay and browser) |
| `server.js` | Relay: accounts, ingest, event log, dead-man's switch, alerts |
| `index.html`, `login.html` | Dashboard and sign-in |
| `test.js` | `node test.js` |
| `tunnel.sh` | Public plain-HTTP URL for the relay |
| `dossier/` | React hardware dossier (pinout lab, ADC lab, build tracker). `cd dossier && npm install && npm run dev` |
