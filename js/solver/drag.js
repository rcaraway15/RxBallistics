// Drag models.
//
// Every drag model reduces to a single function k(mach, velocityFps) = Cd_ref(M) / BC,
// in units of 1/(lb/in²). The solver multiplies this by ρ/ρ0 · v² · DRAG_CONSTANT.
//
// Supported spec shapes (the `drag` object stored with a profile):
//   { type: 'standard', table: 'G1' | 'G7', bc: 0.505 }
//   { type: 'multiBC',  table: 'G1' | 'G7', segments: [{ bc, minVelocityFps }, ...] }
//        Each BC applies at velocities >= its minVelocityFps (Sierra-style velocity bands).
//   { type: 'custom',   points: [[mach, cd], ...] }
//        The bullet's own Cd curve (e.g. from radar / Doppler data). BC = sectional density.
//
// Adding a new model means adding a case to createDragModel; the solver does not change.

import { STANDARD_TABLES } from './dragTables.js';

// π/8 · ρ0 / 144 with ρ0 = 0.0764742 lb/ft³ (ICAO), giving ft/s² from BC in lb/in².
export const DRAG_CONSTANT = (Math.PI * 0.0764742) / (8 * 144);

/** Piecewise-linear lookup of Cd in a sorted [[mach, cd], ...] table. */
export function makeTableLookup(points) {
  const n = points.length;
  const m = new Float64Array(n);
  const c = new Float64Array(n);
  points.forEach(([mach, cd], i) => { m[i] = mach; c[i] = cd; });
  let last = 1;
  return function cdAt(mach) {
    if (mach <= m[0]) return c[0];
    if (mach >= m[n - 1]) return c[n - 1];
    // Mach changes slowly between calls, so start the search at the previous bracket.
    let i = last;
    while (i < n - 1 && m[i] < mach) i++;
    while (i > 1 && m[i - 1] > mach) i--;
    last = i;
    const t = (mach - m[i - 1]) / (m[i] - m[i - 1]);
    return c[i - 1] + t * (c[i] - c[i - 1]);
  };
}

export function sectionalDensity(weightGr, caliberIn) {
  return weightGr / 7000 / (caliberIn * caliberIn);
}

/**
 * @param {object} spec  drag spec (see header)
 * @param {{weightGr:number, caliberIn:number}} bullet  needed for custom curves
 * @returns {{k:(mach:number, v:number)=>number, label:string}}
 */
export function createDragModel(spec, bullet = {}) {
  switch (spec?.type ?? 'standard') {
    case 'standard': {
      const table = tableFor(spec.table);
      if (!(spec.bc > 0)) throw new Error('BC must be greater than zero');
      const cd = makeTableLookup(table);
      const inv = 1 / spec.bc;
      return { k: (mach) => cd(mach) * inv, label: `${spec.table} ${spec.bc}` };
    }
    case 'multiBC': {
      const cd = makeTableLookup(tableFor(spec.table));
      const segs = [...spec.segments].sort((a, b) => b.minVelocityFps - a.minVelocityFps);
      if (!segs.length || segs.some((s) => !(s.bc > 0))) throw new Error('multiBC needs positive BCs');
      return {
        k: (mach, v) => {
          const seg = segs.find((s) => v >= s.minVelocityFps) ?? segs[segs.length - 1];
          return cd(mach) / seg.bc;
        },
        label: `${spec.table} multi-BC`,
      };
    }
    case 'custom': {
      const cd = makeTableLookup(spec.points);
      const sd = sectionalDensity(bullet.weightGr, bullet.caliberIn);
      if (!(sd > 0)) throw new Error('Custom drag curve needs bullet weight and caliber');
      return { k: (mach) => cd(mach) / sd, label: 'custom curve' };
    }
    default:
      throw new Error(`Unknown drag model type: ${spec.type}`);
  }
}

function tableFor(name) {
  const t = STANDARD_TABLES[name];
  if (!t) throw new Error(`Unknown drag table: ${name}`);
  return t;
}
