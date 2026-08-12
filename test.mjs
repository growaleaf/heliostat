// HELIOSTAT headless tests — node test.mjs, exit 0 = green.
import { readFileSync } from 'node:fs';
import * as S from './sun.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function close(a, b, tol) { return Math.abs(a - b) <= tol; }

// 1. sunPosition determinism
{
  const a = S.sunPosition({ month: 1, day: 15 }, 11.5, S.LATITUDE);
  const b = S.sunPosition({ month: 1, day: 15 }, 11.5, S.LATITUDE);
  check('sunPosition deterministic', a.altitude === b.altitude && a.azimuth === b.azimuth, { a, b });
}

// 2. solar-noon altitude matches the closed-form 90-|lat-dec| at solstices/equinox,
// for several latitudes — the general sunPosition() formula and the textbook
// solar-noon identity must agree on the SAME declination.
{
  const cases = [
    { lat: 45.9, date: { month: 12, day: 21 } }, // winter solstice, published dec ~-23.44
    { lat: 45.9, date: { month: 6, day: 21 } },  // summer solstice, published dec ~+23.44
    { lat: 45.9, date: { month: 3, day: 20 } },  // equinox, published dec ~0
    { lat: 60, date: { month: 12, day: 21 } },
    { lat: 10, date: { month: 6, day: 21 } },
  ];
  let ok = true;
  for (const c of cases) {
    const dec = S.solarDeclination(c.date);
    const got = S.sunPosition(c.date, 12, c.lat).altitude;
    const want = S.noonAltitudeFormula(c.lat, dec);
    if (!close(got, want, 0.2)) { ok = false; console.error('solstice mismatch', c, { got, want, dec }); }
  }
  // and the solstice declinations themselves land near the published +-23.44 deg
  const decWinter = S.solarDeclination({ month: 12, day: 21 });
  const decSummer = S.solarDeclination({ month: 6, day: 21 });
  check('winter solstice declination near published -23.44deg', close(decWinter, -23.44, 0.5), decWinter);
  check('summer solstice declination near published +23.44deg', close(decSummer, 23.44, 0.5), decSummer);
  check('solar-noon altitude matches sunPosition at solstice/equinox for several latitudes', ok);
}

// 3. sun altitude/azimuth stay in bounds over every day of the year x 5 hours
{
  let ok = true;
  for (let doy = 1; doy <= 365; doy += 3) {
    let month = 0, acc = 0;
    for (; month < 12; month++) {
      const md = [31,28,31,30,31,30,31,31,30,31,30,31][month];
      if (doy <= acc + md) break;
      acc += md;
    }
    const date = { month: month + 1, day: doy - acc };
    for (let h = 6; h <= 18; h += 3) {
      const { altitude, azimuth } = S.sunPosition(date, h, S.LATITUDE);
      if (!(altitude >= -90 && altitude <= 90) || !(azimuth >= 0 && azimuth < 360) || Number.isNaN(altitude) || Number.isNaN(azimuth)) {
        ok = false; console.error('out of bounds', date, h, { altitude, azimuth });
      }
    }
  }
  check('sunPosition bounds hold over full year x sampled hours', ok);
}

// 4. dirFromAzAlt always returns a unit vector
{
  let ok = true;
  for (let az = 0; az < 360; az += 17) {
    for (let alt = -80; alt <= 80; alt += 13) {
      const v = S.dirFromAzAlt(az, alt);
      if (!close(S.length(v), 1, 1e-9)) ok = false;
    }
  }
  check('dirFromAzAlt returns unit vectors', ok);
}

// 5. angleBetween: self=0, opposite=180, symmetric
{
  const v = S.dirFromAzAlt(37, 22);
  const opp = [-v[0], -v[1], -v[2]];
  const w = S.dirFromAzAlt(190, 5);
  check('angleBetween(v,v) == 0', close(S.angleBetween(v, v), 0, 1e-6));
  check('angleBetween(v,-v) == 180', close(S.angleBetween(v, opp), 180, 1e-6));
  check('angleBetween symmetric', close(S.angleBetween(v, w), S.angleBetween(w, v), 1e-9));
}

// 6. mirror reflection law: the bisector normal makes equal angles with source and target
{
  let ok = true;
  for (let i = 0; i < 40; i++) {
    const src = S.dirFromAzAlt((i * 53) % 360, -40 + ((i * 17) % 80));
    const tgt = S.dirFromAzAlt((i * 91 + 30) % 360, -40 + ((i * 29) % 80));
    const n = S.mirrorNormal(src, tgt);
    const aSrc = S.angleBetween(src, n);
    const aTgt = S.angleBetween(tgt, n);
    if (!close(aSrc, aTgt, 1e-6)) { ok = false; console.error('reflection law violated', { src, tgt, aSrc, aTgt }); }
  }
  check('mirrorNormal bisects exactly: angle(source,normal) == angle(target,normal) over 40 pairs', ok);
}

// 7. incidence is 0 when source == target (mirror not needed, straight pass-through)
{
  const v = S.dirFromAzAlt(210, 12);
  check('incidenceAngle(v,v) == 0', close(S.incidenceAngle(v, v), 0, 1e-6));
}

// 8. horizonAltitude: known-geometry obstruction cases
{
  const obstruction = { az: 100, width: 50, alt: 20 };
  check('horizonAltitude inside width returns peak alt', S.horizonAltitude(100, obstruction) === 20);
  check('horizonAltitude at exact edge (az=125) returns peak alt', S.horizonAltitude(125, obstruction) === 20);
  check('horizonAltitude outside width returns baseline', S.horizonAltitude(126, obstruction) === S.BASE_HORIZON);
  check('horizonAltitude with no obstruction returns baseline', S.horizonAltitude(999 % 360, null) === S.BASE_HORIZON);
}

// 9. village premise: the valley floor gets NO direct sun through the deep-winter
// midday window (that is the entire reason mirrors are needed), while an
// unobstructed ridge site DOES see the sun in the same window.
{
  let villageEverLit = false;
  let ridgeEverLit = false;
  for (let d = 1; d <= 30; d += 4) {
    for (const month of [11, 12]) {
      for (let h = 10; h <= 14; h += 0.5) {
        const { altitude, azimuth } = S.sunPosition({ month, day: d }, h, S.LATITUDE);
        if (S.villageSunVisible(azimuth, altitude, S.VILLAGE_PEAKS)) villageEverLit = true;
        if (S.siteSunVisible(S.SITES.stagnes, azimuth, altitude)) ridgeEverLit = true;
      }
    }
  }
  check('village floor never sees direct sun, Nov-Dec midday', !villageEverLit);
  check('an unobstructed ridge site DOES see the sun in the same window', ridgeEverLit);
}

// 10. traceChain: a clear chain is ok; a chain with excessive incidence is blocked
{
  const clearTarget = { az: 150, alt: 44 }; // close to stagnes's own bearing -> tiny incidence
  const { altitude, azimuth } = S.sunPosition({ month: 1, day: 5 }, 12, S.LATITUDE);
  const okTrace = S.traceChain(azimuth, altitude, ['stagnes'], clearTarget);
  check('traceChain reports ok for a plausible single-mirror relay', okTrace.ok, okTrace);

  // Force an incidence violation: sun and target nearly opposite (incidence ~85deg > 72deg max).
  const badTrace = S.traceChain(180, 30, ['stagnes'], { az: 350, alt: -25 });
  check('traceChain blocks a near-opposite (too-grazing) relay', !badTrace.ok && badTrace.reason === 'incidence-too-grazing', badTrace);
}

// 11. commissionCheck aggregates samples correctly on a small synthetic commission
{
  const synthetic = {
    id: 'synthetic', target: { az: 150, alt: 44 },
    start: { month: 1, day: 1 }, end: { month: 1, day: 3 },
    hourStart: 12, hourEnd: 12, budget: 1,
  };
  const result = S.commissionCheck(synthetic, ['stagnes'], { dayStep: 1, hourStep: 1 });
  check('commissionCheck samples exactly 3 days x 1 hour', result.total === 3, result);
  check('commissionCheck.allMet true for a trivially-clear synthetic chain', result.allMet, result);
}

// 12. every one of the 12 winter commissions is solvable within its stated budget
{
  let allOk = true;
  for (const c of S.COMMISSIONS) {
    const sol = S.solveCommission(c);
    const ok = !!sol && sol.path.length >= 1 && sol.path.length <= c.budget;
    if (!ok) { allOk = false; console.error('unsolvable commission', c.id); }
  }
  check(`all ${S.COMMISSIONS.length} commissions solvable within budget`, allOk && S.COMMISSIONS.length === 12);
}

// 13. regression: the exact same mirror chain, at the exact same clock hour,
// is valid on Dec 21 and blocked on Feb 20 — the sun's azimuth path through
// that hour differs by date, sweeping in and out of Miller's Shoulder's local
// obstruction. Not a hardcoded calendar rule: it falls out of sunPosition().
{
  const chainTarget = { az: 150, alt: 22 };
  const dec = S.sunPosition({ month: 12, day: 21 }, 8.3, S.LATITUDE);
  const feb = S.sunPosition({ month: 2, day: 20 }, 8.3, S.LATITUDE);
  const decTrace = S.traceChain(dec.azimuth, dec.altitude, ['millershoulder'], chainTarget);
  const febTrace = S.traceChain(feb.azimuth, feb.altitude, ['millershoulder'], chainTarget);
  check('same chain, same hour: valid Dec 21', decTrace.ok, { dec, decTrace });
  check('same chain, same hour: blocked Feb 20', !febTrace.ok, { feb, febTrace });
}

// 14. solveCommission is deterministic
{
  const c = S.COMMISSIONS.find((x) => x.id === 'longdark');
  const a = S.solveCommission(c);
  const b = S.solveCommission(c);
  check('solveCommission deterministic', JSON.stringify(a) === JSON.stringify(b));
}

// 15. share codec round-trips exactly
{
  const state = { commissionId: 'longdark', path: ['stagnes', 'goatridge'], seed: 7 };
  const code = S.encodeShare(state);
  const back = S.decodeShare(code);
  check('share codec round-trips', JSON.stringify(state) === JSON.stringify(back), { code, back });
  check('share code is a non-trivial string', typeof code === 'string' && code.length > 10);
}

// 16. shareText carries the commission's own flavor line and mirror count
{
  const c = S.COMMISSIONS.find((x) => x.id === 'market');
  const text = S.shareText(c, ['stagnes', 'goatridge']);
  check('shareText includes commission flavor', text.includes(c.flavor));
  check('shareText includes mirror count', text.includes('2 mirrors'));
}

// 17. dayOfYear / inDateRange, including a range that wraps the New Year
{
  check('dayOfYear(Jan 1) == 1', S.dayOfYear({ month: 1, day: 1 }) === 1);
  check('dayOfYear(Dec 31) == 365', S.dayOfYear({ month: 12, day: 31 }) === 365);
  const wrap = { start: { month: 12, day: 18 }, end: { month: 1, day: 10 } };
  check('inDateRange wraps year: Dec 25 inside', S.inDateRange({ month: 12, day: 25 }, wrap.start, wrap.end));
  check('inDateRange wraps year: Jan 5 inside', S.inDateRange({ month: 1, day: 5 }, wrap.start, wrap.end));
  check('inDateRange wraps year: Jun 1 outside', !S.inDateRange({ month: 6, day: 1 }, wrap.start, wrap.end));
}

// 18. siteSunVisible boundary matches horizonAltitude exactly (unit-level check
// distinct from the aggregate premise test above)
{
  const site = S.SITES.millershoulder; // block { az:100, width:50, alt:20 }
  check('siteSunVisible false just inside block width below required alt', !S.siteSunVisible(site, 100, 15));
  check('siteSunVisible true inside block width above required alt', S.siteSunVisible(site, 100, 25));
  check('siteSunVisible true outside block width above baseline', S.siteSunVisible(site, 200, 10));
}

// 19. commissionCheck never silently reports allMet on zero samples
{
  const degenerate = { target: { az: 0, alt: 0 }, start: { month: 1, day: 1 }, end: { month: 1, day: 1 }, hourStart: 5, hourEnd: 4, budget: 1 };
  const result = S.commissionCheck(degenerate, ['stagnes'], { dayStep: 1, hourStep: 1 });
  check('commissionCheck with an empty hour window samples zero and does not claim allMet', result.total === 0 && result.allMet === false, result);
}

// 20. source-scan guard: the pure core never touches Math.random or Date.now
{
  const src = readFileSync(new URL('./sun.mjs', import.meta.url), 'utf-8');
  check('sun.mjs never calls Math.random(', !src.includes('Math.random('));
  check('sun.mjs never calls Date.now(', !src.includes('Date.now('));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
