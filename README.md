# Hearts of Iron Chron

*(placeholder name)*

A province-based grand-strategy game set in the world of Chron. The map is a 6000 × 2650 bitmap drawn over satellite imagery. Adjacency, borders and coastlines are derived from the bitmap rather than maintained by hand.

`data/provinces.png` is in progress. Large areas have no provinces on them yet, and more are added as it fills out. Counts in this document describe what is currently painted: at present 755 provinces, 70 polities and 83 cities. The renderer does not depend on any of them, and `sync-provinces.js` folds each new batch into the table.

There are no turns, date, armies, combat, events or AI. What is implemented is the map: three views, provinces and cities that can be read, selection and adjacency. See [Where this goes next](#where-this-goes-next).

## Running it

Requirements: a way to serve a folder over HTTP, and a current browser. There is nothing to install and no build step. `package.json` exists only to mark the folder as ES modules so Node and the browser agree on `import`.

The server must be started **from this folder**, since it serves the current directory. Change into it first:

```
cd "<path>\Hearts_of_Iron_Chron"
```

In Windows `cmd`, that fails silently if the folder is on a different drive from the one the prompt is on: `cd` changes directory but not drive, and reports nothing when it does neither. Use `cd /d`, which does both.

```
cd /d "<path>\Hearts_of_Iron_Chron"
```

PowerShell, Git Bash and macOS or Linux shells do not need `/d`. Quote the path if it contains spaces.

Then start the server:

```
npx serve .
```

The first run of `npx` asks permission to download `serve`. These are equivalent:

```
python -m http.server 8000        # Python 3
py -m http.server 8000            # Windows, if 'python' is not on PATH
npx http-server -p 8000
```

Open the address printed — usually <http://localhost:3000> for `serve`, <http://localhost:8000> for the others. Leave the server running; after editing a file, refresh. `Ctrl+C` stops it.

Opening `index.html` directly does not work. The page reads the bitmap pixel by pixel, which browsers block for pages loaded over `file://`. Serving the folder over HTTP is the fix, and the page reports the failure rather than rendering nothing.

### Troubleshooting

| Symptom | Cause |
|---|---|
| "Failed to start… could not load" | Opened the file directly instead of through a server. |
| `node: command not found` | Node is not installed or not on PATH. Use the Python server. |
| Server starts but every page is 404 | Started from the wrong directory. `cd` into this folder first; in `cmd`, use `cd /d` to cross drives. |
| Page loads but the map is blank | `data/provinces.png` or `data/provinces.json` is missing. |
| Console warns about unrecognised colours | Provinces painted that the JSON does not list. Run `node sync-provinces.js --write`. Until then those areas render as ocean. |
| Console reports the cache is out of date | Expected after redrawing the map. The map is recomputed. Rebuild with `--cache`. |
| Port already in use | `npx serve . -l 4000`. |
| A code change has no effect | The browser is running a cached module. `serve.json` disables caching for `npx serve`; elsewhere hard-refresh with `Ctrl+Shift+R`. |

## Using it

| Key | |
|---|---|
| `+` / `-` | zoom |
| `0` | fit the whole map |
| `` ` `` | debug menu |
| `Esc` | clear the selection |

### The debug menu

Opened with `` ` `` or the **Debug** button. It is a development tool and is closed by default.

| Overlay | Shows |
|---|---|
| Satellite | The imagery under the province colours |
| Cities | City and capital markers and their names |
| Polity labels | Country names along their territory |
| Province names | Every province's name at its centroid |
| Chunk grid | The tile grid, with the chunks being drawn highlighted |
| Adjacency links | Lines from the selected province to its neighbours |
| Selection bounds | The selected province's bounding box and centroid |
| Coastal flags | A dot on every province touching open sea |

Most overlays need only a redraw. **Satellite** is composited into the painted map rather than drawn over it, so toggling it forces a full repaint and is noticeably slower.

**Performance** reports frame rate, blit time, last paint time, repaint counts, whether the map is drawn from tiles or the overview, chunks on screen, canvas size in pixels, and load time with an indication of whether the cache was used. Values outside a healthy range are highlighted.

**Frame** is computed from an averaged frame *interval* rather than from averaged frame rates. `requestAnimationFrame` occasionally delivers two callbacks within one refresh; a rate is the reciprocal of the interval, so averaging rates lets a sub-millisecond interval raise the figure by hundreds while a slow frame can only reduce it towards zero. **Canvas** is the backing-store size, which determines whether a frame can be drawn in time. Display scaling applies to both axes, so 150% scaling is 2.25 times the area.

**Map** reports dimensions, province and border counts, the chunk grid, overview and imagery sizes, city counts, and the number of provinces in the JSON that matched no pixels. **Selected** shows the clicked province and its neighbours; clicking a neighbour selects it.

## The data

**`data/provinces.png`** defines shape and adjacency. Each province is one flat RGB colour. Ocean is a reserved colour.

**`data/provinces.json`** defines name, owner and terrain, keyed by that colour. Colours are hex strings, converted to `[r, g, b]` once at load.

Ids are strings, so events and save data can refer to `"rodtfjell"` rather than an index that changes when the map is redrawn. Each province also gets a small integer index internally, because the per-pixel array is typed. Nothing outside `buildWorld()` uses it.

`terrain` is a list, since a province can carry more than one type:

```json
{ "id": "rodtfjell", "name": "Rodtfjell", "colour": "#bbffb7", "terrain": ["Mountains", "Arctic"],
  "owner": "FNA", "area": 122207, "centre": [54.3829, -39.6923] }
```

`area` and `centre` are derived rather than authored — see [Area and distance](#area-and-distance). Everything else is yours to edit.

A bare string is shorthand for a single-element list. In terrain view a province is drawn as the blend of its tags, so Mountains + Arctic renders as pale snowfield rather than as either alone. The tags in use are Arctic, Desert, Hills, Jungle, Mountains and Plains.

`Impassable` is handled separately. It describes a property of a region rather than a landscape, so it is not blended into the average; it is applied over the result as a darkening. A province tagged Mountains + Impassable still reads as mountains.

**`data/true_area.png`** is the whole world on a full 2:1 equirectangular globe, 6000 × 3000, poles included. It holds the same provinces in the same colours as `provinces.png`, which is a band of it cropped short of both poles. Province areas are measured from this file; shapes, adjacency and everything drawn come from `provinces.png`. Without it the build step leaves areas untouched rather than guessing.

**`data/cities.png`** places cities. A `#000000` pixel is a capital and `#6B6B6B` an ordinary city. The build step determines which province each falls in. There are currently 83, of which 17 are capitals. A country with two capitals is intentional.

## How the map works

### Labels and cities

Country labels are sized and positioned in map units, so they scale with the zoom and each name covers the same part of its territory at any zoom. There is no maximum size. Each follows a spine fitted to the block's pixels, so the name runs with the shape of the land. Provinces within `NEAR_GAP` (5 px) of each other count as one block, so a country divided by a narrow strait gets one label. Visibility depends on the label's size on screen rather than on the zoom level: it fades in across `LABEL_FADE_IN` and out across `LABEL_FADE_OUT`, so large countries' names disappear first.

City markers are drawn at a fixed size on screen rather than scaling with the map. Markers and names have separate zoom thresholds — four in all, since capitals differ from ordinary cities — and the fade between states runs on a fixed timer rather than tracking the zoom.

City names are placed so as not to overlap each other, the markers, or the country labels beneath them, trying eight positions around the marker and taking the first that is clear. Capitals are placed first. Country labels are a weaker constraint than the rest: a city's position is fixed, so where a country label runs through it no alternative position helps, and the least obstructed position is used rather than the name being dropped.

Details of the geometry — glyph advance along the curve, the curvature limit, the overlap tests — are documented in the code.

### Area and distance

The projection is equirectangular, so a pixel count is not an area: a row at the equator spans a full circumference, a row near a pole almost nothing, and both are drawn the same width. A province at 60° comes out twice its real size.

Area is therefore computed per row. A band of a sphere between two latitudes has area 2πR²(sin φ₁ − sin φ₂), and a pixel is 1/width of that band; the rows sum to 4πR², which the build step prints as a check. Chron is a sphere with Earth's surface area, 510,072,000 km², giving R = 6371.047 km. (Earth's own radius and area cannot both be matched, since Earth is an ellipsoid.)

Areas are measured from `true_area.png` rather than from `provinces.png`. That file is the whole world on a 2:1 globe, so row 0 is the north pole and the last row the south, and a row is a latitude with nothing to line up. `provinces.png` is a band of the same globe cut off short of both poles; it remains the source of every shape the game draws, but land in the polar caps exists only in `true_area.png`.

The two hold the same provinces in the same colours, and currently agree on the pixel count for 832 of 841 — the rest is polar land the cropped file cannot reach. Colours in `true_area.png` that match no province are reported and not counted; a handful is normal export residue, but a lot would mean the export blended province colours together.

Land currently comes to 113.9M km², 22.34% of the surface.

`sync-provinces.js` writes two derived fields per province, rewritten every run:

| Field | |
|---|---|
| `area` | surface area in km² |
| `centre` | `[latitude, longitude]` in degrees |

`centre` is the area-weighted mean of each pixel as a **vector** on the sphere. Averaging longitudes instead would put a province straddling the map's edge on the opposite side of the world, its +180 and −180 cancelling to 0.

Distance is the great circle by haversine, in `src/geo.js`. Working from latitude and longitude it wraps east–west for free. Nothing uses it yet; it is what movement will need.

### East–west wrapping

The map wraps horizontally. Panning east returns to the start, and at the seam the far edge of the map continues into the near one.

`wrapOffsets()` determines how many copies are needed to fill the window — usually one or two, three on a wide window at low zoom — and each layer is drawn once per copy. `clampPan()` wraps `view.x` into a single map width rather than clamping it, so the offset cannot grow large enough to lose precision. Hit testing wraps the same way, so a click on any copy resolves to the same province.

Layers drawn over the map work in each copy's own coordinates, because the context has already been translated by that copy's offset. Only their off-screen tests add the offset back, since that test concerns the window rather than the copy.

There is no vertical wrapping, so `view.y` is clamped.

Adjacency does not wrap. Both edges of the current bitmap are open ocean. If land is ever drawn touching both edges, `scanAdjacency()` and the border test in `paintTileRegion()` will need to compare column `width - 1` against column `0`.

### Satellite imagery

`data/satellite.png` is optional; if absent, the **Satellite** switch is disabled. It must match `provinces.png` in size, since it is blitted with the same coordinates, and a mismatch is reported in the console. It is held as an `ImageBitmap` rather than decoded, since it is only blitted and never inspected. That keeps it on the GPU instead of adding 60 MB to the JavaScript heap.

The province layer is composited with a per-pixel alpha, so a country's colour is strongest along its frontier and falls away inland. The terrain shows through the interior of a large country while its outline remains clear.

This requires the distance from every land pixel to the nearest national border — a boundary with a different owner or with open sea. `buildBorderDistance()` computes it as a two-pass chamfer distance transform: one pass carrying distances down and right, one back up and left. After the second pass every pixel holds its distance to the nearest border anywhere on the map. A diagonal step is weighted 4 against 3 for an orthogonal one, approximating √2 to within 5.7% in all directions, which keeps each distance in one byte — 16 MB rather than the 64 MB an exact float field would use. It also caps the measurable distance at 85 map pixels, which `FADE_PX` must stay below.

The blend is resolved into a 256-entry lookup, so the pixel loop is a table read. `FADE_CURVE` shapes it; below 1 it concentrates the falloff near the border, producing a defined band of colour rather than an even wash.

Inland the colour is also softer. Each province has two colours: its own, used at the frontier, and a pastel derivative (`PASTEL_MIX` toward `PASTEL_TOWARD`) used in the interior. The pixel loop blends between them by the same distance. Reducing alpha alone leaves the interior reading as a dim version of the border colour rather than a distinct field.

| Constant | Controls |
|---|---|
| `SATELLITE_NATIONAL` | the drawn frontier line |
| `SATELLITE_INTERNAL` | province subdivisions, added to the local fill |
| `SATELLITE_RIM` | country colour against a national border |
| `SATELLITE_CORE` | country colour inland, past `FADE_PX` |
| `SATELLITE_FLAT` | the even fill used by the province and terrain views |
| ocean | fully transparent, so the imagery's sea shows |

Only the political view is shaped by border distance. The others fill evenly at `SATELLITE_FLAT` with no pastel wash, since a province or terrain type should read the same at the centre of a country as at its edge. Highlighted provinces have `SATELLITE_LIFT` applied on top, otherwise a selection deep inside a large country is too faint to see.

The distance field is built only when imagery is present, since it is three passes over every pixel.

### The map cache

Deriving the world from the bitmap takes 940 ms: a colour lookup per pixel, an adjacency scan, a distance transform, and two further full-map passes for label geometry. None of it depends on runtime state, so it is precomputed.

```
node sync-provinces.js --cache            # build data/map-cache.bin
node sync-provinces.js --write --cache    # sync the JSON, then rebuild it
```

The result is tens of megabytes of derived data, deflated to 0.49 MB. Loading it takes 302 ms, and the province bitmap is not decoded at all. The debug menu reports which path was used under **Load**.

The cache is an optimisation, not a source of truth. It stores a hash of the bitmap's bytes and of the ids, colours and owners in the JSON. If either differs, the reader discards the cache, computes everything from scratch, and logs how to rebuild. Renaming a province does not invalidate it, since no derived data depends on names. Missing, corrupt and old-format caches take the same path, so deleting `map-cache.bin` is safe and only makes loading slower.

The scans live in `src/mapdata.js` and are imported by both the browser and the build script. These passes determine adjacency, borders and label placement, so a build script disagreeing with the renderer would produce inconsistencies that are hard to trace. `src/mapcache.js` holds the file format and is likewise shared.

Label geometry is cached. The labels themselves are finished in the browser, because choosing a font size and line breaks requires measuring text, which requires a canvas.

### Keeping a large map fast

Drawing is split in two. Painting works at map resolution into offscreen canvases and runs only when a colour changes. Blitting puts the result on screen through the pan/zoom transform, and is all that a pan or zoom requires.

At 15.9 million pixels, painting is expensive, so it runs as rarely as possible.

- **Hovering and selecting repaint only the provinces that changed**, by bounding box, via `repaintProvinces()`. Only a province's own pixels can change colour, since the border test reads a neighbour's owner. A hover settles at about 1.3 ms against roughly 250 ms for the full map.
- **A full repaint runs only on load and on a change of view.** The initial one runs before the start menu enables its button, so its quarter-second occurs during loading rather than after the click.
- **The painted map is a grid of 512-pixel tiles**, 12 × 6 = 72 of them. A repaint uploads only the chunks it overlaps rather than a 64 MB texture, and drawing skips chunks outside the window.
- **A downscaled overview** (2051 × 906) is kept alongside and used when the zoom is low enough that it holds as many pixels as the screen can display. Zoomed out, drawing tile by tile would rescale all 15.9 million pixels per frame.
- **One 512 × 512 scratch buffer is shared by all tiles**, rather than a full-map pixel array: 1 MB instead of 61 MB.

Both painted layers are updated by the same repaint — tiles first, then the same rectangle copied into the overview. Border darkening reads the map array rather than the tile, so borders on a chunk edge use the same data as any other and no seam appears.

Text is handled separately.

- **Labels outside the window are skipped before any glyph is processed.** Each carries a bounding box in map units, computed at build time and therefore independent of zoom. Without it, every readable label was laid out and drawn regardless of the view, which zoomed in is most of them: the type scales with the land, so all of them pass the readability test while two are on screen. At 1600% zoom this reduced the label pass from 7.19 ms to 0.12 ms, with identical output.
- **Glyphs are cached in an atlas.** Canvas2D cannot reuse work across a change of type size; at each size it rebuilds the glyph outline path and, for the halo, strokes that path on the CPU. A label's size is its map size times the zoom, so a zoom requests an unseen size on every frame. Measured zoomed out, this was 50–155 ms of blocking work per frame, or roughly 15 fps. Each character is now rasterised once per 5% size step, with halo and body composited together, and placed with a single `drawImage`. Frames over 33 ms during a zoom went from dozens to none.

  Only glyphs are cached, not labels. `'A'` at 24 px is always `'A'` at 24 px, so no change to the world invalidates one; which labels exist, where their spines run and how large the type is are recomputed every frame. Glyphs are rasterised at twice their drawn size, because letters land at fractional positions and at an angle and are therefore resampled at any size. Resampling a 12 px letter at 1:1 blends its dark body into its own halo.

### Borders and coastline

Neither is stored. Both are computed per pixel in `paintTileRegion()`: a land pixel whose right or lower neighbour belongs to a different province is darkened. The amount depends on the neighbour's owner. Provinces sharing an owner get a light internal line (`BORDER_INTERNAL`); a different owner or open sea gets a strong one (`BORDER_NATIONAL`). National borders and coastlines are therefore distinct from internal subdivisions.

Because only right and down are tested, the line falls on one side of each boundary rather than being shared, and is always one map pixel wide, so it thins visually as the zoom increases.

The adjacency behind it comes from `scanAdjacency()` in `src/mapdata.js`, which makes two passes over the pixels at load:

1. Map every pixel to a province id via its colour.
2. Compare each pixel with the one to its right and the one below. Where two ids meet, record a border. Where a province meets ocean, mark it coastal.

Testing right and down finds every touching pair exactly once: a left-right pair is seen from the left pixel, a top-bottom pair from the upper one. Provinces meeting only diagonally are not neighbours, which matches how movement works.

This produces the adjacency graph: currently 1,677 borders and 378 coastal provinces, none of it maintained by hand. Painting a province into the bitmap adds it to the graph, so the rule that a polity may attack only regions adjacent to its own stays correct as the map grows.

## Redrawing the map

`sync-provinces.js` reconciles `provinces.json` with `provinces.png`. Run it after editing the bitmap.

```
node sync-provinces.js                    # report only, writes nothing
node sync-provinces.js --write            # apply
node sync-provinces.js --write --cache    # apply, then rebuild the map cache
node sync-provinces.js --cities           # re-extract cities from cities.png
```

| Flag | |
|---|---|
| `--write` | apply changes; without it nothing is written |
| `--cache` | rebuild `data/map-cache.bin` |
| `--cities` | re-extract `data/cities.json` from `data/cities.png` |
| `--prune` | delete entries whose colour is no longer in the bitmap |
| `--reslug` | regenerate ids from current names, for provinces and cities |
| `--min-size=N` | list provinces smaller than N pixels |

Provinces are matched by colour, so existing names, owners and terrain survive a redraw. New colours are added with placeholder values. Entries whose colour has disappeared are reported as stale and retained, since painting over a province by accident should not discard hand-entered data. `--prune` deletes them.

The script also reports which provinces consist of several disconnected pieces and which five are smallest. Both are informational: island chains, exclaves and single-tile islands are all valid. After a large edit, `--min-size=5` lists anything below that size and prints nothing when there is nothing to report.

The ocean colour is taken from `oceanColour` in the JSON. If that colour is not present in the bitmap, the most common colour is used instead and the JSON updated, so a white background needs no configuration.

## Where this goes next

The map is complete as a renderer. The game is not started. In approximate order:

1. **Turn loop.** A "next turn" control and a date. The Rundean calendar has 12 months of 28–31 days; a weekly or monthly tick is probably the right granularity.
2. **Ownership changes.** Transfer a province between polities and re-render. This is close to trivial now that ownership is a field, except that `borderDist` is derived from ownership, so a transfer invalidates it. Rebuilding costs a few hundred milliseconds and should be done incrementally around the provinces that changed.
3. **Armies and movement.** Units occupy a province and may move only to one in its adjacency set.
4. **Combat.** Attacker against defender, modified by the terrain tag.
5. **Events.** Load the event list as JSON, each entry with a date, condition, probability and effects. The structure in *Simulation Rules* maps onto this directly.
6. **AI.** Last, and simpler once 1–5 exist.

Content should wait until 1–4 work.

## Files

```
index.html            markup only
src/style.css         styling
src/main.js           rendering, labels, cities, interaction
src/mapdata.js        the scans: adjacency, borders, label geometry (shared with the build step)
src/mapcache.js       the precomputed-map file format (shared)
src/geo.js            the sphere: latitude, longitude, area per row, distance (shared)
sync-provinces.js     the build step: reconcile the JSON, extract cities, write the cache
package.json          marks the folder as ES modules; no dependencies
serve.json            disables caching for `npx serve`

data/provinces.png    the province bitmap; defines shape
data/provinces.json   the province table; defines names, owners, terrain
data/true_area.png    the whole world on a 2:1 globe; areas are measured from this
data/cities.png       city placement: black is a capital, grey a city
data/cities.json      extracted city list, rebuilt with --cities
data/satellite.png    optional imagery
data/map-cache.bin    optional precomputed map, safe to delete
data/icons/           city and capital markers
data/ui/              the interface texture
```

`src/main.js` is organised into numbered sections, listed at the top of the file: data loading, world model, rendering, labels, view, debug overlays, app, input, boot.
