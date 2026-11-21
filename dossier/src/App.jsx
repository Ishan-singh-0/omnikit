/* =============================================================================
   OMNIKIT — single-file interactive dossier / digital twin
   Stack: React + Tailwind CSS + Framer Motion + lucide-react
   Drop this in as src/App.jsx. No other files required.

   All hardware facts, pin assignments, thresholds and packet bytes mirror the
   real firmware in this repo (esp32_gateway.ino).
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Battery,
  Beaker,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  Copy,
  Cpu,
  Droplets,
  Gauge,
  Info,
  Layers,
  Power,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Sparkles,
  SquareTerminal,
  Thermometer,
  Volume2,
  VolumeX,
  Wind,
  X,
  Zap,
} from "lucide-react";

/* --------------------------------- tokens --------------------------------- */
const C = {
  canvas: "#060709",
  panel: "#0D1015",
  raised: "#121720",
  emerald: "#10B981",
  cyan: "#06B6D4",
  amber: "#F59E0B",
  sky: "#38BDF8",
  red: "#EF4444",
  text: "#F8FAFC",
  sub: "#94A3B8",
  mute: "#64748B",
};

const EASE = [0.16, 1, 0.3, 1];

/* Thresholds taken straight from esp32_gateway.ino */
const MQ_ALERT_V = 2.2; // MQ_ALERT
const TURB_ALERT_V = 1.6; // TURB_ALERT
const TEMP_ALERT_C = 38.0; // TEMP_ALERT
const DB_ALERT = 78; // relative mic loudness index
const GPS_LAT = 28.6139, GPS_LON = 77.209; // demo fix (Delhi)
const DIVIDER = 1.5; // 10k top / 20k bottom

const NAV = [
  { id: "twin", label: "Digital Twin" },
  { id: "sensors", label: "Sensors" },
  { id: "pinout", label: "Pinout Lab" },
  { id: "divider", label: "ADC Lab" },
  { id: "power", label: "Power" },
  { id: "firmware", label: "Firmware" },
  { id: "build", label: "Build Sequence" },
  { id: "safety", label: "Safety" },
];

/* 38-pin ESP32 DevKit, USB at the bottom, left and right columns top to bottom. */
const LEFT = [
  "3V3", "EN", "36", "39", "34", "35", "32", "33", "25", "26",
  "27", "14", "12", "GND", "13", "9", "10", "11", "5V",
];
const RIGHT = [
  "GND", "23", "22", "TX0", "RX0", "21", "19", "18", "5", "16",
  "17", "4", "0", "2", "15", "8", "7", "6", "GND",
];

const SUBSYSTEMS = {
  all: { label: "All Pins", color: C.text },
  i2c: { label: "I2C Bus", color: C.emerald },
  uart: { label: "UART Link", color: C.sky },
  adc: { label: "ADC Analog", color: C.cyan },
  gpio: { label: "Control", color: C.sub },
  audio: { label: "Audio", color: C.amber },
};

const PIN_MAP = {
  "21": { sys: "i2c", fn: "SDA", note: "I2C data — JHD162A via the HW-061 backpack, BME280 and MPU-6050 all share it" },
  "22": { sys: "i2c", fn: "SCL", note: "I2C clock at 100 kHz. A scan should answer 0x27, 0x68 and 0x76" },
  "34": { sys: "adc", fn: "MQ-135", note: "ADC1, input only. 5 V sensor output through the 10k/20k divider" },
  "35": { sys: "adc", fn: "MAX4466", note: "ADC1, input only. Mic module fed from 3V3 so its output cannot exceed 3.3 V" },
  "25": { sys: "audio", fn: "LM386 IN", note: "LEDC tone through 10k + 0.1 uF into the LM386, out to the 8 ohm speaker" },
  "27": { sys: "uart", fn: "GPS RX", note: "UART2 receive from the GPS6MV2 TXD pin at 9600 baud" },
  "26": { sys: "uart", fn: "GPS TX", note: "UART2 transmit, left open — the ESP32 only listens to NMEA" },
  "16": { sys: "uart", fn: "SIM RX", note: "UART1 receive from the SIM800L TXD pin" },
  "17": { sys: "uart", fn: "SIM TX", note: "UART1 transmit to the SIM800L RXD pin through a 1k/2k divider" },
  "0": { sys: "gpio", fn: "BOOT key", note: "Built-in button, active low. Cycles the seven LCD views" },
  "2": { sys: "gpio", fn: "Alert LED", note: "Onboard LED, lit whenever a threshold flag is set" },
  "3V3": { sys: "gpio", fn: "3V3 rail", note: "BME280, MPU-6050, LCD backpack, MAX4466 and GPS. Never the SIM800L" },
  "5V": { sys: "gpio", fn: "5V rail", note: "LM386 and the MQ-135 heater only" },
  "GND": { sys: "gpio", fn: "Ground", note: "One common ground for every module, including the SIM800L supply" },
  "EN": { sys: "gpio", fn: "Reset", note: "Pull low to reboot the ESP32" },
};

const BUILD_STEPS = [
  {
    title: "Flash the ESP32 and watch the serial monitor",
    goal: "The board boots, prints its I2C report, and emits one JSON line every 2 s.",
    checks: [
      "Board 'ESP32 Dev Module', port selected, upload completes",
      "Monitor at 115200 shows 'I2C: LCD ok BME280 ok MPU6050 ok'",
      "One JSON line per cycle, and it keeps running on USB power alone",
    ],
  },
  {
    title: "I2C: LCD, BME280 and MPU-6050",
    goal: "All three devices answer on one bus and the 16x2 shows real numbers.",
    checks: [
      "Scan returns 0x27 (or 0x3F), 0x76 (or 0x77) and 0x68",
      "Backlight on, contrast pot adjusted, 'OMNIKIT' visible",
      "Temperature and pressure track the room; tilt changes when you rotate the board",
    ],
  },
  {
    title: "Analog sensors behind their dividers",
    goal: "No ADC pin ever sees more than 3.3 V and both readings respond to real air.",
    checks: [
      "Multimeter reads below 3.3 V at GPIO34 and GPIO35 at maximum output",
      "MQ-135 warms up for 3 minutes; its reading settles instead of drifting",
      "Clapping near the MAX4466 moves the loudness index",
    ],
  },
  {
    title: "LCD views, BOOT key and speaker",
    goal: "The one button and the LM386 behave without browning out the board.",
    checks: [
      "BOOT key steps through all seven views, one step per press",
      "Speaker tone is clean and does not reset the ESP32",
      "Alert LED lights whenever a threshold flag is raised",
    ],
  },
  {
    title: "SIM800L registers and posts",
    goal: "A real HTTP 200 comes back from the relay over the phone network.",
    checks: [
      "SIM800L on its own 4 V / 2 A supply with 1000 uF at the module",
      "AT+CREG? answers 0,1 and AT+CSQ is above 10",
      "Relay logs the packet and the dashboard switches to live data",
    ],
  },
  {
    title: "Integrate power, enclosure and calibration",
    goal: "The unit runs untethered and the screening numbers mean something.",
    checks: [
      "Protected cell, physical switch, both rails present",
      "Clean-air and clear-water reference captured per session",
      "Enclosure keeps probes and wet hands away from live electronics",
    ],
  },
];

const LIMITS = [
  {
    icon: Wind,
    color: C.amber,
    title: "MQ-135 is cross-sensitive",
    body: "It responds broadly to several gases and vapours. It cannot name a gas, and it needs a warm-up period plus calibration before its numbers mean anything.",
    note: "Use it as an indication, never as a specific gas detector.",
  },
  {
    icon: Droplets,
    color: C.cyan,
    title: "Turbidity is not in this build",
    body: "There is no turbidity sensor in the BOM. That channel stays empty, the dashboard hides it, and the score renormalises over the channels you actually send.",
    note: "Wire a probe to its own divider later; the code path is already there.",
  },
  {
    icon: Thermometer,
    color: C.emerald,
    title: "BME280 is ambient only",
    body: "Temperature, humidity and barometric pressure describe the air around the unit. They are not an air pollution or air quality measurement.",
    note: "Environmental context, not a pollution index.",
  },
  {
    icon: Activity,
    color: C.amber,
    title: "The microphone measures loudness only",
    body: "MAX4466 gives a relative dB index from RMS voltage with no absolute calibration. It cannot recognise speech, sirens or specific sounds, and its reading depends on the gain pot.",
    note: "A loudness trend, not a sound classifier.",
  },
  {
    icon: Radio,
    color: C.emerald,
    title: "GPS needs open sky",
    body: "The NEO-6M needs 30-60 s for a cold fix outdoors and gives nothing indoors. Accuracy is metres, and the fix is only attached when it is under 10 s old.",
    note: "Outdoor position, not indoor tracking.",
  },
  {
    icon: Gauge,
    color: C.sky,
    title: "The IMU is an accelerometer, not a gyro",
    body: "Pitch and roll come from gravity, so they are steady at rest and noisy under quick movement. The shake flag is a threshold on total acceleration, not a certified fall detector.",
    note: "Motion indication only.",
  },
];

const RULES = [
  {
    title: "Never exceed 3.3 V on an ADC pin",
    body: "GPIO34 and GPIO35 are 0-3.3 V only and not 5 V tolerant. The MQ-135 runs from 5 V, so its AO passes the 10k/20k divider first. The MAX4466 is powered from 3V3 so its output cannot overshoot.",
  },
  {
    title: "Give the SIM800L its own 4 V supply",
    body: "It pulls 2 A bursts. Use a separate 4.0 V supply with 1000 uF at the module, a common ground with the ESP32, and a 1k/2k divider on its RXD line.",
  },
  {
    title: "Drive the speaker through the LM386",
    body: "An 8 ohm speaker on a GPIO will brown the board out. Feed the LM386 through 10k + 0.1 uF, keep its gain low, and give it a 10 uF supply bypass.",
  },
  {
    title: "Protected cells and insulated wiring",
    body: "Use a protected 18650 in the correct holder with a proper charger, and keep the physical switch in the battery positive path, never on a GPIO.",
  },
  {
    title: "Keep liquid away from electronics",
    body: "Probes and sample containers stay physically separated from the ESP32, the rails and the SIM800L. One spill ends the demo.",
  },
];

const FW_TABS = [
  {
    name: "1. INITIALIZE",
    code: `#include <Wire.h>

// I2C: LCD 0x27 + BME280 0x76 + MPU-6050 0x68
Wire.begin(21, 22, 100000);
lcd.begin();                    // HW-061 backpack
lcd.line(0, "OMNIKIT");
lcd.line(1, "starting...");

if (!bme.begin(0x76)) bme.begin(0x77);
if (!mpu.begin(0x68)) Serial.println("MPU offline");

// analog inputs, both behind their dividers
analogSetPinAttenuation(34, ADC_11db);   // MQ-135
analogSetPinAttenuation(35, ADC_11db);   // MAX4466

// speaker tone into the LM386 on GPIO25
ledcAttach(25, 2000, 8);

// serial links: SIM800L = UART1, GPS = UART2
sim.begin(9600, SERIAL_8N1, 16, 17);
gps.begin(9600, SERIAL_8N1, 27, 26);`,
  },
  {
    name: "2. MAIN LOOP",
    code: `float t = 0, h = 0, p = 0, mq, db, pitch = 0, roll = 0;
if (bme.ok) bme.read(t, h, p);
mq = volts(34);              // mV -> V, / 1.5 divider
db = micDb();                // relative loudness index

float mag = 1.0f;
if (mpu.ok) mpu.read(pitch, roll, mag);
bool shake = fabsf(mag - 1.0f) > 0.45f;

uint8_t flags = 0;
if (mq > 2.20f) flags |= 0x01;   // gas indication
if (t  > 38.0f) flags |= 0x04;   // high ambient temp
if (db > 78.0f) flags |= 0x08;   // loud environment
if (shake)      flags |= 0x10;   // motion

digitalWrite(2, flags ? HIGH : LOW);

// one JSON line per cycle: USB path + relay body
Serial.println(body);
qPush(body);
if (flags) spkAlert();

// the BOOT key steps through the seven LCD views`,
  },
  {
    name: "3. SIM800L",
    code: `// one-time: APN + GPRS bearer
at("AT+SAPBR=3,1,\\"Contype\\",\\"GPRS\\"");
at("AT+SAPBR=3,1,\\"APN\\",\\"airtelgprs.com\\"");
at("AT+SAPBR=1,1", "OK", 30000);

// per packet: URL, then the JSON body
at("AT+HTTPINIT");
at("AT+HTTPPARA=\\"CID\\",1");
snprintf(cmd, sizeof cmd,
         "AT+HTTPPARA=\\"URL\\",\\"%s\\"", url);

sim.println("AT+HTTPDATA=190,20000");
waitFor("DOWNLOAD", 5000);
sim.print(body);                 // exactly the announced length
sim.println("AT+HTTPACTION=1");  // expect +HTTPACTION: 1,200

// RELAY must be plain http:// - the SIM800L has no TLS`,
  },
];

const BOOT_SCREENS = [
  ["OMNIKIT V1.0    ", "booting...      "],
  ["I2C 27 68 76    ", "sensors ok      "],
  ["SENSORS READY   ", "BOOT = next view"],
];

const PRESETS = [
  { name: "Clean Lab Air & Tap Water", temp: 26.4, hum: 54.2, gas: 10, ntu: 12, loud: 41, tilt: 2, moving: false, fix: true },
  { name: "High Vapour / Smoke Test", temp: 31.5, hum: 42.0, gas: 88, ntu: 12, loud: 72, tilt: 6, moving: true, fix: true },
  { name: "Muddy River Sample", temp: 27.2, hum: 78.0, gas: 18, ntu: 500, loud: 88, tilt: 12, moving: true, fix: false },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad16 = (s) => (s + "                ").slice(0, 16);

/* ------------------------------ small pieces ------------------------------ */
function Reveal({ children, delay = 0, className = "" }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

function Judge({ text, show }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.96 }}
          transition={{ duration: 0.35, ease: EASE }}
          className="mb-3 inline-flex items-start gap-2 rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2 text-[11px] leading-relaxed text-[#FCD34D]"
        >
          <Sparkles size={13} className="mt-0.5 shrink-0" />
          <span>{text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Card({ children, className = "", as = "div", ...rest }) {
  const ref = useRef(null);
  const Tag = as;
  const onMove = (e) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.setProperty("--mx", `${e.clientX - r.left}px`);
    ref.current.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <Tag
      ref={ref}
      onMouseMove={onMove}
      className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-[#0D1015] transition-colors duration-300 hover:border-white/20 ${className}`}
      {...rest}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(340px circle at var(--mx, 50%) var(--my, 0%), rgba(255,255,255,0.055), transparent 72%)",
        }}
      />
      <div className="relative">{children}</div>
    </Tag>
  );
}

function SectionHead({ index, kicker, title, blurb, accent = C.emerald }) {
  return (
    <div className="mb-8 max-w-3xl">
      <div className="mb-3 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-[#64748B]">
        <span style={{ color: accent }}>{index}</span>
        <span className="h-px w-8" style={{ background: accent, opacity: 0.5 }} />
        <span>{kicker}</span>
      </div>
      <h2 className="font-display text-3xl font-bold leading-[1.05] tracking-[-0.04em] text-[#F8FAFC] sm:text-4xl lg:text-[42px]">
        {title}
      </h2>
      {blurb && <p className="mt-4 text-[15px] leading-relaxed text-[#94A3B8]">{blurb}</p>}
    </div>
  );
}

function Badge({ children, color = C.sub, className = "" }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${className}`}
      style={{ color, borderColor: `${color}44`, background: `${color}12` }}
    >
      {children}
    </span>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, unit = "", color = C.emerald, format }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="block select-none">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-[#64748B]">{label}</span>
        <span className="font-mono text-[12px] tabular-nums" style={{ color }}>
          {format ? format(value) : value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        style={{
          background: `linear-gradient(90deg, ${color} 0%, ${color} ${pct}%, rgba(255,255,255,0.10) ${pct}%, rgba(255,255,255,0.10) 100%)`,
        }}
      />
    </label>
  );
}

function Spark({ data, color, height = 46 }) {
  if (!data || data.length < 2) return <div style={{ height }} />;
  const w = 200;
  const h = height;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 5 - ((v - min) / span) * (h - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <polyline points={`0,${h} ${pts.join(" ")} ${w},${h}`} fill={color} opacity="0.10" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <circle
        cx={w}
        cy={pts[pts.length - 1].split(",")[1]}
        r="2.6"
        fill={color}
      />
    </svg>
  );
}

function Lcd({ lines, on }) {
  return (
    <div
      className="relative overflow-hidden rounded-[6px] px-3 py-2.5"
      style={{
        background: on ? "linear-gradient(180deg,#0a2418 0%,#061510 100%)" : "#070a09",
        boxShadow: on
          ? "inset 0 0 26px rgba(16,185,129,0.30), 0 0 0 1px rgba(16,185,129,0.30), 0 0 18px rgba(16,185,129,0.12)"
          : "inset 0 0 14px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.55) 0px, rgba(0,0,0,0.55) 1px, transparent 1px, transparent 3px)",
        }}
      />
      <div
        className="relative whitespace-pre font-mono text-[12.5px] leading-[1.5] tabular-nums sm:text-[14px]"
        style={{
          color: on ? "#7CF3BE" : "transparent",
          textShadow: on ? "0 0 9px rgba(16,185,129,0.85)" : "none",
          letterSpacing: "0.02em",
        }}
      >
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}

function HexRow({ bytes }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from(bytes).map((b, i) => (
        <span
          key={i}
          className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#CBD5E1]"
        >
          {b.toString(16).padStart(2, "0").toUpperCase()}
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------- app ---------------------------------- */
export default function App() {
  /* device state */
  const [power, setPower] = useState(true);
  const [boot, setBoot] = useState(3);
  const [view, setView] = useState(0);
  const [sound, setSound] = useState(false);
  const [judge, setJudge] = useState(false);
  const [buzzerMuted, setBuzzerMuted] = useState(false);
  const [calibrating, setCalibrating] = useState(false);

  /* environment */
  const [temp, setTemp] = useState(26.4);
  const [hum, setHum] = useState(54.2);
  const [gas, setGas] = useState(10);
  const [ntu, setNtu] = useState(12);
  const [loud, setLoud] = useState(46);      // relative mic index, uncalibrated
  const [tilt, setTilt] = useState(4);       // pitch, degrees
  const [moving, setMoving] = useState(false);
  const [gpsFix, setGpsFix] = useState(true);

  /* radio log */
  const [txLog, setTxLog] = useState([]);
  const [seq, setSeq] = useState(0);
  const [txFlash, setTxFlash] = useState(false);

  /* labs */
  const [pinFilter, setPinFilter] = useState("all");
  const [pinQuery, setPinQuery] = useState("");
  const [vin, setVin] = useState(5);
  const [r1, setR1] = useState(10);
  const [r2, setR2] = useState(20);
  const [powerInspect, setPowerInspect] = useState("battery");

  /* firmware + repl */
  const [fwTab, setFwTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const [replLines, setReplLines] = useState([
    { kind: "sys", text: "ESP32 DevKit · Arduino core 3.x · Serial @ 115200" },
    { kind: "sys", text: 'Type "help" for the command list.' },
  ]);
  const [replInput, setReplInput] = useState("");

  /* build tracker */
  const [verified, setVerified] = useState(Array(BUILD_STEPS.length).fill(false));

  /* audio */
  const acRef = useRef(null);
  const audioCtx = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (!acRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      acRef.current = new AC();
    }
    if (acRef.current.state === "suspended") acRef.current.resume();
    return acRef.current;
  }, []);

  const click = useCallback(() => {
    if (!sound) return;
    const ac = audioCtx();
    if (!ac) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "square";
    o.frequency.value = 340;
    g.gain.setValueAtTime(0.055, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0005, ac.currentTime + 0.035);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.04);
  }, [sound, audioCtx]);

  const buzz = useCallback(
    (ms = 240) => {
      if (!sound) return;
      const ac = audioCtx();
      if (!ac) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "square";
      o.frequency.value = 2400; // active piezo buzzer
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.06, ac.currentTime + 0.01);
      g.gain.setValueAtTime(0.06, ac.currentTime + ms / 1000 - 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + ms / 1000);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + ms / 1000 + 0.02);
    },
    [sound, audioCtx]
  );

  /* derived live values */
  const pressure = useMemo(() => 1013.2 - (temp - 25) * 0.42 + (hum - 50) * 0.09, [temp, hum]);
  const mqV = useMemo(() => +(0.35 + (gas / 100) * 2.25).toFixed(2), [gas]);
  const turbV = useMemo(() => +(4.2 - (ntu / 500) * 2.6).toFixed(2), [ntu]);
  const gasAlert = mqV >= MQ_ALERT_V;
  const waterAlert = turbV <= TURB_ALERT_V;
  const tempAlert = temp >= TEMP_ALERT_C;
  const dbAlert = loud >= DB_ALERT;
  const rollDeg = tilt * -0.7;
  const anyAlert = gasAlert || waterAlert || tempAlert || dbAlert;

  /* sparkline history */
  const liveRef = useRef({ temp, hum, pressure });
  liveRef.current = { temp, hum, pressure };
  const [hist, setHist] = useState({
    t: Array.from({ length: 24 }, () => 26.4),
    h: Array.from({ length: 24 }, () => 54.2),
    p: Array.from({ length: 24 }, () => 1013),
  });
  useEffect(() => {
    const id = setInterval(() => {
      const s = liveRef.current;
      setHist((prev) => {
        const push = (arr, v) => [...arr.slice(-27), v];
        return {
          t: push(prev.t, s.temp + (Math.random() - 0.5) * 0.15),
          h: push(prev.h, s.hum + (Math.random() - 0.5) * 0.4),
          p: push(prev.p, s.pressure + (Math.random() - 0.5) * 0.3),
        };
      });
    }, 900);
    return () => clearInterval(id);
  }, []);

  /* boot sequence */
  useEffect(() => {
    if (!power) {
      setBoot(3);
      return;
    }
    setBoot(0);
    const a = setTimeout(() => setBoot(1), 500);
    const b = setTimeout(() => setBoot(2), 1000);
    const c = setTimeout(() => setBoot(3), 1500);
    return () => [a, b, c].forEach(clearTimeout);
  }, [power]);

  /* buzzer on alert */
  useEffect(() => {
    if (power && !buzzerMuted && anyAlert) buzz(260);
  }, [gasAlert, waterAlert, tempAlert, power, buzzerMuted, buzz, anyAlert]);

  /* calibration */
  useEffect(() => {
    if (!calibrating) return;
    const id = setTimeout(() => setCalibrating(false), 3000);
    return () => clearTimeout(id);
  }, [calibrating]);

  /* payload builder — the exact JSON esp32_gateway.ino posts to /ingest */
  const buildPayload = useCallback(
    (n) => {
      const body = {
        t: +temp.toFixed(2),
        h: +hum.toFixed(2),
        p: +pressure.toFixed(2),
        mq: +mqV.toFixed(3),
        mic: +loud.toFixed(1),
        pitch: +tilt.toFixed(1),
        roll: +rollDeg.toFixed(1),
        flags:
          (gasAlert ? 1 : 0) |
          (tempAlert ? 4 : 0) |
          (dbAlert ? 8 : 0) |
          (moving ? 16 : 0),
        csq: 17,
        ...(gpsFix ? { lat: GPS_LAT, lon: GPS_LON, sats: 8 } : {}),
      };
      return { seq: n, body, json: JSON.stringify(body) };
    },
    [temp, hum, pressure, mqV, loud, tilt, rollDeg, gasAlert, tempAlert, dbAlert, moving, gpsFix]
  );

  const transmit = useCallback(() => {
    if (!power) return;
    const next = seq + 1;
    setSeq(next);
    const { json } = buildPayload(next);
    setTxLog((prev) =>
      [
        {
          id: `${next}-${Date.now()}`,
          seq: next,
          when: new Date().toLocaleTimeString("en-GB", { hour12: false }),
          json,
          bytes: json.length,
          t: temp,
          h: hum,
          mq: mqV,
          mic: loud,
          tilt,
        },
        ...prev,
      ].slice(0, 6)
    );
    setTxFlash(true);
    setTimeout(() => setTxFlash(false), 420);
    click();
  }, [power, seq, buildPayload, temp, hum, mqV, loud, tilt, click]);

  const press = (n) => {
    if (!power) return;
    click();
    if (n === 0) setView((v) => (v + 6) % 7);
    if (n === 1) setView((v) => (v + 1) % 7);
    if (n === 2) transmit();
    if (n === 3) {
      setBuzzerMuted((m) => !m);
      if (buzzerMuted) buzz(180);
    }
    if (n === 4) setCalibrating(true);
  };

  /* LCD content */
  const lcdLines = useMemo(() => {
    if (!power) return ["                ", "                "];
    if (boot < 3) return BOOT_SCREENS[boot];
    if (calibrating) return ["CALIBRATING...  ", "ZERO REF  hold  "];
    const sg = (n) => (n >= 0 ? "+" : "") + Math.round(n);
    switch (view) {
      case 0:
        return [
          pad16(`T${temp.toFixed(1)}C H${hum.toFixed(0)}%`),
          pad16(`P${pressure.toFixed(0)}hPa ${tempAlert ? "HOT" : "OK"}`),
        ];
      case 1:
        return [pad16(`MQ135 ${mqV.toFixed(2)}V`), pad16(`AIR ${gasAlert ? "ELEVATED" : "NOMINAL"}`)];
      case 2:
        return [pad16(`MIC IDX ${Math.round(loud)}`), pad16(`SND ${dbAlert ? "LOUD" : "NORMAL"}`)];
      case 3:
        return [pad16(`PIT${sg(tilt)} ROL${sg(rollDeg)}`), pad16(`MOT ${moving ? "SHAKE" : "STILL"}`)];
      case 4:
        return gpsFix
          ? [pad16("SATS 8 FIX"), pad16(`${GPS_LAT.toFixed(4)} ${GPS_LON.toFixed(4)}`)]
          : [pad16("SATS 3 SEARCH"), pad16("no fix yet")];
      case 5:
        return [pad16("SIM CSQ 17"), pad16("ONLINE Q:0")];
      default:
        return [pad16("I2C LCD BME MPU"), pad16(`ALERT ${anyAlert ? "YES" : "NONE"}`)];
    }
  }, [power, boot, calibrating, view, temp, hum, pressure, mqV, loud, tilt, rollDeg, moving, gpsFix, dbAlert, gasAlert, tempAlert, anyAlert]);

  /* divider math */
  const vout = (vin * r2) / (r1 + r2);
  const adcRaw = clamp(Math.round((vout / 3.3) * 4095), 0, 4095);
  const adcState =
    vout <= 3.25
      ? { label: "SAFE FOR THE ESP32 ADC", color: C.emerald }
      : vout <= 3.3
      ? { label: "MARGINAL — NEAR 3.3 V LIMIT", color: C.amber }
      : { label: "DANGER — OVER-VOLTAGE RISK", color: C.red };

  /* repl */
  const runCmd = (raw) => {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    const out = [];
    if (cmd === "help") {
      out.push("commands: scan, bme, mq, mpu, mic, send, clear");
    } else if (cmd === "scan") {
      out.push("I2C: 0x27 (LCD)  0x68 (MPU-6050)  0x76 (BME280)");
    } else if (cmd === "bme") {
      out.push(`t=${temp.toFixed(2)}  h=${hum.toFixed(2)}  p=${pressure.toFixed(2)}`);
    } else if (cmd === "mq") {
      out.push(`mq=${mqV.toFixed(3)} V   ${gasAlert ? "ELEVATED" : "nominal"}`);
    } else if (cmd === "mpu") {
      out.push(`pitch=${tilt.toFixed(1)}  roll=${rollDeg.toFixed(1)}  shake=${moving}`);
    } else if (cmd === "mic") {
      out.push(`db_rel=${loud.toFixed(1)}   ${dbAlert ? "over threshold" : "nominal"}`);
    } else if (cmd === "send") {
      const { seq: n, json } = buildPayload(seq + 1);
      setSeq(n);
      out.push(`POST /ingest?key=...  ${json.length} B  ${json}`);
    } else if (cmd === "clear") {
      setReplLines([]);
      setReplInput("");
      return;
    } else {
      out.push(`NameError: name '${cmd}' isn't defined`);
    }
    setReplLines((prev) => [
      ...prev,
      { kind: "in", text: cmd },
      ...out.map((t) => ({ kind: "out", text: t })),
    ]);
    setReplInput("");
  };

  const consoleRef = useRef(null);
  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [replLines]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(FW_TABS[fwTab].code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const go = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const verifiedCount = verified.filter(Boolean).length;
  const pinRows = Object.entries(PIN_MAP)
    .filter(([pin, meta]) => {
      if (pinFilter !== "all" && meta.sys !== pinFilter) return false;
      if (!pinQuery) return true;
      const q = pinQuery.toLowerCase();
      return (
        pin.toLowerCase().includes(q) ||
        meta.fn.toLowerCase().includes(q) ||
        meta.note.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => (parseInt(a[0].replace(/\D/g, ""), 10) || 0) - (parseInt(b[0].replace(/\D/g, ""), 10) || 0));

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-[#060709] text-[#F8FAFC] antialiased">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .font-display { font-family: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif; }
        .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 14px; height: 14px; border-radius: 50%;
          background: #F8FAFC; border: 2px solid #060709;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.5);
          cursor: pointer;
        }
        input[type=range]::-moz-range-thumb {
          width: 14px; height: 14px; border-radius: 50%;
          background: #F8FAFC; border: 2px solid #060709; cursor: pointer;
        }
        .pcb-grid {
          background-image: radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px);
          background-size: 22px 22px;
          -webkit-mask-image: radial-gradient(ellipse 65% 55% at 50% 0%, #000 25%, transparent 100%);
          mask-image: radial-gradient(ellipse 65% 55% at 50% 0%, #000 25%, transparent 100%);
        }
        .dashflow { stroke-dasharray: 5 7; animation: dash 1.4s linear infinite; }
        @keyframes dash { to { stroke-dashoffset: -24; } }
        .rfpulse { animation: rfpulse 1.8s cubic-bezier(0.16,1,0.3,1) infinite; }
        @keyframes rfpulse { 0% { opacity: 0; } 30% { opacity: 0.9; } 100% { opacity: 0; } }
        .danger-flash { animation: dangerflash 0.9s steps(2, end) infinite; }
        @keyframes dangerflash { 50% { opacity: 0.35; } }
        ::-webkit-scrollbar { width: 9px; height: 9px; }
        ::-webkit-scrollbar-track { background: #060709; }
        ::-webkit-scrollbar-thumb { background: #1e2530; border-radius: 9px; }
      `}</style>

      {/* ───────────────────────── command bar ───────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-[#060709]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <button onClick={() => go("twin")} className="flex shrink-0 items-center gap-2.5">
            <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="30" height="30" rx="8" stroke="white" strokeOpacity="0.22" />
              <path d="M9 22V10l7 8 7-8v12" stroke="#10B981" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="16" cy="16" r="1.7" fill="#10B981" />
            </svg>
            <span className="font-display text-[13px] font-bold uppercase tracking-[0.18em]">Omnikit</span>
            <span className="hidden items-center gap-1.5 font-mono text-[10px] text-[#64748B] sm:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#10B981] opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#10B981]" />
              </span>
              ESP32 · V1.0
            </span>
          </button>

          <nav className="mx-auto hidden items-center gap-0.5 lg:flex">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => go(n.id)}
                className="rounded-lg px-2.5 py-1.5 text-[12px] text-[#94A3B8] transition-colors hover:bg-white/[0.06] hover:text-[#F8FAFC]"
              >
                {n.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => {
                setSound((s) => !s);
                click();
              }}
              aria-label={sound ? "Mute" : "Unmute"}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-[#94A3B8] transition-colors hover:border-white/25 hover:text-white"
            >
              {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            <button
              onClick={() => setJudge((j) => !j)}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors"
              style={{
                borderColor: judge ? "rgba(245,158,11,0.45)" : "rgba(255,255,255,0.10)",
                color: judge ? "#FCD34D" : "#94A3B8",
                background: judge ? "rgba(245,158,11,0.10)" : "transparent",
              }}
            >
              <Sparkles size={12} />
              <span className="hidden sm:inline">Judge</span>
            </button>
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto border-t border-white/[0.06] px-3 py-1.5 lg:hidden">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => go(n.id)}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[#94A3B8]"
            >
              {n.label}
            </button>
          ))}
        </div>
      </header>

      {/* ─────────────────────────── hero ─────────────────────────── */}
      <section id="twin" className="relative pt-24 lg:pt-28">
        <div className="pointer-events-none absolute inset-0 h-[520px] pcb-grid" />
        <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 pb-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-28">
          <div className="min-w-0">
            <Reveal>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#10B981]/30 bg-[#10B981]/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#6EE7B7]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#10B981]" />
                National Hackathon · Edge-first survival node
              </div>
            </Reveal>

            <Reveal delay={0.05}>
              <h1 className="font-display text-[2.6rem] font-extrabold leading-[1.02] tracking-[-0.04em] text-white sm:text-6xl lg:text-[4.1rem]">
                Wilderness Survival
                <br />
                &amp; Rescue Digital Twin.
                <br />
                <span className="text-[#10B981]">Know where they are, and how they are.</span>
              </h1>
            </Reveal>

            <Reveal delay={0.1}>
              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-[#94A3B8] sm:text-base">
                One ESP32 senses, decides locally and warns out loud: fall detection and a 3-second SOS
                run on the device with no network. When a link exists it posts over GPRS to a relay whose
                risk engine fuses pressure trend, GPS, route and motion into a score you can explain, and
                sends a rescue brief by itself. Every limit is stated on the front of the box.
              </p>
            </Reveal>

            <Reveal delay={0.15}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => go("twin-device")}
                  className="group inline-flex items-center gap-2 rounded-xl bg-[#10B981] px-5 py-3 text-[13px] font-semibold text-[#04120c] transition-transform hover:-translate-y-0.5"
                >
                  Interact with Digital Twin
                  <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
                </button>
                <button
                  onClick={() => go("pinout")}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-5 py-3 text-[13px] font-semibold text-white transition-colors hover:border-white/35 hover:bg-white/[0.04]"
                >
                  <CircuitBoard size={15} />
                  Inspect ESP32 Pinout
                </button>
              </div>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 border-t border-white/10 pt-5 font-mono text-[11px] text-[#64748B]">
                {["ESP32", "16×2 I²C LCD", "BME280 + MQ-135 + MAX4466", "SIM800L over GPRS"].map(
                  (s) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className="h-1 w-1 rounded-full bg-[#10B981]" />
                      {s}
                    </span>
                  )
                )}
              </div>
            </Reveal>
          </div>

          {/* --------------------- the handheld --------------------- */}
          <Reveal delay={0.12} className="min-w-0">
            <div id="twin-device" className="scroll-mt-28">
              <div
                className="relative rounded-[26px] border border-white/10 p-4 sm:p-5"
                style={{
                  background:
                    "linear-gradient(160deg,#1a1f27 0%,#0f1319 42%,#0b0e13 100%)",
                  boxShadow:
                    "0 40px 80px -30px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.09), inset 0 -1px 0 rgba(0,0,0,0.8)",
                }}
              >
                {/* screws */}
                {[
                  "left-2 top-2",
                  "right-2 top-2",
                  "left-2 bottom-2",
                  "right-2 bottom-2",
                ].map((pos) => (
                  <span
                    key={pos}
                    className={`absolute ${pos} h-2 w-2 rounded-full`}
                    style={{
                      background: "radial-gradient(circle at 35% 30%, #6b7280, #1f242c 70%)",
                      boxShadow: "inset 0 1px 1px rgba(255,255,255,0.25)",
                    }}
                  />
                ))}

                {/* top strip: power + status */}
                <div className="mb-3 flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-1.5 w-1.5 rounded-full transition-all"
                      style={{
                        background: power ? "#10B981" : "#1f2937",
                        boxShadow: power ? "0 0 8px #10B981" : "none",
                      }}
                    />
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#64748B]">
                      {power ? (anyAlert ? "alert" : "nominal") : "off"}
                    </span>
                    <span
                      className="h-1.5 w-1.5 rounded-full transition-all"
                      style={{
                        background: txFlash ? "#38BDF8" : "#1f2937",
                        boxShadow: txFlash ? "0 0 8px #38BDF8" : "none",
                      }}
                    />
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#64748B]">
                      tx
                    </span>
                  </div>

                  <button
                    onClick={() => {
                      setPower((p) => !p);
                      click();
                    }}
                    className="flex items-center gap-2"
                    aria-label="Power switch"
                  >
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#64748B]">
                      power
                    </span>
                    <span
                      className="relative h-5 w-9 rounded-full border transition-colors"
                      style={{
                        borderColor: power ? "rgba(16,185,129,0.5)" : "rgba(255,255,255,0.15)",
                        background: power ? "rgba(16,185,129,0.18)" : "rgba(255,255,255,0.05)",
                      }}
                    >
                      <span
                        className="absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all duration-300"
                        style={{
                          left: power ? "18px" : "3px",
                          background: power ? "#10B981" : "#475569",
                          boxShadow: power ? "0 0 8px rgba(16,185,129,0.8)" : "none",
                        }}
                      />
                    </span>
                  </button>
                </div>

                {/* LCD */}
                <div className="rounded-lg border border-black/60 bg-black/70 p-1.5">
                  <Lcd lines={lcdLines} on={power} />
                </div>

                {/* silkscreen */}
                <div className="mt-2 flex items-center justify-between px-1 font-mono text-[8px] uppercase tracking-[0.18em] text-[#475569]">
                  <span>omnikit v1 · esp32</span>
                  <span>16×2 i²c · 0x27</span>
                </div>

                {/* buttons */}
                <div className="mt-4 grid grid-cols-4 gap-1.5">
                  {[
                    { l: "VIEW", p: "GPIO0", k: 1 },
                    { l: "SEND", p: "serial", k: 2 },
                    { l: "MUTE", p: "serial", k: 3 },
                    { l: "CAL", p: "serial", k: 4 },
                  ].map((b) => (
                    <button
                      key={b.p}
                      onClick={() => press(b.k)}
                      disabled={!power}
                      className="group flex flex-col items-center gap-1 rounded-md border border-white/10 bg-[#12171f] px-1 py-2 transition-all active:translate-y-px disabled:opacity-40"
                      style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 2px 4px rgba(0,0,0,0.5)" }}
                    >
                      <span className="font-mono text-[9px] font-semibold tracking-[0.08em] text-[#CBD5E1]">
                        {b.l}
                      </span>
                      <span className="font-mono text-[7.5px] tracking-[0.06em] text-[#475569]">
                        {b.p}
                      </span>
                    </button>
                  ))}
                </div>

                {buzzerMuted && power && (
                  <div className="mt-2 text-center font-mono text-[9px] uppercase tracking-[0.16em] text-[#F59E0B]">
                    buzzer muted
                  </div>
                )}

                {calibrating && (
                  <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-white/10">
                    <motion.div
                      className="h-full bg-[#10B981]"
                      initial={{ width: "0%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: 3, ease: "linear" }}
                    />
                  </div>
                )}
              </div>

              {/* environment controls */}
              <div className="mt-4 rounded-2xl border border-white/10 bg-[#0D1015] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Sliders size={13} className="text-[#64748B]" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#64748B]">
                    inject test conditions
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Slider
                    label="Ambient temp"
                    value={temp}
                    min={10}
                    max={45}
                    step={0.1}
                    onChange={setTemp}
                    unit="°C"
                    color={C.emerald}
                    format={(v) => v.toFixed(1)}
                  />
                  <Slider
                    label="Humidity"
                    value={hum}
                    min={20}
                    max={95}
                    step={0.1}
                    onChange={setHum}
                    unit="%"
                    color={C.emerald}
                    format={(v) => v.toFixed(1)}
                  />
                  <Slider
                    label="Gas / vapour exposure"
                    value={gas}
                    min={0}
                    max={100}
                    onChange={setGas}
                    unit="%"
                    color={C.amber}
                  />
                  <Slider
                    label="Water cloudiness (optional sensor)"
                    value={ntu}
                    min={0}
                    max={500}
                    onChange={setNtu}
                    unit=" NTU"
                    color={C.cyan}
                  />
                  <Slider
                    label="Ambient loudness"
                    value={loud}
                    min={30}
                    max={100}
                    onChange={setLoud}
                    unit=" dB"
                    color={C.amber}
                  />
                  <Slider
                    label="Tilt (pitch)"
                    value={tilt}
                    min={-45}
                    max={45}
                    onChange={setTilt}
                    unit="°"
                    color={C.sky}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.1em]">
                  <button
                    onClick={() => {
                      setMoving((m) => !m);
                      click();
                    }}
                    className="rounded-md border px-2.5 py-1.5 transition-colors"
                    style={{
                      borderColor: moving ? "rgba(56,189,248,0.5)" : "rgba(255,255,255,0.12)",
                      color: moving ? C.sky : C.mute,
                      background: moving ? "rgba(56,189,248,0.10)" : "transparent",
                    }}
                  >
                    motion: {moving ? "shaking" : "still"}
                  </button>
                  <button
                    onClick={() => {
                      setGpsFix((g) => !g);
                      click();
                    }}
                    className="rounded-md border px-2.5 py-1.5 transition-colors"
                    style={{
                      borderColor: gpsFix ? "rgba(16,185,129,0.5)" : "rgba(255,255,255,0.12)",
                      color: gpsFix ? C.emerald : C.mute,
                      background: gpsFix ? "rgba(16,185,129,0.10)" : "transparent",
                    }}
                  >
                    gps: {gpsFix ? "3d fix" : "no fix"}
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => {
                        setTemp(p.temp);
                        setHum(p.hum);
                        setGas(p.gas);
                        setNtu(p.ntu);
                        setLoud(p.loud);
                        setTilt(p.tilt);
                        setMoving(p.moving);
                        setGpsFix(p.fix);
                        click();
                      }}
                      className="rounded-md border border-white/10 px-2.5 py-1.5 text-[10.5px] text-[#94A3B8] transition-colors hover:border-white/30 hover:text-white"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ───────────────────────── sensors ───────────────────────── */}
      <section id="sensors" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="01 / SUBSYSTEMS"
            kicker="Sensor suite & signal flow"
            title="Five senses, one honest disclaimer each."
            blurb="Every reading below is driven by the sliders above. Note what each sensor can and cannot tell you — that boundary is the design."
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
            {/* BME280 */}
            <div className="md:col-span-4">
              <Card className="h-full p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <Thermometer size={15} style={{ color: C.emerald }} />
                      <h3 className="font-display text-base font-bold tracking-tight">BME280 ambient</h3>
                    </div>
                    <p className="text-[12px] text-[#64748B]">Temperature · humidity · pressure</p>
                  </div>
                  <Badge color={C.emerald}>I²C0 · 0x76</Badge>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {[
                    { k: "TEMP", v: temp.toFixed(1), u: "°C", d: hist.t, c: C.emerald },
                    { k: "HUMIDITY", v: hum.toFixed(1), u: "%RH", d: hist.h, c: C.emerald },
                    { k: "PRESSURE", v: pressure.toFixed(1), u: "hPa", d: hist.p, c: C.emerald },
                  ].map((m) => (
                    <div key={m.k}>
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#475569]">
                        {m.k}
                      </div>
                      <div className="mt-1 font-mono text-xl tabular-nums text-white">
                        {m.v}
                        <span className="ml-1 text-[10px] text-[#64748B]">{m.u}</span>
                      </div>
                      <Spark data={m.d} color={m.c} height={38} />
                    </div>
                  ))}
                </div>

                <p className="mt-3 flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[11.5px] leading-relaxed text-[#94A3B8]">
                  <Info size={12} className="mt-0.5 shrink-0 text-[#64748B]" />
                  Ambient conditions only — this is not an air pollution measurement.
                </p>
              </Card>
            </div>

            {/* MQ-135 */}
            <div className="md:col-span-2">
              <Card className="h-full p-5">
                <div className="mb-4 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Wind size={15} style={{ color: C.amber }} />
                    <h3 className="font-display text-base font-bold tracking-tight">MQ-135</h3>
                  </div>
                  <Badge color={C.amber}>GPIO34 · ADC1</Badge>
                </div>

                <div className="font-mono text-3xl tabular-nums text-white">
                  {mqV.toFixed(2)}
                  <span className="ml-1 text-xs text-[#64748B]">V</span>
                </div>

                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: gasAlert ? C.red : C.amber }}
                    animate={{ width: `${clamp((mqV / 3.3) * 100, 0, 100)}%` }}
                    transition={{ duration: 0.4, ease: EASE }}
                  />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[9px] text-[#475569]">
                  <span>0 V</span>
                  <span style={{ color: MQ_ALERT_V <= mqV ? C.red : C.mute }}>
                    alert {MQ_ALERT_V.toFixed(2)} V
                  </span>
                  <span>3.3 V</span>
                </div>

                <div className="mt-3 flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#64748B]">
                    warm-up
                  </span>
                  <span className="font-mono text-[10px]" style={{ color: C.amber }}>
                    180 s · 24 h burn-in
                  </span>
                </div>

                <p
                  className="mt-3 text-[11.5px] leading-relaxed"
                  style={{ color: gasAlert ? C.amber : C.sub }}
                >
                  {gasAlert ? "Elevated broad response." : "Broad response, nominal range."} Cross-sensitive
                  — it names no gas.
                </p>
              </Card>
            </div>

            {/* Audio: MAX4466 + LM386 */}
            <div className="md:col-span-3">
              <Card className="h-full p-5">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Volume2 size={15} style={{ color: C.amber }} />
                    <h3 className="font-display text-base font-bold tracking-tight">Audio in + out</h3>
                  </div>
                  <Badge color={C.amber}>GPIO35 · GPIO25</Badge>
                </div>

                <div className="font-mono text-3xl tabular-nums text-white">
                  {loud}
                  <span className="ml-1 text-xs text-[#64748B]">dB rel</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: dbAlert ? C.red : C.amber }}
                    animate={{ width: `${clamp(((loud - 30) / 70) * 100, 0, 100)}%` }}
                    transition={{ duration: 0.4, ease: EASE }}
                  />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[9px] text-[#475569]">
                  <span>30</span>
                  <span style={{ color: dbAlert ? C.red : C.mute }}>alert {DB_ALERT}</span>
                  <span>100</span>
                </div>

                <button
                  onClick={() => buzz(300)}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/10 py-2 text-[12px] font-semibold text-[#FCD34D] transition-colors hover:bg-[#F59E0B]/20"
                >
                  <Volume2 size={13} />
                  Test the LM386 speaker
                </button>

                <p className="mt-3 text-[11.5px] leading-relaxed text-[#94A3B8]">
                  MAX4466 OUT goes to GPIO35 with the module on 3.3 V; GPIO25 drives the LM386 through
                  10k + 0.1 µF. The microphone measures loudness only — no speech or sound classification.
                </p>
              </Card>
            </div>

            {/* Motion: MPU-6050 */}
            <div className="md:col-span-3">
              <Card className="h-full p-5">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Activity size={15} style={{ color: C.sky }} />
                    <h3 className="font-display text-base font-bold tracking-tight">MPU-6050 motion</h3>
                  </div>
                  <Badge color={C.sky}>I²C0 · 0x68</Badge>
                </div>

                <div className="flex items-center gap-4">
                  <svg width="88" height="88" viewBox="0 0 88 88" className="shrink-0">
                    <circle cx="44" cy="44" r="34" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.14)" />
                    <line x1="44" y1="12" x2="44" y2="76" stroke="rgba(255,255,255,0.10)" />
                    <line x1="12" y1="44" x2="76" y2="44" stroke="rgba(255,255,255,0.10)" />
                    <motion.circle
                      r="6"
                      fill={dbAlert || moving ? C.sky : C.emerald}
                      animate={{
                        cx: 44 + clamp(rollDeg, -30, 30) * 1.0,
                        cy: 44 + clamp(tilt, -30, 30) * 1.0,
                      }}
                      transition={{ type: "spring", stiffness: 220, damping: 22 }}
                    />
                  </svg>
                  <div className="min-w-0 font-mono text-[11px] tabular-nums">
                    <div className="text-[#F8FAFC]">
                      pitch <span style={{ color: C.sky }}>{tilt.toFixed(1)}°</span>
                    </div>
                    <div className="mt-1 text-[#F8FAFC]">
                      roll <span style={{ color: C.sky }}>{rollDeg.toFixed(1)}°</span>
                    </div>
                    <div className="mt-2 text-[#64748B]">
                      {moving ? "shake detected" : "still"}
                    </div>
                  </div>
                </div>

                <p className="mt-3 text-[11.5px] leading-relaxed text-[#94A3B8]">
                  Accelerometer-only pitch and roll, plus a shake flag when total acceleration leaves
                  1 g by more than 0.45 g. It is a motion indicator, not a calibrated inclinometer.
                </p>
              </Card>
            </div>

            {/* GPS */}
            <div className="md:col-span-6">
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Radio size={15} style={{ color: C.emerald }} />
                    <h3 className="font-display text-base font-bold tracking-tight">NEO-6M position</h3>
                    <Badge color={C.emerald}>on board · UART2 GPIO27</Badge>
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-4 font-mono text-[11px] tabular-nums">
                    <span style={{ color: gpsFix ? C.emerald : C.amber }}>
                      {gpsFix ? "3D fix" : "no fix"}
                    </span>
                    <span className="text-[#CBD5E1]">
                      {gpsFix ? `${GPS_LAT.toFixed(4)}, ${GPS_LON.toFixed(4)}` : "waiting for sky view"}
                    </span>
                    <span className="text-[#64748B]">{gpsFix ? "8 sats" : "0 sats"}</span>
                  </div>
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-[#94A3B8]">
                  The GPS6MV2 sits on the same ESP32 as everything else: its TXD goes to GPIO27 at 9600
                  baud and the fix is added to the JSON as lat/lon/sats. Cold start takes 30–60 s under
                  open sky; indoors there is no fix at all.
                </p>
              </Card>
            </div>

            {/* Turbidity */}
            <div className="md:col-span-3">
              <Card className="h-full p-5">
                <div className="mb-4 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Droplets size={15} style={{ color: C.cyan }} />
                    <h3 className="font-display text-base font-bold tracking-tight">Turbidity</h3>
                  </div>
                  <Badge color={C.cyan}>not in BOM · optional</Badge>
                </div>

                <div className="flex items-center gap-4">
                  <svg width="72" height="96" viewBox="0 0 72 96" className="shrink-0">
                    <defs>
                      <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0e7490" stopOpacity="0.35" />
                        <stop offset="100%" stopColor="#06B6D4" stopOpacity="0.10" />
                      </linearGradient>
                    </defs>
                    <rect x="16" y="4" width="40" height="84" rx="7" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" />
                    <rect x="20" y="22" width="32" height="62" rx="4" fill="url(#water)" />
                    <motion.rect
                      x="20"
                      y="22"
                      width="32"
                      height="62"
                      rx="4"
                      fill="#94A3B8"
                      animate={{ opacity: clamp(ntu / 620, 0.02, 0.9) }}
                      transition={{ duration: 0.35 }}
                    />
                    <rect x="14" y="1" width="44" height="7" rx="3" fill="rgba(255,255,255,0.16)" />
                    <line x1="52" y1="34" x2="66" y2="34" stroke={C.cyan} strokeWidth="1.4" className="dashflow" />
                  </svg>

                  <div className="min-w-0">
                    <div className="font-mono text-3xl tabular-nums text-white">
                      {ntu}
                      <span className="ml-1 text-xs text-[#64748B]">NTU</span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] tabular-nums text-[#94A3B8]">
                      {turbV.toFixed(2)} V at the ADC
                    </div>
                    <div
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em]"
                      style={{
                        color: waterAlert ? C.amber : C.cyan,
                        background: waterAlert ? "rgba(245,158,11,0.12)" : "rgba(6,182,212,0.10)",
                      }}
                    >
                      {waterAlert ? <AlertTriangle size={11} /> : <Check size={11} />}
                      {waterAlert ? "cloudy sample" : "clear"}
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-[10px]">
                  <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                    <span className="text-[#475569]">V→NTU</span>
                    <div className="text-[#CBD5E1]">NTU = (4.20−V)/0.0052</div>
                  </div>
                  <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                    <span className="text-[#475569]">alert</span>
                    <div style={{ color: C.amber }}>V ≤ {TURB_ALERT_V.toFixed(2)}</div>
                  </div>
                </div>

                <p className="mt-3 text-[11.5px] leading-relaxed text-[#94A3B8]">
                  Optical cloudiness only — no bacteria, virus, pathogen, heavy metal or dissolved toxin
                  detection.
                </p>
              </Card>
            </div>

            {/* uplink */}
            <div className="md:col-span-3">
              <Card className="h-full p-5">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Radio size={15} style={{ color: C.sky }} />
                    <h3 className="font-display text-base font-bold tracking-tight">SIM800L uplink</h3>
                  </div>
                  <Badge color={C.sky}>UART1 · 9600</Badge>
                </div>

                <svg viewBox="0 0 300 96" className="w-full">
                  <rect x="4" y="30" width="62" height="36" rx="6" fill="rgba(56,189,248,0.08)" stroke="rgba(56,189,248,0.4)" />
                  <text x="35" y="52" textAnchor="middle" fill="#7DD3FC" fontSize="8" fontFamily="monospace">
                    ESP32
                  </text>
                  <rect x="234" y="30" width="62" height="36" rx="6" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.22)" />
                  <text x="265" y="52" textAnchor="middle" fill="#CBD5E1" fontSize="8" fontFamily="monospace">
                    RELAY
                  </text>

                  {[0, 1, 2].map((i) => (
                    <path
                      key={i}
                      d={i % 2 === 0 ? "M70 44 Q150 22 232 44" : "M70 52 Q150 74 232 52"}
                      fill="none"
                      stroke={C.sky}
                      strokeWidth="1.2"
                      opacity="0.45"
                      className="dashflow"
                      style={{ animationDelay: `${i * 0.3}s` }}
                    />
                  ))}

                  <AnimatePresence>
                    {txFlash && (
                      <motion.circle
                        key={seq}
                        r="3"
                        cy="48"
                        fill={C.sky}
                        initial={{ cx: 72, opacity: 1 }}
                        animate={{ cx: 230, opacity: [1, 1, 0] }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.75, ease: "easeInOut" }}
                      />
                    )}
                  </AnimatePresence>

                  <text x="150" y="16" textAnchor="middle" fill="#475569" fontSize="7" fontFamily="monospace">
                    GPRS · HTTP POST JSON
                  </text>
                </svg>

                <button
                  onClick={transmit}
                  disabled={!power}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[#38BDF8]/35 bg-[#38BDF8]/10 py-2 text-[12px] font-semibold text-[#7DD3FC] transition-colors hover:bg-[#38BDF8]/20 disabled:opacity-40"
                >
                  <Zap size={13} />
                  Send a sample now
                </button>

                <div className="mt-3 max-h-[132px] space-y-1.5 overflow-y-auto">
                  {txLog.length === 0 && (
                    <p className="py-3 text-center font-mono text-[10.5px] text-[#475569]">
                      uplink log empty — nothing posted yet
                    </p>
                  )}
                  {txLog.map((l) => (
                    <div
                      key={l.id}
                      className="rounded-md border border-white/[0.06] bg-black/30 px-2 py-1.5 font-mono text-[9.5px] leading-relaxed"
                    >
                      <div className="flex items-center justify-between text-[#64748B]">
                        <span>seq {l.seq} · {l.when}</span>
                        <span style={{ color: C.sky }}>{l.bytes} B</span>
                      </div>
                      <div className="break-all text-[#CBD5E1]">{l.json}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-[#38BDF8]/25 bg-[#38BDF8]/[0.07] px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[#7DD3FC]">
                  <ShieldAlert size={11} />
                  plain http:// only · the SIM800L has no TLS
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────────────── pinout ───────────────────────── */}
      <section id="pinout" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="02 / WIRING"
            kicker="ESP32 pinout explorer"
            title="Every wire, accounted for."
            blurb="Click a subsystem to isolate its pins on the board and read the wiring rule that keeps it alive."
          />
          <Judge
            show={judge}
            text="Why one I²C bus for three devices? The LCD backpack, BME280 and MPU-6050 have different addresses and never transmit at once, so two pins (GPIO21/22) carry all of them and one scan proves every device at once."
          />

          <div className="mb-5 flex flex-wrap gap-2">
            {Object.entries(SUBSYSTEMS).map(([key, s]) => (
              <button
                key={key}
                onClick={() => setPinFilter(key)}
                className="rounded-lg border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors"
                style={{
                  borderColor: pinFilter === key ? `${s.color}66` : "rgba(255,255,255,0.10)",
                  color: pinFilter === key ? s.color : "#94A3B8",
                  background: pinFilter === key ? `${s.color}12` : "transparent",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.16em] text-[#475569]">
                <span>esp32 devkit</span>
                <span>38 pin</span>
              </div>
              <svg viewBox="0 0 300 470" className="w-full">
                <rect x="46" y="34" width="208" height="410" rx="14" fill="#0b1f16" stroke="rgba(16,185,129,0.35)" />
                <rect x="126" y="10" width="48" height="26" rx="4" fill="#1f2937" stroke="rgba(255,255,255,0.18)" />
                <text x="150" y="27" textAnchor="middle" fill="#64748B" fontSize="7" fontFamily="monospace">
                  USB
                </text>
                <rect x="140" y="70" width="20" height="20" rx="4" fill="#111827" stroke="rgba(255,255,255,0.14)" />
                <text x="150" y="103" textAnchor="middle" fill="#475569" fontSize="6.5" fontFamily="monospace">
                  ESP32
                </text>

                {LEFT.map((pin, i) => {
                  const y = 48 + i * 19;
                  const meta = PIN_MAP[pin];
                  const active = meta && (pinFilter === "all" || meta.sys === pinFilter);
                  const color = meta ? SUBSYSTEMS[meta.sys].color : "#334155";
                  return (
                    <g key={`l-${pin}-${i}`} opacity={meta ? (active ? 1 : 0.22) : 0.35}>
                      <circle cx="58" cy={y} r={meta ? 3.4 : 2.2} fill={meta ? color : "#1e293b"} />
                      <text
                        x="68"
                        y={y + 2.6}
                        fill={meta ? (active ? color : "#475569") : "#334155"}
                        fontSize="7"
                        fontFamily="monospace"
                      >
                        {pin}
                      </text>
                      {meta && (
                        <text x="106" y={y + 2.6} fill="rgba(148,163,184,0.55)" fontSize="6" fontFamily="monospace">
                          {meta.fn}
                        </text>
                      )}
                    </g>
                  );
                })}

                {RIGHT.map((pin, i) => {
                  const y = 48 + i * 19;
                  const meta = PIN_MAP[pin];
                  const active = meta && (pinFilter === "all" || meta.sys === pinFilter);
                  const color = meta ? SUBSYSTEMS[meta.sys].color : "#334155";
                  return (
                    <g key={`r-${pin}-${i}`} opacity={meta ? (active ? 1 : 0.22) : 0.35}>
                      <circle cx="242" cy={y} r={meta ? 3.4 : 2.2} fill={meta ? color : "#1e293b"} />
                      <text
                        x="232"
                        y={y + 2.6}
                        textAnchor="end"
                        fill={meta ? (active ? color : "#475569") : "#334155"}
                        fontSize="7"
                        fontFamily="monospace"
                      >
                        {pin}
                      </text>
                      {meta && (
                        <text
                          x="194"
                          y={y + 2.6}
                          textAnchor="end"
                          fill="rgba(148,163,184,0.55)"
                          fontSize="6"
                          fontFamily="monospace"
                        >
                          {meta.fn}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </Card>

            <div className="min-w-0">
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  placeholder="Search pins, functions, notes…"
                  className="w-full rounded-lg border border-white/10 bg-[#0D1015] px-3 py-2 font-mono text-[12px] text-white placeholder:text-[#475569] focus:border-white/30 focus:outline-none"
                />
                {pinQuery && (
                  <button
                    onClick={() => setPinQuery("")}
                    className="rounded-lg border border-white/10 p-2 text-[#64748B] hover:text-white"
                    aria-label="Clear search"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/10">
                <table className="w-full text-left">
                  <thead className="bg-white/[0.03] font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#64748B]">
                    <tr>
                      <th className="px-3 py-2">Pin</th>
                      <th className="px-3 py-2">Function</th>
                      <th className="hidden px-3 py-2 sm:table-cell">Rule</th>
                      <th className="px-3 py-2">Bus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pinRows.map(([pin, meta]) => (
                      <tr key={pin} className="border-t border-white/[0.06] transition-colors hover:bg-white/[0.03]">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-white">{pin}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-[#CBD5E1]">{meta.fn}</td>
                        <td className="hidden px-3 py-2 text-[11px] leading-snug text-[#94A3B8] sm:table-cell">
                          {meta.note}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span
                            className="font-mono text-[9.5px] uppercase tracking-[0.08em]"
                            style={{ color: SUBSYSTEMS[meta.sys].color }}
                          >
                            {SUBSYSTEMS[meta.sys].label}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {pinRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center font-mono text-[11px] text-[#475569]">
                          no pins match this filter
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-[#10B981]/25 bg-[#10B981]/[0.06] p-3">
                  <div className="mb-1 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#6EE7B7]">
                    <Layers size={11} /> i²c shared bus
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-[#A7F3D0]/80">
                    LCD at 0x27 or 0x3F, BME280 at 0x76 or 0x77, MPU-6050 at 0x68. SDA GPIO21, SCL
                    GPIO22 at 100 kHz, pull-ups to 3V3 only.
                  </p>
                </div>
                <div className="rounded-xl border border-[#38BDF8]/25 bg-[#38BDF8]/[0.06] p-3">
                  <div className="mb-1 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#7DD3FC]">
                    <Radio size={11} /> uart links
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-[#BAE6FD]/80">
                    SIM800L on GPIO16/17 at 9600, RXD through a 1k/2k divider. GPS6MV2 TXD into GPIO27.
                    Both share one ground with the board.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { icon: Zap, color: C.amber, title: "GPIO25 speaker", body: "LEDC tone into the LM386 through 10k + 0.1 µF — never the speaker straight from a pin." },
              { icon: Activity, color: C.cyan, title: "GPIO34 / GPIO35", body: "Input-only ADC1 pins, 0–3.3 V maximum. The MQ-135 sits behind a divider; the mic runs on 3V3." },
              { icon: CircuitBoard, color: C.sub, title: "GPIO0 BOOT", body: "Built-in key to GND with an internal pull-up. Cycles the LCD views; nothing extra to wire." },
            ].map((c) => (
              <div key={c.title} className="rounded-xl border border-white/10 bg-[#0D1015] p-3">
                <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em]" style={{ color: c.color }}>
                  <c.icon size={11} /> {c.title}
                </div>
                <p className="text-[11px] leading-relaxed text-[#94A3B8]">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────────────── divider lab ───────────────────────── */}
      <section id="divider" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="03 / PROTECTION"
            kicker="Voltage divider & ADC lab"
            title="The one resistor pair that saves the board."
            blurb="A 5 V sensor output will kill an ESP32 ADC pin. Drag the values and watch the math that decides whether your board survives."
            accent={C.cyan}
          />
          <Judge
            show={judge}
            text="Why 10k over 20k? Because 5 V × 20/(10+20) = 3.333 V — just over the limit. It works on paper and is risky in practice; verify the real maximum output, or nudge the bottom resistor up."
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <svg viewBox="0 0 340 210" className="w-full">
                <rect x="4" y="78" width="66" height="46" rx="6" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.2)" />
                <text x="37" y="98" textAnchor="middle" fill="#CBD5E1" fontSize="8" fontFamily="monospace">SENSOR</text>
                <text x="37" y="110" textAnchor="middle" fill="#64748B" fontSize="7.5" fontFamily="monospace">AO</text>

                <line x1="70" y1="101" x2="104" y2="101" stroke="#64748B" strokeWidth="1.4" />
                <rect x="104" y="88" width="30" height="26" fill="rgba(255,255,255,0.05)" stroke="#94A3B8" strokeWidth="1.2" />
                <text x="119" y="82" textAnchor="middle" fill="#94A3B8" fontSize="7" fontFamily="monospace">R1</text>
                <text x="119" y="105" textAnchor="middle" fill="#E2E8F0" fontSize="6.5" fontFamily="monospace">{r1}k</text>

                <line x1="134" y1="101" x2="196" y2="101" stroke="#06B6D4" strokeWidth="1.6" className="dashflow" />
                <circle cx="170" cy="101" r="3.6" fill="#06B6D4" />
                <text x="170" y="88" textAnchor="middle" fill="#67E8F9" fontSize="7" fontFamily="monospace">ADC NODE</text>

                <line x1="170" y1="105" x2="170" y2="136" stroke="#64748B" strokeWidth="1.2" />
                <rect x="155" y="136" width="30" height="26" fill="rgba(255,255,255,0.05)" stroke="#94A3B8" strokeWidth="1.2" />
                <text x="170" y="152" textAnchor="middle" fill="#E2E8F0" fontSize="6.5" fontFamily="monospace">{r2}k</text>
                <text x="196" y="152" fill="#94A3B8" fontSize="7" fontFamily="monospace">R2</text>
                <line x1="170" y1="162" x2="170" y2="182" stroke="#64748B" strokeWidth="1.2" />

                <line x1="160" y1="182" x2="180" y2="182" stroke="#94A3B8" strokeWidth="1.6" />
                <line x1="163" y1="186" x2="177" y2="186" stroke="#94A3B8" strokeWidth="1.4" />
                <line x1="166" y1="190" x2="174" y2="190" stroke="#94A3B8" strokeWidth="1.2" />
                <text x="196" y="186" fill="#64748B" fontSize="7" fontFamily="monospace">GND</text>

                <line x1="170" y1="101" x2="268" y2="101" stroke="#06B6D4" strokeWidth="1.2" opacity="0.55" />
                <rect x="268" y="84" width="60" height="34" rx="5" fill="rgba(6,182,212,0.08)" stroke="rgba(6,182,212,0.45)" />
                <text x="298" y="99" textAnchor="middle" fill="#67E8F9" fontSize="7.5" fontFamily="monospace">GPIO34 /</text>
                <text x="298" y="110" textAnchor="middle" fill="#67E8F9" fontSize="7.5" fontFamily="monospace">GPIO35</text>

                <text x="4" y="24" fill="#475569" fontSize="7.5" fontFamily="monospace">V_in = {vin.toFixed(2)} V</text>
                <text x="4" y="36" fill="#67E8F9" fontSize="7.5" fontFamily="monospace">
                  V_out = {vout.toFixed(3)} V
                </text>
              </svg>

              <div className="mt-4 space-y-3">
                <Slider label="Sensor output (V_in)" value={vin} min={0} max={5} step={0.05} onChange={setVin} unit=" V" color={C.red} format={(v) => v.toFixed(2)} />
                <div className="grid grid-cols-2 gap-3">
                  <Slider label="R1 (top)" value={r1} min={1} max={50} onChange={setR1} unit=" kΩ" color={C.sub} />
                  <Slider label="R2 (bottom)" value={r2} min={1} max={50} onChange={setR2} unit=" kΩ" color={C.sub} />
                </div>
              </div>
            </Card>

            <div className="space-y-3">
              <Card className="p-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#475569]">V_out</div>
                    <div className="mt-1 font-mono text-3xl tabular-nums" style={{ color: adcState.color }}>
                      {vout.toFixed(3)}
                      <span className="ml-1 text-xs text-[#64748B]">V</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-[#475569]">
                      {vin.toFixed(2)} × {r2}/({r1}+{r2})
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#475569]">
                      ADC analogRead()
                    </div>
                    <div className="mt-1 font-mono text-3xl tabular-nums text-white">{adcRaw}</div>
                    <div className="mt-1 font-mono text-[10px] text-[#475569]">of 4095 · 12-bit</div>
                  </div>
                </div>

                <div
                  className={`mt-4 flex items-center gap-2 rounded-lg border px-3 py-2.5 ${
                    vout > 3.3 ? "danger-flash" : ""
                  }`}
                  style={{
                    borderColor: `${adcState.color}55`,
                    background: `${adcState.color}12`,
                    color: adcState.color,
                  }}
                >
                  {vout > 3.3 ? <AlertTriangle size={14} /> : <Check size={14} />}
                  <span className="font-mono text-[11px] uppercase tracking-[0.1em]">{adcState.label}</span>
                </div>

                <div className="mt-3 space-y-1 font-mono text-[10px] text-[#64748B]">
                  <div className="flex justify-between">
                    <span>≤ 3.250 V</span>
                    <span style={{ color: C.emerald }}>safe</span>
                  </div>
                  <div className="flex justify-between">
                    <span>3.251 – 3.300 V</span>
                    <span style={{ color: C.amber }}>marginal</span>
                  </div>
                  <div className="flex justify-between">
                    <span>&gt; 3.300 V</span>
                    <span style={{ color: C.red }}>over-voltage</span>
                  </div>
                </div>
              </Card>

              <Card className="p-5">
                <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#475569]">
                  default wiring check
                </div>
                <p className="text-[12px] leading-relaxed text-[#94A3B8]">
                  10 kΩ over 20 kΩ with a 5.00 V sensor gives{" "}
                  <span className="font-mono text-[#F8FAFC]">3.333 V</span> — over the limit. Use a slightly
                  larger bottom resistor, or confirm the module never reaches its full rail. Never trust the
                  datasheet maximum: measure it.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => {
                      setVin(5);
                      setR1(10);
                      setR2(20);
                    }}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 font-mono text-[10px] text-[#94A3B8] hover:border-white/30 hover:text-white"
                  >
                    load 10k/20k
                  </button>
                  <button
                    onClick={() => {
                      setVin(5);
                      setR1(10);
                      setR2(22);
                    }}
                    className="rounded-md border border-[#10B981]/35 bg-[#10B981]/10 px-2.5 py-1.5 font-mono text-[10px] text-[#6EE7B7]"
                  >
                    load 10k/22k (safe)
                  </button>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────────────── power ───────────────────────── */}
      <section id="power" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="04 / POWER"
            kicker="Architecture & safe regulation"
            title="One cell, two rails, one switch."
            blurb="Power is where prototypes die. This is the exact chain, and the two decisions that matter most."
            accent={C.amber}
          />

          <Card className="p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              {[
                { icon: Battery, title: "Protected 18650", body: "Correct holder, protection circuit, proper charger.", color: C.amber },
                { icon: Power, title: "Power switch", body: "In the battery + path. Never on a GPIO.", color: C.red },
                { icon: Zap, title: "Regulated 5 V", body: "For 5 V modules only — sensor boards, LCD backpack.", color: C.sub },
                { icon: Cpu, title: "Stable 3.3 V", body: "ESP32, BME280, MPU-6050, LCD and GPS. Logic never sees 5 V.", color: C.emerald },
              ].map((b, i) => (
                <div key={b.title} className="relative rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <b.icon size={15} style={{ color: b.color }} />
                  <div className="mt-2 font-display text-[13px] font-bold">{b.title}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#94A3B8]">{b.body}</p>
                  {i < 3 && (
                    <ChevronRight
                      size={13}
                      className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-[#334155] sm:block"
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#64748B]">
              <span className="rounded border border-white/10 px-2 py-1">common GND everywhere</span>
              <span className="rounded border border-white/10 px-2 py-1">charger with power-path if charging while running</span>
              <span className="rounded border border-[#EF4444]/30 px-2 py-1 text-[#FCA5A5]">
                never connect a bare cell to a 5 V pin
              </span>
            </div>

            <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="mb-2 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#64748B]">
                <CircuitBoard size={11} /> current bill of materials
              </div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-[10.5px] sm:grid-cols-2">
                {[
                  ["ESP32 dev board", "the only controller: sensors + SIM800L + GPS", C.sky],
                  ["SIM800L", "cellular uplink, own 4 V 2 A supply", C.sky],
                  ["BME280", "temp / humidity / pressure, 0x76", C.emerald],
                  ["JHD162A + HW-061", "16x2 LCD over I2C, 0x27", C.emerald],
                  ["MQ-135", "broad gas response, GPIO34", C.amber],
                  ["MPU-6050", "pitch / roll / shake, 0x68", C.sky],
                  ["MAX4466", "microphone, GPIO35", C.amber],
                  ["LM386 + 8 ohm", "speaker alert, GPIO25", C.amber],
                  ["GPS6MV2 (NEO-6M)", "position on board, UART2 GPIO27", C.emerald],
                  ["nRF24L01", "spare — no second node in this build", C.mute],
                  ["Turbidity sensor", "NOT IN BOM — channel stays empty", C.mute],
                ].map(([part, role, color]) => (
                  <div key={part} className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] py-1">
                    <span className="text-[#CBD5E1]">{part}</span>
                    <span className="text-right text-[#64748B]" style={{ color }}>
                      {role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {[
              {
                id: "battery",
                title: "Battery protection & charging",
                body: "A protected cell plus a charger with power-path management lets you run while charging without fighting the load. Feed the ESP32 through VIN or a 5 V rail, and keep the SIM800L on its own 4 V supply so its 2 A bursts never brown the board out.",
                color: C.amber,
              },
              {
                id: "rails",
                title: "3.3 V vs 5 V isolation",
                body: "BME280, MPU-6050, the LCD backpack, MAX4466 and the GPS all run from 3V3. The MQ-135 runs from 5 V, so its analog output must pass the 10k/20k divider before it reaches GPIO34.",
                color: C.emerald,
              },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setPowerInspect(powerInspect === t.id ? "" : t.id)}
                className="rounded-2xl border p-4 text-left transition-colors"
                style={{
                  borderColor: powerInspect === t.id ? `${t.color}55` : "rgba(255,255,255,0.10)",
                  background: powerInspect === t.id ? `${t.color}0D` : "#0D1015",
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-display text-[13px] font-bold">{t.title}</span>
                  <ChevronDown
                    size={14}
                    className="transition-transform"
                    style={{
                      transform: powerInspect === t.id ? "rotate(180deg)" : "none",
                      color: t.color,
                    }}
                  />
                </div>
                <AnimatePresence initial={false}>
                  {powerInspect === t.id && (
                    <motion.p
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.35, ease: EASE }}
                      className="overflow-hidden text-[12px] leading-relaxed text-[#94A3B8]"
                    >
                      <span className="mt-2 block">{t.body}</span>
                    </motion.p>
                  )}
                </AnimatePresence>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────────────── firmware ───────────────────────── */}
      <section id="firmware" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="05 / FIRMWARE"
            kicker="Arduino workbench"
            title="Read the source, then talk to the board."
            blurb="Three phases of esp32_gateway.ino on the left. A serial console on the right that answers with the same numbers the sliders are feeding your digital twin."
            accent={C.sky}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="flex items-center gap-1 border-b border-white/10 bg-white/[0.02] px-2 py-2">
                {FW_TABS.map((t, i) => (
                  <button
                    key={t.name}
                    onClick={() => setFwTab(i)}
                    className="relative rounded-md px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors"
                    style={{ color: fwTab === i ? "#7DD3FC" : "#64748B" }}
                  >
                    {t.name}
                    {fwTab === i && (
                      <motion.span
                        layoutId="fwtab"
                        className="absolute inset-x-1 -bottom-[7px] h-[2px] rounded-full bg-[#38BDF8]"
                      />
                    )}
                  </button>
                ))}
                <button
                  onClick={copyCode}
                  className="ml-auto flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 font-mono text-[10px] text-[#94A3B8] transition-colors hover:border-white/30 hover:text-white"
                >
                  {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
                  {copied ? "copied" : "copy"}
                </button>
              </div>
              <pre className="max-h-[420px] overflow-auto p-4 font-mono text-[11px] leading-[1.65] text-[#CBD5E1]">
                <code>{FW_TABS[fwTab].code}</code>
              </pre>
            </Card>

            <Card className="flex min-h-[420px] flex-col overflow-hidden">
              <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2">
                <SquareTerminal size={13} className="text-[#10B981]" />
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#64748B]">
                  arduino ide · COM3 · 115200
                </span>
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#10B981]" />
              </div>

              <div
                ref={consoleRef}
                className="flex-1 space-y-1 overflow-y-auto bg-black/40 p-3 font-mono text-[11px] leading-relaxed"
                style={{ maxHeight: 300 }}
              >
                {replLines.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.kind === "in"
                        ? "text-[#F8FAFC]"
                        : l.kind === "sys"
                        ? "text-[#64748B]"
                        : "whitespace-pre-wrap break-words text-[#6EE7B7]"
                    }
                  >
                    {l.kind === "in" ? <span className="text-[#38BDF8]">&gt;&gt;&gt; </span> : null}
                    {l.text}
                  </div>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  runCmd(replInput);
                }}
                className="flex items-center gap-2 border-t border-white/10 px-3 py-2"
              >
                <span className="font-mono text-[11px] text-[#38BDF8]">&gt;&gt;&gt;</span>
                <input
                  value={replInput}
                  onChange={(e) => setReplInput(e.target.value)}
                  placeholder="type a command…"
                  className="w-full bg-transparent font-mono text-[11px] text-white placeholder:text-[#475569] focus:outline-none"
                  aria-label="REPL input"
                />
              </form>

              <div className="flex flex-wrap gap-1.5 border-t border-white/[0.06] px-3 py-2">
                {["scan", "bme", "mq", "mpu", "mic", "send", "help"].map(
                  (cmd) => (
                    <button
                      key={cmd}
                      onClick={() => runCmd(cmd)}
                      className="rounded border border-white/10 px-2 py-1 font-mono text-[9.5px] text-[#94A3B8] transition-colors hover:border-[#38BDF8]/40 hover:text-[#7DD3FC]"
                    >
                      {cmd}
                    </button>
                  )
                )}
              </div>
            </Card>
          </div>
        </div>
      </section>

      {/* ───────────────────────── build sequence ───────────────────────── */}
      <section id="build" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="06 / BRING-UP"
            kicker="Six-step verification"
            title="Nothing gets integrated until it passes alone."
            blurb="Each subsystem is proven in isolation, in this order. Mark a step verified once its checklist actually passes on hardware."
            accent={C.emerald}
          />

          <div className="mb-5 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full bg-[#10B981]"
                animate={{ width: `${(verifiedCount / BUILD_STEPS.length) * 100}%` }}
                transition={{ duration: 0.5, ease: EASE }}
              />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
              {verifiedCount}/{BUILD_STEPS.length} verified
            </span>
          </div>

          <div className="space-y-2">
            {BUILD_STEPS.map((s, i) => {
              const done = verified[i];
              return (
                <div
                  key={s.title}
                  className="rounded-xl border p-4 transition-colors"
                  style={{
                    borderColor: done ? "rgba(16,185,129,0.35)" : "rgba(255,255,255,0.10)",
                    background: done ? "rgba(16,185,129,0.05)" : "#0D1015",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() =>
                        setVerified((v) => v.map((x, k) => (k === i ? !x : x)))
                      }
                      aria-label={`Mark step ${i + 1} verified`}
                      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-[10px] transition-colors"
                      style={{
                        borderColor: done ? "#10B981" : "rgba(255,255,255,0.2)",
                        background: done ? "#10B981" : "transparent",
                        color: done ? "#04120c" : "#64748B",
                      }}
                    >
                      {done ? <Check size={13} /> : i + 1}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <h3 className="font-display text-[14px] font-bold tracking-tight text-white">
                          {s.title}
                        </h3>
                        {done && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#10B981]">
                            verified
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-[#94A3B8]">{s.goal}</p>
                      <ul className="mt-2 space-y-1">
                        {s.checks.map((c) => (
                          <li key={c} className="flex items-start gap-1.5 text-[11.5px] text-[#64748B]">
                            <ChevronRight size={11} className="mt-1 shrink-0 text-[#334155]" />
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ───────────────────────── safety ───────────────────────── */}
      <section id="safety" className="scroll-mt-24 border-t border-white/[0.06] py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHead
            index="07 / HONESTY"
            kicker="Limitations & electrical safety"
            title="What it does not do is part of the design."
            blurb="Screening is not certified testing, and a demo that overheats is not a demo. Both statements live here, in public."
            accent={C.red}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Beaker size={15} className="text-[#F59E0B]" />
                <h3 className="font-display text-base font-bold tracking-tight">Scientific limitations</h3>
                <Badge color={C.amber} className="ml-auto">screening ≠ certified</Badge>
              </div>
              <div className="space-y-3">
                {LIMITS.map((l) => (
                  <div key={l.title} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <div className="mb-1 flex items-center gap-2">
                      <l.icon size={13} style={{ color: l.color }} />
                      <span className="font-display text-[12.5px] font-bold text-white">{l.title}</span>
                    </div>
                    <p className="text-[11.5px] leading-relaxed text-[#94A3B8]">{l.body}</p>
                    <p className="mt-1.5 font-mono text-[10px]" style={{ color: l.color }}>
                      {l.note}
                    </p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <ShieldAlert size={15} className="text-[#EF4444]" />
                <h3 className="font-display text-base font-bold tracking-tight">Five ironclad rules</h3>
                <Badge color={C.red} className="ml-auto">electrical</Badge>
              </div>
              <div className="space-y-2">
                {RULES.map((r, i) => (
                  <div
                    key={r.title}
                    className="flex items-start gap-3 rounded-xl border border-[#EF4444]/15 bg-[#EF4444]/[0.04] p-3"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[#EF4444]/40 font-mono text-[10px] text-[#FCA5A5]">
                      {i + 1}
                    </span>
                    <div>
                      <div className="font-display text-[12.5px] font-bold text-white">{r.title}</div>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#94A3B8]">{r.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </section>

      {/* ───────────────────────── footer ───────────────────────── */}
      <footer className="border-t border-white/10 py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="30" height="30" rx="8" stroke="white" strokeOpacity="0.22" />
                  <path d="M9 22V10l7 8 7-8v12" stroke="#10B981" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="font-display text-[12px] font-bold uppercase tracking-[0.2em]">
                  Omnikit V1
                </span>
              </div>
              <p className="mt-3 max-w-md text-[12px] leading-relaxed text-[#64748B]">
                Measure · Display · Extend. Educational screening prototype — not certified safety or water
                quality testing.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[#475569]">
                {["ESP32", "Arduino", "BME280", "MQ-135", "MPU-6050", "SIM800L"].map((t) => (
                  <span key={t} className="rounded border border-white/10 px-1.5 py-0.5">
                    {t}
                  </span>
                ))}
              </div>
            </div>

            <button
              onClick={() => go("twin")}
              className="inline-flex items-center gap-2 self-start rounded-xl border border-[#10B981]/35 bg-[#10B981]/10 px-4 py-2.5 text-[12px] font-semibold text-[#6EE7B7] transition-colors hover:bg-[#10B981]/20 sm:self-auto"
            >
              <RefreshCw size={13} />
              Back to Digital Twin
            </button>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5 font-mono text-[10px] text-[#334155]">
            <span>OMNIKIT · national hackathon prototype</span>
            <span className="flex items-center gap-1.5">
              <Gauge size={11} /> JSON over GPRS · SIM800L · plain HTTP
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
