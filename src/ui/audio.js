// Button and selection sounds.

const VERSION = new URL(import.meta.url).search;
const { ease, live } = await import(`../core/core.js${VERSION}`);

// Pixels a press may travel and still count as a click.
const DRAG_SLOP = 4;

// ---------------------------------------------------------------- the click
const SFX_CLICK = './data/sfx/old_radio_button.ogg';
const SFX_SELECT = './data/sfx/province_county_selection.ogg';
// Water selection recordings, one picked at random per click.
const SFX_WATER = [
  './data/sfx/region_subregion_selection.ogg',
  './data/sfx/region_subregion_selection_2.ogg',
];
const SFX_VOLUME = 0.35;

// Sound onset threshold, as a share of the sample's peak.
const SFX_ONSET = 0.25;

// Lead-in kept before the detected onset.
const SFX_PREROLL = 0.002;   // seconds

// Delay before a click sound plays, tunable with game.clickDelay(ms).
live.sfxDelay = 0;            // seconds

const sfx = {
  ctx: null, buffer: null, gain: null, offset: 0, on: true,
  // Selection sounds and their leading silence: select is ground, water is sea.
  select: null, selectOffset: 0,
  // One { buffer, offset } per water recording.
  water: [],
  // Latency figures reported in the debug panel.
  lag: 0, base: 0, output: 0, peak: 0, attack: 0,
};

// Fetches and decodes the sounds into in-memory buffers.
async function loadSounds() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx || sfx.ctx) return;
  try {
    sfx.ctx = new Ctx({ latencyHint: 'interactive' });
    sfx.gain = sfx.ctx.createGain();
    sfx.gain.gain.value = SFX_VOLUME;
    sfx.gain.connect(sfx.ctx.destination);
    const bytes = await (await fetch(SFX_CLICK)).arrayBuffer();
    sfx.buffer = await sfx.ctx.decodeAudioData(bytes);
    sfx.offset = leadingSilence(sfx.buffer);

    const decode = async (url) => {
      const raw = await (await fetch(url)).arrayBuffer();
      const buffer = await sfx.ctx.decodeAudioData(raw);
      return { buffer, offset: leadingSilence(buffer) };
    };

    try {
      const one = await decode(SFX_SELECT);
      sfx.select = one.buffer;
      sfx.selectOffset = one.offset;
    } catch { sfx.select = null; }

    for (const url of SFX_WATER) {
      try { sfx.water.push(await decode(url)); } catch { }
    }
    sfx.base = sfx.ctx.baseLatency || 0;
    sfx.output = sfx.ctx.outputLatency || 0;
  } catch {
    sfx.ctx = null;
    sfx.buffer = null;
  }
}

// Seconds of leading silence before a sound's onset.
function leadingSilence(buf) {
  const d = buf.getChannelData(0);
  let peak = 0, peakAt = 0;
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i]);
    if (v > peak) { peak = v; peakAt = i; }
  }
  sfx.peak = peak;
  if (!peak) return 0;

  const gate = peak * SFX_ONSET;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) >= gate) {
      sfx.attack = Math.max(0, (peakAt - i) / buf.sampleRate);
      return Math.max(0, i / buf.sampleRate - SFX_PREROLL);
    }
  }
  return 0;
}

// Plays the button click sound.
function playClick(ev) {
  playSound(sfx.buffer, sfx.offset, ev);
}

// Mute one sound when a single gesture selects two things.
live.quietSelect = false;
live.quietWater = false;

// Plays the paper selection sound for a page-turning control.
function playPaper(ev) {
  playSound(sfx.select, sfx.selectOffset, ev);
}

// Plays the ground selection sound.
function playSelect() {
  if (live.quietSelect) return;
  playSound(sfx.select, sfx.selectOffset);
}

// Plays one of the water selection sounds at random.
function playWater() {
  if (live.quietWater || !sfx.water.length) return;
  const pick = sfx.water[Math.floor(Math.random() * sfx.water.length)];
  playSound(pick.buffer, pick.offset);
}

function playSound(buffer, offset, ev) {
  if (!sfx.on || !buffer) return;
  if (ev && ev.timeStamp) sfx.lag = ease(sfx.lag, Math.max(0, performance.now() - ev.timeStamp));
  try {
    if (sfx.ctx.state === 'suspended') sfx.ctx.resume();
    const source = sfx.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(sfx.gain);
    source.start(sfx.ctx.currentTime + live.sfxDelay, offset);
  } catch { }
}

export { DRAG_SLOP, SFX_CLICK, SFX_SELECT, SFX_WATER, SFX_VOLUME, SFX_ONSET, SFX_PREROLL, sfx, loadSounds, leadingSilence, playClick, playPaper, playSelect, playWater, playSound };
