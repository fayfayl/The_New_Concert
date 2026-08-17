# Hearts of Iron Chron

Hearts of Iron Chron is a placeholder name.

This will be a grand strategy game set in the world of Chron. It starts in 1926, seven years before the Third Sapient War (1933-1938). The map will cover the entire planet and is still being currently drawn. As of now, it holds 1,425 provinces, 170 polities and 872 cities.

It runs in a browser and requires no installation.

## Status

The map is only partly finished. There are no other mechanics yet such as the clock, armies and events.

Map drawing continues. The placeholder region is being split into real provinces over time, so the province count rises. Province statistics exist as fields in `data/province-stats.json` and are set to zero.

## Running it locally

It requires a recent browser and a static file server. Opening `index.html` directly does not work as browsers block a local page from reading its own data files.

From inside the `Hearts_of_Iron_Chron` folder, use the command prompt to execute:

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
| Change map mode | **Political**, **Provinces**, **Terrain** in the toolbar |
| Close the province card | The **×** on the card |
| Go to a neighbour | Click a name in the **Adjacent provinces** list in the debug menu |
| Debug menu | **Debug** button, or the backtick `` ` `` key |
| Dismiss the start screen | **Enter**, `Space` or `Esc` |

## Features

- **Political mode.** Provinces coloured by owner.
- **Provinces mode.** Every province has its own colour.
- **Terrain mode.** Coloured by landscape: plains, hills, mountains, desert, jungle, arctic. Provinces with two terrain types take a mix of both. Impassable areas are darker.
- **Satellite imagery** under the political colours. Switchable in the debug menu.
- **Day and night.** A solar terminator with city lights on the night side, computed from the date, the latitude of the row and the longitude of the column. It shows in every map mode and at reduced strength on the political map. The date is fixed at 10 June 1926 until the clock is set.
- **Country names** are drawn on the map along the shape of the territory. They scale with the zoom, appear once they are large enough to read, and fade out past that. A country split across islands takes a name on each part, and a country in two pieces across a strait takes one name spanning both.
- **Cities** appear with the zoom: capitals first, then ordinary cities, then their names. Names are placed to avoid other city names and country names, and a city buried under a country name is hidden until the province is selected.
- **Province card.** Click a province for its owner, foreign claims, population, area in km², and what is built there: road, air base, supply hub, fortification, electricity, anti-air. Building slots are shown as one row shared between civilian and military factories.
- **Selection.** The selected province and everything bordering it are highlighted, and country names dim while a province is selected.
- **Ownership change.** Provinces change hands at runtime and the map updates over the affected area only, including borders, country names and realm names. `game.setOwner('norrhus', 'FNA')` from the console.
- **Realms.** A polity can name another as its parent or its suzerain, so an empire draws as one country at low zoom and as its constituent kingdoms when closer.
- **Areas** are calculated on a sphere, not counted in pixels, so they are undistorted near the poles.
- **Debug menu** (backtick key). Overlays for province names, adjacency, coastal provinces, selection bounds and render chunks, plus performance figures, map totals and details of the selected province.

## Planned

None of this exists yet, in roughly the order it is wanted.

- **Clock.** Real time, with adjustable speed and pause. Everything else depends on it.
- **Counties.** A level below provinces, used for army movement and combat. Provinces remain the level for ownership and economy.
- **Armies and movement.** Divisions recruited at county level and moved county to county, at a speed set by terrain and infrastructure.
- **Combat.** Battles based on numbers, terrain, fortifications and supply.
- **Relations between polities.** Alliances, wars, guarantees, occupations and claims.
- **Events.** Historical events and choices that can change the timeline.
- **AI.** Polities you are not playing running themselves.
