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
 * Areas are measured from `data/img/true_area.png`, which holds the whole world on a
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

// ================================================================ where the sun is
//
// Chron matches Earth in every planetary respect that bears on this: the same
// axial tilt and the same year. Its landmass differs and its Bond albedo is
// 0.363 rather than Earth's 0.306, and neither moves the terminator. Albedo
// changes how much of the light is thrown back, not where the light falls.

export const AXIAL_TILT = (23.44 * Math.PI) / 180;
export const YEAR_DAYS = 365.2422;

/**
 * Where the drawn map sits on the globe.
 *
 * `provinces.png` is a band of a 6000 by 3000 equirectangular globe and it is
 * NOT centred on it. Measured by matching province colours between
 * `provinces.png` and `true_area.png`: all 1079 provinces present in both put
 * the band's first row exactly 100 rows below the north pole.
 *
 * So the drawn map runs from 84.00 degrees north to 74.94 degrees south, and the
 * equator falls on drawn row 1400. Nothing else in the code knew this, because
 * nothing else needed a latitude for a drawn row.
 */
export const MAP_NORTH_ROW = 100;
export const MAP_GLOBE_HEIGHT = 3000;

/** Latitude of a drawn row of `provinces.png`, in radians. */
export const mapLatAt = (y) =>
  Math.PI / 2 - Math.PI * ((y + MAP_NORTH_ROW) / MAP_GLOBE_HEIGHT);

/** Longitude of a drawn column, in radians, -π at the left edge. */
export const mapLonAt = (x, width) => -Math.PI + TAU * (x / width);

/**
 * The sun's declination on a given day of the year, in radians.
 *
 * The tilted-axis approximation: the sun tracks between the tropics as a cosine
 * over the year, zero at the equinoxes and ±23.44 degrees at the solstices. Good
 * to about a third of a degree, which on this map is five pixels of terminator
 * and nothing anybody will measure.
 *
 * The +10 puts the minimum near 21 December, where the solstice is.
 */
export const solarDeclination = (dayOfYear) =>
  -AXIAL_TILT * Math.cos((TAU * (dayOfYear + 10)) / YEAR_DAYS);

/**
 * The column Chron keeps time by, which is NOT the middle of the map.
 *
 * The prime meridian, longitude zero, is the map's centre at x = 3000. The
 * meridian UTC is reckoned from is a different line, falling between x = 2376
 * and x = 2377, which puts it at 37.41 degrees west. The two are separate facts
 * about the world and conflating them puts every sunrise two and a half hours
 * out.
 */
export const UTC_MERIDIAN_X = 2376.5;

/** Longitude of the timekeeping meridian, in radians. */
export const utcMeridianLon = (width) => mapLonAt(UTC_MERIDIAN_X, width);

/**
 * The longitude the sun is directly over, in radians, for a UTC hour.
 *
 * The sun stands over the UTC meridian at noon and moves west at 15 degrees an
 * hour, so at midnight it is over the far side of that line rather than over the
 * map's antimeridian.
 */
export const subsolarLongitude = (utcHours, width) =>
  utcMeridianLon(width) + ((12 - utcHours) * 15 * Math.PI) / 180;

/** Local solar time at a longitude, in hours, for a UTC hour. */
export const localHours = (lon, utcHours, width) =>
  (utcHours + toDegrees(lon - utcMeridianLon(width)) / 15 + 24) % 24;

/**
 * The sine of the sun's elevation above the horizon at a point.
 *
 * Negative is below the horizon, which is night. This is the whole day and night
 * calculation in one line, and it separates: for a fixed row `sin(lat)sin(dec)`
 * and `cos(lat)cos(dec)` are constants, and `cos(lon - sunLon)` depends only on
 * the column, so a whole map costs one multiply and one add per pixel.
 */
export const sinSolarElevation = (lat, lon, dec, sunLon) =>
  Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(lon - sunLon);
