// The telegraph tape scrollbar: a punched tape for the track and a typewriter key for the thumb.

const TAPE_WIDTH = 13;
const TAPE_LENGTH = 1400;
const HOLE_STEP = 5;
const HOLE_CHANCE = 0.4;
const THUMB_MIN = 26;

// Every box that scrolls.
const SCROLLERS = '.dialog-body, .diplo-box, .choose-scroll';

let tapeArt = null;

// Punches one tape: small feed holes down the middle, random code holes either side.
function punchTape() {
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = TAPE_WIDTH * scale;
  canvas.height = TAPE_LENGTH * scale;
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = '#2a241c';
  const hole = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  for (let y = HOLE_STEP / 2; y < TAPE_LENGTH; y += HOLE_STEP) {
    hole(TAPE_WIDTH / 2, y, 0.8);
    if (Math.random() < HOLE_CHANCE) hole(2.4, y, 1.3);
    if (Math.random() < HOLE_CHANCE) hole(TAPE_WIDTH - 2.4, y, 1.3);
  }
  return `url(${canvas.toDataURL()})`;
}

// Lays a tape and key over one scroller.
function attachTape(scroller) {
  scroller.classList.add('tape-scroller');
  const track = document.createElement('div');
  track.className = 'tape-track';
  track.hidden = true;
  track.style.backgroundImage = tapeArt;
  const thumb = document.createElement('div');
  thumb.className = 'tape-key';
  track.append(thumb);
  // Each tape starts at its own place along the punched strip.
  const start = Math.floor(Math.random() * TAPE_LENGTH);

  const keyHeight = () => Math.max(THUMB_MIN, scroller.clientHeight * scroller.clientHeight / scroller.scrollHeight);

  // Places the tape on the scroller's edge and the key at the scroll position.
  const sync = () => {
    const home = scroller.offsetParent;
    const tall = scroller.scrollHeight - scroller.clientHeight >= 1;
    scroller.classList.toggle('tape-room', Boolean(home) && tall);
    track.hidden = !home || !tall;
    if (track.hidden) return;
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (track.parentElement !== home) home.append(track);
    track.style.left = scroller.offsetLeft + scroller.clientLeft + scroller.clientWidth + 'px';
    track.style.top = scroller.offsetTop + scroller.clientTop + 'px';
    track.style.height = scroller.clientHeight + 'px';
    track.style.backgroundPositionY = start - scroller.scrollTop + 'px';
    const h = keyHeight();
    thumb.style.height = h + 'px';
    thumb.style.top = (scroller.scrollTop / range) * (scroller.clientHeight - h) + 'px';
  };

  const scrollToKey = (y) => {
    const span = scroller.clientHeight - keyHeight();
    scroller.scrollTop = Math.max(0, Math.min(1, y / span)) * (scroller.scrollHeight - scroller.clientHeight);
  };

  let grab = null;
  thumb.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    grab = ev.clientY - thumb.getBoundingClientRect().top;
    thumb.setPointerCapture(ev.pointerId);
    thumb.classList.add('held');
  });
  thumb.addEventListener('pointermove', (ev) => {
    if (grab !== null) scrollToKey(ev.clientY - track.getBoundingClientRect().top - grab);
  });
  const drop = () => { grab = null; thumb.classList.remove('held'); };
  thumb.addEventListener('pointerup', drop);
  thumb.addEventListener('pointercancel', drop);
  track.addEventListener('pointerdown', (ev) => {
    scrollToKey(ev.clientY - track.getBoundingClientRect().top - keyHeight() / 2);
  });
  track.addEventListener('wheel', (ev) => { scroller.scrollTop += ev.deltaY; }, { passive: true });

  scroller.addEventListener('scroll', sync, { passive: true });
  const resized = new ResizeObserver(sync);
  resized.observe(scroller);
  if (scroller.parentElement) resized.observe(scroller.parentElement);
  new MutationObserver(sync).observe(scroller, { childList: true, subtree: true, characterData: true });
  sync();
}

// Gives every scrolling box its tape.
function wireScrollbars() {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return;
  const boxes = document.querySelectorAll(SCROLLERS);
  if (!boxes.length) return;
  tapeArt = punchTape();
  for (const box of boxes) attachTape(box);
}

export { wireScrollbars };
