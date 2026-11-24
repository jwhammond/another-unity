# Raw IR

The raw IR is A Final Unity's data as the ScummVM engine parses it, written
as JSON by the `export` console command on the private `unity-export` branch
(Plan 3). The lifter (Plan 4) reads it. `tools/rawcheck/src/ir.ts` holds the
same shapes as zod schemas, strict, so the C++ writer and this document can't
drift apart unnoticed.

## Running it

```sh
sh tools/rawcheck/run-harness.sh export 300      # ScummVM writes $HOME/pcode/unity-raw/runs/export/raw
RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw npx vitest run tools/rawcheck/src/live-export.test.ts
```

From the debugger console it's `export <dir>`. The export reads every file
again into fresh structures, so it can run at any point in a game, and it
leaves the game as it was.

## Conventions

- **Keys are the C++ member names**, exactly as spelled (`_order`, `WhoCan`,
  `_choicestring`). An entry's `class` key is the extra one: its C++ class.
- **Numbers are raw.** `65535`, `255` and `4294967295` (0xffff, 0xff,
  0xffffffff) usually mean "none" or "unchanged". The lifter decides that,
  not the export.
- **Object ids** are six lowercase hex digits, `wwssii`: world, screen and id,
  as the console prints them. `ffffff` is "no object". (An `objectID`'s `unused` byte,
  always 0 or 0xff, isn't represented.)
- **Strings are the game's bytes.** Printable ASCII is as it is, and every
  other byte is `\u00XX`, so nothing is lost, whatever the code page.
- **Signed fields.** An object's `width`, `height`, `x`, `y`, `z` and
  `universe_*` are int16 in the file. ScummVM keeps them in unsigned ints, and
  the export writes them as int16 again, so -1 means none.
- **Only what the parser keeps.** Bytes that ScummVM's parsers skip aren't
  exported. "Not exported" at the end lists every one.

## manifest.json

| Key | Meaning |
|---|---|
| `format` | `"another-unity/raw-ir"` |
| `version` | `1` |
| `generator` | `"scummvm unity-export"` |
| `objects` | every `o_wwssii.bst` in the archive, as `wwssii`, sorted |
| `conversations` | every `wWWWcNNN.bst` (world in hex, id in decimal), as `wWWWcNNN`, sorted |
| `screens` | every screen with an object list (`wWWSSobj.bst`), an entry in `slNNN.scr`, or both, as `s_WWSS`, sorted |
| `worlds` | every world with a start file (`w_WWstrt.bst`), as `w_WW`, sorted |
| `files` | every file the export wrote, relative to the output directory, sorted (the manifest excepted) |

## objects/o_wwssii.json

One file per `o_wwssii.bst`, read by `Object::loadObject` (and `loadPhaserData`
for objects in `phaser.map`) into a fresh `Object`.

| Key | C++ | Meaning |
|---|---|---|
| `id` | `objectID id` | this object |
| `curr_screen` | `byte` | the screen it starts on |
| `width`, `height` | `int16` | its size, for hotspots and placement; -1 none |
| `x`, `y`, `z` | `int16` | its position in screen pixels (`z` is unused by the away team) |
| `universe_x/y/z` | `int16` | its position in space (ships, planets) |
| `y_adjust` | `int16` | draw depth; -1 means "use y" |
| `anim_index` | `uint16` | the sprite animation it starts with; 0xffff the first; other values above 0x7fff hide it |
| `sprite_id` | `uint16` | index into `sprite.lst` (`maps/sprite.json`); 0xffff or 0xfffe none |
| `region_id` | `uint32` | a region number (unused by the away-team code) |
| `flags` | `byte` | 0x01 walk, 0x02 use, 0x04 talk, 0x08 get, 0x10 look, 0x20 active, 0x40 inventory, 0x80 stunned |
| `state` | `byte` | the script-visible state |
| `objwalktype` | `byte` | 0 normal, 1 scaled walker (characters), 2 transition square, 3 action square |
| `name` | 20 chars | display name |
| `transition` | `objectID` | for a transition square, the object a WALK uses |
| `skills` | `uint16` | four hex digits of skill levels, checked digit by digit |
| `timer` | `uint16` | seconds between TIMER actions; 0 or 0xffff none |
| `talk_string` | 100 chars | what TALK says: plain text, `@…` conversation, `!` advice, `^n` screen text, `~n` tricorder, `\|` description; the `-verb-preposition-` suffix removed |
| `use_verb`, `use_preposition` | | the words from that suffix, if any |
| `voice_id`, `voice_group`, `voice_subgroup` | `uint32`, `uint32`, `uint16` | the talk string's voice |
| `cursor_id`, `cursor_flag` | `byte` | cursor shown over it |
| `descriptions` | `Description[]` | file order; `entry_id` is the crew member (0-8) it's for, then `text` and its voice (all `uint32`) |
| `use_entries`, `get_entries`, `look_entries`, `timer_entries` | `EntryList` | the scripts for each verb |
| `phaser_data` | `PhaserData *` | `null`, or `max_health`, `threshold` (down at or below), `damage_setting` (lowest damaging setting), `gtp_setting`, `gtp_min_setting` (all `int8`), and `stun_entries`, `gtp_entries`, `kill_entries` |

## Entry lists

An entry list is an array of **groups**, and a group is an array of
**entries**. Each group is in **execution order**: `EntryList::readEntryList`
sorts it as it reads it (`sortLastEntry`: a condition stays where the file put it and is never moved past; the results after it are stably sorted by `_order`), and the file order isn't kept. Every entry has:

| Key | C++ | Meaning |
|---|---|---|
| `class` | | the C++ class |
| `_order` | `int8` | where its effect runs among the group's results |
| `_stopHere` | `byte` | 0, 1 or 0xff; non-zero stops the list after this group (a condition's is always 0: the parser, `ConditionBlock::readFrom` in object.cpp, overwrites the file's byte with 0) |

Then, by class (all numbers unsigned unless noted):

- **ConditionBlock** (0x06): `target`, `WhoCan` (who may act), `how_close_dist`, `how_close_x`, `how_close_y`, `skill_check`, `counter_value` (u16), `counter_when` (u8), and four checks as parallel arrays of 4: `condition` (object ids), `check_x`, `check_y`, `check_unknown`, `check_univ_x`, `check_univ_y`, `check_univ_z` (u16), `check_screen`, `check_status`, `check_state` (u8).
- **AlterBlock** (0x07): `target`, `alter_flags`, `alter_reset`, `alter_state` (u8), `x_pos`, `y_pos` (u16), `alter_name` (20), `alter_hail` (100: a new talk string), `alter_timer`, `alter_anim` (u16), `play_description` (u8), `y_adjust` (u16, also the new z), `cursor_id`, `cursor_flag` (u8), `universe_x/y/z` (u16), `voice_id`, `voice_group` (u32), `voice_subgroup` (u16).
- **ReactionBlock** (0x08): `target`, `dest_world`, `dest_screen`, `dest_entrance` (u16), `target_type` (1 actor, 3 team on screen, 6 `target`, 7 random member, 0xff nothing), `action_type`, `damage_amount`, `beam_type` (u8), `dest_x`, `dest_y`, `dest_unknown` (u16).
- **CommandBlock** (0x09): `target` (3 ids: target, who, other; who 0x10 is the current member, 0x20 the actor), `target_x`, `target_y` (u16), `command_id` (u32: 2 look, 3 get, 4 walk, 5 talk, 6 use).
- **ScreenBlock** (0x10): `new_world` (u16), `new_screen`, `new_entrance`, `advice_screen` (u8), `new_advice_id`, `new_advice_timer`, `startup_screen` (u16), `startup_target`, `startup_action` (u8), `startup_who`, `startup_other`, `startup_x`, `startup_y` (u16), `flags_screen` (u16), `combadge`, `closeup`, `input_blocked` (u8).
- **PathBlock** (0x11): `regions_on`, `regions_off` (4 region numbers each; 0xff none).
- **GeneralBlock** (0x13): `movie_id` (movie.map), `sound_id` (`_presetSounds`), `command` (type × 1000 + value).
- **ConversationBlock** (0x14): `world_id`, `conversation_id`, `response_id`, `state_id`, `action_id` (2 enable, 3 disable, 4 lock).
- **BeamBlock** (0x15): `world_id`, `unknown1`, `unknown3`, `screen_id`.
- **TriggerBlock** (0x16): `trigger_id` (u32), `enable_trigger` (bool).
- **CommunicateBlock** (0x17): `target`, `conversation_id`, `situation_id` (u16), `hail_type` (u8).
- **ChoiceBlock** (0x18): `_boxX`, `_boxY` (u16), `_object` (whose icon), `_questionstring` (100), `_choicestring` (2 × 16 chars), `_choice` (2 entry lists, one per button; each group is one block run).

## conversations/wWWWcNNN.json

One file per `wWWWcNNN.bst` (world in hex, number in decimal), read by
`Conversation::loadConversation` into a fresh `Conversation`.

| Key | C++ | Meaning |
|---|---|---|
| `id` | | `wWWWcNNN` |
| `our_world`, `our_id` | `uint` | the world and number |
| `responses` | `Response *[]` | file order (a menu lists its candidates back to front) |

Each response:

| Key | C++ | Meaning |
|---|---|---|
| `id`, `state` | `uint16` | the situation the response belongs to (`id`: `Conversation::execute` offers the responses whose `id` is the situation) and its key within it (`state`: `setState` and the change actions match both) |
| `text` | 255 chars | what the speaker says (a menu line); a `" @hex@"` voice tag is moved to `voice_tags` |
| `voice_tags` | | for voice group 0xfd: each speaker's voice, from the tag |
| `response_state` | `byte` | 1 set (enabled once a conversation starts here), 2 enabled, 3 disabled, 4 locked |
| `next_situation` | `uint16` | the situation that follows; 0xffff ends the conversation |
| `target` | `objectID` | who replies |
| `voice_id`, `voice_group`, `voice_subgroup` | `uint32`, `uint32`, `uint16` | the text's voice |
| `whocansayblocks` | `WhoCanSayBlock *[]` | `{ whocansay }`: who may say it |
| `textblocks` | `TextBlock *[]` | the replies: `text` (255), `continued` and its voice. A `'>'` at byte 0xfd of the 255-byte field is stripped (the text is cut to 0xfd chars) and sets `continued`: the text carries on in the next block |
| `changeactions` | | `type` (0x30 disable, 0x31 set, 0x32 enable, 0x33 lock), `response_id`, `state_id` |
| `results` | `EntryList *[]` | entry lists run after the reply, in file order |

## screens/s_WWSS.json

One file per screen. The object list comes from `listScreenObjects`
(`wWWSSobj.bst`), the location from `readScreenLocation` (`slNNN.scr`), and
the polygons from `loadScreenPolys`.

| Key | Meaning |
|---|---|
| `id`, `world`, `screen` | `s_WWSS`, and its world and screen numbers |
| `objects` | the ids in the object list, in file order, or `null` without one |
| `location` | `null` if `slNNN.scr` doesn't list the screen; else `background` (the `.scr` image), `polygons` (the polygon file), and `entrypoints`: for each entrance, the 4 places the team members stand. ScummVM's Pascal strings keep the file's trailing NUL, so both names end in `\u0000`. |
| `polygons` | in file order: `id`, `type` (0 not walkable, 1 walkable, 3 and 4 other kinds), `points` (`{x, y}`), `distances` (one per point: 0-256, the walker's scale there, higher is nearer). Empty without a location, and for the three located screens whose polygon file isn't in the game (`s_0202`, `s_0215`, `s_050b`). |

## worlds/w_WW.json

| Key | Meaning |
|---|---|
| `id`, `world` | `w_WW`, and the world's number |
| `startups` | every 45-byte record of `w_WWstrt.bst`, indexed by screen: `advice_id`, `advice_timer` (u16), `closeup`, `combadge`, `input_blocked` (u8), `screen` (u16; 0xffff no startup action), `target`, `who`, `other`, `action` (u8: 0 use, 1 get, 2 look, 3 get, 4 walk, 5 talk, 6 use, as `kStartupActions` in `awayteam.cpp`; above 6 is a warning and no action), `x`, `y` (u16) |
| `advice` | `null` without `wWWWa000.dat`; else, by advice id (a decimal string), `easy` and `hard`: the lines `{ name, text }` in file order, where `name` is a crew member's name from `_adviceNames` |

## triggers.json

`trigger.dat`, read afresh by `loadTriggers`, in file order. Each trigger
has `id` (u32), `type` (0 normal, 1 timer, 2 proximity, 3 unused), `target`
(the object whose USE runs), `enabled`, `context` (0 ship, 1 away team), and
`timer_start` (seconds, for timers). Proximity triggers also have `dist`,
`from`, `to`, `reversed` (fire when outside) and `instant`. Other triggers
have `null` for those, because ScummVM leaves them unset.

## maps/*.json

| File | Keys |
|---|---|
| `maps/phaser.json` | `_phaserableObjects`: phaser.map's ids in file order |
| `maps/icon.json` | `_iconSprites`: icon.map, id → sprite file (the first entry for an id wins, as in the game) |
| `maps/movie.json` | `movies`: movie.map in file order, `{ id, filename, description }` |
| `maps/sprite.json` | `_spriteFilenames`: sprite.lst, indexed by an object's `sprite_id` (add `.spr`) |

## executable.json

The tables `loadExecutableData` reads from `sttng.ovl` that away missions use.
The keys are `UnityData`'s members: `_presetSounds` (GeneralBlock
`sound_id` → file), `_adviceNames` (crew id → name in advice files),
`_crewVoices`, `_leaderOrder`, `_awayTeamScreenData` (`defaultMembers`,
`inventoryItems`), `_failHailEntries` (`actionId`, `source`, `failFlag`,
`hail`), `_actionStrings`, `_transporterTargets` (`{x, y}` by world),
`_tricorderReadings` (`key` = world × 10000 + reading, `parent`, `entry`),
`_computerEntryIds` and `_backgroundSoundDefaults` (`formatString`, `first`,
`last`: each world's beam-down music), `_phaserMuzzles` (`x`, `y`, `frame`:
where the beam starts, for each crew member then direction), the beam-down's
transporter room: `_transporterPads` (`rect`, `stand`, `scale`),
`_transporterSpriteNames`, `_transporterWalkOn` and `_transporterWalkOff`
(`x`, `y`, `direction`, `scale`), and `_arrowCursor` (`width`, `height`,
`hotspotX`, `hotspotY`, `pixels`, where 13 is transparent). The ship's
tables follow (Plan 10), which the browser engine's ship modes lift:

| Key | Element |
|---|---|
| `_bridgeItems` | `id`, `x`, `y`, `width`, `height`, `action`, `depth`, `description` |
| `_bridgeObjects` | `id`, `x`, `y`, `depth`, `filename` |
| `_bridgeScreenEntries`, `_transporterExits` | `code` (the ship screen it goes to), `text` |
| `_warpSpeeds`, `_impulseSpeeds` | one number per speed setting |
| `_sectorRegions` | one region per sector, 512 (8x8x8) |
| `_regionChatter` | numbers, as `loadExecutableData` reads them |
| `_astroReveals` | one astro thing id per scripted reveal (a story script's `reveal n`) |
| `_warpMovies` | the warp movies' file names, by index (index 0 is not a movie; they play from 1) |
| `_encounterThresholds`, `_hazardDamage`, `_hazardVoices` | the encounter and hazard tables, exported for after M4 (the lifter ignores them) |
| `_shipUnits` | `name`, `type`, `depth`, `paletteIndex`, `current`, `target`, `max`, `chargeTicks`, `dischargeTicks`, `damage`, `repair`, `baseDamage`, `maxDamage`, `efficiency`, `hitWeight`: the template `ShipSystems::load` reads |
| `_enemyShip` | the 20 units every ship but the Enterprise starts with (`ENEMY_UNIT_OFFSET_DOS`, data.cpp:825), as `_shipUnits` |
| `_combatShips` | by combat type, 11: `base` (the model and tactics files' name), `maxSpeed`, `detailDistance`, `reducedDistance` (data.cpp:827-836) |
| `_flightTurns`, `_flightSpeeds`, `_flightTurnScales` | the flight model: 84 int32, 40 and 24 float32 (data.cpp:838-846); floats are written with nine significant digits, so `Math.fround` gives the float back |
| `_cues` | the crew's cues, 0x84: `speaker`, `filename` (`''` for none), `gap` in ticks (data.cpp:814-824) |

## ast_stat.json

`_flags`: the `count` words at `offset` 0x6e2 of `ast_stat.dat`, the starting
flags of every star, phenomenon, station and special in `astro.db` (1
charted, 4 and 8 visited, 0x10 revealed), as `Astrogation::load` reads them.

## combat.json

What space combat reads that isn't in `sttng.ovl`: five power presets, the archive's media list, and the constants ScummVM hard-codes. Each constant is `{ source, value }`, where `source` is `<file>.cpp:<from>[-<to>]` in the `unity-engine` branch (`~/pcode/scummvm/engines/unity`); `live-constants.test.ts` checks the values are still on those lines.

| Key | What |
|---|---|
| `_powerLevels` | `level0.dat`-`level4.dat`, the CONN page's five power levels: every int32 of each file, one per Enterprise unit (`Combat::setPowerLevel`, weapons.cpp:647-656) |
| `archive` | every `*.spr`, `*.mac`, `*.rac`, `*.pic` and `*.mrg` in the archive, lowercase and sorted; `raceFile` takes a race's own file only if it is here (weapons.cpp:92-99) |
| `kShipKinds` | by combat type, 10: `name` and `flags` (combat.cpp:35-49) |
| `kContactCues`, `kDestroyedCues`, `kTargetCues` | the cue each type's contact, destruction and targeting plays, per type; -1 for none (combat.cpp:245, damage.cpp:607-609, ai.cpp:138) |
| `kSurpriseObjects` | the battle `screen` and the object `ids` that are a surprise (combat.cpp:197-199) |
| `kEnterpriseHitLists`, `kOtherHitLists` | the units a hit on each area can reach, 8 and 6 rows (damage.cpp:36-53) |
| `kRaceBits`, `kRaces` | the race file bits, and each type's file `letter` and `mask` (weapons.cpp:35-48) |
| `kEnterprisePhasers`, `kOtherPhasers` | phaser emitter positions, 6 and 2 rows of x, y, z (weapons.cpp:51-54) |
| `kWeaponUnits` | the units that fire the phasers and photon tubes (weapons.cpp:55-58) |
| `kTacticOverrides` | objects whose tactics file isn't their type's: `object` and `file` (tactics.cpp:95-106) |
| `kClassNames`, `kScannerImages`, `kRadarColours` | the tactical display's class names, scanner images and radar colours, per type (tactical.cpp:213-217, 232) |
| `kEnterpriseAreas`, `kOtherAreas` | the units in each of the 11 areas of the damage display (tactical.cpp:219-226) |
| `kBearing` | by the target's facing (0-7), the three lamps that bear on it: banks 0-5, tubes 6-7, -1 for none (weapons.cpp:738-740) |
| `kShieldNames` | the Enterprise's eight shields by facing, as its log names them (damage.cpp:55-58) |
| `kCueIds` | every crew cue combat plays by a literal id, by name: each `{ source, value }`, `source` the line that plays it (65; another-unity Plan 23 R1). The cues played from a table are `kContactCues`, `kDestroyedCues` and `kTargetCues`; the power level's is the level itself (weapons.cpp:683) |
| `kConsoleText` | the words TacticalScreen draws on the console itself, by name (`megawatts`, `lightspeed`, `alien`, `power`, `kilometres`, `mark`, `colon`): each `{ source, value }`, `source` the line that draws it (7; another-unity Plan 27 R15). `power` is a format (`%3.2f`). An export before Plan 27 has none |

Numbers are raw: rows keep their `-1` end and zero fill, and `kTacticOverrides`' objects are C++ numbers (`world << 16 | screen << 8 | id`). The lift trims and interprets them.

## verbatim/

Copied byte for byte, because ScummVM has no structured parser for them: the
tactics `*.bin` (bytecode, for sub-project 4), the screen texts
`t_WWSS00.bst` (parsed as they're shown), and `w_WWscrn.bst` and
`w_WWWcon.bst` (which ScummVM doesn't read); and `computer.db`, `compstat` (the computer's
starting state), `astro.db` and `sector.ast`, which the browser engine's tricorder, computer and astrogation read;
and space combat's models, materials and textures: `*.3dv` and `*.3dr` (geometry), `*.mtl` and `*.mtr` (materials), `*.dmg`, `*.pc?`, `*.img` (GIF) and `*.lbm` (PBM), which the browser engine's ports of `SpaceResources` parse (space3d.cpp:519-569);
and tactical's still pictures, drawn from their palette indices: `spc00a.pic` (the console) and `space.mrg` (its buttons, pages, scanner pictures and digits), which TacticalScreen::start loads (tactical.cpp:264-265) and draws in the space palette it sets (:271-278), and `cheap.pic`, the warp's background (showWarp, tactical.cpp:819), in its own. A `.pic` is 256 6-bit colours and 640×480 indices (graphics.cpp:311-342); an `.mrg` a count, offsets, then each entry's width, height and indices (graphics.cpp:262-286).

## Not exported

| What | Why |
|---|---|
| Object header: the world byte after `curr_screen`, the five block pointers, the entry counts, the two bytes the original copies but never uses, the zero padding | `loadObject` skips them |
| Entry headers' owner, block position, and response/state words; the BEGIN_ENTRY block's 0xac bytes | `readHeaderFrom` and `readEntryList` skip them |
| The file order of a group's entries | `sortLastEntry` sorts each group as it's read; `_order` is kept |
| BeamBlock's bytes after `screen_id`; ChoiceBlock's branch offsets and counts; the blocks' zero padding | their `readFrom`s skip them |
| A response's 6 bytes after `response_state`, its 20 bytes after `next_situation`, and `unknown3`-`unknown7` (after `target`) | `Response::readFrom` skips or only logs them |
| WhoCanSay's 4 bytes after `whocansay`; TextBlock's 4 bytes after the text | `WhoCanSayBlock::readFrom` and `TextBlock::readFrom` skip them |
| ChangeAction's `unknown4`, `unknown5` and `unknown6` (after `state_id`) | `ChangeActionBlock::readFrom` only logs them |
| Polygon `triangles` | derived from `points` by `triangulate`, so not exported |
| Each entrance's two header bytes | `readScreenLocation` skips them |
| Advice files' number line after each id, and comments | `loadAdvice` skips them |
| Each object list entry's 30-byte name and 260-byte description in `wWWSSobj.bst` | `listScreenObjects` skips them (each object's own file has its name and descriptions) |
| `trigger.dat`'s fixed words (0xffff, 0xff), the byte after `enabled`, and the zero words of timer and unused triggers | `loadTriggers` checks or skips them |
| A phaser record's other bytes (0-5, 7, 9 and 0xc of its 0xe) and the rest of the record up to its size | `loadPhaserData` skips them |
| An object's `timer_deadline`, walk state, sprite and `draw_scale`; phaser data's `health`, `stunned`, `destroyed` and `regen_time`; a trigger's `target_time` | runtime state, the same for every fresh load |
| Fonts, cursors, `.mrg` UI images | outside the away-team slice (sub-project 4 and later) |

## Media

Media isn't part of the raw IR proper. Three console commands decode it next
to the IR:

```sh
sh tools/rawcheck/run-harness.sh audio 3600    # export_audio <dir> [pattern]
sh tools/rawcheck/run-harness.sh images 600    # export_images <dir> [world]
sh tools/rawcheck/run-harness.sh movies 1200   # export_movies <dir> <id|all>
```

### audio/

Every `.vac` (voice), `.rac` and `.mac` (effects and music), decoded by the
engine's own IMA ADPCM stream (`makeUnitySoundStream`) to 16-bit PCM WAV at
22050 Hz, named `<original name>.wav`. The files have no header; the channel
count goes by the extension: every `.rac` is stereo, music or effect, and every
`.vac` and `.mac` mono. (Until 2026-10-30 only the `.rac`s the engine plays as
music were decoded as stereo. The 12 others, such as the transporter's beam,
the hand phaser and the tricorder, came out twice as long and clipping, as both
channels' codes stepped one predictor.) `audio/manifest.json` lists
`{ name, wav, channels, rate, frames }` for each file, sorted by name.

### images/

- `images/backgrounds/s_WWSS.png`: each located screen's background (640×480),
  in its palette: the `.scr`'s 128 colours and `STANDARD.PAL`'s 128, as
  `setBackgroundImage` builds it.
- `images/sprites/<file>/NNNN.png`: every frame of a sprite (entry `NNNN`),
  RGBA, with colour 13 (`COLOUR_BLANK`) transparent. A sprite takes the
  palette of the first screen whose objects use it. Sprites that no screen
  object uses (crew, icons, UI) get `STANDARD.PAL` in the top half. A sprite's
  own `palette` entry replaces both from that point in the file on.
- `images/sprites/<file>/sprite.json`: `file`, `palette` (`s_WWSS`,
  `standard`, `space` or `cheap`), `anims` (the entry each animation starts at) and `entries` in
  file order: `{ type }`, plus `width`, `height` for frames (and `png`, unless the
  frame is empty), `wait`;
  `rand_amt`, `base` for random waits; `target` for jumps; `x`, `y` for
  positions; `name`, `volume` for sound files; `wav` (`NNNN.wav`, decoded as
  mono 22050 Hz) and `length` for embedded sounds; `state` and `flagId`. The
  other types (`mask`, `static`, `pause`, `mark`, `exit` and so on) carry no
  data beyond their type.
- Space combat's sprites (`?_boom.spr`, `?_phaser.spr`, `?_photon.spr`,
  `?_shield.spr`) take `palette: "space"`: the Enterprise's first texture's
  colours (tactical.cpp:271-276), with colours 0 and 13 transparent and the
  sprite's own palette entries not applied, as `SpaceResources::animation`
  makes textures of them. Combat takes at most 23 frames of each
  (`kMaxAnimationFrames`).
- The warp overlay's sprites (`viewscan.spr`, `viewscr.spr`, `vwwarped.spr`)
  take `palette: "cheap"`: `cheap.pic`'s own 256 colours, which showWarp's
  `setBackgroundImage` sets before it starts them (tactical.cpp:818-854).
  The bridge also shows `viewscr.spr` and `viewscan.spr` (bridge.cpp:213-214),
  in `bridge.rm`'s palette; the ship's art decodes its own from the game.
- `images/manifest.json`: `backgrounds` (`screen`, `file`, `png`) and `sprites`
  (`file`, `json`, `palette`, `frames`).

### movies/

`movies/<id>/` for each movie in movie.map (or one, by id): `frames/NNNNN.png`
(every frame, decoded by `FVFDecoder`, in order), `audio.wav` (the movie's
sound, mono 16-bit at its own rate), and `movie.json`: `id`, `file`,
`description`, `width`, `height`, `frameRate` (`[numerator, denominator]`
frames per second, as the decoder's `Common::Rational` holds it), `frames`, `audioRate`, `audioFrames`.
