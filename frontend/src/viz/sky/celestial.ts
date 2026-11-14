// The sky seen from a lunar site, for drawing it: where the stars are and which way Earth faces.
// (The Sun's and Earth's positions themselves come from JPL Horizons via the engine; these formulas
// agree with them to a fraction of a degree, see celestial.test.ts.)
//
// Frames: "inertial" = ICRF / J2000 equatorial (x to the vernal equinox, z to the celestial north
// pole), where star catalogues live. Moon-fixed = Mean Earth frame (cubeSphere.ts). Site frame =
// x east, y up, z south (SiteFrame). Matrices are 3x3 row-major arrays.
import type { SiteFrame, Vec3 } from '../globe/cubeSphere'

export type Mat3 = number[] // 9 numbers, row-major

const DEG = Math.PI / 180
const J2000_MS = Date.UTC(2000, 0, 1, 12) // 2000-01-01 12:00 (TT ~ UTC to a minute: plenty here)

/** Days since J2000 for a UTC time. */
export const daysSinceJ2000 = (utcMs: number) => (utcMs - J2000_MS) / 86_400_000

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}
export const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
// Frame rotations (the coordinates of a fixed vector in axes turned by angle a).
const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)]
const rotZ = (a: number): Mat3 => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1]

/**
 * Inertial -> Moon-fixed, from the IAU WGCCRE 2009 rotation model of the Moon (pole direction and
 * prime meridian, with its periodic terms). Matches the Mean Earth frame to well under 0.1 deg.
 */
export function moonFixedFromInertial(d: number): Mat3 {
  const T = d / 36525
  const E = [
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d,
  ].map((x) => x * DEG)
  const s = (i: number) => Math.sin(E[i - 1])
  const c = (i: number) => Math.cos(E[i - 1])
  const alpha0 = 269.9949 + 0.0031 * T - 3.8787 * s(1) - 0.1204 * s(2) + 0.07 * s(3) - 0.0172 * s(4) + 0.0072 * s(6) - 0.0052 * s(10) + 0.0043 * s(13)
  const delta0 = 66.5392 + 0.013 * T + 1.5419 * c(1) + 0.0239 * c(2) - 0.0278 * c(3) + 0.0068 * c(4) - 0.0029 * c(6) + 0.0009 * c(7) + 0.0008 * c(10) - 0.0009 * c(13)
  const W =
    38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * s(1) + 0.1208 * s(2) - 0.0642 * s(3) + 0.0158 * s(4) + 0.0252 * s(5) -
    0.0066 * s(6) - 0.0047 * s(7) - 0.0046 * s(8) + 0.0028 * s(9) + 0.0052 * s(10) + 0.004 * s(11) + 0.0019 * s(12) - 0.0044 * s(13)
  return mul(rotZ(W * DEG), mul(rotX((90 - delta0) * DEG), rotZ((90 + alpha0) * DEG)))
}

/** Moon-fixed -> site frame (x east, y up, z south): directions only. */
export const siteFromMoonFixed = (f: SiteFrame): Mat3 => [...f.east, ...f.up, -f.north[0], -f.north[1], -f.north[2]]

/** Inertial -> site frame, at a time: the sky as the lander sees it (stars, Earth's axis). */
export const siteFromInertial = (d: number, f: SiteFrame): Mat3 => mul(siteFromMoonFixed(f), moonFixedFromInertial(d))

const OBLIQUITY_J2000 = 23.4392911 * DEG
/** Ecliptic (J2000) longitude/latitude (deg) -> inertial unit vector. */
function fromEcliptic(lonDeg: number, latDeg: number): Vec3 {
  const l = lonDeg * DEG
  const b = latDeg * DEG
  const x = Math.cos(b) * Math.cos(l)
  const y = Math.cos(b) * Math.sin(l)
  const z = Math.sin(b)
  return [x, y * Math.cos(OBLIQUITY_J2000) - z * Math.sin(OBLIQUITY_J2000), y * Math.sin(OBLIQUITY_J2000) + z * Math.cos(OBLIQUITY_J2000)]
}
// The formulas below give longitudes from the equinox of date: back to J2000.
const precession = (d: number) => 1.3969713 * (d / 36525)

/** Geocentric direction of the Sun (inertial), Astronomical Almanac low-precision formula (~0.01 deg). */
export function sunDirection(d: number): Vec3 {
  const g = (357.528 + 0.9856003 * d) * DEG
  const lon = 280.46 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)
  return fromEcliptic(lon - precession(d), 0)
}

/** Geocentric direction of the Moon (inertial), Astronomical Almanac low-precision formula (~0.3 deg). */
export function moonDirection(d: number): Vec3 {
  const T = d / 36525
  const sd = (a: number, b: number) => Math.sin((a + b * T) * DEG)
  const lon =
    218.32 + 481267.881 * T + 6.29 * sd(135.0, 477198.87) - 1.27 * sd(259.3, -413335.36) + 0.66 * sd(235.7, 890534.22) +
    0.21 * sd(269.9, 954397.74) - 0.19 * sd(357.5, 35999.05) - 0.11 * sd(186.5, 966404.03)
  const lat = 5.13 * sd(93.3, 483202.02) + 0.28 * sd(228.2, 960400.89) - 0.28 * sd(318.3, 6003.15) - 0.17 * sd(217.6, -407332.21)
  return fromEcliptic(lon - precession(d), lat)
}

/** Greenwich mean sidereal time (rad): how far Earth has turned (Earth-fixed lon 0 vs the equinox). */
export const gmst = (d: number) => ((280.46061837 + 360.98564736629 * d) % 360) * DEG

/**
 * Earth-fixed -> site frame: how Earth's own globe is turned in the lander's sky (its axis and which
 * longitudes face the Moon), for drawing it with a map of Earth on it.
 */
export function siteFromEarthFixed(d: number, f: SiteFrame): Mat3 {
  return mul(siteFromInertial(d, f), rotZ(-gmst(d))) // Earth-fixed -> inertial is a turn by +GMST
}

/** Azimuth (deg, clockwise from north) and elevation (deg) of a site-frame direction. */
export function azEl(v: Vec3): [number, number] {
  const n = Math.hypot(v[0], v[1], v[2])
  const el = Math.asin(v[1] / n) / DEG
  const az = ((Math.atan2(v[0], -v[2]) / DEG) % 360 + 360) % 360
  return [az, el]
}
