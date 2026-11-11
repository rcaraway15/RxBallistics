// Saved profiles (localStorage) and import/export.
//
// Profile schema v1:
// {
//   id, name, createdAt, updatedAt,
//   bullet: { weightGr, caliberIn, lengthIn, drag: { type:'standard', table:'G1'|'G7', bc } },
//   rifle:  { muzzleVelocityFps, sightHeightIn, zeroRangeYd, twistIn, twistDirection },
//   shot:   { windMph, windClock, angleDeg },
//   zeroAtmosphere: { tempF, humidity, altitudeFt, pressureInHg },
// }
// `bullet.drag` is the solver's drag spec, so multi-BC / custom curves slot in unchanged.
// Environment (current weather, latitude, azimuth) is deliberately NOT part of a profile.

export const SCHEMA_VERSION = 1;
const KEY = 'ballistics.profiles.v1';
const STATE_KEY = 'ballistics.state.v1';

export const STANDARD_ZERO = Object.freeze({ tempF: 59, humidity: 0, altitudeFt: 0, pressureInHg: 29.92 });

export function newId() {
  return (globalThis.crypto?.randomUUID?.() ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

export class ProfileStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.profiles = this.#read();
  }

  #read() {
    try {
      const raw = this.storage.getItem(KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return (data.profiles || []).map(normalizeProfile).filter(Boolean);
    } catch {
      return [];
    }
  }

  #write() {
    this.storage.setItem(KEY, JSON.stringify({ schema: SCHEMA_VERSION, profiles: this.profiles }));
  }

  list() {
    return [...this.profiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  get(id) {
    return this.profiles.find((p) => p.id === id) ?? null;
  }

  /** Create a new profile from data; returns it. */
  create(name, data) {
    const now = new Date().toISOString();
    const p = normalizeProfile({ ...structuredClone(data), id: newId(), name: uniqueName(this.profiles, name), createdAt: now, updatedAt: now });
    this.profiles.push(p);
    this.#write();
    return p;
  }

  /** Overwrite an existing profile's data (keeps id and name). */
  update(id, data) {
    const i = this.profiles.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('Profile not found');
    const old = this.profiles[i];
    this.profiles[i] = normalizeProfile({ ...structuredClone(data), id, name: old.name, createdAt: old.createdAt, updatedAt: new Date().toISOString() });
    this.#write();
    return this.profiles[i];
  }

  rename(id, name) {
    const p = this.get(id);
    if (!p) throw new Error('Profile not found');
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Name cannot be empty');
    p.name = uniqueName(this.profiles.filter((x) => x.id !== id), clean);
    p.updatedAt = new Date().toISOString();
    this.#write();
    return p;
  }

  duplicate(id) {
    const p = this.get(id);
    if (!p) throw new Error('Profile not found');
    return this.create(`${p.name} copy`, p);
  }

  remove(id) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.#write();
  }

  exportJSON() {
    return JSON.stringify({ app: 'ballistic-calc', schema: SCHEMA_VERSION, exportedAt: new Date().toISOString(), profiles: this.profiles }, null, 2);
  }

  /**
   * Merge profiles from an exported JSON string. Profiles with an id that already
   * exists replace the stored one; others are added. Returns counts.
   */
  importJSON(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('File is not valid JSON'); }
    const list = Array.isArray(data) ? data : data?.profiles;
    if (!Array.isArray(list)) throw new Error('No profiles found in file');
    if ((data.schema ?? 1) > SCHEMA_VERSION) throw new Error('File was made by a newer version of this app');
    let added = 0, replaced = 0, skipped = 0;
    for (const item of list) {
      const p = normalizeProfile(item);
      if (!p) { skipped++; continue; }
      const i = this.profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) { this.profiles[i] = p; replaced++; }
      else { p.name = uniqueName(this.profiles, p.name); this.profiles.push(p); added++; }
    }
    this.#write();
    return { added, replaced, skipped };
  }
}

function uniqueName(list, name) {
  const base = String(name || 'Profile').trim() || 'Profile';
  const names = new Set(list.map((p) => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

const numOr = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Validate and coerce a profile object; returns null if unusable. */
export function normalizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const drag = p.bullet?.drag ?? {};
  const out = {
    id: typeof p.id === 'string' && p.id ? p.id : newId(),
    name: String(p.name ?? 'Profile').slice(0, 80),
    createdAt: p.createdAt ?? new Date().toISOString(),
    updatedAt: p.updatedAt ?? new Date().toISOString(),
    bullet: {
      weightGr: numOr(p.bullet?.weightGr),
      caliberIn: numOr(p.bullet?.caliberIn),
      lengthIn: numOr(p.bullet?.lengthIn),
      drag: normalizeDrag(drag),
    },
    rifle: {
      muzzleVelocityFps: numOr(p.rifle?.muzzleVelocityFps),
      sightHeightIn: numOr(p.rifle?.sightHeightIn),
      zeroRangeYd: numOr(p.rifle?.zeroRangeYd),
      twistIn: numOr(p.rifle?.twistIn),
      twistDirection: p.rifle?.twistDirection === 'L' ? 'L' : 'R',
    },
    shot: {
      windMph: numOr(p.shot?.windMph, 0),
      windClock: numOr(p.shot?.windClock, 3),
      angleDeg: numOr(p.shot?.angleDeg, 0),
    },
    zeroAtmosphere: {
      tempF: numOr(p.zeroAtmosphere?.tempF, STANDARD_ZERO.tempF),
      humidity: numOr(p.zeroAtmosphere?.humidity, STANDARD_ZERO.humidity),
      altitudeFt: numOr(p.zeroAtmosphere?.altitudeFt, STANDARD_ZERO.altitudeFt),
      pressureInHg: numOr(p.zeroAtmosphere?.pressureInHg, STANDARD_ZERO.pressureInHg),
    },
  };
  return out;
}

function normalizeDrag(d) {
  const type = d.type ?? 'standard';
  if (type === 'standard') return { type, table: d.table === 'G1' ? 'G1' : 'G7', bc: numOr(d.bc) };
  // Future model types are passed through untouched so newer exports survive a round trip.
  return structuredClone(d);
}

// --- Last-used working state (form contents incl. environment) ---------------
export function loadState(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(STATE_KEY) || 'null'); } catch { return null; }
}
export function saveState(state, storage = globalThis.localStorage) {
  try { storage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
}
