// Pause and controls menus, the loading screen and the start menu.

const VERSION = new URL(import.meta.url).search;
const { clock, cssToken, els, invalidateProvinces, state } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let clamp, playClick, select;
export function link(all) { ({ clamp, playClick, select } = all); }

// ---------------------------------------------------------- the pause menu

// Whether the start screen has been dismissed and the map is on show.
const mapIsShowing = () => document.getElementById('start')?.classList.contains('gone') === true;

const pauseOpen = () => els.pause.classList.contains('open');

const controlsOpen = () => !!document.getElementById('controls')?.classList.contains('open');

// Opens or closes the controls list.
function setControls(open) {
  const el = document.getElementById('controls');
  if (!el) return;
  el.classList.toggle('open', open);
  el.setAttribute('aria-hidden', String(!open));
  if (open) el.querySelector('.dialog-close')?.focus();
}

function setPause(open) {
  els.pause.classList.toggle('open', open);
  els.pause.setAttribute('aria-hidden', String(!open));

  if (!open) {
    els.canvas.focus?.();
    return;
  }

  els.tooltip.hidden = true;
  invalidateProvinces(state.hovered);
  state.hovered = null;

  document.getElementById('pause-resume')?.focus();
}

// Returns to the start screen, leaving the map built behind it.
function quitToStartMenu() {
  setPause(false);
  select(null);
  showStartMenu();
}

// Shows the start menu once the map is drawn; called at the end of init().
function markMapReady() {
  const loading = document.getElementById('loading');
  const menu = document.getElementById('start');

  const reveal = () => {
    loading?.classList.add('gone');
    loading?.setAttribute('aria-hidden', 'true');
    if (!menu) return;
    menu.classList.remove('pending');
    menu.setAttribute('aria-hidden', 'false');

    requestAnimationFrame(() => document.getElementById('start-enter')?.focus());
  };

  if (!loading) { reveal(); return; }

  loading.classList.add('ready');

  const MODIFIERS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
    'ContextMenu', 'Dead', 'Fn', 'FnLock', 'Hyper', 'Super', 'AltGraph',
  ]);

  const go = (ev) => {
    if (ev.type === 'keydown' && MODIFIERS.has(ev.key)) return;
    ev.preventDefault();
    window.removeEventListener('keydown', go);
    window.removeEventListener('mousedown', go);
    reveal();
  };

  window.addEventListener('keydown', go);
  window.addEventListener('mousedown', go);
}

// Sets the line under the loading bar.
function setLoadingNote(text) {
  const note = document.getElementById('loading-note');
  if (note) note.textContent = text;
}

// Cell count of the loading gauge, read from its initial markup.
let gaugeCells = 0;

// Writes the loading gauge and percentage; it only moves forward.
let loadingShown = 0;
function setLoadingProgress(pct) {
  pct = Math.max(loadingShown, Math.min(100, Math.round(pct)));
  loadingShown = pct;
  const bar = document.getElementById('loading')?.querySelector?.('.loading-bar');
  const done = bar?.querySelector?.('.done');
  const todo = bar?.querySelector?.('.todo');
  const figure = bar?.querySelector?.('.pct');
  if (!done || !todo || !figure) return;
  gaugeCells ||= done.textContent.length + todo.textContent.length;
  const n = Math.round((gaugeCells * pct) / 100);
  done.textContent = '='.repeat(n);
  todo.textContent = '.'.repeat(gaugeCells - n);
  figure.textContent = String(pct).padStart(3) + '%';
}

// Advances the gauge from `from` to `to` as each start-up fetch lands.
function countedLoad(from, to, promises) {
  let landed = 0;
  return promises.map((p) => Promise.resolve(p).then((value) => {
    landed++;
    setLoadingProgress(from + ((to - from) * landed) / promises.length);
    return value;
  }));
}

// Writes a random quote into the loading screen.
function fillLoadingQuote(list) {
  if (!list?.length) return;

  const q = list[Math.floor(Math.random() * list.length)];
  const text = document.getElementById('loading-quote-text');
  const by = document.getElementById('loading-quote-by');
  if (text) text.replaceChildren(...typedRun(String(q.text ?? '')));
  if (by) by.textContent = q.by ?? '';
  const card = document.getElementById('loading-quote');
  if (typeof card?.style?.setProperty === 'function') card.style.setProperty('--deckle', deckleEdge());
}

// Builds a line of text as typewriter-struck, whole-pixel-offset spans.
function typedRun(text) {
  const out = [];
  for (const word of text.split(/( )/)) {
    if (word === ' ') { out.push(' '); continue; }
    if (!word) continue;
    const hold = document.createElement('span');
    hold.style.whiteSpace = 'nowrap';
    for (const c of word) {
      const ch = document.createElement('span');
      ch.className = 'ch';
      ch.textContent = c;
      if (Math.random() < 0.16) ch.style.top = (Math.random() < 0.5 ? -1 : 1) + 'px';
      ch.style.opacity = (0.8 + Math.random() * 0.2).toFixed(2);
      hold.append(ch);
    }
    out.push(hold);
  }
  return out;
}

// Random torn-edge clip-path polygon for the quote card.
function deckleEdge() {
  const r = (n) => Math.round(Math.random() * n);
  const pts = [];
  for (let x = 0; x <= 100; x += 2.5) pts.push(`${x}% ${r(3)}px`);
  for (let y = 4; y <= 96; y += 6) pts.push(`calc(100% - ${r(3)}px) ${y}%`);
  for (let x = 100; x >= 0; x -= 2.5) pts.push(`${x}% calc(100% - ${r(3)}px)`);
  for (let y = 96; y >= 4; y -= 6) pts.push(`${r(3)}px ${y}%`);
  return `polygon(${pts.join(', ')})`;
}

// ------------------------------------------------------ the drifting backdrop

// Furthest the artwork drifts from centre, in CSS pixels.
const PARALLAX_PX = 26;
if (!(PARALLAX_PX < parseFloat(cssToken('--parallax-slack')))) {
  console.warn("PARALLAX_PX reaches past --parallax-slack; the photograph's edge will show");
}

// Time constant of the backdrop drift, in ms.
const PARALLAX_MS = 320;

function startParallax() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const root = document.documentElement;
  const at = { x: 0, y: 0 };      // where the artwork is
  const to = { x: 0, y: 0 };      // where the pointer says it should be
  let raf = 0;
  let clock = 0;

  const step = (now) => {
    const k = 1 - Math.exp(-(clock ? now - clock : 0) / PARALLAX_MS);
    clock = now;
    at.x += (to.x - at.x) * k;
    at.y += (to.y - at.y) * k;

    const done = Math.abs(to.x - at.x) < 0.05 && Math.abs(to.y - at.y) < 0.05;
    if (done) { at.x = to.x; at.y = to.y; }

    root.style.setProperty('--parallax-x', `${at.x.toFixed(2)}px`);
    root.style.setProperty('--parallax-y', `${at.y.toFixed(2)}px`);

    clock = done ? 0 : clock;
    raf = done ? 0 : requestAnimationFrame(step);
  };

  window.addEventListener('mousemove', (ev) => {
    if (mapIsShowing()) return;

    const nx = (ev.clientX / window.innerWidth) * 2 - 1;
    const ny = (ev.clientY / window.innerHeight) * 2 - 1;
    to.x = -clamp(nx, -1, 1) * PARALLAX_PX;
    to.y = -clamp(ny, -1, 1) * PARALLAX_PX;

    if (!raf) raf = requestAnimationFrame(step);
  }, { passive: true });

}

// Puts the start screen back up over the built map.
function showStartMenu() {
  const menu = document.getElementById('start');
  if (!menu) return;
  menu.classList.remove('gone');
  menu.setAttribute('aria-hidden', 'false');

  requestAnimationFrame(() => document.getElementById('start-enter')?.focus());
}

// Wires the start menu's buttons and keys.
function openStartMenu() {
  const menu = document.getElementById('start');
  const enter = document.getElementById('start-enter');
  if (!menu || !enter) return;

  const dismiss = () => {
    if (menu.classList.contains('gone') || menu.classList.contains('pending')) return;
    menu.classList.add('gone');
    menu.setAttribute('aria-hidden', 'true');
    els.canvas.focus?.();
  };
  enter.addEventListener('click', dismiss);

  // Menu dialogs, each opened by a button's data-dialog.
  let openedBy = null;                    // the button to give the focus back to
  const openDialog = () => document.querySelector('.start-dialog.open');

  const setDialog = (dialog, open) => {
    if (!dialog) return;
    dialog.classList.toggle('open', open);
    dialog.setAttribute('aria-hidden', String(!open));
    if (open) dialog.querySelector('.dialog-close')?.focus();
    else openedBy?.focus();
  };

  for (const button of menu.querySelectorAll('button[data-dialog]')) {
    button.addEventListener('click', () => {
      openedBy = button;
      setDialog(document.getElementById(button.dataset.dialog), true);
    });
  }

  for (const dialog of document.querySelectorAll('.start-dialog')) {
    dialog.querySelector('.dialog-close')?.addEventListener('click', () => setDialog(dialog, false));
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) setDialog(dialog, false); });
  }

  // Enter and Space start the game; Escape does not.
  window.addEventListener('keydown', (ev) => {
    if (menu.classList.contains('gone') || menu.classList.contains('pending')) return;
    if (ev.key !== 'Enter' && ev.key !== 'Escape' && ev.key !== ' ') return;

    const dialog = openDialog();
    if (dialog) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      setDialog(dialog, false);
      return;
    }

    if (ev.key === 'Escape') {
      ev.preventDefault();
      return;
    }

    if (document.activeElement?.tagName === 'BUTTON' && document.activeElement !== enter) return;

    ev.preventDefault();

    ev.stopImmediatePropagation();

    playClick(ev);
    dismiss();
  });
}

export { mapIsShowing, pauseOpen, controlsOpen, setControls, setPause, quitToStartMenu, markMapReady, setLoadingNote, gaugeCells, loadingShown, setLoadingProgress, countedLoad, fillLoadingQuote, typedRun, deckleEdge, PARALLAX_PX, PARALLAX_MS, startParallax, showStartMenu, openStartMenu };
