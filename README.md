# The New Concert

This will be a grand strategy game set in the world of Chron. It starts in 1926, seven years before the Third Sapient War (1933-1938). The map covers the entire planet and is finished. It holds 1,525 provinces across 194 polities, 14,093 counties below them, 1,229 cities, and 95 sea regions cut into 4,005 subregions.

It runs in a browser and requires no installation.

## Status

The map is finished, in provinces, counties, cities and sea regions alike. There are no other mechanics yet such as armies, combat and events.

Province statistics are fields in `data/json/province-stats.json`. Most are still zero. Population is the exception and is being authored country by country: 345 of the 1,525 provinces carry a 1926 figure, 450,864,000 people. Therundia is complete at 386,990,000 across 291 provinces and 23 polities, and Sakan is in progress.

Sea regions are drawn and named in `data/json/sea.json`, which also records which of them are lakes.

## Running it locally

It requires a recent browser and a static file server. Opening `index.html` directly does not work as browsers block a local page from reading its own data files.

From inside the `The_New_Concert` folder, use the command prompt to execute:

```sh
npx serve .            # then open the address it prints, usually http://localhost:3000
```

or, with Python:

```sh
python -m http.server 8000     # then open http://localhost:8000
```

Any static file server works, including the VS Code Live Server extension.

A loading screen appears while the map is being loaded, then it fades to the start menu.

## Controls

| What | How |
| --- | --- |
| Pan | Drag with the left mouse button. The map wraps east-west. |
| Zoom | Mouse wheel, the zoom buttons in the toolbar, or the `+` and `-` keys |
| Fit the whole world | **Fit** button, or `0` |
| Select a province | Left-click it |
| Clear the selection | Click open sea, or press `Esc` |
| Identify a province | Hover it for a tooltip: name, owner, terrain and local time |
| Inspect sea | In **Navy** mode, hover water: the region above, the subregion under the pointer below. Clicking picks both. |
| Inspect a county | **Right-click** land. Both highlights come up — the province it sits in in gold, the county itself ringed in white inside it — and a panel opens with its owner, the province it is in, terrain, climate, whether it has a railway, and its area. Only the CARDS take turns, since they share a corner: the right button puts the province card away and the left button puts the county card away. Escape closes it. |
| Change map mode | **Political**, **Provinces**, **Terrain**, **Counties**, **Navy** in the toolbar |
| Select a sea region | Left-click it, in Navy mode only |
| Identify a sea region | Hover it for a tooltip, in any mode |
| Close the province card | The **×** on the card |
| Go to a neighbour | Click a name in the **Adjacent provinces** list in the debug menu |
| Debug menu | **Debug** button, or the backtick `` ` `` key |
| Dismiss the start screen | **Enter** or `Space` |
| Pause and resume the clock | `Space` |
| Set the clock speed | `1`, `2`, `3` |
| Open the pause menu | `Esc`, once nothing is selected |

## Testing

```sh
node --max-old-space-size=6144 test/smoke.mjs         # the map, headless
node --max-old-space-size=6144 test/tooltip-time.mjs  # the tooltip clock, mouse held still
node --max-old-space-size=6144 test/county-panel.mjs  # right-click a county, read its panel
node test/borderdist.mjs                              # the distance field across the seam
node test/borderdist-map.mjs                          # and on the real map, at all four edges
```

Boots the map under node against a small DOM shim, runs frames, clicks through every map mode, and sweeps the zoom from 16x down to the floor and back. Every nine-argument `drawImage` is checked against the size of its source: the specification clips a source rectangle reaching outside the image rather than complaining, so a layer that asks for a column which is not there is handed the edge pixel instead, over and over — which is how a wrapping layer grows a seam with nothing anywhere reporting a fault. It exists for one failure in particular: a throw inside `requestAnimationFrame` used to take the re-arm with it, so the canvas stopped updating while every event handler carried on answering. That reads as the map having frozen while the tooltip still works, and nothing anywhere says why.

The loop now catches its own faults, re-arms regardless, and reports the first one in the debug menu. The test watches for that report.

## Features

- **Political mode.** Provinces coloured by owner.
- **Provinces mode.** Every province has its own colour.
- **Terrain mode.** Coloured by landscape: the shape of the ground (plains, hills, mountains) mixed with the climate on it, in twelve Köppen groups from ice cap to rainforest. Both are read off the true-area maps at every sync — everything covering more than 40% of a province is named, so a province half hills and half mountains is both, and the colours average. Ground and climate weigh the same however many of each there are. Impassable areas are darker.
- **County boundaries follow rivers**, by `node sync-provinces.js --snap-rivers --write`. NOT a regeneration: counties.png is hand-edited and `--regen-counties` overwrites it, so this only moves pixels between counties that already exist. Every pixel more than 4px from a river keeps its county and becomes an anchor; the band within 4px is regrown from those anchors by a four-connected flood that cannot cross a river, so two counties whose anchors are on opposite banks meet on the water by construction. Towns are let through — 1,150 of 1,229, being every one the river already runs through plus four in five of the rest, decided by hashing the county id so the answer never changes between runs — because a bridge is why the town is there and a wall through it would hand the far bank to somebody else. Any county that would come out in more pieces than it went in is reverted, iterated to a fixed point since one revert can strand a neighbour. It doubled sustained following: river in stretches of 15+ pixels along a boundary went from 15.3% to 32.7%, against 0.6% for the same rivers displaced sideways as a control. The previous bitmap is kept as `counties.before-snap.png`.

- **Rivers.** Lifted out of `true_water_bodies_and_rivers.png` by `node sync-provinces.js --rivers --write`, which keeps only the blue — every other kind of water in that file is white, and an inland lake belongs to the province around it rather than to the river network. 78,214 pixels, half a per cent of the map, written to `data/img/rivers.png` as a mostly-transparent 179KB file so the page blits one image instead of decoding and filtering a second full-size one. Rivers meeting an inland lake are carried through it: 144 of those lakes exist, small enough to sit inside a province and be drawn as ground rather than water, and a river reaching one used to stop at the shore and reappear on the far side. Every arm reaching a lake is now run to the lake centre, which joins all of them through one point rather than pairing them off — a lake with three rivers on it is a junction, and guessing which two were the same river would be inventing hydrology. 109 lakes carry a crossing, 230 arms, 1,152 pixels; the 35 with only one arm are left alone, since a river ending in a lake is a real thing for a river to do. The route is a breadth-first walk over the water rather than a straight line, so nothing is ever drawn on dry land — a straight line left the lake for a quarter of the arms. They fade in from 100% zoom, because below that a screen pixel covers several map pixels and a one-pixel river draws as a dotted line rather than a river. Always slightly transparent, and under the night layer, so they go dark with the rest of the landscape at midnight.

- **Sea subregions, in the Navy mode.** 4,005 of them, generated from the 95 drawn sea regions and the level a fleet is ordered to — what a county is to a province. Each takes its region’s colour shifted a little, so a sea still reads as one sea while the pieces inside it show; its own borders are drawn lighter than the region border laid over them, so the two levels are told apart by weight rather than by colour.

  Depth comes from `sea_elevation.png` in five seafloor zones — Shelf, Slope, Bathyal, Abyssal, Hadal — read per pixel, so a sea with a shelf along one coast and abyss in the middle is both and each subregion takes the zone most of it is. Whether that counts as shallow water is DERIVED from the zone and never stored: the table said it twice and could disagree with itself.

  `node sync-provinces.js --regen-sea-subs --write` draws them; `--sea-subs --write` reads a hand-edited `sea_subregions.png` back without touching the image; `--cache --write` puts the per-pixel index in the map cache, another 30.7MB packed and 0.7MB deflated.

- **Counties mode.** The level below provinces, 14,093 of them, each in its own colour with the province borders drawn dark over the top. The tooltip names the county under the cursor in every mode, with its terrain and climate.
- **Navy mode.** The water divided into sea regions, each in its own colour, with land pushed back to a flat slate. Lakes are the regions bordering no other passable one and are drawn green rather than blue; water tagged impassable is pulled toward the same near-black that impassable ground is. Sea regions can be selected here and nowhere else; the tooltip names them in every mode.
- **Satellite imagery** under the political colours. Switchable in the debug menu.
- **Day and night.** A solar terminator with city lights on the night side, computed from the date, the latitude of the row and the longitude of the column. It shows in every map mode and at reduced strength on the political map. The sun moves as the clock runs.
- **Country names** are drawn on the map along the shape of the territory. They scale with the zoom, appear once they are large enough to read, and fade out past that. A country split across islands takes a name on each part, and a country in two pieces across a strait takes one name spanning both. A country with most of its land too scattered to carry a name takes one letterspaced name across all its islands at once, however many provinces they are split between, and its pieces give up their own so the name appears once. The test is how much of a country ends up unnamed, not how many pieces it is in, so a mainland country keeps its island chains bare and a country of many separately named islands is left alone.
- **Cities** appear with the zoom: capitals first, then ordinary cities, then their names. Names are placed to avoid other city names and country names, and a city buried under a country name is hidden until the province is selected.
- **Province card.** Click a province for its owner, foreign claims, population, area in km², and what is built there: road, air base, supply hub, fortification, electricity, anti-air. Building slots are shown as one row shared between civilian and military factories.
- **Selection.** The selected province and everything bordering it are highlighted, and country names dim while a province is selected.
- **Ownership change.** Provinces change hands at runtime and the map updates over the affected area only, including borders, country names and realm names. `game.setOwner('norrhus', 'FNA')` from the console.
- **Realms.** A polity can name another as its parent or its suzerain, so an empire draws as one country at low zoom and as its constituent kingdoms when closer.
- **Areas** are calculated on a sphere, not counted in pixels, so they are undistorted near the poles.
- **Counties.** 14,093 of them, generated rather than drawn. Each province is cut into pieces an army can cross in under twelve days, sized by the terrain and climate underneath, with their boundaries pulled onto rivers where a province has any. Polar ground is allowed far larger counties, since there is no front there to keep responsive. Every one of the 1,229 cities gets a county to itself, tagged Urban alongside its landform. Provinces stay the level for ownership and economy. `node sync-provinces.js --counties` reports the figures without writing anything.

- **Water at a county's borders.** Each county records how much river and lake lies in it, and how much of each border it shares with a neighbour is water: `riverShare`, `lakeShare`, `riverBorders` and `lakeBorders`, measured by `--counties --write`. The border figures are per neighbour, because attacking a county across a river and attacking the same county from dry ground are different problems and one figure on the county cannot say which is which. They are also symmetric. A river is one pixel wide, so its pixels belong to one bank or the other and never both, and the snap pass hands each to whichever bank reached it first; 35.6% of river borders on the map are therefore carried by water lying wholly inside one of the two counties, and reading only the defender's water would give each of those a penalty attacking one way and none attacking the other. Nothing consumes them yet.
- **Resources.** Eighteen kinds — coal, oil, natural gas, iron, copper, aluminium, rare metals, gold, uranium, tazkuri, fertile land, rubber, fish, nitrates, timber, tungsten, textiles and base metals — held per province in `data/json/resources.json`. That file lists only the 1,502 provinces which have something and every reader takes an absent figure as zero, so a barren province is an absence rather than a row of noughts. The map stacks a province's deposits at its centre of mass, each a mark and a pair of figures: what it yields today over what is in the ground. Yield is zero throughout, because it is deposit × (0.4 + 0.6 × development) and development reads road, electricity and rail, none of which has a level authored yet — showing 0 is the honest answer and the figure moves on its own once they are. Unprospected, offshore and stranded deposits are all left out on purpose: this is what a country knows it has and can work, which is a different list from what is under it. Each line is drawn once into its own bitmap and kept, 4,371 of them across 1,487 provinces, because a low zoom puts well over a hundred on screen at once.

- **Population.** A 1926 figure per province, in `data/json/province-stats.json`, authored country by country. 345 provinces carry one so far, 450,864,000 people; Therundia is finished at 386,990,000 across 291 provinces and 23 polities, and Sakan is in progress. Each country is worked backwards from its 2001 successors, divided by a growth multiplier taken from that country's own history rather than its continent's, then spread across its provinces by the true terrain and climate percentages, river share and coast, with towns added on top rather than multiplied through. A continent's line is replaced by the sum of its countries once they are all done, and the other eight continents absorb the difference. The method, the traps and the continental budget are in `plans.md`.

- **Sound.** Four recordings: one on every button press, one for picking a province or a county, and two for picking water of which one is chosen at random — a single sample repeated on every click is what makes an interface sound mechanical, and water is clicked a great deal in the Navy mode. Each is fetched once and decoded into a buffer held in memory, so a press starts a fresh source node and presses overlap on their own. It was an `Audio` element first and it was audibly late: `play()` is asynchronous by specification and rewinding with `currentTime = 0` forces a seek, tens of milliseconds together, which is nothing for a soundtrack and far too much for a button. Leading silence is trimmed at a quarter of each recording's own peak rather than at an absolute floor, because the ear places a sound where it gets loud and not where it becomes measurable — `old_radio_button.ogg` takes 112ms to reach a tenth of its peak and every one of those milliseconds reads as the interface being slow. The click is then held back a few milliseconds on purpose, scheduled on the audio clock rather than through a timer so it is the same every time, because a real button clicks at the bottom of its travel and not at first contact. The debug menu reports which part of the delay is the file, which is this page and which is the sound hardware.

- **Clock.** Real time at three speeds, with pause. It sets the date and the time, and moves the sun.
- **Pause menu.** `Esc` on the map opens it, with Resume game and Quit to start menu.
- **Progressive repaint.** Changing map mode repaints 15.9 million pixels across 72 chunks. It is spread over frames at six milliseconds each, visible chunks first and re-chosen every frame, so the map on screen is right immediately and the rest of the world catches up behind it. Done in one pass it was a freeze of about a second. The overview is held back until the pass finishes and then changes in a single frame, so a change of mode does not wipe across the map from the top left.
- **Debug menu** (backtick key). Overlays for province names, sea region names, adjacency, coastal provinces, selection bounds, render chunks and layer seams, plus performance figures, map totals and details of the selected province.

## Planned

None of this exists yet, in roughly the order it is wanted.

- **Armies and movement.** Divisions recruited at county level and moved county to county, at a speed set by terrain and infrastructure.
- **Combat.** Battles based on numbers, terrain, fortifications and supply.
- **Navies.** Fleets moved between sea subregions, with straits and coastlines deciding what can reach where.
- **Relations between polities.** Alliances, wars, guarantees, occupations and claims.
- **Events.** Historical events and choices that can change the timeline.
- **AI.** Polities you are not playing running themselves.
