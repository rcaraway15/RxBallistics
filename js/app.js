// UI controller. All physics lives in ./solver/; all persistence in ./profiles.js.
import { solve } from './solver/index.js';
import { ProfileStore, loadState, saveState, STANDARD_ZERO, normalizeProfile } from './profiles.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const form = $('#inputs');
const store = new ProfileStore();

const DEFAULTS = {
  weightGr: 140, bc: 0.31, dragTable: 'G7', muzzleVelocityFps: 2700, sightHeightIn: 1.75, zeroRangeYd: 100,
  caliberIn: 0.264, lengthIn: 1.37, twistIn: 8, twistDirection: 'R',
  zTempF: STANDARD_ZERO.tempF, zHumidity: STANDARD_ZERO.humidity, zAltitudeFt: STANDARD_ZERO.altitudeFt, zPressureInHg: STANDARD_ZERO.pressureInHg,
  windMph: 10, windClock: 3, angleDeg: 0,
  tempF: 59, humidity: 50, altitudeFt: 0, pressureInHg: 29.92, latitudeDeg: '', azimuthDeg: '',
  maxRangeYd: 1000,
};

let currentProfileId = '';

// ---------------------------------------------------------------- setup
function buildSelects() {
  const clock = $('#windClock');
  const positions = [12, 0.5, ...Array.from({ length: 22 }, (_, i) => 1 + i * 0.5)];
  for (const v of positions) {
    const h = Math.floor(v) || 12;
    const label = `${h}:${v % 1 ? '30' : '00'}${v === 12 ? ' head' : v === 6 ? ' tail' : v === 3 || v === 9 ? ' full' : ''}`;
    clock.add(new Option(label, String(v)));
  }
  const max = $('#maxRangeYd');
  for (let r = 50; r <= 1750; r += 50) max.add(new Option(String(r), String(r)));
  max.add(new Option('1760 (1 mile)', '1760'));
}

// ---------------------------------------------------------------- form <-> model
function parseNum(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim().replace(',', '.').replace(/[−–]/g, '-');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function getField(name) {
  const els = form.elements[name];
  if (!els) return null;
  if (els instanceof RadioNodeList) return els.value;
  if (els.hasAttribute?.('data-num')) return parseNum(els.value);
  if (els.tagName === 'SELECT') return Number(els.value);
  return els.value;
}

function setField(name, value) {
  const els = form.elements[name];
  if (!els) return;
  if (els instanceof RadioNodeList) { els.value = value; return; }
  els.value = value === null || value === undefined ? '' : String(value);
}

function readForm() {
  const g = getField;
  const profile = {
    bullet: { weightGr: g('weightGr'), caliberIn: g('caliberIn'), lengthIn: g('lengthIn'), drag: { type: 'standard', table: g('dragTable'), bc: g('bc') } },
    rifle: { muzzleVelocityFps: g('muzzleVelocityFps'), sightHeightIn: g('sightHeightIn'), zeroRangeYd: g('zeroRangeYd'), twistIn: g('twistIn'), twistDirection: g('twistDirection') },
    shot: { windMph: g('windMph') ?? 0, windClock: g('windClock'), angleDeg: g('angleDeg') ?? 0 },
    zeroAtmosphere: { tempF: g('zTempF'), humidity: g('zHumidity'), altitudeFt: g('zAltitudeFt'), pressureInHg: g('zPressureInHg') },
  };
  const environment = { tempF: g('tempF'), humidity: g('humidity'), altitudeFt: g('altitudeFt'), pressureInHg: g('pressureInHg'), latitudeDeg: g('latitudeDeg'), azimuthDeg: g('azimuthDeg') };
  return { profile, environment, maxRangeYd: g('maxRangeYd') };
}

function writeProfileToForm(p) {
  setField('weightGr', p.bullet.weightGr);
  setField('caliberIn', p.bullet.caliberIn);
  setField('lengthIn', p.bullet.lengthIn);
  if (p.bullet.drag?.type === 'standard') {
    setField('bc', p.bullet.drag.bc);
    setField('dragTable', p.bullet.drag.table);
  }
  setField('muzzleVelocityFps', p.rifle.muzzleVelocityFps);
  setField('sightHeightIn', p.rifle.sightHeightIn);
  setField('zeroRangeYd', p.rifle.zeroRangeYd);
  setField('twistIn', p.rifle.twistIn);
  setField('twistDirection', p.rifle.twistDirection);
  setField('windMph', p.shot.windMph);
  setField('windClock', p.shot.windClock);
  setField('angleDeg', p.shot.angleDeg);
  setField('zTempF', p.zeroAtmosphere.tempF);
  setField('zHumidity', p.zeroAtmosphere.humidity);
  setField('zAltitudeFt', p.zeroAtmosphere.altitudeFt);
  setField('zPressureInHg', p.zeroAtmosphere.pressureInHg);
}

function writeFlat(obj) {
  for (const [k, v] of Object.entries(obj)) setField(k, v);
}

function snapshotFlat() {
  const out = {};
  for (const el of form.elements) if (el.name && !(el.type === 'radio' && !el.checked)) out[el.name] = el.value;
  out.__profileId = currentProfileId;
  return out;
}

// ---------------------------------------------------------------- solve & render
function fmt(n, d = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const t = n.toFixed(d);
  return /^-0\.?0*$/.test(t) ? t.slice(1) : t.replace('-', '−'); // no "−0.0"
}
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
/** Format a correction (positive = dial/hold right) as "L 0.4" / "R 0.4". */
function fmtLR(v, d) {
  const a = Math.abs(v);
  if (a < 0.5 * 10 ** -d) return (0).toFixed(d);
  return `${v > 0 ? 'R' : 'L'} ${a.toFixed(d)}`;
}

function validateInputs() {
  let ok = true;
  for (const el of $$('input[data-num]', form)) {
    const v = parseNum(el.value);
    const bad = Number.isNaN(v) || (el.required && v === null);
    el.classList.toggle('invalid', bad);
    if (bad) ok = false;
  }
  return ok;
}

function compute() {
  const { profile, environment, maxRangeYd } = readForm();
  const errEl = $('#solve-error');
  const tbody = $('#table tbody');
  updateDirty(profile);
  updateZeroSummary(profile.zeroAtmosphere);
  drawClock(profile.shot.windClock);
  saveState(snapshotFlat());

  if (!validateInputs()) {
    errEl.textContent = 'Check the highlighted fields.';
    errEl.hidden = false;
    return;
  }
  const z = profile.zeroAtmosphere;
  const zeroAtmosphere = {
    tempF: z.tempF ?? STANDARD_ZERO.tempF, humidity: z.humidity ?? STANDARD_ZERO.humidity,
    altitudeFt: z.altitudeFt ?? STANDARD_ZERO.altitudeFt, pressureInHg: z.pressureInHg ?? STANDARD_ZERO.pressureInHg,
  };
  const atmosphere = {
    tempF: environment.tempF ?? 59, humidity: environment.humidity ?? 0,
    altitudeFt: environment.altitudeFt ?? 0, pressureInHg: environment.pressureInHg ?? 29.92,
  };

  let result;
  try {
    result = solve({
      bullet: { ...profile.bullet, caliberIn: profile.bullet.caliberIn ?? undefined, lengthIn: profile.bullet.lengthIn ?? undefined },
      rifle: { ...profile.rifle, twistIn: profile.rifle.twistIn ?? undefined },
      zeroAtmosphere,
      atmosphere,
      shot: {
        ...profile.shot,
        latitudeDeg: environment.latitudeDeg ?? undefined,
        azimuthDeg: environment.azimuthDeg ?? undefined,
      },
      table: { maxRangeYd, stepYd: 50 },
    });
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
    tbody.replaceChildren();
    $('#banners').replaceChildren();
    $('#summary').replaceChildren();
    return;
  }
  errEl.hidden = true;
  renderBanners(result, maxRangeYd);
  renderSummary(result, profile);
  renderTable(result, profile.rifle.zeroRangeYd);
}

function renderBanners(res, maxRangeYd) {
  const box = $('#banners');
  box.replaceChildren();
  const add = (cls, text) => { const d = document.createElement('div'); d.className = `banner ${cls}`; d.textContent = text; box.append(d); };
  const { cautionYd, warningYd } = res.transonic;
  const at = (yd) => (yd === 0 ? 'at the muzzle' : `at ~${Math.round(yd)} yd`);
  if (cautionYd !== null) add('caution', `▲ Transonic: below Mach 1.2 ${at(cautionYd)}. Drag predictions become less reliable.`);
  if (warningYd !== null) add('warning', `⚠ Subsonic: below Mach 1.0 ${at(warningYd)}. Expect less predictable drift and dispersion.`);
  if (res.truncated) add('warning', `Trajectory ended near ${Math.round(res.reachedYd)} yd (velocity too low). Table stops short of ${maxRangeYd} yd.`);
}

function renderSummary(res, profile) {
  const dl = $('#summary');
  const items = [
    ['Zero angle', `${fmt(res.boreAngleRad * 1000, 2)} mrad`],
    ['Mach 1', `${fmtInt(res.atmosphere.speedOfSoundFps)} fps`],
    ['Air density', `${fmt(res.atmosphere.densityRatio * 100, 1)}% std`],
    ['Station press.', `${fmt(res.atmosphere.stationPressureInHg, 2)} inHg`],
  ];
  if (res.stability === null) items.push(['Spin drift', 'off (need caliber, length, twist)']);
  else {
    const sg = res.stability;
    const tag = sg < 1 ? ' UNSTABLE' : sg < 1.4 ? ' marginal' : '';
    items.push(['Stability (Sg)', `${fmt(sg, 2)}${tag}`]);
  }
  items.push(['Coriolis', res.coriolis ? 'on' : 'off']);
  dl.replaceChildren(...items.map(([k, v]) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    if (/UNSTABLE|marginal/.test(v)) dd.classList.add('error');
    div.append(dt, dd);
    return div;
  }));
  $('#legend-coriolis').textContent = res.coriolis ? ' and Coriolis' : '';
}

function renderTable(res, zeroRangeYd) {
  const tbody = $('#table tbody');
  const frag = document.createDocumentFragment();
  for (const r of res.rows) {
    const tr = document.createElement('tr');
    if (r.speedZone === 'subsonic') tr.className = 'warning';
    else if (r.speedZone === 'transonic') tr.className = 'caution';
    if (Math.abs(r.rangeYd - zeroRangeYd) < 1e-6) tr.classList.add('zero-row');
    const cells = [
      [String(r.rangeYd)],
      [fmt(r.dropIn, 1)],
      [fmt(r.elevationMrad, 1), 'dial'],
      [fmtLR(-r.windIn, 1)], // drift right → correct left
      [fmtLR(r.windageMrad, 1), 'dial'],
      [fmtInt(r.velocityFps)],
      [fmtInt(r.energyFtLb)],
      [r.timeS.toFixed(3)],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

function updateZeroSummary(z) {
  const s = (v, d) => (v === null || v === undefined ? '–' : v);
  $('#zero-summary').textContent = `${s(z.tempF)}°F · ${s(z.humidity)}% · ${s(z.altitudeFt)} ft · ${s(z.pressureInHg)} inHg`;
}

function drawClock(clock) {
  const svg = $('#clock');
  const ang = ((clock ?? 0) % 12) * 30 * Math.PI / 180;
  const sx = Math.sin(ang), sy = -Math.cos(ang);
  const r0 = 30, r1 = 12;
  const x0 = sx * r0, y0 = sy * r0, x1 = sx * r1, y1 = sy * r1;
  // arrow head at inner end, pointing toward the shooter
  const hx = -sx, hy = -sy, px = -hy, py = hx;
  const head = `${x1 + hx * 2},${y1 + hy * 2} ${x1 - hx * 8 + px * 6},${y1 - hy * 8 + py * 6} ${x1 - hx * 8 - px * 6},${y1 - hy * 8 - py * 6}`;
  svg.innerHTML = `
    <circle class="face" r="46"/>
    <text class="tick" x="0" y="-38">12</text><text class="tick" x="38" y="0">3</text>
    <text class="tick" x="0" y="38">6</text><text class="tick" x="-38" y="0">9</text>
    <polygon class="shooter" points="0,-7 5,5 -5,5"/>
    ${getField('windMph') ? `<line class="arrow" x1="${x0}" y1="${y0}" x2="${x1 - hx * 6}" y2="${y1 - hy * 6}"/><polygon class="head" points="${head}"/>` : ''}`;
}

// ---------------------------------------------------------------- profiles
function profileDataEqual(a, b) {
  const strip = (p) => { const n = normalizeProfile(p); delete n.id; delete n.name; delete n.createdAt; delete n.updatedAt; return JSON.stringify(n); };
  return strip(a) === strip(b);
}

function updateDirty(profile) {
  const p = currentProfileId ? store.get(currentProfileId) : null;
  $('#profile-dirty').hidden = !p || profileDataEqual(p, profile);
}

function renderProfileSelect() {
  const sel = $('#profile-select');
  sel.replaceChildren(new Option(store.profiles.length ? '— Unsaved / new —' : '— No saved profiles —', ''));
  for (const p of store.list()) sel.add(new Option(p.name, p.id));
  sel.value = currentProfileId;
}

function flash(msg) {
  const el = $('#profile-msg');
  el.textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.textContent = ''; }, 4000);
}

function selectProfile(id) {
  currentProfileId = id;
  const p = id ? store.get(id) : null;
  if (p) writeProfileToForm(p);
  renderProfileSelect();
  compute();
}

function currentProfileData() {
  return normalizeProfile(readForm().profile);
}

const actions = {
  save() {
    if (!currentProfileId) return actions['save-new']();
    store.update(currentProfileId, currentProfileData());
    flash(`Saved "${store.get(currentProfileId).name}".`);
    compute();
  },
  'save-new'() {
    const name = prompt('Profile name:', currentProfileId ? `${store.get(currentProfileId).name} copy` : '');
    if (name === null || !name.trim()) return;
    const p = store.create(name, currentProfileData());
    selectProfile(p.id);
    flash(`Saved "${p.name}".`);
  },
  rename() {
    if (!currentProfileId) return flash('Select a saved profile first.');
    const p = store.get(currentProfileId);
    const name = prompt('New name:', p.name);
    if (name === null) return;
    try { store.rename(p.id, name); } catch (e) { return flash(e.message); }
    renderProfileSelect();
    flash(`Renamed to "${store.get(p.id).name}".`);
  },
  duplicate() {
    if (!currentProfileId) return flash('Select a saved profile first.');
    const p = store.duplicate(currentProfileId);
    selectProfile(p.id);
    flash(`Created "${p.name}".`);
  },
  delete() {
    if (!currentProfileId) return flash('Select a saved profile first.');
    const p = store.get(currentProfileId);
    if (!confirm(`Delete profile "${p.name}"? This cannot be undone.`)) return;
    store.remove(p.id);
    currentProfileId = '';
    renderProfileSelect();
    compute();
    flash(`Deleted "${p.name}".`);
  },
  async export() {
    if (!store.profiles.length) return flash('No saved profiles to export.');
    const json = store.exportJSON();
    const name = `ballistic-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Ballistic profiles' });
        return flash('Exported.');
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    flash(`Exported ${store.profiles.length} profile(s).`);
  },
  import() {
    $('#import-file').click();
  },
};

// ---------------------------------------------------------------- events
let timer;
function scheduleCompute() {
  clearTimeout(timer);
  timer = setTimeout(compute, 120);
}

function bind() {
  form.addEventListener('input', scheduleCompute);
  form.addEventListener('change', scheduleCompute);
  form.addEventListener('submit', (e) => e.preventDefault());

  // ± buttons for signed fields (iOS decimal keypad has no minus key)
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('.pm');
    if (!btn) return;
    const input = btn.parentElement.querySelector('input');
    const v = input.value.trim();
    input.value = v.startsWith('-') ? v.slice(1) : `-${v}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Select all on focus for quick overwrite
  form.addEventListener('focusin', (e) => {
    if (e.target.matches('input[data-num]')) setTimeout(() => e.target.select(), 0);
  });

  $('#profile-select').addEventListener('change', (e) => {
    const id = e.target.value;
    const { profile } = readForm();
    const cur = currentProfileId && store.get(currentProfileId);
    if (cur && !profileDataEqual(cur, profile) && !confirm('Discard unsaved changes to this profile?')) {
      e.target.value = currentProfileId;
      return;
    }
    selectProfile(id);
  });

  $$('[data-action]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.action]()));

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { added, replaced, skipped } = store.importJSON(await file.text());
      renderProfileSelect();
      flash(`Imported: ${added} added, ${replaced} updated${skipped ? `, ${skipped} skipped` : ''}.`);
    } catch (err) {
      flash(`Import failed: ${err.message}`);
    }
  });

  $('#zero-standard').addEventListener('click', () => {
    writeFlat({ zTempF: STANDARD_ZERO.tempF, zHumidity: STANDARD_ZERO.humidity, zAltitudeFt: STANDARD_ZERO.altitudeFt, zPressureInHg: STANDARD_ZERO.pressureInHg });
    compute();
  });
  $('#zero-from-env').addEventListener('click', () => {
    const f = (n) => form.elements[n].value;
    writeFlat({ zTempF: f('tempF'), zHumidity: f('humidity'), zAltitudeFt: f('altitudeFt'), zPressureInHg: f('pressureInHg') });
    compute();
  });

  $('#theme-toggle').addEventListener('click', () => {
    const red = document.documentElement.dataset.theme !== 'red';
    document.documentElement.dataset.theme = red ? 'red' : '';
    document.querySelector('meta[name=theme-color]').content = red ? '#000000' : '#0d1117';
    localStorage.setItem('ballistics.theme', red ? 'red' : '');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const status = $('#sw-status');
  navigator.serviceWorker.register('sw.js').then((reg) => {
    status.textContent = 'Works offline.';
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) status.textContent = 'Update downloaded. Close and reopen the app to use it.';
      });
    });
  }).catch(() => { status.textContent = ''; });
}

// ---------------------------------------------------------------- init
function init() {
  if (localStorage.getItem('ballistics.theme') === 'red') {
    document.documentElement.dataset.theme = 'red';
    document.querySelector('meta[name=theme-color]').content = '#000000';
  }
  buildSelects();
  const state = loadState();
  writeFlat({ ...DEFAULTS, ...(state || {}) });
  currentProfileId = state?.__profileId && store.get(state.__profileId) ? state.__profileId : '';
  renderProfileSelect();
  bind();
  compute();
  registerServiceWorker();
}

init();
