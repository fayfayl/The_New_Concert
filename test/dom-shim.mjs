/*
 * Enough of a browser to boot src/main.js under node.
 *
 * Not a general DOM. It exists so that the map can be loaded, drawn and driven
 * headlessly, which is the only way to find out whether a change to the drawing
 * throws before a person clicks the button and watches the frame loop die.
 *
 * Everything that returns pixels returns real pixels: the PNGs are decoded, the
 * cache is inflated, getImageData hands back the bytes that were put there. What
 * is faked is only the drawing itself, since nothing here looks at the result.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// ------------------------------------------------------------------ PNG decode

function decodePNG(buf) {
  const chunks = [];
  let p = 8, ihdr = null, plte = null, trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') {
      ihdr = { w: buf.readUInt32BE(p + 8), h: buf.readUInt32BE(p + 12), depth: buf[p + 16], colour: buf[p + 17] };
    } else if (type === 'PLTE') plte = buf.subarray(p + 8, p + 8 + len);
    else if (type === 'tRNS') trns = buf.subarray(p + 8, p + 8 + len);
    else if (type === 'IDAT') chunks.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const { w, h, depth, colour } = ihdr;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  const stride = Math.ceil((w * chan * depth) / 8);
  const step = Math.max(1, (chan * depth) >> 3);
  const flat = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= step ? flat[y * stride + i - step] : 0;
      const b = y > 0 ? flat[(y - 1) * stride + i] : 0;
      const c = i >= step && y > 0 ? flat[(y - 1) * stride + i - step] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      flat[y * stride + i] = v & 255;
    }
  }

  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b, a = 255;
      if (colour === 3) {
        const per = 8 / depth, mask = (1 << depth) - 1;
        const k = depth === 8 ? flat[y * stride + x]
          : (flat[y * stride + ((x / per) | 0)] >> (8 - depth - (x % per) * depth)) & mask;
        r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2];
        if (trns && k < trns.length) a = trns[k];
      } else {
        const i = y * stride + x * chan;
        if (colour === 2) { r = flat[i]; g = flat[i + 1]; b = flat[i + 2]; }
        else if (colour === 6) { r = flat[i]; g = flat[i + 1]; b = flat[i + 2]; a = flat[i + 3]; }
        else { r = g = b = flat[i]; }
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

// ------------------------------------------------------------------ the canvas

class FakeCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.font = '';
    this.fillStyle = '';
    this.strokeStyle = '';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.imageSmoothingEnabled = true;
    this.calls = 0;
  }
  // Anything that only draws is a tally.
  save() {} restore() {} beginPath() {} closePath() {} moveTo() {} lineTo() {}
  arc() {} rect() {} fill() {} stroke() {} clip() {} translate() {} rotate() {}
  scale() {} setTransform() {} resetTransform() {} fillRect() { this.calls++; }
  clearRect() {} strokeRect() {} quadraticCurveTo() {}
  // Recorded, so a test can ask what the map actually wrote. A no-op here meant
  // a layer made entirely of text could be checked only for not throwing.
  fillText(t, x, y) { texts.push({ t: String(t), x, y }); }
  strokeText() {}
  bezierCurveTo() {} createLinearGradient() { return { addColorStop() {} }; }
  // Recorded on the same terms as fillText. A layer that bakes its text into
  // bitmaps writes each string once and then blits it, so counting fillText
  // counts bakes and says nothing about what reached the screen.
  drawImage(...a) {
    checkSource(a[0], a);
    blits.push(blitOf(a));
    this.calls++;
  }
  putImageData() { this.calls++; }
  // A flat 16px was assumed here whatever the font said, so anything measuring
  // its own text to decide whether it fits got one answer at every size. 0.55em
  // an character is about right for a humanist sans at weight 500.
  measureText(s) {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font || '')?.[1]) || 16;
    return { width: (s ? String(s).length : 0) * 0.55 * px };
  }
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' };
  }
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
}

class FakeCanvas {
  constructor(w = 300, h = 150) {
    this.width = w; this.height = h;
    this.clientWidth = w; this.clientHeight = h;
    this.style = {};
    this.classList = makeClassList();
    this.dataset = {};
    this._ctx = null;
  }
  getContext() { return (this._ctx ??= new FakeCtx(this)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
  // The same registry the other elements use. A no-op here meant nothing could
  // fire an event AT THE MAP — no wheel, no hover, no click on the canvas itself —
  // so the whole of the pan, zoom and pick path was untestable and silently
  // untested.
  addEventListener(type, fn) {
    if (!listeners.has(this)) listeners.set(this, new Map());
    const m = listeners.get(this);
    if (!m.has(type)) m.set(type, []);
    m.get(type).push(fn);
  }
  removeEventListener() {}
  appendChild(c) { return c; }
  focus() {} blur() {}
}

const makeClassList = () => {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
  };
};

// ------------------------------------------------------------------ elements

const listeners = new Map();

function makeEl(tag = 'div', id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    style: new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => (t[k] = v, true) }),
    classList: makeClassList(),
    dataset: {},
    children: [],
    offsetWidth: 120,
    offsetHeight: 24,
    clientWidth: 1600,
    clientHeight: 900,
    scrollTop: 0,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 }),
    addEventListener(type, fn) {
      if (!listeners.has(el)) listeners.set(el, new Map());
      const m = listeners.get(el);
      if (!m.has(type)) m.set(type, []);
      m.get(type).push(fn);
    },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
    // The modern spelling, and the one drawSlots uses. Missing it meant every
    // left click on a province threw inside updateCard, which no test noticed
    // because no test had ever selected a province.
    append(...c) { for (const q of c) { el.children.push(q); if (q) q.parentElement = el; } },
    prepend(...c) { el.children.unshift(...c); },
    removeChild(c) { el.children = el.children.filter((q) => q !== c); return c; },
    replaceChildren(...c) { el.children = c; },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    // Matches a tag, a .class or an #id, walking up parentElement. Enough for
    // the delegated handlers main.js uses, and it must not stay a stub: a
    // listener keyed on closest() is invisible to every test while it is one.
    closest(sel) {
      const hit = (q) => (sel[0] === '.' ? q.classList.contains(sel.slice(1))
        : sel[0] === '#' ? q.id === sel.slice(1)
        : q.tagName === sel.toUpperCase());
      for (let q = el; q; q = q.parentElement) if (hit(q)) return q;
      return null;
    },
    setAttribute(k, v) { el[k] = v; },
    getAttribute(k) { return el[k]; },
    hasAttribute(k) { return k in el; },
    removeAttribute(k) { delete el[k]; },
    focus() {}, blur() {}, click() {},
    animate: () => ({ finished: Promise.resolve(), cancel() {} }),
  };
  return el;
}

/** Fires a listener that main.js registered, so the harness can drive the app. */
/**
 * Does this blit read pixels that exist?
 *
 * The nine-argument drawImage takes a source rectangle, and the specification
 * says a rectangle reaching outside the image is simply clipped — no error, no
 * warning, and the missing part comes out transparent or, worse, as the edge
 * pixel held flat. That is how a wrapping layer ends up with a seam: the code
 * asks for a column that is not there and the canvas quietly gives it the last
 * one instead, over and over, and nothing anywhere reports a fault.
 *
 * So every blit is checked here. Half a pixel of tolerance, because the source
 * rectangle of a scaled draw is a float and lands on boundaries by rounding.
 */
/**
 * WebAudio, counted.
 *
 * Node has no AudioContext, so main.js takes its early return and the button
 * sound goes untested forever. This records the graph it builds and every
 * source it starts, including the offset, which is what proves the leading
 * silence is being trimmed.
 *
 * SILENT_HEAD samples of silence are prepended to the decoded buffer on
 * purpose. A decoder that returned a clean buffer would let a broken trim
 * pass, because 0 is the right answer for a file that starts immediately.
 */
export const sounds = {
  contexts: 0, decoded: 0, resumed: 0, started: [], gain: null,
  reset() { this.started.length = 0; },
};

const SILENT_HEAD = 1000;   // samples
const SAMPLE_RATE = 44100;

class FakeAudioContext {
  constructor(opts = {}) {
    this.latencyHint = opts.latencyHint;
    // Advances on read, the way a real clock does, so a test can tell a sound
    // scheduled ahead of now from one started at a literal zero.
    this._t = 0;
    this.state = 'suspended';
    this.sampleRate = SAMPLE_RATE;
    this.destination = { kind: 'destination' };
    sounds.contexts++;
  }
  get currentTime() { return (this._t += 0.001); }
  resume() { this.state = 'running'; sounds.resumed++; return Promise.resolve(); }
  createGain() {
    const g = { gain: { value: 1 }, connect: (to) => { g.to = to; } };
    sounds.gain = g;
    return g;
  }
  createBufferSource() {
    const src = {
      buffer: null,
      connect(to) { src.to = to; },
      start(when, offset) {
        // WHICH sound, as well as when. decodeAudioData carries the source byte
        // length through, and the two files differ in size, so a test can tell
        // the click from the selection.
        sounds.started.push({
          when, offset, now: this._t,
          gain: sounds.gain && sounds.gain.gain.value,
          bytes: src.buffer && src.buffer.bytes,
        });
      },
      stop() {},
    };
    return src;
  }
  decodeAudioData(bytes) {
    sounds.decoded++;
    const total = SILENT_HEAD + 2000;
    const data = new Float32Array(total);
    for (let i = SILENT_HEAD; i < total; i++) data[i] = Math.sin(i / 8) * 0.6;
    return Promise.resolve({
      sampleRate: SAMPLE_RATE,
      length: total,
      duration: total / SAMPLE_RATE,
      numberOfChannels: 1,
      getChannelData: () => data,
      bytes: bytes && bytes.byteLength,
    });
  }
}

/** Where the fake decoder put the first audible sample, in seconds. */
export const expectedOffset = SILENT_HEAD / SAMPLE_RATE;

/** Every string the map has written, in order. Cleared with texts.length = 0. */
export const texts = [];

/**
 * Every bitmap the map has blitted, in order. Cleared with blits.length = 0.
 *
 * The DESTINATION size is kept as well as the position, which is what lets a
 * test tell a stack row from a map chunk, and one drawn at one size from the
 * same one drawn larger.
 */
export const blits = [];

// drawImage takes three, five or nine arguments. Only the last two forms carry
// a destination size; the three-argument form takes it from the source.
function blitOf(a) {
  if (a.length >= 9) return { dx: a[5], dy: a[6], dw: a[7], dh: a[8] };
  if (a.length >= 5) return { dx: a[1], dy: a[2], dw: a[3], dh: a[4] };
  return { dx: a[1], dy: a[2], dw: a[0]?.width ?? 0, dh: a[0]?.height ?? 0 };
}

export const blitFaults = [];

function checkSource(src, a) {
  if (a.length < 9 || !src) return;
  const [sx, sy, sw, sh] = [a[1], a[2], a[3], a[4]];
  const w = src.width, h = src.height;
  if (!(w > 0 && h > 0)) return;
  if (![sx, sy, sw, sh].every(Number.isFinite)) {
    blitFaults.push(`source rectangle is not a number: ${sx},${sy} ${sw}x${sh}`);
    return;
  }
  const e = 0.51;
  if (sx < -e || sy < -e || sx + sw > w + e || sy + sh > h + e) {
    blitFaults.push(`reads ${sx.toFixed(1)},${sy.toFixed(1)} ${sw.toFixed(1)}x${sh.toFixed(1)}`
      + ` out of a ${w}x${h} image`);
  }
}

export function fire(el, type, event = {}) {
  const m = listeners.get(el);
  if (!m || !m.has(type)) return false;
  for (const fn of m.get(type)) fn({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event });
  return true;
}

// ------------------------------------------------------------------ install

export function install(root) {
  const byId = new Map();
  const el = (id) => {
    if (!byId.has(id)) {
      const isCanvas = id === 'map' || id.includes('canvas');
      byId.set(id, isCanvas ? new FakeCanvas(1600, 900) : makeEl('div', id));
    }
    return byId.get(id);
  };

  const modeButtons = ['political', 'province', 'terrain', 'county', 'navy'].map((m) => {
    const b = makeEl('button');
    b.dataset.mode = m;
    return b;
  });

  const doc = {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    getElementById: el,
    createElement: (tag) => (tag === 'canvas' ? new FakeCanvas() : makeEl(tag)),
    querySelector: (sel) => {
      const m = /button\[data-mode="(\w+)"\]/.exec(sel);
      if (m) return modeButtons.find((b) => b.dataset.mode === m[1]) || makeEl('button');
      return makeEl();
    },
    querySelectorAll: (sel) => {
      if (sel.includes('data-mode')) return modeButtons;
      return [];
    },
    // Recorded, like every other element. A no-op here meant nothing could fire
    // a KEY at the page: Escape, Space, the backtick that opens the debug menu
    // and every other shortcut are all registered on window or document, so the
    // whole keyboard was untestable and silently untested.
    addEventListener(type, fn) {
      if (!listeners.has(this)) listeners.set(this, new Map());
      const m = listeners.get(this);
      if (!m.has(type)) m.set(type, []);
      m.get(type).push(fn);
    },
    removeEventListener() {},
    createElementNS: () => makeEl(),
    fonts: { ready: Promise.resolve(), load: () => Promise.resolve() },
    visibilityState: 'visible',
    hidden: false,
  };

  const win = {
    devicePixelRatio: 1,
    innerWidth: 1600,
    innerHeight: 900,
    // Recorded, like every other element. A no-op here meant nothing could fire
    // a KEY at the page: Escape, Space, the backtick that opens the debug menu
    // and every other shortcut are all registered on window or document, so the
    // whole keyboard was untestable and silently untested.
    addEventListener(type, fn) {
      if (!listeners.has(this)) listeners.set(this, new Map());
      const m = listeners.get(this);
      if (!m.has(type)) m.set(type, []);
      m.get(type).push(fn);
    },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => { frameQueue.push(fn); return frameQueue.length; },
    cancelAnimationFrame() {},
    location: { search: '', href: 'http://localhost/' },
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
  };

  const frameQueue = [];

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.self = win;
  // node 21 and later define navigator as a getter, so it has to be replaced
  // rather than assigned.
  if (!globalThis.navigator || !globalThis.navigator.userAgent) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node', platform: 'node' }, configurable: true,
    });
  }
  globalThis.devicePixelRatio = 1;
  globalThis.location = win.location;
  // node defines localStorage as a getter of its own on recent versions, so it
  // has to be replaced rather than assigned, as navigator does.
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    },
  });
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.matchMedia = win.matchMedia;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.Image = class { set src(_) { this.onload?.(); } };

  // Real bytes for the real files.
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.\//, '');
    const file = path.join(root, clean);
    if (!fs.existsSync(file)) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); }, async json() { return null; }, async text() { return ''; }, async blob() { return null; } };
    const buf = fs.readFileSync(file);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
      async json() { return JSON.parse(buf.toString('utf8')); },
      async text() { return buf.toString('utf8'); },
      async blob() { return { _buf: buf, stream: () => bufToStream(buf), async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); } }; },
    };
  };

  const bufToStream = (buf) => new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(buf)); c.close(); },
  });

  globalThis.Blob = class {
    constructor(parts) {
      const arr = parts[0];
      this._buf = Buffer.from(arr instanceof Uint8Array ? arr : new Uint8Array(arr));
    }
    stream() { return bufToStream(this._buf); }
    async arrayBuffer() { return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength); }
  };

  globalThis.DecompressionStream = class {
    constructor(kind) {
      const inflate = kind === 'deflate' ? zlib.createInflate() : zlib.createGunzip();
      const chunks = [];
      this.writable = new WritableStream({
        write(c) { inflate.write(Buffer.from(c)); },
        close() { inflate.end(); },
      });
      this.readable = new ReadableStream({
        start(c) {
          inflate.on('data', (d) => c.enqueue(new Uint8Array(d)));
          inflate.on('end', () => c.close());
          inflate.on('error', (e) => c.error(e));
        },
      });
    }
  };

  globalThis.createImageBitmap = async (blob) => {
    const img = decodePNG(blob._buf ?? Buffer.from(await blob.arrayBuffer()));
    return { width: img.width, height: img.height, _img: img, close() {} };
  };

  // getImageData has to hand back the pixels that were drawn, since loadPixels
  // is how the page reads a bitmap it did not get from the cache.
  const realGetContext = FakeCanvas.prototype.getContext;
  FakeCanvas.prototype.getContext = function getContext(...a) {
    const ctx = realGetContext.apply(this, a);
    ctx.drawImage = function drawImage(src, ...rest) {
      const a = [src, ...rest];
      checkSource(src, a);
      if (src && src._img) this.canvas._img = src._img;
      blits.push(blitOf(a));
      this.calls++;
    };
    ctx.getImageData = function getImageData(x, y, w, h) {
      const img = this.canvas._img;
      if (img && img.width === w && img.height === h) return img;
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    };
    return ctx;
  };

  return { doc, win, el, modeButtons, frameQueue, decodePNG };
}
