// Mouse, keyboard and toolbar input.

const VERSION = new URL(import.meta.url).search;
const { realmOf } = await import(`../world/mapdata.js${VERSION}`);
const { SPEEDS, clock, els, invalidateBuffer, invalidateProvinces, invalidateView, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let DRAG_SLOP, INFRA_LAYERS, INFRA_NAME, clampPan, closeCard, closeDiplo, controlsOpen, countyAtEvent, debug, diploOpen, fitToView, hoverSea, hoverSub, loadSounds, mapIsShowing, mapPointAtEvent, markAtEvent, openDiplo, pauseOpen, playClick, playPaper, provinceAtEvent, quitToStartMenu, resourceAtEvent, seaAtEvent, select, selectCounty, selectSea, selectSub, setControls, setPause, setPaused, setSpeed, showDiploTab, showMarkTooltip, showResourceTooltip, showTooltip, subAtEvent, togglePanel, view, zoomAt, zoomCentre;
export function link(all) { ({ DRAG_SLOP, INFRA_LAYERS, INFRA_NAME, clampPan, closeCard, closeDiplo, controlsOpen, countyAtEvent, debug, diploOpen, fitToView, hoverSea, hoverSub, loadSounds, mapIsShowing, mapPointAtEvent, markAtEvent, openDiplo, pauseOpen, playClick, playPaper, provinceAtEvent, quitToStartMenu, resourceAtEvent, seaAtEvent, select, selectCounty, selectSea, selectSub, setControls, setPause, setPaused, setSpeed, showDiploTab, showMarkTooltip, showResourceTooltip, showTooltip, subAtEvent, togglePanel, view, zoomAt, zoomCentre } = all); }

// Attaches every event listener. Called once, from init().
function wireInput() {
  loadSounds();

  // Plays each button's sound on pointerdown via one delegated capture listener.
  const pressed = (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset && b.dataset.sfx === 'paper') playPaper(ev);
    else playClick(ev);
  };
  document.addEventListener('pointerdown', pressed, true);

  // Keyboard-activated clicks (detail 0) sound too.
  document.addEventListener('click', (ev) => {
    if (ev.detail === 0) pressed(ev);
  }, true);

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };

  els.canvas.addEventListener('mousedown', (ev) => {
    dragging = true;
    moved = false;
    last = { x: ev.clientX, y: ev.clientY };
  });

  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - last.x;
    const dy = ev.clientY - last.y;
    if (!moved && (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP)) {
      moved = true;
      els.canvas.classList.add('panning');
    }
    if (moved) {
      view.x += dx;
      view.y += dy;
      clampPan();
      invalidateView();
      last = { x: ev.clientX, y: ev.clientY };
    }
  });

  window.addEventListener('mouseup', (ev) => {
    if (dragging && !moved && ev.button === 0) {
      const id = provinceAtEvent(ev);
      // Ctrl-click opens the owner's diplomacy panel and selects nothing.
      if (ev.ctrlKey || ev.metaKey) {
        dragging = false;
        const owner = id ? state.world?.table?.provinces?.find((q) => q.id === id)?.owner : null;
        if (owner) openDiplo(realmOf(state.world.table, owner) || owner);
        else closeDiplo();
        return;
      }
      closeDiplo();
      select(id);
      // Water is selectable only in Navy mode.
      if (state.mode === 'navy') {
        const seaId = id ? null : seaAtEvent(ev);
        const subId = id ? null : subAtEvent(ev);

        live.quietWater = Boolean(subId);
        selectSea(seaId);
        live.quietWater = false;
        selectSub(subId);
      }
    }
    dragging = false;
    els.canvas.classList.remove('panning');
  });

  // Hover highlighting and the tooltip.
  els.canvas.addEventListener('mousemove', (ev) => {
    debug.cursor = mapPointAtEvent(ev);
    if (dragging && moved) { els.tooltip.hidden = true; return; }
    const id = provinceAtEvent(ev);
    if (id !== state.hovered) { invalidateProvinces(state.hovered, id); state.hovered = id; }

    const seaId = id ? null : seaAtEvent(ev);
    hoverSea(state.mode === 'navy' ? seaId : null);
    hoverSub(state.mode === 'navy' && !id ? subAtEvent(ev) : null);

    const deposit = resourceAtEvent(ev);
    const building = deposit ? null : markAtEvent(ev);
    if (deposit) showResourceTooltip(deposit, ev);
    else if (building) showMarkTooltip(building, ev);
    else showTooltip(id, ev, seaId);
  });

  // Right button selects the county under the pointer.
  els.canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 0) selectCounty(null);
  });

  els.canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();

    // Ctrl-right-click opens the member's diplomacy panel.
    if (ev.ctrlKey || ev.metaKey) {
      const id = provinceAtEvent(ev);
      const owner = id ? state.world?.table?.provinces?.find((q) => q.id === id)?.owner : null;
      if (owner) openDiplo(owner);
      else closeDiplo();
      return;
    }

    closeDiplo();

    const county = countyAtEvent(ev);

    // Lights the province and rings the county inside it.
    if (county) {
      live.quietSelect = true;
      select(county.province);
      live.quietSelect = false;
    }
    closeCard();
    selectCounty(county ? county.id : null);
  });

  els.canvas.addEventListener('mouseleave', () => {
    debug.cursor = null;
    invalidateProvinces(state.hovered);
    state.hovered = null;
    hoverSea(null);
    hoverSub(null);
    els.tooltip.hidden = true;
  });

  els.canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.pow(1.0015, -ev.deltaY));
  }, { passive: false });

  document.getElementById('zoom-in').addEventListener('click', () => zoomCentre(1.4));
  document.getElementById('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.4));
  document.getElementById('zoom-fit').addEventListener('click', fitToView);

  document.getElementById('toggle-panel').addEventListener('click', togglePanel);

  const sat = document.getElementById('toggle-satellite');
  sat.disabled = !state.world.satellite;
  sat.classList.toggle('active', state.satellite);

  // Debug switches; data-toggle names the state field each one drives.
  els.toggles.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-toggle]');
    if (!b || b.disabled) return;
    const key = b.dataset.toggle;
    state[key] = !state[key];
    b.classList.toggle('active', state[key]);

    if (b.hasAttribute('data-repaint')) invalidateBuffer();
    else invalidateView();
  });

  document.getElementById('pause-resume').addEventListener('click', () => setPause(false));
  document.getElementById('pause-controls').addEventListener('click', () => setControls(true));
  document.getElementById('pause-quit').addEventListener('click', quitToStartMenu);

  els.clockPlay.addEventListener('click', () => setPaused(!clock.paused));
  els.clockSlower.addEventListener('click', () => setSpeed(clock.speed - 1));
  els.clockFaster.addEventListener('click', () => setSpeed(clock.speed + 1));

  window.addEventListener('keydown', (ev) => {
    if (!mapIsShowing()) return;

    if (ev.key === 'Escape' && controlsOpen()) {
      ev.preventDefault();
      setControls(false);
      return;
    }

    if (pauseOpen()) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      setPause(false);
      return;
    }

    if (ev.key === '+' || ev.key === '=') zoomCentre(1.4);
    else if (ev.key === '-' || ev.key === '_') zoomCentre(1 / 1.4);
    else if (ev.key === '0') fitToView();
    else if (ev.key === '`') { playClick(ev); togglePanel(); }
    else if (ev.key >= '1' && ev.key <= String(SPEEDS.length)) { playClick(ev); setSpeed(Number(ev.key)); }
    else if (ev.key === ' ') {
      if (document.activeElement?.tagName === 'BUTTON') return;
      ev.preventDefault();
      playClick(ev);
      setPaused(!clock.paused);
    }
    else if (ev.key === 'Escape') {
      if (diploOpen()) closeDiplo();
      else if (state.county) selectCounty(null);
      else if (state.selected) select(null);
      else if (state.selectedSea || state.selectedSub) { selectSea(null); selectSub(null); }
      else if (mapIsShowing()) setPause(true);
    }
  });

  els.neighbours.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  });

  document.getElementById('diplo-close').addEventListener('click', closeDiplo);
  els.diploTabDiplomacy.addEventListener('click', () => showDiploTab('diplomacy'));
  els.diploTabLedger.addEventListener('click', () => showDiploTab('ledger'));

  document.getElementById('card-close').addEventListener('click', closeCard);
  document.getElementById('county-close').addEventListener('click', () => selectCounty(null));

  // Layer menu and mode buttons clear each other.
  const infraButton = document.getElementById('infra-button');
  const infraList = document.getElementById('infra-list');
  const infraLabel = document.getElementById('infra-label');
  for (const key of INFRA_LAYERS) {
    const b = document.createElement('button');
    b.dataset.layer = 'infra:' + key;
    b.textContent = INFRA_NAME[key];
    infraList.appendChild(b);
  }
  const openInfra = (open) => {
    infraList.hidden = !open;
    infraButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    const r = infraButton.getBoundingClientRect();
    infraList.style.left = r.left + 'px';
    infraList.style.top = (r.bottom + 6) + 'px';
    infraList.style.minWidth = r.width + 'px';
  };
  const clearInfra = () => {
    infraButton.classList.remove('active');
    infraLabel.textContent = 'Infrastructure';
    for (const b of infraList.querySelectorAll('button')) b.classList.remove('active');
  };

  infraButton.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openInfra(infraList.hidden);
  });

  infraList.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-layer]');
    if (!b) return;
    state.mode = b.dataset.layer;
    state.selectedSea = null; state.hoveredSea = null;
    for (const other of els.toolbar.querySelectorAll('button[data-mode]')) other.classList.remove('active');
    for (const other of infraList.querySelectorAll('button')) other.classList.toggle('active', other === b);
    infraButton.classList.add('active');
    infraLabel.textContent = b.textContent;
    openInfra(false);
    invalidateBuffer();
  });

  document.addEventListener('click', () => openInfra(false));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') openInfra(false); });

  els.toolbar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    if (state.mode !== 'navy') { state.selectedSea = null; state.hoveredSea = null; }
    for (const other of els.toolbar.querySelectorAll('button[data-mode]')) {
      other.classList.toggle('active', other === b);
    }
    clearInfra();
    invalidateBuffer();
  });

  // Asks for confirmation before unload once the map is showing.
  window.addEventListener('beforeunload', (ev) => {
    if (!mapIsShowing()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

}

export { wireInput };
