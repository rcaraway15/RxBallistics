// Solver unit tests. Run: npm test   (Node 18+, no dependencies)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  solve, tableRanges, millerStability, litzSpinDriftIn, resolveAtmosphere, stationPressureInHg,
  speedOfSoundFps, createDragModel, G7, STANDARD,
} from '../js/solver/index.js';
import { loadGehtsoft, dirToClock } from './reference/loadGehtsoft.js';

const MOA_IN_PER_100YD = 1.047198;
const inPerMoa = (yd) => (yd / 100) * MOA_IN_PER_100YD;
const MOA = Math.PI / 180 / 60;

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: got ${actual.toFixed(4)}, expected ${expected} ±${tol.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// 1. Full reference trajectories (JBM-format tables, 50 yd steps to 1000 yd)
// ---------------------------------------------------------------------------
function runReference(name) {
  const r = loadGehtsoft(name);
  // Reference files give station pressure directly (no altitude correction).
  const env = { tempF: r.tempF, humidity: r.humidity, altitudeFt: r.altitudeFt, pressureInHg: r.pressureInHg, pressureIsStation: true };
  const out = solve({
    bullet: { weightGr: r.weightGr, caliberIn: r.caliberIn, lengthIn: r.lengthIn, drag: { type: 'standard', table: r.table, bc: r.bc } },
    rifle: { muzzleVelocityFps: r.mv, sightHeightIn: r.sightHeightIn, zeroRangeYd: r.zeroYd, twistIn: r.twistIn, twistDirection: r.twistDirection },
    zeroAtmosphere: env,
    atmosphere: env,
    shot: { windMph: r.windMph || 0, windClock: dirToClock(r.windDirDeg || 0), angleDeg: r.angleDeg || 0 },
    ranges: r.rows.map((x) => x.rangeYd),
  });
  return { r, out };
}

const REFERENCE_CASES = [
  // name, description
  ['g1_nowind', 'G1 0.365, 65 gr @ 2600 fps, 100 yd zero, no wind'],
  ['g1_wind', 'G1 0.365, 65 gr @ 2600 fps, 20 mph wind'],
  ['g1_wind_hot', 'G1 0.465, 65 gr @ 3200 fps, 80°F / 50% / 29.5 inHg, 15 mph wind'],
  ['g1_wind_cold', 'G1 0.465, 65 gr @ 3200 fps, 10°F / 5% / 32 inHg, 15 mph wind'],
  ['g1_twist', 'G1 0.500, 220 gr @ 3006.6 fps, 1:12 R twist (spin drift)'],
  ['g7_nowind', 'G7 0.465, 65 gr @ 3200 fps, 300 yd zero'],
  ['g1_nowind_up_supersonic', 'G1 0.447, 165 gr @ 3100 fps, +10° uphill'],
];

describe('reference trajectories (50 yd rows to 1000 yd)', () => {
  for (const [name, desc] of REFERENCE_CASES) {
    test(`${name}: ${desc}`, () => {
      const { r, out } = runReference(name);
      assert.equal(out.rows.length, r.rows.length, 'row count');
      r.rows.forEach((ref, i) => {
        const row = out.rows[i];
        const at = `@${ref.rangeYd} yd`;
        near(row.velocityFps, ref.velocityFps, Math.max(0.0015 * ref.velocityFps, 0.1), `velocity ${at}`);
        if (ref.rangeYd === 0) return;
        // Tolerance: 0.10 MOA, floored at 0.06" to absorb the references' 0.1" rounding.
        const tol = Math.max(0.1 * inPerMoa(ref.rangeYd), 0.06);
        near(row.dropIn, ref.dropIn, tol, `drop ${at}`);
        near(row.windIn, ref.windIn, tol, `windage ${at}`);
        near(row.timeS, ref.timeS, 0.002, `time ${at}`);
        near(row.energyFtLb, ref.energyFtLb, Math.max(0.0035 * ref.energyFtLb, 0.6), `energy ${at}`);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. JBM-derived checkpoints from the py-ballisticcalc test suite (test_trajectory.py)
//    168 gr .308, BC 0.223, 2750 fps, 2" sight, ICAO atmosphere, 5 mph wind from 4:30.
// ---------------------------------------------------------------------------
const ICAO = { tempF: 59, humidity: 0, altitudeFt: 0, pressureInHg: 29.92 };
const PBC_CASES = [
  {
    name: 'G1 0.223, 168 gr @ 2750 fps, bore 0.001228 rad, no twist',
    table: 'G1', boreAngleRad: 0.001228, twistIn: undefined,
    rows: [
      // range, velocity, energy, path(in), windage(in), time
      [100, 2351.2, 2061, 0, -0.6, 0.118],
      [500, 1169.1, 509.8, -87.9, -19.5, 0.857],
      [1000, 776.4, 224.9, -823.9, -87.5, 2.495],
    ],
  },
  {
    name: 'G7 0.223, 168 gr @ 2750 fps, bore 4.221 MOA, 1:12 R twist (spin drift)',
    table: 'G7', boreAngleRad: 4.221 * MOA, twistIn: 12,
    rows: [
      [100, 2545, 2416, 0, -0.2, 0.113],
      [500, 1814, 1227, -56.2, -6.3, 0.672],
      [1000, 1086, 440, -399.9, -31.6, 1.748],
    ],
  },
];

describe('JBM-derived checkpoints (py-ballisticcalc suite)', () => {
  for (const c of PBC_CASES) {
    test(c.name, () => {
      const out = solve({
        bullet: { weightGr: 168, caliberIn: 0.308, lengthIn: 1.282, drag: { type: 'standard', table: c.table, bc: 0.223 } },
        rifle: { muzzleVelocityFps: 2750, sightHeightIn: 2, zeroRangeYd: 100, twistIn: c.twistIn, twistDirection: 'R' },
        zeroAtmosphere: ICAO, atmosphere: ICAO,
        shot: { windMph: 5, windClock: 4.5 },
        ranges: c.rows.map((r) => r[0]),
        options: { boreAngleRad: c.boreAngleRad },
      });
      c.rows.forEach(([yd, v, e, path, wind, t], i) => {
        const row = out.rows[i];
        near(row.velocityFps, v, 0.005 * v, `velocity @${yd}`);
        near(row.energyFtLb, e, 0.01 * e, `energy @${yd}`);
        near(row.dropIn, path, Math.max(0.15 * inPerMoa(yd), 0.15), `drop @${yd}`);
        near(row.windIn, wind, Math.max(0.1 * inPerMoa(yd), 0.06), `windage @${yd}`);
        near(row.timeS, t, 0.003, `time @${yd}`);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Atmosphere
// ---------------------------------------------------------------------------
describe('atmosphere', () => {
  test('ICAO standard has density ratio 1 and Mach 1 ≈ 1116.4 fps', () => {
    const a = resolveAtmosphere(STANDARD);
    near(a.densityRatio, 1, 0.0005, 'density ratio');
    near(a.speedOfSoundFps, 1116.45, 0.1, 'speed of sound');
  });
  test('altimeter setting → station pressure', () => {
    near(stationPressureInHg(29.92, 0), 29.92, 1e-9, 'sea level');
    near(stationPressureInHg(29.92, 5000), 24.896, 0.01, '5000 ft');
    near(stationPressureInHg(30.10, 10000), 20.69, 0.02, '10000 ft');
  });
  test('humidity and heat lower density; cold raises it', () => {
    const base = resolveAtmosphere({ ...STANDARD });
    assert.ok(resolveAtmosphere({ ...STANDARD, humidity: 100 }).densityRatio < base.densityRatio);
    assert.ok(resolveAtmosphere({ ...STANDARD, tempF: 100 }).densityRatio < base.densityRatio);
    assert.ok(resolveAtmosphere({ ...STANDARD, tempF: 0 }).densityRatio > base.densityRatio);
  });
  test('speed of sound depends on temperature', () => {
    assert.ok(speedOfSoundFps(90) > speedOfSoundFps(20));
  });
  test('weather-app pressure at altitude matches equivalent station pressure', () => {
    const load = sampleLoad();
    const a = solve({ ...load, atmosphere: { tempF: 50, humidity: 30, altitudeFt: 6000, pressureInHg: 30.05 } });
    const st = stationPressureInHg(30.05, 6000);
    const b = solve({ ...load, atmosphere: { tempF: 50, humidity: 30, altitudeFt: 6000, pressureInHg: st, pressureIsStation: true } });
    near(a.rows.at(-1).dropIn, b.rows.at(-1).dropIn, 1e-9, 'drop');
  });
});

// ---------------------------------------------------------------------------
// 4. Behaviour of individual effects
// ---------------------------------------------------------------------------
function sampleLoad(overrides = {}) {
  return {
    bullet: { weightGr: 140, caliberIn: 0.264, lengthIn: 1.40, drag: { type: 'standard', table: 'G7', bc: 0.315 } },
    rifle: { muzzleVelocityFps: 2710, sightHeightIn: 1.9, zeroRangeYd: 100, twistIn: 8, twistDirection: 'R' },
    shot: { windMph: 0, windClock: 3, angleDeg: 0 },
    table: { maxRangeYd: 1000 },
    ...overrides,
  };
}

describe('zero handling', () => {
  test('bullet crosses the line of sight at the zero range in zero conditions', () => {
    const out = solve({ ...sampleLoad(), ranges: [100] });
    near(out.rows[0].dropIn, 0, 0.005, 'drop at zero');
  });
  test('zero angle is solved in zero conditions and reused in current conditions', () => {
    const zeroAtmosphere = { tempF: 30, humidity: 50, altitudeFt: 0, pressureInHg: 30.2 };
    const hot = { tempF: 100, humidity: 50, altitudeFt: 6000, pressureInHg: 29.9 };
    const sameConds = solve({ ...sampleLoad(), zeroAtmosphere, atmosphere: zeroAtmosphere, ranges: [100, 800] });
    const changed = solve({ ...sampleLoad(), zeroAtmosphere, atmosphere: hot, ranges: [100, 800] });
    assert.equal(changed.boreAngleRad, sameConds.boreAngleRad);
    near(sameConds.rows[0].dropIn, 0, 0.005, 'on zero in same conditions');
    assert.ok(changed.rows[1].dropIn > sameConds.rows[1].dropIn, 'thinner air → less drop at 800 yd');
  });
});

describe('shooting angle', () => {
  test('uphill and downhill both reduce drop vs. level, near-symmetrically', () => {
    const at = (deg) => solve({ ...sampleLoad({ shot: { angleDeg: deg } }), ranges: [600] }).rows[0].dropIn;
    const level = at(0), up = at(30), down = at(-30);
    assert.ok(up > level && down > level);
    near(up, down, 0.03 * Math.abs(level), 'symmetry');
    // Rifleman's rule ballpark: drop scales roughly with cos(angle) (0.866 at 30°).
    near(up / level, 0.84, 0.06, 'rifleman ratio');
  });
});

describe('wind', () => {
  const at = (clock, mph = 10) => solve({ ...sampleLoad({ shot: { windMph: mph, windClock: clock } }), ranges: [500], options: { spinDrift: false } }).rows[0];
  test('3 o\'clock pushes left, 9 o\'clock pushes right, equal magnitude', () => {
    const r3 = at(3), r9 = at(9);
    assert.ok(r3.windIn < 0 && r9.windIn > 0);
    near(r3.windIn, -r9.windIn, 1e-6, 'mirror');
    assert.ok(r3.windageMrad > 0, 'dial right to correct a left drift');
  });
  test('12 and 6 o\'clock produce no drift; headwind drops more than tailwind', () => {
    const head = at(12), tail = at(6);
    near(head.windIn, 0, 1e-6, 'head drift');
    near(tail.windIn, 0, 1e-6, 'tail drift');
    assert.ok(head.dropIn < tail.dropIn);
  });
  test('half value at 1 o\'clock is sin(30°) of full value (within lag nonlinearity)', () => {
    near(at(1).windIn / at(3).windIn, 0.5, 0.02, 'ratio');
  });
});

describe('spin drift', () => {
  test('Miller stability matches hand calculation', () => {
    // 140 gr, .264", 1.40", 1:8, 2710 fps, standard atmosphere
    const t = 8 / 0.264, l = 1.40 / 0.264;
    const expected = (30 * 140) / (t * t * 0.264 ** 3 * l * (1 + l * l)) * Math.cbrt(2710 / 2800);
    near(millerStability({ weightGr: 140, caliberIn: 0.264, lengthIn: 1.40, twistIn: 8, muzzleVelocityFps: 2710, tempF: 59, stationPressureInHg: 29.92 }), expected, 1e-9, 'Sg');
  });
  test('Litz drift formula', () => {
    near(litzSpinDriftIn(1.5, 1.0), 1.25 * 2.7, 1e-12, 'drift at 1 s');
  });
  test('right twist drifts right, left twist mirrors it; no twist → none', () => {
    const r = solve({ ...sampleLoad(), ranges: [1000] }).rows[0];
    const l = solve({ ...sampleLoad({ rifle: { ...sampleLoad().rifle, twistDirection: 'L' } }), ranges: [1000] }).rows[0];
    const none = solve({ ...sampleLoad({ rifle: { ...sampleLoad().rifle, twistIn: undefined } }), ranges: [1000] }).rows[0];
    assert.ok(r.windIn > 0);
    near(l.windIn, -r.windIn, 1e-9, 'mirror');
    near(none.windIn, 0, 1e-9, 'none');
  });
});

describe('Coriolis', () => {
  const OMEGA = 7.2921159e-5;
  // Nearly drag-free bullet (huge BC) at constant velocity: the exact deflections are
  // horizontal Ω·sinλ·X·t and vertical (Eötvös) Ω·cosλ·sin(Az)·X·t.
  const vacuum = (lat, az) => solve({
    ...sampleLoad({ bullet: { weightGr: 140, drag: { type: 'standard', table: 'G7', bc: 1e7 } } }),
    shot: { latitudeDeg: lat, azimuthDeg: az }, ranges: [1000],
  });
  test('drag-free horizontal deflection equals Ω·sinλ·X·t', () => {
    const lat = 45;
    const base = vacuum(undefined, undefined).rows[0];
    const north = vacuum(lat, 0).rows[0];
    const expected = OMEGA * Math.sin(lat * Math.PI / 180) * 3000 * base.timeS * 12;
    near(north.windIn - base.windIn, expected, 0.01 * expected, 'horizontal');
  });
  test('drag-free vertical (Eötvös) deflection equals Ω·cosλ·X·t firing east', () => {
    const lat = 45;
    const base = vacuum(undefined, undefined).rows[0];
    const east = vacuum(lat, 90).rows[0];
    const expected = OMEGA * Math.cos(lat * Math.PI / 180) * 3000 * base.timeS * 12;
    near(east.dropIn - base.dropIn, expected, 0.02 * expected, 'vertical');
  });
  test('directions agree with Ballistic Explorer reference (lat ±45°, east/west)', () => {
    const refOff = loadGehtsoft('be_coriolis_off');
    const run = (name) => {
      const r = loadGehtsoft(name);
      const env = { tempF: r.tempF, humidity: r.humidity, altitudeFt: 0, pressureInHg: r.pressureInHg, pressureIsStation: true };
      return solve({
        bullet: { weightGr: r.weightGr, drag: { type: 'standard', table: r.table, bc: r.bc } },
        rifle: { muzzleVelocityFps: r.mv, sightHeightIn: r.sightHeightIn, zeroRangeYd: r.zeroYd },
        zeroAtmosphere: env, atmosphere: env,
        shot: { latitudeDeg: r.latitudeDeg ?? undefined, azimuthDeg: r.azimuthDeg ?? undefined }, ranges: [1000],
      }).rows[0];
    };
    const off = run('be_coriolis_off'), east = run('be_coriolis_east'), west = run('be_coriolis_west'), south = run('be_coriolis_south');
    const refAt = (n) => loadGehtsoft(n).rows.find((x) => x.rangeYd === 1000);
    // Baseline (no Coriolis) agrees with BE within 0.1 MOA at 1000 yd.
    near(off.dropIn, refAt('be_coriolis_off').dropIn, 0.1 * inPerMoa(1000), 'baseline drop');
    assert.ok(refOff.rows.length > 0);
    // Northern hemisphere → right; southern → left; east → high; west → low.
    assert.ok(east.windIn > 0 && refAt('be_coriolis_east').windIn > 0);
    assert.ok(south.windIn < 0 && refAt('be_coriolis_south').windIn < 0);
    assert.ok(east.dropIn > off.dropIn && west.dropIn < off.dropIn);
  });
  test('Coriolis is off unless both latitude and azimuth are given', () => {
    const a = solve({ ...sampleLoad(), shot: { latitudeDeg: 45 }, ranges: [1000] });
    const b = solve({ ...sampleLoad(), ranges: [1000] });
    assert.equal(a.coriolis, false);
    assert.equal(a.rows[0].windIn, b.rows[0].windIn);
  });
});

describe('transonic detection', () => {
  test('flags Mach 1.2 and Mach 1.0 crossings consistent with the reference Mach column', () => {
    const { r, out } = runReference('g1_nowind');
    // Reference: Mach 1.231 @600, 1.166 @650; 1.009 @800, 0.970 @850.
    assert.ok(out.transonic.cautionYd > 600 && out.transonic.cautionYd < 650, `caution ${out.transonic.cautionYd}`);
    assert.ok(out.transonic.warningYd > 800 && out.transonic.warningYd < 850, `warning ${out.transonic.warningYd}`);
    r.rows.forEach((ref, i) => near(out.rows[i].mach, ref.mach, 0.003, `mach @${ref.rangeYd}`));
    assert.equal(out.rows.find((x) => x.rangeYd === 650).speedZone, 'transonic');
    assert.equal(out.rows.find((x) => x.rangeYd === 850).speedZone, 'subsonic');
  });
  test('supersonic load reports no crossings within range', () => {
    const out = solve({ ...sampleLoad(), table: { maxRangeYd: 300 } });
    assert.equal(out.transonic.cautionYd, null);
    assert.equal(out.transonic.warningYd, null);
  });
});

describe('table ranges & output conventions', () => {
  test('50 yd steps with a final one-mile row', () => {
    const r = tableRanges(1760);
    assert.equal(r[0], 50);
    assert.deepEqual(r.slice(-3), [1700, 1750, 1760]);
    assert.deepEqual(tableRanges(1750).slice(-2), [1700, 1750]);
    assert.deepEqual(tableRanges(50), [50]);
  });
  test('MRAD dial values: positive elevation = come up', () => {
    const out = solve(sampleLoad());
    const row = out.rows.at(-1);
    assert.ok(row.dropIn < 0 && row.elevationMrad > 0);
    near(row.elevationMrad, (-row.dropIn / (row.rangeYd * 36)) * 1000, 0.01, 'mrad');
  });
  test('one-mile solution runs and reports TOF and energy', () => {
    const out = solve({ ...sampleLoad(), table: { maxRangeYd: 1760 } });
    assert.equal(out.rows.at(-1).rangeYd, 1760);
    assert.ok(out.rows.at(-1).timeS > 2 && out.rows.at(-1).energyFtLb > 0);
  });
});

describe('drag model extensibility', () => {
  test('single-segment multi-BC equals standard BC', () => {
    const std = solve(sampleLoad()).rows.at(-1);
    const multi = solve(sampleLoad({ bullet: { ...sampleLoad().bullet, drag: { type: 'multiBC', table: 'G7', segments: [{ bc: 0.315, minVelocityFps: 0 }] } } })).rows.at(-1);
    near(multi.dropIn, std.dropIn, 1e-9, 'drop');
  });
  test('velocity-banded multi-BC uses the lower BC below its threshold', () => {
    const lowBand = sampleLoad({ bullet: { ...sampleLoad().bullet, drag: { type: 'multiBC', table: 'G7', segments: [{ bc: 0.315, minVelocityFps: 2000 }, { bc: 0.28, minVelocityFps: 0 }] } } });
    assert.ok(solve(lowBand).rows.at(-1).dropIn < solve(sampleLoad()).rows.at(-1).dropIn);
  });
  test('custom Cd curve equal to G7 scaled by form factor reproduces the G7 solution', () => {
    const b = sampleLoad().bullet;
    const sd = b.weightGr / 7000 / b.caliberIn ** 2;
    const i = sd / 0.315; // form factor
    const custom = { type: 'custom', points: G7.map(([m, cd]) => [m, cd * i]) };
    const std = solve(sampleLoad()).rows.at(-1);
    const cus = solve(sampleLoad({ bullet: { ...b, drag: custom } })).rows.at(-1);
    near(cus.dropIn, std.dropIn, 1e-6, 'drop');
  });
  test('unknown model types are rejected', () => {
    assert.throws(() => createDragModel({ type: 'nope' }));
  });
});
