// HELIOSTAT — DOM, canvas, input. Imports the pure core; owns nothing about
// solar geometry itself.
import * as S from './sun.mjs';

const STORAGE_KEY = 'heliostat_v1';
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function loadSave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completed: {}, currentIndex: 0, seenHowTo: false };
    const parsed = JSON.parse(raw);
    return { completed: parsed.completed || {}, currentIndex: parsed.currentIndex || 0, seenHowTo: !!parsed.seenHowTo };
  } catch (e) {
    return { completed: {}, currentIndex: 0, seenHowTo: false };
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      completed: state.save.completed,
      currentIndex: state.save.currentIndex,
      seenHowTo: state.save.seenHowTo,
    }));
  } catch (e) { /* storage unavailable — play on without persistence */ }
}

// step `deltaDays` from `date`, wrapping the fixed 365-day calendar
function stepDate(date, deltaDays) {
  const doy = S.dayOfYear(date);
  const target = ((doy - 1 + deltaDays) % 365 + 365) % 365 + 1;
  let month = 0, acc = 0;
  for (; month < 12; month++) {
    if (target <= acc + MONTH_DAYS[month]) break;
    acc += MONTH_DAYS[month];
  }
  return { month: month + 1, day: target - acc };
}

function dateSpan(start, end) {
  const s = S.dayOfYear(start);
  const e = S.dayOfYear(end);
  return s <= e ? e - s : e + 365 - s;
}

function fmtDate(d) {
  return `${MONTH_NAMES[d.month - 1]} ${d.day}`;
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const period = hh < 12 ? 'am' : 'pm';
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, '0')}${period}`;
}

const state = {
  save: loadSave(),
  screen: 'title', // title | howto | play | freeplay
  path: [],        // current chain of site ids for the active commission
  sliderDay: 0,     // 0..span
  sliderHour: null, // decimal hour; null = commission.hourStart
  lastCheck: null,  // last full-window verify result
};

function activeCommission() {
  if (state.screen === 'freeplay') return null;
  return S.COMMISSIONS[state.save.currentIndex] || null;
}

function allComplete() {
  return S.COMMISSIONS.every((c) => state.save.completed[c.id]);
}

// ---------- DOM refs ----------

const root = document.getElementById('app');
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');

// ---------- rendering ----------

function polarPoint(cx, cy, radius, az, alt) {
  const r = radius * (1 - clamp01(alt / 90));
  const theta = (az - 90) * Math.PI / 180; // az=0(N) drawn at top
  return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function drawSky(commission, sunAz, sunAlt, trace) {
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 - 6;
  const R = Math.min(W, H) * 0.42;

  ctx.clearRect(0, 0, W, H);

  // sky background
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15);
  grad.addColorStop(0, '#1c2b4a');
  grad.addColorStop(1, '#0a1226');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2);
  ctx.fill();

  // village-peak shadow wedges (the reason direct light fails)
  for (const peak of S.VILLAGE_PEAKS) {
    const a0 = peak.az - peak.width / 2;
    const a1 = peak.az + peak.width / 2;
    const rInner = R * (1 - clamp01(peak.alt / 90));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let a = a0; a <= a1; a += 4) {
      const [x, y] = polarPoint(cx, cy, R, a, 0);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#0a1638';
    ctx.fill();
    ctx.globalAlpha = 1;
    // inner boundary of the shadow (where the peak's silhouette sits)
    ctx.beginPath();
    for (let a = a0; a <= a1; a += 4) {
      const [x, y] = polarPoint(cx, cy, R, a, peak.alt);
      if (a === a0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(120,140,190,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // altitude rings
  ctx.strokeStyle = 'rgba(200,210,235,0.14)';
  ctx.lineWidth = 1;
  for (const alt of [0, 20, 40, 60, 80]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * (1 - alt / 90), 0, Math.PI * 2);
    ctx.stroke();
  }
  // compass labels
  ctx.fillStyle = 'rgba(220,225,245,0.55)';
  ctx.font = '11px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - R - 8);
  ctx.fillText('S', cx, cy + R + 16);
  ctx.fillText('E', cx + R + 12, cy + 4);
  ctx.fillText('W', cx - R - 12, cy + 4);

  // ridge sites
  for (const id of S.SITE_IDS) {
    const site = S.SITES[id];
    const [x, y] = polarPoint(cx, cy, R, site.az, site.alt);
    const selected = state.path.includes(id);
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x - 6, y + 5);
    ctx.lineTo(x + 6, y + 5);
    ctx.closePath();
    ctx.fillStyle = selected ? '#e8b84b' : 'rgba(180,195,225,0.55)';
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = '#fff3d0';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // target (the window this commission is lighting)
  if (commission) {
    const [tx, ty] = polarPoint(cx, cy, R, commission.target.az, commission.target.alt);
    ctx.beginPath();
    ctx.moveTo(tx, ty - 7);
    ctx.lineTo(tx + 7, ty);
    ctx.lineTo(tx, ty + 7);
    ctx.lineTo(tx - 7, ty);
    ctx.closePath();
    ctx.fillStyle = trace && trace.ok ? '#ffe9a8' : 'rgba(255,233,168,0.4)';
    ctx.strokeStyle = '#fff3d0';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fill();
  }

  // sun
  const sunOnScreen = sunAlt > -8;
  if (sunOnScreen) {
    const [sx, sy] = polarPoint(cx, cy, R, sunAz, Math.max(sunAlt, 0.5));
    ctx.beginPath();
    ctx.arc(sx, sy, 7, 0, Math.PI * 2);
    ctx.fillStyle = sunAlt > 0 ? '#ffd35c' : '#8a6a3a';
    ctx.shadowColor = '#ffd35c';
    ctx.shadowBlur = sunAlt > 0 ? 14 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // beam chain
  if (commission && state.path.length) {
    const pts = [sunOnScreen ? polarPoint(cx, cy, R, sunAz, Math.max(sunAlt, 0.5)) : null];
    for (const id of state.path) pts.push(polarPoint(cx, cy, R, S.SITES[id].az, S.SITES[id].alt));
    pts.push(polarPoint(cx, cy, R, commission.target.az, commission.target.alt));
    const ok = trace && trace.ok;
    ctx.strokeStyle = ok ? 'rgba(255,211,92,0.9)' : 'rgba(255,120,90,0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash(ok ? [] : [5, 4]);
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (!p) continue;
      if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------- screens ----------

function render() {
  root.innerHTML = '';
  if (state.screen === 'title') return renderTitle();
  if (state.screen === 'howto') return renderHowTo();
  return renderPlay();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderTitle() {
  canvas.style.display = 'none';
  const wrap = el('div', 'screen title-screen');
  wrap.appendChild(el('div', 'sun-emblem', '\u{1F31E}'));
  wrap.appendChild(el('h1', null, 'HELIOSTAT'));
  wrap.appendChild(el('p', 'subtitle', 'the mirror-keeper of a valley that loses its sun'));

  const note = el('p', 'honest-note');
  note.innerHTML = 'Some real alpine villages — Viganella in Italy, Rjukan in Norway — sit so deep in their valleys that the sun leaves them for the whole winter. Both built giant mirrors on the ridgelines to send it back down. This game is built on that true idea, with real solar geometry: the sun’s actual daily arc, by date and latitude.';
  wrap.appendChild(note);

  const playBtn = el('button', 'btn primary', allComplete() ? 'Free-play the valley' : 'Take up the commission book');
  playBtn.onclick = () => { state.screen = allComplete() ? 'freeplay' : 'play'; setupForCommission(); render(); };
  wrap.appendChild(playBtn);

  const howBtn = el('button', 'btn', 'How the light works');
  howBtn.onclick = () => { state.screen = 'howto'; render(); };
  wrap.appendChild(howBtn);

  if (Object.keys(state.save.completed).length > 0) {
    const progress = el('p', 'progress-note', `${Object.keys(state.save.completed).length} of ${S.COMMISSIONS.length} commissions lit.`);
    wrap.appendChild(progress);
  }
  root.appendChild(wrap);
}

function renderHowTo() {
  canvas.style.display = 'none';
  const wrap = el('div', 'screen howto-screen');
  wrap.appendChild(el('h2', null, 'How the light works'));
  const items = [
    ['The village is walled in.', 'The valley sides block the low winter sun from ever reaching the floor directly — the whole reason for mirrors.'],
    ['A heliostat tracks on its own.', 'Once you set a mirror on a ridge, it keeps re-aiming itself all day, every day — you’re choosing WHERE to put it and WHERE it aims, not steering it by hand.'],
    ['Chain mirrors to go further.', 'One mirror catches the sun and throws it at your target. Add a second to relay it further — spend your budget wisely.'],
    ['Scrub the calendar to prove it.', 'A placement has to hold across the WHOLE commission window — every sampled day and hour — not just the moment you set it. Drag the sliders and watch the beam.'],
  ];
  for (const [h, p] of items) {
    const card = el('div', 'howto-card');
    card.appendChild(el('h3', null, h));
    card.appendChild(el('p', null, p));
    wrap.appendChild(card);
  }
  const back = el('button', 'btn primary', 'Back');
  back.onclick = () => { state.screen = 'title'; render(); };
  wrap.appendChild(back);
  root.appendChild(wrap);
}

function setupForCommission() {
  const c = activeCommission();
  state.path = (state.save.completed[c?.id] && state.save.completed[c.id].path) ? [...state.save.completed[c.id].path] : [];
  state.sliderDay = 0;
  state.sliderHour = c ? c.hourStart : 12;
  state.lastCheck = null;
}

function currentSunSample(commission) {
  const span = dateSpan(commission.start, commission.end);
  const date = stepDate(commission.start, Math.round(state.sliderDay));
  const hour = state.sliderHour;
  const { altitude, azimuth } = S.sunPosition(date, hour, S.LATITUDE);
  return { date, hour, altitude, azimuth, span };
}

function renderPlay() {
  canvas.style.display = 'block';
  const wrap = el('div', 'screen play-screen');
  const freeplay = state.screen === 'freeplay';
  const commission = freeplay ? null : activeCommission();

  if (freeplay && !commission) {
    wrap.appendChild(el('div', 'commission-header', 'Free-play valley — no book, no budget, just the ridge and the sun.'));
  }

  if (commission) {
    const idx = state.save.currentIndex + 1;
    const header = el('div', 'commission-header');
    header.appendChild(el('span', 'badge', `${idx} / ${S.COMMISSIONS.length}`));
    header.appendChild(el('h2', null, commission.name));
    wrap.appendChild(header);
    wrap.appendChild(el('p', 'flavor', commission.flavor));
    wrap.appendChild(el('p', 'window-note',
      `${fmtDate(commission.start)} – ${fmtDate(commission.end)}, ${fmtHour(commission.hourStart)}–${fmtHour(commission.hourEnd)}  ·  budget ${commission.budget} mirror${commission.budget > 1 ? 's' : ''}`));
  }

  wrap.appendChild(canvas);

  const target = commission ? commission.target : { az: 180, alt: 30 };
  const sun = commission
    ? currentSunSample(commission)
    : (() => { const { altitude, azimuth } = S.sunPosition(stepDate({ month: 12, day: 21 }, state.sliderDay), state.sliderHour ?? 12, S.LATITUDE); return { altitude, azimuth, date: stepDate({ month: 12, day: 21 }, state.sliderDay), hour: state.sliderHour ?? 12, span: 60 }; })();
  const trace = S.traceChain(sun.azimuth, sun.altitude, state.path, target);
  drawSky(commission || { target }, sun.azimuth, sun.altitude, trace);

  const readout = el('div', 'readout');
  readout.appendChild(el('span', null, `${fmtDate(sun.date)}, ${fmtHour(sun.hour)}`));
  readout.appendChild(el('span', trace.ok ? 'ok' : 'blocked', trace.ok ? 'light reaches the window' : (state.path.length ? 'blocked' : 'no mirror placed')));
  wrap.appendChild(readout);

  // sliders
  const daySlider = document.createElement('input');
  daySlider.type = 'range';
  daySlider.min = 0;
  daySlider.max = commission ? sun.span : 90;
  daySlider.step = 1;
  daySlider.value = state.sliderDay;
  daySlider.className = 'slider';
  daySlider.oninput = (e) => { state.sliderDay = Number(e.target.value); render(); };
  const dayLabel = el('label', 'slider-label', 'Day within the window');
  dayLabel.appendChild(daySlider);
  wrap.appendChild(dayLabel);

  const hourSlider = document.createElement('input');
  hourSlider.type = 'range';
  const hMin = commission ? commission.hourStart : 6;
  const hMax = commission ? commission.hourEnd : 18;
  hourSlider.min = hMin;
  hourSlider.max = Math.max(hMax, hMin + 0.01);
  hourSlider.step = 0.05;
  hourSlider.value = state.sliderHour ?? hMin;
  hourSlider.className = 'slider';
  hourSlider.oninput = (e) => { state.sliderHour = Number(e.target.value); render(); };
  const hourLabel = el('label', 'slider-label', 'Hour within the window');
  hourLabel.appendChild(hourSlider);
  wrap.appendChild(hourLabel);

  // site picker
  const grid = el('div', 'site-grid');
  for (const id of S.SITE_IDS) {
    const site = S.SITES[id];
    const btn = el('button', 'site-btn' + (state.path.includes(id) ? ' selected' : ''), site.name);
    btn.onclick = () => toggleSite(id, commission);
    grid.appendChild(btn);
  }
  wrap.appendChild(grid);

  if (commission) {
    const actions = el('div', 'actions');
    const verifyBtn = el('button', 'btn primary', 'Verify the whole window');
    verifyBtn.disabled = state.path.length === 0;
    verifyBtn.onclick = () => {
      state.lastCheck = S.commissionCheck(commission, state.path, { dayStep: 1, hourStep: 0.1 });
      if (state.lastCheck.allMet) {
        state.save.completed[commission.id] = { path: [...state.path] };
        persist();
      }
      render();
    };
    actions.appendChild(verifyBtn);

    const clearBtn = el('button', 'btn', 'Clear mirrors');
    clearBtn.onclick = () => { state.path = []; state.lastCheck = null; render(); };
    actions.appendChild(clearBtn);
    wrap.appendChild(actions);

    if (state.lastCheck) {
      const result = el('div', 'result ' + (state.lastCheck.allMet ? 'ok' : 'fail'));
      if (state.lastCheck.allMet) {
        result.textContent = `Lit. ${state.lastCheck.total} moments checked, all clear.`;
      } else {
        const f = state.lastCheck.firstFailure;
        result.textContent = `Not yet — breaks on ${fmtDate(f.date)} around ${fmtHour(f.hour)} (${f.reason === 'sun-blocked-at-first-site' ? 'sun blocked at the first mirror' : f.reason === 'incidence-too-grazing' ? 'throw too grazing' : 'no mirror placed'}).`;
      }
      wrap.appendChild(result);

      if (state.save.completed[commission.id]) {
        const shareEl = el('p', 'share-text', S.shareText(commission, state.path));
        wrap.appendChild(shareEl);
        const nextBtn = el('button', 'btn primary', state.save.currentIndex + 1 < S.COMMISSIONS.length ? 'Next commission' : 'All twelve, lit — open the valley');
        nextBtn.onclick = () => {
          if (state.save.currentIndex + 1 < S.COMMISSIONS.length) {
            state.save.currentIndex += 1;
            persist();
            setupForCommission();
          } else {
            state.screen = 'freeplay';
          }
          render();
        };
        wrap.appendChild(nextBtn);
      }
    }
  }

  const titleBtn = el('button', 'btn ghost', 'Title screen');
  titleBtn.onclick = () => { state.screen = 'title'; render(); };
  wrap.appendChild(titleBtn);

  root.appendChild(wrap);
}

function toggleSite(id, commission) {
  const idx = state.path.indexOf(id);
  if (idx >= 0) {
    state.path.splice(idx, 1);
  } else {
    const budget = commission ? commission.budget : S.SITE_IDS.length;
    if (state.path.length >= budget) return; // budget spent
    state.path.push(id);
  }
  state.lastCheck = null;
  render();
}

// ---------- dev hook ----------

const params = new URLSearchParams(location.search);
if (params.get('dev') === '1') {
  window.__g = {
    state,
    commissions: S.COMMISSIONS,
    sites: S.SITES,
    goTitle: () => { state.screen = 'title'; render(); },
    goHowTo: () => { state.screen = 'howto'; render(); },
    goPlay: () => { state.screen = 'play'; setupForCommission(); render(); },
    goFreeplay: () => { state.screen = 'freeplay'; setupForCommission(); render(); },
    setCommissionIndex: (i) => { state.save.currentIndex = i; setupForCommission(); render(); },
    toggleSite: (id) => { toggleSite(id, activeCommission()); },
    setSliderDay: (d) => { state.sliderDay = d; render(); },
    setSliderHour: (h) => { state.sliderHour = h; render(); },
    verify: () => {
      const c = activeCommission();
      if (!c) return null;
      state.lastCheck = S.commissionCheck(c, state.path, { dayStep: 1, hourStep: 0.1 });
      if (state.lastCheck.allMet) { state.save.completed[c.id] = { path: [...state.path] }; persist(); }
      render();
      return state.lastCheck;
    },
    solve: () => {
      const c = activeCommission();
      if (!c) return null;
      const sol = S.solveCommission(c);
      if (sol) { state.path = [...sol.path]; render(); }
      return sol;
    },
    reset: () => { localStorage.removeItem(STORAGE_KEY); state.save = loadSave(); state.screen = 'title'; render(); },
    getState: () => JSON.parse(JSON.stringify({ screen: state.screen, path: state.path, save: state.save, sliderDay: state.sliderDay, sliderHour: state.sliderHour, lastCheck: state.lastCheck })),
  };
}

render();
