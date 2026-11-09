# City.RA — checkpoint prototype

A 2D real-time strategy game for the browser, written in plain HTML5, CSS and JavaScript on Canvas. No build step, no libraries, no external art: every sprite, texture and sound is generated in code.

## Play it

**Online:** https://meso-studios.github.io/cityra/ (GitHub Pages). Multiplayer works there with join codes.

## Run it

**Easiest — `CityRA.html`.** One self-contained file with every script built in. Save it anywhere and double-click it. No server, no folder structure needed.

**Multiplayer.** Menu → Multiplayer → Host a game gives a 5-letter join code (and an invite link, `…/?join=CODE`). Friends choose Join and type the code. Four connection types:
- **Cloud relay (default)**: the game travels through a free public HTTPS relay (smee.io), so it runs on GitHub Pages or any static host and works between devices on different Wi-Fi, mobile networks or behind firewalls. Nothing to install and no account is needed; share the host's join code. It is a best-effort public service, so use a self-hosted relay for a private game.
- **Peer-to-peer (optional)**: WebRTC data channels via the free PeerJS broker (0.peerjs.com). Faster when a direct route exists, but strict NATs can block it.
- **Same computer**: links browser tabs.
- **Relay server**: for networks that block WebRTC. Run `python3 server.py` (or `node server.js`) in the game folder, open the address it prints, and pick Relay server.

The options below are for working on the source code.

**Option A — any static server (recommended)**

```
cd cityra
python3 -m http.server 8000
# open http://localhost:8000/play.html
```

**Option B — double-click** `play.html` after extracting the whole zip. It loads the scripts from the `js` folder beside it, so it shows a blank page if opened on its own or from inside the zip viewer. Saves use `localStorage`.

`index.html` and `play.html` are the same page; GitHub Pages serves `index.html`. Fonts load from Google Fonts when online and fall back to system condensed fonts offline. After editing a file in `js/`, run `python3 bundle.py` to rebuild the self-contained `CityRA.html`.

## What is in this checkpoint

| Area | Working now |
|---|---|
| Maps | Procedural generator, 6 theatre types (continental, coastal, river valley, archipelago, desert, highlands), 8 sizes up to 1024×1024, 4 seasons. Rivers, lakes, coasts, beaches, wetlands, forests, mountains, farmland. Strategic zoom-out for huge maps |
| Real Earth | Pick any region of the world map: click to centre a preset (55 km skirmish up to the whole planet) or **drag a box** for a custom region of any shape. Real coastlines (~5.5 km), matching climate zones and major mountain ranges, **real country borders** (Natural Earth, 185 countries, drawn on the ground, in the strategic view and on the minimap, with country labels) and **~3,000 real cities** placed at their true positions and sized by population. A scale bar and a hover readout show country, latitude/longitude, city population and radiation. Click the preview to choose where your base deploys, or pick a starting nation and deploy inside it; rival bases start in other countries, far apart and near cities |
| Scale | Every map has a real-world scale (km per tile) shown in the setup screen and on a scale bar: 1 tile is about 100 m on a local-war map, 1 km on a national map and 80 km on a whole-world map. City footprints follow population and scale, and nuclear blast radii follow physical laws in real kilometres. Visibility, fog and the minimap throttle automatically on giant and planetary maps to hold the frame rate |
| Realism and scale | One world scale: **1 tile = 10 m**. Every unit, ship, aircraft, structure and warhead is defined in real units in `js/realism.js` (length, width, speed in m/s, blast radius in m) and converted to game units, so a main battle tank is 10 m long, a destroyer 150 m, an infantry squad is drawn as its individual soldiers, a headquarters compound is 50 m, the airfield is a 240 × 90 m air base with four 60 m stands (a 56 m-span bomber fits), and a 155 mm shell kills within 30 m. Weapon ranges keep their real order on a compressed square-root curve (rifle 100 m, tank gun 300 m, artillery 930 m), so fights still fit on screen. Zoom runs from 6× (individual soldiers) out to the strategic view; zoomed out, every unit gets a faction marker. Nuclear blasts are sized at the scale the map's cities are drawn at (`urbanKm`): procedural towns are true to the 10 m tile, and on real-Earth theatres all cities share one scale so the largest spans 10–14 tiles. A warhead therefore destroys the same share of a city of a given size on any map. Every unit keeps that same exact scale on both axes: a 10 m main battle tank is drawn 10 m long and 3.75 m wide, a 19 m fighter is 19 m, a 48 m bomber is 48 m, and robotic UCAVs and interceptors use full-size airframes so they read at the same scale as crewed fighters instead of growing with AI model tier. Smoke clears in under half the old time |
| Territory | You can only build on ground your nation holds. The HQ claims about 280 m, each finished structure extends the border, and held towns and strategic points project zones. Combat troops hold the ground they stand on, but enemy land under a standing structure or held point can't be painted over. Strategic points (oil, towers, checkpoints, airports, harbours) are captured by holding their 80 m core with troops and no enemies present, with a progress ring; enemy-held points take twice as long, and engineers still seize instantly. Surrounded pockets are absorbed. Borders are drawn on the map above the fog and on the minimap |
| Napoleonic era | Era → Napoleonic (1805) in setup, or the **Conquer Europe** mode on the real map of Europe. Six powers (France, Britain, Prussia, Austria, Russia, Spain) with unique units (Imperial Guard, Highland regiments, Death's Head Hussars, Kürassiers, Cossacks, Guerrilleros). Line infantry fire volleys in two ranks behind banks of powder smoke; hussars, lancers, dragoons and cuirassiers fight with sabre and lance; foot and horse artillery fire roundshot and canister; Congreve rockets; privateer brigs, pirate brigantines, frigates and 74-gun ships of the line with ripple broadsides. Period buildings (château, caserne, windmills, stables, dockyard, redoubts, star-shaped earthworks), period towns with horse-drawn traffic, dirt roads and timber bridges, no railways, airports or power grid. 1805 city and country names, and a warm parchment-and-brass look. Conquer Europe: each nation starts at its capital; take two thirds of Europe's 1805 capitals and hold them for a minute, or break every rival |
| Multiplayer | Host-authoritative: the host's browser runs the battle, other players are thin clients that receive the world about 8 times a second (delta-coded units, projectile and effect events, structures, territory, economy) and send their orders back, where the host checks them against the sender's nation. Players take the setup screen's opponent slots; unclaimed slots stay AI, and a player who leaves is handed to the AI. Lobby with chat. Works across devices through the free cloud relay, across tabs on one computer, or over LAN or internet through `server.js` / `server.py` |
| Performance | Fixed-step simulation inside a 16 ms per-frame budget (a heavy moment slows the clock rather than freezing the screen), adaptive particle quality, off-screen effects skipped, span-filled visibility and territory stamping, a coarse combat hash for long-range target scans, and staggered crowd separation and building updates. A 400-unit battle on a 384² map costs about 3.5 ms per simulation step and 15 ms per frame |
| Territory zones | Every settlement and capturable (oil, towers, checkpoints, airport, harbour, power) projects a coloured border. Capture ground with engineers or by swaying settlements; enemies inside your perimeter trigger an alert, and the AI guards its own zones. Checkpoints are capturable border posts that reveal the surrounding area. Ground forces claim the land they cross, the minimap tints each faction's territory, and fully surrounded pockets are absorbed with their unowned points |
| Strategic strikes | Research the Strategic missile programme to build silos and missile defence batteries. Nine missile types with real ranges in km: cruise (1,500), short-range ballistic (600), cluster (900), thermobaric (700), ballistic (4,500), hypersonic glider (3,500, nearly impossible to intercept), tactical nuke (10 kt, 800 km), strategic nuke (300 kt, 7,000 km) and thermonuclear ICBM (1.5 Mt, 16,000 km). The launch cursor shows range and blast rings. Batteries try to intercept. Impacts level blocks, start fires, shake the screen and wreck your reputation if civilians are hit. The AI uses them too, including nukes on harder settings |
| Nuclear weapons | Needs the Nuclear programme (and ICBMs for the megaton missile). Fireball, 20 psi, 5 psi, 1 psi and thermal radii scale with yield (Y^0.4, Y^1/3, Y^0.42) and the map scale; shock fronts arrive after the flash, aircraft in the blast radius are destroyed, trees are flattened, a mushroom cloud rises. Every other faction turns on the aggressor |
| Casualties | Every figure is a whole number of people, with killed and injured counted separately. Real cities carry their real population (Frankfurt about 650,000), so tolls are in real numbers. Nuclear deaths are worked out building by building from distance to ground zero (blast, burns, collapse, glass injuries); conventional missiles are capped by the real lethal footprint of the warhead, so a cruise missile kills tens, not thousands. Deaths from fallout, collapsing buildings, combat crossfire and untreated wounds are tracked by cause, shown on the end screen, in the Civil affairs table and in strike reports. Hospitals help the injured recover |
| Fallout | Each detonation leaves a radioactive plume stretching downwind that decays over time, drawn as an overlay and on the minimap. Radiation sickens infantry and civilians, harms vehicle crews, empties settlements, spoils farms, triggers Geiger-counter warnings and evacuation. Enough nuclear use causes a nuclear winter that cuts food production worldwide |
| Sandbox | Instant construction, training, research, upgrades and missile arming, no prerequisites, unlimited resources, build anywhere |
| World | Cities, towns and villages on street grids with zoned buildings (housing, shops, hospital, schools, university, police, fire, city hall, bank, factories, warehouses, water plant, substations, bus depot), highways with bridges, a railway with a running train, airport, harbour, power station and power lines, fuel stations, checkpoints, comms towers, oil derricks, ruins |
| Rendering | Grid-free blended terrain with hillshading and texture noise in cached chunks, decals (craters, scorch), day/night with building, vehicle and fire lighting, physically staged explosions (prompt flash, decelerating shock fronts, cooling fireballs, ballistic shrapnel, soot occlusion and dust skirts), world-space explosion bloom, warm/cool cinematic colour grading and anamorphic highlights, weather (rain, thunderstorm, fog, snow, sandstorm), fog of war, minimap with radar rule |
| Civilians | Population, housing, jobs, utilities (power, water), services, happiness, economy, taxes; pedestrians and traffic on roads with intersection yielding; fire engines, ambulances, police, buses, construction crews, trade convoys, tractors; injured civilians, casualties, evacuation, refugee shelters, self-rebuilding |
| Military | 4 factions with doctrines and unique units; 34 unit types (infantry, vehicles, aircraft, ships); 25 structures; power grid; construction queues; upgrades; repair and sell; research tree (10 techs) |
| Combat | Weapon/armour tables, projectiles (bullets, shells, rockets, homing missiles, artillery arcs, bombs, torpedoes), splash, suppression, cover, morale and retreat, veterancy, ammunition and resupply, ECM flares, radar-guided SAMs, stealth and submarines, transports, capture, demolition, destructible bridges, wrecks that block roads, fire spread |
| Economy | Credits, power, fuel, materials, food, water, metal, supplies; ore harvesting, mines, farms, pumps, depots, logistics conversion, storage caps, shortages with real effects. Bitcoin mining farms earn credits that scale with every AI Datacenter on the network and with the size of the mining pool, but draw heavy power |
| Stock market | Seven listed corporations (defence, mining, energy, logistics, agri/medical, finance, robotics/AI) plus municipal bonds for every city and town. Company valuations rise and fall with the presence and health of their required city buildings, trade routes, highway traffic, combat and AI model tiers. Buy, sell, collect dividends and fund civic development grants |
| AI innovation | AI Datacenters run training on your current model. Twelve models — Drone, Servo, Rover, Sentry, Cortex, Vector, Chassis, Turbine, Goliath, Matrix, Colossus, Mainframe — each with a distinct procedural chassis sprite and a major jump in robotic damage, durability, speed and upkeep; 2–8 sub-steps inside each model (Rover 3.5 … Mainframe 12.8). The first four datacenters add parallel training slots, and every extra datacenter adds +30% training speed applied live to runs already in progress. Five buyable combat specializations (assault, aegis, recon, siege, logistics) and six buyable infrastructure optimizations boost power plants, ore haulers/refineries, airfields, factories, mines/farms and base defences. Combat UGVs, robotic combat vehicles, UCAV strike drones and interceptors all scale with the current model |
| AI and diplomacy | Base-building AI with doctrine plans, production mixes, research, scouting, capture, defence and attack waves, air strikes, naval patrols. Stances (war, ceasefire, neutral, alliance), opinion, trade agreements, sanctions, AI-initiated offers |
| Modes | 5-mission campaign, skirmish, conquest, survival, defensive, peacekeeping, urban evacuation, resource competition, reconstruction, sandbox |
| Interface | Resource bar with rates, build sidebar with queues, selection and command panel, settlement panel with evacuation/aid/trade/rebuild, diplomacy and civil-affairs windows, objectives, ticker, pause and 4 speeds, save/load (3 slots + autosave + text export), rebindable keys, touch controls |

### Not in this checkpoint yet
- A scenario/map editor UI (the map format and `MapGen.blank()` are ready for it).
- Hand-made art and recorded audio (the replacement hooks below are ready).
- On real-Earth theatres the terrain is at strategic scale (kilometres per tile) while units and structures stay at the 10 m tactical scale and march at an operational pace; they are shown with markers when zoomed out.
- Multiplayer clients get fewer notification messages than the host (production and alert toasts are host-side), and civilian foot and road traffic is not mirrored to clients.
- `server.js` needs Node.js; `server.py` needs only Python 3 and behaves identically.
- Pathfinding is per-unit tile A* with smoothing; very large battles (300+ units moving at once) can queue paths for a moment.

## Controls

| Action | Input |
|---|---|
| Select / box-select / add | Left-click / drag / Shift |
| Context order (move, attack, board, capture, repair, harvest, aid, clear) | Right-click |
| Force fire, including ground | Ctrl + right-click |
| Queue waypoints | Shift + right-click |
| Attack-move · stop · guard · patrol · fire at | A · S · G · Q · T |
| Scatter · formation · retreat · unload · aircraft home | X · F · R · U · B |
| Groups | Ctrl+1–9 assign, 1–9 select, double-tap to jump |
| Camera | Arrows, screen edge, middle- or right-drag, wheel zoom, minimap |
| Pause · speed | P · = and - |

All of these can be rebound in Settings.

## Architecture

Plain scripts loaded in order, all sharing the `G` state object:

```
js/core.js     constants, math, seeded RNG + noise, spatial grid, pools, heap, event bus, base64
js/data.js     factions, weapons, warheads, units, buildings, civilian buildings, research  ← tuning
js/realism.js  real-world dimensions, speeds, ranges and blast radii; one 10 m tile scale
js/sprites.js  procedural sprite atlas + art replacement hooks
js/earthdata.js  embedded land mask (0.05°)
js/geodata.js  embedded country raster (0.1°, Natural Earth) and real cities (GeoNames)
js/earth.js    Earth lookups (land, climate, countries, cities), world picker with drag-to-select regions
js/map.js      world generator (terrain, rivers, real or generated towns, roads, rail, resources, borders)
js/strike.js   missiles, interception, nuclear blasts, mushroom clouds, radioactive fallout
js/path.js     A* pathfinding, smoothing, request queue, connectivity
js/fx.js       particles, lights, decals
js/world.js    entities, visibility, combat, projectiles, aircraft, abilities, orders
js/civ.js      settlements, population, services, traffic, emergency services, evacuation
js/eco.js      factions, resources, power, production, research, upgrades
js/ai.js       faction AI and diplomacy
js/render.js   terrain chunks, entities, fog, lighting, weather, minimap
js/audio.js    synthesised WebAudio sound
js/game.js     clock, weather, modes, objectives, main loop, save/load
js/era.js      eras: Napoleonic order of battle, period art, Conquer Europe setup
js/ui.js       input, camera, panels, windows, menu
js/net.js      multiplayer: lobby, transports, host snapshots, client RPCs
server.py / server.js   static server + WebSocket room relay
```

The simulation runs at a fixed 30 Hz step independent of frame rate; `Game.sim(dt)` can be called headlessly for testing.

### Adding content
- **A unit**: add an entry to `UNITS` in `data.js` (stats, weapons, cost, producer category). Add a `case` to the right `draw*` function in `sprites.js`, or supply art (below). It appears in the sidebar automatically.
- **A building**: add to `BLDS` and to `BUILD_ORDER_UI`, then a `case` in `drawMil`.
- **A civilian building**: add to `CIVB`; give `layoutTown()` in `map.js` a reason to place it.
- **A weapon**: add to `WEAPONS`; warhead multipliers live in `WH`.
- **A mode**: add to `MODES` and a `case` in `Modes.setup` / `Modes.tick` in `game.js`.

### Replacing placeholder art and sound
Before the game boots (top of the inline script in `index.html`):

```js
SPR.overrides['unit:mbt']   = 'assets/mbt.png';    // top-down, nose pointing right
SPR.overrides['bld:power']  = 'assets/power.png';  // footprint w×32 by h×32 px
SPR.overrides['civ:house']  = 'assets/house.png';
Sound.files['cannon']       = 'assets/cannon.ogg';
```

Any key without an override keeps its procedural version, so art can be swapped in one asset at a time.
