import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileStore, normalizeProfile } from '../js/profiles.js';

class MemStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } }

const data = {
  bullet: { weightGr: 175, caliberIn: 0.308, lengthIn: 1.24, drag: { type: 'standard', table: 'G1', bc: 0.505 } },
  rifle: { muzzleVelocityFps: 2600, sightHeightIn: 1.8, zeroRangeYd: 100, twistIn: 10, twistDirection: 'R' },
  shot: { windMph: 10, windClock: 9, angleDeg: -5 },
  zeroAtmosphere: { tempF: 70, humidity: 40, altitudeFt: 1200, pressureInHg: 30.1 },
};

test('create, rename, duplicate, delete persist across instances', () => {
  const s = new MemStorage();
  const a = new ProfileStore(s);
  const p = a.create('308 Match', data);
  a.rename(p.id, 'Tikka 308');
  const d = a.duplicate(p.id);
  assert.equal(d.name, 'Tikka 308 copy');
  const b = new ProfileStore(s);
  assert.deepEqual(b.list().map((x) => x.name), ['Tikka 308', 'Tikka 308 copy']);
  assert.deepEqual(b.get(p.id).zeroAtmosphere, data.zeroAtmosphere);
  b.remove(d.id);
  assert.equal(new ProfileStore(s).profiles.length, 1);
});

test('profiles exclude environment and Coriolis inputs', () => {
  const p = normalizeProfile({ ...data, tempF: 20, latitudeDeg: 45, environment: { tempF: 20 } });
  assert.deepEqual(Object.keys(p).sort(), ['bullet', 'createdAt', 'id', 'name', 'rifle', 'shot', 'updatedAt', 'zeroAtmosphere']);
});

test('zero conditions default to standard atmosphere', () => {
  const p = normalizeProfile({ ...data, zeroAtmosphere: undefined });
  assert.deepEqual(p.zeroAtmosphere, { tempF: 59, humidity: 0, altitudeFt: 0, pressureInHg: 29.92 });
});

test('duplicate names are made unique', () => {
  const a = new ProfileStore(new MemStorage());
  a.create('Load', data);
  assert.equal(a.create('load', data).name, 'load (2)');
});

test('export → import round trip into empty storage, then re-import updates in place', () => {
  const a = new ProfileStore(new MemStorage());
  a.create('One', data); a.create('Two', data);
  const json = a.exportJSON();
  const b = new ProfileStore(new MemStorage());
  assert.deepEqual(b.importJSON(json), { added: 2, replaced: 0, skipped: 0 });
  assert.deepEqual(b.importJSON(json), { added: 0, replaced: 2, skipped: 0 });
  assert.deepEqual(b.list().map((p) => p.bullet), a.list().map((p) => p.bullet));
});

test('future drag models survive import untouched', () => {
  const b = new ProfileStore(new MemStorage());
  const drag = { type: 'multiBC', table: 'G1', segments: [{ bc: 0.5, minVelocityFps: 1800 }, { bc: 0.47, minVelocityFps: 0 }] };
  b.importJSON(JSON.stringify({ schema: 1, profiles: [{ ...data, id: 'x', name: 'Multi', bullet: { ...data.bullet, drag } }] }));
  assert.deepEqual(b.get('x').bullet.drag, drag);
});

test('bad import files are rejected', () => {
  const b = new ProfileStore(new MemStorage());
  assert.throws(() => b.importJSON('not json'), /valid JSON/);
  assert.throws(() => b.importJSON('{"foo":1}'), /No profiles/);
  assert.throws(() => b.importJSON('{"schema":99,"profiles":[]}'), /newer version/);
});
