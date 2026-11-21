/* =====================================================================
   OMNIKIT — single-board ESP32 survival node (Arduino)

   One ESP32 does everything: senses, decides locally (fall, SOS, hazards), warns out loud,
   and reports over GPRS. No second MCU. (The nRF24L01 team link is on the roadmap, not in this build.)
     BME280 (I2C 0x76)        temperature / humidity / pressure
     MQ-135  (GPIO34)         air response in volts (5 V sensor, divider)
     MAX4466 (GPIO35)         loudness index from the mic's RMS
     MPU-6050 (I2C 0x68)      pitch, roll, shake
     GPS6MV2 / NEO-6M (RX 27) latitude, longitude, satellites
     JHD162A on HW-061 (0x27) 16x2 status display
     LM386 + 8 ohm speaker (GPIO25)  tones, alerts
     SIM800L (UART1)          posts JSON to the relay over GPRS
     Alert LED (GPIO2), BOOT button (GPIO0)

   WIRING
     I2C  SDA 21 / SCL 22 -> JHD162A via HW-061 (0x27 or 0x3F),
                             BME280 (0x76 or 0x77), MPU-6050 (0x68)
     MQ-135 AO  -> 10k series / 20k to GND -> GPIO34   (module Vout / 1.5)
     MAX4466 OUT-> GPIO35            (power the module from 3V3, gain pot low)
     LM386 IN   -> 10k + 0.1 uF from GPIO25, speaker 8 ohm on the LM386 out
     GPS TXD    -> GPIO27 (ESP32 RX2). GPS RXD stays open.
     SIM800L TXD-> GPIO16 (ESP32 RX1)
     SIM800L RXD-> GPIO17 via divider (1k series, 2k to GND)
     SIM800L VCC-> separate 4.0 V / 2 A supply + 1000 uF. Common GND.
     Alert LED  -> GPIO2 through 330 ohm (onboard LED on most dev boards)
     BOOT button-> GPIO0 (built in, active low)

   TWO HAZARDS WORTH CHECKING BEFORE POWER-ON
     * SIM800L VCC must never come from the ESP32 3V3 pin or USB 5 V: it draws
       2 A spikes and will brown out the board. 1000 uF at the module pins.
     * HW-061 LCD backpack: it is happiest on 5 V, and many boards pull SDA/SCL up
       to that 5 V. ESP32 pins are NOT 5 V tolerant. Either remove the two I2C
       pull-up resistors on the backpack (the BME280 / MPU-6050 breakouts already
       pull the bus up to 3.3 V), or use a level shifter.

   BUTTON (BOOT, GPIO0)
     short press  -> next LCD view (7 views)
     hold 1.2 s   -> mute / unmute the speaker alerts (acts on release)
     hold 3 s     -> SOS on / off. Sends at once, sets flag 32, sounds the speaker. Hold again to cancel.

   ON-DEVICE FALL DETECTION (works with no network)
     The MPU-6050 is read every 40 ms. An impact above FALL_IMPACT_G followed by FALL_STILL_MS
     without movement raises flag 64 and the alarm. Moving again clears it. A unit simply
     dropped on a table looks the same, which is the known false-alarm case.

   NO RE-FLASH NEEDED TO CHANGE THE RELAY
     Open the Serial Monitor (115200, newline) and type:
         relay https://your-site.example.com   (https works over WiFi only; the SIM needs http://)
         key   YOUR_DEVICE_KEY
         wifi  MyHotspot MyPassword            (fastest: a phone hotspot at the venue)
         wifi  off
         sim   off                             (WiFi only: skips the SIM800L bring-up)
         apn   airtelgprs.com
         status
     WiFi is used whenever it is connected; otherwise the SIM800L takes over.
     Values are stored in flash and survive reboot.

   FLASHING
     1. Board: "ESP32 Dev Module", Arduino-ESP32 core 2.x or 3.x, 115200 baud.
     2. Set APN_DEFAULT / RELAY_DEFAULT / DEV_KEY_DEFAULT below, or use the serial
        commands above after the first flash.
     3. Create a device on the relay site and copy its key.
     4. RELAY must be plain http:// — the SIM800L has no usable TLS.
     5. No SIM handy? The board still prints one JSON line per cycle on USB, so
        the dashboard's "Connect over USB" works on its own.
     6. The SIM must work on 2G (GSM). 4G-only SIMs will never register.

   JSON SENT (POST /ingest?key=DEV_KEY), every field optional, absent = not measured
     {"mq":1.400,"mic":62.0,"t":27.4,"h":51.2,"p":1004.5,"pitch":-4.0,"roll":7.0,
      "lat":28.6134,"lon":77.2090,"alt":212.4,"sats":8,"flags":0,"csq":17,"ago":0}
     flags: 1 = MQ-135 over threshold, 2 = MQ-135 still warming up (alerts held),
            4 = hot, 8 = loud, 16 = shake, 32 = SOS, 64 = fall suspected.
     alt = GPS altitude in metres. The relay needs it to tell a climb from a falling barometer.
     ago = seconds since the sample was taken. Packets wait in a queue while there is no signal,
           and ago lets the relay place them at the right time when they finally get through.
   ===================================================================== */

#include <Wire.h>
#include <HardwareSerial.h>
#include <Preferences.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <stdarg.h>
#include <math.h>

// ---------------------------- configure -------------------------------
static const char* APN_DEFAULT     = "airtelgprs.com";            // your SIM's APN
static const char* RELAY_DEFAULT   = "http://YOUR.HOST.OR.IP:8080";
static const char* DEV_KEY_DEFAULT = "PASTE_DEVICE_KEY_HERE";

#define USE_GPS      1           // 0 = no GPS6MV2 attached
#define SAMPLE_MS    2000        // read sensors, refresh LCD, print USB JSON
#define UPLOAD_MS    10000       // one GPRS post per this many ms (a post takes 3-8 s)
#define MQ_WARMUP_MS 60000UL     // MQ-135 alerts are held this long after power-on
#define ALERT_REPEAT 30000UL     // repeat the beep at most this often while an alert stays on
#define SDA_PIN      21
#define SCL_PIN      22
#define MQ_PIN       34
#define MIC_PIN      35
#define SPK_PIN      25
#define LED_PIN      2
#define BTN_PIN      0
#define SIM_RX_PIN   16
#define SIM_TX_PIN   17
#define GPS_RX_PIN   27
#define GPS_TX_PIN   26
#define LCD_ADDR     0x27        // HW-061 backpack; 0x3F on some boards
#define BME_ADDR     0x76        // 0x77 if SDO is high
#define MPU_ADDR     0x68        // AD0 low
#define DIVIDER      1.5f        // 10k top / 20k bottom
#define TEMP_ALERT   38.0f       // C
#define MQ_ALERT     2.20f       // V at the module output
#define DB_ALERT     78.0f       // relative loudness index
#define SHAKE_G      0.45f       // g deviation that counts as motion
#define FALL_IMPACT_G 2.2f       // total acceleration that counts as an impact
#define MOVE_G       0.12f       // g deviation that counts as "they are moving"
#define FALL_STILL_MS 15000UL    // no movement for this long after an impact = suspected fall
#define SOS_HOLD_MS  3000UL      // hold BOOT this long to send an SOS
#define VIEWS        7
// ---------------------------------------------------------------------

HardwareSerial sim(1);
HardwareSerial gps(2);
Preferences prefs;

static char apn[40], relay[96], devKey[48];
static char wifiSsid[40], wifiPass[64];       // WiFi is the fast path; the SIM800L is the fallback in the field
static bool simOn = true;
static bool wifiUp() { return wifiSsid[0] && WiFi.status() == WL_CONNECTED; }
static char line[192];
static char url[200];

// ------------------------------ I2C helpers ----------------------------
static bool i2cPresent(uint8_t a) {
  Wire.beginTransmission(a);
  return Wire.endTransmission() == 0;
}

static bool regRead(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, (int)n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool regWrite(uint8_t addr, uint8_t reg, uint8_t v) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

// --------------------------- LCD on HW-061 ----------------------------
// The HW-061 is a PCF8574 backpack: 4-bit parallel into the JHD162A.
// Bits: P0 RS, P1 RW, P2 EN, P3 backlight, P4-P7 D4-D7.
struct Lcd {
  uint8_t addr = LCD_ADDR;
  bool ok = false;

  void wr(uint8_t v) { Wire.beginTransmission(addr); Wire.write(v); Wire.endTransmission(); }

  void nyb(uint8_t b, uint8_t rs) {
    uint8_t v = (uint8_t)((b & 0xF0) | 0x08 | (rs ? 0x01 : 0x00));   // backlight on
    wr(v | 0x04); delayMicroseconds(40);      // EN high
    wr(v);        delayMicroseconds(40);      // EN low
  }

  void send(uint8_t b, uint8_t rs) { nyb(b & 0xF0, rs); nyb((uint8_t)(b << 4), rs); }
  void cmd(uint8_t c) { send(c, 0); }
  void data(uint8_t c) { send(c, 1); }

  bool begin() {
    if (!i2cPresent(addr) && addr == 0x27 && i2cPresent(0x3F)) addr = 0x3F;   // auto-find the other usual address
    if (!i2cPresent(addr)) { ok = false; return false; }
    ok = true;
    delay(60);
    for (int i = 0; i < 3; i++) { nyb(0x30, 0); delay(5); }
    nyb(0x20, 0); delay(2);
    cmd(0x28);            // 4-bit, 2 lines, 5x8
    cmd(0x0C);            // display on, cursor off
    cmd(0x06);            // entry mode
    cmd(0x01); delay(2);  // clear
    return true;
  }

  void row(uint8_t r, const char* s) {
    if (!ok) return;
    cmd((uint8_t)(0x80 | (r ? 0x40 : 0x00)));
    char buf[17];
    snprintf(buf, sizeof buf, "%-16.16s", s ? s : "");
    for (uint8_t i = 0; i < 16; i++) data((uint8_t)buf[i]);
  }
};

static Lcd lcd;

// ---------------------------- BME280 ----------------------------------
// Bosch datasheet double-precision compensation. Also accepts a BMP280
// (chip id 0x58): many cheap "BME280" boards are really BMP280 and have no
// humidity sensor, in which case humidity is simply not reported.
struct Bme {
  uint8_t addr = BME_ADDR;
  bool ok = false, hasHum = false;
  uint16_t T1, P1;
  int16_t  T2, T3, P2, P3, P4, P5, P6, P7, P8, P9;
  uint8_t  H1, H3;
  int16_t  H2, H4, H5, H6;

  static uint16_t u16(const uint8_t* d, int i) { return (uint16_t)(d[i] | (d[i + 1] << 8)); }
  static int16_t  s16(const uint8_t* d, int i) { return (int16_t)u16(d, i); }

  bool begin(uint8_t a) {
    addr = a; ok = false;
    if (!i2cPresent(a)) return false;
    uint8_t id;
    if (!regRead(a, 0xD0, &id, 1)) return false;
    if (id != 0x60 && id != 0x58 && id != 0x56 && id != 0x57) return false;
    hasHum = (id == 0x60);

    uint8_t d[24];
    if (!regRead(a, 0x88, d, 24)) return false;
    T1 = u16(d, 0);  T2 = s16(d, 2);  T3 = s16(d, 4);
    P1 = u16(d, 6);  P2 = s16(d, 8);  P3 = s16(d, 10);
    P4 = s16(d, 12); P5 = s16(d, 14); P6 = s16(d, 16);
    P7 = s16(d, 18); P8 = s16(d, 20); P9 = s16(d, 22);

    if (hasHum) {
      uint8_t e[7], h1;
      if (!regRead(a, 0xA1, &h1, 1) || !regRead(a, 0xE1, e, 7)) return false;
      H1 = h1;
      H2 = s16(e, 0);
      H3 = e[2];
      // E4 and E6 are signed bytes; the 12-bit values share the nibbles of E5.
      H4 = (int16_t)((int16_t)(int8_t)e[3] * 16 + (e[4] & 0x0F));
      H5 = (int16_t)((int16_t)(int8_t)e[5] * 16 + (e[4] >> 4));
      H6 = (int16_t)(int8_t)e[6];
      regWrite(a, 0xF2, 0x01);   // humidity x1 (must be written before F4)
    }
    regWrite(a, 0xF5, 0xA0);     // 1000 ms standby
    regWrite(a, 0xF4, 0x27);     // T x1 P x1, normal mode
    ok = true;
    return true;
  }

  bool read(float& t, float& h, float& p, bool& gotHum) {
    uint8_t d[8];
    if (!regRead(addr, 0xF7, d, 8)) { ok = false; return false; }
    double adcP = (double)(((uint32_t)d[0] << 12) | ((uint32_t)d[1] << 4) | (d[2] >> 4));
    double adcT = (double)(((uint32_t)d[3] << 12) | ((uint32_t)d[4] << 4) | (d[5] >> 4));
    double adcH = (double)(((uint32_t)d[6] << 8) | d[7]);
    if (adcT == 524288.0) return false;            // 0x80000: first conversion not finished yet

    double v1 = (adcT / 16384.0 - T1 / 1024.0) * T2;
    double v2 = (adcT / 131072.0 - T1 / 8192.0) * (adcT / 131072.0 - T1 / 8192.0) * T3;
    double tf = v1 + v2;
    t = (float)(tf / 5120.0);

    double p1 = tf / 2.0 - 64000.0;
    double p2 = p1 * p1 * P6 / 32768.0 + p1 * P5 * 2.0;
    p2 = p2 / 4.0 + P4 * 65536.0;
    p1 = (P3 * p1 * p1 / 524288.0 + P2 * p1) / 524288.0;
    p1 = (1.0 + p1 / 32768.0) * P1;
    if (p1 == 0) {
      p = 0;
    } else {
      double pr = 1048576.0 - adcP;
      pr = (pr - p2 / 4096.0) * 6250.0 / p1;
      p1 = P9 * pr * pr / 2147483648.0;
      p2 = pr * P8 / 32768.0;
      p = (float)((pr + (p1 + p2 + P7) / 16.0) / 100.0);
    }

    gotHum = hasHum && adcH != 32768.0;            // 0x8000 = humidity not measured
    if (gotHum) {
      double hh = tf - 76800.0;
      hh = (adcH - (H4 * 64.0 + H5 / 16384.0 * hh)) *
           (H2 / 65536.0 * (1.0 + H6 / 67108864.0 * hh * (1.0 + H3 / 67108864.0 * hh)));
      hh = hh * (1.0 - H1 * hh / 524288.0);
      h = (float)(hh < 0 ? 0 : (hh > 100 ? 100 : hh));
    }
    return true;
  }
};

static Bme bme;

// --------------------------- MPU-6050 ---------------------------------
struct Mpu {
  uint8_t addr = MPU_ADDR;
  bool ok = false;

  bool begin(uint8_t a) {
    addr = a;
    if (!i2cPresent(a)) { ok = false; return false; }
    ok = regWrite(a, 0x6B, 0x00) && regWrite(a, 0x1C, 0x00) && regWrite(a, 0x1A, 0x03);
    return ok;
  }

  bool read(float& pitch, float& roll, float& mag) {
    uint8_t d[6];
    if (!regRead(addr, 0x3B, d, 6)) { ok = false; return false; }
    float ax = (int16_t)((d[0] << 8) | d[1]) / 16384.0f;
    float ay = (int16_t)((d[2] << 8) | d[3]) / 16384.0f;
    float az = (int16_t)((d[4] << 8) | d[5]) / 16384.0f;
    pitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * 57.29578f;
    roll  = atan2f(ay, az) * 57.29578f;
    mag   = sqrtf(ax * ax + ay * ay + az * az);
    return true;
  }
};

static Mpu mpu;

// --------------------- speaker on the LM386 (LEDC) --------------------
// Works on Arduino-ESP32 core 2.x and 3.x.
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  static void spkBegin() { ledcAttach(SPK_PIN, 2000, 8); ledcWriteTone(SPK_PIN, 0); }
  static void spkRaw(uint32_t f) { ledcWriteTone(SPK_PIN, f); }
#else
  #define SPK_CH 0
  static void spkBegin() { ledcSetup(SPK_CH, 2000, 8); ledcAttachPin(SPK_PIN, SPK_CH); ledcWrite(SPK_CH, 0); }
  static void spkRaw(uint32_t f) { if (f) ledcWriteTone(SPK_CH, f); else ledcWrite(SPK_CH, 0); }
#endif

static void spkTone(uint16_t freq, uint16_t ms) { spkRaw(freq); delay(ms); spkRaw(0); }
static void spkChirp() { spkTone(1200, 40); spkTone(1800, 40); }
static void spkAlert() { for (int i = 0; i < 3; i++) { spkTone(2200, 120); delay(70); } }

// ------------------------------- GPS -----------------------------------
#if USE_GPS
static double gpsLat = 0, gpsLon = 0, gpsAlt = 0;
static bool   gpsHasAlt = false;
static int    gpsSats = 0;
static bool   gpsFix = false;
static uint32_t gpsSeen = 0;

static double nmeaToDeg(const char* v, char hemi) {
  if (!v || !*v) return 0;
  double raw = atof(v);
  int deg = (int)(raw / 100.0);
  double min = raw - deg * 100.0;
  double out = deg + min / 60.0;
  if (hemi == 'S' || hemi == 'W') out = -out;
  return out;
}

static void parseNmea(char* s) {
  if (s[0] != '$') return;
  if (!(strncmp(s, "$GPGGA", 6) == 0 || strncmp(s, "$GNGGA", 6) == 0)) return;

  char* f[16] = {0};
  int n = 0;
  f[n++] = s;
  for (char* p = s; *p && n < 16; p++) {
    if (*p == ',' || *p == '*') {
      const bool cks = (*p == '*');
      *p = 0;
      f[n++] = p + 1;
      if (cks) break;
    }
  }
  if (n < 12) return;

  const int quality = atoi(f[6]);
  gpsSats = atoi(f[7]);
  if (quality > 0 && f[2][0] && f[4][0]) {
    gpsLat = nmeaToDeg(f[2], f[3][0]);
    gpsLon = nmeaToDeg(f[4], f[5][0]);
    gpsHasAlt = f[9][0] != 0;
    if (gpsHasAlt) gpsAlt = atof(f[9]);        // metres above mean sea level
    gpsFix = true;
    gpsSeen = millis();
  }
}

static void pollGps() {
  static char buf[110];
  static size_t n = 0;
  while (gps.available()) {
    char c = gps.read();
    if (c == '\n' || c == '\r') {
      if (n > 6) { buf[n] = 0; parseNmea(buf); }
      n = 0;
    } else if (c == '$') {
      n = 0; buf[n++] = c;
    } else if (n < sizeof(buf) - 1) {
      buf[n++] = c;
    }
  }
  if (gpsFix && (millis() - gpsSeen) > 10000) gpsFix = false;
}
#endif

// ------------------------------ sensors --------------------------------
static float volts(uint8_t pin, uint8_t n = 8) {
  uint32_t total = 0;
  for (uint8_t i = 0; i < n; i++) total += analogReadMilliVolts(pin);
  return (total / (float)n) / 1000.0f * DIVIDER;
}

// MAX4466 sits at VCC/2; only the AC swing matters, so use the RMS of the samples.
// This is a RELATIVE loudness index (30..110), not calibrated dB SPL.
static float micDb() {
  double sum = 0, sumsq = 0;
  const int N = 48;
  for (int i = 0; i < N; i++) {
    float v = analogRead(MIC_PIN) * 3.3f / 4095.0f;
    sum += v; sumsq += (double)v * v;
    delayMicroseconds(250);
  }
  const double mean = sum / N;
  double var = sumsq / N - mean * mean;
  if (var < 0) var = 0;
  const double rms = sqrt(var);
  if (rms < 0.0002) return 30.0f;
  const double db = 20.0 * log10(rms / 0.0002) + 30.0;
  return (float)(db < 30 ? 30 : (db > 110 ? 110 : db));
}

// ------------------------------ readings cache -------------------------
struct Reading {
  bool have = false, hasT = false, hasH = false, hasP = false, hasMpu = false;
  float t = 0, h = 0, p = 0, mq = 0, db = 0, pitch = 0, roll = 0;
  bool shake = false, warm = false;
  uint8_t flags = 0;
};
static Reading R;
static char lastBody[232];
static bool haveBody = false;

static int csq = -1;
static bool online = false, muted = false;
static uint8_t view = 0;
static uint32_t lastSample = 0;
static uint32_t lastUp = 0;
static bool sos = false;                       // latched until the user holds BOOT again

// ------------------------------ upload queue ---------------------------
// Each packet remembers when it was taken, so the relay can place it correctly
// even if it waits minutes for signal ("ago" in the JSON).
struct Item { char body[232]; uint32_t at; };
static Item q[16];
static int qHead = 0, qCount = 0;

static bool qPush(const char* body) {
  if (strlen(body) >= sizeof(q[0].body)) return false;
  if (qCount == 16) { qHead = (qHead + 1) % 16; qCount--; }   // drop oldest
  Item& it = q[(qHead + qCount) % 16];
  strcpy(it.body, body);
  it.at = millis();
  qCount++;
  return true;
}
static void qPop() { if (qCount) { qHead = (qHead + 1) % 16; qCount--; } }
static const Item& qFront() { return q[qHead]; }

// ------------------------- fast motion watcher -------------------------
// The IMU is polled every 40 ms, not once per 2 s sample: an impact lasts a few
// milliseconds and would otherwise be missed. Impact + stillness = suspected fall,
// decided here on the device so it works with no signal at all.
static float peakDev = 0;                      // largest |g - 1| since the last sample()
static uint32_t impactAt = 0, lastMoveAt = 0;
static bool fall = false;

static void pollMotion() {
  static uint32_t next = 0;
  if (!mpu.ok || (int32_t)(millis() - next) < 0) return;
  next = millis() + 40;
  float tiltP, tiltR, mag;
  if (!mpu.read(tiltP, tiltR, mag)) return;
  const uint32_t now = millis();
  const float dev = fabsf(mag - 1.0f);
  if (dev > peakDev) peakDev = dev;
  if (mag > FALL_IMPACT_G) { impactAt = now ? now : 1; lastMoveAt = now; }
  else if (dev > MOVE_G) {
    lastMoveAt = now;
    if (impactAt && now - impactAt > 3000) { impactAt = 0; fall = false; }    // moving again: they got up
  }
  if (impactAt && !fall && now - impactAt > FALL_STILL_MS && now - lastMoveAt > FALL_STILL_MS) fall = true;
}

// ------------------------------ display --------------------------------
static void lcdShow() {
  char a[17], b[17];
  switch (view) {
    case 0:
      if (R.hasT) {
        if (R.hasH) snprintf(a, sizeof a, "T%.1fC H%.0f%%", R.t, R.h);
        else        snprintf(a, sizeof a, "T%.1fC H --", R.t);
        snprintf(b, sizeof b, "P%.0fhPa %s", R.p, R.t > TEMP_ALERT ? "HOT" : "OK");
      } else {
        snprintf(a, sizeof a, bme.ok ? "BME280 WARMING" : "BME280 MISSING");
        snprintf(b, sizeof b, bme.ok ? "first read..." : "CHECK 0x76/0x77");
      }
      break;
    case 1:
      snprintf(a, sizeof a, "MQ135 %.2fV", R.mq);
      if (R.warm) snprintf(b, sizeof b, "WARMING UP...");
      else        snprintf(b, sizeof b, "AIR %s", R.mq > MQ_ALERT ? "ELEVATED" : "NOMINAL");
      break;
    case 2:
      snprintf(a, sizeof a, "MIC IDX %.0f", R.db);
      snprintf(b, sizeof b, "SND %s", R.db > DB_ALERT ? "LOUD" : "NORMAL");
      break;
    case 3:
      if (R.hasMpu) {
        snprintf(a, sizeof a, "PIT%+.0f ROL%+.0f", R.pitch, R.roll);
        snprintf(b, sizeof b, "MOT %s", R.shake ? "SHAKE" : "STILL");
      } else {
        snprintf(a, sizeof a, "MPU-6050 MISSING");
        snprintf(b, sizeof b, "CHECK 0x68");
      }
      break;
    case 4:
#if USE_GPS
      snprintf(a, sizeof a, "SATS %d %s", gpsSats, gpsFix ? "FIX" : "SEARCH");
      if (gpsFix) snprintf(b, sizeof b, "%.4f %.4f", gpsLat, gpsLon);
      else        snprintf(b, sizeof b, "no fix yet");
#else
      snprintf(a, sizeof a, "GPS DISABLED");
      snprintf(b, sizeof b, "USE_GPS 0");
#endif
      break;
    case 5:
      if (wifiUp()) {
        snprintf(a, sizeof a, "WIFI %.11s", wifiSsid);
        snprintf(b, sizeof b, "ONLINE Q:%d", qCount);
      } else {
        snprintf(a, sizeof a, "SIM CSQ %d", csq);
        snprintf(b, sizeof b, "%s Q:%d", online ? "ONLINE" : "OFFLINE", qCount);
      }
      break;
    default:
      snprintf(a, sizeof a, "I2C %s%s%s",
               lcd.ok ? "LCD " : "", bme.ok ? "BME " : "", mpu.ok ? "MPU" : "");
      snprintf(b, sizeof b, "%s%s", (R.flags & 0x20) ? "SOS SENT" : (R.flags & 0x40) ? "FALL SUSPECTED" : (R.flags & ~0x02) ? "ALERT YES" : "ALERT NONE", muted ? " MUTE" : "");
      break;
  }
  lcd.row(0, a);
  lcd.row(1, b);
}

// ------------------------------ AT layer -------------------------------
static void idleWork();   // keeps GPS parsed and LCD/USB alive while we wait on the modem

static void flushSim() { while (sim.available()) sim.read(); }

static bool waitFor(const char* want, uint32_t ms) {
  uint32_t t0 = millis(); size_t n = 0;
  line[0] = 0;
  while (millis() - t0 < ms) {
    while (sim.available()) {
      char c = sim.read();
      if (c == '\r') continue;
      if (c == '\n') {
        line[n] = 0;
        if (strstr(line, want)) return true;
        if (strstr(line, "ERROR") && !strstr(want, "ERROR")) return false;   // fail fast
        n = 0; line[0] = 0;
        continue;
      }
      if (n < sizeof(line) - 1) line[n++] = c;
    }
    idleWork();
    delay(1); yield();
  }
  return false;
}

static bool at(const char* cmd, const char* want = "OK", uint32_t ms = 3000) {
  flushSim();
  sim.println(cmd);
  return waitFor(want, ms);
}

// ------------------------------ SIM800L --------------------------------
static void readCsq() {
  for (int i = 0; i < 2; i++) {
    if (at("AT+CSQ", "+CSQ:", 2000)) {
      const char* c = strchr(line, ':');
      if (c) { int v = atoi(c + 1); csq = (v >= 0 && v < 99) ? v : -1; }
      return;
    }
  }
}

static void buildUrl() {
  size_t n = strlen(relay);
  while (n && relay[n - 1] == '/') relay[--n] = 0;
  snprintf(url, sizeof url, "%s/ingest?key=%s", relay, devKey);
}

static bool httpInit() {
  at("AT+HTTPTERM", "OK", 2000);
  if (!at("AT+HTTPINIT", "OK", 5000)) return false;
  if (!at("AT+HTTPPARA=\"CID\",1", "OK", 5000)) return false;
  char cmd[260];
  snprintf(cmd, sizeof cmd, "AT+HTTPPARA=\"URL\",\"%s\"", url);
  if (!at(cmd, "OK", 5000)) return false;
  return at("AT+HTTPPARA=\"CONTENT\",\"application/json\"", "OK", 5000);
}

static bool gprsUp() {
  flushSim();
  if (!at("AT", "OK", 3000)) { Serial.println("SIM: no answer to AT (power, wiring, baud)"); return false; }
  at("ATE0", "OK", 2000);
  at("AT+CMEE=0", "OK", 2000);
  if (!at("AT+CPIN?", "READY", 3000)) { Serial.println("SIM: card not READY (missing, or PIN-locked)"); return false; }

  bool reg = false;
  for (int i = 0; i < 30 && !reg; i++) {
    reg = at("AT+CREG?", "0,1", 2000) || at("AT+CREG?", "0,5", 2000);
    if (!reg) delay(1000);
  }
  if (!reg) { Serial.println("SIM: not registered on the network (2G coverage? antenna?)"); return false; }

  at("AT+CGATT=1", "OK", 10000);
  at("AT+SAPBR=0,1", "OK", 5000);               // close a bearer left open by a previous run; ERROR is fine
  at("AT+SAPBR=3,1,\"Contype\",\"GPRS\"", "OK", 5000);
  char cmd[100];
  snprintf(cmd, sizeof cmd, "AT+SAPBR=3,1,\"APN\",\"%s\"", apn);
  if (!at(cmd, "OK", 5000)) return false;
  if (!at("AT+SAPBR=1,1", "OK", 30000)) { Serial.println("SIM: GPRS bearer failed (wrong APN? no data plan?)"); return false; }
  readCsq();
  if (!httpInit()) { Serial.println("SIM: HTTP init failed"); return false; }
  Serial.printf("SIM: online, CSQ %d\n", csq);
  return true;
}

static void gprsDown() { at("AT+HTTPTERM", "OK", 3000); at("AT+SAPBR=0,1", "OK", 10000); }

// Stamp the packet's age at the moment it really leaves: {...} -> {...,"ago":N}
static bool stampBody(const Item& it, char* out, size_t cap) {
  const size_t bl = strlen(it.body);
  if (bl < 2 || bl + 16 >= cap) return false;
  memcpy(out, it.body, bl - 1);
  snprintf(out + bl - 1, cap - bl + 1, ",\"ago\":%lu}", (unsigned long)((millis() - it.at) / 1000UL));
  return true;
}

// WiFi path: plain http:// or https:// (https skips certificate checks: fine for a demo, not for secrets).
static bool wifiPost(const Item& it) {
  static char out[260];
  if (!stampBody(it, out, sizeof out)) return true;       // malformed: drop it rather than retry forever
  HTTPClient http;
  WiFiClientSecure sec;
  WiFiClient plain;
  const bool tls = !strncmp(url, "https://", 8);
  if (tls) { sec.setInsecure(); if (!http.begin(sec, url)) return false; }
  else if (!http.begin(plain, url)) return false;
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  const int code = http.POST((uint8_t*)out, strlen(out));
  http.end();
  if (code != 200) Serial.printf("WiFi POST failed, HTTP %d (401 = wrong key, 400 = bad packet, negative = cannot reach the relay)\n", code);
  return code == 200;
}

static bool httpPost(const Item& it) {
  static char out[260];
  if (!stampBody(it, out, sizeof out)) return true;       // malformed: drop it rather than retry forever
  const char* body = out;
  char cmd[64];
  snprintf(cmd, sizeof cmd, "AT+HTTPDATA=%u,20000", (unsigned)strlen(body));
  flushSim();
  sim.println(cmd);
  if (!waitFor("DOWNLOAD", 5000)) return false;
  sim.print(body);
  if (!waitFor("OK", 20000)) return false;

  flushSim();
  sim.println("AT+HTTPACTION=1");
  if (!waitFor("+HTTPACTION:", 45000)) return false;
  const char* c = strchr(line, ',');
  const int status = c ? atoi(c + 1) : -1;
  if (status != 200) Serial.printf("POST failed, HTTP %d (601/603 = network, 401 = wrong key, 400 = bad packet)\n", status);
  return status == 200;
}

// ------------------------------ config ---------------------------------
static void loadCfg() {
  prefs.begin("omnikit", true);
  String a = prefs.getString("apn", APN_DEFAULT);
  String r = prefs.getString("relay", RELAY_DEFAULT);
  String k = prefs.getString("key", DEV_KEY_DEFAULT);
  String ws = prefs.getString("ssid", "");
  String wp = prefs.getString("wpass", "");
  simOn = prefs.getString("sim", "on") != "off";
  prefs.end();
  strlcpy(wifiSsid, ws.c_str(), sizeof wifiSsid);
  strlcpy(wifiPass, wp.c_str(), sizeof wifiPass);
  strlcpy(apn, a.c_str(), sizeof apn);
  strlcpy(relay, r.c_str(), sizeof relay);
  strlcpy(devKey, k.c_str(), sizeof devKey);
  buildUrl();
}

static void saveCfg(const char* k, const char* v) {
  prefs.begin("omnikit", false);
  prefs.putString(k, v);
  prefs.end();
}

static void handleCmd(char* s) {
  while (*s == ' ') s++;
  size_t n = strlen(s);
  while (n && (s[n - 1] == ' ' || s[n - 1] == '\r')) s[--n] = 0;
  if (!n) return;

  if (!strncmp(s, "relay ", 6)) {
    char* v = s + 6; while (*v == ' ') v++;
    if (strncmp(v, "http://", 7) && strncmp(v, "https://", 8)) { Serial.println("relay must start with http:// or https://"); return; }
    strlcpy(relay, v, sizeof relay); saveCfg("relay", relay); buildUrl(); online = false;
    Serial.printf("relay saved: %s\n", relay);
    if (!strncmp(relay, "https://", 8)) Serial.println("note: https works over WiFi only. The SIM800L needs a plain http:// relay.");
  } else if (!strncmp(s, "wifi ", 5)) {
    char* v = s + 5; while (*v == ' ') v++;
    if (!strcmp(v, "off")) {
      wifiSsid[0] = 0; wifiPass[0] = 0; saveCfg("ssid", ""); saveCfg("wpass", ""); WiFi.disconnect(true);
      Serial.println("wifi off");
    } else {
      char* sp = strchr(v, ' ');
      if (sp) { *sp = 0; sp++; while (*sp == ' ') sp++; }
      strlcpy(wifiSsid, v, sizeof wifiSsid); strlcpy(wifiPass, sp ? sp : "", sizeof wifiPass);
      saveCfg("ssid", wifiSsid); saveCfg("wpass", wifiPass);
      WiFi.mode(WIFI_STA); WiFi.disconnect(); WiFi.begin(wifiSsid, wifiPass);
      Serial.printf("wifi saved: %s (connecting; SSID without spaces, add the password after it)\n", wifiSsid);
    }
  } else if (!strncmp(s, "sim ", 4)) {
    simOn = strcmp(s + 4, "off") != 0; saveCfg("sim", simOn ? "on" : "off");
    Serial.printf("sim %s\n", simOn ? "on" : "off");
  } else if (!strncmp(s, "key ", 4)) {
    char* v = s + 4; while (*v == ' ') v++;
    strlcpy(devKey, v, sizeof devKey); saveCfg("key", devKey); buildUrl(); online = false;
    Serial.println("device key saved");
  } else if (!strncmp(s, "apn ", 4)) {
    char* v = s + 4; while (*v == ' ') v++;
    strlcpy(apn, v, sizeof apn); saveCfg("apn", apn); online = false;
    Serial.printf("apn saved: %s\n", apn);
  } else if (!strcmp(s, "status")) {
    Serial.printf("relay=%s  apn=%s  key=%s...  sim=%s online=%d  queued=%d  csq=%d\n",
                  relay, apn, String(devKey).substring(0, 4).c_str(), simOn ? "on" : "off", online, qCount, csq);
    Serial.printf("wifi=%s  %s\n", wifiSsid[0] ? wifiSsid : "(not set)", wifiUp() ? "CONNECTED" : "not connected");
  } else {
    Serial.println("commands: relay <http(s)://host> | key <device key> | wifi <ssid> <password> | wifi off | sim on|off | apn <name> | status");
  }
}

static void pollSerial() {
  static char buf[140];
  static size_t n = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { buf[n] = 0; handleCmd(buf); n = 0; }
    else if (c != '\r' && n < sizeof(buf) - 1) buf[n++] = c;
  }
}

// ------------------------------- sampling ------------------------------
static void jb(char* dst, size_t cap, size_t& len, const char* fmt, ...) {
  va_list ap; va_start(ap, fmt);
  int w = vsnprintf(dst + len, cap - len, fmt, ap);
  va_end(ap);
  if (w > 0) len = (len + (size_t)w < cap) ? len + (size_t)w : cap - 1;
}

static void sample() {
  static uint32_t lastBmeTry = 0, lastBeep = 0;
  static uint8_t prevAlerts = 0;

  if (!bme.ok && millis() - lastBmeTry > 10000) {      // hot-plug / late power
    lastBmeTry = millis();
    if (!bme.begin(BME_ADDR)) bme.begin(0x77);
  }

  R.hasT = R.hasH = R.hasP = false;
  if (bme.ok) {
    float t = 0, h = 0, p = 0; bool gh = false;
    if (bme.read(t, h, p, gh)) { R.t = t; R.p = p; R.hasT = R.hasP = true; if (gh) { R.h = h; R.hasH = true; } }
  }

  R.mq = volts(MQ_PIN);
  R.db = micDb();
  R.warm = millis() < MQ_WARMUP_MS;

  R.hasMpu = false; R.shake = false;
  if (mpu.ok) {
    float mag = 1.0f;
    if (mpu.read(R.pitch, R.roll, mag)) {
      R.hasMpu = true;
      if (fabsf(mag - 1.0f) > peakDev) peakDev = fabsf(mag - 1.0f);
      R.shake = peakDev > SHAKE_G;               // any shake since the last sample, not just this instant
    }
  }
  peakDev = 0;

  uint8_t flags = 0;
  if (R.mq > MQ_ALERT && !R.warm) flags |= 0x01;
  if (R.warm)                     flags |= 0x02;     // informational, not an alert
  if (R.hasT && R.t > TEMP_ALERT) flags |= 0x04;
  if (R.db > DB_ALERT)            flags |= 0x08;
  if (R.shake)                    flags |= 0x10;
  if (sos)                        flags |= 0x20;
  if (fall)                       flags |= 0x40;
  R.flags = flags;
  R.have = true;

  const uint8_t alerts = flags & ~0x02;
  digitalWrite(LED_PIN, alerts ? HIGH : LOW);
  // beep on a NEW alert, then at most every ALERT_REPEAT ms while it persists
  if (alerts && !muted && ((alerts & ~prevAlerts) || millis() - lastBeep > ALERT_REPEAT)) { spkAlert(); lastBeep = millis(); }
  prevAlerts = alerts;

  // JSON: only what was really measured. mq and mic come straight off the ADC pins.
  size_t len = 0;
  jb(lastBody, sizeof lastBody, len, "{\"mq\":%.3f,\"mic\":%.1f", R.mq, R.db);
  if (R.hasT) jb(lastBody, sizeof lastBody, len, ",\"t\":%.2f", R.t);
  if (R.hasH) jb(lastBody, sizeof lastBody, len, ",\"h\":%.2f", R.h);
  if (R.hasP) jb(lastBody, sizeof lastBody, len, ",\"p\":%.2f", R.p);
  if (R.hasMpu) jb(lastBody, sizeof lastBody, len, ",\"pitch\":%.1f,\"roll\":%.1f", R.pitch, R.roll);
#if USE_GPS
  if (gpsFix) {
    jb(lastBody, sizeof lastBody, len, ",\"lat\":%.6f,\"lon\":%.6f,\"sats\":%d", gpsLat, gpsLon, gpsSats);
    if (gpsHasAlt) jb(lastBody, sizeof lastBody, len, ",\"alt\":%.1f", gpsAlt);
  }
#endif
  jb(lastBody, sizeof lastBody, len, ",\"flags\":%u", (unsigned)flags);
  if (csq >= 0) jb(lastBody, sizeof lastBody, len, ",\"csq\":%d", csq);
  jb(lastBody, sizeof lastBody, len, "}");
  haveBody = true;

  Serial.println(lastBody);          // one JSON line per cycle: "Connect over USB"
  lcdShow();
}

// Runs while we are blocked waiting on the SIM800L, so the GPS buffer never
// overflows and the LCD / USB stream keep updating during a 3-8 s upload.
static void idleWork() {
#if USE_GPS
  pollGps();
#endif
  pollMotion();
  if (millis() - lastSample >= SAMPLE_MS) { lastSample = millis(); sample(); }
}

// ------------------------------ button ---------------------------------
static void pollButton() {
  static bool last = HIGH, longDone = false;
  static uint32_t downAt = 0;
  const bool now = digitalRead(BTN_PIN);
  if (now == LOW && last == HIGH) { downAt = millis(); longDone = false; }
  if (now == LOW && !longDone && millis() - downAt > SOS_HOLD_MS) {      // 3 s: SOS on / off
    longDone = true;
    sos = !sos;
    if (sos) { lastUp = 0; spkAlert(); }                                  // lastUp = 0 pushes a packet at once
    lcd.row(0, sos ? "SOS SENT" : "SOS CANCELLED");
    lcd.row(1, sos ? "help is called" : "");
    delay(900);
    sample();                                                            // refresh flags + queue now
    lcdShow();
  }
  if (now == HIGH && last == LOW && !longDone) {
    const uint32_t held = millis() - downAt;
    if (held > 1200) {                                                    // 1.2 s: mute
      muted = !muted;
      if (!muted) spkChirp();
      lcd.row(0, muted ? "SOUND MUTED" : "SOUND ON");
      lcd.row(1, "");
      delay(700);
      lcdShow();
    } else if (held > 40) {                                               // tap: next view
      view = (uint8_t)((view + 1) % VIEWS);
      if (!muted) spkChirp();
      lcdShow();
    }
  }
  last = now;
}

// ------------------------------- setup / loop --------------------------
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  digitalWrite(LED_PIN, LOW);
  spkBegin();

  analogSetPinAttenuation(MQ_PIN, ADC_11db);
  analogSetPinAttenuation(MIC_PIN, ADC_11db);

  loadCfg();
  Wire.begin(SDA_PIN, SCL_PIN, 100000);

  lcd.begin();
  lcd.row(0, "OMNIKIT");
  lcd.row(1, "starting...");

  if (!bme.begin(BME_ADDR)) bme.begin(0x77);
  mpu.begin(MPU_ADDR);

  Serial.printf("\nI2C: LCD %s(0x%02X)  BME280 %s%s  MPU6050 %s\n",
                lcd.ok ? "ok" : "MISSING", lcd.addr,
                bme.ok ? "ok" : "MISSING", (bme.ok && !bme.hasHum) ? " (BMP280: no humidity)" : "",
                mpu.ok ? "ok" : "MISSING");

#if USE_GPS
  gps.setRxBufferSize(1024);
  gps.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("GPS6MV2 on GPIO27 (outdoors, fix in 30-60 s)");
#endif

  sim.begin(9600, SERIAL_8N1, SIM_RX_PIN, SIM_TX_PIN);
  Serial.println("type 'status', 'relay http://...', 'key ...' or 'wifi SSID PASSWORD' in the Serial Monitor to configure");
  if (wifiSsid[0]) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(wifiSsid, wifiPass);
    lcd.row(1, "WiFi connect...");
    for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(500);   // 10 s, then carry on either way
    Serial.printf("WiFi %s: %s\n", wifiSsid, WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "not connected yet (will keep trying)");
  }
  if (simOn && !wifiUp()) {
    Serial.print("SIM800L bring-up... ");
    lcd.row(1, "SIM bring-up...");
    online = gprsUp();
    Serial.println(online ? "online" : "no network (will retry)");
  }

  spkChirp();
  lastSample = millis() - SAMPLE_MS;   // sample immediately
}

void loop() {
  pollButton();
  pollSerial();
#if USE_GPS
  pollGps();
#endif
  pollMotion();

  if (millis() - lastSample >= SAMPLE_MS) { lastSample = millis(); sample(); }

  // queue the freshest reading once per UPLOAD_MS (at once after SOS: lastUp was zeroed)
  if (haveBody && (lastUp == 0 || millis() - lastUp >= UPLOAD_MS)) { lastUp = millis(); qPush(lastBody); }

  static uint32_t nextCsq = 0;
  if (online && millis() > nextCsq) { nextCsq = millis() + 30000; readCsq(); }

  if (qCount) {
    if (wifiUp()) {                                          // fast path: no modem, no waiting
      if (wifiPost(qFront())) {
        qPop();
        digitalWrite(LED_PIN, HIGH); delay(30); digitalWrite(LED_PIN, LOW);
      } else {
        static uint8_t wifiFails = 0;
        if (++wifiFails >= 5) { wifiFails = 0; qPop(); }
        delay(1000);
      }
      return;
    }
    if (!simOn) { delay(50); return; }                       // WiFi-only and not connected: keep queueing, retry
    if (!online) {
      online = gprsUp();
      if (!online) { gprsDown(); delay(2000); return; }
    }
    if (httpPost(qFront())) {
      qPop();
      digitalWrite(LED_PIN, HIGH); delay(30); digitalWrite(LED_PIN, LOW);
    } else {
      static uint8_t failCount = 0;
      if (++failCount >= 3) { failCount = 0; qPop(); gprsDown(); online = false; }
      else { gprsDown(); online = gprsUp(); }
    }
  } else {
    delay(5);
  }
}
