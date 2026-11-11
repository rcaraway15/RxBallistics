// Atmosphere model: air density and speed of sound.
//
// Units in the public API are the shooter's units: °F, %, ft, inHg.
// Internally SI is used for the gas-law math.

export const STANDARD_DENSITY_KGM3 = 1.2250; // ICAO sea level, the BC reference density
export const STANDARD = Object.freeze({ tempF: 59, humidity: 0, altitudeFt: 0, pressureInHg: 29.92 });

const R_DRY = 287.058; // J/(kg·K)
const R_VAPOR = 461.495; // J/(kg·K)
const HPA_PER_INHG = 33.8638866667;
const LAPSE_K_PER_M = 0.0065;
const T0_K = 288.15;
const BARO_EXP = 5.25588; // g·M/(R·L)
const FT_TO_M = 0.3048;

export const fToK = (f) => (f - 32) * 5 / 9 + 273.15;

/**
 * Convert an altimeter-setting (sea-level-adjusted, as reported by weather apps)
 * pressure to the actual station pressure at the given altitude.
 */
export function stationPressureInHg(altimeterInHg, altitudeFt) {
  const hM = altitudeFt * FT_TO_M;
  return altimeterInHg * Math.pow(1 - (LAPSE_K_PER_M * hM) / T0_K, BARO_EXP);
}

/** Saturation vapor pressure (hPa) over water, Arden Buck (1996). */
export function saturationVaporPressureHpa(tempC) {
  return 6.1121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));
}

/** Moist-air density in kg/m³ from station pressure (inHg), temperature (°F), RH (%). */
export function airDensityKgM3(stationInHg, tempF, humidityPct) {
  const tK = fToK(tempF);
  const tC = tK - 273.15;
  const pHpa = stationInHg * HPA_PER_INHG;
  const rh = Math.min(Math.max(humidityPct || 0, 0), 100) / 100;
  const pv = rh * saturationVaporPressureHpa(tC);
  const pd = pHpa - pv;
  return (pd * 100) / (R_DRY * tK) + (pv * 100) / (R_VAPOR * tK);
}

/** Speed of sound in dry air (ft/s) at temperature °F. */
export function speedOfSoundFps(tempF) {
  return 49.0223 * Math.sqrt(tempF + 459.67);
}

/**
 * Build a resolved atmosphere from user inputs.
 * @param {{tempF:number, humidity:number, altitudeFt:number, pressureInHg:number, pressureIsStation?:boolean}} env
 */
export function resolveAtmosphere(env = STANDARD) {
  const e = { ...STANDARD, ...stripUndefined(env) };
  const station = e.pressureIsStation ? e.pressureInHg : stationPressureInHg(e.pressureInHg, e.altitudeFt);
  const density = airDensityKgM3(station, e.tempF, e.humidity);
  return {
    tempF: e.tempF,
    humidity: e.humidity,
    altitudeFt: e.altitudeFt,
    pressureInHg: e.pressureInHg,
    stationPressureInHg: station,
    densityKgM3: density,
    densityRatio: density / STANDARD_DENSITY_KGM3,
    speedOfSoundFps: speedOfSoundFps(e.tempF),
    tempK: fToK(e.tempF),
  };
}

/**
 * Density ratio and speed of sound at a height (ft) above the shooter, using the
 * standard lapse rate from the shooter's actual conditions.
 */
export function atHeight(atmo, dhFt) {
  if (dhFt === 0) return [atmo.densityRatio, atmo.speedOfSoundFps];
  const t = atmo.tempK - LAPSE_K_PER_M * dhFt * FT_TO_M;
  const ratioT = t / atmo.tempK;
  // ρ ∝ P/T and P ∝ T^BARO_EXP  ⇒  ρ ∝ T^(BARO_EXP-1)
  const dens = atmo.densityRatio * Math.pow(ratioT, BARO_EXP - 1);
  return [dens, atmo.speedOfSoundFps * Math.sqrt(ratioT)];
}

function stripUndefined(o) {
  const r = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && !Number.isNaN(v)) r[k] = v;
  return r;
}
