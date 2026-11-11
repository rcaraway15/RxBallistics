// Point-mass (3-DOF) exterior ballistics solver.
//
// Frame: integration happens in the line-of-sight (LOS) frame.
//   x' = along the line of sight (downrange), y' = perpendicular "up", z = right.
// The shooting angle is applied by rotating gravity (and wind / Earth-rotation
// vectors) into this frame, so table distances are LOS distances and drops are
// measured perpendicular to the line of sight (what you dial).
//
// Integration: classic RK4 with a small fixed time step; table rows are linearly
// interpolated between steps at exact range crossings.

import { resolveAtmosphere, atHeight, STANDARD } from './atmosphere.js';
import { createDragModel, DRAG_CONSTANT } from './drag.js';

export const GRAVITY_FPS2 = 32.17405;
export const EARTH_OMEGA = 7.2921159e-5; // rad/s
const MPH_TO_FPS = 5280 / 3600;
const YD = 3; // ft
const DEG = Math.PI / 180;

export const DEFAULTS = Object.freeze({
  dt: 0.0005, // s
  minVelocityFps: 100,
  maxTimeS: 30,
});

/** Miller twist-rule gyroscopic stability factor. Returns null if inputs are missing. */
export function millerStability({ weightGr, caliberIn, lengthIn, twistIn, muzzleVelocityFps, tempF, stationPressureInHg }) {
  if (!(weightGr > 0 && caliberIn > 0 && lengthIn > 0 && twistIn > 0)) return null;
  const t = twistIn / caliberIn;
  const l = lengthIn / caliberIn;
  const sg = (30 * weightGr) / (t * t * Math.pow(caliberIn, 3) * l * (1 + l * l));
  const fv = Math.cbrt((muzzleVelocityFps || 2800) / 2800);
  const fa = ((tempF + 460) / (59 + 460)) * (29.92 / stationPressureInHg);
  return sg * fv * fa;
}

/** Litz spin-drift approximation, inches (positive = direction of twist). */
export function litzSpinDriftIn(sg, tofS) {
  if (!(sg > 0) || !(tofS > 0)) return 0;
  return 1.25 * (sg + 1.2) * Math.pow(tofS, 1.83);
}

/** Wind vector (ft/s) in the horizontal ground frame [downrange, up, right] from a clock position. */
export function windFromClock(speedMph, clock) {
  const w = (speedMph || 0) * MPH_TO_FPS;
  const th = ((clock || 0) % 12) * 30 * DEG;
  // Wind *from* the clock direction: 12 blows toward the shooter, 3 blows right→left.
  return [-w * Math.cos(th), 0, -w * Math.sin(th)];
}

/** Earth rotation vector in the ground frame [downrange, up, right]. */
export function earthRotation(latitudeDeg, azimuthDeg) {
  const lat = latitudeDeg * DEG;
  const az = azimuthDeg * DEG;
  return [
    EARTH_OMEGA * Math.cos(lat) * Math.cos(az),
    EARTH_OMEGA * Math.sin(lat),
    -EARTH_OMEGA * Math.cos(lat) * Math.sin(az),
  ];
}

// Rotate a ground-frame vector [X, Y, Z] into the LOS frame tilted by angle a.
function toLos([X, Y, Z], ca, sa) {
  return [ca * X + sa * Y, -sa * X + ca * Y, Z];
}

/**
 * Integrate one trajectory and sample it at the requested LOS ranges.
 * Low-level: callers normally use solve() or zeroAngle().
 *
 * @returns {{samples:Array, transonic:{cautionYd:number|null, warningYd:number|null}, reachedYd:number}}
 */
export function integrate({ drag, muzzleVelocityFps, sightHeightIn, boreAngleRad, atmo, losAngleRad = 0,
  windGround = [0, 0, 0], omegaGround = null, rangesYd, dt = DEFAULTS.dt,
  minVelocityFps = DEFAULTS.minVelocityFps, maxTimeS = DEFAULTS.maxTimeS }) {
  const ca = Math.cos(losAngleRad);
  const sa = Math.sin(losAngleRad);
  const g = [-GRAVITY_FPS2 * sa, -GRAVITY_FPS2 * ca, 0];
  const wind = toLos(windGround, ca, sa);
  const om = omegaGround ? toLos(omegaGround, ca, sa) : null;
  const trackAltitude = losAngleRad !== 0;

  // state: x, y, z, vx, vy, vz (ft, ft/s)
  let s = [0, -sightHeightIn / 12, 0, muzzleVelocityFps * Math.cos(boreAngleRad), muzzleVelocityFps * Math.sin(boreAngleRad), 0];
  let t = 0;

  const deriv = (st, out) => {
    const rvx = st[3] - wind[0];
    const rvy = st[4] - wind[1];
    const rvz = st[5] - wind[2];
    const vRel = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    let dens = atmo.densityRatio;
    let sos = atmo.speedOfSoundFps;
    if (trackAltitude) [dens, sos] = atHeight(atmo, sa * st[0] + ca * st[1]);
    const v = Math.sqrt(st[3] * st[3] + st[4] * st[4] + st[5] * st[5]);
    const kd = DRAG_CONSTANT * dens * drag.k(vRel / sos, v) * vRel;
    let ax = -kd * rvx + g[0];
    let ay = -kd * rvy + g[1];
    let az = -kd * rvz + g[2];
    if (om) {
      // Coriolis acceleration: -2 Ω × v
      ax += -2 * (om[1] * st[5] - om[2] * st[4]);
      ay += -2 * (om[2] * st[3] - om[0] * st[5]);
      az += -2 * (om[0] * st[4] - om[1] * st[3]);
    }
    out[0] = st[3]; out[1] = st[4]; out[2] = st[5];
    out[3] = ax; out[4] = ay; out[5] = az;
  };

  const k1 = new Array(6), k2 = new Array(6), k3 = new Array(6), k4 = new Array(6), tmp = new Array(6);
  const step = () => {
    deriv(s, k1);
    for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * dt * k1[i];
    deriv(tmp, k2);
    for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * dt * k2[i];
    deriv(tmp, k3);
    for (let i = 0; i < 6; i++) tmp[i] = s[i] + dt * k3[i];
    deriv(tmp, k4);
    const n = new Array(6);
    for (let i = 0; i < 6; i++) n[i] = s[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    return n;
  };

  const machOf = (st) => {
    const sos = trackAltitude ? atHeight(atmo, sa * st[0] + ca * st[1])[1] : atmo.speedOfSoundFps;
    return Math.hypot(st[3], st[4], st[5]) / sos;
  };

  const targets = [...rangesYd].sort((a, b) => a - b).map((r) => r * YD);
  const samples = [];
  let ti = 0;
  const transonic = { cautionYd: null, warningYd: null };
  let prevMach = machOf(s);

  const sample = (st, time, rangeFt) => {
    const v = Math.hypot(st[3], st[4], st[5]);
    samples.push({ rangeYd: rangeFt / YD, yFt: st[1], zFt: st[2], velocityFps: v, timeS: time, mach: machOf(st) });
  };

  while (ti < targets.length && targets[ti] <= 0) { sample(s, 0, 0); ti++; }

  while (ti < targets.length && t < maxTimeS) {
    const n = step();
    const tn = t + dt;
    const nMach = machOf(n);
    for (const [key, thr] of [['cautionYd', 1.2], ['warningYd', 1.0]]) {
      if (transonic[key] === null && prevMach >= thr && nMach < thr) {
        const f = (prevMach - thr) / (prevMach - nMach);
        transonic[key] = (s[0] + f * (n[0] - s[0])) / YD;
      }
    }
    while (ti < targets.length && n[0] >= targets[ti]) {
      const f = (targets[ti] - s[0]) / (n[0] - s[0]);
      const st = s.map((v, i) => v + f * (n[i] - v));
      sample(st, t + f * dt, targets[ti]);
      ti++;
    }
    s = n;
    t = tn;
    prevMach = nMach;
    if (Math.hypot(s[3], s[4], s[5]) < minVelocityFps || s[3] <= 0) break;
  }
  if (transonic.cautionYd === null && prevMach < 1.2 && samples.length && samples[0].mach < 1.2) transonic.cautionYd = 0;
  if (transonic.warningYd === null && prevMach < 1.0 && samples.length && samples[0].mach < 1.0) transonic.warningYd = 0;
  return { samples, transonic, reachedYd: s[0] / YD };
}

/**
 * Bore angle (radians, relative to the line of sight) that puts the bullet on the
 * line of sight at the zero range, in the given (zero) atmosphere. Level, no wind.
 */
export function zeroAngle({ drag, muzzleVelocityFps, sightHeightIn, zeroRangeYd, atmo, dt = DEFAULTS.dt }) {
  const yAt = (ang) => {
    const r = integrate({ drag, muzzleVelocityFps, sightHeightIn, boreAngleRad: ang, atmo, rangesYd: [zeroRangeYd], dt });
    if (!r.samples.length) throw new Error(`Zero range ${zeroRangeYd} yd is out of reach`);
    return r.samples[0].yFt;
  };
  const R = zeroRangeYd * YD;
  let a0 = Math.atan((sightHeightIn / 12) / R);
  let y0 = yAt(a0);
  let a1 = a0 - y0 / R;
  for (let i = 0; i < 30; i++) {
    const y1 = yAt(a1);
    if (Math.abs(y1) < 1e-6) return a1;
    const a2 = a1 - (y1 * (a1 - a0)) / (y1 - y0);
    a0 = a1; y0 = y1; a1 = a2;
  }
  return a1;
}

/** Build the list of table ranges: every step up to max, plus max itself (e.g. 1760). */
export function tableRanges(maxRangeYd, stepYd = 50, startYd = stepYd) {
  const out = [];
  for (let r = startYd; r <= maxRangeYd + 1e-9; r += stepYd) out.push(r);
  if (out[out.length - 1] !== maxRangeYd) out.push(maxRangeYd);
  return out;
}

const hasNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Full solution for the UI.
 *
 * input = {
 *   bullet: { weightGr, caliberIn, lengthIn, drag: {type:'standard', table:'G7', bc:0.3} },
 *   rifle:  { muzzleVelocityFps, sightHeightIn, zeroRangeYd, twistIn, twistDirection:'R'|'L' },
 *   zeroAtmosphere: { tempF, humidity, altitudeFt, pressureInHg },   // defaults to standard
 *   atmosphere:     { tempF, humidity, altitudeFt, pressureInHg },   // current conditions
 *   shot: { windMph, windClock, angleDeg, latitudeDeg?, azimuthDeg? },
 *   table: { maxRangeYd, stepYd = 50, startYd = stepYd } or ranges: [...]
 *   options: { dt, spinDrift = true }
 * }
 */
export function solve(input) {
  const { bullet, rifle, shot = {}, options = {} } = input;
  const dt = options.dt ?? DEFAULTS.dt;
  validate(input);
  const drag = createDragModel(bullet.drag, bullet);
  const zeroAtmo = resolveAtmosphere(input.zeroAtmosphere ?? STANDARD);
  const atmo = resolveAtmosphere(input.atmosphere ?? STANDARD);

  const boreAngleRad = options.boreAngleRad ?? zeroAngle({
    drag, muzzleVelocityFps: rifle.muzzleVelocityFps, sightHeightIn: rifle.sightHeightIn,
    zeroRangeYd: rifle.zeroRangeYd, atmo: zeroAtmo, dt,
  });

  const ranges = input.ranges ?? tableRanges(input.table?.maxRangeYd ?? 1000, input.table?.stepYd ?? 50, input.table?.startYd);
  const coriolis = hasNum(shot.latitudeDeg) && hasNum(shot.azimuthDeg);
  const angleRad = (shot.angleDeg || 0) * DEG;

  const run = integrate({
    drag,
    muzzleVelocityFps: rifle.muzzleVelocityFps,
    sightHeightIn: rifle.sightHeightIn,
    boreAngleRad,
    atmo,
    losAngleRad: angleRad,
    windGround: windFromClock(shot.windMph, shot.windClock),
    omegaGround: coriolis ? earthRotation(shot.latitudeDeg, shot.azimuthDeg) : null,
    rangesYd: ranges,
    dt,
  });

  const stability = millerStability({
    weightGr: bullet.weightGr, caliberIn: bullet.caliberIn, lengthIn: bullet.lengthIn,
    twistIn: rifle.twistIn, muzzleVelocityFps: rifle.muzzleVelocityFps,
    tempF: atmo.tempF, stationPressureInHg: atmo.stationPressureInHg,
  });
  const spinSign = rifle.twistDirection === 'L' ? -1 : 1;
  const useSpin = options.spinDrift !== false && stability !== null;

  const rows = run.samples.map((p) => {
    const rangeIn = p.rangeYd * 36;
    const spinIn = useSpin ? spinSign * litzSpinDriftIn(stability, p.timeS) : 0;
    const dropIn = p.yFt * 12;
    const windIn = p.zFt * 12 + spinIn;
    const mrad = (inches) => (rangeIn > 0 ? Math.atan(inches / rangeIn) * 1000 : 0);
    return {
      rangeYd: p.rangeYd,
      dropIn, // path relative to line of sight; negative = below
      elevationMrad: -mrad(dropIn), // dial value; positive = come up
      windIn, // positive = impact right of aim (includes spin drift)
      windageMrad: -mrad(windIn), // dial value; positive = dial right, negative = dial left
      spinDriftIn: spinIn,
      velocityFps: p.velocityFps,
      energyFtLb: (bullet.weightGr * p.velocityFps * p.velocityFps) / 450240,
      timeS: p.timeS,
      mach: p.mach,
      speedZone: p.mach < 1.0 ? 'subsonic' : p.mach < 1.2 ? 'transonic' : 'supersonic',
    };
  });

  return {
    rows,
    boreAngleRad,
    stability,
    transonic: run.transonic,
    reachedYd: run.reachedYd,
    truncated: rows.length < ranges.length,
    coriolis,
    atmosphere: atmo,
    zeroAtmosphere: zeroAtmo,
  };
}

function validate({ bullet, rifle }) {
  const req = [
    ['bullet weight', bullet?.weightGr], ['muzzle velocity', rifle?.muzzleVelocityFps],
    ['zero range', rifle?.zeroRangeYd],
  ];
  for (const [name, v] of req) if (!(v > 0)) throw new Error(`Enter a valid ${name}`);
  if (!hasNum(rifle.sightHeightIn)) throw new Error('Enter a valid sight height');
}
