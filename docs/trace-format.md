# Trace format

A trace is what one engine did during a run: actions, the rules they ran, the
state those rules changed, and what was said. The ScummVM engine writes it on
the private `unity-export` branch (Plan 3). `tools/tracediff` maps it through
`ids.yaml` into a model it shares with the TypeScript engine's own record of
the same walkthrough, and compares the two (`docs/tracediff.md`).
`tools/rawcheck/src/trace.ts` holds the schema.

## Running it

From the debugger console, or a harness script (`tools/rawcheck/harness/trace`):

```
trace <file> [seed]     start tracing to a file (native path); a seed reseeds the game's RNG
trace off               write "end" and close the file
```

```sh
sh tools/rawcheck/run-harness.sh trace 300
TRACE_FILE=$HOME/pcode/unity-raw/runs/trace/trace.jsonl npx vitest run tools/rawcheck/src/live-trace.test.ts
```

## Lines

One JSON object per line. Every event has `seq` (0, 1, 2…, with no gaps)
and `ev`. Nothing in a trace depends on the wall clock, except in a battle
(see "Space combat"): the `ships` event's `now` is setup's `getMillis()`
(`combat.cpp:159`), and the snapshots' `now` counts on from it; the `combat`
event's system timers (`lastTick`, `lastReactorTick`, and each unit's
`nextStep` and `nextRepair`) are the game clock's; and a 0x10 hail's
`removeTimes` are `getMillis()` too (`tactical.cpp:427`). So a battle's run
isn't reproducible from its seed alone: its end step and its atan2f calls can
move from run to run. The replay takes each of these values from the trace,
never from its own clock (docs/tracediff.md). Ids are `wwssii` as
in the raw IR, and flags are the original's `RESULT_*` values.

| `ev` | Fields | When |
|---|---|---|
| `begin` | `version` (1), `engine` (`"scummvm"`), `seed` | first; `seed` is the RNG's state, which seeds Plan 1's `Rng` |
| `end` | | last (`trace off`, a walkthrough's end, or shutdown) |
| `seed` | `seed` | the RNG was reseeded (a walkthrough's `seed` line) |
| `load` | | a saved game (or, on restart, the starting state) was loaded; the loaded state is the new baseline, so what the load changed isn't logged. What happens on going back to the saved screen follows it |
| `action` | `verb` (use, get, look, timer, walk, talk), `target` (or null), `who`, `other`, `x`, `y`, `depth` (1 outermost) | `performAction` starts |
| `actionEnd` | `verb`, `target`, `flags`, `depth` | `performAction` returns |
| `group` | `list`, `index`, `passed`, `flags` | a group's conditions were checked: `passed` says whether its results run |
| `entry` | `list`, `group`, `index`, `class`, `flags` | a result entry ran (`index` in execution order); logged after it runs, so the actions, groups and lines a CommandBlock or ReactionBlock set off come before it |
| `obj` | `id`, `field`, `from`, `to`, and `walking` for `x`/`y` | an object changed (see below) |
| `response` | `conv`, `index`, `id`, `state`, `from`, `to` | a response's state changed (1 set, 2 enabled, 3 disabled, 4 locked) |
| `triggerState` | `id`, `enabled` | a trigger was enabled or disabled |
| `region` | `world`, `screen`, `region`, `type` | a script changed a walk region |
| `counter` | `entry`, `from`, `to` | a condition's counter changed |
| `startup` | `world`, `screen`, `field`, `from`, `to` | a screen's startup changed |
| `global` | `key`, `from`, `to` | the advice, away-team flags, team, current member, phaser gauge, beam-down target, pending hail or new-warp-movie flag changed |
| `shipUnit` | `index`, `name`, `field` (`damage`), `from`, `to` | a ship unit's damage changed |
| `trigger` | `id`, `target` | a trigger fired (its target's USE follows) |
| `timer` | `object` | an object's timer fired (its TIMER action follows) |
| `screen` | `world`, `screen`, `entrance` | the away team arrived on a screen (entrance flags included) |
| `ship` | `code` | the game went to a ship screen (low byte the screen, high byte a parameter) |
| `rng` | `site`, `max`, `value` | a game-state random number was drawn |
| `say` | `who`, `text`, `voice` | a line was said (`voice` is the `.vac` file, or empty) |
| `choice` | `kind` (`menu` or `box`), `question`, `options`, `picked`, `scripted` | a walkthrough answered a choice (`picked` -1 cancels) |
| `movie` | `id` (null if movie.map doesn't list it), `file` | a movie was played (or skipped by a walkthrough), including warp movies |
| `step` | `line`, `text` | a walkthrough line starts |
| `refused` | `who` | a walkthrough gave a command to a member who is down |
| `error` | `what` | a walkthrough stopped |

## State changes

State changes come from comparing snapshots, not from hooks on every write.
At each checkpoint, the tracer compares:

- every loaded object's `curr_screen`, `flags`, `state`, `x`, `y`, `z`,
  `y_adjust`, `universe_x/y/z`, `timer`, `anim_index`, `sprite_id`, `name`,
  `talk_string`, `use_verb`, `use_preposition`, `voice_id`, `voice_group`,
  `voice_subgroup`, `cursor_id`, `cursor_flag`, its phaser `health`,
  `stunned` and `destroyed`, and whether it's in the inventory (`obj`);
- every loaded conversation's response states (`response`);
- every condition's counter, which checking it counts down
  (`object.cpp:1158-1170`), by the entry's path, such as
  `o_070103#/use_entries/0/0` (`counter`);
- every trigger's `enabled` (`triggerState`) and the region overrides (`region`);
- every loaded world's screen startups, which ScreenBlocks change (`startup`;
  ids as `world << 16 | screen << 8 | id`);
- the advice (`adviceId`, `adviceInterval`), the away-team flags (`combadge`,
  `inputBlocked`, `closeup`), the team (`team`: ids, comma-separated), the
  current member (`member`), the phaser gauge (`phaserIndex`), where the
  transporter will send the team (`beam`: `"world,screen"`, which BeamBlocks
  set), the hail waiting for the bridge (`pendingHail`:
  `"target,conversation,situation,type"`, with the target as `wwssii` and
  type 255 for none, which CommunicateBlocks set) and whether the next warp
  shows a new movie (`newWarpMovie`, which a GeneralBlock's command 1xxx sets) (`global`);
- each ship unit's `damage` (`shipUnit`).

Some state that scripts change isn't traced. It only matters on the ship's
screens, which the away-mission slice doesn't reach:

- the timer triggers' restart (a GeneralBlock's command 4xxx sets every
  enabled timer trigger's `target_time` to 0): it's a wall-clock time in milliseconds, and
  a trace has no wall clock;
- astrogation's reveal flags (command 2xxx sets `0x10` in
  `Astrogation::_flags`);
- the computer's hidden entries (commands 9xxx and 10xxx, via
  `ComputerScreen::setHidden`).

A checkpoint runs:

- after each `group` (checking conditions counts their counters down, so
  those changes follow the group),
- after each `entry` (so what an entry changed follows it),
- before each `action`, `actionEnd`, `trigger`, `timer`, `screen`, `ship` and `step`,
- and before `end`.

`screen` is logged as `startAwayTeam` begins, so the team's placement and
the screen's startup changes show at the next checkpoint, after it.

An object, conversation or world's startups loaded since the last checkpoint
is compared with a fresh parse of its file, so loading something is never a
change. `walking`
is true when the object still has a walk path: the TypeScript engine moves
between markers, so `tools/tracediff` compares where walks end, not every step.

## List paths

`group` and `entry` events name their list as a JSON pointer into the raw IR:
`o_070103#/use_entries`, `o_070103#/phaser_data/stun_entries`, a choice's
branch as `o_070100#/use_entries/0/2/_choice/1`, and a conversation's result
as `w007c000#/responses/3/results/0`. `?` would mean the tracer couldn't find
the list, which the checker rejects.

## Random numbers

The engine's `_rnd` carries only game-state draws. Each one goes through
`gameRandom`, which logs an `rng` event. The draws that only change how
things look or sound use `_presentationRnd` and aren't traced: sprite random
waits, dissolves, the viewscreen planet, beam-down music, Riker's walk-on,
warp movie replays, the globe's colours and the tactical starfield. Animation
timing can then never shift a game-state draw. `begin` logs `_rnd`'s state,
and Plan 1's `Rng` started from it returns the same `value` for each `max` in
order (`checkRng`).

| `site` | Where | `max` |
|---|---|---|
| `skill` | `object.cpp` `passesSkillCheck`, per short digit | 255 |
| `reactMember` | `object.cpp` ReactionBlock target type 7 | members - 1 |
| `reply` | `conversation.cpp` `Response::execute`, which reply | replies - 1 |
| `situation` | `talk.cpp` `sayString`, `@id,?n` | n |
| `advisor` | `talk.cpp` `updateAdvice`, who offers advice | advisors - 1 |
| `stepInX`, `stepInY` | `awayteam.cpp` `placeAwayTeam`, entrance flag 0x80, x then y per member | 2 |
| `chatterFederation`, `chatterRomulanGate`, `chatterRomulan`, `chatterNonaligned`, `chatterNebula` | `astrogation.cpp`, the crew's remarks on entering a region | varies |
| `hazard` | `astrogation.cpp`, black hole and vortex damage | 99 |
| `combatSeed` | `combat.cpp`, the battle's own generator | 0x7fffffff |

The battle's own generator (`AstroRandom`, seeded by `combatSeed`) is traced
apart, as `roll` events: see "Space combat".

## Walkthroughs

A walkthrough is a text file of the player's actions. Both engines play it:
ScummVM with `walkthrough <file> [quit]` (usually after `trace <file> <seed>`),
and the TypeScript engine through `tools/play`'s `Play` (Plan 6, with ids
mapped through `ids.yaml`). One line per step; `#` starts a comment.

| Line | ScummVM does | `Play` does |
|---|---|---|
| `start <world> <screen> [entrance]` | `startAwayTeam`, with the first four crew and the ship's kit | loads the game at that screen |
| `look <who> <target>` | selects `who`, cancels their queued actions, `handleLook` | `look(who, target)` |
| `talk <who> <target>` | the same, `handleTalk` | `talk(who, target)` |
| `walk <who> <target>` | the same, `handleWalk` | `walk(who, target)` |
| `get <who> <target>` | the same, `performAction(ACTION_GET)` | `get(who, target)` |
| `use <who> <target> [other]` | the same, `handleUse(target, other)` | `use(who, target, other)` |
| `combadge <who>` | the same; then, if the combadge is on, asks "Do you wish to contact the ship?" (the next `answer`) and on Hail uses the communicator, as the click does (`awayteam.cpp:824-831`); nothing while it's off | `combadge()` |
| `answer <0\|1>` | queues the answer to the next message box (ChoiceBlock) | `answer(n)` |
| `pick <n\|cancel>` | queues the pick for the next conversation menu | `pick(n \| null)` |
| `phaser <0-3>` | sets the phaser (gauge position n × 4) | `setPhaser(n)` |
| `advance <seconds>` | waits that long | `advance(seconds)` |
| `seed <n>` | reseeds the game's RNG (logs `seed`) | reseeds `Rng` |
| `end` | ends the walkthrough (writes `end` and quits, with `quit`) | |

Numbers are decimal, or hex after `0x`, with no sign; an `advance` is at
most 3600 seconds. Each step runs once the game has settled and the last step
has returned: no dialog, no action, conversation or line running, no screen
change pending, nothing queued, nobody walking. While a walkthrough
plays, ScummVM doesn't show lines (they're logged as `say`), takes choices
from the queues (logged as `choice`), and skips movies (logged as `movie`).
A step whose member is down is `refused`, as a click would be. These all end
the walkthrough with an `error` event: an unknown or malformed line, an
object that doesn't exist (or, for `Play`, one `ids.yaml` doesn't name), a
member not on the team, a choice with nothing
queued or a pick past its options, and 60 seconds without settling.

## Space combat

A battle fought while a trace runs adds its own events (Plan 22). They are
step-based: `step` counts the battle's steps of 66 ms (`kCombatStepTime`), 0
before the first. `tools/tracediff`'s `combat` command replays the battle in
the port and compares the two (`docs/tracediff.md`, "Space combat");
`tools/rawcheck/src/trace.ts` holds the schema, and its `checkCombatRolls`
replays every draw from the seed.

While a trace runs, the battle's clock is the step clock: each frame's update
runs exactly one step (`now` is the last step's time plus 66 ms), so a battle
plays the same at any frame rate. After the warp overlay (`warp`), the next
update also skips the overlay's wait, as ScummVM's own clock does
(`combat.cpp:411-412`). The radar draws once a frame, before the update, and
asks the sensors each time (`checkSensors`, `tactical.cpp:1111-1113`): one
sensor roll a step at most, unless the view is wide or the Enterprise is lost.

| `ev` | Fields | When |
|---|---|---|
| `combat` | `scenario`, `difficulty`, `delegate`, `lastDifficulty`, `astrogation` (`[x, y, z]`), `enterprise` (`units` as `[current, target, max, damage, repair, nextStep, nextRepair]`, `pool`, `torpedoes`, `matterAntimatterOutput`, `fusionOutput`, `lastReactorTick`, `lastTick`), `objects` (the battle screen's: `id`, `active`, `state`) | `TacticalScreen::start` begins a battle, before Delegate's Ensign rule and `Combat::setup`; the `rng` `combatSeed` draw follows |
| `ships` | `now` (the battle clock at setup, ms), `ships` (`index`, `type`, `id`) | setup has made the ships; step 0's `snap` follows |
| `roll` | `step`, `site` (`file.cpp:line` of the call, in the unity-engine branch's lines), `n` (the bound, -1 for `next()`), `value` | every `AstroRandom` draw in combat |
| `snap` | `step`, `now`, `exit` (65535 for none), `target` (-1 for none), `redAlert`, `delegate`, `weaponsLock`, `shieldsRaised`, `powerLevel`, `kernelReady`, `random` (the generator's state), `camera` (where updateCamera put the camera: `pos`, `axes`, its rows right, down and forward as nine floats, and `view`; Plan 25), `ships` (`index`, `pos`, `velocity`, `angles`, `speed`, `condition`, `flags`, `destroyed`, `removed`, `target`, `engaged`, `removeTime`, `units` as `[current, target, max, damage, repair]`, `pool`, `torpedoes`), `torpedoes` (the active ones: `slot`, `pos`, `angles`, `shooter`, `target`, `expiry`) | at step 0, after every 15th step, at a `leave` and at the run's end |
| `hails`, `hailsEnd` | `step`, `site` (where processHails was called from) and `type` (the pending hail's); then `result`, `type`, `exit`, `redAlert`, `removeTimes` (each ship's) | `TacticalScreen::processHails` begins and returns: after the Enter object's USE, each hook (`damage.cpp:672`, `693`, `713`, `731`), a hail (the trace logs the export's `tactical.cpp:462`, which is the unity-engine branch's `tactical.cpp:450`) |
| `standDown` | `step`, `site` | `TacticalScreen::standDown` |
| `leave` | `step`, `code` | `TacticalScreen::leave`: the battle leaves the screen; what follows (endCombat) is the world's and isn't logged |
| `warp` | `step`, `wait` (ms) | `TacticalScreen::showWarp`'s overlay |
| `input` | `step`, `line` | the harness played a scripted input (below) |
| `atan2` | `step`, `site`, `s`, `c`, `angle` (ScummVM's), `rounded` (`atan2` in double, rounded to a float) | `angleFromSinCos`, only where the two angles differ |
| `combatEnd` | `step`, `reason` (`leave`, `won`: only the Enterprise is left, or `cap`) | the harness's `fight` ends |

Floats are printed with nine significant digits, which read back to the same
float32. Every `roll` site is a line of the unity-engine branch: the export's
trace hooks add no line to `ai.cpp`, `tactics.cpp`, `weapons.cpp` or
`damage.cpp` (each draw's file and line come from `Combat::rnd`'s default
arguments). The other sites (`hails`, `standDown`, `atan2`) are the export's
lines, which its hooks move in `tactical.cpp` and `combat.cpp`.

### Scripted inputs

The harness (`tools/scummvm-harness/harness.inc`) plays a battle with:

```
difficulty <0-2>               the game's difficulty (UnityEngine::difficulty)
activate <wwssii> <0|1>        an object's OBJFLAG_ACTIVE
ship 7 <battle>                the battle (kShipTactical)
at <step> <input>              an input, once the battle has taken that many steps
fight <cap>                    plays the battle, the at lines at their steps, to its end or <cap> steps
```

An input is one line of the engine's `parseInputLine` grammar
(`engine/src/sim/combat/inputs.ts`): `steer <yaw> <pitch> <roll>
<throttle>` (each -1, 0 or 1), `orbit <-1|0|1>`, `stop`, `fire
phasers|torpedoes|both`, `target next|prev|none|<ship>`, `delegate on|off`,
`maneuver <row>`, `scroll up|down`, `engage`, `hail`, `bridge`,
`engineering`, `view <view> enterprise|target`, `cycle`, `zoom in|out`, `wide
on|off`, `page <page>`, and `set banks all|none`, `set bank <0-5> <0-100>`,
`set salvo <0|1> <0-10>`, `set spread <0-9>`, `set shields on|off`, `set lock
on|off`, `set power <0-4>`, `set selfdestruct`. Each calls what the player's
key, button or click calls, without the buttons' delay. The port's grammar is canonical and a strict subset of what the harness accepts (the harness reads numbers with atoi, takes any other word as off, none or both, except `target <word>`, which atoi reads as ship 0, the Enterprise, and ignores trailing tokens); `combat-script` checks every script with `parseInputScript` before any harness run, so the harness's leniency never reaches a run. `target <ship>` past the last ship changes nothing in either: the harness ignores it (though it still logs the input), and so does the port's `applyCommand`. `engineering` is in the grammar, but the harness can't play it: ScummVM's battle waits while the engineering screen is open (`unity.cpp:285-286`), and no input leaves that screen, so `fight` would stall until its cap or the run's timeout. `combat-script` refuses a script that has it. `fight` checks, each
frame before the draw and the update: the battle has left the screen
(`leave`), only the Enterprise is left (`won`), or `<cap>` steps (`cap`);
else it plays the inputs due. It does nothing from a hook inside a step (the
warp overlay's wait, `ai.cpp:246`, or a hook's conversation), and clicks a
conversation through (its first choice taken) wherever one opens, an input's
hail included. Once the battle has left, though, `fight` ends at once, from
whatever hook it is in (a step's, a conversation's or a menu's): the leave's
aftermath (endCombat's destroyed hooks, the Exit object's conversation, the
game's end after a self-destruct) comes after `combatEnd`, or not at all once
`quit` runs. Without a running trace, `fight` stops the run with a message.
While `fight` waits (a conversation's click, the warp overlay, the battle's
start), the battle keeps stepping, so an input or the cap can land a few
steps after its `at` or `<cap>`. The trace's `input` and `combatEnd` events
record the step each really landed at, so the replay stays consistent with
ScummVM's run.
