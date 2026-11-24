# A Final Unity on this machine

The game's data is Paramount's. Nothing generated from it is committed: the lifted content, the
transcoded audio, the greybox rooms and every ScummVM run stay local. CI (`npm run ci`) runs only the
synthetic fixtures; everything below runs here, and each check skips unless its variable is set.

## What you need

- The game's CD data at `~/pcode/unity-gamedata/cd`.
- The private ScummVM worktree `~/pcode/scummvm-export` (branch `unity-export`), built with the harness
  hooks on: `sh tools/scummvm-harness/toggle.sh on`, then `make -j8` there. Runs are muted
  (`tools/scummvm-harness/harness.ini` has `mute=true`).
- Plan 3's exports under `~/pcode/unity-raw/runs`:
  ```sh
  sh tools/rawcheck/run-harness.sh export 300     # runs/export/raw: the raw IR, with computer.db (the tricorder's readings)
  sh tools/rawcheck/run-harness.sh audio 3600     # runs/audio/media: every sound as WAV
  sh tools/rawcheck/run-harness.sh images 3600    # runs/images/media: backgrounds and sprites, every world
  sh tools/rawcheck/run-harness.sh movies 1800    # runs/movies/media: every movie the away missions name
  ```
  After Plan 18, an older `runs/export/raw` must be re-exported (`sh tools/rawcheck/run-harness.sh export 300`): the strict ExecutableFile schema now requires the combat tables and each unit's efficiency and hitWeight.
  After Plan 22, re-export again: `trig.json` holds ScummVM's sinf and cosf of every angle, which the combat sim reads (without it the lift warns, and the sim uses the browser's own, which differ from ScummVM's on some angles).
  After Plan 23, re-export again: `combat.json` holds kBearing, kShieldNames and the cue ids (`kCueIds`), which `combat.yaml` must have (the content schema refuses one without them).
  After Plan 25, rebuild the export (its trace's snapshots carry the camera) and fight the parity suite again (docs/tracediff.md, "Parity runs"): `tracediff combat` calls a trace from before a problem, as it has no camera to compare.
  After Plan 24, re-export again, and the images too (`sh tools/rawcheck/run-harness.sh images 3600`): the raw export's `verbatim/` holds tactical's still pictures (`spc00a.pic`, `space.mrg`, `cheap.pic`), and the images export colours the warp overlay's sprites in `cheap.pic`'s palette. Without them the space build says what to re-export and exits 1.
  After Plan 27, re-export again: `combat.json` holds the console's own words (`kConsoleText`), which the tactical console draws (without them the lift warns, and the console draws without them).
- ffmpeg (`brew install ffmpeg`). Homebrew's build has no libvorbis, so music and ambience are stereo
  Opus in `.ogg` files. Without ffmpeg, `unity:build` says so, skips the audio transcode, still builds
  the greybox rooms, and exits 1 at the end.

## Build the away missions

```sh
export RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw
npm run unity:build
```

This lifts worlds 2-7 into `games/unity`, transcodes the audio it names (`AUDIO_DIR`, default
`.../runs/audio/media`; without it the game plays silent) and the movies (`MOVIES_DIR`, the `runs/movies/media` directory), and builds the
greybox rooms (`IMAGES_DIR` adds the reference backgrounds and sprite sizes). It is safe to run again:
nothing up to date is redone, and `git status` stays clean. `game.yaml` starts in Horst III, and the bridge's mission select
starts any of the six missions; `readings.yaml` holds the tricorder's readings (from `computer.db`).

## Play the ship

A new game starts on the ship's bridge (`/?game=unity`). The opening movies play first (the teaser and the title; each has Skip, and a
stem with no film is left out). A load, a restart and a `?dev` start play none, and a load or restart while they play ends them. Then
the bridge: the first conversation menus are the opening scene, and the hails come on the bridge's viewscreen. The ship's own
steps are the same whatever the route: Astrogation plots a sector, star and planet by name, Engage runs the journey on the sim clock
(`&speed=60` shortens it), the Transporter room picks the team (Recommended, or by hand) and Energize beams it down. When the team is
back aboard the ship is on the bridge again.

How the ship plays:

- **Story warps run by themselves.** Once a conversation or a trigger has set a course, astrogation engages it on the next tick, with
  its warp movie. The first mission's course (sector 156, star 3, planet 3) is the only one the player plots on the way to world 4;
  after that the story sets most courses. A hail that comes mid-journey or on arrival goes to the viewscreen. The Comms and Lounge
  buttons are off while the viewscreen is up: toggle the viewscreen off first.
- **Playing the whole route** (worlds 4, 3, 5, 5 again as 8, 7, 2 and 6, in that order). Every pick is an index; `whole-game.walk` and
  `games/unity/tests/route/*.walk` are the exact steps, with ids only. In outline:
  - at the opening, take the first option at c008@3 k13 (it sets `ship.scout_escape_type`, which brings the next course), put the first
    mission's hail (c007@3) on the viewscreen, plot sector 156, star 3, planet 3, and beam down. After that the story sets most courses;
  - after each mission the ship's hails set the next course (the hub, c022, and the lounge, c027, carry the choices), and the Comms
    hails beam the team down (t53/t54 for world 3, t88 for world 5, the second visit's battle 51 and t116 for world 8);
  - the world 7, 2 and 6 warps are ship conversations' own (c032 for world 2, c006 for world 6). Each away leg is the same walk as its
    dev-start walk (`games/unity/tests/*.walk`), with one extra question at world 2's small drone.

  World 2's way back from s0f is the transporter: from s0d the panel o_020d02 opens the terminal on s11, its bar gauge o_021102 starts
  a countdown, o_02110a leaves to s0d and the action square o_020d0a is the pad, which takes the whole team to s08. (A bare energize,
  o_021100, beams the others to s14 and leaves the acting member on s11, as c009@8 says: it is not the way.)

  `whole-game.walk` is exactly this route, with every pick by index (below).
- **Combat is the combat sim for everyone; the M4 dialog is `?dev&combat=dialog`.** Tactical (Plan 23; Plan 31 switched it on for players) fights the battle in the
  combat sim, drawn in 3D under the console (Plan 27: the original's console from its own pictures and the game's fonts, in a 640 x 480 box,
  the space view in its Split rectangle; Full fills the game frame with the view and a slim HUD, its console a drawer; a screen under 560 px
  high opens wide; Plan 25: the space view; Plan 26: its beams, torpedoes, shields, explosions and debris, the bloom, the red flash and the
  warp overlay; Plan 29: the original's keys with W and S, Q and E, Space to fire both, P to pause and `.` for the speed, F6 into the
  console's controls, a drag on the view to steer, a click or a tap on a ship to target it, the wheel to zoom, a standard pad, and the
  assists panel by Escape or the HUD's Assists: the difficulty, the speed, pause and a confirmed auto-resolve
  with its result; Plan 32: F1 the original's Combat Options screen, final.spr, over the paused battle: stars, resolution, radar, detail
  and the sixteen keys, the same settings as the admin console's SETTINGS page, the Enterprise drawn in its preview), with the debug view folded over its corner (Dev tools): the console's orders as buttons, pause, 1-8x, auto-resolve (Delegate
  to the end, then its result and the Enterprise's log; Continue ends it), and the combat difficulty (as the game, a level apart,
  or Story, whose note says it is the only assist that changes a battle's numbers), kept in `localStorage` with the difficulty.
  Win, Flee and Lose stay beside it as a test shortcut. No save during a battle ("You can't save during combat."). Headless,
  the walks fight in the combat sim too; the route fights battle 51 by Delegate and flies 71 (Delegate loses it) and 52
  (Delegate wins it but leaves the reactors and the grid destroyed) by hand, from `games/unity/tests/battles/<n>.inputs`
  (Plan 31). `?dev&combat=dialog` (a dev page only: a deploy build ignores it) brings back the M4 dialog; `devGate` is its one line.
  The dialog: a battle hail names its scenario, and the tactical panel offers three buttons. Win destroys the enemies one
  at a time (each kill list runs once) and returns to the bridge by the battle's Exit object. Flee runs its Warp object, or Exit if
  it has none. Lose destroys the Enterprise and ends the game. A hook's hail can wait in the panel as an Answer button. The
  mandatory battles are scenarios 52 and 71, both won on the route by hand (`combat inputs`: 71 its one enemy destroyed; 52 the ship its kill list waits on destroyed, which stands the battle down, its two probes left); 51 is optional, and
  the route fights it by Delegate, then gives engineering's repairs (`repair all`). 16, 70 and 83 are
  not on the route: 16's hails (c020@0 k6, c018, c023, c024, c035) are never raised because c008@3 k13 lets the scout go and the route
  never takes c020@0's confrontation line; 70's hail is c016@11 k4, through t170 (ship.taa), which c016@8 k4 enables when the relay
  station was lost; and 83 needs the team to stay at world 2. (t03 leaves `battleScenario` 16 set, so the bridge's Tactical button
  starts battle 16 until something stands down: faithful, bridge.cpp:428-431.) Battles 2, 3, 4, 6 and 7 are not reachable by any hail: their
  Enterprise object is inactive or missing, so a Lose there is the original's warning and a return to the bridge (combat.cpp:202-213).
- **Difficulty** is a setting, 0 to 2, default 1 (Ensign, Lieutenant, Captain on the admin console's DIFFICULTY button): `?difficulty=<n>`,
  or the console's button, kept in the settings record (below). It can only change while no team is away (the button is disabled away). Below 2 the transporter starts with the
  recommended team chosen, and at 0 it energizes by itself. Combat ignores it (nothing is flown).
- **Computer, Replay, Comms and Lounge.** The computer lists its entries by the ship's computer level (a tricorder reading appears
  there once recorded); Replay on the bridge shows the last ten conversations in the transcript box.
- **Saves and checkpoints.** The admin console's SAVE saves only when nothing is happening, aboard or away; the SETTINGS page's IMPORT takes a save file. Saves are
  version 4: a version 3 save loads with its queued ship effects applied once, in order, and one made in the transporter reopens it.
  The walk's `checkpoint <name>` writes a save in the Import format (to `CHECKPOINT_DIR`, or the runner's `checkpointDir`).
- **Dev starts.**
  - `?dev&missions` is the old mission select (any of the six missions, straight to its beam-down).
  - `?dev&ship=horst3` is a new game with the trigger a Frigis visit would have enabled (`t117`), so plotting sector 293, star 3,
    planet 2 and the transporter reach Horst III. A restart keeps it, and the opening movies don't play.

Headless, the walk verbs are:

| Verb | What it does |
|---|---|
| `start ship` | a new game on the bridge |
| `station <name>`, `talk`, `pick <n>`, `advance <ticks>` | go to a station; the crew's talk; a conversation pick; run the sim |
| `plot <sector> <star> [<planet>]`, `engage warp\|impulse <n>` | astrogation |
| `beam [<crew>...]` | the transporter: the recommended team, or these crew |
| `computer <row>` | a click on a row of the open computer screen |
| `comms <object>`, `lounge <object>` | a pick from the bridge's list (no object: asserts it is empty) |
| `combat win\|flee\|lose\|answer` | the combat dialog's outcome (with the combat sim, a test shortcut), or answering a waiting hail |
| `combat wait` | runs the game until a battle is on (the combat sim fights from its first frame) |
| `combat auto [expect <outcome>]` | auto-resolves the battle: Delegate on, to its end, then gone on from; logs how it came out and its step. Fails if still fighting at 9000 steps, or if it doesn't stand down (`stoodDown`) unless the walk expects `left`, `ended` or `lost` |
| `combat <input>`, `combat at <step> <input>` | an order for the battle in Plan 22's input lines (`docs/trace-format.md`), taken as written (no doubled spaces or tabs), now or after exactly that many steps (at any speed), so it first shows in the next step |
| `combat inputs <file>` | an inputs file's orders (Plan 22's `at <step> <input>` lines, a path from the game's directory), each given as `combat at` gives it; a bad line fails the walk, naming the file and line |
| `repair all` | at engineering: every damaged unit's repairs, and every unit's power a hit took, given in full |
| `assists <difficulty> [<speed>]` | the combat assists: `game`, `ensign`, `lieutenant`, `captain` or `story`, and 1, 2, 4 or 8 |
| `difficulty <0-2>` | the setting (aboard only, once playing) |
| `include <file>` | another walk's steps, from the screen it starts on |
| `checkpoint <name>` | writes a save in the Import format |
| `trigger <id> on\|off` | a dev shortcut for a gap in the route; allowed only after a `# gap:` comment |

- `games/unity/tests/ship-opening.walk` is the short route (a new game to world 4's beam-down; no ScummVM diff: Plan 13).
- `games/unity/tests/whole-game.walk` includes `tests/route/01-mertens.walk` to `07-unity.walk`: a new game through all seven
  beam-downs to world 6's first screen. `RAW_DIR=... npx vitest run tools/play/src/live-route.test.ts` plays it (about
  40 s), checks the teams and the mandatory battles, and writes the six returns' checkpoints to
  `~/pcode/unity-raw/runs/plan12-route/` (the browser check imports two of them).
- **The route has two ruled gaps, and no trigger gap.** No step enables a trigger by hand (`ROUTE_GAPS` in `live-route.test.ts` is
  empty). Play refuses a use, get or talk on an inactive target, since no player could click it; a step after a `# gap:` comment opts
  out, and `ROUTE_OBJECT_GAPS` lists those: o_030327 (zoo; inactive and named by nothing, but c006's lines 0/30-37 are written only by
  it) and o_020f19 (world 2's pedestal chart, activated for 5 s only by o_020f10's chain at chod_have_been_here state 1, where the route
  takes state 2). The census found that zoo t52 has no enabler, but the zoo's real entry is t48 then its first hail; t6 isn't on the
  route either, since world 6's beam is c006's.
- `npm run tracediff -- route --game games/unity --missions` lists each mission's chain of triggers, hails and talk strings.
- `apps/web/e2e/unity-ship.spec.ts` plays a new game to world 4's beam-down through the UI, imports `after-mertens` and plays the ship to
  world 3's beam-down, and imports `after-frigis2` and plays to world 7's (about 50 s each; it skips without the lifted game or the checkpoints). The browser gameplay specs open the game with `&art=0` (`GAMEPLAY_ART` in `apps/web/e2e/helpers.ts`): under SwiftShader the plates' texture fetches roughly double the time to the opening's menus, and art never touches the sim. Only the art specs (`unity-art`, `unity-art-ship`) check art.

Worth checking against the original game (Plan 13):

1. World 2's pedestal chart (o_020f19): find the c008 picks that give chod_have_been_here state 1, so the route can scan it in its
   5 s window and drop the gap. The route's way back (the s11 terminal's countdown and the s0d pad) is the sim's reading of the data.
2. At world 2 the small drone's question appears on the route (the dev-start walk never meets it, as its team and timing differ);
   the route answers the first option.
3. ScummVM's runner reads `# gap:` before a use, get or talk as a plain comment, so the same walks run there.

## Play the away missions

The away missions play from the ship's transporter, or straight into a room with `/?game=unity&dev&start=<room>`. What the screen does,
briefly:

- **The admin console (Plan 32).** The original's RGCD PADD (`adminConsole.tsx`) is the home of every setting and of the saves, in place of
  the old save menu. It opens from the bridge's Admin button, the away panel's admin button, the plain bar's Admin button, and Esc (away,
  on the bridge, or on the game-over screen, when nothing else takes it); while it is open the game clock stops and the loops pause. It
  does not open while a line is being said (Esc skips the line instead), while a dialog is up or while input is blocked, except on the
  game-over screen. Its controls are the original's:
  LOAD and SAVE (9 named slots; LOAD also has a load-only AUTOSAVE row), NEW and QUIT (each with YES and NO), SOUND LEVELS (two 27-segment
  bars), TEXT ON/OFF, DIFFICULTY (disabled away) and RESUME. SETTINGS (`settingsPage.tsx`) has three tabs:
  - GAME: master volume, art, hotspot labels, movies, IMPORT, EXPORT and LOG.
  - COMBAT: stars, resolution 1x or 2x, radar, detail, battle difficulty and battle speed.
  - KEYS: the original's 16 keys plus fire both, pause and speed, each rebindable. A key already used is refused, and so are the view keys
    1-9 and 0; F1, Esc, F5, F6 and F12 are fixed.

  Tactical's **F1** opens the original's Combat Options screen (`combatOptions.tsx`, final.spr): the live COMBAT values (the same settings),
  the rebinding and a preview; the battle pauses. **L** toggles the log aboard; away, L is Look and **Shift+L** toggles the log.
- **Settings record.** Every setting is one `au.settings` record in `localStorage` (`engine/src/web/settings.ts`, below, `docs/web.md`).
  The mix: the loops play at volume/255 (ScummVM's balance), every bus at 1, the master defaults to 0.5. The URL overrides `?mute`, `?art`
  and `?difficulty` apply for the load and are never written back. `?res` is a device parameter (`half` or `full` plates for this device,
  `apps/web/src/device.ts`), not a setting: the record never holds it.
- **Loading and saves.** The loading screen takes a saved game: once the load has finished, a saved game can be loaded from it (9b854c4).
- **Walking.** Hold **Shift** to hurry: the away team's walks go 2.5 times as fast (a512634).
- **Flat close-ups.** A flat close-up room (a console, a screen: 22 rooms) now lays the camera over the original's 640x480 picture, so a
  hotspot spans the rectangle it is drawn in and its exit is no longer under the HUD (b3b5d14).
- **Hotspot labels.** **H** (or the Hotspots setting in the admin console's SETTINGS page) shows the names and outlines over the clickable areas, on away
  screens as on the ship's (17435e1). An away room's names stay off the ship's screens (8f3ab21).
- **The away panel is the original's.** With the published panel (`art panel publish`, below) the bar draws the original's
  panel and verbs, its black box, the combadge, the kit slots and the power bar over the rectangles the game gives them (261c306).
  The panel's admin button (and Esc) opens the admin console; a click on the black box moves to the next crew member; the scroll
  buttons page the slots; the power bar sets the phaser. `?panel=0`, or art off, brings back the HUD's own bar. The phaser meter fills
  to its setting (squares past it are dimmed: positions 0 to 3 are off, 4 to 7 low, 8 to 11 medium, 12 to 15 high), and while the
  pointer is over it the status line says Low, Medium or High phaser setting, or Phaser off (0641655).
- **The pointer** over a room is the original's own eye, hand, balloon or boot (`cursor.dat`, `art cursors publish`: 37 by 23 pixels, drawn at twice
  that, clicking at `setCursor`'s points: 18,11 / 33,11 / 4,4 / 33,22). It lights as the original's does (`updateAwayTeamCursor`): the lit frame over
  an object, whatever the verb (a transition or action square is not a thing to point at), and in Walk over floor to walk on; plain elsewhere, and
  when the pointer leaves the room for the panel. `#game` carries `data-lit` while it is lit. Without `art.cursors` the pointers are the panel's own
  button sprites (the selected ones are the lit frames); with art off, or before the pictures load, the drawn ring, thicker when lit.
  The exit arrows (frames 8 to 11, published as `exit_*`) are not drawn: they need each object's `cursor_id`, which the lift leaves out.
- **Hotspots are the original's rectangles.** A click is tested as `objectAt` does (`unity.cpp:225-258`): the pointer's pixel of the 640 by 480 screen
  against each active object's rectangle (the lift's `rect`: a sprite's first frame, or the object's own width and height), front first by the
  object's draw depth (`y_adjust`, else `y`: the lift's `order`), a later object winning a tie. Before, the room's 3D boxes were ray-cast, and a
  box stands on its object's ground point, which a row above the picture's horizon has none of: Mertens' shelf pickups in `lab.s07` (flux router
  and plasma shunt, rows 205 to 223) and the damaged conduit on the far wall of `lab.s06` could not be picked, and the conduit was also checked
  behind the power conduits it overlaps (their `y` is 175, its `y_adjust` 176). A rectangle follows its object when a script moves it. What still
  differs: the original also tests the sprite's current frame pixel by pixel (a transparent pixel passes the click on); ours is the first frame's
  whole rectangle. An alter that changes `y_adjust` is not followed. A hotspot without a rectangle (a hand-made test room) is still ray-cast.
  `unity-hotspots-mertens.spec.ts` picks up each of the six shelf items and looks at the conduit through real clicks.
- **The tricorder** (Look at it in the kit, or a script's reading) is shown on the original's tricorder, drawn where it draws it (115 of 640 across,
  the screen's height): `tricord.spr`'s frame and `tricord.mrg`'s buttons (`art tricorder publish`), the reading's text on its black screen at
  121,97 (223 by 191), the four number boxes (page and last page, reading and last reading, from 0), the page buttons greyed as the original draws
  them with one page, and Previous, Next and Close over the arrow and RESUME rectangles, greyed when they can't be pressed and lit under the
  pointer. Not drawn: the original's second mode (the conversations log). Without `art.tricorder`, or with art off, it is the plain dialog.
  (`unity-tricorder-frame.spec.ts`.)
- **Portraits and icons.** The bar shows the selected crew member's portrait and the kit's icons, and a subtitle shows its speaker's
  portrait beside the line; a speaker with no portrait gets the combadge (f681774). With art off they show text only. The subtitle box
  takes the width its line needs, up to 76% of the frame, centred; aboard, over a ship plate's strip, it still fills the strip (f18c198).
- **Screen texts.** A script line starting with `^` shows text from the screen's `t_WWSS00.bst` on the screen itself, in its original box,
  with no dialog and no wait. The lift writes it to `games/unity/screentexts.yaml` (git-ignored, like the rest of the lift's output;
  re-run `npm run unity:build` to get it). A screen without the record shows nothing, as in the original. Before, the browser put up a
  placeholder "Screen text N" menu with one Close button (9262415).
- **The ship's painted controls.** The ship's screens show their plate's own buttons (4d532b1 to d0bbb6b, e5028cf, 74c530d): the
  bridge strip's sensor arrows and rows, the transporter's lists, map, round arrows and door, astrogation's exit block, tabs, pad, views
  and cursor arrows, and the computer's exits, topic grid, text pane and scroll arrows. A button the port can't do yet says "not
  available yet" (21 of them). `docs/unity-ship-buttons.md` has the audit.
- **No room art aboard.** On the ship the session loads no plate for the room under the panels (the new game's start room, horst3.s01,
  has one since M6); leaving for an away mission loads it (e1fe9be).

## Art

The browser can show a repainted plate for a room in place of its greybox (clicks and walks are unchanged: the greybox stays under it
for picking, walking and as the fallback). The tools run on this Mac only, and **nothing generated is committed**: plates, depth and
normal maps, cards, glTF built from traced layouts, benchmark images and intermediates stay under `~/pcode/unity-art-cache/` and
`games/unity/art/` (git-ignored). What is committed is the recipes (`art/recipes/*.yaml`), the model lock (`art/models.yaml`), the
benchmark's numbers (`art/bench/`), the Blender scripts (`art/blender/`) and `tools/art`.

```sh
export ART_CACHE=$HOME/pcode/unity-art-cache IMAGES_DIR=$HOME/pcode/unity-raw/runs/images/media
export GAMEDATA_DIR=$HOME/pcode/unity-gamedata/cd RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw
export COMFY_URL=http://<gpu-host>:8188   # the PC's RTX 4080; leave it unset to generate on this Mac
sh tools/art/setup/install.sh            # Blender, uv, a Python 3.12 venv, pinned ComfyUI; never sudo (stop if it asks)
npm run art -- fetch                     # the models in art/models.yaml, sha256-checked (about 13 GB)
npm run art -- doctor                    # every tool, pin and model hash: all lines must say ok
npm run art -- run art/recipes/lab.s01.yaml      # repaint + depth map + alignment check (the run fails if misaligned)
npm run art -- verify art/recipes/lab.s01.yaml   # re-run: same within 1/255 mean difference, and still aligned
npm run art -- align <plate.png> --screen lab.s01   # the alignment check alone
npm run art -- publish art/recipes/lab.s01.yaml  # copy the last run to games/unity/art/ and set presentation.yaml's `art`
npm run art -- card <object> <frame.png>         # a crew member's sprite card
```

A recipe's id is its screen id. Outputs of each run are in `$ART_CACHE/work/<recipe>/<timestamp>/` (`meta.json` has the model
hashes, seed, seconds and the alignment summary; `last.json` points at the latest). `COMFY_URL` points the tools at a ComfyUI
already running, for many runs in a row; `BLENDER` overrides the Blender binary. Lab.s01 takes about a minute.

**Where plates are generated.** The default is the PC's RTX 4080 at `COMFY_URL=http://<gpu-host>:8188`; the Mac (no `COMFY_URL`) is the
fallback. The same seed gives different pixels on the two (MPS and CUDA), so a recipe's settings are the 4080's. The variables, together:

- `ART_CACHE`: the cache with the runs, references and models (`~/pcode/unity-art-cache`);
- `IMAGES_DIR`: the exported originals (`runs/images/media`); every command that reads an original needs it;
- `GAMEDATA_DIR`: the game's folder with STTNG.ZIP, for the ship's originals and sprites and the panel;
- `RAW_DIR`: the raw IR export (`runs/export/raw`). `art publish` needs it to cut the masks: without it, it publishes the plate and says
  "RAW_DIR is not set: the masks were not cut" (`art masks <screen>` does them later).

`npm run art -- admin publish` takes the admin console's pictures (adminmnu.spr and .mrg, final.spr, the palette) from the game zip
(`GAMEDATA_DIR`) into `games/unity/art/admin`, 4x nearest-neighbour as lossless WebP, with the HD repaints' last runs beside them. The
repaints' recipes are `art/recipes/plate.admin.yaml` (the console's body) and `art/recipes/plate.final.yaml` (the Combat Options screen),
made on the 4080 and run like any recipe (`art run`, then `art admin publish` again). Art on draws the repaint; art off, or before the
pictures load, uses the original's pixels.

`art verify` refuses to run with `COMFY_URL` set, since it can't prove that server's build: unset it for a verify.

View it with art on: `/?game=unity&dev&start=lab.s01`. Art off (greybox): add `&art=0`, or untick `art` in the dev overlay's view
tab. `window.__au.art()` says what the room shows.

### The ship's screens as plates (Plan 16)

The ship's screens (the bridge, the viewscreen, the transporter room, astrogation and the computer) can each show a repainted plate of
the original's own background in place of the flat panel. Tactical and engineering stay flat. The panel's buttons stay exactly where and
what they were (they are the hit areas); the plate only shows behind them, and a control the original paints under a panel is covered by
a black area traced for it. The same rules hold: nothing generated is committed, and art is view-only (`?art=0` or a missing or failing
plate shows the flat panel).

**Build it** (each station's plate; `art ship publish` needs these inputs built first):

```sh
export ART_CACHE=$HOME/pcode/unity-art-cache IMAGES_DIR=$HOME/pcode/unity-raw/runs/images/media GAMEDATA_DIR=$HOME/pcode/unity-gamedata/cd
npm run art -- ship originals                                  # decodes the ship's backgrounds from the game's data (needs GAMEDATA_DIR)
npm run art -- refs grab --manifest art/refs/ship.yaml         # the set references the plates' style comes from
npm run art -- run art/recipes/plate.bridge.yaml               # a passing run per station: bridge, viewscreen, transporter, astrogation, computer
npm run art -- ship publish [station]                          # plate.webp, the window and areas, the crew and hail frames, into presentation.yaml
```

- **`art ship publish` needs its inputs built first:** the decoded originals (`art ship originals`, with `GAMEDATA_DIR`), the show crops
  (`art refs grab --manifest art/refs/ship.yaml`), a passing plate run per station (`art run art/recipes/plate.<station>.yaml`) and
  `IMAGES_DIR` (the bridge crew's and the hails' frames). **`GAMEDATA_DIR` is required for ship sprites:** a ship-only sprite (the bridge
  crew, the hails' pictures) has no screen of the world that draws it, so the images export holds it with the standard palette only, and
  its low colours come out black. `art ship publish` decodes those sprites itself, from the game's data, **with the palette of the ship
  screen that draws them** (the bridge's for the crew, the viewscreen's for the hails). Without `GAMEDATA_DIR` it stops with an error.
  `art ship publish --set` (the 3D set) also needs `art ship build` and the seven materials baked (`art run art/recipes/mat.*.yaml`).
- **Remote generation goes through `COMFY_URL`.** A plate is generated by ComfyUI. A run on another machine's GPU starts the command with
  `COMFY_URL=http://<host>:8188 ` (the tools talk to it through `curl`). The host must be loopback, private (RFC 1918) or link-local, or a
  name that resolves only to such addresses: the tools refuse any other, since the game's originals and the reference crops are uploaded
  to it, and `art doctor` checks the remote's models by name only. `art verify` refuses a `COMFY_URL` run, since it can't prove that
  server's build. A local run goes through `startComfy`, which takes the shared lock `$ART_CACHE/.comfy.lock` (R1: one ComfyUI job at a
  time, so Plan 14/15/16 runs take turns on the GPU; `lockf -k`, up to two hours). A manual ComfyUI run (a notebook, a script of your own)
  wraps itself: `lockf -k -t 7200 $ART_CACHE/.comfy.lock <command>`. Never leave a ComfyUI running.
- **The plate recipe** (`art/recipes/plate.<station>.yaml`, `kind: repaint`, `source: { ship: <screen> }`): `keep` is the list of
  rectangles `[x, y, w, h]` (original pixels) copied through unchanged (the LCARS bars, frames and labels); `areas` are the named rectangles
  the panel's sections sit in (`rows`, `entry`, `kit`, `controls`, `exits`, `map` and so on; each gets an opaque black ground); `window`
  (the viewscreen only) is a seed point inside the original's flat key-coloured window, whose region becomes a transparent layer the picture
  is drawn behind. The numbers are our own, traced on the decoded original. The item and pad rectangles are read from the lift at run time,
  never copied into a recipe (the schema refuses `rects` and `items`).
- **What the alignment check measures on a ship screen** (R13): the area corners, the pad and item corners and the original's strongest
  edges, measured on the plate against the original: a point passes within 2 px, and the per-axis medians and the drift must stay small. The
  published WebP is checked again (at most 2/255 mean drift). For the viewscreen the check runs against the original with a black window.
  **De-dither:** `dedither: { method: bilateral, sigma, factor, minRange, range, passes, glowSat, glowLum, glowGrow }` (every plate and room recipe has it) averages the
  original's dither out before the 4x upscale, which would otherwise turn it into streaks on carpets, floors and walls; edges, thin seam
  lines, displays (saturated glowing pixels) and the `keep` rectangles are left as they are (`tools/art/src/dedither.ts`, tuned on the bridge carpet and lab.s01's floor). The
  run keeps `dedithered.png` (1x) beside the plate, and a recipe with `keep` upscales the original as well, for the kept strip.
  **The step-down:** a run that fails the check is redone by hand with a lower `denoise` (0.6, 0.55, 0.5, ...), a tighter `mask.protect` or a new seed, and the recipe's comment says which step passed.
- **The window:** the viewscreen's window layer is the key region grown 3 px, so the picture covers the plate's repainted rim.
- **After a merge, the ship art must be published in the checkout that plays** (R10), since the art outputs aren't in git. Publishing the
  plates needs no Blender: the plate runs are already in the shared art cache. `GAMEDATA_DIR` is required (the game folder with STTNG.ZIP, e.g.
  `~/pcode/unity-gamedata/cd`: the originals and sprites are read from it), and so are `ART_CACHE` and `IMAGES_DIR` (the crew and hail frames). `art ship publish` with no
  station publishes only the bridge, so run it per station:

  ```sh
  export ART_CACHE=~/pcode/unity-art-cache IMAGES_DIR=... GAMEDATA_DIR=...
  for s in bridge viewscreen transporter astrogation computer; do npm run art -- ship publish $s; done
  ```

  The lifter carries `art.ship` over on a rebuild, as it does `art.rooms`.
- **The 3D set is behind `?dev&ship3d`.** The earlier 3D bridge (Blender scripts under `art/blender/ship/`, glTF in `art/ship/*.glb`) is
  kept and shown only with `?dev&ship3d`; without the flag no glb is requested, even for a station that has one, and `ship3d` without `dev`
  is ignored. It is never on by default: a station with a glb and no plate shows the flat panel. Build it with `art ship build` (the layout and the Blender run), the materials (`art run art/recipes/mat.*.yaml`) and
  `art ship publish --set`.

| What | Command |
|---|---|
| The art tools (live: needs the stack, the originals and the lifted rooms; skips otherwise) | `ART_CACHE=... IMAGES_DIR=... npx vitest run tools/art` |
| All 13 Mertens rooms: plate, masks and the team's cards shown, art on and off pick and walk the same, no console errors (skips, naming what is missing, without the 13 plates and the seven animated crew cards; screenshots go to `~/pcode/unity-raw/runs/art-mertens/`) | `npm run e2e -- unity-art-mertens` |
| Every ship screen with art on and off: the same buttons, item rectangles and picks, and the plates hold their controls (skips without published ship plates; screenshots go to `~/pcode/unity-raw/runs/art-ship/`) | `npm run e2e -- unity-art-ship` |
| `lab.s01` with art on and off picks the same objects, walks to the same point and logs no errors (skips without a published plate; screenshots go to `~/pcode/unity-raw/runs/art-lab-s01/`) | `npm run e2e -- unity-art` |

### Combat's art (Plan 30)

A battle with the art on is drawn in repainted textures and upscaled effects, its console over a repainted plate; with `&art=0`, or
without `art.space`, it is the original's (CI runs so). It is made on the PC's RTX 4080, the machine the recipes are tuned on,
through `COMFY_URL` (which must be on the local network, as for the plates); unset, it runs on this Mac's ComfyUI. Make every part on
the one machine: the same seed gives different pixels on the two. Nothing made here is committed: the runs are in `$ART_CACHE/work/`, the published files in `games/unity/art/space/`. The recipes are
`art/recipes/plate.tactical.yaml`, `pages.tactical.yaml`, `space.textures.yaml`, `space.upscales.yaml` and `tex.nebula-0.yaml` to
`tex.nebula-3.yaml`.

```sh
export ART_CACHE=$HOME/pcode/unity-art-cache
export COMFY_URL=http://<gpu-host>:8188   # the PC's RTX 4080; unset, this Mac
npm run art:space -- originals                          # the console and the atlas of its pictures, from the space build (npm run unity:build first)
npm run art -- run art/recipes/plate.tactical.yaml      # the console's plate: the 2 px check must pass (step-down: denoise 0.55, 0.5, ...)
npm run art -- run art/recipes/pages.tactical.yaml      # the pictures it repaints: the pages', the tabs', the buttons'
npm run art:space -- textures [--only <name>…] [--fresh] # every texture: repainted, or its upscale where the check can't pass (about two hours)
npm run art:space -- upscales                           # the effects' sheets and the console's other pictures, upscaled only
for n in 0 1 2 3; do npm run art -- run art/recipes/tex.nebula-$n.yaml; done   # the backdrop plates
npm run art:space -- check                              # every model's silhouette from six sides, the repaint's against the original's
npm run art:space -- publish                            # the packs and art.space in presentation.yaml (refused while a silhouette differs)
```

- **What is kept exactly:** every vertex, face and UV; each keyed texture's clear texels (copied from the original); the scanner's
  areas; the console's black and red-flash colours and the scanner's colours, which the console draws from the original's indices
  over the repaint; the warp overlay, which stays the original's.
- **The packs:** `art/space/kind<N>.pack` (a kind's textures), `effects.pack` (the effects' textures and upscaled sheets),
  `console.pack` beside `console/plate.webp` and its half, `backdrop/plate<n>.webp`. Each is at most 20 MiB (the deploy's limit is 25).
- **A low resolution** (`res=half`) decodes every picture at half its size. A battle's textures with the art are at most about
  143 MiB (the busiest battle, by estimate; §8's budget is 160).
- **The screenshot check with the art:** `COMBATSHOTS_ART=1 sh tools/combatshots/shots.sh <label> <battle>...` loads the port's side
  with the art and judges its console by lining up alone (Plan 30 R17). The port's console is drawn as the game draws it: the repaint's
  plate, its art layer and the frame over them; the run fails ("the port side drew no repaint") when the repaint isn't published or
  doesn't load.

#### Crew fix-ups and the viewscreen's views (Plan 34)

- **Fix-ups.** A crew recipe (`art/recipes/bridgecrew.*.yaml`) may list `fixups: { anim, frame, box: [x, y, w, h], from, mode? }[]`. They are applied
  in `crewRepaint` (`applyFixups`, `tools/art/src/bridgerepaint.ts`) after the head pass and before `holdStill`, to RGB only, never the alpha,
  so they mend a flaw without a GPU run. The box is in the strip's cell pixels, so it must be checked again whenever a frame is painted again. The
  default copies the box from the `from` frame as the paint came; `mode: tone` instead moves the box's opaque pixels to the source's colour, by
  lightness band in Lab (Data's tinted turn frame). The edge is feathered over 2 px, and a fix-up that changes nothing throws, naming the recipe.
  Used by Troi (anim 2 frame 1), Worf (anim 2 frame 3) and Data (anim 0 frames 3 and 6). Troi's talk lost its widest mouth frame to the copy (a
  ruling: the black lips were the named defect).
- **The views' sheets.** `npm run art -- ship publish viewscreen` now also writes each view's animation as sheets, `art/ship/view/<stem>.<anim>.<n>.webp`,
  in pages of at most 4096 px a side (the layer strips' atlas form: `images`, `pages`, `cells`), recorded in `art.ship.viewscreen.views[stem][anim]` with
  frames, scale, cell, anchor, delays, loop and next. The `<stem>.webp` first frame is still written, and shows when a sheet is missing. The plate must be
  published first, and a publish with no sheets removes them. Hail callers with no repainted still now animate, as the original's do.

### Mertens Station and the crew (Plan 15)

All 13 Mertens rooms and the seven crew (Picard, Riker, Data, Troi, Worf, Crusher, La Forge) play with art. The tools run on this Mac, with
the repaints that need a GPU going to a LAN ComfyUI through `COMFY_URL` (a non-loopback address goes through curl; every request has a
connect timeout and a max time, short for polls and long for uploads, views and streams).

**References (`art refs`).** The art draws on frames of the show from the Jellyfin server on the LAN, so that rooms and faces look like it.
`art/refs/show.yaml` is committed and holds only item ids, season and episode numbers, timestamps, crop boxes, tags and sha256s. The frames
are pulled into `$ART_CACHE/refs/` and never committed.

```sh
npm run art -- refs list [--season N]                         # the episodes the server has
npm run art -- refs scan --season N --episode N --every 20     # contact sheets to choose crops from
npm run art -- refs grab [--only <id>…] [--record]             # cut the manifest's crops (--record writes their sha256s)
npm run art -- refs board --tag crew:riker                     # a sheet of every crop with a tag
```

The server's key lives in `$ART_CACHE/jellyfin.env` (or the file `$JELLYFIN_ENV` names), with `JELLYFIN_URL` and `JELLYFIN_KEY`. The file is
mode 600 and outside the repo, and the loader refuses one that is group- or world-readable or inside the repo. The key is sent only as a
request header: never in a URL, argv, a child's environment, a log, an error, a file or a commit. Do not `cat` or `grep` the file; to check
it, list the names (`cut -d= -f1`). The server must be on a private or loopback address, and requests are read-only.

**IP-Adapter and its licence gate.** `ComfyUI_IPAdapter_plus` (pinned by `IPADAPTER_COMMIT` in `tools/art/setup/pins.env`; its code is GPL-3.0
and runs as a separate server process, nothing of it is vendored here) steers a repaint toward reference crops. Its SDXL weights and CLIP
vision encoder come from `h94/IP-Adapter` (Apache-2.0) and are in `art/models.yaml`, fetched with `art fetch`. A model is used only if its
sha256 matches and its card's licence is on the allow-list (Apache-2.0, MIT, BSD-3-Clause, CC-BY-4.0, OpenRAIL(++)-M, no login). Anything
that needs InsightFace or its models (FaceID, InstantID, PhotoMaker-V2) is non-commercial: it is banned from `selected`, and the user
allowed it on 2026-10-19 as an `experimental` role only, for this personal project (the likeness scorer and the away-team portraits use it). A recipe's `reference`
lists crops by id with a `model` (`style` or `face`), a `weight`, a `weightType` and optionally a `mask` (`head` or `figure`).

**Relative ControlNet windows (R3).** A ControlNet's `start`/`end` in a recipe are fractions of the sampled steps (0 is the first sampled
step, 1 the last). ComfyUI wants absolute percents of the whole schedule, so `tools/art/src/sigmas.ts` reproduces its karras schedule for
SDXL and maps one onto the other. At a partial denoise a window written in ComfyUI's terms would otherwise sit past the steps that run, and
the ControlNet would do nothing.

**Rooms.** A repaint recipe adds `denoise` for open surfaces, and a `mask` block (`protect`, point radius, band, emissive thresholds): the
denoise is masked by differential diffusion, so hotspot outlines, floor edges and glowing panels get `protect` of the schedule and the
room's own look survives. Every plate must pass `art align` (the per-point shift and drift checks) before it publishes. The M6 recipes (`art/recipes/<world>.sNN.yaml`)
use `denoise 0.45` and `protect 0.1`; a room that fails is stepped down by hand (lower denoise, tighter protect or a new seed) and its
recipe's comment says which step passed.

**The alignment check on dark, grainy originals** (6393c92). The 256-colour, hand-painted originals of Allanor, the zoo, Frigis and
Unity buried their structure under dither noise, and failed on points that were not misaligned. The check now:

- measures a point again on a smoother edge map with a wider window when it failed only for a low match peak (the coarse re-measure): a
  confident peak within the limit passes there, and a confident shift beyond it still fails;
- calls a point with no confident match at either scale (and every shift within the limit) *unmeasurable*, and lets at most 10% of the
  points be that;
- adds the original's strongest-edge windows when too few hotspot and floor points can be measured, and wants at least 6 points to
  measure in all;
- gives the median drift a 0.15 px allowance for the noise of the estimate, as the per-point shift already had (0.05 px).

The thresholds are unchanged: 2 px per point (`maxShift`), `minPeak` 0.5 and the 1 px drift limit. A plate moved 3 px is still refused on
every published plate (the test is `align.published.test.ts`, which skips without `IMAGES_DIR`).

**WebP fallback** (091cab2). `art publish` encodes the plate lossy first (`-q 90`). If that WebP drifts from its PNG (more than 2/255
mean) or no longer passes the alignment check, it tries near-lossless (`-near_lossless 60`), then lossless, logs which one it used, and
refuses (publishing nothing) only if even lossless fails. The cost is size: a lossy plate is about 0.4 MB, a near-lossless one 3.5 to
3.8 MB (full size; 0.1 to 0.15 MB at half size). `published.json` in the run's folder records `encoding` (`lossy`,
`near-lossless` or `lossless`). The 2 px rule and thresholds are not loosened for any of them.

**The local warp and `art post`** (d68bf5f). A plate that is right nearly everywhere and off by a few pixels at a point or two can be
touched up instead of re-rolled. The warp measures the plate against the original at the check's points, and moves the plate's content
back by each confident point's shift, with a smooth (Gaussian) falloff; it runs up to `passes` rounds, and then the normal check gates
the warped plate. It is capped so it can't paper over a misaligned plate:

- `maxWarp` 5 px: a point off by more than that is not warped (and still fails the check);
- `maxShare` 25%: the warp is refused when more than a quarter of the measured points need it;
- only confident points (a clear match, measured, not flat) are used;
- only the plate's own pixels move: gameplay data (hotspots, walk polygons, markers) is read from the lift, never from the plate.

```yaml
post:
  - warp: { radius: 24, minShift: 1, passes: 2 }   # also maxWarp (default 5, at most 8) and maxShare (0.25); before align
  - align: { maxShift: 2 }                          # a warp needs the align step after it
```

`allanor.s0a` and `frigis.s0a` publish this way. `art post` redoes the post stage of a run that already exists, with no generation:

```sh
npm run art -- post art/recipes/allanor.s0a.yaml                   # the last run
npm run art -- post art/recipes/allanor.s0a.yaml --run <run dir>   # one run
npm run art -- post art/recipes/allanor.s0a.yaml --all             # each run until one passes
```

**Upscale-only plates.** A room whose repaint can't be made to line up gets `repaint: false`: the plate is the de-dithered 4x upscale of
the original, with no diffusion pass, so it keeps the original's geometry (`allanor.s07`, `frigis.s03` and `allanor.s14`, by the user's
ruling). The check still runs. The one exception is a room whose original can't be measured at all (`allanor.s14`: a flat grey with a
black band), which may say `align: { maxShift: 2, skip: true, reason: "..." }`. A skip is allowed only when `repaint` is false and
only with a reason (the schema refuses anything else), and `art publish` logs it loudly and records `alignSkipped` in `published.json`.

```sh
npm run art -- batch art/recipes/lab.s0*.yaml     # many recipes in a row; a finished item whose inputs hash the same is skipped; logs in $ART_CACHE/work/batch/
npm run art -- publish art/recipes/lab.s01.yaml   # plate as WebP (measured against the original again), the depth map, then the masks
npm run art -- masks lab.s01                      # (publish does this) cut the occlusion masks from the published plate
```

Publishing writes the plate as WebP (`cwebp`, from Homebrew). The occlusion masks (`art.rooms.<id>.masks`) are cut from that plate for each
mask object in the room: the engine draws each as a quad standing at the mask object's floor depth, so a card behind it passes behind it. A
mask whose depth is above the horizon is not drawn, and a prop drawn at under 1 px (an object at the floor's vanishing end) is skipped:
the original shows nothing of it (3cfc5c2).

**The bridge crew** are not cards of the room kind: `art ship publish bridge` decodes each `brdg*.spr` with the bridge's palette, cleans each frame (`prepareCrewFrame`: the original
picture behind it matted out, the near-black and steel-grey fringe taken off) and sends every distinct frame through the card upscaler (4x, cached under `work/cards/bridge-crew/frames`), publishing
`art/ship/crew/<file>.<anim>.webp` as `scale: 4` strips. A crew member with a recipe, `art/recipes/bridgecrew.<object>.yaml` (`kind: bridgecrew`), is then
repainted toward the show as a crew card is (Plan 33): each distinct frame painted alone on its canvas with the recipe's seed, the head painted again on a canvas of
its own (`face`), the frame's alpha kept (the cut-out's, upscaled), and each frame held on the earlier frame it has most in common with (`hold`), so a talking
mouth doesn't shimmer the rest of the face. Each repainted strip must pass the card checks' absolute limits (alpha unchanged, outline in place,
`checks.deltaE`, every frame pair's flicker within `checks.flickerMax`, 12 and 12 by default; no flicker ratio), or its upscale is published and the log says why. Painted frames are cached under `work/cards/bridge-crew/repaint/<object>`; about 65 s a frame on the 4080, about
two hours for all five cold. It needs `COMFY_URL` (or a local ComfyUI) for the upscaler. A run beside another on the same ComfyUI uploads its frames under its own
name (`makeCard`'s `input`), because the shared `card-in` is overwritten by whoever uploads last.

**Crew.** `art strips <object> [--sprite <file>] --upscale-only` turns a sprite's used animations into strips of equal cells, with one anchor
per animation, the dithered foot patch smoothed, and the sprite's own pixel height (`pixelHeight`). A `card.<id>.yaml` recipe (`kind: card`)
repaints those frames toward a likeness: `art batch art/recipes/card.worf.yaml`. The original alpha is forced onto every repainted frame,
so a silhouette and its feet cannot move. A repainted animation is published only if it passes its checks: alignment (the feet and outline
stay where they were), flicker (`flickerRatio`, `flickerMax`), colour drift (`deltaE`), and for a costume with a glittering texture an
opt-in `speckle` skip. Each character's settings, with what was tried, are in the comments of their recipe. Device matters: the same seed
gives different pixels on MPS and on CUDA, so a recipe's last run records its device.

**Props and people lying on a floor.** Only crew are actors with cards; any other sprite the original draws over a background (Mertens' big cable
and trapped woman on `lab.s03`: `w4s3msk4.spr`, `w4s3doct.spr`) has no art in the plate. A `card.*` recipe with `prop: { screen, objects, anim }` repaints
that sprite's frame like a crew card (`anims: [0]`, one frame, the same alignment check) and publishes only the strip file; `art masks <screen>` (and
`art publish`) then stands it in the room's `masks` in a mask's place: the sprite's own rectangle, sorted by the object's row, shown while the object is
here and active. It is a still of one frame, not its animations: the first frame of animation `anim` (default 0). An object that a script swaps for
another one drawing a different animation of the same sprite needs a card of its own: Mertens' cable, when the phaser cuts it, turns `lab.big_cable.0308` off
and `lab.big_cable.0307` on, which plays animation 1 of `w4s3msk4.spr` (a 144x58 frame, not 146x60), so `card.lab_cut_cable` (`anim: 1`) stands it in. `art batch art/recipes/card.lab_big_cable.yaml art/recipes/card.lab_cut_cable.yaml art/recipes/card.lab_trapped_woman.yaml`
then `art masks lab.s03`.

What the original draws that a room's art still lacks, found by comparing with ScummVM room by room (`npm run placement`), is in
`docs/unity-sprite-placement.md`.

**NPC cards for the M6 worlds.** The same recipe kind (`card.<world>_<name>_<screen>.yaml` with `prop`) gives the Allanor, Frigis, zoo and
Unity characters a card: a still of frame 0 of animation 0 (or the `anim` the recipe names), stood in the room by `art masks <screen>`.
**Animated NPC cards are not supported yet.** `docs/unity-art-status.md` lists which are published.

**Away-team portraits and kit icons.** The away team's bar and the subtitles show a 64x64 pixel portrait of each of the nine crew
(Picard, Riker, Data, Troi, Worf, Crusher, La Forge, Carlstrom, Butler) and five icons for the standard kit (communicator, phaser,
tricorder, medical tricorder, medical kit). They are made by `art avatar` and `art icon`, and published by `art publish-kit`.

`art avatar <recipe> [--variant v] [--sheet-only]` makes each variant of a head portrait (the recipes are `art/recipes/avatar.<id>.yaml`;
the variants are the earlier rounds: SDXL + IP-Adapter, FaceID, style LoRAs) and writes a comparison sheet to
`~/pcode/unity-raw/runs/avatars/`. The pick for all nine is **treatment B**, the `grab` variant (`pick: grab` in the recipe, `grab.ts`),
which is a real picture, not a repaint:

1. a full show frame (a ref of `art/refs/show.yaml`) is scaled and moved so its InsightFace face box lands on the game portrait's;
2. BiRefNet's portrait matte (`face/matte.py`, in the face venv: `rembg`, `pymatting`) cuts the person out, and only the part joined to
   the face stays; backdrop pixels near the figure are filled from farther out, so the game's pale rim lights leave no glow;
3. the person's colours are graded halfway to the game figure's, and set on the game portrait's own mottled blue backdrop;
4. the recipe's `pixel` step reduces it to a 64x64 grid on 32 k-means colours.

```sh
npm run art -- avatar art/recipes/avatar.riker.yaml --variant grab     # the face venv, no ComfyUI
npm run art -- avatars art/recipes/avatar.*.yaml                       # one sheet with every pick
npm run art -- icon art/recipes/icon.phaser.yaml                       # an icon: repainted, then pixelated on its own grid with the sprite's alpha
npm run art -- publish-kit                                             # the picks to games/unity/art/avatars/ and art/icons/
```

The grab portrait's source is the show for six of the crew. **Carlstrom and Butler** have no show footage, so their source is the
`krea2` variant's picture (Krea 2 Turbo, with the TNG setting LoRA, from the game portrait as layout); Krea 2 Turbo's files are
recorded as experimental, remote-only models under the Krea 2 community licence. **Crusher and Troi** were re-picked on 2026-10-20 from
new frames: near-frontal, mouth closed and centred (b1bf04a).

`art publish-kit` writes each portrait to `games/unity/art/avatars/<crew>.webp` and each icon to `games/unity/art/icons/<item>.webp`
(lossless, so the pixels stay hard), reads every WebP back (it must equal its PNG exactly, or nothing is renamed or recorded), and
sets `art.portraits.<crew>` and `art.icons.<item>` in `presentation.yaml`. All of it is local and git-ignored.

**The likeness scorer** (`tools/art/face/score.py`). It embeds each picture's largest face with InsightFace (buffalo_l) and gives its mean
cosine similarity to held-out show frames of the person (`sim`) and `margin`, `sim` minus the closest of the other crew; a pixelated
picture is embedded at the face found in its unpixelated twin. It runs in the face venv (`$ART_CACHE/venv-face`: insightface,
onnxruntime, opencv; `rembg` and `pymatting` for the matte). InsightFace's weights are non-commercial, and the user allowed them for
this personal project on 2026-10-19; the licence note is in `art/models.yaml`. FaceID on the PC needed insightface 2.1 (before that
its numpy build broke, and the rounds ran on the Mac).

**The away team's panel** (`art panel publish`) publishes `awayteam.mrg` as it is: each entry decoded with `standard.pal`, scaled 4x
nearest-neighbour (interface art stays hard-edged) and written as lossless WebP to `games/unity/art/panel/<name>.webp` (21 sprites: the
panel, the verbs and their lit states, the markers, the scroll buttons, the slot), with `art.panel` in `presentation.yaml` (sprite names,
the scale and the few colours the panel fills itself; ce9630d). It needs `GAMEDATA_DIR`. The same sprites give the room's pointers.

**Another world.** The recipes and references are by world, so another world needs: its rooms' `repaint` recipes (copy a Mertens one, point
`source.background` at the room's original, tune `denoise`/`mask` on one room with `art run`, then `art batch` the rest); a section of
`art/refs/show.yaml` for its sets (people-free crops, tags such as `set.<world>.<name>`) and the crews' faces if they differ; the crew's
`card.*` recipes only if they change; and `art publish` per room, which cuts the masks. Then a spec like `unity-art-mertens.spec.ts` with
the world's room ids.

### Other model families (experiment, 2026-10-18)

A repaint or card recipe may name `model: qwen-image` or `model: flux` (default `sdxl`). Their files are `experimental` entries of
`art/models.yaml`: non-commercial and gated licences are allowed there for this personal project (the header says so), but only on that
role, never in `selected`. They live on the `COMFY_URL` server only (`remoteOnly: true`): `art fetch` skips them, their sha256 is Hugging
Face's LFS oid (recorded, not checkable remotely), and `COMFY_URL=... npm run art -- doctor` lists each family as an optional `ok`/`MISS`
line. The graphs (`tools/art/src/families.ts`) use core nodes: UNETLoader, CLIPLoader `qwen_image` or DualCLIPLoader `flux`, the family's
union ControlNet through ControlNetApplyAdvanced with the VAE, the same masked denoise (SetLatentNoiseMask + DifferentialDiffusion),
`euler`/`simple`; Qwen-Image runs under ModelSamplingAuraFlow (`shift`, default 3.1), FLUX under FluxGuidance (`guidance`, default 4.5,
cfg 1) with Redux (StyleModelApply) taking the recipe's references at their weight. Qwen-Image takes no references. ControlNet windows
are mapped on each model's own flow schedule (`sigmas.ts`).

```sh
COMFY_URL=http://<host>:8188 IMAGES_DIR=... npm run art -- compare art/compare/2026-10-18-models.yaml [--family flux] [--variant <name>] [--wait <minutes>]
npm run art -- compare art/compare/2026-10-18-models.yaml --sheet-only   # the sheets again from results.json
```

`art compare` repaints lab.s01 (its recipe's mask and protect zones, the 2 px alignment check) and two Riker canvases (walk 6, talk 31:
the card checks) per family and setting, at the recipes' seeds; a variant with the same settings is not run twice (`--fresh` forces it).
Results go to `$ART_CACHE/work/compare/<id>/`, the review sheet to `$ART_CACHE/work/sheets/model-compare.html`, the contact sheet to
`~/pcode/unity-raw/runs/model-compare/sheet.png`, and the numbers to `art/compare/<id>.results.yaml`. Nothing is published.

The state of every away room, the ship plates, the hails and the NPC cards is in `docs/unity-art-status.md`.

## Running the tests

Three checks, from the repository root, with the environment exported as above (`RAW_DIR`, `GAMEDATA_DIR`, `IMAGES_DIR`, `ART_CACHE`):

| Check | Command | Time on the 15-core M-series machine |
|---|---|---|
| Types | `npm run typecheck` | 10 s |
| Unit and live tests | `npx vitest run` | 16 minutes with `ART_CACHE` set, 3 minutes without |
| Browser tests | `E2E_PORT=5290 npm run e2e` | about an hour |
| What CI runs (no game data, no art) | `npm run ci` in a checkout with no `games/unity` (a `git worktree add` of HEAD with the `node_modules` linked in) | vitest 70 s, e2e 35 s |

What to know about each:

- **Vitest** runs the live suites whenever their variable is set. `ART_CACHE` brings in the ComfyUI ones (`tools/art/src/live-*.test.ts`),
  which generate on the GPU one after another behind `.comfy.lock`: `live-plate` alone is ten minutes. `env -u ART_CACHE npx vitest run` leaves
  them out and takes three minutes (2671 pass, 39 skip). A live suite whose lock is held says so and skips. With every variable set 2710 tests run (30 skip: the ScummVM
  trace ones need `TRACES_DIR`, `WALK_DIR` and the like); in CI mode 2629 (96 skip).
- **Playwright** starts its own dev server on `E2E_PORT` and a preview of the production build on the next port, and reuses them if they are
  already up. Use ports from your own range (never 5173, the dev server). It runs **three workers** (`E2E_WORKERS` changes it): every page draws
  WebGL on the CPU (SwiftShader) and one browser alone takes about six cores, so the default of half the cores (seven here) starves the pages
  and fails the specs on their own timeouts. `npm run e2e -- <spec file>` runs one file, which is what to do while changing something: the whole
  suite is 419 tests with everything published. Its Chromium sends audio to a fake output (`--disable-audio-output`), whose clock runs
  on a timer: through this Mac's own device a headless page's audio clock can stand at 0, so no sound ends and the sound checks time out
  (the combat sound spec checks the clock first and says so).
- **A spec that cannot run says why**: every `test.skip` names what is missing (`needs the lifted game under games/unity`, `needs ...: the
  published plate of lab.s01`). `npx playwright test --reporter=list` prints skipped tests, and the JSON reporter
  (`PLAYWRIGHT_JSON_OUTPUT_NAME=out.json npx playwright test --reporter=json`) has the reason in each skipped test's `annotations`. The specs
  that play the game skip on `games/unity` (what `npm run unity:build` makes), not on `RAW_DIR`; the art specs skip on the published files.
  `unity-art-worlds` makes one test per room that `presentation.yaml` publishes a plate for (62 here) and fails, rather than shrinking, if
  the file is unreadable or disagrees with the plates on disk (a count of 30 once came of a read taken while `art publish` was writing it).
- **The slow files**, by the minutes of their tests (summed, one worker): `unity-placement` 39 (about 130 rooms and props), `unity-art-worlds` 32,
  `unity-worlds` 31 (a page for each of the 93 rooms), `unity-art-mertens` 13. The room files run their tests across the workers.
- **Load and the retry.** A browser spec can fail only because the machine is busy (a page that takes over 30 s to boot beside two others). The
  config retries a failed test once and the summary lists a test that passed on the retry as `flaky`, by name: look at those, they are the
  ones that will fail next (the last full runs listed `frigis.s01`'s talk animation and `lab.dr_griems`' portrait line, each once). Do not run anything else heavy (a ComfyUI generation, another browser) beside the suite. A spec that times
  an animation reads `window.__au.animationTime()`, the time the animations play on, because the game's loop caps a frame and so runs slow
  on a busy machine, which the wall clock does not.

## Check it

| What | Command |
|---|---|
| Every away world lifts with 0 errors, alone and together; the lift accounts for every field; no hook throws `NotPorted`; the export names no hook | `npx vitest run tools/lift/src/live.test.ts` |
| A walkthrough can click the combadge in ScummVM | `sh tools/rawcheck/run-harness.sh walkcombadge 300 && WALKCOMBADGE_DIR=$HOME/pcode/unity-raw/runs/walkcombadge npx vitest run tools/rawcheck/src/live-trace.test.ts` |
| One walkthrough in both engines, diffed | `npm run unity:diff -- games/unity/tests/horst3.walk` (report: `~/pcode/unity-raw/runs/tracediff-horst3/report.md`) |
| Every walkthrough (all eleven: `horst3` x6, `allanor`, `zoo`, `lab`, `frigis`, `unity`) plays in the TypeScript engine, and diffs as the table below says | run `npm run unity:diff -- <walk>` for each `games/unity/tests/*.walk` (about 5 minutes each, mostly the ScummVM run), then `TRACES_DIR=$HOME/pcode/unity-raw/runs npx vitest run tools/tracediff/src/live.test.ts` |
| Which space combats the story needs (Plan 10 census; local output, it quotes the game) | `npm run tracediff -- census --game games/unity --raw $RAW_DIR` |
| Which beam-downs a new game's ship scripts reach, and the chain of triggers, hails and talk strings to each (Plan 11 census; local output, ids only; no raw export needed, a gap is a node nothing on the ship feeds) | `npm run tracediff -- route --game games/unity` |
| A world's puzzle gates, for writing a walk: `npm run tracediff -- outline --game games/unity --world <slug>` (output is local: it quotes the game) | `npm run tracediff -- outline --game games/unity --world <slug>` |
| Space combat's data: all 40 battles (every ship has its model, tactics and stats; gaps are listed), its sounds and cues (the 11 cue files the game lacks are listed), and the exported constants against ScummVM's lines | `RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw IMAGES_DIR=$HOME/pcode/unity-raw/runs/images/media AUDIO_DIR=$HOME/pcode/unity-raw/runs/audio/media GAMEDATA_DIR=$HOME/pcode/unity-gamedata/cd npx vitest run tools/lift/src/live-combat.test.ts tools/rawcheck/src/live-constants.test.ts` |
| Space combat's models (glTF), tactical's stills (indexed packs) and the combat sprites (sheets) under `games/unity/space` (85 models, 21 sheets here) | `npm run space -- --raw $RAW_DIR --images $IMAGES_DIR` |
| Every battle's models, sprites and stills load and are freed again, and combat.yaml is read only when a battle is near (Plan 24) | `E2E_PORT=5292 npm run e2e -- unity-combat-loading.spec.ts` |
| Every vertex of every space model lands where ScummVM's projection puts it, within half a pixel (Plan 25) | `npx vitest run tools/space/src/live-projection.test.ts` |
| Every battle draws in the space view: its ships where the scene says, within the draw budget, its set freed; the world's battle at tactical in the tactical box (Plan 25) | `E2E_PORT=5292 npm run e2e -- unity-combat-view.spec.ts` |
| Every battle's effects draw, fought by Delegate: each kind somewhere, where the scene says, within the draw budget, beams ending on their targets, no GL error; the bloom in the modern view only; the warp overlay at tactical, the battle held under it (Plan 26; about 2.5 minutes) | `E2E_PORT=5292 npm run e2e -- unity-combat-effects.spec.ts` |
| The console: its tabs turn its pages, each control gives its order, the radar targets a ship, Engineering waits its 498 ms, it costs the view no draw call; Full fills the frame with the HUD; the warp overlay hides both; a phone opens wide with the console as a drawer; F1's Combat Options pause the battle, keep their settings and draw the preview (Plan 27, Plan 32; about 2.5 minutes) | `E2E_PORT=5292 npm run e2e -- unity-combat-console.spec.ts` |
| A battle's sound, muted: tactical's music, the crew's cue for Shields and the cue after it, and nothing new while paused (Plan 28; about 1 minute) | `E2E_WORKERS=1 E2E_PORT=5292 npm run e2e -- unity-combat-sound.spec.ts` |
| The battle's controls: the keys fly, fire, target, zoom, pause and set the speed; the wheel zooms, a drag steers and a click targets the ship drawn there; Escape opens the assists panel, whose confirmed auto-resolve shows its result; a phone's tap targets and its HUD opens the panel; on a short screen the drawer fits the frame in Wide and the console's box in Split (Plan 29; about 1.8-1.9 minutes) | `E2E_WORKERS=1 E2E_PORT=5292 npm run e2e -- unity-combat-controls.spec.ts` |
| The admin console (Plan 32): Esc and the Admin buttons open it away and on the bridge, the clock stops behind it, Esc closes it; a named save loads back; a change on each SETTINGS tab is kept over a reload; EXPORT gives a file IMPORT takes back; a KEYS row takes the next key; with TEXT OFF a voiced line shows no box and a click still skips it (the bridge tests skip without the lifted game) | `E2E_WORKERS=1 E2E_PORT=5292 npm run e2e -- unity-admin.spec.ts` |
| Combat with its art on: a battle's packs on its models and sheets, its console over the repaint, the same controls and orders as with the art off; every battle's set within 160 MiB and freed (Plan 30; skips without `art.space`; screenshots go to `~/pcode/unity-raw/runs/art-combat/`) | `E2E_WORKERS=1 E2E_PORT=5292 npm run e2e -- unity-combat-art.spec.ts` |
| Flying a battle by hand (Plan 31 R6): the walk played to battle `<n>`'s start, the inputs file's orders given at their steps, and the battle run to its end (at most 9000 steps). It prints the outcome (`won`: the Enterprise lives and every enemy is destroyed, or the battle stood down with the ships its kill lists wait on destroyed; `lost`; `stoodDown`; `left`; `undecided`), the end step, the Enterprise's hull and its units destroyed, and exits 0 only on `won`. Each try replays the walk (about 25 s); a battle can't be saved | `RAW_DIR=… npm run fly -- --walk games/unity/tests/whole-game.walk --battle 71 --inputs games/unity/tests/battles/71.inputs` |
| Combat's frame rate, on the GPU, headed (never CI or an e2e spec; Plan 31 R4): each battle (`--battles 82,8` by default) fought wide with Delegate on at 1x on a 1920x1080 desktop (60 fps target) and a Pixel 7 landscape (30 fps target), 60 s after a 1 s warm-up. It prints `perf <profile> battle <n>: <fps> fps, p95 <ms> ms, worst <ms> ms, <calls> calls, <triangles> triangles` per run and exits 1 under a target; `?dev&perf=<n>` and `window.__au.perf()` are what it drives | `npm run perf` |
| The camera in ScummVM's trace against the port's, in every view (Plan 25) | `INPUTS=tools/tracediff/battles/views.inputs sh tools/tracediff/combat-parity.sh views 1 1100 8 16 52` |
| The space view against ScummVM's screen, by silhouette, and the console about it by the 2 px alignment check (Plan 25, Plan 27: six views a battle; report.md and sheet.png under `$RUNS/combatshots/<label>/b<battle>`, local only, for the eye) | `E2E_PORT=5292 sh tools/combatshots/shots.sh <label> 8 16 52` |
| A traced, scripted battle in ScummVM (Plan 22): its start, every draw from its seed, a snapshot every 15 steps, the inputs at their steps | `sh tools/rawcheck/run-harness.sh combat 300 && COMBAT_DIR=$HOME/pcode/unity-raw/runs/combat npx vitest run tools/rawcheck/src/live-trace.test.ts` |
| Space combat's parity (Plan 22): every battle fought in ScummVM, replayed in the port and diffed (about 40 minutes for the 39 battles; one ScummVM at a time) | `sh tools/tracediff/combat-parity.sh ensign 0 9000 && COMBAT_PARITY_DIR=$HOME/pcode/unity-raw/runs/combat-parity npx vitest run tools/tracediff/src/live-combat.test.ts` |
| Each entrance's scale against the original's | `npx vitest run tools/lift/src/live-projection.test.ts` |
| The floors' navmeshes, in every world | `npx vitest run apps/web/src/games/unity.rooms.test.ts` |
| Exporting the images leaves ScummVM's palette and background as they were | `sh tools/rawcheck/run-harness.sh imagestate 1800 && sh tools/rawcheck/run-harness.sh imagesearly 1800 && IMAGES_STATE_LOGS=$HOME/pcode/unity-raw/runs/imagestate/out.log:$HOME/pcode/unity-raw/runs/imagesearly/out.log npx vitest run tools/rawcheck/src/live-media.test.ts` |
| The first screen in the browser, and that the second screen's team takes clicks | `npm run e2e -- unity.spec.ts` |
| Every away screen loads with no console errors, the mission select starts each mission, the finale ends the game, and the tricorder shows a reading (about 10 minutes) | `npm run e2e -- unity-worlds.spec.ts` |
| Open any screen directly (dev only) | `?game=unity&start=<screen>[&entrance=<marker>]`, for example `&start=allanor.s05` |
| Play it: choose the mission on the bridge | `npm run dev`, then http://localhost:5173/?game=unity |

All six worlds (2-7) lift with 0 errors, alone and together, and `npm run unity:build` builds them (media, 80 greybox rooms, 85 space models as .glb); the
second build redoes nothing. Each command assumes `RAW_DIR` is exported as above. Walk status (Plan 9; each walk is one canonical route per world, played in ScummVM and the TypeScript engine, then diffed):

| Walk | Goal reached | Cut | Diff | Allowances used |
|---|---|---|---|---|
| `horst3` x6 | mission and ship | none | CLEAN | `advice-timing` 2 each |
| `frigis` | `t90` and the ship | none (the niche's o_050404 has an animation slot without data; scummvm-export `a24fa623798` makes ScummVM skip it) | CLEAN | `advice-timing` 1, `sprite-state` 6 |
| `zoo` | `t59` and the ship (through the field-unit sample chain, `o_030836`) | none | CLEAN | `idle-timer-firing` 21, `arrival-order` 4, `walk-end-position` 3, `timer-cadence` 1 |
| `lab` | `t133` and the ship | none | CLEAN | none |
| `unity` | none (stops at `s0a`, panel state) | ScummVM never moves the leaders off `s04`, so the finale and its game-over panel are not walked (deferred to Plan 13's ScummVM checks) | NOT CLEAN, known lines 12 and 102 | `sprite-state` 1, `same-tick-screen-timers` 1, `timer-cadence` 1, `walk-end-position` 1 |
| `allanor` | none (stops at `s0f`, before `t34`) | the star chart, schedule scan, `t34` and the ship | NOT CLEAN, known lines 35, 74, 77, 83 | `advice-timing` 3, `same-tick-screen-timers` 3, `walk-end-position` 3 |

The NOT CLEAN lines are known differences, listed in `KNOWN_DIFFERENT_STEPS` (`tools/tracediff/src/live.test.ts`) (each pinned with the state keys that still differ, so a new one, or one that goes clean, fails):
unity 12 and 102, allanor 35 (a member's position on re-entering a screen) and
74, 77, 83 (NPC walk-then-use nesting). Causes are under "Open questions". Without a ScummVM trace the live tests skip.
Without `games/unity` (CI), `npm run e2e` reports 24 passed and 247 skipped, each naming what it needs (the production gating check, the demo
tests and the loading-screen tests pass).

Writing a walkthrough: see `docs/trace-format.md` ("Walkthroughs") and `docs/tracediff.md`; play the
new lines in ScummVM alone with `sh tools/tracediff/run-scummvm.sh <walk>`, and read what happened with
`npm run tracediff -- summary --game games/unity --scummvm ~/pcode/unity-raw/runs/tracediff-<walk>/trace.jsonl`.

## For the user

These need a decision or an action of yours.

### Manual checklist

- [ ] Play Horst III start to finish in current Chrome, with sound (`npm run dev`, `?game=unity`).
- [ ] The same in current Firefox, with sound.
- [ ] Confirm 60 fps in both (devtools performance panel or the frame counter) and note the numbers.
- [ ] Later, once there is art (no manual play-through until then): play Allanor start to finish from the bridge in Chrome, with sound, following `games/unity/tests/allanor.walk`.
- [ ] Later, once there is art: the same for the zoo, following `games/unity/tests/zoo.walk`.
- [ ] Later, once there is art: the same for the lab, following `games/unity/tests/lab.walk`.
- [ ] Later, once there is art: the same for Frigis, following `games/unity/tests/frigis.walk`.
- [ ] Later, once there is art: the same for Unity, through the finale's game-over panel, following `games/unity/tests/unity.walk`.
- [ ] Later, once there is art: do the same in Firefox for one mission of your choice.
- [ ] Listen for the arrival movie, the beam-down music piece and the room music loops.

### Plan 18 follow-ups (combat data)

- Plan 18 exports `efficiency` and `hitWeight` for every ship unit; since Plan 23 ship.yaml must have each unit's efficiency
  (the reactors' fallback of 95 is gone): a ship.yaml from before Plan 18 is refused, and lifted again.
- Since Plan 23 the space world's battles are combat.yaml's only (the dialog reads them too): ship.yaml has no `battles`, and an
  older ship.yaml with them is refused until it is lifted again.
- Since Plan 24 the space build carries tactical's still pictures (`spc00a.pic` and `space.mrg` as `space/console.pack` in the space palette, `cheap.pic` as `space/warp.pack` in its own) and every combat sprite (`space/sprites/<stem>.png`, indexed by `space/sprites.json`) into `games/unity`, beside the models.
- **11 combat cue files are not in the game** (Plan 24): `fe0202c1`, `fe040266`, `fe040288` to `fe04028c`, `fe04029f`, `fe0602d1`, `fe0602dd`, `fe0602df` (each `.vac`). No member of `STTNG.ZIP` or `STTNGINS.ZIP` and no file on the CD has these names, so the audio export has nothing to decode; ScummVM plays nothing for them (sound.cpp:167-172), and nor will the port. Every other combat sound and cue (134 of 145 files) is transcoded. `live-combat.test.ts` pins the list against the game's archives.
- Battle 3 has no Enterprise: its only ship object has a misspelled name that matches no kind, and is inactive. The original has none there either (ScummVM warns "no battle the game reaches is like this"). The live test pins the line.
- No AlterBlock moves, turns or re-cloaks a space-world object before its battle (Review Focus 5): 58 AlterBlocks target space objects (11 set a state, 33 reset, 5 set flags, 9 only change the cursor) and none sets a position or a cloak time, so combat.yaml's file values are what `createShip` sees (Plan 19 can read them directly).
- Five tactics files are run by no ship: `bx.bin`, `nowarp.bin`, `probe.bin`, `shuttle.bin`, `warbird.bin`.

### Upstream candidates

- [ ] Port scummvm-export `a24fa623798` (`UNITY: Skip an animation slot that has no data instead of asserting`) to the `unity-engine` branch: `SpritePlayer::startAnim` asserted that the animation slot has data, but the sprite of `o_050404` has a slot with offset 0 that the data starts, so ScummVM aborted on frigis's good ending; it now warns and returns, as for a too-high animation.
- [ ] Port scummvm-export `486ba76741e` (`UNITY: Run an action square's script when a walker arrives at it`, first made as `f86474ebd10`) to the `unity-engine` branch, with its three follow-ups `27cd7bb07ec` (skip a deactivated square), `cb79e72c7b5` (radius 20 px) and `3664403ea02` (only the nearest squares): nothing ran an object with `objwalktype` 3, so the zoo's field units never reached their arrival scripts (and Frigis's floor-tile puzzle and the allanor people mover, which are action squares too, never worked). **The rule is inferred from the data, not confirmed against the original's own hit test:** an arriving walker takes the nearest square within 20 px, active or not, and runs it only if it is active (so a deactivated nearest square blocks the others). The zoo's crater square is exactly 20 px from its field unit's destination; Frigis's floor tiles (1 px squares, armed ones stun and beam out) are 14.6 px from the safe tile a walker is sent to, so running every square in a radius sets them off. The TypeScript sim does the same (`ACTION_SQUARE_RADIUS`, `actionSquaresNear`).
  **Suggest squashing the four into one `unity-engine` commit**, whose message states that final rule (nearest within 20 px, active or not, run only if active) and the "inferred, not confirmed" caveat: the earlier messages are superseded (`486ba76741e` says 25 pixels; `27cd7bb07ec` skips inactive squares, which `3664403ea02` reverses). Do not rewrite scummvm-export's history; squash when porting. `runActionSquares`'s per-square `debug(1, ...)` could also move to a higher debug level.
- [ ] Port scummvm-export `339c8269cb9` (`UNITY: Let a script sound finish when a sprite is making noises too`) to the `unity-engine` branch: a GeneralBlock sound waited on the shared sfx handle, which a looping sprite sound (the zoo field unit's droid) kept restarting, so `waitForSound` never returned. Script sounds now get their own handle.
- [ ] Port scummvm-export `63b5c32fa5e` (`UNITY: Act after walking partway if that is close enough`) to the `unity-engine` branch: `walkToThenAct` queued nothing when the path ended short of an unreachable destination, even within the action's stop distance (the zoo's field units stand off the crew's floor).

### Open questions

The action squares' rule (the nearest square within 20 px, run only if it is active) is a fit to the zoo, frigis and allanor data, not confirmed against the original; the upstream candidate above carries that caveat.

- **ScummVM plays one frame short of every FVF movie.** `FVFDecoder` (`engines/unity/fvf_decoder.cpp`)
  increments `_curFrame` before decoding, so `VideoDecoder` stops one frame early: movie 55 has 331
  frames, and ScummVM shows 330. It is a candidate fix for the upstream `unity-engine` branch. Plan 3's
  export writes all 331 frames, so the WebM shows one more frame than ScummVM plays; movies are compared
  by name only, so the trace diff doesn't see it.
- **290 conversation lines may be silent in the original too.** Lines whose voice depends on the speaker
  (voice group 0xfd) resolve, when Data speaks them, to voice files `fe0105xx`, which don't exist: Data's
  `fe01` files only have subgroups 00-04. ScummVM computes the same names, so those lines are probably
  silent in the original as well; worth checking in ScummVM (a possible bug in its `voice_tags`
  decoding). The browser falls back to the line's reading time for each of them.
- **The lift records content the export lacks as `missing`** (conversations w003c007, w006c013, w006c014; object 060b05; movie 42):
  ScummVM would fail if any were reached. Worth checking against the original game.
- **Space combats the story needs** (Plan 10 census, re-run after the final review: 57 battle hails naming 29 scenarios; it reads each scenario ship's destroyed hook, `phaser_data.kill_entries`, compares the written value with the value the gate reads, and counts only state/flag writes): the mandatory set is scenarios **16, 52, 70, 71, 83**. 16 sets `5f060c` (read by `w05fc005`, `w05fc006`, `o_5f012a`; it is the walkthrough's Frigis warbird); 52 sets `5f060d` (read by `o_020b1f`, `o_5f012c`); 70 sets `5f0132` (read by `o_5f03ac`); 83 sets `5f0627` (read by `o_5f0130`; `w05fc002` writes 0, not the gate's 1); 71 sets `5f062c`, whose only reader is `o_5f062c` itself (use groups 0 and 1). The other 24 are optional. Plan 12 Task 8 takes this list; Plan 13's whole-game route re-checks each.
- **Ship conversations the game refers to but its data lacks:** 1 (the game-over conversation, number 95) is recorded as `missing`. The other holes are not conversations: 24 battle-scenario numbers, 2 viewscreen numbers (99, 1), and 65535 (none).
- **frigis.walk diffs CLEAN only through the `sprite-state` allowance** (five steps: `o_05020c`, `o_050703`, `o_050a13`, `o_05011e`, `o_050302` change `state` in ScummVM's sprite scripts, which the export lacks); see `docs/tracediff.md`.
- **The ship script's writes to away objects** (frigis: `o_5f0372`, `o_5f0374`, `w05fc005`; lab: `o_5f0383`-`o_5f0385`, `w05fc007`) are ship-side gates (Plan 10 R3): walks end there. The playable ship is Plan 11 (spec section 7 amendment); Plan 13 continues the walks.
- **Screens without walk polygons** (R5): 13 of 14 are close-ups by their startup record. `allanor.s02` and `zoo.s0f` are no screen change's destination, so they keep the original's flags. The lift warns about three floorless non-close-ups: those two and `horst3.s05`.
- **`?start=` (dev only)**: the dev overlay's Restart goes to `game.yaml`'s start (Horst III), not the `?start=` screen, and a return to the ship shows only the store message, with no bridge panel. The screen-load e2e check waits 500 ms after each load, so a startup error later than that goes unseen (enough for R10's purpose).
- **The finale is beyond the harness** (R4): the ScummVM harness can't reach the guardians' endings (`gameOver`), so the game-over panel is covered by the browser e2e and synthetic tests only; `unity.walk` ends at `s0a`.
- **allanor.walk is NOT CLEAN in four steps and stops at `s0f`** (Plan 9 R7 a; `KNOWN_DIFFERENT_STEPS` lines 35, 74, 77, 83): line 35 (a member's position on re-entering `s01` while the data character is mid walk-in; not compared), and lines 74, 77, 83 (an NPC's walk-then-use nests differently: ScummVM runs it from `queueAfterWalk`/`runQueuedActions` when the walk ends, the sim has no walk-duration model). The second half (star chart, schedule scan, `t34`, ship) is not diffed.
- **A ScummVM harness `start 2 11 0` (allanor `s11`) does not stall** (Plan 9 Task 3): both engines play it to its end; Plan 8's stall was its own script.
- **Headless Play accepts use/talk on objects not on the current screen**, while ScummVM runs actions on other screens' objects remotely (frigis): conflicting evidence, so no refusal was added; settle in M4 what the original allows.
- **Candidate upstream fixes in ScummVM's `unity-engine` branch**: the SpritePlayer assert (frigis) and the action squares (zoo, frigis, allanor) are fixed in scummvm-export; see "For the user". The leaders left on `s04` (unity) is not yet diagnosed: Plan 10 deferred it to Plan 13's ScummVM checks.
- **Away-team selection** is the transporter room's (Plan 11-12): the recommended team or a hand-picked one, world 8 with its own.
- **unity: ScummVM never moves the two leaders (o_060402, o_060405) off s04** (Plan 9 R7 c; not yet diagnosed, deferred to Plan 13). They are walked and spoken
  for on later screens, but their `curr_screen` stays 4, so every check that wants one of them on s09 or s0a fails, and the guardians'
  endings that reach s10 (`startup_end`'s finale, `gameOver 3`) can't be walked in ScummVM; `unity.walk` ends in the guardians' room.
  The sim brings a reaction's object to the screen only while its sprite is unloaded, as ScummVM does, so the two engines agree
  up to there. Whether the original moved the leaders with the team is worth checking in the original game (a candidate fix for
  ScummVM's `unity-engine` branch).
- **unity.walk is NOT CLEAN in two steps** (Plan 9 R7 a; `KNOWN_DIFFERENT_STEPS` in `tools/tracediff/src/live.test.ts`):
  line 12 (`obj:o_06020f.timer`: ScummVM's screen change takes longer than the sim's, so a 4 s timer on the old screen still fires
  there), and line 102 (Troi's, `o_000003`, position after a step-in arrival: ScummVM is
  still walking her in when the step ends). None changes later steps.

## What only synthetic tests cover

Two of the trace events the walkthrough format can produce never happen in a Horst III walk, so only
`tools/tracediff/src/scummvm.test.ts`'s synthetic traces exercise their handling: a skipped movie (no
Horst III script plays one; the arrival movie is the bridge stub's, outside any walkthrough) and the
settle timeout's `error` (a walk that settles never hits it; a step that blocks is killed by the harness
instead, and `normalizeScummvm` refuses that trace: `killed-at-timeout`).
