// earthSurface.ts: the float64 WGS84 inverse a landfall is labeled with.
//
// Ported from ONOSENDAI src/lib/earthSurface.ts at commit 18eded9 (branch
// v2), trimmed to what landfall.ts needs: the ellipsoid constants and
// `csMetresToLatLon`, verbatim. Left out: the surface mesh, ring, graticule
// and framing helpers, which draw the planet and have no reader here.
//
// Nothing in this file is consensus-critical. The exact, decimal derivation
// of a landfall lives in landfall.ts; this is the float64 reading of a
// coordinate back into latitude, longitude and height, good to a nanometer
// at Earth-radius magnitudes, for words a person can read.

export const WGS84_A_M = 6378137
export const WGS84_F = 1 / 298.257223563
export const WGS84_B_M = WGS84_A_M * (1 - WGS84_F)
const E2 = WGS84_F * (2 - WGS84_F)

/** §9.7: 1 meter = 2^33 gibsons (Cantor height 34 is 2 meters). */
export const GIBSONS_PER_M = 2 ** 33

/** Cyberspace axis values in meters from the mapping centre (float64). */
export interface CsMetres {
  x: number
  y: number
  z: number
}

/**
 * Geodetic latitude and longitude (degrees) and height above the ellipsoid
 * (meters) of a point given in cyberspace axis meters: the inverse of
 * latLonToCsMetres. Undo the §9.4 permutation, then the standard iterative
 * ECEF-to-geodetic solve; six rounds is far past float64 convergence.
 * Exactly on the polar axis the iteration has no longitude and the height
 * is read off the axis directly.
 */
export function csMetresToLatLon(m: CsMetres): { lat: number; lon: number; altM: number } {
  const X = m.x
  const Y = m.z
  const Z = m.y
  const p = Math.hypot(X, Y)
  if (p < 1e-9) return { lat: Z >= 0 ? 90 : -90, lon: 0, altM: Math.abs(Z) - WGS84_B_M }
  const lon = Math.atan2(Y, X)
  let lat = Math.atan2(Z, p * (1 - E2))
  let n = WGS84_A_M
  let alt = 0
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat)
    n = WGS84_A_M / Math.sqrt(1 - E2 * s * s)
    alt = p / Math.cos(lat) - n
    lat = Math.atan2(Z, p * (1 - (E2 * n) / (n + alt)))
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, altM: alt }
}
