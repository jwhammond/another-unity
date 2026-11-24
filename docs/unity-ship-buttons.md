# Ship screens: painted buttons audit

Every control the original paints on a ship screen's background (or draws as a sprite over it), where it is, and what our DOM
UI has for it with the plate on. Rects are the original's pixels as `[x, y, w, h]` (ScummVM's `Common::Rect` is right/bottom
exclusive; converted here). Sources: `engines/unity/bridge.cpp`, `transporter.cpp`, `astrogation.cpp`, `computer.cpp`,
`unity.cpp` (runViewscreen), and our `engine/src/ui/ship/*.tsx` with the areas in `games/unity/presentation.yaml`.

Status: **OK** (ours is at the painted spot and does the same), **MISSING** (no control), **MISPLACED** (the control exists but
not over its painted button), **DEAD** (painted, ours present but does nothing), **PARTIAL** (present with a different form).

## Bridge (bridge.rm, interface strip)

| Control | Original rect | Ours | Status |
|---|---|---|---|
| Tableau items (replay, comms, lounge, tactical, astrogation, computer, turbolift, crew) | per item (`bridgeItems`) | `.au-ship-item` at the item rects | OK |
| Admin menu | [3, 421, 46, 59] | `data-strip=admin`, `port.adminMenu()` | OK |
| Viewscreen | [484, 426, 121, 42] | `data-strip=viewscreen`, `port.toggleViewscreen()` | OK |
| Sensor records: scroll up (transp.mrg 0/2 grey) | [117, 426, 48, 24] | none | MISSING |
| Sensor records: scroll down (transp.mrg 3/5 grey) | [117, 450, 48, 24] | none | MISSING |
| Sensor record rows x3 (click: preset destination, go to astrogation) | [171, 423 + 20*i, 295, 16] | none | MISSING |
| Hover-name box (readout, not a button) | [492, 392, 102, 16] | none | readout, not counted |

## Viewscreen (viewscr.rm)

No painted buttons: runViewscreen takes no clicks of its own; the hail's conversation is the ordinary dialog. Ours: the name
readout in `name`. Nothing to add.

## Transporter room (transp.rm)

| Control | Original rect | Ours | Status |
|---|---|---|---|
| Lists button (show crew/equipment lists) | [7, 300, 46, 64] | none (lists always shown) | MISSING |
| Map button (show the ship map) | [7, 359, 46, 64] | none | MISSING |
| List scroll up | [210, 359, 48, 24] | lists scroll with CSS | MISSING |
| List scroll down | [210, 383, 48, 24] | lists scroll with CSS | MISSING |
| Preview box (click: transfer the selected row) | [208, 293, 53, 53] | rows transfer on click | PARTIAL |
| Kit scroll left | [297, 424, 24, 53] | kit scrolls with CSS | MISSING |
| Kit scroll right | [321, 424, 26, 53] | kit scrolls with CSS | MISSING |
| Sliders (pull: energize) | [418, 291, 125, 117] | Recommended + Energize in `controls` [419, 291, 124, 124] | OK (Energize over the sliders) |
| Exit door (leave) | [63, 79, 25, 201] | exit list in `exits` [538, 293, 102, 45] | MISPLACED |

## Astrogation (astropnl.ast)

| Control | Original rect | Ours | Status |
|---|---|---|---|
| Rotation pad x5 | `data._rotationPad[i]` | none | MISSING |
| Cursor arrows x/y/z up | [191 + 32*i, 372, 29, 30] | none | MISSING |
| Cursor arrows x/y/z down | [191 + 32*i, 445, 29, 30] | none | MISSING |
| View buttons x3 | [124, 376 + 32*i, 48, 32] | none | MISSING |
| Exits: Bridge, Computer, Engineering | [490, 369/401/432, 119, 33/32/37] | Back to the bridge + Engage in `controls` [491, 373, 119, 100] | MISPLACED (Bridge), MISSING (Computer, Engineering) |
| Info / Course / Display tabs | [389, 49, 72, 25], [479, 49, 73, 25], [567, 49, 73, 25] | none (one panel) | MISSING |
| Warp | [395, 93, 83, 61] | radio in `info` | MISPLACED |
| Impulse | [552, 93, 86, 61] | radio in `info` | MISPLACED |
| Faster / Slower (sprites, pressed frame +1) | [478, 93, 64, 28], [478, 121, 64, 30] | range slider in `info` | MISPLACED |
| Engage (sprite, pressed frame) | [392, 161, 245, 28] | button in `controls` | MISPLACED |
| Stop (sprite, pressed frame) | [392, 189, 245, 28] | none | MISSING |
| Display switches x9 (Display tab) | [398 or 423, 102..332, ..., 20] | none | MISSING |
| Map (click: pick) | [10, 19, 374, 348] | canvas in `map` | OK |

## Computer (compupnl.ast)

| Control | Original rect | Ours | Status |
|---|---|---|---|
| Rows | rowRect(i) | `rows` list | OK |
| List up | [61, 412, 57, 28] | Up in `scroll` [64, 416, 209, 49] | MISPLACED |
| List down | [61, 440, 57, 28] | Down in `scroll` | MISPLACED |
| Text up | [217, 412, 57, 28] | none (entry scrolls with CSS) | MISSING |
| Text down | [217, 440, 57, 28] | none | MISSING |
| Bridge | [490, 370, 112, 30] | in `exits` [491, 373, 119, 100] | OK |
| Astrogation | [490, 402, 112, 30] | in `exits` | OK |
| Tactical | [490, 434, 112, 30] | in `exits` | OK |

## Summary (before fixes)

| Screen | Painted | OK | Missing | Misplaced | Partial |
|---|---|---|---|---|---|
| Bridge | 5 + tableau | 3 | 3 | 0 | 0 |
| Viewscreen | 0 | 0 | 0 | 0 | 0 |
| Transporter | 9 | 1 | 6 | 1 | 1 |
| Astrogation | 14 groups | 1 | 8 | 5 | 0 |
| Computer | 7 + rows | 4 | 2 | 2 | 0 |

## After the fixes

Every painted button above is now a control at its painted place (`engine/src/ui/ship/painted.tsx`: a clear button in a `data-area` box at
the original's rectangle; outlined and named with the hotspot labels on; a plain button in the `&art=0` greybox). Checked by
`apps/web/e2e/unity-ship-buttons.spec.ts`, which clicks each one with art and hotspots on.

| Screen | Had | Added | Fixed (moved) | Not available yet |
|---|---|---|---|---|
| Bridge | 2 strip + tableau | 5: sensor up, down, rows 1-3 | 0 | 0 (the sensor records are in the sim, below) |
| Viewscreen | 0 | 0 | 0 | 0 |
| Transporter | 1 (Energize over the sliders) | 7: lists, map, list up/down, kit left/right, door | 0 | 0 (the map is built: see "The transporter map") |
| Astrogation | 1 (map) | 17 (+ Warp, Impulse, Faster, Slower, Engage, Stop on the Course panel): Computer and Engineering exits, 3 tabs, 5 pad, 3 views, 6 cursor arrows | 1: Bridge exit (Engage moved to the info box, off the exit block) | 0 (the map camera is in: see below) |
| Computer | 4 (rows, exits) | 2: text up/down (scroll the entry) | 2: list up/down onto the left arrow's halves | 0 |

Notes:

- The transporter's Map is built (see "The transporter map" below): the game's own `tmaps.spr` pictures, the scan lines and the lock-on.
- The sensor records (`ShipState.sensorRecords`, `sensorScroll`, `lastSensorRecord`; `addSensorRecord` and `scrollSensors` in `sim/astro.ts`) are
  the original's: each course engaged is recorded (newest first, the same place twice running not again), the arrows scroll a record at a
  time and are greyed at the ends, a row goes to astrogation with that place chosen and puts it first again. Saves from before have none.
  Replay plays nothing from the records: in the original it opens the conversation log (already built), shown in a grey panel.
  The strip also draws the original's readouts in the plate's black fields: the speed (or the light years left, taking turns every two
  seconds) while travelling, DEST (or ARR once there) and the place, the three record names, and the name of the bridge item under the pointer.
- The astrogation Course panel is the original's set of controls at the original's rectangles (`PaintedButton`): Warp [395,93,83,61],
  Impulse [552,93,86,61], Faster [478,93,64,28] and Slower [478,121,64,30] (hold to repeat, as `changeSpeed`), the speed text at x 425 (warp, 1.0
  style) or 578 (impulse, as a percentage), Engage [392,161,245,28] and Stop [392,189,245,28]. Stop is `stopTransit`: the ship stays where it
  has got to, the journey and the bridge's destination readout go (`_destinationType = -1`). They replace the radios, the slider and our
  Engage button. The sector, star and planet selectors (ours: the original chooses by the map and the cursor) sit below the controls on the
  Info and Course tabs. The original's sprites for Faster, Slower, Engage and Stop are drawn when published: `npm run art -- astro publish` lifts them from
  `astro.mrg` (the screen's MRG is astro.mrg; there is no astropnl.mrg: astropnl.ast is the plate) entries 71/72 (Faster warp, up and pressed),
  73/74 (Faster impulse), 75/76 (Slower), 84/70 (Engage, its pressed frame is the lower entry) and 85/86 (Stop), coloured as the screen is
  (astropnl.ast's 128 colours under standard.pal; index 13 is clear, `COLOUR_BLANK`: the first publish took 0, which was wrong for any picture with transparent corners), 4x nearest-neighbour as the away
  team's panel is, lossless WebP in `games/unity/art/astro` with `art.astro` in presentation.yaml (both git-ignored). Each is drawn at its own
  size from the original's corner (Faster and Slower 66 by 28 or 29 at 478, 93 and 478, 121; Engage and Stop 245 by 29 at 392, 161 and 392, 189),
  the pressed frame while the pointer is down on the button (`_pressed`), with the clear button over it. Without them, with `&art=0`, or with no
  plate, the buttons are CSS as before (lit while pressed). Warp and Impulse are not MRG pictures but part of the course panel's own picture
  (`engineFrame`, engine.spr's animations 0 and 2): with that published (below) they are clear buttons over it, otherwise CSS.
  Engage goes to the bridge as the original's does (`buttonAt`: once `engage()` has taken the course, with the warp movie played first, then
  `gotoShipScreen(kShipBridge | 0x100)`; a refused course stays on astrogation, as does a Stop). So Stop is reached by coming back to astrogation.
  The three tabs are real: Info (the chosen place's name and the original's own text about it, below), Course, and Display (the nine switches;
  each acts on the map: stars, grid, the five regions' stars, inhabited stars and starbases coloured). The screen opens on Info, as `start` does
  (`setPanel(kPanelInfo)`), and a scripted warp opens Course. The sector, star and planet selectors stay in the tree for the keyboard and
  screen readers, visually hidden on the plate: the original chooses by the map.
- The astrogation map camera (`engine/src/sim/astroCamera.ts`, kept by the session, not saved) is the original's: the pad turns the map three
  degrees a click, a second click within 0x3c ticks starts a spin and the middle button stops it (or sets 6/3), the three views, the cursor
  arrows (the sector in the galaxy view, the place in the sector in the sector view, nothing in the system view; the cursor chooses what is
  at it, as `cursorMoved`), the three tabs, and the Display tab's nine switches (stars, grid, five regions, inhabited stars, starbases).
  The map itself is now the original's own drawing (see "Astrogation: what the original draws" below), not a 3D greybox. The map's opening is the original's (`setDefaults`, `start`; not a difference): 6 degrees azimuth and 3 elevation, spinning
  in azimuth only, backwards (-3, so one degree every 0x13 ticks, about 15 degrees a second), restarted from where it is on each visit to
  astrogation; a click of the pad, a drag, or the middle button while it spins stops it, and it then stays still on later visits (the
  original keeps `_spinning` too). Still different: a drag on the map still turns it, and the wheel zooms (neither is the original's).

- The rotation pad's rectangles are the executable's (`data._rotationPad`: up [9, 374, 99, 28], down [9, 445, 99, 28], left [9, 374, 28, 99], right [80, 374, 28, 99], middle
  [37, 402, 43, 43]), as `buttonAt` has them (up and down first, so over the corners of left and right); they were read off the plate before.
- The transporter's lists and map buttons are trimmed by a few pixels so they don't overlap each other or the equipment list.
- Warp, Impulse, Faster, Slower, Engage and Stop are sprites on the original's Course panel, not on the plate; ours are the
  painted controls above, and the sprites are drawn for the four that are MRG pictures.
- The transporter's kit is now a tray of four slots, the round arrow and four slots, as the original's, with the arrow showing through.

## The plates show their own buttons and fields

Where the plate paints a button or a field, our controls are clear over it or lie inside it, rather than drawing a box of their own:

- Computer: Bridge, Astrogation and Tactical are clear buttons over the painted grey exits; the topics lie one to a painted row of the
  grid (15 rows of 23 pixels from y 54, no ground or borders, the selected row lit within its row); the entry sits inside the painted
  pane with the original's margin (kTextX 200, kTextY 62).
- Transporter: the equipment and crew lists lie in the painted rows, the kit in the painted slots, with no ground; Energize is a clear
  button over the painted sliders (trimmed to x 537 so it does not meet the exits); each padded crew member is a clear button over the
  pad (the original's padAt rectangles, now on the port); Recommended (no button in the original) sits under the exits; the status is on
  the room's floor.
- Astrogation, bridge and viewscreen: the info box, the sector readout and the hail's name lie in fields the plate paints black; nothing
  covers a painted button.

## Astrogation: what the original draws

Compared with the original's screen, captured from ScummVM's own harness (`tools/scummvm-harness`, `shot`, the tests `a1` and `a3` of
`~/pcode/unity-tools`; muted), element by element. The map is `engine/src/view/astroLayout.ts` (the layout: a port of `AstrogationScreen::draw`
and what it calls, as drawing commands in the original's 640x480 pixels, and the entries that pick), `astroPaint.ts` (the commands onto a 2D canvas
over the plate's map window, at three canvas pixels to an original pixel), `astroGlobe.ts` (the planet's globe), `astroSelect.ts` (what the
cursor and clicks choose) and `astro.ts` (the three.js plane the session draws in the plate's window). The planets themselves are `sim/planets.ts`,
a port of `universe.cpp`'s `PlanetMaker`: the same planets, classes, moons, belts and inhabitants from a star's seed (checked against the capture of
one system), and the text the info panel says (`starText`, `planetText`, `moonText`, `stationText`, `phenomenonText`, `sectorText`).

The pictures and tables come from the game with `npm run art -- astro publish` (git-ignored, like the rest of `games/unity/art`): astro.mrg's
stars by class, hazards, stations, planets, moons, belt, outpost and starbase pictures, the selection frame and the ship and destination markers;
the info and display tabs' strips and the swatches; and engine.spr's course panels for warp and impulse and the engines' frames. Transparent is
index 13 (`COLOUR_BLANK`), not 0. The tables the raw export lacks (the Display labels, the screen's messages, the alignments' texts and colours,
the stars' magnitudes, the planet numerals and class descriptions, each class's size in the system view, the map's palette colours) are read from
STTNG.OVL in STTNGINS.ZIP and written to `art.astro.tables`. With them absent the map draws shapes in the original's colours and the text uses
plain Roman numerals and short class names. Check after another publish that `art.astro` still has `palette`, `tables` and the `engine_*`, `course_*`, `planet*` and held and lit (`pad_*_down`, `arrow_*_down`,
`exit_*_down`, `view_*_lit`) sprites, and that `art.fonts` is there: `art astro publish` rewrites the whole `art.astro` key and `art.fonts`, and nothing else.

| Element of the original | Ours | Status |
|---|---|---|
| Plate (astropnl.ast), tabs, pad, view and cursor buttons, exit block | the repainted plate and the painted buttons over it (earlier work) | differs by design (the repaint); the original's own pictures of what is held and what is lit are drawn over it (the next row) |
| Pad button, cursor arrow or exit held (`drawButtons`: `_pressed` draws astro.mrg's picture of it at the button's corner); the view the map shows always lit (entries 1, 3, 5) | the 13 pictures `art astro publish` lifts from astro.mrg (entries 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, with index 13 clear, 4x), drawn by `PaintedButton`'s `held` and `lit` at the button's corner while the pointer is down / while it is on | matches (`apps/web/e2e/unity-astro-pictures.spec.ts`) |
| Title "SECTOR: NAME x-y-z" (label font at 101, 1) | `data-readout="title"`, in the plate's bar | matches (the game's font) |
| Galaxy view: grid walls, a pixel per charted star in its alignment's colour, the cross for inhabited stars and ring for starbases (Display), the sector box and its three digits, the ship-to-cursor line with "n.nnn LY", the ship marker, the course line, destination marker and name | all of it, with only charted stars | matches |
| Galaxy view with the stars off: cross sections, back faces of the cube, ticks | all of it | matches |
| Galaxy click: chooses the sector by screen position (`pos.x - 100`, `pos.y - 90`), or the star hit | ported as it is | matches |
| Sector view: sprites by class scaled by magnitude, drawn far to near with a line to the floor grid, hazards and stations, the grid behind or in front, the ship, the box 32 across round what is chosen, the cursor's three squares | all of it | matches |
| System view: the star and its companion at the corners with class and magnitude, "UNCHARTED", the planets left to right spaced by size with their orbits, class letters, moons and their stalks, belt, outpost and starbase icons, the marker under the chosen one, its globe (120 pixels, turning), a station's picture and name, the messages for no planets and an unscanned system | all of it; planets, moons and the belt pick as in the original (the outpost does not) | matches (the globe is the original engine's own made-up surface, ported) |
| What is chosen: name at the top of the map, info panel title and text (`updateInfo`), the cursor going to it (`selectionChanged`), the first visit choosing where the ship is and showing it close up, `cursorMoved`, the tails of `buildSectorEntries` and `buildSystemEntries` | ported (`astroSelect.ts`, the session) | matches |
| Courses to a moon, an outpost or starbase, an asteroid belt, a station, a hazard, or the cursor alone | `sim/astro.ts` `destinationOf` (was: stars and planets only, "no moons yet") | matches |
| Info panel: the title at (399, 98), the lines from y 134, 18 apart, wrapped to 223 | the same text and places (the browser wraps; our condensed font) | matches (the game's font, wrapped as the original wraps it) |
| Display panel: nine bars at the original's tops, lit or off, the labels at x 528, the region swatches, the tab strip | `art.astro.tables.labels` (our own "Region n" names without), the bars, the swatches' and tab pictures | matches |
| Course panel: the panel picture for warp or impulse, Warp, Impulse and the arrows in it, the speed at 425 or 578, Faster, Slower, Engage, Stop and their pressed frames, the engine's frames (166 ms each) | the pictures lifted from astro.mrg and engine.spr, the clear buttons over them | matches (a new game's speed is warp 5.0, `_warpSetting = 500`, and the buttons keep to 1.0 to 9.9 whatever the engines can do; a course refused as too fast sets the speed to the most they can) |
| Coordinates fields (cursor, ship), angles ("°E: 000", "°A: 000") | `data-readout="cursor-x"…`, `ship-x`…, `elevation`, `azimuth` | matches (the game's font) |
| Fonts (three bitmap fonts: map, info, label: font0.fon, font2.fon, font4.fon) | the game's own fonts, published with the screen's palette (`art/fonts`, `art.fonts`, `art.astro.palette`) and drawn as pictures of the text: the map's text (`paintMap`'s `text`, and the layout measures with them), the title, the coordinates, the angles, the speed, the Display labels and the info panel (wrapped to 223 pixels in the info font as `wrapText` does, from y 134, 18 apart, twenty lines at most). The words stay in the page; without the fonts, or with `&art=0`, the text is condensed sans as before | matches; the title is drawn in the plate's dark ink (the plate's field is blue where the original's is black), the letters the font's |
| Voices: `_astroVoices` (engage, refusals), `_astroPanelVoices` (the Display switches on and off, the hazards' warnings), the warp-panel switch sound (engine.spr's `DIGI`) | not in the raw export, so not played, and not made up | remains |
| The loading messages as the screen opens (`start`: the screen's first message at 80, 140, then its third at 73, 140, each for a frame; `_astroMessages` 0 and 2) | each for a frame as the plate comes up (in the font when it is loaded, plain text before) | matches (a flash, as the original's) |
| The pointer over an exit that is open (`mouseMove`: `setCursor(3)`, cursor.dat's frame 3, the use pointer lit; the arrow elsewhere) | `port.exitCursor()`: that picture from `art.cursors` when it is published (`use_lit`, at the use pointer's click point), else the drawn lit use pointer; the page's own over everything else | matches |
| Ours and not the original's | the drag turns the map, the wheel zooms, the journey time and progress in the engine picture's foot, the selectors in the tree | extra |

Checked by `view/astroLayout.test.ts`, `astroSelect.test.ts`, `astroGlobe.test.ts`, `astroPaint.test.ts`, `astro.test.ts`, `sim/planets.test.ts`,
`ui/ship/astrogation.test.tsx`, `view/bitmapText.test.ts`, `web/astroFontsSession.test.ts`, `web/exitCursor.test.ts`, `tools/art/src/astro.test.ts`, `enginespr.test.ts`, and
`apps/web/e2e/unity-astro-map.spec.ts`, which also shoots each view to `~/pcode/unity-raw/runs/ui-astro-map` (element only; `ASTRO_SHOTS` moves them), and
`apps/web/e2e/unity-astro-pictures.spec.ts` (the fonts, the held and lit pictures, warp 5.0 and the exits' pointer), which shoots the screen to
`~/.claude/jobs/988a7092/tmp/ship2/` (`astrogation-course-ours.png`, `-pad-held-ours.png`, `-arrow-held-ours.png` and `-exit-held-ours.png` beside ScummVM's `-scummvm.png`, taken
with the harness's `down` and `shot`; the harness's screen is 640 by 480, ours the plate's box).

## Choice menus open by the pointer

The original's turbolift, Comms and Lounge pick from `runChoice`'s dialog, which comes up where the player clicked. Ours (`ChoiceMenu` in
`engine/src/ui/ship/bridge.tsx`) opens below and to the right of the pointer (ten pixels off, so the item is still under it), in pixels
of the bridge's box, and `menuPlace` moves it back in where that would leave the box (four pixels of margin on every side). A click with no
pointer, such as a key's, opens it by the item's centre. It used to be pinned to the box's bottom right corner. Checked by
`bridge.test.tsx` (the place, the edges) and `ship.spec.ts` (at the door's top left and bottom right).

## The holodeck

The turbolift's and the transporter room's third exit (screen code 10, `kShipHolodeck`) used to fall into "unknown ship screen" and come back to the
bridge, which is why the holodeck could not be reached: the code had no station. In the original (`UnityEngine::runHolodeck`, unity.cpp:379-426)
it is open whenever the computer is at least `kHolodeckComputerPercent` (80; `computerPercent` is the best of the three computer cores, 100 in a
new game). Below that the computer says "fe090098" and the bridge comes back. Otherwise the door and projector sound, the screen is holodeck.rm,
and a choice lists the movies seen so far (`_seenMovies`, in movie.map's order, the ship's tour seen from the start), each played again on a pick,
with the BRIDGE button leaving. Ours (`holodeck` in `sim/ship.ts` `STATION_CODE`, `HolodeckPanel`): the same gate and list, drawn as the original draws it
(below), or a greybox panel without the art. `ShipState.seenMovies` is saved (a save from before has the tour only) and
filled by every movie the sim plays (an effect's `play.movie`, a warp movie by its index as `warp:<n>`, the opening movies from the session). The
list comes from presentation.yaml's `movieMap` (the lifter writes movie.map's files and descriptions there); the door, projector, pick and over
sounds and the computer's refusal are `shipSounds` cues (`SHIP_CUES`). The refusal is said to its end before the bridge comes back, as the original's
`waitForSpeech` does: the screen the ship was asked from stays up until then, and the bridge's own start (its music) follows (`World.waitForSpeech`,
which the session points at the mixer's voice queue; `gotoShipScreen`).

### The holodeck as the original draws it

`npm run art -- holodeck publish` writes `art/holodeck/holodeck.pack` (holodeck.rm, with its 128 colours under standard.pal's, and dialog.mrg's 31 entries
as indices, so MRG entry `i` is the pack's `i + 1`) and `palette.rgb`, `art.holodeck` in presentation.yaml, and the game's fonts (`art/fonts`, `art.fonts`: the
same files `art engineering publish` writes; each command writes them again, the same). The screen is `view/dialogLayout.ts` (a port of `initDialog`,
`drawDialogFrameAround` and `drawDialogWindow`: the plain frame of dialog.mrg's entries 0 to 16, fonts 2 and 3, the round scroll buttons 11 to 16, the choices
at x 100 from y 280, a line 16 high and 8 between a choice's own lines, a gap line between choices, 160 high at the most, scrolled a line at a time),
`holodeckArt.ts`, `ui/ship/holodeck.tsx` (a canvas with clear buttons over the movies, the scroll buttons and the Bridge button holodeck.rm paints, 484, 426 to
605, 468, which is `runChoice`'s cancel rectangle) and `web/holodeckSession.ts`. The picture is the original's pixels: ScummVM's screen with the ship's tour in the dialog and
ours with the same title are identical pixel for pixel, and so are the two with the pointer on the title (checked with the harness's `shot`, scripts in
`~/.claude/jobs/988a7092/tmp/ship2/holo1`; the e2e compares the part of the picture outside the dialog when the capture is there, as the opening's movies
are in our list and not in the harness's). Check after another publish that `art.holodeck` and `art.fonts` are still in presentation.yaml.

| Element of the original | Ours | Status |
|---|---|---|
| holodeck.rm: the yellow grid, the console, the painted BRIDGE button | the picture's own pixels and palette | matches |
| The choice dialog: black box, grey frame (entries 0 to 7 for the borders, 0 to 3 corners), blue text (font 2) | `layoutChoices`, `drawChoices` | matches |
| The choice under the pointer in the highlighted font (font 3) | `data-selected`; the pointer or focus | matches |
| Up and down round buttons, greyed (13, 16) when there is nothing to scroll and lit (11, 14) when there is; a click scrolls a line | `data-scroll` buttons over the drawn ones, disabled when greyed | matches |
| Click a movie: baknwlgd, the movie, holooff, the list again | the sim's cues as before (`holodeckPlay`) | matches |
| Bridge (the painted button): door sound, the bridge | `data-holodeck-bridge` over the painted one | matches |
| Door and projector sounds going in; the music stops | `holodeckDoor`, `holodeckOn` (already) | matches |
| The refusal below 80 percent: fe090098, and the bridge only when it is said | `World.waitForSpeech` | matches |
| The arrow pointer (`setCursor(0xffffffff)` in `runDialogWindow`) | the page's own pointer | remains (the cursor work is another agent's) |
| Word wrapping of a long title (`Font::wordWrapText`) | a greedy wrap by words to 313 pixels; no title in movie.map is that wide, so it is not exercised | remains (unverified) |


## The ship's audio

The ship's screens were silent: the lifter only named the sounds the away worlds use. What the original plays aboard is hard-coded in its
screens, so the lifter now writes it (`tools/lift/src/presentation.ts`: `SHIP_MUSIC`, `SHIP_SOUNDS`, each citing its line; `presentation.yaml`'s
`shipMusic` by station, `shipSounds` by name, and the loops' gain and loop point in `loops`), `unity:build` transcodes the files they name
(and each crew member's computer voice, below), and the session plays them (`Session.shipMusic`, `shipSound`, through the one mixer, so the
mute, the bus levels and the voice ducking apply):

| Where | Plays | Original |
|---|---|---|
| Bridge, transporter room | `bridgamb` loop | bridge.cpp:167, transporter.cpp:211 |
| Astrogation | `astro` loop, louder (volume 0x5f), loop point 0x1b140 | astrogation.cpp:1091 |
| Computer | `fe090081` ("online", unless at 0), then `fe090082` (100), `fe0900aa` (1-99) or `fe090098` (0); then the `compute` loop | computer.cpp:306-318 |
| Tactical, engineering | `enterpri`, `engamb` loops | tactical.cpp:287, engineering.cpp:143 |
| Holodeck | door, projector, pick and off sounds; the music stops | unity.cpp:393-424 |
| Console buttons | `beep7` (astrogation, computer and comms clicks, the map's pad, views, cursor arrows, Engage), `softbop` (scrolls, sensor arrows), `level2` (a computer row), `tactical`, `advice` (replay), `dooropen`/`doorclos` (turbolift, lounge, transporter door), `trnscnfm` (Energize) | bridge.cpp, computer.cpp, astrogation.cpp, transporter.cpp |
| Transporter pad | the computer says the crew member's name, `fe09` and their `_crewVoices` entry as four hex digits (`ship.yaml` `crew.voiceOf`) | transporter.cpp:759-763 |

The music starts when the station's screen does (the computer's once it has spoken, and not if the ship has left it meanwhile), and not
while the opening movies run: the bridge's begins when they end. A game loaded aboard goes on with its station's. The viewscreen leaves what
plays alone; beaming down replaces it with the world's piece as before. Voice lines come one after another, as the original waits for each.
Checked by `session.test.ts` (the music, the voices in order, the clicks, a load), `stations.test.ts` (the computer's cues), the lifter and
build tests, and `unity-ship-audio.spec.ts`, which reads what the mixer started through `window.__au.sounds()`.

In a battle (Plan 28) the crew's cues and the battle's effects play on the original's eight channels (`engine/src/audio`:
`channels.ts`, Sound's; `cues.ts`, the CuePlayer, cues.cpp; `effects.ts`, playEffect, weapons.cpp:154-168), the cues on the
voice bus (an effect's cue, speaker 8 and up, on the effects') and the effects on the effects' bus, quieter with the distance
from the camera and silent from 8500. The sim hands each frame at tactical on (`battleAudio`, with the battle's clock), so the
cues' delays and gaps follow the speed, and a paused battle, the warp overlay, Engineering and auto-resolve start nothing new
while what plays plays on. A file the game lacks plays nothing. Checked by `cues.test.ts`, `effects.test.ts`,
`channels.test.ts`, `battleSound.test.ts`, `session.test.ts` and `unity-combat-sound.spec.ts` (`window.__au.battleSound()`).

Not done: astrogation's own voices (`_astroVoices`, `_astroPanelVoices`, `_hazardVoices`: the region chatter, the course panel's switches and
the hazard warnings, astrogation.cpp:549, 777, 791, 1250, 1763, 1787, 1853) are not in the export (`executable.json` lacks the tables; the
lifter lists `_hazardVoices` as ignored), so they are not played; The engineering screen's two delegate voice lines are played (see "Engineering" below), and the holodeck's refusal is waited for (see "The holodeck");
the other speech waits (the hazards' warnings) are not there, with their voices. The transporter map's scan sound and two voice lines are played (see below).

## The transporter room's own pictures

With the plate on, the room's console draws what the original's `TransporterScreen::draw` does (transporter.cpp:802-853), from `transp.mrg`:
the Lists and Map buttons, the round up/down arrow beside the lists and the round left/right arrow in the kit tray (each grey where its list has
no more, as the original greys it at the ends), the kit's eight slots (x 71, 125, 179, 233, 357, 411, 465, 519 at y 424), and the item icons:
in the kit's slots, and in the preview box [208, 293, 53, 53] for the equipment pointed at (the original shows the selected row's, for the list
last chosen from; ours transfers a row on a click, so it is the row under the pointer or focus). `npm run art -- transporter publish` lifts
the sprites (`tools/art/src/transporter.ts`, entries 0, 2, 3, 5, 6, 8, 9, 11, 13-17, coloured as the screen is: transp.rm's 128 colours under
standard.pal, 4x nearest-neighbour, lossless WebP in `games/unity/art/transporter`, with `art.transporter` in presentation.yaml; both are
git-ignored), as `art astro publish` does for the course panel; the icons are the repainted ones the HUD's kit already uses (`art.icons`). The
buttons stay the clear controls over the pictures (`PaintedButton`'s `sprite`); without the pictures, with `&art=0` or with no plate, they are the
CSS ones as before and the kit shows names. Checked by `transporter.test.tsx`, `faces.test.ts`, `session.test.ts`, `transporter.test.ts` (the
publisher) and `unity-transporter-art.spec.ts`, which also shoots the room.

The pairs in `transp.mrg` are 14/15 (the crew figure: Lists, off and lit) and 16/17 (the planet: Map, off and lit): the baked-in background has
14 and 16 exactly at the buttons' places and the sizes pair them (42 by 58, and 42 by 56). ScummVM's constants for them
(`kSpriteListsButton` 14, `kSpriteMapButton` 15, `kSpriteMapButtonOn` 16, `kSpriteListsButtonOn` 17, transporter.cpp:72-76) name 15 and 17 the other
way round, so its Lists button is drawn with the planet lit and its Map button with the crew figure lit at the default (and the swapped pair when
the map is shown): worth fixing there, since the engine is the reference. Not done: the sliders' knob (entry 12, a trail the original never
erases), and portraits in the crew list (the original's crew list is text; the pad figures are the crew's cards).

## Engineering

The turbolift's and astrogation's Engineering exits used to land on "this screen is not built yet". The screen is now the original's own
(`EngineeringScreen`, engineering.cpp), drawn the way the original draws it: from the game's pictures and fonts, as palette indices through the
original's palette, with its palette rotations. Nothing is repainted.

Where the pieces are: `engine/src/view/indexed.ts` (an indexed 640x480 screen, sprites that skip colour 13, rectangles, bitmap fonts, the palette's
rotations and single-entry edits), `engineeringLayout.ts` (a port of `draw`, `drawSlider`, `drawInfo`, `drawTotalPower`, `updateColours`, the tabs'
and buttons' rectangles, `sliderAt`), `engineeringArt.ts` (loads what the publisher wrote), `ui/ship/engineering.tsx` (the canvas, with clear controls
over the tabs, buttons and sliders), `web/engineeringSession.ts` (the ship port's half), and `sim/shipSystems.ts` (the ship's systems).

`npm run art -- engineering publish` writes, into the git-ignored `games/unity/art` and `presentation.yaml`:

- `art/engineering/engineering.pack`: the background (eng00a.pic, with all 256 of its own colours) and eng01b.mrg's 41 entries (entry `i` is the pack's
  `i + 1`), as indices, and `palette.rgb`. The English eng00a.pic is the loose file beside STTNG.ZIP, which the engine finds first; the zip's own is the
  German one (it reads MASCHINENRAUM and Gesamtenergie), so the publisher prefers the loose file.
- `art.engineering.tables` (from STTNG.OVL in STTNGINS.ZIP, as the astrogation tables are): the 70 sliders' places and flags, the 59 labels with their
  words, the 38 row frames, the shields' order, and the colour each of the 35 units has on the schematics.
- `art/fonts/font0.fon` ... `font9.fon` as they are, and `art.fonts`: the engineering screen draws in fonts 0 and 2, and the astrogation text will use the same.

Check after another publish that `art.engineering` and `art.fonts` are still in presentation.yaml (`art engineering publish` writes only those two keys).
Without them, or with `&art=0`, the screen is a plain list: a power slider for each unit of a page (a torpedo launcher's loads, a reactor's output), a repair
slider while a unit is damaged, the pages as buttons, and the same Delegate, Bridge and Tactical.

The ship's systems were only the lifted starting levels, read and never changed. Now `ShipState.systems` holds each unit's live level, target, damage and
repair, the power pool (2400 to start) and the torpedoes in store (275), saved with the game (a save from before has them new), and `tickSystems` is
`ShipSystems::tick`: the reactors fill the grid twice a second, systems charge from the pool five at a time and give power back as they are turned down,
repairs cost a point of power a second, a damaged system is offline, a torpedo costs 25 to load and returns 20. It runs from the bridge, astrogation, the
computer and engineering, as the original's updates call it. What reads the ship's state follows it: `maxWarp`, the sensors' charting, the computer's
level (which entries it shows, and the holodeck's 80 percent gate). The mission scripts' "repair everything" resets it. The model is ScummVM's `ShipSystems`
(which reconstructs the original's; its constants are quoted in `shipSystems.ts`), not a second guess.

| Element of the original | Ours | Status |
|---|---|---|
| Background eng00a.pic: the title bar, frames, the info box and button wells | the picture's own pixels and palette | matches (checked pixel for pixel against ScummVM's capture: only the Total Power bars differ, by the time the pool has had) |
| Five page tabs, the open one lit | `tabRect` rectangles, the same pictures; a click beeps (beep7) | matches |
| The ship drawn twice on each page, a unit's part green when working, red when damaged, blinking grey under the pointer | the schematics' own palette entries (`paletteIndex` from the executable), `updateColours` | matches |
| Repair and power bars: lit to the level, a band to the target, 20 segments of 6 | `drawSlider` as it is | matches |
| Torpedo cells and the box round the one to load to; the reactors' efficiency strip | as it is | matches |
| Labels and the rows' frames, per page | `art.engineering.tables`, font 2 | matches |
| The power bars' and reactors' shimmer (palette rotations 0x77-0x7f, 0x72-0x68, 0x48-0x52 every 0x12 ticks) | `Palette.rotate`, `COLOUR_MS` | matches |
| Total Power: three bars (what is wanted, what is spare, what is used), their figures | `totalPower`, `drawTotalPower` | matches |
| Info box for the unit pointed at: name, capacity, level, charge and discharge times, or minutes to repair | `unitInfo`, font 0 | matches |
| Pointer on a slider, drag along it (the box starts 7 left of the bar, 130 wide) | `SliderBox`: pointer down and drag; the arrow keys, Home and End step it | matches (the keys are extra) |
| Weapons page: the torpedoes in store beside "Total" | drawn | matches |
| Power page: the two reactor pictures | drawn | matches |
| Delegate: the button and its lamp, pressed picture for 0x24 ticks, then it toggles; on, Picard says fe00029d ("Mr La Forge, take over") and La Forge answers fe0602c7 when he has finished | `usePress`; the two lines through the ship's mixer in order (`delegateTakeOver`, `delegateAye`); on at the easier levels | matches |
| Bridge and Tactical: pressed picture, 0x91 ticks, then the screen changes; a beep | as it is (Tactical goes by the ship screen code, without the bridge's alert sound) | matches |
| The ship's systems the screen shows and sets (ShipSystems::tick) | `sim/shipSystems.ts` | matches ScummVM's reconstruction |
| engamb loop | `shipMusic.engineering` (already) | matches |
| The sliders as named controls for a screen reader and the keyboard | `role=slider` boxes over the pictures, the total power and the unit's lines as hidden text | extra |
| Delegate doing anything beyond the toggle and the voices | ScummVM's engineering does nothing more (La Forge managing power is not in its model), so nor do we | remains (nothing to port) |
| Damage from hazards (black holes, vortices) and battle | the sim can damage and repair (`setDamage`); nothing calls it yet: the hazards need astrogation's encounters (`planEncounters`) and `_hazardVoices`, which the export lacks, and combat is the placeholder | remains |
| The arrow pointer on this screen (`setCursor(0xffffffff)` is the default) | the page's own pointer | remains (the cursor work is another agent's) |

Checked by `view/indexed.test.ts`, `engineeringLayout.test.ts`, `engineeringArt.test.ts`, `web/engineeringSession.test.ts`, `ui/ship/engineering.test.tsx`,
`sim/shipSystems.test.ts`, `tools/art/src/engineering.test.ts`, and `apps/web/e2e/unity-engineering.spec.ts`, which also shoots the screen to
`~/.claude/jobs/988a7092/tmp/ship2/` (`engineering-power-ours.png`, `-weapons-ours.png` and `-hover-ours.png` beside ScummVM's `-scummvm.png`, taken with the harness's own `shot`).

## The transporter map

`TransporterScreen::start` ends with `showMap(true)`: the room opens on the map, not the lists, and the console scans for the target
(`showMap`, `updateLock`, transporter.cpp:243-300). So does ours: `view/transporterMap.ts` is the scan (a step every 0x14 of 291 ticks a second,
68.7 ms: the row line two pixels down a step from row 297 to the target's row, then the column line three pixels across from column 51 to the target's,
then the blip), `web/transporterDirector.ts` holds each visit's state and sets the room's `hold`, which `canEnergize` reads (the original's
`_showMap && _lockStage != 2`): Energize waits for the lock, Lists puts the map away and frees it, Map starts the scan again.

`npm run art -- transporter publish` also lifts `tmaps.spr` (nine pictures, 368x120, one per world, anim n is world n's), `beamhori.spr`, `beamvert.spr`
and `tranblip.spr`'s looping animation (ten frames, 100 ms), decoded from the game zip with the sprites' own palette if they carry one (they do not:
transp.rm's, as the screen draws), index 13 clear, 4x nearest-neighbour, lossless WebP in `games/unity/art/transporter`, with `blipMs` and the
sprites `map_world_N`, `scan_across`, `scan_down`, `blip_N` in `art.transporter` (git-ignored). The sounds `transporterScan` (`scann`),
`transporterNoTarget` (`fe0900b0`) and `transporterLocked` (`fe0900b3`) are in the lifter's `SHIP_SOUNDS` (`shipSounds`).
The dev handle `window.__au.beam(n)` is ScummVM's `beam <world>` (a mission's world number) for looking at it.

| Element of the original | Ours | Status |
|---|---|---|
| Room opens on the map, lists put away, Lists button the crew figure unlit, Map button the planet lit | the same; the pairs are the corrected 14/15 and 16/17 (ScummVM draws the planet in the Lists slot: its constants are swapped, as noted above) | matches (ScummVM's own pictures swap) |
| tmaps.spr picture of the target's world (0 with no target: "NO BEAMDOWN LOCATIONS"), at (50, 294) | `map_world_N` over the lists' places | matches |
| scann.mac as the scan starts, and again each time Map is pressed | `transporterScan` | matches |
| Row line (beamhori) from row 297, two rows a step, to the target's row | `advanceLock`, `lockRects` | matches (checked by tests and the element shots below) |
| Column line (beamvert) from column 51, three a step, to the target's column | the same | matches |
| Blip (tranblip anim 1) at the target, looping; computer says fe0900b3 on locking | `blip_N` at 100 ms; `transporterLocked` | matches |
| No target: fe0900b0, the row line goes round to the first target's row and never locks | `transporterNoTarget`, the wrap in `advanceLock` | matches |
| Energize only when locked on (or the lists up) | `room.hold` | matches |
| The lists' round arrow and the preview box drawn only with the lists up | not rendered with the map up | matches |
| Lists/Map buttons, no click sound | none | matches |
| Map with the art off | a dark panel with a blue edge, CSS lines and a ring, and the words | extra (the fallback) |
| The map's picture for world 8 (beam world 8, the team of world 5) | `map_world_8` and target 8 | matches |

Checked by `view/transporterMap.test.ts`, `web/transporterDirector.test.ts`, `ui/ship/transporter.test.tsx`, `ui/faces.test.ts`, `session.test.ts`,
`tools/art/src/transporter.test.ts` and `apps/web/e2e/unity-transporter-map.spec.ts`, which shoots the room to
`~/.claude/jobs/988a7092/tmp/transp/` (`map-scanning-ours.png`, `-crossing-`, `-locked-`, `-lists-`, `-none-` beside ScummVM's `-scummvm.png`, taken with the harness's own `shot`).

## The crew on the pads

In the original a crew member chosen walks in through the door at the left of the room and stands on their pad, and one dismissed walks back out
(`TransporterScreen::walk` and `updateWalkers`, transporter.cpp:314-410). So do ours, drawn with the same crew cards the pads already use
(`art.cards`, the standing animation 0x18) and their walking animations (the direction of each leg: 0, 3 and 9, lifted and repainted like the rest).

- `walkOn` and `walkOff` (the executable's `_transporterWalkOn`, `_transporterWalkOff`) are lifted into `ship.yaml`'s `transporter`; `view/transporterWalk.ts`
  is `walk` (the path: the six waypoints in, the middle of the way to the pad filled in, the side the pad is on deciding the last legs' direction) and
  `updateWalkers` (160 pixels a second at the size they are drawn at, the size changing along each leg, a frame never counting more than 100 ms).
- `web/transporterDirector.ts` starts a walker for each new face on a pad (the team the room opens with, and Recommended's, one after another 20/15 of
  a second apart; a crew member chosen by hand at once), holds the room's `hold` while anyone walks (the original's `canEnergize` needs
  `_walkers.empty()`), and for a dismissal keeps them on the pad until they reach the door and only then puts them back in the crew list
  (`removeFromPad`). A pad someone is walking on or off cannot be clicked (`isWalking`). The door's sounds are the original's: `dooropen` as the first
  walker is sent, `doorclos` once nobody is left of x 198.
- `ShipPlate.moveCards` puts a card where its walker is, at its size, sorted by its row, hidden until it sets off; `setOccluder` draws the doorway's wall
  (tdoor.spr, 70x176 at (0, 112), which is the background's own pixels) over the cards, so they come out from behind it. The beam's sparkle and
  dissolve follow the card (`ShipPlate.beam` reads where it is), so Energize still plays them on the figures.

| Element of the original | Ours | Status |
|---|---|---|
| Chosen: the computer says their name, they walk in from (38, 289) by (290, 277), (326, 248), (326, 243) and the middle of the way to the pad, and stand | the card walks the path from the executable | matches (shots below: the same order, places and stagger as ScummVM's) |
| Speed 160 px/s scaled by their size, the size interpolated along each leg, never more than 100 ms counted | `stepWalker` | matches |
| The leg's direction animation (0, 3 or 9), then standing (0x18) | the cards' strips for those animations | matches |
| The recommended team set off 20/15 s apart; a crew member chosen by hand at once | `delay` | matches |
| Dismissed: walks pad, (326, 248), (290, 277), (38, 289) and is then back in the list | the same; they stay on the pad until they have gone | matches |
| The doorway's wall (tdoor.spr) over the walkers | `setOccluder` with the plate's own pixels | matches |
| Energize and the pads' clicks wait for the walkers | `hold`, disabled pad buttons | matches |
| dooropen / doorclos sounds | `doorOpen` / `doorClose` | matches |
| The door's own opening animation (trnsdoor.spr, 11 frames of 34 ms; the game also waits for it) | not drawn: the repainted plate's door stays shut, and the game does not wait for it | remains (it needs a repainted animated layer for the door; the sounds play) |
| A crew member with no card published | on the pad at once, and dismissed at once | extra |
| Art off, or a ship.yaml from before | no walk: on the pad at once | extra |

Checked by `view/transporterWalk.test.ts`, `web/transporterDirector.test.ts`, `view/shipPlate.test.ts`, `session.test.ts` and
`apps/web/e2e/unity-transporter-walk.spec.ts`, which shoots the room every 0.6 s to `~/.claude/jobs/988a7092/tmp/transp/` (`walk-NN-ours.png` beside
ScummVM's `walk-NN-scummvm.png` from the harness; `walk-compare.png` is the two side by side).
