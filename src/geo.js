/**
 * Where the drawn map sits on a sphere, and what that makes things measure.
 *
 * The bitmap is an equirectangular projection: x is longitude and y is latitude,
 * both linear. That is convenient to draw and lies about size. A row of pixels
 * at the equator spans a full circumference; a row near a pole spans almost
 * nothing, yet is drawn the same width. Counting pixels therefore overstates
 * polar land badly — on Earth's proportions, a province at 60 degrees comes out
 * twice the size it really is.
 *
 * So area is not a pixel count. Each ROW carries its own area per pixel, and
 * every real measurement here starts from that.
 *
 * Areas are measured from `data/true_area.png`, which holds the whole world on a
 * 2:1 equirectangular globe: row 0 is the north pole and the last row the south,
 * so a row is a latitude and there is nothing to line up.
 *
 * `provinces.png` is a band of that same globe, cut off short of both poles, and
 * remains the source of every shape the game draws. It is not what gets
 * measured, because land in the polar caps exists only in true_area.png.
 */

// Chron is stated to match Earth in radius and in total surface area. Earth
// cannot do both at once, being an ellipsoid: 6378 km at the equator and 6357
// at the poles, so its 510,072,000 km² is more surface than any sphere of its
// mean radius 6371.0088 km, which comes to 510,065,881 km².
//
// Chron is a sphere, so the surface area is the figure kept and the radius is
// derived from it: R = sqrt(A / 4π). That is 6371.047 km, 38 metres above
// Earth's mean radius, which is nobody's idea of a discrepancy — where the two
// could not agree, an area every province is measured against is worth more
// than a radius nothing reads.
export const EARTH_SURFACE_KM2 = 510072000;
export const EARTH_RADIUS_KM = Math.sqrt(EARTH_SURFACE_KM2 / (4 * Math.PI));

const TAU = Math.PI * 2;

/**
 * Fixes a bitmap to the globe.
 *
 *   width       pixels across, which is a full 360 degrees of longitude
 *   height      rows in the bitmap being measured
 *   globeHeight rows from the north pole to the south, so half `width` for a
 *               true 2:1 equirectangular, and equal to `height` when the bitmap
 *               IS the whole globe — which is the case that measures areas
 *   northRow    which row of the globe this bitmap's first row is, for a band
 *               of one rather than the whole thing
 *
 * Coordinates going in are always the bitmap's own, so a caller working with a
 * band never has to remember the offset.
 */
export function makeProjection({ width, height, globeHeight, northRow = 0 }) {
  // Latitude of the boundary ABOVE drawn row y, as a fraction of the way from
  // the north pole to the south. Boundaries rather than centres, because area
  // needs the band a row covers and not the line through its middle.
  const edgeLat = (y) => Math.PI / 2 - Math.PI * ((y + northRow) / globeHeight);

  // Area of one pixel in each row, precomputed: it depends only on y, and the
  // caller is about to ask for it fifteen million times.
  //
  // The exact figure, not cos(latitude) scaled. A band of a sphere between two
  // latitudes has area 2πR²(sin φ₁ − sin φ₂) — Archimedes' result, that a
  // sphere's zones have the area of the cylinder around them — and one pixel is
  // 1/width of such a band. Taking cos at the row's centre instead is an
  // approximation that breaks down exactly where rows are most distorted, at
  // the poles, and would leave the map's total area not quite equal to 4πR².
  const rowArea = new Float64Array(height);
  const perPixel = (EARTH_RADIUS_KM * EARTH_RADIUS_KM * TAU) / width;
  for (let y = 0; y < height; y++) {
    rowArea[y] = perPixel * (Math.sin(edgeLat(y)) - Math.sin(edgeLat(y + 1)));
  }

  const lonAt = (x) => TAU * ((x + 0.5) / width) - Math.PI;
  const latAt = (y) => Math.PI / 2 - Math.PI * ((y + northRow + 0.5) / globeHeight);

  // The whole sphere, summed row by row exactly as a province is, over every row
  // of the globe rather than only the drawn ones. If the row areas are right
  // this comes to 4πR²; an error in them shows up here, against a figure that is
  // known, instead of hiding inside a province nobody can check.
  let surfaceKm2 = 0;
  for (let g = 0; g < globeHeight; g++) {
    const top = Math.PI / 2 - Math.PI * (g / globeHeight);
    const bot = Math.PI / 2 - Math.PI * ((g + 1) / globeHeight);
    surfaceKm2 += perPixel * (Math.sin(top) - Math.sin(bot)) * width;
  }

  return {
    width,
    height,
    globeHeight,
    northRow,
    /** Surface area of the whole sphere, drawn or not. Should be 4πR². */
    surfaceKm2,

    /** Longitude of a column, in radians, -π at the left edge. */
    lonAt,
    /** Latitude of a row's centre, in radians. */
    latAt,
    /** Square kilometres covered by one pixel in row y. */
    areaOfPixel: (y) => rowArea[y],
    /** Square kilometres covered by a whole row. */
    areaOfRow: (y) => rowArea[y] * width,

    /**
     * A pixel as a unit vector on the sphere.
     *
     * Averaging these is how a centre is found. Averaging longitudes directly
     * cannot work: a province straddling the map's left and right edges has
     * longitudes near +180 and −180, whose mean is 0, putting its centre on the
     * far side of the world. Vectors have no seam to fall down.
     */
    toVector(x, y) {
      const lat = latAt(y), lon = lonAt(x);
      const c = Math.cos(lat);
      return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
    },

    /** Latitude and longitude of a vector, in radians. */
    fromVector([vx, vy, vz]) {
      return { lat: Math.atan2(vz, Math.hypot(vx, vy)), lon: Math.atan2(vy, vx) };
    },
  };
}

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Points are `{ lat, lon }` in radians. This is the distance over the surface,
 * so it wraps east–west for free: two places either side of the map's edge are
 * neighbours here, as they are on the map.
 *
 * Haversine rather than the plain spherical law of cosines. The two agree in
 * theory; the law of cosines loses its precision on short distances, where
 * cos(d/R) is so close to 1 that the leading digits cancel — and short is the
 * case that matters, since these will mostly be measurements between provinces
 * that touch.
 */
export function distanceKm(a, b, radius = EARTH_RADIUS_KM) {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat) * Math.cos(b.lat) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const toDegrees = (rad) => (rad * 180) / Math.PI;
