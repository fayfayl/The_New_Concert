# The New Concert

This will be a grand strategy game set in the world of Chron. It starts on 10 Ungerbruni 1926, seven years before the Third Sapient War (1933-1938). The map covers the entire planet and is finished. It holds 1,525 provinces across 193 polities, 14,095 counties below them, 1,230 cities, and 95 sea regions divided into 4,005 subregions.

It runs in a browser and requires no installation.

## Status

The map is finished, with its provinces, counties, cities and sea regions. There are no armies, combat, research or events yet. Resources and consumer goods trade daily on the automatic market, under each country's tariffs; trade routes and bunkering are not in yet.

Province statistics are complete. `data/json/province/province-stats.json` holds the maximums the terrain allows, and `data/json/province/provinces-starting-infrastructure.json` holds what a game begins with. The world carries 2,223,477,000 people across 1,514 provinces at the 1926 figure, 19 resource types across 1,521 provinces, and road, electricity, radar, supply hub, anti-air and air base levels across 1,503 provinces. 1,996 civilian and 295 military factories occupy 8,195 building slots, 1,624 counties are fortified, 4,008 counties are railed, and 108 eyries, 156 naval dockyards and 1 synthetic rubber plant are built.

Sea regions are drawn and named in `data/json/geography/sea.json`, which also records which of them are lakes.

The economy is simulated daily: factory output and consumer goods in `src/game/industry.js`, the 19 resources with their power, fuel, reserves and shortages in `src/game/resources.js`, and the construction, equipment and ship queues in `src/game/production.js`.

Governments are complete for all 193 polities, with their laws, policies, decrees and 254 national spirits in `data/json/government/`. Each polity's treasury, political power, command power, manpower, stability and war weariness follow from them in `src/game/nation.js`.

Each country's view of every other is calculated in `src/game/relations.js`, one figure each way, from ideology, wars past and present, claims, occupation, realms and each government's spirits, acts and leader. The game starts with 81 standing relations in `data/json/government/polities-relations-fixed.json`, among them 6 leases, 12 state agreements, 11 denunciations and 11 wars being fought, along with 15 wars that ended before 1926 in `polities-past-wars.json` and 2 treaties with reparations in `polities-treaties.json`. Diplomatic actions cannot yet be taken in the game.

## Local running

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
- **County boundaries follow rivers**, by `node test/sync-provinces.js --snap-rivers --write`.
- **Rivers.** 79,366 pixels, routed across the 144 inland lakes they meet. They fade in from 100% zoom and darken with the landscape at night.
- **Sea subregions, in the Navy mode.** 4,005 of them under the 95 sea regions, the same relationship a county has to a province. Each carries a seafloor depth zone.
- **Counties mode.** The level below provinces, 14,095 of them, each in its own colour.
- **Resources mode.** Each province lists its deposits with the yield over the amount in the ground. Hover a row to name the deposit and its yield.
- **Ideology mode.** Each province takes the colour of its leading movement, paler as that movement's share falls. Hovering lists every movement's share.
- **Infrastructure layers.** A toolbar menu of ten: Road, Electricity, Radar station, Fort, Supply hub, Anti-air, Air base, Factories, Hydro and Rail. Each province shows built over ceiling; Fort draws county fortifications and Rail the rail network.
- **Navy mode.** The water divided into sea regions, each in its own colour, with land reduced to flat slate.
- **Satellite imagery** under the political colours. Switchable in the debug menu.
- **Day and night.** The line between day and night, with city lights on the dark side. It moves as the clock runs.
- **Country names** drawn along the shape of the territory, appearing and fading with the zoom.
- **Cities** appear with the zoom: capitals first, then ordinary cities, then their names.
- **Province card.** Owner or occupier, foreign claims, population, area in km², happiness and unrest with a hover breakdown of each, the six infrastructure levels as built over ceiling, and the building slots.
- **County panel.** Right-click land for the county's owner, province, terrain, climate, fort level, railway and area.
- **Selection.** The selected province and everything bordering it are highlighted.
- **Ownership change.** Provinces change hands at runtime and the map updates. `game.setOwner('norrhus', 'FNA')` from the console; `game.demolish('west_podderonskie_2', 'syntheticRubber')` removes a building.
- **Realms.** A polity can name another as its parent or its suzerain, so an empire draws as one country at low zoom and as its constituent kingdoms when closer.
- **Areas** are calculated on a sphere, not counted in pixels, so they are undistorted near the poles.
- **Counties.** 14,095 of them, sized so an army crosses one in under twelve days. Every city has a county to itself.
- **Buildings.** Eyries, naval dockyards and synthetic oil and rubber plants stand in a county and are captured with it.
- **Building marks.** Each building is drawn as an icon in its county. Hover one for the building, its owner and the county.
- **Water at a county's borders.** How much river and lake lie in each county, and how much of every border it shares with a neighbour is water.
- **Resources.** Nineteen types held per province, drawn on the map as what each yields today over what is in the ground.
- **Population.** A 1926 figure per province, complete at 2,223,477,000 across 1,514 provinces.
- **Sound.** Four recordings, on button presses and on selecting a province, a county or water.
- **Clock.** Real time at three speeds, with pause. It sets the date and the time, and moves the sun.
- **Pause menu.** `Esc` on the map opens it, with Resume game, Controls and Quit to start menu.
- **Country dossier.** Ctrl and left click opens a country's panel: flag, leader and portrait, party, ideology, stability, manpower and its national spirits. Ctrl and right click opens a member of a realm.
- **Relations.** The dossier lists each kind of relation as a row with a fan of flags, one per country. Hover a flag for the terms and dates.
- **Intel Ledger.** The dossier's second tab shows a country's laws and doctrine as tiles, its forts, factories and dockyards, and empty Ministers and Commanders slots.
- **Tooltips for laws, spirits and doctrine.** Hover a tile in the dossier for its effects, written as the figures they change.
- **Government panel.** In the debug menu, the selected province's government: form, ideology, compass position, policy slots, laws, doctrine, policies, decrees, spirits and what the laws cost. A realm member shows both its realm's and its own.
- **Console commands.** The `game` object in the browser console, in families: ownership and buildings, the clock and camera, government (`setLaw`, `addPolicy`, `addSpirit`), economy (`industry`, `supply`, `trade`, `tariffs`, `setTariff`, `treasury`, `reserve`), production (`build`, `produce`, `layDown`, `queue`), relations (`relations`, `relationsOf`, `treaties`) and infrastructure (`setLevel`, `setFactories`, `addRail`).
- **Progressive repaint.** Changing map mode repaints in chunks across several frames, visible ones first.
- **Debug menu** (backtick key). Overlays for province names, sea region names, adjacency, coastal provinces, selection bounds, render chunks and layer seams, plus performance figures and map totals.

## Planned

The following is planned and not yet implemented, in roughly the order it is wanted.

- **Armies and movement.** Divisions recruited at county level and moved county to county, at a speed set by terrain and infrastructure.
- **Combat.** Battles based on numbers, terrain, fortifications and supply.
- **Navies.** Fleets moved between sea subregions, with straits and coastlines deciding what can reach where.
- **Diplomatic actions.** Alliances, guarantees, war declarations and the rest taken in play, not through data and the console.
- **Research.** Technology bought with research points.
- **Events.** Historical events and choices that can change the timeline.
- **AI.** Polities you are not playing running themselves.
