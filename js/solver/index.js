// Public entry point for the ballistic solver (no DOM dependencies).
export { solve, zeroAngle, integrate, tableRanges, millerStability, litzSpinDriftIn, windFromClock, earthRotation, GRAVITY_FPS2 } from './solver.js';
export { resolveAtmosphere, stationPressureInHg, airDensityKgM3, speedOfSoundFps, STANDARD } from './atmosphere.js';
export { createDragModel, DRAG_CONSTANT } from './drag.js';
export { G1, G7, STANDARD_TABLES } from './dragTables.js';
