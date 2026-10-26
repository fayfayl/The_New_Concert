// Overlay text and the debug drawings.

const VERSION = new URL(import.meta.url).search;
const { state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let NAME_MIN_PX, OVERLAY_FONT, TILE, debug, label, overviewCovers, tilesOver, view, visibleRect;
export function link(all) { ({ NAME_MIN_PX, OVERLAY_FONT, TILE, debug, label, overviewCovers, tilesOver, view, visibleRect } = all); }

function drawOverlays(ctx, cssW, cssH, dx) {
  if (state.showCoastal) drawCoastalFlags(ctx, cssW, cssH, dx);
  if (state.showProvinceNames) drawProvinceNames(ctx, cssW, cssH, dx);
  if (state.showSeaNames) drawSeaNames(ctx, cssW, cssH, dx);
  if (state.showAdjacency) drawAdjacency(ctx);
  if (state.showBounds) drawSelectionBounds(ctx);
  if (state.showChunks) drawChunkGrid(ctx, cssW, cssH, dx);
  if (state.showSeams) drawSeams(ctx, cssW, cssH, dx);
}

// Sets up the stroke-then-fill style shared by the text overlays.
function overlayText(ctx, weight = .95) {
  ctx.font = OVERLAY_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(6,8,12,.85)';
  ctx.fillStyle = `rgba(232,238,246,${weight})`;
}

// Every province's name at its centroid, skipping those too small to read.
function drawProvinceNames(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  overlayText(ctx);
  let drawn = 0;
  for (const [id, bb] of w.bounds) {
    if ((bb.maxX - bb.minX + 1) * s < NAME_MIN_PX) continue;      // too small to read
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < -120 || y < -20 || x + dx > cssW + 120 || y > cssH + 20) continue;   // off screen
    const name = w.byId.get(id).name;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
    drawn++;
  }
  ctx.restore();
  debug.names = drawn;
}

// Every sea region's name at its centroid, in a colder tint.
function drawSeaNames(ctx, cssW, cssH, dx) {
  const sea = state.world.sea;
  if (!sea) return;

  const s = view.scale;
  ctx.save();
  overlayText(ctx);
  ctx.fillStyle = 'rgba(150,206,244,.95)';
  let drawn = 0;
  for (const [id, bb] of sea.bounds) {
    if ((bb.maxX - bb.minX + 1) * s < NAME_MIN_PX) continue;    // too small to read
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < -120 || y < -20 || x + dx > cssW + 120 || y > cssH + 20) continue;
    const r = sea.byId.get(id);
    const name = r.lake ? `${r.name} (lake)` : r.name;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
    drawn++;
  }
  ctx.restore();
  debug.seaNames = drawn;
}

// Tile grid with chunk coordinates; drawn chunks lit brightly.
function drawChunkGrid(ctx, cssW, cssH, dx) {
  if (!live.tiles) return;
  const s = view.scale;
  const usingTiles = !overviewCovers(s);

  const inUse = new Set();
  if (usingTiles) {
    const rect = visibleRect(view.x + dx, cssW, cssH);
    if (rect) for (const t of tilesOver(rect.x0, rect.y0, rect.x1, rect.y1)) inUse.add(t);
  }

  ctx.save();
  ctx.font = OVERLAY_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;

  for (const tile of live.tiles.list) {
    const x = Math.round(tile.x * s + view.x), y = Math.round(tile.y * s + view.y);
    const x1 = Math.round((tile.x + tile.w) * s + view.x), y1 = Math.round((tile.y + tile.h) * s + view.y);
    if (x1 + dx < 0 || y1 < 0 || x + dx > cssW || y > cssH) continue;

    const live = inUse.has(tile);
    ctx.strokeStyle = live ? 'rgba(168,189,212,.9)' : 'rgba(127,151,178,.28)';
    ctx.strokeRect(x + .5, y + .5, x1 - x - 1, y1 - y - 1);

    if (x1 - x > 74 && y1 - y > 26) {
      const label = `${tile.x / TILE},${tile.y / TILE}`;
      ctx.fillStyle = live ? 'rgba(168,189,212,.95)' : 'rgba(127,151,178,.45)';
      ctx.fillText(label, x + 5, y + 4);
    }
  }
  ctx.restore();
}

// Lines from the selected province to each neighbour.
function drawAdjacency(ctx) {
  const w = state.world;
  if (!state.selected) return;
  const from = w.bounds.get(state.selected);
  if (!from) return;
  const s = view.scale;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(168,189,212,.75)';
  ctx.fillStyle = 'rgba(232,238,246,.9)';
  for (const id of w.adjacency.get(state.selected)) {
    const to = w.bounds.get(id);
    if (!to) continue;
    ctx.beginPath();
    ctx.moveTo(from.cx * s + view.x, from.cy * s + view.y);
    ctx.lineTo(to.cx * s + view.x, to.cy * s + view.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(to.cx * s + view.x, to.cy * s + view.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// The selected province's bounding box and centroid.
function drawSelectionBounds(ctx) {
  const w = state.world;
  if (!state.selected) return;
  const bb = w.bounds.get(state.selected);
  if (!bb) return;
  const s = view.scale;
  const x = bb.minX * s + view.x, y = bb.minY * s + view.y;
  const bw = (bb.maxX - bb.minX + 1) * s, bh = (bb.maxY - bb.minY + 1) * s;

  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(217,140,95,.9)';
  ctx.strokeRect(x + .5, y + .5, bw, bh);
  ctx.setLineDash([]);

  ctx.beginPath();                                  // centroid: where a label anchors
  ctx.arc(bb.cx * s + view.x, bb.cy * s + view.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(217,140,95,.95)';
  ctx.fill();
  ctx.restore();
}

// Seam markers: copy joins, tile columns and the overview's right edge.
function drawSeams(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  ctx.lineWidth = 1;

  ctx.strokeStyle = 'rgba(0,220,255,.55)';
  for (let x = TILE; x < w.width; x += TILE) {
    const sx = Math.round(view.x + x * s) + 0.5;
    if (sx + dx < -1 || sx + dx > cssW + 1) continue;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,0,220,.95)';
  for (const x of [0, w.width]) {
    const sx = Math.round(view.x + x * s) + 0.5;
    if (sx + dx < -1 || sx + dx > cssW + 1) continue;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,150,0,.9)';
  const last = Math.round(view.x + Math.floor(w.width / TILE) * TILE * s) + 0.5;
  if (!(last + dx < -1 || last + dx > cssW + 1)) {
    ctx.beginPath(); ctx.moveTo(last, 0); ctx.lineTo(last, cssH); ctx.stroke();
  }
  ctx.restore();
}

// A dot on every province the pixel scan found touching open sea.
function drawCoastalFlags(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(120,200,225,.85)';
  for (const id of w.coastal) {
    const bb = w.bounds.get(id);
    if (!bb) continue;
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < 0 || y < 0 || x + dx > cssW || y > cssH) continue;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export { drawOverlays, overlayText, drawProvinceNames, drawSeaNames, drawChunkGrid, drawAdjacency, drawSelectionBounds, drawSeams, drawCoastalFlags };
