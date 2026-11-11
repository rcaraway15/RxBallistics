# RxBallistics

An optimized, personal point-mass ballistic calculator. It is a static, mobile-first web app (vanilla
HTML/CSS/JS, no build step) that you install on iPhone with **Share → Add to Home Screen**.
It works offline.

## Features
- **Solver:** 3-DOF point mass, RK4 integration (0.5 ms step), standard G1/G7 drag tables.
- **Atmosphere:** air density from temperature, humidity, altitude and pressure. Pressure is the
  weather-app (sea-level) value and is converted to station pressure using altitude.
- **Zero:** the sight angle is solved in the profile's zero conditions, then fired in the current
  conditions.
- **Shooting angle:** applied by rotating gravity into the line-of-sight frame.
- **Wind:** mph, from a clock position (12 = head, 3/9 = full value, 6 = tail).
- **Spin drift:** Litz approximation using Miller stability (Sg is shown).
- **Coriolis:** horizontal and vertical (Eötvös), only when both latitude and azimuth are entered.
- **Transonic warnings:** banners and highlighted rows below Mach 1.2 (caution) and Mach 1.0
  (warning).
- **Table:** 50–1,750 yd in 50 yd steps, plus a one-mile (1,760 yd) row. MRAD columns are dial
  values (+ = come up; wind L/R = direction to dial).
- **Profiles:** stored in `localStorage` with save, rename, duplicate and delete. You can export
  and import JSON (use the share sheet on iOS). Environment fields are not stored in profiles.
- **Night use:** dark theme, plus a red night mode (◐ button).

## Layout
```
index.html, css/app.css      UI
js/app.js                    UI controller (DOM only)
js/profiles.js               profile storage, import/export (no DOM)
js/solver/                   solver: no DOM, importable from Node
  solver.js                  integrator, zero, spin drift, Coriolis, output rows
  atmosphere.js              density, station pressure, speed of sound
  drag.js                    drag-model factory (standard / multiBC / custom)
  dragTables.js              G1, G7 tables (JBM / BRL)
sw.js, manifest.webmanifest  PWA
tests/                       node:test suites + reference data
```

### Adding multi-BC or custom drag curves later
A profile stores `bullet.drag`, which is passed straight to `createDragModel()`.
`{type:'multiBC', table, segments:[{bc, minVelocityFps}]}` and `{type:'custom', points:[[mach, cd]]}`
are already supported and tested in the solver. Only UI fields are needed.

## Tests
```bash
npm test
```
This needs Node 18+ and has no dependencies. See `tests/reference/README.md` for where the
reference data came from.

## Deploy to GitHub Pages
1. Push this folder to a GitHub repository (files at the repo root).
2. In the repo, open **Settings → Pages**, choose **Deploy from a branch**, then `main` / `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` in Safari on the iPhone, then tap **Share → Add to Home Screen**.

All paths are relative, so the app works under a `/<repo>/` subpath.
**When you change any file, bump `VERSION` in `sw.js`.** Installed apps then download the update.
It takes effect the next time the app is reopened.

## Local preview
```bash
npm run serve
```
Then open http://localhost:8080.
