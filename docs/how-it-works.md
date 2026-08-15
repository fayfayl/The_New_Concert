# How it works

Technical notes on the map viewer. Covers the data files, the load path, the world model,
the renderer, the label and city layers, and the build script.

## Layout

```
index.html            markup, start screen, toolbar, province card, debug panel
serve.json            no-store cache headers for `npx serve`
package.json          type: module. No dependencies, no build step.
sync-provinces.js     Node build script (map cache, area, cities, stats)
src/main.js           renderer, labels, cities, view, input, boot
src/mapdata.js        everything derived from the bitmap. Runs in Node and the browser.
src/ownership.js      provinces changing hands after load
src/mapcache.js       binary cache format, hashing, restore
src/geo.js            sphere projection, areas, great-circle distance
src/style.css         UI
data/                 map data and assets
```

`src/mapdata.js` is imported by both the browser and the build script, so the precomputed
cache and a live computation come from the same code.

## Data files

| File | Format | Contents |
| --- | --- | --- |
| `data/provinces.png` | 8-bit PNG, 6000x2650 | Province shapes. One flat RGB colour per province. Ocean is `#ffffff`. |
| `data/provinces.json` | JSON | Province table keyed by colour: id, name, terrain, owner, area, centre. Also the polity list and `oceanColour`. |
| `data/map-cache.bin` | deflated binary | Precomputed world. Optional. |
| `data/satellite.png` | PNG, same size as provinces.png | Imagery drawn under the province colours. Optional. |
| `data/true_area.png` | PNG, 2:1 whole globe | Same province colours, pole to pole. Used only for area measurement. |
| `data/cities.png` | palette PNG, same size as provinces.png | One pixel per city. Read by the build script only. |
| `data/cities.json` | JSON | Extracted city list: id, name, capital flag, x, y, province. |
| `data/province-stats.json` | JSON | Per province: claims, population, infrastructure pairs, building slots, factories. |
| `data/icons/city.png`, `capital.png` | PNG | City markers. |
| `data/ui/` | PNG, woff2 | Panel texture and the Cabin variable font. |

Two sources of truth, and they do not overlap. `provinces.png` defines shape and adjacency.
`provinces.json` defines data. Adjacency is never written down; it is read from the pixels
at load, so redrawing the bitmap changes the topology without any file needing an edit.

## Load path

`index.html` imports `src/main.js` through a dynamic import carrying `?v=<timestamp>`.
`main.js` passes the same token to its own imports of `mapdata.js` and `mapcache.js`, so a
reload never mixes a fresh module with a cached one. All data fetches add `?t=<timestamp>`
and use `cache: 'no-store'`.

`init()` in `main.js`:

1. Fetches, in parallel: `provinces.json`, `provinces.png`, `map-cache.bin`,
   `satellite.png`, `cities.json`, both icons, `province-stats.json`. Everything except the
   first two is optional and resolves to null if missing.
2. Hashes the inputs with `hashInputs(pngBytes, raw)`. This runs before `normaliseTable()`,
   which rewrites colours in place.
3. Tries the cache. It is rejected if the file is absent, the magic or version is wrong,
   the byte length does not match `width * height * 3`, or the stored hash differs. Any
   rejection falls through to computing from the bitmap.
4. On a cache hit, `worldFromCache()` rebuilds the world without touching a pixel. On a
   miss, `loadPixels()` decodes the PNG with `colorSpaceConversion: 'none'` and
   `buildWorld()`, `buildBorderDistance()` and `computeLabelGeometry()` run.
5. `buildLabels()` runs in the browser either way, because it measures real text.
6. `buildTiles()`, `wireInput()`, `fitToView()`, then one synchronous `frame()`.
7. `openStartMenu()` enables the **Enter** button. The first full repaint has already
   happened at this point, so dismissing the start screen does not stall.

Load time is reported in the debug panel as cached or computed.

`colorSpaceConversion: 'none'` matters. A PNG carrying an sRGB or ICC chunk gets colour
managed on decode, which shifts saturated channels by a point or two. A shifted colour no
longer matches the JSON and the province reads as ocean.

## World model

`buildWorld()` returns:

| Field | Type | Notes |
| --- | --- | --- |
| `width`, `height` | number | 6000 x 2650, 15.9M pixels |
| `provinceAt` | Uint16Array, one per pixel | Province index. 0 is ocean. Int32Array if there are 65535 or more provinces. |
| `atIndex` | array | index to province. Slot 0 is null. |
| `byId` | Map | id to province |
| `adjacency` | Map | id to Set of ids |
| `coastal` | Set | ids touching ocean |
| `bounds` | Map | id to `{minX, minY, maxX, maxY, n, sx, sy, cx, cy}` |
| `table` | object | the normalised JSON, plus `polityById` |
| `borderDist` | Uint8Array | added after, see below |

Two ways to name a province. `id` is a string slug, used by saves, events and every public
API. `index` is a small integer used only inside typed arrays. `indexProvinces()` assigns
indices and is the only place the two are related.

Provinces with a missing or duplicate id are skipped with a console warning. Colours in the
bitmap that no province claims are counted, reported with the nearest registered colour and
its distance, and treated as ocean. Provinces whose colour appears nowhere are reported and
behave as ocean.

### Adjacency scan

One pass over the bitmap. Each pixel is compared with the pixel to its right and the pixel
below. That covers every touching pair exactly once. Diagonal contact does not count.

The right-hand read wraps at the last column to column 0 of the same row, because the map
is a globe and its left and right edges are the same meridian. Nothing wraps vertically.

Contacts are counted first, then converted to neighbours. Pairs sharing fewer than
`MIN_BORDER_PX` (2) pixels are dropped as drawing artefacts. The same pass accumulates each
province's bounding box, pixel count and position sums; centroids are computed afterwards.
A centroid is the centre of mass and can fall outside an L-shaped province.

### Border distance field

`buildBorderDistance()` produces one byte per pixel: distance to the nearest national
border, meaning a boundary with a different owner or with open sea. Province subdivisions
inside a country do not seed it.

Two-pass chamfer transform, forward then backward. Orthogonal steps cost 3, diagonal steps
cost 4, which approximates sqrt(2) to within 5.7 percent and keeps a distance inside one
byte. Maximum measurable distance is 255 / 3 = 85 map pixels, which bounds `FADE_PX`.

Seeds test all four directions, unlike the border drawing which tests two. Sideways reads
wrap; vertical reads do not.

`refreshBorderDistance(world, dist, box)` does the work and takes a rectangle, or null for
the whole map. `buildBorderDistance()` is the whole-map call. Ownership changes pass a
rectangle: see below.

### Label geometry

`computeLabelGeometry()` is two full-map passes and is the most expensive part of a cold
load.

Blocks are contiguous runs of same-owner provinces, found by flood fill over the adjacency
graph. Provinces owned by `NONE` or by an unknown polity are excluded. `nearbyProvinces()`
adds links across water: every province grows outward through ocean one ring at a time up
to `NEAR_GAP` (5) pixels, and where two growths meet the provinces behind them count as
adjacent for labelling. Without this an island a few pixels offshore gets its own tiny
label instead of joining the country's.

Pass one sums pixel positions per block and derives the centroid, covariance and principal
axis (`theta = 0.5 * atan2(2*vxy, vxx - vyy)`). Blocks under 12 pixels get no axis.

Pass two measures every pixel along the axis (`t`) and across it (`u`) and accumulates:
`tMin`, `tMax`, moment sums `s0` to `s4` and `u0` to `u2` for the least-squares spine, `pp`
for thickness, and a histogram of pixel count per `LABEL_HIST_BUCKET` (3 pixel) slice of
`t`.

Both accumulations live in `addMoment()` and `addFitSample()`, which the per-block rebuild
in `computeBlockGeometry()` also uses, so a block measured after a change is identical to
the same block measured from cold.

Each block keeps its members as province indices. `buildBlocks()` fills them; a cache
restore has only the province-to-block mapping, so `attachBlockMembers()` rebuilds the
lists on load. `nearbyProvinces()` is also kept, on the geometry as `near`, because
regrouping blocks needs the same graph they were built from.

## Map cache

`data/map-cache.bin` stores what the two scans above produce. Written by
`node sync-provinces.js --cache`, read by the browser.

Uncompressed layout:

```
"CHM1"        4 bytes
metaLength    uint32 LE
meta          metaLength bytes of UTF-8 JSON
provinceAt    width * height uint16
borderDist    width * height uint8
```

Deflated on write with `zlib`, inflated in the browser with `DecompressionStream`. About
47.7 MB packed, 1.1 MB on disk.

The JSON holds bounds, adjacency, the coastal list, the label geometry and the near-links,
all keyed by province index. The reader rebuilds ids from `provinces.json`.

Two independent guards. `CACHE_VERSION` (currently 5) catches changes to the code that
derives the data. `hashInputs()` catches changes to the inputs: it is FNV-1a over the PNG
bytes, seeded into a hash of `oceanColour` and every province's `id|colour|owner`. Names
and terrain are excluded, because they do not affect anything the cache stores.

A rejected cache is logged to the console and ignored. The cache is never allowed to decide
what the map is.

The build script refuses to write a cache when there are unsaved changes to the JSON, and
builds from the file on disk rather than from its own in-memory table.

## Rendering

Two stages. Painting produces pixels at map resolution and only runs when a colour changes.
Blitting puts the result on screen through the pan and zoom transform, and is all a pan or
zoom needs.

### Buffer

The painted map is a grid of 512 pixel tiles (12 x 6 = 72 tiles at the current size) plus a
downscaled overview of the whole map. A single 6000x2650 canvas would be 64 MB and any
touch of it costs as if all of it were touched.

The overview scale is chosen so that one tile lands on a whole number of overview pixels
(`round(512 * min(1, 2048 / 6000)) / 512`), which stops seams appearing between the copies
that assemble it. Currently 2051 x 906.

`drawMapLayer()` uses the overview when `view.scale <= overview.scale`, and tiles above
that, drawing only the tiles that intersect the viewport. Destination edges are rounded
rather than widths, so neighbouring tiles resolve a shared edge to the same integer.

### Shade table

`shadeTable()` computes every colour before any pixel is touched, as flat per-index typed
arrays. It is O(provinces), so it is recomputed on every repaint however small.

Five colour arrays per province: `rim` (interior at a frontier), `core` (interior inland,
pastel), `softRim` and `softCore` (subdivision line, same two positions), `hard` (the
frontier line). Plus `ownerAt` as small integers so the pixel loop compares owners
numerically, `lift` for highlight opacity, and a 256-entry `fade` lookup from border
distance to the rim-core blend.

Map modes are one function each, province to base RGB:

- `political`: the owner polity's colour.
- `province`: the province's own bitmap colour.
- `terrain`: the average of its terrain tag colours. `Impassable` is excluded from the
  average and instead pulls the result 45 percent toward `#23262c`.

Terrain colours: Plains `#7c945c`, Hills `#968454`, Mountains `#808086`, Desert `#ceb876`,
Jungle `#487a4a`, Arctic `#ced8e0`.

Highlight states mix the base colour toward white by `LIGHTEN`: selected 0.10, neighbour
0.04, hovered 0.04. Proportional mixing rather than addition, so a bright channel cannot
clip and shift the hue.

### Pixel loop

`paintTileRegion()` walks a rectangle of one tile. Per pixel:

1. Ocean writes the ocean colour and stops.
2. Borders are found, not stored. If the pixel to the right or below belongs to another
   province, this pixel is an edge: `edge = 1` if that neighbour has the same owner, `2`
   otherwise. These reads index the map, not the tile, so borders on a chunk edge come from
   the same data as any other and no seam appears. Only right and below are checked, so the
   dark line falls on one side of each boundary and is exactly one map pixel wide.
3. `edge === 2` writes the frontier colour at full alpha and stops.
4. Otherwise the colour blends from `rim` to `core` by the fade lookup on the border
   distance, using the soft pair when `edge === 1`.

Border shades are multipliers on the province colour: `BORDER_INTERNAL` 0.85,
`BORDER_NATIONAL` 0.42.

### Compositing over imagery

With satellite imagery on, the province layer is drawn with a per-pixel alpha rather than
one layer opacity, so a country's colour is strong at its frontier and falls away inland.

| Constant | Value | Applies to |
| --- | --- | --- |
| `SATELLITE_NATIONAL` | 0.88 | the frontier line |
| `SATELLITE_RIM` | 0.82 | country colour at a frontier |
| `SATELLITE_CORE` | 0.36 | country colour deep inland |
| `SATELLITE_INTERNAL` | 0.22 | added to subdivision lines |
| `SATELLITE_FLAT` | 0.84 | province and terrain modes, flat |
| `FADE_PX` | 24 | reach of the falloff, in map pixels |
| `FADE_CURVE` | 0.8 | below 1 concentrates it near the border |
| `PASTEL_MIX` | 0.55 | wash toward `[226, 231, 238]` inland |
| `SATELLITE_LIFT` | 0.5 / 0.32 / 0.22 | extra opacity when selected / neighbour / hovered |

Only political mode is shaped by distance. Province and terrain modes use one flat opacity
and no pastel wash, because their fills answer a different question and a gradient makes
them mottled.

`putImageData` cannot composite, so with imagery on the layer goes to a scratch canvas and
is then drawn over the imagery with `drawImage`.

### Partial repaints

`repaintProvinces()` repaints only the bounding boxes of provinces whose colour changed.
Hovering changes two provinces; selecting changes a province and its neighbours. A full
repaint is 15.9M pixels regardless.

One box at a time, not a union, so two provinces on opposite sides of the map do not
combine into the whole thing. Only a province's own pixels change, because the border test
reads a neighbour's owner and a highlight does not touch that.

`renderBuffer()` repaints every tile and is used at load and on a map mode change.

### Highlight size limit

`HIGHLIGHT_MAX_PX` is 4e6 bounding-box pixels. Above that a province is not lit at all:
`shadeTable()` refuses the role and `invalidateProvinces()` refuses the repaint, so the two
agree. The province stays named, clickable and reported. The ring is skipped for the same
reason, since it is built from a silhouette the size of the bounding box.

This affects the placeholder regions covering undrawn ground, whose boxes are the whole
map. Lighting one measured 386 ms.

### Frame loop

`frame()` runs continuously on `requestAnimationFrame` and does nothing unless a flag is
set.

- `bufferDirty`: full repaint.
- `dirtyProvinces`: a Set of ids, partial repaint.
- `viewDirty`: blit only.

Every repaint sets `viewDirty`. A full repaint clears `dirtyProvinces`.

The canvas box is compared against its pixel buffer every frame rather than through a
`ResizeObserver`, because observer callbacks arrive after the frame callback and a redraw
triggered from one is always a frame late. The debug panel slide would otherwise show a
stretched map for its whole animation.

Also stepped per frame: city fades, label dimming, and the deselect fade
(`DESELECT_FADE_MS` 60).

## Ownership changes

`src/ownership.js`. `setOwners(world, geometry, changes)` takes an iterable of
`[provinceId, polityId]` and returns `{changed, blocks, boxes}`, or null if nothing moved.
Unknown provinces and polities are warned about and skipped rather than thrown.

Three things depend on who owns what, and each is handled differently:

- **Colours and borders** are worked out per repaint from the province's current owner, and
  borders are found per pixel by comparing owners. Nothing to update.
- **`borderDist`** is redone over a rectangle. The rectangle is the changed province's
  bounding box grown by `BORDER_DIST_REACH + 1` (86 pixels), which is the furthest a border
  appearing or disappearing can be felt. `refreshBorderDistance()` reads outside the
  rectangle and writes only inside it, so a distance owed to a border further away still
  arrives. Provinces near the seam produce two rectangles, one per edge of the map.
- **Labels** are regrouped and remeasured, but only where the change reached.
  `leaveBlock()` takes the province out of its block and splits the remainder if it no
  longer hangs together. `joinBlock()` puts it into the block of its new owner, merging any
  blocks it now connects. Only the blocks touched are handed to `computeBlockGeometry()`,
  which walks their member provinces' bounding boxes rather than the map.

Emptied blocks keep their array slot, because a block id indexes into `geo`, `fit` and the
caller's `labels`. Renumbering would mean rebuilding every label on the map.

`main.js` finishes the job: `changeOwners()` rebuilds the labels of the reported blocks
(fitting a label needs measured type, which needs a canvas), pushes the reported rectangles
onto `dirtyBoxes`, and refreshes the card and the panel if the selected province moved.
Repainting goes through the normal dirty flags, so a hundred provinces changing at once
still costs one repaint on the next frame.

`window.game` exposes it for now, until events and the AI call it directly:

```js
game.setOwner('norrhus', 'FNA')
game.setOwners([['norrhus', 'FNA'], ['rodtfjell', 'FNA']])
game.world()
```

Measured on the real map, including the block rebuild and the distance field but not the
repaint: about 10 ms for one ordinary province, 13 ms for a country of 13 provinces
changing at once. The map-spanning placeholder province costs 200 ms, or 544 ms in the
browser with the repaint of 12.7M pixels included, which is what a province larger than the
screen costs and not a case any real province reaches.

Changes are not written back to `provinces.json`, so they last until reload. Saving is a
separate problem and does not exist yet.

Counties will be the same shape of problem one level down: a county changes hands, its
province's owner is whatever its counties add up to, and only then does any of the above
run. The entry point stays `setOwners()`.

## Labels

One label per block. Four steps, the first three at load and the fourth per frame.

1. Axis, from the covariance in `computeLabelGeometry()`.
2. Spine: a quadratic `u = a*t^2 + b*t + c` fitted by Cramer's rule on the 3x3 normal
   equations. Singular matrices fall back to a flat spine.
3. Span: `denseRange()` starts at the slice holding the median pixel and walks outward in
   each direction until the block narrows below `LABEL_DENSITY_FLOOR` (0.4) of its own mean
   width, reading the histogram smoothed over three slices. The two sides stop
   independently, so a country cut flat by a border runs to that edge while a fraying coast
   stops where the land thins.
4. Type: `fitLabel()` tries 1 to `maxLines` lines. For each count the size is the smaller of
   the span limit and the thickness limit. `wrapInto()` tries every break point and keeps
   the one whose widest line is narrowest. An extra line must improve the size by
   `LABEL_WRAP_GAIN` (1.15) to be taken. Blocks longer than `LABEL_WRAP_ASPECT` (2.3) times
   their thickness never stack.

Widths come from `measureText` on the real font, not an average glyph width, so a name in
wide capitals is not laid out longer than the land it was sized for.

Blocks with less land than `LABEL_MIN_DENSITY` (0.3) per unit of extent are skipped as
archipelagos, because the spine would run mostly over water.

Curvature is clamped to `BEND_RADIUS` (7) times the type size. `a0` is re-derived when the
clamp bites, or the spine keeps an offset only the steeper curve justified.

Text is set in map units and scales with the zoom, so a name covers the same stretch of its
country at every zoom. There is no maximum size, because a cap reads as the label shrinking
back toward its own centre as you keep zooming.

Opacity is a function of the label's own size on screen, not of the zoom:

- fade in over `LABEL_FADE_IN` [3, 6] screen pixels of font size, which is legibility and
  is absolute.
- fade out over `LABEL_FADE_OUT` [0.34, 0.78] of the window width covered by the widest
  line, which is relevance and is relative. Large countries drop out first.
- peak `LABEL_ALPHA` 0.85, multiplied by `LABEL_DIM_TO` (0.2 over 160 ms) while a province
  is selected.

`labelBounds()` gives each label a map-space box, sampled at 13 points along the spine plus
padding, so off-screen labels are skipped before any glyph work.

### Glyph atlas

Canvas2D rebuilds and strokes a glyph path at every new type size. Label size is map size
times zoom, so a zoom produces an unseen size every frame; measured at 50 to 155 ms of
blocking work per frame with around 90 names on screen.

Glyphs are baked once into bitmaps, keyed by `size|char`, and blitted. Sizes snap to a
1.05 ladder, so a zoom reuses a rung instead of missing every frame, and a glyph is drawn
at most 2.5 percent off its baked size. Bake size is chosen in device pixels and
supersampled 2x, so every blit is a reduction. The budget is 8e6 pixels, cleared wholesale
when exceeded, since the sizes a zoom leaves behind are never asked for again.

Halo and body are composited into the bitmap at their relative strengths, so a fade is one
`globalAlpha` on the finished mark. Text is `#1c222d` with a white halo at 0.76.

Glyph boxes are kept tilted, not squared off. An upright box around a glyph rotated 45
degrees claims twice its area, which would block every spot a city name could take.
`boxHitsGlyph()` is a separating-axis test over four directions.

## Cities

Two rules. A threshold decides whether something belongs on the map at the current zoom,
and its opacity transitions between 0 and 1 over `CITY_FADE_MS` (150) when that answer
changes. The transition knows nothing about zoom.

| Layer | Threshold |
| --- | --- |
| capital icons | 0.50 |
| city icons | 1.30 |
| capital names | 1.30 |
| city names | 2.25 |

Icons are drawn at a fixed screen size (9 px cities, 14 px capitals), not scaled with the
map, because a city is a point.

Cities are drawn under the country names, not over them, unless a province is selected.
That means the country names have
to be measured before the cities are drawn and drawn after, so `drawLabels()` runs twice
per frame: once with `measure` set, which places every glyph and reports its box without
rasterising anything, and once to draw. The measuring pass only runs when there are city
names on screen to make use of it.

A city whose icon is at least `CITY_BLOCKED_AT` (0.85) covered by country name glyphs is
not drawn at all: no dot, no name, and no space reserved, since a marker that is not drawn
is not something another city's name has to avoid. Coverage is sampled on an 8x8 grid
rather than summed from the glyph rectangles, because those overlap each other and a
summed figure comes out above the true one, which matters on a threshold. Only glyphs that
reach the icon are sampled.

Names are then placed in two passes. Pass one draws every icon and reserves its box, so a
name cannot be placed where a later icon will land. Pass two places names, capitals first.

Each name tries eight positions in order: below, above, right, left, then the four
diagonals. Icons and already-placed names are hard obstacles. Country name glyphs are soft
obstacles: the first position clear of them wins, otherwise the position covering the least
AREA of them. Area rather than a count of glyphs touched, because with large letters a
count calls a name laid across the middle of one and a name clipping the corner of another
equally good, and the first position on the list then wins by default.
`glyphOverlapArea()` clips the glyph's corners against the candidate box and takes the
shoelace area of the result, which is exact for two convex shapes.

While a province is selected the country names dim to a fifth of their strength, and at
that point they stop counting for any of this: their boxes are not collected, so nothing is
blocked and nothing is dodged. The order flips with them, and the cities are drawn last,
over the dimmed names. Standing the names back exists to let you read what is underneath,
so what was underneath comes out on top.

City names are light text on a dark halo, the inverse of country names.

## View and input

```
map to screen:  sx = mx * view.scale + view.x
screen to map:  mx = (sx - view.x) / view.scale
```

`view` is the only state involved. Changing it needs no repaint.

Scale range is 0.25 to 16. Wheel zoom is exponential in the delta
(`1.0015 ^ -deltaY`), so one notch is always the same ratio, and it is anchored: the map
point under the cursor is found, the scale changed, and the offset recomputed so that point
lands back under the cursor.

The map wraps east-west. `clampPan()` wraps `view.x` into one map width instead of clamping
it, so panning east indefinitely works and the offset never grows large enough to lose
precision. Vertically at least a quarter of the viewport must hold map. `wrapOffsets()`
returns the offsets at which copies of the map have to be drawn to fill the window, usually
one or two.

Hit testing is one array lookup. The pointer is converted to a map pixel, `x` is wrapped
into range, and `provinceAt` already holds the answer. Constant time regardless of border
complexity.

A press that travels fewer than `DRAG_SLOP` (4) pixels before release counts as a click,
not a drag.

The canvas pixel buffer is sized to `devicePixelRatio` and the context is transformed by
it, so everything else is written in CSS pixels. `imageSmoothingEnabled` is on below 1:1
and off above, so zoomed-in province edges stay hard pixel steps.

## Geography

`src/geo.js` exists because the bitmap is an equirectangular projection and pixel counts
are not areas. A row near a pole spans almost no ground but is drawn the same width as one
at the equator.

Chron is a sphere with Earth's surface area, 510,072,000 km2, giving a derived radius of
6371.047 km.

`makeProjection()` precomputes area per pixel for each row using the exact zone formula
`2*pi*R^2*(sin(lat1) - sin(lat2))` divided by the width, not `cos(latitude)`, which breaks
down at the poles. It also sums the whole sphere row by row as a check against 4*pi*R^2.

Areas are measured from `true_area.png`, not `provinces.png`. The first is a whole 2:1
globe where row 0 is the north pole, so a row is a latitude directly. The second is a band
cut short of both poles and holds no polar land at all. Shapes, adjacency and everything
drawn still come from `provinces.png`.

Province centres are the area-weighted average of each pixel's unit vector on the sphere,
converted back to lat and lon. Averaging longitudes directly would put the centre of a
province straddling the seam on the far side of the world.

`distanceKm()` is haversine, which keeps its precision on the short distances that
neighbouring provinces produce.

## Build script

```sh
node sync-provinces.js                    # report only, writes nothing
node sync-provinces.js --write            # apply changes to provinces.json and province-stats.json
node sync-provinces.js --write --cache    # also rebuild map-cache.bin
node sync-provinces.js --write --cities   # also rebuild cities.json from cities.png
node sync-provinces.js --prune            # delete entries whose colour is gone from the bitmap
node sync-provinces.js --reslug           # regenerate ids from names, provinces and cities
node sync-provinces.js --min-size=8       # list provinces under 8 pixels
```

It contains its own PNG decoder: bit depth 8, colour types 0, 2, 3, 4 and 6,
non-interlaced. Palette transparency is read, because `cities.png` uses black twice, once
opaque as a capital mark and once transparent as background.

What it does:

- Tallies every colour in the bitmap. Ocean is the colour named in the JSON if present,
  otherwise the most common colour, which is then written back.
- Finds connected components per colour, so provinces in several pieces (islands, exclaves)
  are reported.
- Counts borders with the same wrap and `MIN_BORDER_PX` rules the renderer uses, and lists
  contacts too short to count.
- Matches JSON entries to the bitmap **by colour**, so redrawing preserves everything typed
  in. Existing entries keep their position in the file and new ones are appended, which
  keeps diffs readable.
- New provinces get `Unnamed NN`, terrain `Plains`, owner `NONE` and a slug id. Placeholder
  numbers are the next unused one, not a map position.
- Rewrites `area` and `centre` on every run from `true_area.png`. These are derived, so
  editing them by hand has no effect. Without that file they are left alone.
- Keeps stale entries by default and reports them. `--prune` deletes them.
- Maintains `province-stats.json`: adds entries for new provinces, fills in fields added
  since the file was written, upgrades bare numbers to `[built, max]` pairs, follows
  reslugged ids, and drops orphaned entries only when they are entirely blank.

Ids are slugs of the name (`"Rødt Fjell"` to `"rodt_fjell"`). NFD strips combining accents;
letters with strokes or bars have no decomposition and are transliterated from a hand
written table (`ł`, `ø`, `đ`, `æ`, `ß` and so on). Ids are preserved once assigned, because
saves and events point at them. `--reslug` regenerates them and carries the stats entries
across.

### City extraction

`cities.png` holds one pixel per city: `#000000` capital, `#6b6b6b` ordinary. It must match
`provinces.png` in size, because a mark's position is its location. Each mark is read
against `provinces.png` to find its province.

Marks are matched to the existing `cities.json` by position, exact matches first in a pass
of their own, then within `CITY_MOVE_TOLERANCE` (10) pixels. A new mark is named after the
province it sits in. Marks on no known province are reported and will not render. Two
capitals for one polity is reported, not corrected.

## Debug panel

Backtick, or the **Debug** button. Overlays: satellite (rebuilds the buffer), cities,
polity labels, province names, chunk grid, adjacency links, selection bounds, coastal
flags. A button's `data-toggle` names the field in `state` it drives, and `data-repaint`
marks the ones that change the painted map rather than what is drawn over it.

Readouts refresh every 250 ms. Frame time is stored as an interval and converted to a rate
only for display; averaging rates gives a meter that can only climb, since a sub-millisecond
gap between two `requestAnimationFrame` callbacks reads as thousands of frames per second
and a zero gap gives Infinity, which a running average never leaves.

`BUILD` in `main.js` is a string shown in the panel, bumped by hand when the file changes,
to confirm which version is running.

## Known constraints

- `borderDist` caps at 85 map pixels, so `FADE_PX` cannot exceed that. The same number
  bounds the rectangle an ownership change has to redo.
- `provinceAt` is Uint16, so the format supports 65534 provinces.
- Ownership changes are not persisted. They last until the page is reloaded.
- Highlighting is baked into the painted map. The alternative is province indices as a
  texture with a palette read by a shader, which removes the size limit above.
