// Parser for the reference trajectory templates from gehtsoft-usa/BallisticCalculator1
// (BallisticCalculator.Test/resources, LGPL-2.1). See tests/reference/README.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const num = (s) => (s === undefined || s === '' ? null : parseFloat(s));

export function loadGehtsoft(name) {
  const text = readFileSync(join(here, 'gehtsoft', `${name}.txt`), 'utf8').replace(/^﻿/, '');
  const ref = { name, rows: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(';');
    switch (f[0]) {
      case 'ammo': {
        const m = f[1].match(/^([\d.]+)(G\d)$/);
        ref.bc = parseFloat(m[1]); ref.table = m[2];
        ref.weightGr = num(f[2]); ref.mv = num(f[3]);
        if (f[4]) { ref.caliberIn = num(f[4]); ref.lengthIn = num(f[5]); }
        break;
      }
      case 'rifle':
        ref.sightHeightIn = num(f[1]); ref.zeroYd = num(f[2]);
        if (f[3]) { ref.twistIn = num(f[3]); ref.twistDirection = f[4] === 'left' ? 'L' : 'R'; }
        break;
      case 'wind': ref.windMph = num(f[1]); ref.windDirDeg = num(f[2]); break;
      case 'atmosphere':
        ref.tempF = num(f[1]); ref.humidity = num(f[2]); ref.pressureInHg = num(f[3]); ref.altitudeFt = num(f[4]);
        break;
      case 'shot':
        ref.angleDeg = num(f[1]); ref.azimuthDeg = num(f[3]); ref.latitudeDeg = num(f[4]);
        break;
      default:
        if (/^\d/.test(f[0])) {
          // windage in these files: + = left. Converted here to + = right.
          ref.rows.push({ rangeYd: num(f[0]), dropIn: num(f[1]), windIn: -num(f[3]), velocityFps: num(f[5]), mach: num(f[6]), energyFtLb: num(f[7]), timeS: num(f[8]) });
        }
    }
  }
  return ref;
}

/** Gehtsoft wind direction (0° = blowing toward the target, 90° = from the right) → clock. */
export const dirToClock = (deg) => (((6 - deg / 30) % 12) + 12) % 12;
