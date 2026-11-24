# Lifting A Final Unity

Plan 3's ScummVM export writes the raw IR and media under `~/pcode/unity-raw/runs/`
(`export/raw`, `images/media`, `audio/media`, `movies/media`). The tools below turn
them into `games/unity/`. Everything they generate is the game's data, and is
git-ignored; only `overrides/`, `hooks/register.ts`, `hooks/ported/` and
`hooks/generated.ts` are committed.

```sh
R=$HOME/pcode/unity-raw/runs
npm run lift -- --raw $R/export/raw --world all-away --start horst3 --images $R/images/media --audio $R/audio/media
npm run media -- --audio $R/audio/media --movies $R/movies/media --out games/unity --dry-run
npm run greybox -- --rooms games/unity/rooms --images $R/images/media --out games/unity/models/rooms
npm run space -- --raw $R/export/raw --images $R/images/media
```

- **lift** takes `--world` as slugs, numbers, comma lists and `all-away` (worlds 2-7); `--start` names the world `game.yaml` starts in (default: the first given). It writes the content (`game.yaml`, `screens/`, `objects/`, `conversations/`,
  `triggers.yaml`, `advice.yaml`), `ids.yaml` (original ids and list paths ↔ slugs),
  `coords.yaml` (each screen's projection, every marker's pixel, every distance's
  pixels), `voices.yaml` (speakers and transcripts), `rooms/`, `hooks/generated.ts`
  and `coverage/<world>.json`. Each screen carries its fitted projection as
  `pixelMetric` (the `coords.yaml` projection without `samples` and `rms`), with
  `floor`: every polygon of the screen in the original's pixels and order, unwelded,
  each corner with its scale. So the sim measures talk reach, near checks and step-ins
  in the original's pixels, and ends each walk where the original's path finder does
  (`engine/src/sim/walkFloor.ts`, a port of walk.cpp). It fails, writing nothing, if any IR field is
  neither lifted nor listed in `tools/lift/src/ignored.ts`, if the content model
  can't express something, if an override names an id it didn't generate, or if
  the engine's `parseGame` rejects the result. Running it again changes nothing.
  In `coverage/<world>.json`, `stubs` and `fields` are global counts: every stub object the lift made, and every IR field it lifted or ignored, across all worlds (the same numbers in each world's file).
- **Overrides** (`games/unity/overrides/`) are deep-merged by id: `objects/**`,
  `screens/**`, `conversations/**` (each with its `id`), `triggers.yaml` and
  `advice.yaml` (maps by id), `game.yaml`. Arrays replace; `null` deletes.
  `coords.yaml` (`metersPerPixel`, and per-screen `kind`, `slope`, `horizonY`,
  `meanScale`, `topY`) and `contexts.yaml` (`<IR file>: { screen: s_WWSS }`, for crew,
  item and ship-conversation lists that use positions or regions) change the lift itself.
- A lift rewrites the tracked `hooks/generated.ts` when the stub list changes. Don't commit the regenerated file until it has been checked for quoted game text; the committed copy stays the empty skeleton.
- **Hooks:** to port `unity.general.g5`, write `games/unity/hooks/ported/unity.general.g5.ts`
  exporting `export const hook: Hook`, and run the lifter again.
- **media** prints (with `--dry-run`) or runs the ffmpeg commands: voice and sound
  effects to Opus, music and ambience to stereo Opus in `.ogg` files (Homebrew's ffmpeg
  has no libvorbis), movies to WebM. What is music is `--music`'s pattern (`unity:build` passes the stems
  presentation.yaml and combat.yaml play as music), not the channel count: every `.rac` is stereo, effects too.
  ffmpeg writes
  each output to a hidden `.<name>.part.<ext>` beside it, renamed once it succeeds;
  a job that fails is reported and the rest still run, and the command exits 1.
  A sound or movie whose name isn't a plain file name stops it before anything runs.
  Each output's command is kept in a hidden `.<file>.cmd` beside it; an output made by another command (an older codec) is made again.
- **greybox** turns each room file into `models/rooms/<world>/sNN.glb`, and removes
  any `.glb` under `--out` whose room file is gone.
- **space** (`npm run space -- --raw $R/export/raw`) turns every model `combat.yaml` names into `space/<key>.glb`. It takes the geometry and materials from the export's verbatim files, and every texture is drawn in the space palette (enterprs.mtl's first texture's); without that texture it stops, as the original then keeps whatever palette the screen before left set (`tactical.cpp:275-276`), which no file holds. A root node turns the original's x-right, y-down, z-forward space 180° about z. Each part is a node; each (material, two-sided) group is a primitive whose `extras.faces` lists the original faces; each material's `extras` keep its colour, alpha, flags and texture name. It removes any `.glb` that `combat.yaml` no longer names. Since Plan 24 it also writes tactical's stills as the original draws them, from their palette indices (the console, `spc00a.pic` then `space.mrg`'s entries, as `space/console.pack` with the space palette `space/space.rgb`; the warp's background, `cheap.pic`, as `space/warp.pack` with its own palette `space/warp.rgb`; engine/src/view/combat/files.ts), and with `--images` a sheet of every sprite `combat.yaml`'s `media.sprites` names (`space/sprites/<stem>.png`: its frames left to right in rows of at most 4096 pixels, from the images export's PNGs, in the palette the battle draws them in) and their index `space/sprites.json` (each sheet's frames, columns, cell, palette and entries). A still or sprite the exports lack is a `space:` line and exit 1; the rest is still written. `unity:build` runs it last, after the greybox rooms, when the lift wrote `combat.yaml`, with the images export when there is one.

## Ship data

The lift also writes these ship-side files (all gitignored, the game's data). They come from the export's verbatim binaries and overlay tables (`executable.json`):

| File | Holds | Source |
|---|---|---|
| `universe.yaml` | astrogation's sectors, stars, phenomena, stations, specials (those `Astrogation::load` keeps) and the starting flags | `astro.db` and `sector.ast` (copied verbatim), sector regions and chatter in `executable.json` |
| `computer.yaml` | the ship's computer tree: entries, their ids and the readings' parents | `computer.db` (copied verbatim), parsed as `loadComputerDatabase` does |
| `screentexts.yaml` | the text a script puts on a screen itself (`^N`), by screen and record: its box, font and lines | the screens' `t_WWSS00.bst` (`verbatim/`), parsed as `showScreenText` does |
| `ship.yaml` | bridge items and objects, the turbolift, transporter exits and recommended teams, warp and impulse speeds, ship unit stats (with each unit's efficiency and hit weight) | `executable.json` overlay tables (`exportTables`) |
| `combat.yaml` | the ten kinds of ship (flags, models, speed, cues, scanner and radar, weapon sprites and sounds, tactics), the enemy units, the flight tables, the power presets, hit lists, phaser banks, scanner areas, cues, the 40 battles (each ship's kind, position, heading, cloak, strength, hull-low and tactics; Enter, Exit, Warp), the tactics files (whole, base64), the models' records and the media combat uses; `sources` names the ScummVM line each hard-coded constant comes from | `executable.json` (`_enemyShip`, `_combatShips`, the flight tables, `_cues`), `combat.json`, the space world's objects, `verbatim/*.bin` and the models' headers |

Anything combat.yaml wants that the export lacks (a model, a tactics file, a sprite or sound the archive doesn't have) is a lift warning. A missing model or tactics file leaves its field null; a missing sprite or sound is only listed as a gap. `LiftedContent.combatGaps` lists them, and the live test (`tools/lift/src/live-combat.test.ts`) expects none.

Battle hails (types 0xa, 0xb, 0x10, 0x11) lift as a `scenario` number, never as a conversation; a ship conversation the game names but the export lacks is `missing`.

## Action squares

An object with `objwalktype` 3 lifts with `actionSquare: <the id's last byte>` on its `ObjectDef` (a transition square, type 2, is still known by its `transition` link). The sim's `walkActor` runs the `use` rules of the action squares nearest to a walker who arrives, before the walk's queued action, as ScummVM's `runActionSquares` does: of the squares on the screen within 20 pixels (`ACTION_SQUARE_RADIUS`, `pixels.ts`), only those at the shortest distance run (in id order), and a deactivated square still counts as the nearest and runs nothing. Both parts are inferred from the data, not confirmed against the original: the zoo's crater square is exactly 20 px from the destination its field unit is sent to, and Frigis's floor tiles (1 px squares that stun and beam out whoever reaches them armed) lie 14.6 px from the safe tile a walker is sent to, so running every square in a radius set them off.
