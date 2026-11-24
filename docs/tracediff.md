# The trace diff

`tools/tracediff` plays one walkthrough (`docs/trace-format.md`, "Walkthroughs") in the TypeScript
engine, maps ScummVM's trace of the same walkthrough through the lifted `ids.yaml`, `coords.yaml` and
`voices.yaml`, and compares the two step by step. Everything it reads is local and generated from the
game's data; see `docs/unity-local.md` for the commands that make it.

```sh
npm run unity:diff -- games/unity/tests/horst3.walk        # both engines, then the diff
npm run tracediff -- run --game games/unity --walk <file> --out <ts.jsonl>
npm run tracediff -- diff --game games/unity --scummvm <trace.jsonl> --ts <ts.jsonl> --out <report.md>
npm run tracediff -- summary --game games/unity --scummvm <trace.jsonl>
```

`diff` exits 0 when clean, 1 when there are differences, 2 when ScummVM's trace can't be compared, a file
can't be read or written, or the command line is wrong. An `error` in either engine is a structural
difference, even when both stop alike.

## What is compared

Both runs become one model (`tools/tracediff/src/model.ts`). Per walkthrough step, matched by line:

- **Ordered events:** actions and their ends (verb, target, other, depth, result flags), rule groups
  (`<rule path>/<index>`, passed or not), lines (speaker and voice file, or the text when there is no
  voice), choices (kind, option count, pick), movies, screens, the return to the ship, `refused`, `error`
  and `seed`. They are aligned with an LCS. Timer and trigger firings, each with its action, are matched
  as a set first, because each engine fires them on its own clock.
- **State:** the final value, at the step's end, of every key either engine changed in the step:
  objects (screen, state, active, inventory, stunned, position in metres, timer, name, talk string),
  phaser health and stun, response states, triggers, walk regions, condition counters, screen startups
  (close-up, combadge, input, advice) and the globals (advice, away-team flags, member, team, phaser
  setting, beam target, a waiting hail).
- **Content the export lacks (`missing`):** a walk that reaches one is never clean, as ScummVM fails there (M3 Decision 3).
- **Random draws:** site and bound in the ordered events; values pair by pair while the streams are aligned.

## Not compared

| What | Why |
|---|---|
| ScummVM's `entry` events | one IR entry lifts to one or more effects: entries show in the groups and state they produce |
| positions while walking | the sim works out only where a walk ends (on a screen with a pixel metric, through the original's path finder), not each step on the way; where walks end is compared |
| `obj` fields `z`, `y_adjust`, `universe_*`, `anim_index`, `sprite_id`, `cursor_*`, `voice_*`, `use_verb`, `use_preposition`, `destroyed`; flag bits other than active (0x20) and stunned (0x80) | the sim's state has no counterpart; they change presentation or the starship modes |
| `startup` fields other than `advice_id`, `closeup`, `combadge`, `input_blocked` | they are compared through what they cause when the screen is entered |
| `shipUnit`, `global` `newWarpMovie`, a hail's details | the starship modes (sub-project 4); whether a hail waits is compared |
| events before the first step | the harness's preamble |
| a position update while the other coordinate is still unknown | it can't be projected yet; the next update of the pair is compared |
| everything after `ship`, except `step`, `error` and `end` | back on the ship ScummVM plays the ship's screens, which the slice doesn't have, while the sim stops |

The report counts each under "Not compared".

## Allowances

A divergence that isn't in this table is a difference. Adding a row needs a ledger ruling with its cost (M3 Decision 14), a
reason, a source, a test that it applies and one that it doesn't over-reach
(`tools/tracediff/src/allowances.test.ts`).

| id | kind | why | source |
|---|---|---|---|
| `advice-timing` | forgive | ScummVM offers advice on a wall-clock timer, the sim on ticks behind the same tick's trigger work; the advisor's draw and the one line it offers (when one of the advice entry's advisors says it) are dropped from both streams, and random values are compared again from the next seed | carry notes 10, 28; `talk.cpp:421` |
| `phaser-regen-timing` | forgive | the sim skips regeneration on busy ticks; in a step that fires no phaser, health on the same side of the down threshold plays the same | carry note 10 |
| `timer-cadence` | forgive | timers and triggers fire on each engine's clock (ScummVM through walks and waits; the sim freezes them while busy; tracing slows ScummVM); a firing pairs one for one with the same firing in the other engine's next step, and the state it set is compared at the later step. Cost: an ordering bug inside that window is hidden | carry notes 18, 27; Decision 16 |
| `idle-timer-firing` | forgive | a surplus timer firing (the pairing of `timer-cadence` found no partner) whose every group failed, so that it changed nothing, is dropped; a surplus firing that passes a group, sets or says anything is still a difference. Cost: the count of idle firings isn't compared | Plan 9 Task 5 ruling (zoo's 1 s timers) |
| `arrival-order` | forgive | crew members walking to one place together arrive in a race (ScummVM walks them at once, the sim in turn): a step whose only difference is that the same members did the same `use` of the same target, at depth 1, in another order is forgiven. Task 2b adds action squares: walkers (crew or not) who each run the same squares' `use` blocks in another interleaving, each walker's own arrivals in the same order, with the end flags compared as a set, are forgiven too. Cost: the order of simultaneous arrivals isn't compared, and events common to both sides are paired by key, not by walker, so a swap of two walkers' identical uses is invisible | Plan 9 Task 5 ruling (zoo shuttle bay); Plan 10 Task 2b ruling (unity shuttle squares, the s0e step-in) |
| `same-tick-screen-timers` | forgive | the sim drops a timer due on the tick a trigger changes the screen | carry note 10; `timers.ts` |
| `walk-end-position` | forgive | without a pixel metric, the original walks to the clicked point, the sim to the marker; with one, the sim ports the path finder and the TALK walk-up's raw `pixelWidth`, so walks end where the original's do and this is only a safety net: the step's own actor's position after a step that can walk and stays on its screen (or goes on to a close-up, which places no one) matches within `rules.talkDistance` | Plan 5 Decision 3; Plan 4 Decision 8 |
| `sprite-state` | forgive | ScummVM's sprite scripts set an object's state while it animates and the export has no sprites, so the sim can't; a step whose only differences are the state keys of objects some lifted rule plays an animation on, or switches on or off, is forgiven, one count per key, and one other difference of any kind shows them all. Cost: a wrong state alter on an animated object hides in such a step (its rule outcomes stay compared) | `sprite_player.cpp` (`se_StateSet`); Plan 9 ledger |
| `unlifted-triggers` | forgive | a trigger outside Horst III's scope that triggers.json says is unused (type 3) or the ship's has nothing to compare with | Plan 4 Decisions 6, 14 |
| `proximity-threshold` | explain | near circles are in pixels in the original; on a screen with a pixel metric the sim measures near in the same pixels (so a near check passing in one engine only there is a real difference), and on one without, in metres; the one fix, for a screen without a metric only, is an `overrides/objects` patch of the group's near `dist` | carry note 24; Plan 4 Decision 8 |
| `talk-walkup-threshold` | explain | TALK's walk-up distance is in pixels in the original and, on a screen without a pixel metric, metres in the sim, so one engine walks (or talks) where the other doesn't (with a pixel metric the sim measures the same pixels, so this doesn't arise there); fix with `overrides/game.yaml`'s `rules.talkDistance` only if every walk agrees, else ask the user | carry note 24; Plan 2 Decision 7 |
| `alter-stops-walk` | explain | the sim drops a walk-then-act an AlterBlock interrupted; ScummVM runs it after the next arrival | Plan 5 Decision 4 |
| `new-command-stops-walk` | unreachable | a step starts only once nobody walks | Plan 5 Decision 4; `awayteam.cpp:610-611` |
| `combadge-behind-walk` | unreachable | a step starts only once nothing is queued | carry note 19 |
| `member-waits-behind-walk` | unreachable | a step starts only once nobody walks, so no member's command waits behind another's walk | carry note 31 |
| `partial-walk-position` | unreachable | only the browser's stage ends a removed walker part way; the diff runs headless | carry note 40 |
| `trace-across-load` | refused | a trace across a load loses changes; walkthroughs never load | carry notes 27, 29 |
| `killed-at-timeout` | refused | a blocked step can't time out, the harness kills ScummVM, and the trace has no end | carry note 29 |
| `halt-before-walk-ends` | retired | Plan 5 made headless walks stop part way | carry note 10; Plan 5 Decision 4 |
| `libm-atan2f` | forgive | Apple's `atan2f` is not `Math.atan2` rounded to a float: about 6% of results are a float apart, and `angleFromSinCos`'s whole angle moves on 26 of 2,000,000 inputs (a battle of 9000 steps meets a dozen to a hundred). ScummVM's trace logs each one (`atan2`), and the parity replay takes ScummVM's angle for exactly those inputs at that step; each taken is counted in the report by call site. Cost: the game's own angle, outside a replay, can be a unit off ScummVM's there | `space3d.cpp:47-49` (`angleFromSinCos`), called from `combat.cpp:647-650` (fly), `ai.cpp:57-58`, `ai.cpp:72` (steering), `weapons.cpp:83-84` (aim), `damage.cpp:440-441` (the shield); Plan 22 R1 |

Carry note 37 (scripts naming a non-crew actor) has no row: the engine now does what the original does (Decision 17). (Carry-note numbers are those of the project's working notes, which are not published.)

`forgive` removes the difference and counts it in the report; `explain` keeps it and names its cause;
`unreachable` has no matcher, because a walkthrough can't produce it (if one ever did, it would show as a
difference); `refused` traces aren't compared at all; `retired` divergences no longer exist.

## Space combat

`tracediff combat` replays each battle of a ScummVM trace in the port and compares the two
(`docs/trace-format.md`, "Space combat"):

```sh
npm run tracediff -- combat --game games/unity --scummvm <trace.jsonl> [--out <port.jsonl>] [--report <report.md>]
```

`--out` writes the port's events as ScummVM's trace writes its own (floats `%.9g`, -0 kept, NaN or an
infinity null), so the two files' `snap` lines can be read side by side.

Each battle gets a verdict, in the report's table and on the command's line: DIFFERS (at its first difference),
PROBLEMS (no difference, but something makes the comparison doubtful: a setup warning, a processHails ScummVM made
that the port didn't, an input line that won't parse, a simulation atan2f the port never asked for, a non-finite
float in ScummVM's snapshot), DIDN'T FINISH (ScummVM's trace has no `combatEnd`: the replay goes to the last step
it logged, plays the inputs it logged there, and stops without an end of its own, comparing that step as a
prefix, as the run may have stopped part way through it; a half-written last line is dropped with a note; what
there is matches), or
CLEAN. It exits 1 when a battle differs or has problems, else 2 when the trace has no battle, can't be read, or a
run didn't finish, else 0.

The replay starts the port's battle from the trace's `combat` event (the Enterprise's systems, the objects'
active flags and states, the difficulty, `lastDifficulty`, astrogation's position), its `combatSeed` and its
setup clock, through `startBattle` (TacticalScreen::start's part); then, a frame at a time as the harness's
`fight`: the inputs due, and `tacticalUpdate` to one step on (the step asks the sensors first, as the radar's draw
before the update did, once a step: Plan 23 R10). A trace of several battles (a route's) is one session: each battle
starts from the one before it as the port replayed it, as ScummVM's one Combat carries its console, camera and keys
into the next (setup's carryOver; Plan 23).

**Compared:** every `roll` in order (step, site, bound, value); each `snap` at its step, floats as float32
values (ScummVM's nine digits read back exactly; -0 is not 0, and a non-finite float is null, as the
export's JsonWriter writes them); in order, the `standDown` (by step: its site is the export's line), `leave`,
`warp`, `input` and `combatEnd` events; the camera in each `snap` (its position and axes as float32 values, and its view: M8 spec Decision 12; a trace from an export before Plan 25 has none, which is a problem until the battle is fought again); and setup's ships, each index's type and object, against the `ships`
event (a mismatch is a problem). The `hails` and `hailsEnd` events are echoed, not compared: the replay copies
ScummVM's own into its stream where it takes a processHails (below), so they always agree.

**Not compared:**

| What | Why |
|---|---|
| the world's scripts in a battle (the Enter object's USE, the hooks, a hail's response) | the replay doesn't run them: where ScummVM's trace has processHails at the step a hook runs, from that hook's own line (`damage.cpp:672` the event hook, `:693` the hail script, `:713` hull low, `:731` destroyed), the replay takes only what processHails can change (`tactical.cpp:377-436`): the red alert where it stood down or on a 0xf, the exit on a 0xd (or a type 7 that reached one), and a 0x10's remove times for the ships whose remove time is still 0. Any other value its `hailsEnd` has apart from the port's is a problem, not taken. It echoes the call's events. The world's part is the adventure diff's and Plan 23's |
| what follows a `leave` (endCombat's hooks, stand-down, the Exit or Warp object) | the battle is over; the world's |
| ScummVM's `atan2` events the port never asked for | the stars' drift (`combat.cpp:958-963`, once a drawn frame), or one past a difference; they're listed by site as unused. One at a simulation site (`combat.cpp:650-653`, `ai.cpp:57-58`, `ai.cpp:72`, `weapons.cpp:83-84`, `damage.cpp:440-441`, and since Plan 25 the camera's, `combat.cpp:808-809` and `923-924`: the export's lines) before the first difference is a problem |
| sounds, cues, the stars, the console's drawing | presentation (M8) |
| a hail's 0x10 remove times in the game (processHails, `tactical.cpp:420-429`) | ScummVM reads `g_system->getMillis()` there, the wall clock; the game takes the battle's clock (`now`), as it can't reproduce the wall clock (Plan 23 R6, a kept-in-spirit deviation). The replay takes ScummVM's remove times from its trace as they were, so a parity run is unaffected; a route trace's (Plan 23's battles, once the export can play the ship's walks) differs by the frame's lag at most: take them from the trace, as the replay does |

A difference is triaged by Plan 22's rules (R9): a port bug is fixed with a pinned test; only ScummVM's own
rounding that the port can't reproduce gets an allowance, with its call site.

### Parity runs

`tools/tracediff/combat-parity.sh` fights battles in ScummVM (the export worktree, traced and muted, one run at
a time under the harness lock) and runs `tracediff combat` on each:

```sh
sh tools/tracediff/combat-parity.sh ensign 0 9000                 # every battle with an Enterprise, Worf flying
INPUTS=tools/tracediff/battles/delegate.inputs sh tools/tracediff/combat-parity.sh lieutenant 1 9000
INPUTS=tools/tracediff/battles/flight.inputs sh tools/tracediff/combat-parity.sh flight 1 700 1
INPUTS=tools/tracediff/battles/views.inputs sh tools/tracediff/combat-parity.sh views 1 1100 8 16 52   # every camera view (Plan 25)
COMBAT_PARITY_DIR=$HOME/pcode/unity-raw/runs/combat-parity npx vitest run tools/tracediff/src/live-combat.test.ts
```

A label is one whole run: `$RUNS/combat-parity/<label>` is cleared first (`RUNS` must be
`~/pcode/unity-raw/runs` or under it). The runs land in its `b<battle>` (`script.txt`, `trace.jsonl`, `out.log`,
`port.jsonl`, `report.md`), their lines in `summary.txt`, which always ends with the count of each outcome: clean,
differs, problems (no script, or a trace `tracediff combat` couldn't compare, with its reason), and ScummVM didn't
finish (said so, never diffed as a difference). The script exits 1 if a battle differs or has problems, else 2 if
ScummVM didn't finish one, else 0; a bad command line (a battle that isn't a number, say) is 2 before anything runs.
It refuses to start when the export's hooks are off, or its `scummvm` was built without them.
Each battle is fought from seed 7000 plus its number, its ships a new game has inactive made active (as the story
makes them), to its end or the cap.
`npm run tracediff -- combat-script` writes one run's harness script, and `combat-battles` lists the battles
with an Enterprise. `combat-states --scummvm <trace> --steps <n,n,...> --out <dir>` replays a trace's battle and writes
it as each of those steps left it (`state-<n>.json`): `tools/combatshots` draws them beside ScummVM's screens (Plan 25).

### Results (Plan 22)

`tools/tracediff/src/live-combat.test.ts` pins what holds on every run: each label's battle count (39, 39, 1, 1,
1, 1), every battle CLEAN (no difference, no problem of the replay's or the diff's) and finished, and the
hand-flown battles' end reasons (`flight` and `console` at the cap, the two self-destructs leaving). The end
steps and atan2f counts below were measured once, and are informational: they vary with ScummVM's wall-clock
start (setup's `getMillis()`, `combat.cpp:159`: docs/trace-format.md, "Lines"), which the replay takes from each
trace, so another run of the same battles can end at other steps and take other angles, and still be CLEAN.

- `ensign`: 39 battles, all CLEAN; 4 won (only the Enterprise left); 15 left the screen (15 for the game's end, the Enterprise lost); 20 still fighting at the cap; 481 of ScummVM's atan2f angles taken.
- `lieutenant`: 39 battles, all CLEAN; 2 won (only the Enterprise left); 17 left the screen (17 for the game's end, the Enterprise lost); 20 still fighting at the cap; 396 of ScummVM's atan2f angles taken.
- `flight`: 1 battle, CLEAN; 1 still fighting at the cap; 2 of ScummVM's atan2f angles taken.
- `console`: 1 battle, CLEAN; 1 still fighting at the cap; 1 of ScummVM's atan2f angles taken.
- `selfdestruct`: 1 battle, CLEAN; 1 left the screen (1 for the game's end, the Enterprise lost); 3 of ScummVM's atan2f angles taken.
- `selfdestruct-conn`: 1 battle, CLEAN; 1 left the screen (1 for the game's end, the Enterprise lost); 3 of ScummVM's atan2f angles taken.

Each battle's end in that run, as `<battle>:<reason>@<step>`:

- `ensign`: 1:cap@9000 2:cap@9000 4:cap@9000 6:won@0 7:leave@153 8:leave@1136 16:cap@9000 32:leave@572 33:cap@9000 34:leave@1868 35:leave@2600 36:leave@1626 37:leave@3207 38:leave@2018 39:won@6046 40:cap@9000 41:cap@9000 48:cap@9000 49:cap@9000 50:cap@9000 51:cap@9000 52:leave@531 53:cap@9000 54:cap@9000 55:leave@1256 56:cap@9000 57:cap@9000 64:won@1567 65:leave@1476 66:cap@9000 67:cap@9000 68:won@496 69:cap@9000 70:leave@1701 71:leave@2175 80:cap@9000 81:leave@1840 82:cap@9000 83:leave@3251
- `lieutenant`: 1:leave@1601 2:cap@9000 4:cap@9000 6:won@0 7:leave@153 8:leave@549 16:leave@2232 32:cap@9000 33:cap@9000 34:leave@951 35:cap@9000 36:cap@9000 37:leave@3093 38:cap@9000 39:cap@9000 40:cap@9000 41:leave@6856 48:cap@9000 49:cap@9000 50:cap@9000 51:leave@1412 52:leave@766 53:cap@9000 54:cap@9000 55:leave@749 56:cap@9000 57:cap@9000 64:leave@1963 65:leave@690 66:leave@2727 67:won@322 68:cap@9000 69:cap@9000 70:leave@1068 71:leave@3027 80:cap@9000 81:leave@1601 82:leave@5877 83:cap@9000
- `flight`: 1:cap@700; `console`: 1:cap@700; `selfdestruct`: 1:leave@489; `selfdestruct-conn`: 1:leave@476

No allowance but `libm-atan2f` was needed.

### Results (Plan 25)

Plan 25's export traces the camera in each snapshot, and the whole suite was fought again with it (about 1 hour
24 minutes, one ScummVM at a time). Every battle is CLEAN, the camera included; `libm-atan2f` is still the only
allowance. Unlike Plan 22's counts these are not pinned by `live-combat.test.ts`.

- `views` (`views.inputs`, Lieutenant, cap 1100, battles 8, 16 and 52): 3 battles, all CLEAN. Battles 16 and 52 trace every view number from 0 to 0x12 but 0x11 (the drop becomes tracking within its step, so its snapshots say 0x10); battle 8 traces views 0 to 8 and 0x10, then leaves at step 555.
- `ensign`: 39 battles, all CLEAN.
- `lieutenant` (with `delegate.inputs`): 39 battles, all CLEAN.
- `flight`, `console`, `selfdestruct`, `selfdestruct-conn`: 1 battle each, all CLEAN.

No `views` run took an atan2f angle at the camera's sites (`combat.cpp:808-809`, `923-924`): ScummVM logs only the inputs where the two libms differ, so the camera is compared through the snapshot's `camera`, and the replay's taking of a logged angle there is pinned by a unit test (`combat.test.ts`).

### Results (Plan 31)

The screenshot check (`tools/combatshots/shots.sh`, M8 spec §9.3) for every battle with an Enterprise (`combat-battles`:
39), in the parity mode with the art off, Difficulty 1, one ScummVM at a time. 38 battles were shot, six views each;
battle 6 took no shots (it is won at step 0, before the first view's input). **170 of 228 shots SAME**; the side view
(0x1) differs in 37 of the 38 battles (battle 7's alone passes), and 21 other shots differ.

- 6 of 6: 7. 5 of 6 (the side view alone): 16, 34, 35, 36, 37, 38, 39, 41, 48, 51, 52, 53, 54, 66, 67, 70, 71, 80, 81.
- 4 of 6: 1 and 32 (side, forward), 2, 33, 40, 49, 55, 68, 69 and 82 (side, overview), 4 and 57 (side, forward: ScummVM
  shows 8 and 12 pixels the port has nothing at), 56 (side, top: box 3 px), 65 (chase: box 3 px; side), 83 (side,
  target: box 3 px).
- 3 of 6: 8 (side, overview: box 19 px, target: box 5 px), 50 (side, overview, target), 64 (chase, side, overview).
- The side view: IoU 0.851 to 0.898, the port's mask 7 to 12% larger (battle 1's 810 against 878 pixels, battle 50's 841
  against 939), its centroid 1.4 to 2.4 px right.

**The side view's cause: the rasterizer, not the filtering.** Plan 25's lead (the parity mode's textures Linear where
drawTriangle takes one texel, `space3d.cpp:428-430`) was tested first and refuted: every space texture Nearest in the
parity mode left the side view's mask at 877 pixels (from 878), and Nearest with the original's texel scale
(`u * (width - 1)`, `space3d.cpp:338`) at 877 too, though both changed the colour of 872 of the view's pixels. An
emulation of the original's drawObject and drawTriangle on the Enterprise's model (the build's .glb, its stored face
normals and planes for the back-face test, `scummProject` for the vertices) at the side view's replayed state matches
ScummVM's mask at IoU 0.969 (battle 52). The port's 80 extra pixels are all pixels a triangle covers only in part:
the canvas is multisampled (`antialias: true`, apps/web/src/main.ts), so a pixel an edge crosses comes out a blend of the
ship and space, not space; the same emulation sampled 16 times a pixel matches the port at IoU 0.984. Drawing the parity
mode without multisampling isn't enough: ScummVM's rasterizer is "fat" (its vertices snapped to whole pixels,
`project`, `space3d.cpp:277-279`, and every pixel on an edge drawn, `space3d.cpp:416`, where the GPU draws a pixel whose
middle is inside, edges by the top-left rule). With `antialias: false` the side view's mask came to 763 pixels, as the
emulation of the GPU predicted to the pixel, and 121 of 228 shots were SAME. The emulation with snapped vertices and the
top-left rule reaches IoU 0.892; only the original's every-edge rule passes (as the emulation predicts it; no every-edge
rasterizer has been built in the port). The emulation was a scratch script, kept outside the repo.

So the side view fails the strict check. Matching it exactly would mean drawing the parity mode as the original rasterizes
(no multisampling, vertices snapped to the pixel, every edge pixel drawn, degenerate triangles skipped), a change to the
render path beyond the combat view's drawing. The user ruled otherwise (Plan 31 R9(b)): accept the edge ring and judge with
a 1 px tolerance, with no change to the renderer; no rasterizer fix was committed (see "The 1 px tolerance" below).

With the art on (`COMBATSHOTS_ART=1`, battles 8, 16 and 52): 14 of 18 SAME: the side view in all three, and battle 8's
overview (with the art off, battle 8's target differed too); the console lines up on 48 of 50 points in every shot.

**The other 21 differing shots (Plan 31 Task 6b).** Each was looked at with its masks and its replayed state. A scratch
emulation (outside the repo) drew every ship and effect of the state as drawObject, drawPolygon and drawTriangle do: the
back-face test, the clip at z = 1, snapped vertices, every edge pixel, affine texels and keyed texels. It matches
ScummVM's mask in every shot with a ship (IoU 0.90 to 1.00 on the whole view, stars aside). A GPU-like version of it (16 samples a
pixel, perspective-correct texels) mostly matches the port's: IoU 0.92 to 0.99, but 0.870 for battle 1's forward and
0.721 for 50's overview (below). There are three causes:

- **Fixed (1): battle 69's overview.** The camera is on the shooter, its phaser bank 1 unit behind the camera and the
  beam's tip on the Enterprise 2000 ahead. ScummVM draws nothing of the beam. drawPolygon clips at z = 1 and lerps the
  texels along the edge (`space3d.cpp:366-387`), and drawTriangle reads them across the screen with no perspective
  (`space3d.cpp:404`, 428-430). Every pixel in the window takes the texels at the tip's end of frame 1, which are keyed.
  The port's GPU-clipped, perspective-correct beam ran from the window's bottom edge to the Enterprise (IoU 0.848, box
  69 px). The parity mode now clips a beam as drawPolygon does and reads its texture affinely (effectLayer.ts: clipNear,
  withAffineMap). The shot is SAME (0.975, box 0, centroid 0.08), as the emulation predicted (0.975).
- **The side view's cause (13): the rasterizer and the multisampling.** Battle 1's forward, 2's overview, 8's overview
  and target, 32's forward, the overviews of 33, 40, 49, 50, 55, 68 and 82, and 50's target. They are small or distant
  ships (10 to 200 pixels, where a one-pixel ring is 10 to 15% of the mask), thin dotted beams, edge-on slivers and a
  shield's keyed sparkle. The whole-view emulation was run on all 13. The original's passes against ScummVM in each
  (IoU 1.000, 1.000, 1.000, 0.997, 0.923, 0.976, 0.987, 0.982, 0.990, 0.993, 1.000, 1.000 and 0.989 in the order
  above). The GPU emulation against the port gives 0.870, 0.924, 0.988, 0.984, 0.930, 0.931, 0.937, 0.975, 0.721, 0.976,
  0.917, 0.984 and 0.946. Two of those don't match well. Battle 1's forward is a 20-pixel ship, and 50's overview is a
  dotted beam whose dots the emulated GPU doesn't place where the port does. Those two are judged by analogy with the
  rest. Two amplify a pixel into a large box shift:
  - Battle 8's overview (box 19): a distant ship ScummVM draws 6 pixels wide and the port 5. The check's star filter
    drops any component that fits a 5 x 5 box, so it takes out the port's ship and keeps ScummVM's.
  - Battle 8's target (box 5): the port draws faint (3 to 12 of 255) one-pixel lines under the starbase, from triangles
    seen edge-on that a multisample partly covers and the original never draws.

  These were left to the side view's decision, which was the 1 px tolerance (below): battle 8's overview and target still fail it.
- **The stars (7): no ship differs.** Battle 4's and 57's forward views have no ship on either side. ScummVM's 8 and 12
  pixels are two of its stars that touch, which the star filter (one star fits 5 x 5) doesn't take out. In 56's top, 64's
  chase and overview, 65's chase and 83's target (box 3 each), one of ScummVM's or the port's stars touches the ship, so
  the box takes it in. The port's stars come from its own generator (M8 spec Decision 10), and ScummVM's change from run
  to run, so where they fall is chance. Battles 4, 57, 56 and 64 pass in the re-run below, and other shots fail the same
  way there instead.

The re-run of all 38 with the fix (`plan31c`): **169 of 228 SAME**. ScummVM's replayed states move a few milliseconds
from run to run and its stars are new each run, so this run's port side was also drawn without the fix
(`plan31c-nofix`): 170 of 228. On the same states the fix passes battle 69's overview and fails battles 1's and 2's
targets. There the original draws the start of a distant beam (frames 0 and 1) as isolated dots, which the star filter
takes out. The fixed port now draws the beam there too, but the multisampling joins the dots into a line the filter
keeps (the emulation of the original passes; with one sample a pixel, battle 2's does too). These are the side view's
cause. The re-run's other new failures are stars again: the top views of 34, 41, 50 (box 82, two stars together) and
57. One is a small ship's ring: 66's overview, where the emulation of the original passes.

**Parity re-run after combat's switch-on (Plan 31, R10).** Plans 26 to 30 did not touch the sim or the camera, and Plan 31
changed only the parity mode's beam drawing (`d86053e`), which no trace covers; the suite was fought again to check
that (`combat-parity.sh`, labels `plan31-ensign` and `plan31-lieutenant`, cap 9000, the commands as Plan 22 and 25
ran them: `delegate.inputs` for the Lieutenant set alone):

- `plan31-ensign` (difficulty 0): 39 battles, 39 CLEAN, 0 differ, 0 problems, ScummVM finished every one.
- `plan31-lieutenant` (difficulty 1, `delegate.inputs`): 39 battles, 39 CLEAN, 0 differ, 0 problems, ScummVM finished every one.

`libm-atan2f` is still the only allowance.

**The 1 px tolerance (Plan 31 R9, the user's ruling).** `compareShots` now counts a mask pixel set in one screen and not
the other as matched when the other has a set pixel among its 8 neighbours (`EDGE_TOLERANCE = 1`); the tolerant IoU is
`matched / union`, with `matched` = the pixels both set + each side's unshared pixels that have the other's within 1 px.
It applies to every view, the stars are taken out first, and `MIN_IOU` 0.9 and `MAX_SHIFT` 2 (box and centroid, still
measured on the strict masks) stand. The report keeps the strict IoU in its own column. Re-scored offline from the same
shots (`combatshots compare`; the strict reports are kept beside them as `report-strict.md`), no shot went from SAME to
DIFFERS:

- `plan31c`: 169 → **211 of 228 SAME**. By view shown: side 0 → 34 of 37, forward 35 → 37, overview 27 → 31, target 32 → 34, top 33 → 33.
- `plan31c-nofix`: 170 → **211 of 228**. (Battle 69's overview, the beam fix's shot, still fails there.)
- `plan31-art` (battles 8, 16, 52): 14 → **17 of 18**.

The 17 still differing in `plan31c` (the same set but for 2's target and 69's overview in `nofix`; `plan31-art` keeps only
battle 8's overview). Their tolerant IoU is 0.974 to 1.000; each fails on its box or centroid:

- Stars (6): the top views of 34, 41, 57 and 50 (box 5, 5, 3, 82), 65's chase and 83's target (box 3). One star touches a
  ship or two touch each other, so the box takes it in.
- The star filter on a distant ship (1): battle 8's overview, box 19 (ScummVM's 6-pixel ship kept, the port's 5 dropped).
- Edge-on slivers the multisample partly covers (3): battle 8's target (box 5), and the side views of 32 and 50 (box 3, 4),
  where the port has 4 to 23 pixels a few pixels beyond the ship's end that ScummVM doesn't.
- A dotted beam the multisampling joins into a line (1): battle 2's target, box 14.
- The centroid alone (6): the overviews of 2, 33, 49, 50 and 66 and the side view of 80 (centroids 2.4 to 5.7 px, boxes 0
  to 1 px). Few pixels, 0 to 16, differ, on thin dotted beams or a ship cut off by the view's edge, and they sit far from the
  masks' centre; the centroid is taken on the strict masks, so a handful of dots far out move it. The tolerant IoU is 0.985 to 1.000.
  The last two kinds were not run against the emulation; they are classed from the pixels that differ.

#### Frame rates (Plan 31)

`npm run perf` (headed Chromium, battles 82 and 8), on an Apple M5 Pro (16-core GPU). Targets: desktop 60 fps, Pixel 7
30 fps. All four are over. The frame counter reads 120, the display's refresh, so the figures are capped by vsync and
show headroom rather than a ceiling. The Pixel 7 profile is Playwright's emulation (its viewport, scale and touch) on
the same Mac, not the phone's GPU. Battle 82 is the busy one: 122 calls and 3,156 triangles in its busiest frame. Its
worst frame on the desktop, 599.4 ms (35.0 ms on the Pixel 7 run), falls inside the timed minute: the sampler drops
the warm-up and the first frame after it. So it is a hitch during the battle, not the start-up. Its cause is not yet
looked into; a first use of a shader or a texture is the likely suspect.

```
perf desktop battle 82: 118.7 fps, p95 10.2 ms, worst 599.4 ms, 122 calls, 3156 triangles
perf desktop battle 8: 120.0 fps, p95 10.2 ms, worst 16.6 ms, 19 calls, 602 triangles
perf Pixel 7 landscape battle 82: 119.9 fps, p95 10.2 ms, worst 35.0 ms, 122 calls, 3156 triangles
perf Pixel 7 landscape battle 8: 120.0 fps, p95 10.2 ms, worst 10.4 ms, 19 calls, 602 triangles
```
