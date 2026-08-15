# Hearts of Iron Chron

Placeholder name.

A grand strategy game set in the world of Chron. It will start in 1926, seven years before
the Third Sapient War (1933-1938). The map covers the whole planet and is still being
drawn: 1,175 provinces and 99 polities so far, plus cities and capitals.

It runs in a browser. Nothing to install.

## Status

Early. Right now it is a map you can look at. No clock, no armies, no gameplay.

The map is not finished. Large placeholder regions get split into real provinces over time,
so the province count keeps going up and some areas are still blank blocks. Province stats
(population, infrastructure, factories) exist as fields but are all zeros.

## Running it

You need a recent browser and a way to serve the folder over HTTP. Double-clicking
`index.html` does not work, because browsers block a local page from reading its own data
files. The page tells you this if you try.

From inside the `Hearts_of_Iron_Chron` folder:

```sh
npx serve .            # then open the address it prints, usually http://localhost:3000
```

or, if you have Python:

```sh
python -m http.server 8000     # then open http://localhost:8000
```

Any static file server works, including the VS Code Live Server extension.

The first load takes about a second. The **Enter** button on the start screen stays
disabled until the map is ready.

## Controls

| What | How |
| --- | --- |
| Pan | Drag with the left mouse button. The map wraps east-west. |
| Zoom | Mouse wheel, the zoom buttons in the toolbar, or the `+` and `-` keys |
| Fit the whole world | **Fit** button, or `0` |
| Select a province | Left-click it |
| Clear the selection | Click open sea, or press `Esc` |
| See what something is | Hover for a tooltip: province, owner, terrain |
| Change map mode | **Political**, **Provinces**, **Terrain** in the toolbar |
| Close the province card | The **×** on the card. The province stays selected. |
| Go to a neighbour | Click a name in the **Adjacent provinces** list in the debug menu |
| Debug menu | **Debug** button, or the backtick `` ` `` key |
| Dismiss the start screen | **Enter**, `Space` or `Esc` |

## Features

- **Political mode.** Provinces coloured by owner. The colour is strongest at the borders
  and fades inland, so the terrain underneath stays visible.
- **Provinces mode.** Every province gets its own colour.
- **Terrain mode.** Coloured by landscape: plains, hills, mountains, desert, jungle,
  arctic. Provinces with two terrain types get a mix of both. Impassable areas are darker.
- **Satellite imagery** under the political colours. Can be turned off in the debug menu.
- **Country names** are drawn on the map and follow the shape of the territory. They scale
  with the zoom, fade in once they are big enough to read, and fade out when you zoom in
  past them. A country split across islands gets a name on each part.
- **Cities** appear as you zoom in: capitals first, then ordinary cities, then their names.
  Names are placed to avoid overlapping each other.
- **Province card.** Click a province for its owner, foreign claims, population, area in
  km², and what is built there: road, rail, supply hub, fortification, electricity,
  anti-air. Building slots are shown as one row shared between civilian and military
  factories.
- **Selection.** The selected province and everything bordering it are highlighted, and
  country names dim while a province is selected.
- **Areas** are calculated on a sphere rather than counted in pixels, so they are not
  distorted near the poles.
- **Debug menu** (backtick key). Overlays for province names, adjacency, coastal
  provinces, selection bounds and render chunks, plus performance numbers, map totals and
  details of the selected province.

## Planned

None of this exists yet, roughly in the order it is wanted:

- **Clock.** Real time, with adjustable speed and pause. Everything else depends on it.
- **Ownership change.** Provinces changing hands during play, with the map updating.
- **Counties.** A level below provinces, used for army movement and combat. Provinces stay
  the level for ownership and economy.
- **Armies and movement.** Building units and moving them county to county, at a speed set
  by terrain and infrastructure.
- **Combat.** Battles based on numbers, terrain, fortifications and supply.
- **Relations between polities.** Alliances, wars, guarantees, occupations and claims.
- **Events.** Historical events and choices that can change the timeline.
- **AI.** Polities you are not playing running themselves.
