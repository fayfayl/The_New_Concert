# Chron map engine

The map layer of a province-based strategy game: a 6000 × 2650 world drawn over satellite imagery, with everything about who borders whom derived from the bitmap rather than written by hand.

What exists is the renderer and everything needed to look at a map — political, province and terrain views, country labels that behave like an atlas, selection and adjacency, an east-west wrap, and a debug menu.

The world itself is still being drawn: provinces are added to `data/provinces.png` as the map fills out, and `sync-provinces.js` folds each new batch into the table. Nothing in the renderer cares how many there are. What does not exist at all yet is the game — no turns, armies, combat or events. See *Where this goes next*.

## Requirements

- **A way to serve a folder over HTTP.** Node or Python will do; both are covered below.
- **A modern browser.** Chrome, Edge or Firefox.

No dependencies to install. The browser code is plain JavaScript and the map data is already in `data/`, so there is nothing to build before running it — `sync-provinces.js` is only needed after you redraw the bitmap. `package.json` exists solely to mark the folder as ES modules so Node and the browser agree on `import`.

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
| Console warns about unrecognised colours | You have painted provinces the JSON does not know about. Run `node sync-provinces.js --write`. Until you do, those areas render as ocean. |
| Console says the cache is out of date | Expected after redrawing the map. Harmless — it recomputes. Rebuild with `--cache`. See *The map cache*. |
| Port already in use | Something else is on that port. Use `npx serve . -l 4000`. |
| A change to the code seems to do nothing | The browser is running a cached copy of the module. `serve.json` disables caching for `npx serve`; on any other server, hard-refresh with `Ctrl+Shift+R`. |

## What you should see

The world, fitted to the window. Hover to read a province's name, click to select. The selected province lightens and is ringed in gold, and **its neighbours lighten too**, more gently — that highlight comes from adjacency derived from the bitmap, not from a hand-written list. Dropping a selection fades it out rather than snapping it off.

Drag to pan; the map loops east-west. Three map views: political, province, terrain.

| Key | |
|---|---|
| `+` / `-` | zoom |
| `0` | fit the whole map |
| `` ` `` | debug menu |
| `Esc` | clear the selection |

Press `` ` `` (backtick), or the **Debug** button, to slide out the debug menu. It is a development tool rather than part of the game, so it stays closed until asked for and takes up no space when closed.

**Overlays.** Each draws over the finished map, costs nothing while off, and needs only a redraw to toggle:

| Overlay | Shows | Useful for |
|---|---|---|
| Satellite | The imagery under the province colours | Comparing the political layer against the terrain |
| Polity labels | Country names along their territory | The normal map label layer |
| Province names | Every province's name at its centroid | Checking names and finding a province by eye |
| Chunk grid | The tile grid, with the chunks being drawn lit up | Watching the culling in `drawView()` work |
| Adjacency links | Lines from the selected province to its neighbours | Verifying the adjacency derived from pixels |
| Selection bounds | The selected province's box and centroid | Seeing what a partial repaint costs |
| Coastal flags | A dot on every province touching open sea | Checking the coastline scan |

Province names are skipped for anything under 30 screen pixels wide, so how many appear depends on zoom; the count is reported in the readout.

Most overlays only need a redraw, so they cost nothing to toggle. **Satellite** is the exception — it is composited into the painted map rather than drawn over it, so switching it forces a full repaint. Its button carries `data-repaint` to say so.

**Performance** reports frame rate, blit time, last paint time, how many full and partial repaints have happened, whether the map is being drawn from tiles or the overview, how many chunks are on screen, and how long loading took — flagged when it fell back to computing rather than using the cache. Figures outside a healthy range turn orange. **Map** reports the loaded map's dimensions, province and border counts, the chunk grid, overview and imagery sizes, and how many provinces in the JSON matched no pixels.

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

### Polity labels

Names belong to the **map**, not to the screen. A label is sized and placed in map units and scales with the zoom, as though painted onto the terrain, so a country's name covers the same part of that country however far in you are. There is deliberately no maximum size: capping it would stop the text growing once the cap was hit, which reads as the label sliding inward off its own country.

Zoom changes only how *visible* a label is, and that is driven by the label's **own size on screen** rather than by the zoom level:

- below `LABEL_FADE_IN[0]` it is unreadable and not drawn
- it fades up to full strength by `LABEL_FADE_IN[1]`
- it holds until `LABEL_FADE_OUT[0]`
- it fades away by `LABEL_FADE_OUT[1]`, the name having grown so large that you are plainly looking at provinces rather than countries

Tying this to size rather than zoom is what makes each label behave sensibly on its own terms. A fade driven by zoom dims every label in lockstep, so zooming in fades out a small country's name at the very moment it finally became readable. Driven by size, a large country's name disappears at a much lower zoom than a small one's — which is what the equivalent map in Hearts of Iron looks like, and why big names go first.

The obvious next step is a second tier: fade province names in as polity names fade out, so there is always exactly one useful level of naming on screen. The **Province names** debug overlay already draws that layer.

### East-west wrapping

The map loops horizontally, like Google Maps: pan east far enough and you come back round to where you started, and at the seam the far edge of the map continues into the near one.

`wrapOffsets()` works out how many copies of the map are needed to fill the window — usually one or two, three on a very wide window at low zoom — and everything is drawn once per copy. `clampPan()` wraps `view.x` back into a single map width rather than clamping it, so the offset cannot drift off into numbers large enough to lose precision. Hit testing wraps the same way, so a click on any copy lands on the same province.

There is no vertical wrapping — the poles are not joined — so `view.y` is still clamped to keep the map on screen.

Note that adjacency does **not** wrap. Both edges of the current bitmap are open ocean, so nothing actually joins across the seam; if you ever draw land that touches both edges, `scanAdjacency()` and the border test in `paintTileRegion()` would need to compare column `width - 1` against column `0`.

### Satellite imagery

`data/satellite.png` is optional. If present it is drawn *underneath* the province colours, and the **Satellite** switch in the debug menu turns it on and off. If the file is missing the switch is simply disabled.

It must be the same dimensions as `provinces.png`, since it is blitted with the same coordinates; a mismatch is reported in the console.

The province layer is composited with a **per-pixel alpha**, so a country's colour is emphatic along its frontier and falls away inland — the terrain reads through the middle of a large country while its shape stays unmistakable.

That needs to know, for every land pixel, how far it is from the nearest *national* border — a boundary with a different owner or with open sea. `buildBorderDistance()` computes it as a two-pass chamfer distance transform: one pass carrying distances down and right, one back up and left, after which every pixel has effectively seen the whole map in two linear passes rather than a search each. A diagonal step is weighted 4 against 3 for an orthogonal one, approximating √2 to within 5.7% in every direction, which keeps a distance inside one byte — 16 MB rather than the 64 MB an exact float field would need. That also caps the measurable distance at 85 map pixels, which `FADE_PX` must stay under.

The blend is resolved into a 256-entry lookup so the pixel loop is a table read rather than a curve. `FADE_CURVE` shapes it: below 1 it concentrates the falloff near the border, giving a defined band of colour that drops away quickly instead of an even wash.

Inland the colour is not merely thinner but **softer**. Each province has two colours — its own, used at the frontier, and a pastel wash of it (`PASTEL_MIX` toward `PASTEL_TOWARD`) for deep inside — and the pixel loop blends between them by the same distance. Thinning alone leaves the interior reading as a dim version of the border colour rather than as a distinct pastel field.

| Constant | Controls |
|---|---|
| `SATELLITE_NATIONAL` | the drawn frontier line itself |
| `SATELLITE_INTERNAL` | province subdivisions, added to whatever the local fill is |
| `SATELLITE_RIM` | country colour hard against a national border |
| `SATELLITE_CORE` | country colour deep inland, past `FADE_PX` |
| `SATELLITE_FLAT` | the even fill used by the province and terrain views |
| ocean | fully transparent, so the imagery's own sea shows |

Only the **political** view is shaped by distance from a frontier. The others fill evenly at `SATELLITE_FLAT`, with no pastel wash — a province or a terrain type should read the same in the middle of a country as at its edge, and fading them only made their centres mottled and illegible.

Highlighted provinces get `SATELLITE_LIFT` added on top, or a selection deep inside a large country would be too faint to make out.

The distance field is only built when there is imagery to fade into, since it is three passes over every pixel.

The imagery is kept as an `ImageBitmap`, not decoded to a pixel array — it is only ever blitted, never inspected, so it can live on the GPU instead of adding 60 MB to the JavaScript heap.

### The map cache

Deriving the world from the bitmap costs about 800 ms — a colour lookup per pixel, an adjacency scan, a distance transform, and two more full-map passes for the label geometry. None of it depends on anything that happens at runtime, so it is precomputed:

```
node sync-provinces.js --cache            # build data/map-cache.bin
node sync-provinces.js --write --cache    # sync the JSON and rebuild it
```

That writes 45 MB of precomputed data, deflated to about **0.3 MB**. Loading it takes ~70 ms instead of ~790 ms, and the province bitmap never has to be decoded at all. The debug menu reports which path was taken under **Load**.

**The cache is an optimisation, never a source of truth.** It stores a hash of the bitmap's bytes and of the ids, colours and owners in the JSON. If either has changed, the reader discards it, computes everything from scratch, and logs how to rebuild — a stale cache showing yesterday's borders would be a horrible bug, so it is made impossible rather than merely unlikely. Renaming a province does *not* invalidate it, since no derived data depends on names.

Missing, corrupt or old-format caches all fall through to the same path, so deleting `map-cache.bin` is always safe. It just makes loading slower.

The scans themselves live in `src/mapdata.js`, imported by both the browser and the build script. That sharing is the point: these passes decide adjacency, borders and label placement, and a build script quietly disagreeing with the renderer would be miserable to debug. There is one copy and both sides run it. `src/mapcache.js` holds the file format, likewise shared.

Label *geometry* is cached, but the labels themselves are always finished in the browser — choosing a font size and line breaks means measuring real text, which needs a canvas.

### Keeping a large map fast

Drawing is split in two. **Painting** works at map resolution into offscreen canvases and only runs when a colour changes; **blitting** puts the result on screen through the pan/zoom transform, and is all a pan or zoom actually needs.

At 6000 × 2650 the painting is expensive — 15.9 million pixels — so it runs as rarely as possible:

- **Hovering and selecting repaint only the provinces that changed**, by bounding box, via `repaintProvinces()`. A province's own pixels are the only ones whose colour can change, since the border test reads a neighbour's *owner*. On the current map the median province box is about 1,200 pixels, so a hover touches roughly 2,300 instead of 15.9 million.
- **A full repaint happens only on load and on a change of map mode**, which are the only things that recolour everything at once.
- **The painted map is a grid of 512-pixel tiles**, not one canvas. A repaint uploads only the chunks it overlaps instead of a 64 MB texture, and drawing skips every chunk outside the window. At 6000×2650 that is 72 chunks, of which about 15 are on screen at 100% zoom and 4 at 400%.
- **A downscaled overview of the whole map** is kept alongside them, and used whenever the zoom is low enough that it holds as many pixels as the screen can show. Zoomed out, the entire map is visible, so going tile by tile would mean rescaling all 15.9 million pixels every frame; the overview is 2048×905, about a tenth of that, and is never drawn larger than its own resolution so nothing is lost.
- **One 512×512 scratch buffer is shared by every tile**, rather than a full-map pixel array. 1 MB instead of 61 MB.

Both are kept in step by the same repaint: tiles first, then the same rectangle is copied down into the overview.

Border darkening reads the map array rather than the tile, so borders falling on a chunk edge are drawn from the same data as any other and no seam appears.

If the map grows much beyond this, the next things to reach for are painting tiles lazily as they first come on screen, and a second overview level between the current one and full resolution.

### Borders and coastline

Neither is stored anywhere. Both are found per pixel in `paintTileRegion()`: any land pixel whose right or down neighbour belongs to a different province is darkened. How much depends on who owns the neighbour — provinces sharing an owner get a light internal line (`BORDER_INTERNAL`), while a different owner or the open sea gets a strong one (`BORDER_NATIONAL`). So national borders and coastlines read at a glance while internal subdivisions stay quiet.

Because it only tests right and down, the line falls on one side of each boundary rather than being shared, and it is always one map pixel wide, so it thins out visually as you zoom in.

The adjacency behind it comes from `scanAdjacency()` in `src/mapdata.js`, which does two passes over the pixels at load:

1. Map every pixel to a province id via its colour.
2. Compare each pixel with the one to its right and the one below. Wherever two different ids touch, record a border. Wherever a province touches ocean, mark it coastal.

Checking only right and down is enough to catch every touching pair exactly once — a left-right pair is seen from the left pixel, a top-bottom pair from the upper one. Provinces meeting only at a diagonal do not count as neighbours, which matches how armies move.

That second pass is the whole adjacency system. It means you never maintain a neighbour list by hand, and the rule that a polity may only attack regions adjacent to its own has real data behind it.

## Redrawing the map

`sync-provinces.js` reconciles `provinces.json` with `provinces.png`. Run it after every edit to the bitmap.

```
node sync-provinces.js                    # report only, writes nothing
node sync-provinces.js --write            # apply
node sync-provinces.js --write --cache    # apply, then rebuild the map cache
```

It matches provinces **by colour**, so any names, owners and terrain you have already filled in survive a redraw. New colours are added with placeholder values.

Entries whose colour has vanished from the bitmap are reported as **stale** and kept, because painting over a province by accident should not silently destroy data you typed in by hand. Pass `--prune` to actually delete them. Pass `--reslug` to regenerate ids from the current province names.

It also prints a short survey of the map: which provinces are made of several disconnected pieces, and which five are smallest. Both are just information — island chains, exclaves and one-tile islands are all legitimate. If you do want to hunt for stray pixels after a messy edit, `--min-size=5` lists anything below that size and says nothing when there is nothing to find.

The ocean colour is taken from `oceanColour` in the JSON. If that colour is not actually present in the bitmap, the most common colour is used instead and the JSON is updated to match — so a white background works with no configuration.

## Where this goes next

The renderer is in good shape. The world is still being drawn, and the game has not been started. In rough order:

1. **Turn loop.** A "next turn" button and a date. The Rundean calendar is 12 months of 28–31 days; a weekly or monthly tick is probably the right granularity.
2. **Ownership changes.** Transfer a province between polities and re-render. Nearly trivial now that ownership is just a field — but note that `borderDist` is derived from ownership, so a transfer invalidates it. Rebuilding it costs ~230 ms, so it will want to be done incrementally around the provinces that changed.
3. **Armies and movement.** Units sit in a province and may only move to one in its adjacency set. The rule enforces itself.
4. **Combat.** Attacker vs defender strength, modified by the terrain tag.
5. **Events.** Load the event list as JSON; each entry gets a date, a condition, a probability, and effects. The structure in *Simulation Rules* maps onto this almost directly.
6. **AI.** Last, and simpler than it sounds once 1–5 exist.

Do not start on content until 1–4 work. They are the game.

Two smaller things worth doing at some point, both measured rather than guessed:

- **A full repaint spends 96% of its time on ocean.** Only 4% of the map is land, yet a mode change rewrites all 15.9 million pixels. Filling ocean once and then repainting each province by bounding box — machinery that already exists for hover — should take that 230 ms hitch to roughly 15 ms.
- **A second label tier.** Fade province names in as polity names fade out, so there is always about one useful level of naming on screen. The **Province names** overlay already draws that layer.

If the map ever needs to be genuinely dynamic — ownership changing every turn, animated — the answer is to move compositing to the GPU: the province ids as a texture, a 42-entry palette texture, and a fragment shader doing the lookup. Selection, hover and mode changes then cost a palette rewrite of a few hundred bytes instead of a repaint, and the tiles, overview and partial-repaint machinery all disappear. Worth doing before more features are layered onto the CPU path, not after.

## Files

```
index.html          layout and styling
package.json        marks the folder as ES modules; no dependencies
sync-provinces.js   the build step — reconcile the JSON, write the cache
src/main.js         rendering, labels, interaction
src/mapdata.js      the scans: adjacency, borders, label geometry (shared with the build step)
src/mapcache.js     the precomputed-map file format (shared)
data/provinces.png  the province bitmap — source of truth for shape
data/provinces.json the province table — source of truth for data
data/satellite.png  optional imagery
data/map-cache.bin  optional precomputed map, safe to delete — see The map cache
```

`src/main.js` is organised in numbered sections, listed at the top of the file: data loading, world model, rendering, labels, view, debug overlays, app, input, boot.
