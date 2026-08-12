// HELIOSTAT — pure core. Solar geometry, mirror-relay optics, ridge shadow,
// commission verification, and a brute-force solvability solver.
// No DOM, no WebAudio, no wall-clock or PRNG calls of any kind. All time is injected
// as {month, day} + decimal hour; the calendar is a fixed non-leap 365-day year.

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toRad = (d) => d * DEG2RAD;
const toDeg = (r) => r * RAD2DEG;

// ---------- calendar ----------

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function dayOfYear({ month, day }) {
  let n = day;
  for (let m = 0; m < month - 1; m++) n += MONTH_DAYS[m];
  return n;
}

// true if {month,day} falls within [start,end] inclusive, where the range may
// wrap the New Year (e.g. Dec 18 -> Jan 10)
export function inDateRange(date, start, end) {
  const d = dayOfYear(date);
  const s = dayOfYear(start);
  const e = dayOfYear(end);
  if (s <= e) return d >= s && d <= e;
  return d >= s || d <= e; // wraps year boundary
}

// ---------- sun position ----------

export function solarDeclination({ month, day }) {
  const n = dayOfYear({ month, day });
  return 23.45 * Math.sin(toRad((360 / 365) * (284 + n)));
}

// Returns {altitude, azimuth} in degrees. azimuth is compass bearing,
// clockwise from North (0=N, 90=E, 180=S, 270=W). hour is decimal local
// solar time (0-24). Uses the standard declination + hour-angle formula.
export function sunPosition(date, hour, latitudeDeg) {
  const dec = solarDeclination(date);
  const H = 15 * (hour - 12);
  const latR = toRad(latitudeDeg);
  const decR = toRad(dec);
  const HR = toRad(H);

  const sinAlt = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(HR);
  const altitude = toDeg(Math.asin(clamp(sinAlt, -1, 1)));
  const altR = toRad(altitude);

  const denom = Math.cos(altR) * Math.cos(latR);
  let azimuth;
  if (Math.abs(denom) < 1e-9) {
    azimuth = H > 0 ? 270 : 90; // pole-adjacent degenerate case, arbitrary but stable
  } else {
    const cosAz = (Math.sin(decR) - Math.sin(altR) * Math.sin(latR)) / denom;
    let az = toDeg(Math.acos(clamp(cosAz, -1, 1)));
    azimuth = H > 0 ? 360 - az : az;
  }
  return { altitude, azimuth: ((azimuth % 360) + 360) % 360 };
}

// The theoretical solar-noon altitude at solstice/equinox: 90 - |lat - dec|.
// Exported so tests can cross-check sunPosition(noon) against this closed
// form independently of the general formula's own code path.
export function noonAltitudeFormula(latitudeDeg, declinationDeg) {
  return 90 - Math.abs(latitudeDeg - declinationDeg);
}

// ---------- vectors ----------

// Unit direction vector pointing toward (azDeg, altDeg). x=east, y=north, z=up.
export function dirFromAzAlt(azDeg, altDeg) {
  const azR = toRad(azDeg);
  const altR = toRad(altDeg);
  return [Math.cos(altR) * Math.sin(azR), Math.cos(altR) * Math.cos(azR), Math.sin(altR)];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length(a) {
  return Math.sqrt(dot(a, a));
}

export function normalize(a) {
  const len = length(a);
  if (len < 1e-9) return [0, 0, 1];
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function angleBetween(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return toDeg(Math.acos(clamp(dot(na, nb), -1, 1)));
}

// ---------- mirror optics ----------

// A heliostat's normal is the exact bisector of the source and target
// directions: it continuously re-aims through the day, always redirecting
// whatever hits it from `sourceDir` toward `targetDir`.
export function mirrorNormal(sourceDir, targetDir) {
  return normalize(add(normalize(sourceDir), normalize(targetDir)));
}

// Angle between the incoming ray and the mirror's normal. By construction
// this equals the angle between the normal and the outgoing ray too (law of
// reflection) — tested explicitly as an invariant.
export function incidenceAngle(sourceDir, targetDir) {
  const n = mirrorNormal(sourceDir, targetDir);
  return angleBetween(sourceDir, n);
}

// ---------- ridge shadow caster ----------

export const BASE_HORIZON = 4; // degrees; open-sky baseline altitude to clear

function angularDiff(a, b) {
  return Math.abs((((a - b + 540) % 360) + 360) % 360 - 180);
}

// obstruction: {az, width, alt} | null. Returns the minimum sun altitude
// required to be visible at this azimuth: `alt` while the sun's azimuth is
// within the obstruction's angular width of `az`, else the open baseline.
export function horizonAltitude(sunAzimuthDeg, obstruction) {
  if (!obstruction) return BASE_HORIZON;
  if (angularDiff(sunAzimuthDeg, obstruction.az) <= obstruction.width / 2) {
    return Math.max(obstruction.alt, BASE_HORIZON);
  }
  return BASE_HORIZON;
}

// Village horizon: the tallest covering peak among a list, else baseline.
// This is what keeps the valley floor dark through the winter.
export function villageHorizon(sunAzimuthDeg, peaks) {
  let h = BASE_HORIZON;
  for (const p of peaks) {
    if (angularDiff(sunAzimuthDeg, p.az) <= p.width / 2) h = Math.max(h, p.alt);
  }
  return h;
}

export function siteSunVisible(site, sunAz, sunAlt) {
  return sunAlt > horizonAltitude(sunAz, site.block || null);
}

export function villageSunVisible(sunAz, sunAlt, peaks) {
  return sunAlt > villageHorizon(sunAz, peaks);
}

// ---------- game data ----------

export const LATITUDE = 45.9; // alpine valley, ~Viganella's parallel

export const MAX_INCIDENCE = 72; // degrees; beyond this a mirror's throw is game-ruled too weak

export const VILLAGE_PEAKS = [
  { az: 180, width: 140, alt: 42 }, // the long south wall — the valley's main blocker
  { az: 120, width: 50, alt: 33 },  // east shoulder
  { az: 240, width: 50, alt: 33 },  // west shoulder
];

export const SITES = {
  bakerystep: { name: "Bakery Step", az: 100, alt: 15, block: null },
  millershoulder: { name: "Miller's Shoulder", az: 120, alt: 30, block: { az: 100, width: 50, alt: 20 } },
  stagnes: { name: "Crag of St. Agnes", az: 150, alt: 44, block: null },
  wolfstooth: { name: "Wolf's Tooth", az: 170, alt: 50, block: null },
  sunwell: { name: "Sunwell Ridge", az: 185, alt: 46, block: null },
  goatridge: { name: "Goat Ridge", az: 200, alt: 38, block: null },
  lownotch: { name: "Low Notch", az: 225, alt: 15, block: { az: 225, width: 80, alt: 35 } },
  saddle: { name: "The Saddle", az: 240, alt: 28, block: { az: 255, width: 40, alt: 18 } },
  eastcomb: { name: "East Comb", az: 95, alt: 25, block: null },
  northwatch: { name: "North Watch", az: 350, alt: 20, block: null },
};

export const SITE_IDS = Object.keys(SITES);

export const COMMISSIONS = [
  { id: "bakery", name: "The Bakery Step", flavor: "Bread's no good cold. Get the step lit before the oven cools.",
    target: { az: 100, alt: 15 }, start: { month: 11, day: 15 }, end: { month: 11, day: 30 }, hourStart: 8.5, hourEnd: 9.0, budget: 1 },
  { id: "recess1", name: "Schoolyard Recess", flavor: "Twenty children, ten minutes, one patch of warm stone.",
    target: { az: 140, alt: 25 }, start: { month: 11, day: 20 }, end: { month: 12, day: 10 }, hourStart: 10.5, hourEnd: 11.0, budget: 1 },
  { id: "market", name: "Market Square", flavor: "Nobody buys turnips in the shade.",
    target: { az: 180, alt: 30 }, start: { month: 12, day: 1 }, end: { month: 12, day: 20 }, hourStart: 11.5, hourEnd: 12.5, budget: 2 },
  { id: "widow", name: "Widow Elsa's Window", flavor: "She takes her coffee slow. She'd like to see the cup.",
    target: { az: 110, alt: 18 }, start: { month: 12, day: 5 }, end: { month: 1, day: 10 }, hourStart: 8.75, hourEnd: 9.25, budget: 1 },
  { id: "chapel", name: "Chapel Steps, St. Lucy's Day", flavor: "The procession needs somewhere dry and bright to stand.",
    target: { az: 175, alt: 22 }, start: { month: 12, day: 10 }, end: { month: 12, day: 16 }, hourStart: 12.0, hourEnd: 12.5, budget: 2 },
  { id: "longdark", name: "The Long Dark Well", flavor: "Solstice week. Ask for little and be glad of it.",
    target: { az: 200, alt: 20 }, start: { month: 12, day: 18 }, end: { month: 12, day: 26 }, hourStart: 11.0, hourEnd: 13.0, budget: 3 },
  { id: "cobbler", name: "Cobbler's Bench", flavor: "He likes the afternoon light on his hands, not his eyes.",
    target: { az: 230, alt: 20 }, start: { month: 12, day: 20 }, end: { month: 1, day: 15 }, hourStart: 14.0, hourEnd: 14.5, budget: 2 },
  { id: "newyear", name: "New Year's Square", flavor: "One noon, lit right, and the whole village will remember it.",
    target: { az: 180, alt: 25 }, start: { month: 12, day: 30 }, end: { month: 1, day: 2 }, hourStart: 11.75, hourEnd: 12.25, budget: 2 },
  { id: "surgery", name: "Doctor's Surgery Window", flavor: "She can't stitch a cut she can't see.",
    target: { az: 20, alt: 35 }, start: { month: 1, day: 5 }, end: { month: 1, day: 25 }, hourStart: 10.0, hourEnd: 15.0, budget: 3 },
  { id: "loom", name: "Weaver's Loom-Room", flavor: "Wool shows its true color only in daylight.",
    target: { az: 150, alt: 20 }, start: { month: 1, day: 10 }, end: { month: 2, day: 1 }, hourStart: 9.5, hourEnd: 10.0, budget: 1 },
  { id: "clock", name: "Town Clock Face", flavor: "The bell-ringer reads the shadow, not the hands.",
    target: { az: 180, alt: 28 }, start: { month: 1, day: 20 }, end: { month: 2, day: 15 }, hourStart: 11.75, hourEnd: 12.25, budget: 2 },
  { id: "recess2", name: "Schoolyard Recess Returns", flavor: "The sun's coming back on its own. Give it a head start.",
    target: { az: 140, alt: 30 }, start: { month: 2, day: 5 }, end: { month: 2, day: 20 }, hourStart: 10.5, hourEnd: 11.0, budget: 1 },
];

// ---------- chain tracing ----------

// path: array of site ids, in relay order, sun-first-then-target implied.
// Returns per-hop incidence data and whether the whole chain is clear at
// this single instant (sun position + all fixed geometry).
export function traceChain(sunAz, sunAlt, path, targetAzAlt, sites = SITES) {
  if (path.length === 0) {
    return { ok: false, hops: [], blockedAt: -1, reason: "no-mirrors" };
  }
  const dirs = [dirFromAzAlt(sunAz, sunAlt)];
  for (const id of path) {
    const s = sites[id];
    dirs.push(dirFromAzAlt(s.az, s.alt));
  }
  dirs.push(dirFromAzAlt(targetAzAlt.az, targetAzAlt.alt));

  const firstSite = sites[path[0]];
  if (!siteSunVisible(firstSite, sunAz, sunAlt)) {
    return { ok: false, hops: [], blockedAt: 0, reason: "sun-blocked-at-first-site" };
  }

  const hops = [];
  for (let j = 1; j <= path.length; j++) {
    const source = dirs[j - 1];
    const target = dirs[j + 1];
    const incidence = incidenceAngle(source, target);
    hops.push({ siteIndex: j - 1, siteId: path[j - 1], incidence });
    if (incidence > MAX_INCIDENCE) {
      return { ok: false, hops, blockedAt: j - 1, reason: "incidence-too-grazing" };
    }
  }
  return { ok: true, hops, blockedAt: -1, reason: null };
}

// ---------- commission verification ----------

function* sampleDates(start, end, dayStep) {
  const s = dayOfYear(start);
  const e = dayOfYear(end);
  const span = s <= e ? e - s : e + 365 - s;
  for (let d = 0; d <= span; d += dayStep) {
    const doy = ((s - 1 + d) % 365) + 1;
    let month = 0;
    let acc = 0;
    for (; month < 12; month++) {
      if (doy <= acc + MONTH_DAYS[month]) break;
      acc += MONTH_DAYS[month];
    }
    yield { month: month + 1, day: doy - acc };
  }
}

function* sampleHours(hourStart, hourEnd, hourStep) {
  for (let h = hourStart; h <= hourEnd + 1e-9; h += hourStep) yield h;
}

// Checks a fixed mirror placement (path of site ids) against every sampled
// date x hour in the commission's window. Every sample must clear the chain
// for the commission to be considered met — a heliostat once placed keeps
// tracking automatically, but the geometry itself can still fail at the
// window's edges.
export function commissionCheck(commission, path, opts = {}) {
  const { sites = SITES, latitude = LATITUDE, dayStep = 2, hourStep = 0.25 } = opts;
  let total = 0;
  let failures = 0;
  let firstFailure = null;
  for (const date of sampleDates(commission.start, commission.end, dayStep)) {
    for (const hour of sampleHours(commission.hourStart, commission.hourEnd, hourStep)) {
      total++;
      const { altitude, azimuth } = sunPosition(date, hour, latitude);
      const trace = traceChain(azimuth, altitude, path, commission.target, sites);
      if (!trace.ok) {
        failures++;
        if (!firstFailure) firstFailure = { date, hour, reason: trace.reason, blockedAt: trace.blockedAt };
      }
    }
  }
  return { allMet: failures === 0 && total > 0, total, failures, firstFailure };
}

// ---------- solvability solver ----------

function* permutations(arr, len) {
  if (len === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const tail of permutations(rest, len - 1)) {
      yield [arr[i], ...tail];
    }
  }
}

// Deterministic brute-force search over chains up to `commission.budget`
// mirrors long, drawn from candidateIds (defaults to all sites, in fixed
// sorted order — no randomness, same input always yields the same output).
export function solveCommission(commission, opts = {}) {
  const { sites = SITES, candidateIds = SITE_IDS, latitude = LATITUDE, dayStep = 3, hourStep = 0.5 } = opts;
  const ids = [...candidateIds].sort();
  for (let len = 1; len <= commission.budget; len++) {
    for (const path of permutations(ids, len)) {
      const result = commissionCheck(commission, path, { sites, latitude, dayStep, hourStep });
      if (result.allMet) return { path, result };
    }
  }
  return null;
}

// ---------- share codec ----------

function b64encode(str) {
  if (typeof btoa === "function") return btoa(str);
  return Buffer.from(str, "utf-8").toString("base64");
}

function b64decode(str) {
  if (typeof atob === "function") return atob(str);
  return Buffer.from(str, "base64").toString("utf-8");
}

export function encodeShare(state) {
  return b64encode(JSON.stringify(state));
}

export function decodeShare(code) {
  return JSON.parse(b64decode(code));
}

export function shareText(commission, path, sites = SITES) {
  const names = path.map((id) => sites[id].name).join(", ");
  return `\u{1F31E} HELIOSTAT · ${commission.flavor} · ${path.length} mirror${path.length === 1 ? "" : "s"}, ${names} · http://heliostat.defimagic.io`;
}
