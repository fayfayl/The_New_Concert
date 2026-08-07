# Province map prototype

The foundation layer for a province-based strategy game. It proves out the one decision everything else depends on: how provinces are stored, identified, and turned into an adjacency graph.

## Requirements

- **A way to serve a folder over HTTP.** Node or Python will do; both are covered below.
- **A modern browser.** Chrome, Edge or Firefox.

There are no dependencies and no build step. The browser code is plain JavaScript, and the map data is already in `data/`.

## Running it

**1. Start a web server in this folder.**

```
npx serve .
```

The first time, `npx` will ask permission to download `serve`; answer yes. If you would rather not use npx, any of these do the same job:

```
python -m http.server 8000        # Python 3
py -m http.server 8000            # Windows, if 'python' is not on PATH
npx http-server -p 8000
```

**2. Open the address it prints** — normally <http://localhost:3000> for `serve`, or <http://localhost:8000> for the Python ones.

Leave the server running while you work. After editing any file, just refresh the browser; there is no rebuild step.

To stop the server, press `Ctrl+C` in that terminal.

### Why a server is needed

Opening `index.html` by double-clicking will **not** work. The page reads the map bitmap pixel by pixel, and browsers block that for files loaded over `file://` as a security measure. Serving the folder over HTTP is the whole fix. If you forget, the page tells you so rather than failing silently.

### If something goes wrong

| Symptom | Cause |
|---|---|
| "Failed to start… could not load" | Opened the file directly instead of through a server. |
| `node: command not found` | Node is not installed, or not on PATH. Use the Python server instead. |
| Page loads but the map is blank | `data/provinces.png` or `data/provinces.json` is missing. |
| Console warns about unrecognised colours | The bitmap has anti-aliased or compressed edges. See *Drawing your own map*. |
| Port already in use | Something else is on that port. Use `npx serve . -l 4000`. |

## What you should see

A landmass of 34 provinces. Hover to read a name, click to select. The selected province lightens and is ringed in yellow-orange, and **its neighbours lighten too**, more gently — that highlight is computed from the bitmap at load time, not from a hand-written list.

Three map modes: political, province, terrain.

Press `` ` `` (backtick), or the **Debug** button, to slide out the debug menu. It is a development tool rather than part of the game, so it stays closed until asked for and takes up no space when closed.

**Overlays.** Each draws over the finished map, costs nothing while off, and needs only a redraw to toggle:

| Overlay | Shows | Useful for |
|---|---|---|
| Polity labels | Country names along their territory | The normal map label layer |
| Province names | Every province's name at its centroid | Checking names and finding a province by eye |
| Chunk grid | The tile grid, with the chunks being drawn lit up | Watching the culling in `drawView()` work |
| Adjacency links | Lines from the selected province to its neighbours | Verifying the adjacency derived from pixels |
| Selection bounds | The selected province's box and centroid | Seeing what a partial repaint costs |
| Coastal flags | A dot on every province touching open sea | Checking the coastline scan |

Province names are skipped for anything under 30 screen pixels wide, so how many appear depends on zoom; the count is reported in the readout.

**Performance** reports frame rate, blit time, last paint time, how many full and partial repaints have happened, whether the map is being drawn from tiles or the overview, and how many chunks are on screen. Figures outside a healthy range turn orange. **Map** reports the loaded map's dimensions, province and border counts, the chunk grid and overview sizes, and how many provinces in the JSON matched no pixels.

**Selected** shows the clicked province's data and its adjacent provinces; clicking one jumps to it.

## How it works

**`data/provinces.png`** is the source of truth for *shape* and *neighbours*. Every province is one unique flat RGB colour. Ocean is a reserved colour.

**`data/provinces.json`** is the source of truth for *data* — name, owner, terrain — keyed by that colour. Colours are hex strings; they are converted to `[r, g, b]` once at load, so plain arrays work too.

Ids are strings, so events and save data can refer to `"rodtfjell"` rather than to a number that shifts whenever the map is redrawn. Internally each province also gets a small integer index, because the per-pixel array is a typed array and can only hold numbers; nothing outside `buildWorld()` sees it.

`terrain` is a list, since a province can be more than one thing at once:

```json
{ "id": "rodtfjell", "name": "Rodtfjell", "colour": "#bbffb7", "terrain": ["Mountains", "Arctic"], "owner": "NONE" }
```

A bare string is accepted as shorthand for a one-element list. In terrain map mode a province is drawn as the blend of its tags, so Mountains + Arctic comes out as pale snowfield rather than as either alone. Your rules already say provinces with several tags "mix these properties appropriately" — this is the data behind that.

`Impassable` is handled apart from the rest. The rules make it a property a region carries rather than a landscape of its own, so it is not blended into the average — it is laid over the result as a darkening. A province tagged Mountains + Impassable still reads as mountains, just shut.

### East-west wrapping

The map loops horizontally, like Google Maps: pan east far enough and you come back round to where you started, and at the seam the far edge of the map continues into the near one.

`wrapOffsets()` works out how many copies of the map are needed to fill the window — usually one or two, three on a very wide window at low zoom — and everything is drawn once per copy. `clampPan()` wraps `view.x` back into a single map width rather than clamping it, so the offset cannot drift off into numbers large enough to lose precision. Hit testing wraps the same way, so a click on any copy lands on the same province.

There is no vertical wrapping — the poles are not joined — so `view.y` is still clamped to keep the map on screen.

Note that adjacency does **not** wrap. Both edges of the current bitmap are open ocean, so nothing actually joins across the seam; if you ever draw land that touches both edges, `scanAdjacency()` and the border test in `paintTileRegion()` would need to compare column `width - 1` against column `0`.

### Satellite imagery

`data/satellite.png` is optional. If present it is drawn *underneath* the province colours, and the **Satellite** button in the toolbar turns it on and off. If the file is missing the button is simply disabled.

It must be the same dimensions as `provinces.png`, since it is blitted with the same coordinates; a mismatch is reported in the console.

The province layer is composited with a **per-pixel alpha**, so a country's colour is emphatic along its frontier and falls away inland — the terrain reads through the middle of a large country while its shape stays unmistakable.

That needs to know, for every land pixel, how far it is from the nearest *national* border — a boundary with a different owner or with open sea. `buildBorderDistance()` computes it as a two-pass chamfer distance transform: one pass carrying distances down and right, one back up and left, after which every pixel has effectively seen the whole map in two linear passes rather than a search each. A diagonal step is weighted 4 against 3 for an orthogonal one, approximating √2 to within 5.7% in every direction, which keeps a distance inside one byte — 16 MB rather than the 64 MB an exact float field would need. That also caps the measurable distance at 85 map pixels, which `FADE_PX` must stay under.

Opacity is then resolved into a 256-entry lookup so the pixel loop is a table read rather than a curve, using a smoothstep rather than a straight ramp — a linear fade leaves a visible crease where it flattens out.

| | Alpha |
|---|---|
| `SATELLITE_EDGE` | the drawn border lines themselves |
| `SATELLITE_RIM` | country colour hard against a national border |
| `SATELLITE_CORE` | country colour deep inland, past `FADE_PX` |
| ocean | fully transparent, so the imagery's own sea shows |

Highlighted provinces get `SATELLITE_LIFT` added on top, or a selection deep inside a large country would be too faint to make out.

The distance field is only built when there is imagery to fade into, since it is three passes over every pixel.

The imagery is kept as an `ImageBitmap`, not decoded to a pixel array — it is only ever blitted, never inspected, so it can live on the GPU instead of adding 60 MB to the JavaScript heap.

### Keeping a large map fast

Drawing is split in two. `renderBuffer()` paints the map into an offscreen canvas at map resolution; `drawView()` blits that through the pan/zoom transform. Only the second runs while you pan or zoom.

On a 6000×2650 map the first is expensive — 15.9 million pixels — so it runs as rarely as possible:

- **Hovering and selecting repaint only the provinces that changed**, by bounding box, via `repaintProvinces()`. A province's own pixels are the only ones whose colour can change, since the border test reads a neighbour's *owner*. On the current map the median province box is about 1,200 pixels, so a hover touches roughly 2,300 instead of 15.9 million.
- **A full repaint happens only on load and on a change of map mode**, which are the only things that recolour everything at once.
- **The painted map is a grid of 512-pixel tiles**, not one canvas. A repaint uploads only the chunks it overlaps instead of a 64 MB texture, and drawing skips every chunk outside the window. At 6000×2650 that is 72 chunks, of which about 15 are on screen at 100% zoom and 4 at 400%.
- **A downscaled overview of the whole map** is kept alongside them, and used whenever the zoom is low enough that it holds as many pixels as the screen can show. Zoomed out, the entire map is visible, so going tile by tile would mean rescaling all 15.9 million pixels every frame; the overview is 2048×905, about a tenth of that, and is never drawn larger than its own resolution so nothing is lost.
- **One 512×512 scratch buffer is shared by every tile**, rather than a full-map pixel array. 1 MB instead of 61 MB.

Both are kept in step by the same repaint: tiles first, then the same rectangle is copied down into the overview.

Border darkening reads the map array rather than the tile, so borders falling on a chunk edge are drawn from the same data as any other and no seam appears.

If the map grows much beyond this, the next things to reach for are painting tiles lazily as they first come on screen, and a second overview level between the current one and full resolution.

### Borders and coastline

Neither is stored anywhere. Both are drawn in `renderBuffer()`: any land pixel whose right or down neighbour belongs to a different province is darkened. How much depends on who owns the neighbour — provinces sharing an owner get a light internal line (`BORDER_INTERNAL`), while a different owner or the open sea gets a strong one (`BORDER_NATIONAL`). So national borders and coastlines read at a glance while internal subdivisions stay quiet.

Because it only tests right and down, the line falls on one side of each boundary rather than being shared, and it is always one pixel wide, so it thins out visually as you zoom in.

At load, `buildWorld()` does two passes over the pixels:

1. Map every pixel to a province id via its colour.
2. Compare each pixel with the one to its right and the one below. Wherever two different ids touch, record a border. Wherever a province touches ocean, mark it coastal.

That second pass is the whole adjacency system. It means you never maintain a neighbour list by hand, and your "a polity can only attack regions adjacent to its own" rule has real data behind it.

## Redrawing the map

`sync-provinces.js` reconciles `provinces.json` with `provinces.png`. Run it after every edit to the bitmap.

```
node sync-provinces.js            # report only, writes nothing
node sync-provinces.js --write    # apply
```

It matches provinces **by colour**, so any names, owners and terrain you have already filled in survive a redraw. New colours are added with placeholder values.

Entries whose colour has vanished from the bitmap are reported as **stale** and kept, because painting over a province by accident should not silently destroy data you typed in by hand. Pass `--prune` to actually delete them. Pass `--reslug` to regenerate ids from the current province names.

It also prints a short survey of the map: which provinces are made of several disconnected pieces, and which five are smallest. Both are just information — island chains, exclaves and one-tile islands are all legitimate. If you do want to hunt for stray pixels after a messy edit, `--min-size=5` lists anything below that size and says nothing when there is nothing to find.

The ocean colour is taken from `oceanColour` in the JSON. If that colour is not actually present in the bitmap, the most common colour is used instead and the JSON is updated to match — so a white background works with no configuration.

## Where this goes next

In rough order:

1. **Turn loop.** A "next turn" button and a date. Your calendar is 12 months of 28–31 days; a weekly or monthly tick is probably the right granularity.
2. **Ownership changes.** Transfer a province between polities and re-render. Trivial now that ownership is just a field.
3. **Armies and movement.** Units sit in a province and may only move to one in its adjacency set. The rule enforces itself.
4. **Combat.** Attacker vs defender strength, modified by the terrain tag.
5. **Events.** Load your event list as JSON; each entry gets a date, a condition, a probability, and effects. The structure you already wrote maps onto this almost directly.
6. **AI.** Last, and simpler than it sounds once 1–5 exist.

Do not start on content until 1–4 work. They are the game.

## Files

```
index.html          layout and styling
src/main.js         loading, adjacency, rendering, interaction
data/provinces.png  the province bitmap
data/provinces.json the province table
```
