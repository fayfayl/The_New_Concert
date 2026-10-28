// Fetches the data files and images.

const VERSION = new URL(import.meta.url).search;
const { unpackCache } = await import(`../world/mapcache.js${VERSION}`);

// Appends a timestamp to a URL to bypass the cache.
const noCache = (url) => `${url}?t=${Date.now()}`;

async function loadJSON(url, optional = false) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${url} (${res.status})`);
  }
  return res.json();
}

// Raw bytes, or null if there is no such file.
async function loadBytes(url, optional = false) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${url} (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// The precomputed map cache, or null if missing or stale.
async function loadCache(bytes, expectedHash) {
  if (!bytes) return null;
  if (typeof DecompressionStream !== 'function') return null;   // older browser
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const cache = unpackCache(new Uint8Array(await new Response(stream).arrayBuffer()));
    if (!cache) return null;
    if (cache.meta.hash !== expectedHash) {
      console.info('map-cache.bin is out of date and was ignored. Rebuild it with: node test/sync-provinces.js --cache');
      return null;
    }
    return cache;
  } catch (err) {
    console.warn('map-cache.bin could not be read; computing from the bitmap instead.', err);
    return null;
  }
}

// Reads the bitmap's pixels with colour management off.
async function loadPixels(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none' });

  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, c.width, c.height, { colorSpace: 'srgb' });
}

// Loads the satellite imagery as an ImageBitmap, or null if missing.
async function loadBitmap(url) {
  try {
    const res = await fetch(noCache(url), { cache: 'no-store' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });
  } catch {
    console.warn(`${url} could not be loaded; continuing without it.`);
    return null;
  }
}

export { noCache, loadJSON, loadBytes, loadCache, loadPixels, loadBitmap };
