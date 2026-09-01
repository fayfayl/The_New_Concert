# The New Concert

This will be a grand strategy game set in the world of Chron. It starts on 10 Ungerbruni 1926, seven years before the Third Sapient War (1933-1938). The map covers the entire planet and is finished. It holds 1,525 provinces across 194 polities, 14,095 counties below them, 1,230 cities, and 95 sea regions divided into 4,005 subregions.

It runs in a browser and requires no installation.

## Status

The map is finished, in provinces, counties, cities and sea regions alike. There are no other mechanics yet such as armies, combat and events.

Province statistics are complete. `data/json/province-stats.json` holds the maximums the terrain allows, and `data/json/provinces-starting-infrastructure.json` holds what a game begins with. The world carries 2,220,000,000 people across 1,514 provinces at the 1926 figure, 19 resource types across 1,521 provinces, and road, electricity, supply hub, fortification, anti-air and air base levels across 1,504 provinces. 1,995 civilian and 295 military factories occupy 8,194 building slots, 4,008 counties are railed, and 106 eyries, 156 naval dockyards and 1 synthetic rubber plant are built.

Sea regions are drawn and named in `data/json/sea.json`, which also records which of them are lakes.

## Running it locally

It requires a recent browser and a static file server. Opening `index.html` directly does not work because browsers block a local page from reading its own data files.

From inside the `The_New_Concert` folder, use the command prompt to execute:

```sh
npx serve .            # then open the address it prints, usually http://localhost:3000
```

or, with Python:

```sh
python -m http.server 8000     # then open http://localhost:8000
```

Any static file server works, including the VS Code Live Server extension.

A loading screen appears while the map loads, then it fades to the start menu.

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
| Inspect a county | **Right-click** land. The province is highlighted in gold and the county ringed in white inside it, and a panel opens with its owner, province, terrain, climate, railway and area. The two cards share a corner, so the right button closes the province card and the left button closes the county card. Escape closes it. |
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

Boots the map under node against a small DOM shim, runs frames, clicks through every map mode, and sweeps the zoom from 16x down to the floor and back. Every nine-argument `drawImage` is checked against the size of its source, because the specification clips a source rectangle reaching outside the image and returns the edge pixel repeatedly, which is how a wrapping layer develops a seam with nothing reporting an error. It exists for one failure in particular: an exception inside `requestAnimationFrame` used to cancel the re-arm with it, so the canvas stopped updating while every event handler continued to respond. The result looks like a frozen map with a working tooltip, and nothing reports the cause.

The loop now catches its own faults, re-arms regardless, and reports the first one in the debug menu. The test watches for that report.

## Features

- **Political mode.** Provinces coloured by owner.
- **Provinces mode.** Every province has its own colour.
- **Terrain mode.** Landform combined with the climate on it, in twelve Köppen groups from ice cap to rainforest. Impassable areas are darker.
- **County boundaries follow rivers**, by `node sync-provinces.js --snap-rivers --write`.
- **Rivers.** 78,214 pixels, routed across the 144 inland lakes they meet. They fade in from 100% zoom and darken with the landscape at night.
- **Sea subregions, in the Navy mode.** 4,005 of them under the 95 sea regions, the same relationship a county has to a province. Each carries a seafloor depth zone.
- **Counties mode.** The level below provinces, 14,095 of them, each in its own colour.
- **Navy mode.** The water divided into sea regions, each in its own colour, with land reduced to flat slate.
- **Satellite imagery** under the political colours. Switchable in the debug menu.
- **Day and night.** The line between day and night, with city lights on the dark side. It moves as the clock runs.
- **Country names** drawn along the shape of the territory, appearing and fading with the zoom.
- **Cities** appear with the zoom: capitals first, then ordinary cities, then their names.
- **Province card.** Owner, foreign claims, population, area in km², happiness, unrest, the six built levels and the building slots.
- **Selection.** The selected province and everything bordering it are highlighted.
- **Ownership change.** Provinces change hands at runtime and the map updates. `game.setOwner('norrhus', 'FNA')` from the console, `game.build('west_podderonskie_2', 'syntheticRubber')` for buildings.
- **Realms.** A polity can name another as its parent or its suzerain, so an empire draws as one country at low zoom and as its constituent kingdoms when closer.
- **Areas** are calculated on a sphere, not counted in pixels, so they are undistorted near the poles.
- **Counties.** 14,095 of them, sized so an army crosses one in under twelve days. Every city has a county to itself.
- **Buildings.** Eyries, naval dockyards and synthetic plants stand in a county and are captured with it.
- **Water at a county's borders.** How much river and lake lie in each county, and how much of every border it shares with a neighbour is water.
- **Resources.** Nineteen types held per province, drawn on the map as what each yields today over what is in the ground.
- **Population.** A 1926 figure per province, complete at 2,220,000,000 across 1,514 provinces.
- **Sound.** Four recordings, on button presses and on selecting a province, a county or water.
- **Clock.** Real time at three speeds, with pause. It sets the date and the time, and moves the sun.
- **Pause menu.** `Esc` on the map opens it, with Resume game and Quit to start menu.
- **Progressive repaint.** Changing map mode repaints in chunks across several frames, visible ones first.
- **Debug menu** (backtick key). Overlays for province names, sea region names, adjacency, coastal provinces, selection bounds, render chunks and layer seams, plus performance figures and map totals.

## Planned

The following is planned and not yet implemented, in roughly the order it is wanted.

- **Armies and movement.** Divisions recruited at county level and moved county to county, at a speed set by terrain and infrastructure.
- **Combat.** Battles based on numbers, terrain, fortifications and supply.
- **Navies.** Fleets moved between sea subregions, with straits and coastlines deciding what can reach where.
- **Relations between polities.** Alliances, wars, guarantees, occupations and claims.
- **Events.** Historical events and choices that can change the timeline.
- **AI.** Polities you are not playing running themselves.
