// Equirectangular projection maths and true area per row of the globe.

// Earth's surface area, and the sphere radius derived from it.
export const EARTH_SURFACE_KM2 = 510072000;
export const EARTH_RADIUS_KM = Math.sqrt(EARTH_SURFACE_KM2 / (4 * Math.PI));

const TAU = Math.PI * 2;

// Latitude of a globe row and longitude of a column, in radians.
const globeLat = (row, globeHeight) => Math.PI / 2 - Math.PI * (row / globeHeight);
const globeLon = (col, width) => TAU * (col / width) - Math.PI;

// Fixes a bitmap to the globe: per-row areas, lat/lon and vectors.
export function makeProjection({ width, height, globeHeight, northRow = 0 }) {
  const edgeLat = (y) => globeLat(y + northRow, globeHeight);

  // Exact area of one pixel in each row.
  const rowArea = new Float64Array(height);
  const perPixel = (EARTH_RADIUS_KM * EARTH_RADIUS_KM * TAU) / width;
  for (let y = 0; y < height; y++) {
    rowArea[y] = perPixel * (Math.sin(edgeLat(y)) - Math.sin(edgeLat(y + 1)));
  }

  const lonAt = (x) => globeLon(x + 0.5, width);
  const latAt = (y) => globeLat(y + northRow + 0.5, globeHeight);

  let surfaceKm2 = 0;
  for (let g = 0; g < globeHeight; g++) {
    const top = globeLat(g, globeHeight);
    const bot = globeLat(g + 1, globeHeight);
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

    // A pixel as a unit vector on the sphere.
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

// Great-circle distance between two points, in kilometres.
export function distanceKm(a, b, radius = EARTH_RADIUS_KM) {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat) * Math.cos(b.lat) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const toDegrees = (rad) => (rad * 180) / Math.PI;

// ======================================================= where the sun is

export const AXIAL_TILT = (23.44 * Math.PI) / 180;
export const YEAR_DAYS = 365.2422;

// Globe rows above the drawn map, and the globe's full height.
export const MAP_NORTH_ROW = 100;
export const MAP_GLOBE_HEIGHT = 3000;

/** Latitude of a drawn row of `provinces.png`, in radians. */
export const mapLatAt = (y) => globeLat(y + MAP_NORTH_ROW, MAP_GLOBE_HEIGHT);

/** Longitude of a drawn column, in radians, -π at the left edge. */
export const mapLonAt = (x, width) => globeLon(x, width);

// Inverse of mapLatAt and mapLonAt for pixel-centre positions.
/** Row a measured latitude, in radians, was read from. */
export const mapRowAt = (lat) =>
  ((Math.PI / 2 - lat) / Math.PI) * MAP_GLOBE_HEIGHT - 0.5 - MAP_NORTH_ROW;
/** Column a measured longitude, in radians, was read from. */
export const mapColAt = (lon, width) => ((lon + Math.PI) / TAU) * width - 0.5;

// Sun's declination on a day of the year, in radians.
export const solarDeclination = (dayOfYear) =>
  -AXIAL_TILT * Math.cos((TAU * (dayOfYear + 10)) / YEAR_DAYS);

// Map column of the UTC meridian.
export const UTC_MERIDIAN_X = 2376.5;

/** Longitude of the timekeeping meridian, in radians. */
export const utcMeridianLon = (width) => mapLonAt(UTC_MERIDIAN_X, width);

// The longitude the sun is directly over for a UTC hour, in radians.
export const subsolarLongitude = (utcHours, width) =>
  utcMeridianLon(width) + ((12 - utcHours) * 15 * Math.PI) / 180;

/** Local solar time at a longitude, in hours, for a UTC hour. */
export const localHours = (lon, utcHours, width) =>
  (utcHours + toDegrees(lon - utcMeridianLon(width)) / 15 + 24) % 24;

// Sine of the sun's elevation at a point; negative at night.
export const sinSolarElevation = (lat, lon, dec, sunLon) =>
  Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(lon - sunLon);
