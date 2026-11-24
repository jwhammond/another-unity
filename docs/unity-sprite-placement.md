# Sprite placement against the original

The original draws every object that has a sprite over the background: crew, NPCs, props, doors, lights, and the masks that make a figure pass behind a
rock. The repainted plates (`docs/unity-art-status.md`) are made from the background alone, so with art on a sprite shows only if a card or mask layer
stands in for it (`docs/unity-local.md`, "Props and people lying on a floor"). This is what was checked between ScummVM's Unity engine and ours, what was
wrong, and what is left. Everything the tool reads is local; nothing from a run is committed.

## The check

`tools/placement` compares ScummVM's objects on each of the 80 away rooms with our world and our published art.

```sh
export RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw
npm run placement -- scummvm ~/pcode/unity-raw/runs/placement/scummvm-all.json lab horst3 allanor zoo frigis unity
npm run placement -- compare ~/pcode/unity-raw/runs/placement/scummvm-all.json ~/pcode/unity-raw/runs/placement/findings.json
```

- `scummvm` runs the muted harness (`tools/scummvm-harness`, `mute=true`) once a room, so what one room's scripts set cannot leak into the next. Each run
  starts the away team on the room, waits 2.5 s, lists the room's objects (`objects`: flags, state, position) and asks after every object that has a sprite
  (`object`: sprite file, animation index, the player's animation, whether anything is shown). The export worktree's build is used as `tracediff` uses it;
  `REPARSE=1` reads the last runs' logs again.
- `compare` puts our world on the same room (entrance 0, at 0 s and at 3 s, because a timer, a walker or a conversation can leave the two a step apart
  either way) and reports, per object:
  - `active`, `state`, `position` (pixel to metres through the room's projection, 0.05 m): a difference counts only if it holds at both times;
  - `no-art`: ScummVM draws a sprite for it (active, a player, something shown) and the room's published art has no mask or prop layer for it, with the card
    recipe if there is one that is not published;
  - `later-no-art`: the same for a sprite that is off at entry and that some rule turns on (`alter: active: true`): the cable-cut case, found without playing;
  - `anim`: ScummVM's player is on another animation than the one the object's card shows.

Two scripted cases were also traced by hand with `trace` (the harness's `objects`/`object` after a `walkthrough`): the phaser on Mertens' cable and on
Horst III's rubble.

## What agrees

Across the 80 rooms **no object stands in a different place, is on or off differently, or has a different state** that holds at both times. Placement at
room entry is not where the discrepancies are. Two differences remain and both are timing: `allanor.optimator_two.0e04` is a walker that ScummVM has moved
on by the time it is read, and `unity.screen_startup.0108` is still waiting for the shuttle's animation (`play: 1, wait: true`) in ScummVM, which the sim
does not wait for. (Crew placement is the walk diff's: `docs/tracediff.md`.)

## Fixed

| What | Root cause | Fix |
|---|---|---|
| **Mertens' big cable vanishes when shot** (`lab.s03`) | The stun script turns `lab.big_cable.0308` off and `lab.big_cable.0307` on. ScummVM draws 0307 in the same place: the same sprite (`w4s3msk4.spr`) at animation 1, a 144x58 frame where the whole cable's is 146x60 (trace: 0308 flags 62 to 30, 0307 22 to 54, `anim_index` 1 on both). Our sim did the same, but only 0308 had a prop card, so its art went with its object and nothing took its place. | `card.lab_cut_cable` (`prop.anim: 1`); `findProps` reads the frame of the animation the prop shows (`animEntries`). e2e: `unity-cable.spec.ts` (the world swaps the two objects; the cut cable's layer is shown and the whole one's is not). |
| **Horst III's rubble pile is missing with art on** (`horst3.s01`) | The rubble is a patch of the background the original draws over it (`w7s1cvin.spr`, animation 0, 144x136 at 208,336), and the plate is repainted from the background alone, so the first puzzle's obstacle was not there. The phaser's kill turns it off and the plate's open passage (the sprite's animation 5) shows. | `card.horst3_rubble`. e2e: `unity-placement.spec.ts` (shown at entry, gone after a low and a medium shot). |
| **Mertens' trapped, injured and dead women** (`lab.s01`, `s02`, `s03`) | One sprite (`w4s3doct.spr`) in nine objects that scripts swap for each other; only 0301 had a card, so the woman vanished when she was swapped, and the rooms `s01` and `s02` never had her. | The recipe now serves nine objects in three rooms (`prop.screens`); `findProps` takes the objects each room has. |
| **Mertens' Dr. Griems** (`lab.s08`) | A standing NPC with no card. | `card.lab_dr_griems`. |
| **Mask sprites with no `mask` entry** (`lab.cable_mask.0216`, `lab.cable_mask.031c`, `frigis.mask_pillar1-4`, `frigis.mask_small_pyramd`) | `findMasks` took only sprites whose file says `mask`. These are one still the original draws over the actors the same way, so a figure that should pass behind Frigis' pillars, or a cable end that should tuck under the ramp, was drawn in front. | `findMasks` also takes an object named for a mask whose sprite is one still frame and that no other object on the screen draws (a force field's "mask" is its animation). `art masks` re-run on those rooms. |
| **Allanor's Brodnack and chodak stand in the wrong pose** (`allanor.s07`, `allanor.s0e`) | The cards were stills of animation 0; ScummVM plays animation 78, 8 and 3 there (frames 124x170, 94x162 and 64x162, not 110x164, 110x160 and 110x160), the objects' own idle loops. `alien.0706` was missing altogether. | The three recipes name the animation (`anim: 78`, `8`, `3`) and `alien.0706` takes the chodak's card. |
| **Allanor's drones, optimators and chodak masters, and Mertens' dead crewman** (small batch 1) | Characters ScummVM draws with no card (`no-art` 215 to 212, `later-no-art` 99 to 91 on re-running `compare`). The pose is the one ScummVM's player is on: animation 0 for all of them (`anim_index` 0, no script alters it), except what already had a card. | `card.allanor_drone_s01` (`011e`, `w2s1robo`), `card.allanor_drone_s05` (`040b`, `050a`, `w2s4robo`, rooms `s04`, `s05`), `card.allanor_chodak_shared` (`chodak.spr`: `alien.061a/061b`, the optimators of `s0b`, `s0c`, `s0d`, `s0e`), `card.allanor_brodnack_shared` (`brodnack.spr`: the masters of `s0c`, `s0d`, `s0e`), `card.allanor_dead_optimator` (`0b11`). The dead crewman is `w4s8egr.spr` animation 0, as Dr. Griems: it joined `card.lab_dr_griems` (no new art; ScummVM plays the standing frame, not the lying animation 1, 158x40, that its 150x50 rectangle matches). All five new cards passed the card check on the first run (13 to 19 s a canvas). e2e: `unity-placement.spec.ts` (`allanor.s01`, `s04`, `s05`, `s06`, `s0b`, `s0c`; `lab.s08`'s `dead_crewman`). |
| **Allanor's dead optimator was never drawn** (`allanor.dead_optimator.0b11`, small batch 2) | The card was published and cut into `allanor.s0b`'s masks, but the original sorts the object by row 1 (`y_adjust`, behind everything) and `maskQuad` drops any layer sorted above the horizon (no floor point). That rule is right for a cut of the plate (it then looks like the plate) and wrong for a card. | A published prop entry carries `card: true` (`publishMasks`; `presentation.yaml`, `MaskUrl`, `RoomMask`); `maskQuad` stands a card with no floor point under its sorting row on the floor under its own foot, still sorted by its row (behind everything), and a plate cut keeps the old rule. A card whose foot is above the horizon too is still left out. Vitest: `masks.test.ts` (`maskQuad above the horizon`). e2e: `allanor.s0b` in `unity-placement.spec.ts` now lists `0b11`. Props published before this have no flag until `art masks` re-cuts their room. |
| **Frigis' Aelont, pluvoids and gatekeeper** (small batch 2) | Characters ScummVM draws with no card. The pose is the one ScummVM's player is on: animation 0 for each (`playing` 0 in the dump). | `card.frigis_aelont_s07` (`071e`, `w5s7aelo`), `card.frigis_pluvoids_s06` (`frigis.pluvoids`, `w5s6rhrs`, a 320x106 row of figures), `card.frigis_gatekeeper_s0a` (`0a13`, `w5s7upga`); Aelont's `090a` joined `card.frigis_aelont_s09` (the same `w5s9free` sprite; the layer is sorted by row 400, the card's `anim_free_aelont` proxy by -1). None is drawn at near-zero scale. All three passed the card check on the first run (13 s a canvas). The gatekeeper's `anim_gatekeeper` (`0a12`, off, nothing shown) and the sprite-less `070e` gatekeepers have no layer. e2e: `unity-placement.spec.ts` (`frigis.s06`, `s07`, `s09`, `s0a`). |
| **Zoo's constable and the sultis reptile** (small batch 3) | Characters ScummVM draws with no card. The constable `030e` (s03, `w3s3cons`) is the same sprite as `0325`, but ScummVM's player is on animation 0 and that animation's frame 2 flickers (4.7 against 1.9, whatever the seed; `docs/unity-art-status.md`); animation 1 starts on the same pose and passes, so `030e` joined `card.zoo_constable_s03` (`anim: 1`, no new art; the layer is 114x154 at 468,226 sorted by row 350). The sultis reptile (`zoo.sultis_reptile`, `w3s9bat2`, animation 0, 144x56) is a dark view of the habitat, not an animal. | `card.zoo_reptile_s09` (passed first run, 19 s). `art masks zoo.s03`, `zoo.s09`. e2e: `unity-placement.spec.ts` (`zoo.s03`, `zoo.s09`). |
| **Zoo's carcasses and deer, the Borg's cubes, Laraq's second form** (small batch 6) | The carcasses (`zoo.carcass.0417`, `0418`, `0419`: `w3s4myec`, `w3s4fred`, `w3s4kuoj`, animation 0, `zoo.s04`), the deer (`zoo.deer`, `w3s2dear`, animation 0, off at entry, `zoo.s02`) and the Borg (`unity.borg`, `w6s15brg`, animation 1, `unity.s0f`) failed the card check twice in batches 3 and 4 on speckle the check can't measure, whatever the repaint. Laraq's `010c` (`frigis.s01`, off at entry, turned on by a script) is the same sprite and the same frame (`w5s1lar1`, animation 0, `playing` 0 in the dump) as `0100`'s card. | Cards can now be upscale-only: `repaint: false` in a card recipe (the plates' rule: the sprite's 4x upscaled frame published as it is, no diffusion pass; `runCardAnim`; vitest in `recipe.test.ts`). The upscale is geometrically faithful (flicker 0, shift 0, dE 0), but the card check's speckle rule is about the original's own windows, so it still fails on the upscale: 3 of 5, 4 of 5, 7 of 8, 5 of 5 and 27 of 39 strongest windows are speckle. Each of the five recipes therefore carries `align: { skip: true, reason }`, allowed only with `repaint: false` (`checkAnim`'s `skipAlign`: the alignment is skipped and nothing else; the alpha, flicker and identity checks still run and pass); no threshold was changed. `card.zoo_carcass_0417/0418/0419`, `card.zoo_deer_s02`, `card.unity_borg_s0f`; the Laraq card gained `010c` (`objects`, no new art). `art masks frigis.s01`, `zoo.s02`, `zoo.s04`, `unity.s0f`. The upscale is the card's own `makeStrips` upscale (no de-dither step). e2e: `unity-placement.spec.ts` (`frigis.s01`, `zoo.s02`, `zoo.s04`, `unity.s0f`). `compare`: `no-art` 205 to 201, `later-no-art` 88 to 86. |
| **Unity's Picard and the guardian** (small batch 4) | Characters ScummVM draws with no card. Picard `0b00` (`futrpica`, the animation ScummVM plays, 80: a 60x162 frame, not animation 0's), `0b04` (`prespica`, animation 0, 60x150), the guardian `0a07` (`w6s10cnt`, animation 0, 224x192, scale 251/256). Both Picards are drawn at 200/256. | `card.unity_picard_s0b_b00` (failed once at denoise 0.3 / lineart 1.0 on a 3.16 px shift from the green aura in the sprite; passed with denoise 0.2, lineart 1.3 and the aura left out of the prompt), `card.unity_picard_s0b_b04`, `card.unity_guardian_s0a` (both passed first run, 19 to 21 s). `art masks unity.s0a`, `unity.s0b`. e2e: `unity-placement.spec.ts` (`unity.s0a`; `unity.s0b` is in the cutscene tests of batch 5). |
| **Four cards showed another pose than ScummVM's player** (small batch 5) | `allanor.drone.0604` (`w2s4robo`, animation 12), `frigis.stamblyr.0601` (`w5s6stam`, 2), `frigis.nachyl` (`w5s7nach`, 3), `zoo.veronda_bird` (`w3s3bird`, 2): the card was a still of animation 0, the same frame size. | The four recipes name the animation (`prop.anim`, `anims`) and were repainted; all passed the card check on the first run (16 to 20 s; worst shift 0.2 to 0.4 px, dE max 0.7 to 2). `art masks` re-run on `allanor.s06`, `frigis.s06`, `frigis.s07`, `zoo.s03`. `compare`'s `anim` count 5 to 1. |
| **`unity.s0b` showed `unity.s06`'s layer, `allanor.s0e` never settled** (small batch 5) | Not bugs. Both rooms run a cutscene on entry and the original leaves them by it. ScummVM's trace (`start 6 11 0`, `advance 60`): Picard's two lines, Brodnack's "Picard...", then a `screen` event to world 6 screen 6 (`c005`'s result `screen: unity.s06`); (`start 2 14 0`): a `screen` event to allanor.s09 entrance 4 about 5 s in. Our sim does both (the page moved to `unity.s06` after about 20 s at 8x, to `allanor.s09` after 5 s), so the `pentara_s_body` layer was `s06`'s, shown after the room was left; `settled` waited on a room that was gone, then on the lines of the next. | e2e: `unity-placement.spec.ts` (`unity.s0b`, `allanor.s0e`: the layers are there at entry, then the test waits for the move the trace shows). |
| **Mertens' props: shelf tools, hull breach, turbolift pillar, cable piece** (small batch 7) | Props ScummVM draws over the background that `placement triage` calls `static-missing` (one still frame, not in the original background at its rect). Lab was the only world played first with any: Horst III's one (`horst3.rock_pile_endstate`) is the rubble's own sprite and rect on screen 0, no script touches it, and a card would keep the rubble drawn after the phaser clears it, so it was left. | `card.lab_flux_router`, `card.lab_inverter_coupling`, `card.lab_wave_converter`, `card.lab_plasma_shunt` (the shelf of `lab.s07`), `card.lab_piece_of_cable` (`lab.s01`, off at entry), `card.lab_hull_breach`, `card.lab_turbolift_left` (`lab.s06`): repainted, all passed the card check on the first run (16 to 18 s each). `card.lab_pulse_negator` and `card.lab_graviton_probe` failed on speckle the check can't measure (2 of 2 and 1 of 1 windows) and are upscale-only (`repaint: false`, `align: { skip }` with the reason, batch 6's rule: nothing else relaxed; they then passed). `art masks lab.s01`, `lab.s06`, `lab.s07`. `lab.piece_of_cable.0101` was published but never drawn: see batch 7b. e2e: `unity-placement.spec.ts` (`lab.s06`, `lab.s07`). `compare`: `no-art` 201 to 194, `later-no-art` 86 to 84. |
| **Mertens' piece of cable was never drawn; Allanor's and the zoo's still props** (small batch 7b) | **A.** `lab.piece_of_cable.0101` (`lab.s01`, off at entry) is drawn by ScummVM when a script turns it on (`drawObjects`: any active object with a valid sprite, whatever the row; the dump has it at 100,100, `nothingShown` while off), at its rectangle 40,64 120x36, sorted by row 100. The horizon of `lab.s01` is row 149.9, so the whole rect (foot 100 too) is on the far wall, where there is no floor point and `maskQuad` left it out (the batch-2 rule only gave a card a floor under its foot). The original draws a decal there like any other object, so it is a bug of ours. **B.** Props `static-missing` in Allanor and the zoo. | **A.** `maskQuad`: a card whose foot is above the horizon too stands on the plane of the nearest floor point (the picture's bottom row below its column) and keeps its corners, so it covers its own rectangle exactly and is sorted by its row; a cut of the plate still leaves out. Vitest: `masks.test.ts` (corners project back onto 40,64 to 160,100; a cut above the horizon is still null; the old "card with no floor either is left out" case is replaced). e2e: `unity-placement.spec.ts` (`lab.s01` lists the piece). **B.** 14 recipes covering 16 sprites: `card.allanor_alloy_seal_0100`, `_0109`, `_0121`, `card.allanor_ashes_0116`, `card.allanor_logic_inhibitor` (`allanor.foreign_object` on `s01` and `logic_inhibitor.0507` on `s05`, `w2s1stb2`), `card.allanor_sheet_of_metal` (`0404` on `s04`, `0510` on `s05`, `w2s4stmt`), `card.allanor_chodak_shell`, `card.allanor_phaser`, `card.allanor_pedestal_0c05`, `card.allanor_star_chart`, `card.zoo_fruit_s01`, `card.zoo_bioprobe_s04`, `card.zoo_harmonic_collector_s09`, `card.zoo_flock_s06`. Eight passed the card check on the first run (17 to 18 s each). Six failed it on speckle only (shift 0, flicker 0, dE under 2.3; 1 of 1, 1 of 1, 1 of 1, 2 of 2, 4 of 4 and 1 of 1 windows: three seals, the phaser, the flock, the fruit) and are upscale-only (`repaint: false`, `align: { skip, reason }`; nothing else relaxed; they then passed). None failed twice. **Skipped on purpose** because a script changes what the sprite shows while the object stays active, so a still of frame 0 would stay drawn wrongly: the doors `allanor.door.011b` and `0504` and `zoo.door` (anim 1 / 3 plays, state), `allanor.ventilation_duct.0108` (state 2, anim 1 after the seals go), the buttons `1103` to `1108` (the lit/unlit animations) and `sc1` to `sc6` (button `120d` to `1212` play anim 1/2), `allanor.security_rod.1202` (its animations 1 and 2 are swapped by script) and `zoo.shuttle` (`shuttle_timer` plays anim 1). The others go with their object: they are hidden when it is turned off or taken (`syncMask`: active and not in inventory). `art masks` on `lab.s01`, `allanor.s01`, `s04`, `s05`, `s0a`, `s0c`, `s0f`, `zoo.s01`, `s04`, `s06`, `s09`. e2e: `unity-placement.spec.ts` (the same rooms). `compare`: `no-art` 194 to 183, `later-no-art` 84 to 79. |
| **Frigis' orchestrion parts, rings, talismans and items; Unity's disks** (small batch 7c) | Props `static-missing` in Frigis and Unity whose sprite no script changes (only `active`, so they go with their object: hidden when it is turned off or taken). | 16 recipes: `card.frigis_orchestrion_044a`, `_044b`, `_044c`, `_044d` (`frigis.s04`), `card.frigis_golden_ring_0603` (`s06`, off at entry), and on `frigis.s0d` `card.frigis_talisman_0d06`, `_0d07` (off at entry), `card.frigis_staff_0d08`, `card.frigis_golden_ring_0d09`, `card.frigis_device_0d0a`, `card.frigis_stasis_jar`, `card.frigis_staff_0d0c`, `card.frigis_statuette`; `card.unity_disks_s0c` (off at entry), `card.unity_disk_half_0d0b`, `card.unity_disk_half_0d0c` (`unity.s0d`). Nine passed the card check on the first run (17 to 18 s each; worst shift 1.2 px on `0d0b`, dE max under 1.5). Seven failed it on speckle only (shift under 0.2 px, flicker 0, dE max under 1.7; 1 of 1, 3 of 4, 3 of 3, 2 of 2, 2 of 2, 3 of 3, 2 of 3 windows: `044c`, `044b`, `0d08`, both talismans, `0d0c`, the statuette) and are upscale-only (`repaint: false`, `align: { skip, reason }`; nothing else relaxed; they then passed). None failed twice. `art masks` on `frigis.s04`, `s06`, `s0d`, `unity.s0c`, `s0d`. e2e: `unity-placement.spec.ts` (the same rooms). Skipped on purpose, see "Batch 8" below. `compare`: `no-art` 183 to 171, `later-no-art` 79 to 75. |
| A prop card repainted every frame of its animation | A prop is a still, but `art batch` repainted each frame of a looping animation as its own work canvas (13 for Brodnack's idle: 15 minutes for the one frame the card shows). | `loadSprite` cuts a prop recipe's animation to its first frame (`stillOf`). |

The cards were made on this machine (65 to 95 s each); the published files and the cut masks are local and git-ignored. The recipes are committed.
After a fresh checkout: `art batch` the recipes named above, then `art masks <room>` for each of `lab.s01`, `s02`, `s03`, `s08`, `frigis.s01`, `s03`,
`horst3.s01`, `allanor.s07`, `s0e`, and for batch 1 `art batch` the five cards above, for batch 2 the three Frigis cards, then `art masks` for `allanor.s01`, `s04`, `s05`, `s06`, `s0b`, `s0c`, `s0d`, `s0e` and `lab.s08`; for batch 2 `frigis.s06`, `s07`, `s09`, `s0a` (and `allanor.s0b` again, for 0b11's `card` flag); for batch 3 `art batch` `card.zoo_reptile_s09`, then `art masks` `zoo.s03` and `zoo.s09`; for batch 4 `art batch` the three `card.unity_picard_s0b_*` / `card.unity_guardian_s0a` recipes, then `art masks` `unity.s0a` and `unity.s0b`; for batch 6 `art batch` `card.zoo_carcass_0417`, `0418`, `0419`, `card.zoo_deer_s02`, `card.unity_borg_s0f`, then `art masks` `frigis.s01`, `zoo.s02`, `zoo.s04`, `unity.s0f`; for batch 7 `art batch` the nine `card.lab_*` recipes of Mertens' tools, hull breach, turbolift pillar and cable piece, then `art masks` `lab.s01`, `lab.s06`, `lab.s07`; for batch 7b `art batch` the fourteen recipes named in its row, then `art masks` `lab.s01`, `allanor.s01`, `s04`, `s05`, `s0a`, `s0c`, `s0f`, `zoo.s01`, `s04`, `s06`, `s09`; for batch 7c `art batch` the sixteen recipes named in its row, then `art masks` `frigis.s04`, `s06`, `s0d`, `unity.s0c`, `s0d`; for batch 5 `art batch` `card.allanor_drone_s06`, `card.frigis_stamblyr_s06`, `card.frigis_nachyl_s07`, `card.zoo_bird_s03`, then `art masks` `allanor.s06`, `frigis.s06`, `frigis.s07`, `zoo.s03`. The e2e specs skip, saying what is missing, until they are published.

## Triage of the sprites with no art

`placement triage` sorts every `no-art` / `later-no-art` finding by what the original draws, so the cards still worth making are known:

```sh
npm run placement -- triage ~/pcode/unity-raw/runs/placement/scummvm-all.json ~/pcode/unity-raw/runs/placement/findings.json ~/pcode/unity-raw/runs/placement/triage.json
```

It needs `RAW_DIR` and `IMAGES_DIR`. For each sprite it takes the frames the animation ScummVM's player is on plays (up to its first pause or exit), puts the
first at its rect (`maskRect`, the floor's scale for a walker) and decides (`triage.ts`, vitest in `triage.test.ts`; tolerances are constants there):

- `invisible`: no frame, the frame is fully transparent, fewer than 16 opaque pixels (at the drawn scale) or drawn below 8/256. This is the animation ScummVM
  is on at entry: a sprite whose first frame is clear and whose other animations a script plays later (Horst III's `screen_blank`, Mertens' shutdown
  buttons) is counted here and not seen by this tool.
- `in-plate`: every distinct frame matches the room's original background at its rect (90% of the opaque pixels within 24 a channel): the sprite is baked into the
  background, so the plate shows it.
- `animated`: more than one distinct frame (two frames are the same when 98% of their pixels are within 24) and not all of them in the background: lights, doors,
  stars with a changing frame. Needs an animated layer (batch 8).
- `static-missing`: one distinct frame that the background does not show: needs a still card.

ScummVM draws every object the screen's list names, whatever the object's own `curr_screen` (`openLocation`, `drawObjects`), so an object on screen 0 is
not an exception. The plate is a repaint of the same background, so the original background is what the sprite is compared with.

Per world, over the 287 sprites (`no-art` 201 and `later-no-art` 86) before batch 7:

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 27 | 24 | 5 | 75 |
| frigis | 4 | 39 | 16 | 0 | 59 |
| horst3 | 8 | 1 | 2 | 2 | 13 |
| lab | 4 | 9 | 4 | 6 | 23 |
| unity | 14 | 13 | 29 | 5 | 61 |
| zoo | 20 | 6 | 30 | 0 | 56 |
| **all** | 69 | 95 | 105 | 18 | 287 |

After batch 7 (278 sprites left; the nine Mertens cards are published, so those are no longer findings):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 27 | 24 | 5 | 75 |
| frigis | 4 | 39 | 16 | 0 | 59 |
| horst3 | 8 | 1 | 2 | 2 | 13 |
| lab | 4 | 0 | 4 | 6 | 14 |
| unity | 14 | 13 | 29 | 5 | 61 |
| zoo | 20 | 6 | 30 | 0 | 56 |
| **all** | 69 | 86 | 105 | 18 | 278 |

After batch 7b (262 sprites left; 16 more are cards, Allanor's and the zoo's props that no script changes):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 15 | 24 | 5 | 63 |
| frigis | 4 | 39 | 16 | 0 | 59 |
| horst3 | 8 | 1 | 2 | 2 | 13 |
| lab | 4 | 0 | 4 | 6 | 14 |
| unity | 14 | 13 | 29 | 5 | 61 |
| zoo | 20 | 2 | 30 | 0 | 52 |
| **all** | 69 | 70 | 105 | 18 | 262 |

After batch 7c (246 sprites left; 16 more are cards, the Frigis and Unity props that no script changes):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 15 | 24 | 5 | 63 |
| frigis | 4 | 26 | 16 | 0 | 46 |
| horst3 | 8 | 1 | 2 | 2 | 13 |
| lab | 4 | 0 | 4 | 6 | 14 |
| unity | 14 | 10 | 29 | 5 | 58 |
| zoo | 20 | 2 | 30 | 0 | 52 |
| **all** | 69 | 54 | 105 | 18 | 246 |

Remaining `static-missing` before batch 7b (86; **Allanor 15 and zoo 2** are what is left of those two after it, all skipped because a script changes what they show: Allanor's doors, vent duct, buttons, `sc1` to `sc6` and security rod; the zoo's shuttle and door): **Allanor 27** (alloy seals, ventilation duct, ashes, doors, foreign object, sheets of metal, logic inhibitor,
`chodak_shell`, phaser, pedestal, star chart, buttons `1103` to `1108`, security rod, `sc1` to `sc6`), **Frigis 39** (22 floor tiles, touchpad, yellow door,
orchestrion `044a` to `044d`, golden rings, stasis fields, talismans, staffs, device, stasis jar, statuette), **Unity 13** (shuttle, shuttle door, two doors, chips on
the table, `brodnack_s_body`, disks, disk halves, stasis chambers, `captain_pentara.0e0f`), **Zoo 6** (fruit, bioprobe, shuttle, door, flock, harmonic collector) and
**Horst III 1** (`rock_pile_endstate`, left: see batch 7 above). `animated` is 105 in all (batch 8).

## Batch 8: everything that needs an animated or state-driven layer

Cards are stills. What is left needs a layer that changes while its object stays active: 105 `animated` sprites plus the 54 `static-missing` ones left: 53 that a script
changes (an `alter:` with `anim` or `state` on the object, found by scanning `games/unity/objects` and the trigger files) and the one a card would keep
drawn wrongly. Regenerate the first with `placement triage` (`bucket: animated`; Allanor 24, Frigis 16, Horst III 2, Mertens 4, Unity 29, zoo 30).

Script-changed sprites skipped as stills (53):

- **Allanor 15** (batch 7b): doors `allanor.door.011b`, `0504` (anim 2 / 0, `exit_results.050d`; state); `allanor.ventilation_duct.0108`; buttons `1103` to `1108` (lit and unlit animations) and `sc1` to `sc6` (buttons `120d` to `1212` play anim 1/2); `allanor.security_rod.1202` (animations 1 and 2 swapped by script).
- **Zoo 2** (batch 7b): `zoo.door` (anim 1 / 3, state), `zoo.shuttle` (`shuttle_timer` plays anim 1).
- **Frigis 26** (batch 7c): the 22 floor tiles of `frigis.s04` (`floor_tile_06` to `floor_tile_30`: every one is turned on and off and has its state set by `insert_N`, `clear_N` and `screen_start`: the puzzle floor, 8 of them off at entry), `frigis.touchpad.0434` (state), `frigis.yellow_door_anim` (`open_door` plays an animation, off at entry), `frigis.stasis_field.0909` and `0910` (`w5s9stas`: `0909` has its state set, the two share the sprite, so neither is carded).
- **Unity 10** (batch 7c): the shuttle `unity.shuttle.0400` and `unity.shuttle_door` (`as_inside_shuttle` plays their animations), `unity.door.0504` and `unity.door.0e00` (anim and state by script), `unity.left_chip_on_table` and `unity.right_chip_on_table` (`screen_startup.061a` and the disk-half rules play their animation), `unity.brodnack_s_body` (state; off at entry), the stasis chamber `0e03`, `unity.captain_pentara.0e0f` and the stasis chamber `0e18` (anim by `panel.0e01`, `ts_pentara_trap`, `walk_to_tower_as`; all but `0e03` off at entry).
- Not script-changed but left on purpose (batch 7): `horst3.rock_pile_endstate` (the rubble's own sprite and rect on screen 0; a card would keep it drawn after the phaser clears it).

That is the whole of batch 8's input: the 105 `animated` sprites and the 54 above, 159 in all.

## Batch 8a: animated layers, the engine and pipeline pilot

Until now a card was a still of one frame, shown or hidden with its object (`syncMask`). 8a makes a layer follow the object's animation, frame by frame, and
pilots it on four objects. The other ~155 sprites of batch 8 follow in small batches with the same recipe change (see "Rollout").

**What the sim had.** Batch 8's brief said the sim already advanced animations; it did not. `alter: anim` only reached the presenter (a one-second pulse of a greybox
mesh) and nothing was kept. The original keeps `anim_index` on the object (`AlterBlock::execute`: a play sets it, a stop makes it negative, a new sprite replaces the
sprite) and restarts the sprite on it whenever the screen loads. So `ObjectState.anim` (optional, saved, absent until an alter sets it) is the one sim change; the rules never read it. The
*timing* is the view's: frame delays come from the sprite file (`waitMillis`, the 291.3 Hz sprite clock) and run on the stage's presentation clock, the clock `CardPlayer` runs a crew card on.

**Recipe** (`prop` of a card recipe; `art/recipes/card.lab_lights_080a.yaml`, `card.allanor_door_011b.yaml`, `card.horst3_rock_pile_endstate.yaml`):

```yaml
anims: [0, 1]                       # what `art batch` runs: every animation the layer can be on (and the ones they fall into are run too)
prop: { screen: allanor.s01, objects: [allanor.door.011b], anim: 0, animate: [0, 1] }
```

`anim` is the animation the object starts on (the original's `anim_index` in the raw object). `animate` lists the animations published as a strip of **every frame the
original plays, up to its pause or exit, or its jump back (a loop)**: `playAnim`'s body, the same one the crew cards use. An animation not listed keeps the old rule (`anim` only: a still of
the first frame, `stillOf`). The cell of a strip is the union of its frames' rectangles with the sprite's origin at one point of every cell (`packAnim`), so a frame that moves or
changes size is drawn where the original draws it inside the cell, and the layer's quad covers the cell (`stripLayout` gives the cell's rectangle and each frame's own rectangle; both are published).

**Pipeline.**
- `runCardAnim` repaints each *distinct* frame once (`uniqueCells`: identical cells, alpha included, are one) and lays the result back at every place the frame is played, so a blinking light costs
  its pictures, not its length (the rock pile's 21-frame fall took 12 canvases). The check (`checkAnim`: alpha, alignment, flicker between every consecutive pair, identity, thresholds unchanged) then runs on the
  whole animation. A strip is published holding each distinct frame once, with `art/cards/<object>/<anim>.json` saying which cell each frame is (`of`, `columns`).
- Switching animation must not flicker either: `checkTransition` applies the in-animation flicker rules (the recipe's `flickerMax`, `flickerRatio` times the animation's median) to the last frame of each animation the recipe
  animates against the first frame of each other one, both ways, the two cells put on the sprite's origin (`transitionFlicker`). It runs when the second of two animations is run, against the newest passing run of the
  first (the run's `meta.json` now keeps the origin); an animation with no passing run yet says so, and is checked when it has. A failing switch fails the run: nothing is published.
- `repaint: false` (upscale-only, with `align: { skip, reason }`) is as before and every frame goes through the same upscale.
- `art masks <room>` publishes the layer: `presentation.yaml` `art.rooms.<screen>.masks[]` keeps its still `image` (the first frame of the starting animation, the fallback) and `rect`, and gains
  `anim` and `strips: { <anim>: { image, frames, of?, columns?, cell, rect, rects, delays, loop, next? } }`. `image` is the card's own `art/cards/<object>/<anim>.webp`; `rect` is the cell in the
  room, `rects` each frame's. `publishMasks` refuses a strip file that is not the size its layout says (a card published from another sprite or animation). A walker-scaled object (`objwalktype 1`
  at a scale under 256) is refused for now: the strips are not resampled.

**Engine.** `loadRoomArt` loads each strip as a texture (a file two layers share is loaded and freed once; one that fails warns and is left out). The stage makes a quad over each strip's cell
(`maskQuad` with the strip's rect: the corners project onto it) and, each frame, picks what each layer shows (`layerFrame`, a pure function): the animation is the object's `state.anim` (else the starting one;
a change is a script, and restarts from the first frame; a stop holds the frame it was on), the frame follows the delays, a loop goes round, an animation that ends falls into the one the original jumps to with the time left
and holds its last frame. **An animation with no strip, or whose strip failed to load, draws the still; the layer never draws nothing.** `Stage.anim` restarts a play of the animation already playing (`startAnim`).
The layer is shown and hidden with its object as before (`artState().shown`, now by a set, whichever picture is up), and `artState().layers` lists, for tests, `{ object, anim, frame, still }` of each animated layer shown.

**Tests.** Vitest: `layer.test.ts` (rectangles, cell, packing of distinct frames), `layerAnim.test.ts` (frame selection: delays, hold, loop, falling into `next`, uv windows, distinct-frame cells, no strip), `stage.test.ts`
("animated layers": frame by time, switch on a script at the animation's own rectangle, replay and stop, the still as a fallback for no strip and a failed one, with the object and the art off, a save that left the object on
another animation, freeing), `art.test.ts`, `masks.test.ts` (publishing, size refusal, distinct frames), `cardrun.test.ts` (`propSprite`, `uniqueCells`, `siblingEdge`), `cardchecks.test.ts` (transitions), `recipe.test.ts`, `alter.test.ts`, `save.test.ts`.
e2e (`unity-placement.spec.ts`, skipped until published, each compares the published strip with ScummVM's dump where there is one: the animation the original's sprite player is on at entry and whether it has ended):
the lights loop through their frames in order at the strip's own pace; the door is drawn closed, a real use of it by Picard plays animation 1 and the layer runs its frames to the last; the rock pile endstate shows the rubble, then after the real phaser kill
the fall, then the open passage.

**Pilot results** (all four published on this machine, `art masks` run on `lab.s08`, `allanor.s01`, `horst3.s01`; the e2e above pass against them):

| Object | Kind | Result |
|---|---|---|
| `lab.lights.080a` (`lab.s08`, `w4s7trim`, 172x28) | looping, 13 distinct frames | The repaint failed the card check on speckle (frames 0 to 2: 8 to 10 of the 10 strongest windows are the lights' dots; median flicker 17.5, worst shift 3.2 px), so the recipe is `repaint: false` with its `align` reason (batch 6's rule; no threshold changed). 6 s. Strip 13 cells. The layer loops at the strip's own pace; ScummVM's player is on animation 0 and never stops, as the strip says. |
| `allanor.door.011b` (`allanor.s01`, `3db`, 26x72) | script-changed (`alter: anim: play: 1`) | Repainted, passed first run: animation 0 (1 frame) 17 s, animation 1 (30 frames, 5 canvases, 65 s; 19 distinct cells: the door closes again to the frame it started on, which is also animation 0's) with flicker median 3.2, worst shift 0.22 px, dE max 1.1; the switch checks passed. A real use of the door by Picard plays animation 1, and the layer runs it; the script then ends the mission (ScummVM does too). ScummVM at entry: animation 0, stopped. |
| `horst3.rock_pile_endstate` (`horst3.s01`, `w7s1cvin`, 144x136) | script-changed (the phaser kill plays animation 4 on it, the original then jumps into 5) | Same prompt, seed and sampling as `card.horst3_rubble`, so frame 0 is the pile the player has seen. Animation 0 (1 frame) passed (worst shift 1.42 px), animation 4 (20 frames, 12 distinct, 12 canvases, 119 s, flicker median 3.4, worst shift 1.43 px, dE max 1.1) passed, animation 5 (1 frame) passed once the switch check's reference was fixed (see below). The real phaser (low, then medium) turns the rubble off, the endstate plays 4, then holds 5. This fits the state-switch model after all: the "rubble kept drawn" worry was the still; the strips replace it. |

Found while piloting: the first transition check took the switch's reference from the animation just run, and a one-frame animation has no flicker, so its median was 0 and every switch to or from it
failed (`0 to 5: flicker 5.3/255 against a median 0.0`). The reference is now the larger of the two animations' own medians; where neither has one (two stills) only the recipe's `flickerMax` applies. The numbers the rules use are unchanged. (The endstate's animations 0 and 4
ran before the median was kept in `meta.json`, so their switches to 5 were checked against `flickerMax` only; a rerun records it.)

Memory: a strip is `cell x cells` at 4x. The endstate's fall is 12 cells of 576x544 in two rows (4032x1088, 17.5 MB as a texture, 490 KB of WebP); the door's 19 cells of 104x288 wrap at 4096 wide. Large looping sprites (the 272x190 glow of `horst3.s03`, 3 distinct cells of 6) will want `lean` loaders' no-mip rule, which strips already get as non-plate textures. (Batch 8b packs strips as atlases and budgets them; the sizes above are the grid's.)


**Rollout.** Per batch of ~10 objects (`placement triage`, `bucket: animated`, then the 53 script-changed): for each, read the sprite's animations that the scripts play (`alter: anim: play: N` on the object, found as the triage found them) and the starting one (`anim_index`);
write the recipe with `anims` and `prop.animate` (the starting animation plus every one a script plays; the animations they fall into are run and published without listing); `art batch` them; a light, dot or speckle prop that fails the check on speckle is
`repaint: false` with its `align` reason, as before, and nothing else is relaxed; `art masks` for each room; add the room and objects to an e2e like the three above (compare to the dump). Order: single-room looping props first (Mertens' lights, Horst III, Unity), then the script-changed doors and buttons
(Allanor 15, zoo 2, Unity 10), then Frigis' 22 floor tiles (the puzzle: state per tile, 8 off at entry; they need only two animations each and share sprites, so one recipe per sprite, `prop.objects` listing the tiles). Not covered by this design and left for the batches that need it: sprite swaps (`alter: anim: sprite`, which
changes the sprite file: those objects would take a card per sprite), speech sprites (mouths over a marked frame: the crew cards' route), a walker-scaled object (needs the strip resampled), and an object whose picture depends on `state` alone (none found yet: every one in the list is changed by `anim`).

## Batch 8b: strips as atlases, and Mertens' and Horst III's animated props

**Memory.** 8a published a strip as a grid of equal cells (the union of the frames), 17.5 MB as a texture for the rock pile's fall, and a rollout of ~155 would not fit a lean device. A strip of an animated prop (`prop.animate`) is now an **atlas**:

- `packAtlas` (`tools/art/src/atlas.ts`, vitest `atlas.test.ts`) crops each *distinct* cell to the opaque bounds of its own frame (a pixel of margin, so the edge samples what the whole cell would have; fully clear cells cost nothing) and shelf-packs the crops, tallest first, with a pixel of gutter, into
  pages of at most 4096 on a side (a second page starts when one would pass it). The page width is the one of several candidates that wastes least, give or take 8%, preferring fewer pages and squarer ones (a 100x4000 texture is a poor one).
- The pipeline publishes pages as `art/cards/<object>/<anim>.<n>.webp` and `<anim>.json` (`of`, and the atlas: pages, sizes, `[page, x, y, w, h, ox, oy]` per distinct cell). `art masks` copies that into `presentation.yaml`: a strip has `images`, `pages` and `cells` instead of `image` and `columns`
  (a grid strip, an animation the recipe does not animate, is as before). A strip published as a grid before is published again by the next `art batch` (the batch key of an animated prop's animation carries a publish-format tag, `atlas-v3`; the repaint is reused, so nothing is painted again).
- **WebP like plates, checked on the published pixels.** `runCardAnim` encodes the pages lossy (`-q 90 -alpha_q 100 -exact`), then near-lossless, then lossless (`publish.ts`'s `WEBP_MODES`), each tried only if the one before fails, decodes them, lays the cells back (`unpackCell`) and runs `checkAnim` on *that* with the recipe's thresholds
  (and the plate's `WEBP_MAX_MEAN_DIFF` of 2/255 over the visible pixels, `visibleDiff`). Before this the check ran on the repaint's PNG, not on what is published. If even lossless fails the run fails and nothing is published. `propatlas.ts` (`encodePages`, `publishPropAtlas`), vitest `propatlas.test.ts`.
- **Engine.** `layerFrame` returns, for an atlas, the page, the uv window of the cell in it and the part of the union rectangle the cell covers (`sub`; `empty` for a clear cell: nothing is drawn); the stage fits the layer's quad to that part (`fitQuad`: the corners of a rectangle on a camera-facing plane are affine in the picture's pixels, so the part's corners are the same
  fractions along the rectangle's) and swaps the material's map to the page. A grid strip is `sub: [0, 0, 1, 1]`, page 0, as before. Vitest: `layerAnim.test.ts`, `masks.test.ts` (`fitQuad` projects to the right pixels), `stage.test.ts` (an atlas on two pages), `art.test.ts` (all pages or none; every page freed once).
- **Per room, and freed on exit.** `loadRoomArt` was already per room (`enterArt`, from the stage's `loadToken`) and `disposeRoomArt` runs in `clearRoom`: it now frees every page of every strip once (a page two layers share is freed once), and an atlas with a page that fails to load is left out whole (its other pages are freed at once) and the layer draws the still. A phone's `leanLoaders` already gave a strip no mip chain.
  The service worker needs nothing: pages are `.webp` under `/assets`, cache-first in `au-assets`, stored as they are first used, not precached (`swRules.classify`), so a room's pages are fetched with the room and an old build's pages are pruned by the manifest.
- **Budget.** A room's animated layers may hold **64 MiB** decoded (RGBA8, no mips, each file once; `STRIP_BUDGET_BYTES` in `masks.ts`): a quarter of a 256 MB device, after the plate, its maps and the crew's cards. `art masks <room>` logs what each object and the room hold, and
  `WARNING <room>: … over the 64.0 MB budget` when the room is over; the e2e `every published animated layer is an atlas…` fails above it. Vitest `masks.test.ts` (the report).

| Pilot | Before (grid, decoded, file) | After (atlas, decoded, file) |
|---|---|---|
| `lab.lights.080a` | 4.4 MiB, 183 KB | 4.1 MiB, 893 KB (near-lossless: the lossy WebP failed the card check on its own pixels) |
| `allanor.door.011b` | 2.3 MiB, 104 KB | 2.3 MiB, 101 KB |
| `horst3.rock_pile_endstate` | 19.1 MiB (the fall 16.7), 563 KB | 16.8 MiB (the fall 14.4), 578 KB |
| **three pilots** | **25.8 MiB** | **23.2 MiB** |

The saving is small because these frames are what the packer cannot shrink: the rock pile's sprite is a fully opaque 144x136 rectangle in every frame (cropping gains nothing, and 12 distinct cells at 4x are 15 MB however they are packed; the grid wasted 2 of its 14 slots), the door's cells are mostly the door, and the lights' are dots on a panel.
Large, many-frame sprites are what the budget is for, and they are the next lever's job: a half-resolution strip for lean devices, as plates have (`plate.half.webp`), is 4x less.

**Rollout (small): Mertens Station and Horst III.** The `animated` bucket after 8a held Mertens 3 and Horst III 2 (`placement triage`; no script-changed sprite of either was in the 53). `alter: anim` on each was read as the triage reads it (a scan of `games/unity/objects` and the triggers):

| Object | Kind | Result |
|---|---|---|
| `lab.lights.070f` (`lab.s07`, `w4s8flow`, 216x32) | looping, 14 frames | The repaint failed the card check on the lights' dots (frame 3: 11 of 20 windows speckle, the points measured were the dots, 2.2 to 4.2 px, median flicker 22.2), so `repaint: false` with its `align` reason (as `lab.lights.080a`; no threshold changed). Atlas 14 cells, 5.9 MiB; lossless (lossy and near-lossless failed the check on their pixels), 1.9 MB. |
| `horst3.glow` (`horst3.s03`, `w7s3glow`, 272x190) | looping, 6 frames (3 distinct pictures) | Repainted, passed first run (4 canvases, 50 s; flicker median 5.3, worst shift 0.65 px, dE max 1.5). Atlas 4 cells, 12.6 MiB, 262 KB. |
| `horst3.isolinear_rod` (`horst3.s04`, `w7s4rod`, 98x76) | script-played: off at entry; `aperture` turns it on and plays animation 0 (6 frames), its own script plays animation 2 (5 frames, to a pause) and turns it off | Repainted, passed first run (animation 0: 39 s, worst shift 0.82 px; animation 2: 45 s, 0.47 px; the switch checks passed). Atlas 4.5 MiB. Animation 3 only jumps to 0; no script plays it. |

**Not done (listed, nothing published):** `lab.hologram` (`lab.s05`, `w4s5spin`, 120x182: **119** distinct frames, off at entry, `holotable` turns it on and off) and `lab.strange_machine` (`lab.s06`, `w4s6cdpb`, 306x136: 30 frames of a craft with a flame, no `anim` alter; `active` only)
are over the 64 MiB room budget before they are repainted (about 103 and 76 MiB at 4x, cropped to each frame's opaque bounds: estimated from the sprite's own frames), so they stay what they are, the plate. They want the half-resolution strip, or thinning the frames (a decision on timing), not a repaint. No sprite was refused as walker-scaled, a sprite swap or a speech sprite.
Not in scope, but the same two worlds, and the `invisible` bucket's neighbours: Horst III's `screen_blank` and `screen.0403` (`w7s4panl`, first frame clear, scripts play its other animations) and Mertens' shutdown buttons `lab.group_1` to `group_4`, `lab.power_redirect`, `lab.temporary_shutdown.0c01` and `lab.touchbar` (first frame clear). They are script-changed, are not in the 53, and are the first thing to look at when Mertens' and Horst III's `animated` bucket is empty (it nearly is).

`art masks` was run on `lab.s07`, `horst3.s03` and `horst3.s04` (and again on the three pilots' rooms). e2e (`unity-placement.spec.ts`, skipped until published): the lights test is now a table (`lab.s08`, `lab.s07`, `horst3.s03`: each loops through its frames in order at the strip's own pace, compared with the dump); the rod is published with strips 0 and 2 of 6 and 5 frames, starts on 0, and is off and not drawn at entry (as the dump says); and a test with no browser
checks every published animated layer is an atlas with pages no side over 4096, cells inside their pages, files there, and each room under the budget. The three pilots' tests pass on the atlases. `placement compare`: `no-art` 168 to 166, `later-no-art` 75 to 74. After 8b (`triage`, 240 sprites):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 14 | 24 | 5 | 62 |
| frigis | 4 | 26 | 16 | 0 | 46 |
| horst3 | 8 | 0 | 0 | 2 | 10 |
| lab | 4 | 0 | 2 | 6 | 12 |
| unity | 14 | 10 | 29 | 5 | 58 |
| zoo | 20 | 2 | 30 | 0 | 52 |
| **all** | 69 | 52 | 101 | 18 | 240 |

**Remaining for batch 8 (153: `animated` 101 plus the 52 script-changed `static-missing`), by world:** Allanor 38 (24 animated + 14: the doors `0504`, the ventilation duct, buttons `1103` to `1108` and `sc1` to `sc6`, the security rod), Frigis 42 (16 + 26: the puzzle floor's 22 tiles, touchpad, yellow door, stasis fields),
Unity 39 (29 + 10: shuttle, doors, chips, Brodnack's body, the stasis chambers, Pentara), zoo 32 (30 + 2: the door and shuttle), Mertens 2 (the hologram and the strange machine, over budget), Horst III 0.

(After 8c: Mertens' hologram is published, and 1 remains, `lab.strange_machine`, which failed the card check twice, see "Batch 8c".) The order in "Rollout" above stands: Unity's looping props next, then the script-changed doors and buttons, then Frigis' floor tiles. Anything whose cropped frames at 4x already pass the budget is listed, not rolled out.

## Batch 8c: frames are streamed, not uploaded

8b's atlases cropped little (the frames are mostly opaque: three pilots 25.8 to 23.2 MiB) and uploaded every page of a room's layers to the GPU, so the big sprites could not fit. A layer now keeps its pages **as the WebP bytes they were fetched as** and draws one frame at a time.

- **Pages are bytes.** `loadRoomArt` fetches an atlas strip's pages through `ArtLoaders.page` (default `fetchPage`: `fetch`, then a `Blob`; a page two layers share is fetched once; all of a strip's pages or none, as before) and uploads no texture for them. A grid strip (a one-cell animation the recipe does not animate, or one published before the atlases) is a texture as it was.
- **One texture a layer.** The stage makes, for each layer with atlas strips, one surface (`ArtLoaders.surface`, default `canvasSurface`: a canvas and a `CanvasTexture`, no mips) as big as the layer's largest cell (widest by tallest over all its animations' cells). All of the layer's quads, one per animation, use it; a cell is drawn at the surface's top left and the quad's uv is that window of it (three updates the allocated texture, a `texSubImage2D` of the surface, when the canvas changes).
- **A decoded ring.** `FrameRing` (`frameStream.ts`, vitest `frameStream.test.ts`) holds the frame being drawn and the next two, decoded with `createImageBitmap(blob, x, y, w, h)` (the cell's rectangle of its page), current first, two decodes at a time (the wanted set stays three, so the bitmaps held do not grow). `upcomingFrames` (`layerAnim.ts`; `layerFrame` now also returns the distinct `cell` and `until`, the milliseconds the frame has left) says what comes next: round a loop, or into the animation the original falls into. When a frame comes up and its cell is decoded it is drawn into the surface; **if it is not, the layer holds what it last drew** (the quad, uv and rectangle stay) and the sim and the clock go on: a late frame is never a blank one and never a stall. A layer that has drawn nothing yet (the first cell is still decoding) shows its still, so it is never empty. `artState().layers` reports the frame the clock is on, not the one on screen. A cell with nothing visible draws nothing and decodes nothing.
- **Closed and freed.** A bitmap that leaves the ring is closed; one that finishes decoding after it left (a script jumped to another animation) or after the room went is closed on arrival. A hidden layer (its object off, art off) lets go of its ring. `clearRoom` disposes every ring and surface (texture and canvas), and the pages' bytes go with the room's art.
- **Budget** (`layerMemory.ts`, `layerResident`; `STRIP_BUDGET_BYTES` still 64 MiB a room, the warning still `art masks`', the e2e still fails above it): what is **resident**: each page file once at its encoded size, plus per layer the surface (the largest cell at 4 bytes a pixel, twice: the texture and its staging canvas) and the ring (three of the largest cell, no more than the layer has). `art masks` logs the room's total and what is encoded.

Resident memory of the six animated sprites already published (decoded 8b figures in MiB; `after` = encoded pages + ring + texture and canvas):

| Object | Before (decoded atlas pages) | After | Of it: pages, ring, surface (texture) |
|---|---|---|---|
| `lab.lights.080a` | 4.15 | 2.34 | 0.87, 0.88, 0.59 (688x112) |
| `lab.lights.070f` | 5.86 | 3.94 | 1.87, 1.25, 0.83 (864x126) |
| `allanor.door.011b` | 2.30 | 0.64 | 0.10, 0.33, 0.22 (100x284) |
| `horst3.rock_pile_endstate` | 16.77 | 6.54 | 0.56, 3.59, 2.39 (576x544) |
| `horst3.glow` | 12.63 | 16.03 | 0.26, 9.46, 6.31 (1088x760) |
| `horst3.isolinear_rod` | 4.53 | 2.36 | 0.10, 1.35, 0.90 (392x302) |
| **six** | **46.2** | **31.9** | |

The glow is the one that gets worse: four distinct cells of 1088x760 are 12.6 MiB decoded whole, and a ring of three plus the texture and canvas is 16 MiB. Streaming pays where a layer has many cells (the rock pile's 12, 3x smaller; the hologram's 119 and the machine's 30 are what it is for) and costs a little where a sprite has few and big ones; the room's budget is the limit that matters, and `horst3.s03` is at 16 of 64. Cost not in the table: decoding a cell with `createImageBitmap(blob, x, y, w, h)` makes the browser decode its whole page (up to 4096x4096), on its own thread and in the background, two at a time per layer (measured here: 85 ms for a crop of the hologram's 3873x4005 page, against its 65 ms a frame, so one at a time would play it at about half speed); a lean device that cannot keep up holds frames (the hold rule) rather than stalling.

**Rollout (small): Mertens' hologram and strange machine**, the two 8b listed as over budget. Both read as before (`placement triage`: animation 0, no script plays another).

| Object | Kind | Result |
|---|---|---|
| `lab.hologram` (`lab.s05`, `w4s5spin`, 120x182) | off at entry, `holotable` turns it on and off; one looping animation of **119 frames, all distinct** (nothing to dedupe; 65 ms a frame) | Repainted. First run failed the card check on alignment (frame 0: a point moved 2.52 px, limit 2; frames 60, 74, 77 likewise, worst 3.17 px; flicker median 14.5, dE max 7.2; 277 s), not on speckle alone, so it was not made upscale-only. Second run (seed 94011, denoise 0.28, lineart 1.0; thresholds unchanged) passed: 119 frames, 30 canvases, 292 s, flicker median 13.8, worst shift 2.01 px, dE max 5. Two pages (3873x4005, 3908x3809), 2.8 MB of WebP. Resident: **8.6 MiB** (2.7 pages, 4.0 ring, 2.7 texture and canvas of a 480x728 cell), against about 103 MiB uploaded before. `art masks lab.s05`. |
| `lab.strange_machine` (`lab.s06`, `w4s6cdpb`, 306x136) | looping, 30 frames, no `anim` alter (`active` only) | **Failed twice, listed, nothing published.** Run 1 (seed 94002, denoise 0.4, lineart 0.9): frames 1, 3, 4, 5 a point moved 2.24 to 3.13 px (limit 2), flicker median 18.1, dE max 4.4. Run 2 (seed 94012, denoise 0.3, lineart 1.0): frames 0, 1, 2, 4 moved 2.12 to 3.14 px, flicker median 16.5, dE max 2.8. Both failed on measured shifts, not on speckle alone (so `repaint: false` is not the rule's answer), and nothing was loosened. Its recipe is not committed; it wants a different prompt or a hand-picked seed, or the rule decided for a craft with a flame. Resident cost would be small (30 cells). |

e2e: `lab.s05: the hologram is published as every frame of its loop, and is off and not drawn until the holotable turns it on` (the holotable's puzzle is not driven; the streaming itself is what the lights' tests watch in a real browser).

Tests: vitest `frameStream.test.ts` (ordering, hold on miss, closing when frames leave, loops, jumps, stop, disposal and late arrivals, failed decodes), `layerAnim.test.ts` (`upcomingFrames`, `until`, the existing uv and frame selection unchanged), `layerMemory.test.ts`, `art.test.ts` (pages as bytes, all or none, fetched once), `stage.test.ts` ("streamed atlas strips": the still first, one texture, the next frames ahead, holding a late frame, closing and freeing, a late decode after the room, a clear cell), `masks.test.ts` (the resident report). e2e `unity-placement.spec.ts`: the budget test counts resident bytes; the lights tests wait for the first cell before sampling.

## Batch 8d: whole or streamed, per layer, and Allanor's animated layers

**Engine: whichever costs less.** 8c streamed every atlas layer, which costs more than uploading the pages for a layer with a few big cells (`horst3.glow`: 4 cells of 1088x760, 12.6 MiB whole, 16.0 streamed). `layerMode` (`layerMemory.ts`) compares, per layer, the pages' decoded bytes (RGBA8, no mips: `whole`) with the ring and the surface (`stream`; the encoded pages a stream also keeps are a few percent and are left out of the comparison, so the engine can make it from `presentation.yaml` alone: the strips' `pages` and `cells`). Whole wins only when strictly smaller; a layer with no atlas, or one with no page sizes, streams. `loadRoomArt` calls it per mask: a whole layer's atlas strips take the texture path (`textures`, one per page, the uv window of the cell on its page, as 8b drew them), a streamed one the bytes path of 8c. `art masks` and the e2e budget call the same function (`layerResident(strips)` returns the mode, and for a whole layer the decoded size of each page file): a whole layer's pages count decoded and a streamed layer's encoded, each file once, and `art masks` marks a whole layer in its log. `horst3.glow` is now whole (16.0 to 12.6 MiB); of Allanor's 32 published layers, 5 are whole (the light shaft `o0302` and the four buttons). Vitest: `layerMemory.test.ts` (`layerMode`: the glow, the hologram's shape, a tie, a page two animations share), `art.test.ts` (a layer uploaded whole and one streamed, in one room), `masks.test.ts` (both reports; the existing fixtures that were streamed now use pages that make streaming the cheaper).

Two small fixes found by the rollout: an animation whose every frame is clear (the door `0504`'s animation 2: the door is gone from its frame) made `repaintAnim` throw (`a frame group with no pixels`); it now hands the frames back with no canvas. Such an animation publishes no page (`images: []`), which `art batch`'s published check, the presentation schema and `loadRoomArt` refused; all three accept it now, and the layer draws nothing for it (not the still). Vitest: `cardrepaint.test.ts`, `art.test.ts`, `stage.test.ts` (an animation of clear cells draws nothing).

**Rollout: Allanor (38 sprites).** Read as the triage reads them (`placement triage`, then `alter: anim` on each object in `games/unity/objects`; the start is the animation ScummVM's player is on in the dump). No sprite swaps or speech sprites; one walker (`allanor.admiral_brodnack`, `objwalktype` 1, a talker) is refused. 32 recipes cover 37 objects (`prop.screens`: the rods of `s0f`, `s10`, `s12`, `s13` are one recipe, the lens of `s0a` and the gun of `s0e` another, the buttons `1100` and `1110` of `s11` one). First run, per recipe:

| Result | Recipes |
|---|---|
| Repainted, passed | `sniffer_a` (36 frames, 19 distinct), `sniffer_b`, `pipe_leak_a`, `pipe_leak_b`, `magma_0125`, `s03_light_up`, `amb_090f`, `ambient_s0b`, `isolinear_rod_s12` (animations 0, 2 and the 1 it falls into), `screen_sc1`, `sc2`, `sc6`; second run (seed and denoise 0.2 to 0.25 changed, thresholds unchanged): `button_1107`, `door_0504` (animations 0, 1, 2, 3; animation 1 first failed on flicker median 15.7 against 14, the second run 13.8) |
| Speckle alone, so `repaint: false` and `align: { skip, reason }` (nothing else relaxed; the upscale passed) | `beam_emitter` (lens, gun), `button_1103`, `button_1105`, `button_1108`, `chodalite`, `amb_090d`, `s03_light_down`, `s03_water`, `screen_sc3`, `sc4`, `sc5`, `security_rod_1202`, `vent_duct_0108`; and `s03_reflections` after its second repaint failed on speckle alone (the first also moved a point 3.21 px) |
| **Failed twice, listed, nothing published (recipes not committed)** | `button_1106` (lit1: median shift 1.52 px, then 1.08 against 1), `button_s11_pulse` (buttons `1100` and `1110`, `w2s17but`: a point moved 4.24 px, then 3.08; speckle too), `amb_090c` (a point moved 2.15 px both times, with speckle), `amb_090e` (frame 11 moved 2.41, then 2.40) |
| Refused | `allanor.admiral_brodnack` (walker-scaled, talks) |

Counts: of the 38, **32 animated** (among them the `s05` door, the duct, six screens, four buttons, the lens, the gun and four rods), **5 failed twice** (`button_1106`, `button_1100`, `button_1110`, `amb.090c`, `amb.090e`) and **1 refused**. `button_1100` and `button_1110` also play an animation 1 that their one-animation sprite does not have: the original ignores it (`SpritePlayer::startAnim`), our layer would draw the still for it, so they are not a recipe worth a third run until that is decided.

Resident memory per room after `art masks` (MiB, budget 64): `allanor.s01` 10.7 (7 layers), `s03` 3.7, `s05` 17.7 (the door: 44 frames of 896x992 cells, streamed), `s07` 1.8, `s09` 4.9, `s0a` 0.7, `s0b` 6.4, `s0e` 0.7, `s0f` 3.0, `s10` 3.0, `s11` 1.0, `s12` 18.5 (rod, security rod, six screens), `s13` 3.0. The earlier rooms after the tweak: `horst3.s01` 6.5, `s03` 12.6 (was 16.0), `s04` 2.4, `lab.s05` 8.6, `s07` 3.9, `s08` 2.3. None is over the budget.

e2e (`unity-placement.spec.ts`): the looping table gained nine Allanor layers (the sample window now follows the strip's own pace: the chodalite's frames are slow), and a table of the script-changed layers per room (`SCRIPTED`: the animations and frame counts each is published with, the start against the dump, the layer in `art().masks`, drawn at entry if on and not if off; `s0e` is a cutscene room and is checked without entering it). The budget test counts whole layers decoded and accepts a strip with no page. Two older tests (the first door, the rock pile) now wait for the first cell before asserting the frame (they raced the decode when the machine was busy). `unity-placement` and `unity-art-worlds` pass.

`compare` after: `no-art` 166 to 145, `later-no-art` 73 to 62 (`position` 1, `anim` 1, `state` 1 as before). `triage` (207 sprites; 8c's counts were not refreshed and the hologram has gone from `animated` since):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 1 | 5 | 5 | 30 |
| frigis | 4 | 26 | 16 | 0 | 46 |
| horst3 | 8 | 0 | 0 | 2 | 10 |
| lab | 4 | 0 | 1 | 6 | 11 |
| unity | 14 | 10 | 29 | 5 | 58 |
| zoo | 20 | 2 | 30 | 0 | 52 |
| **all** | 69 | 39 | 81 | 18 | 207 |

**Remaining for batch 8 (120: `animated` 81 plus 39 `static-missing`), by world:** Allanor 6 (the five failed twice and the admiral), Frigis 42, Unity 39, zoo 32, Mertens 1 (`lab.strange_machine`, failed twice in 8c). Next: Unity's looping props, then Frigis' floor tiles and zoo.

## Batch 8e: ignored animations, and Frigis

**Fix: an animation the sprite does not have.** `SpritePlayer::startAnim` (`sprite_player.cpp`) warns and returns when the index is past the sprite's animations, so the sprite stays on the animation it was on; `Object::loadSprite` does the same for a saved `anim_index` that is out of range (it starts animation 0). Our layer drew the still for such an index (8a: "an animation with no strip draws the still"). The layer now ignores it: `updateLayer` (and the start from a save in `addLayer`) take a `state.anim` that is not one of the layer's strips as no change, so the layer stays on the animation it is on, and a later real index is followed as before. `ObjectState.anim` is left alone (it is what the last alter set, as the original's `anim_index`, and the rules never read it; the sim does not know a sprite's animations). Allanor's buttons `1100` and `1110`, which play an animation 1 that `w2s17but` does not have, are covered by this when they are rolled out (they failed the card check twice, see 8d). A strip that failed to load is not told apart from an animation the sprite lacks: the layer stays on the animation it is on rather than drawing the still. Vitest: `stage.test.ts` (an index with no strip is ignored, before and after a real one; the failed strip).

**Rollout: Frigis (42 sprites).** Read as the triage reads them (`placement triage`, then `alter: anim` on each object and the entry state in the dump). 38 recipes cover 40 of the 42 objects (three share a sprite and are one recipe each: the force field and its mask object `mask_force_field` of `s03`, the stasis fields `0909` and `0910` of `s09`; the manuscript pair below failed). The 22 puzzle floor tiles are **not** one sprite: each is its own (`w5s4tl22` to `w5s4tl43`, 168x74 down to 62x22, one frame each), so there is one still recipe per tile (`card.frigis_floor_tile_06` to `_30`), published together in one run. A script sets their state, but the picture does not follow it (one animation, one frame), so they are plain cards that go with `active` (5 are off at entry). No sprite swaps, no walkers; the stasis fields' sprite also carries a speech sprite and a sound, which a still does not draw.

| Result | Recipes |
|---|---|
| Repainted, passed first run | `volcanoes_s01`, `heat_0206`, `heat_0207`, `force_field_s03` (3 frames; its other three animations are not played by a script), `light_1` to `light_4` (6 frames each), `red_light_0506` (8 frames), `pipe_gas_s05` (4 frames), the 22 floor tiles, `stasis_field_s09` (still) |
| Speckle alone, so `repaint: false` and `align: { skip, reason }` (nothing else relaxed; the upscale passed) | `transporter_rave_020c` (7 frames), `blue_door_s04` (65 frames, worst shift 1.36 px), `yellow_door_s04` (animation 0 one frame, animation 1 65 frames), `touchpad_0434`; and `transporter_acid_011e` (19 frames) after a second run (seed and denoise 0.3 to 0.25 changed, thresholds unchanged): the first moved a point 2.13 px with speckle, the second was speckle alone with a worst shift of 1.94 px |
| **Failed twice, listed, nothing published (recipe not committed)** | `manuscript_s05` (`frigis.anim_manuscript` and `frigis.manuscript.050b`, `w5s5fire`): animation 0 (16 frames) passed on speckle alone both times, but animation 1 (17 frames, played by `anim_manuscript`) moved points 3.15 and 3.27 px, then 3.15, 3.79 and 3.33 px (limit 2) |
| Refused | none |

The blue door's sprite (`w5s4door`) lists a second animation, but its entry is `0xFFFFFFFF`: `open_door`'s play of it is ignored (by the fix above, as the original has nothing to start), the door's 65 frames of animation 0 (it opens onto a tunnel) run from entry like the original's sprite, which starts on room load, and the layer shows its last frame, the open door, once `open_door` turns the object on. The yellow door's animation 1 is played by `open_door` and restarts the strip.

Counts: of the 42, **40 published** (15 animated layers: the volcanoes' haze, the transporter doorways `011e` and `020c`, two heat hazes, the force field and its mask, the two doors, four lights, the red light and the pipe's gas; and 25 stills: the 22 floor tiles, the touch pad and both stasis fields), **2 failed twice** (`anim_manuscript`, `manuscript.050b`), **0 refused**., of the 38 recipes 5 are upscale-only (`rave`, both doors, the touch pad, the acid doorway).

Resident memory per room after `art masks` (MiB, budget 64): `frigis.s01` 6.7 (the doorway 4.1, the haze 2.6), `s02` 7.4, `s03` 2.1 (the two objects share one atlas), `s04` 6.5 (the doors 3.1 each; the lights are under a MiB; the tiles are stills, outside the strip budget), `s05` 8.8 (the pipe's gas 8.1 whole), `s09` none (stills). None is near the budget.

e2e (`unity-placement.spec.ts`): the looping table gained seven Frigis layers (the haze, both heat hazes, the force field, two of the lights, the gas), the script-changed table four more rooms' layers (`SCRIPTED`: both doorways, both doors with the animations and frame counts each is published with, the red light; each off at entry, as the dump says), and the layers table the 22 tiles, the touch pad and both stasis fields. `unity-placement` and `unity-art-worlds` pass.

`compare` after: `no-art` 145 to 116, `later-no-art` 62 to 51 (`position` 1, `anim` 1, `state` 1 as before). `triage` (167 sprites; Frigis' 40 have left it):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 1 | 5 | 5 | 30 |
| frigis | 4 | 0 | 2 | 0 | 6 |
| horst3 | 8 | 0 | 0 | 2 | 10 |
| lab | 4 | 0 | 1 | 6 | 11 |
| unity | 14 | 10 | 29 | 5 | 58 |
| zoo | 20 | 2 | 30 | 0 | 52 |
| **all** | 69 | 13 | 67 | 18 | 167 |

**Remaining for batch 8 (80: `animated` 67 plus 13 `static-missing`), by world:** Allanor 6 (the five failed twice and the admiral), Frigis 2 (the manuscript pair), Unity 39, zoo 32, Mertens 1 (`lab.strange_machine`). Next: Unity's looping props, then zoo.

## Batch 8f: Unity

**Rollout: Unity (39 sprites).** Read as the triage reads them (`placement triage`, then `alter: anim` on each object in `games/unity/objects`; the start is the animation ScummVM's player is on in the dump; no sprite swaps). 30 recipes were run for 31 of the objects (`prop.screens`: the panel button of `s08` and `s0e` is one recipe). Refused, nothing run: **8**: `unity.shuttlecraft` (`w6s1shtl`: the 88 frames of its animation 1 end in 11 speech-sprite frames, a mouth drawn over a marked frame) and the seven walker-scaled objects (`objwalktype` 1, drawn at 99 to 191/256 where they stand, which `art masks` refuses for a strip): the six balls of `s07` (`picard_ball_1`/`_2`, `pentara_ball_1`/`_2`, `brodnack_ball_1`/`_2`, off at entry) and `unity.brodnack_s_body` of `s06` (scale 116/256). First run, per recipe:

| Result | Recipes |
|---|---|
| Repainted, passed | `big_sun_s10` (21 frames, 20 distinct, 10 canvases), `chip_left_s06`, `chip_right_s06`, `door_0504` (23 frames), `energy_current_s0c`, `force_field_0519`, `force_field_0720`, `force_field_s0c`, `forcefield_bm_1`, `forcefield_bm_2`, `little_gen_zap`, `grin_s0d`, `panel_button`, `side_light_0f02`, `vortex_bottom_s0a`; second run (seed +1000, denoise 0.2, thresholds unchanged): `shuttle_0508` (animation 2 first failed the switch to 1 at 27.4/255 against 14), `shuttle_door_s04` (animation 1 first moved a point 3.86 px) |
| Speckle alone, so `repaint: false` and `align: { skip, reason }` (nothing else relaxed; the upscale passed) | `forcefield_bm_3`, `glow_s03` (32 to 37 of the 38 to 43 strongest windows speckle), `door_0e00`, `smoke1_s06`, `symbol_0706`, `vortex_top_s0a`, and the three stasis recipes `stasis_0e03`, `pentara_0e0f`, `stasis_0e18` (so frame 0 of the chambers of `s0e` is the original's own, not the repainted one `s08`'s cards show) |
| **Failed twice, listed, nothing published (recipes not committed)** | `lights_s02` (flicker 3.5 to 5.5 against a median of 0.0: 24 frames of 5 pictures, so most neighbours are equal; both runs), `shuttle_0400` (animation 2, 42 frames: a point moved 3.64 px, then 2.01 px with flicker across the switches 15.7 to 16.4/255, limit 14), `shuttle_050f` (a point moved 4.24 px with flicker 10.1 against 2.5, then flicker 8.8 and 8.0 against 2.2), `side_light_0f03` (a point moved 3.35 px, then 3.49) |
| Refused | `unity.shuttlecraft`, the six balls, `unity.brodnack_s_body` |

Counts: of the 39, **27 animated** (in 26 recipes; among them the sun, the vortex halves, the three stasis chambers, the doors and the panel buttons; the chips are two one-frame animations each), **4 failed twice** (`unity.lights`, `unity.shuttle.0400`, `unity.shuttle.050f`, `unity.side_light.0f03`) and **8 refused**.

Resident memory per room after `art masks` (MiB, budget 64): `unity.s03` 17.0 (the glow), `s04` 2.4, `s05` 11.2 (the shuttle 7.6, the door 3.3), `s06` 2.9 (six small layers and the smoke), `s07` 1.3, `s08` 0.1, `s0a` 34.2 (the vortex halves: top 21.3, bottom 12.9, the biggest of any room), `s0c` 7.8, `s0d` 1.2, `s0e` 17.1 (door, panel, three chambers), `s0f` 1.9, `s10` 24.4 (the sun). None is over the budget. `s0b` and `s0f` were checked as 8d checked `allanor.s0e`: `s0b` has none of these objects, and `s0f` settles. The two rooms that run a cutscene on entry are `s04` (`as_inside_shuttle`) and `s10` (it never settles): their layers are checked as published and drawn at entry, not by the layer tests.

e2e (`unity-placement.spec.ts`): the looping table gained fourteen Unity layers (the hall's glow, the force fields, the smoke, the zap, the key symbol, the panel button, the energy current and emitter, the dome, the side light), the script-changed table nine more rooms (`SCRIPTED`: the glow, the shuttle door, the door and shuttle of `s05`, the chips, the vortex halves (off at entry), the door, panel and three chambers of `s0e`, the side light, the sun) and a test for the two cutscene rooms. The hologram and rod tests now wait for the plate before reading the masks (the hologram's raced it once when the machine was busy). `unity-placement` and `unity-art-worlds` pass.

`compare` after: `no-art` 116 to 93, `later-no-art` 51 to 47 (`position` 1, `anim` 1, `state` 1 as before). `triage` (140 sprites; Unity's 27 have left it):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 1 | 5 | 5 | 30 |
| frigis | 4 | 0 | 2 | 0 | 6 |
| horst3 | 8 | 0 | 0 | 2 | 10 |
| lab | 4 | 0 | 1 | 6 | 11 |
| unity | 14 | 2 | 10 | 5 | 31 |
| zoo | 20 | 2 | 30 | 0 | 52 |
| **all** | 69 | 5 | 48 | 18 | 140 |

**Remaining for batch 8 (53: `animated` 48 plus 5 `static-missing`), by world:** Allanor 6 (the five failed twice and the admiral), Frigis 2 (the manuscript pair), Unity 12 (the four that failed twice and the eight refused), zoo 32, Mertens 1 (`lab.strange_machine`). Next: zoo.

## Batch 8g: the zoo

**Rollout: zoo (32 sprites).** Read as the triage reads them (`placement triage`, then `alter: anim` on each object in `games/unity/objects`; the start is the animation ScummVM's player is on in the dump, which is 0 for every one: the sprites of `anim_index` 65535 start on 0). 26 recipes were run for 31 of the objects (`prop.screens` was not needed: the five habitat lights, the four corals and the three scans share a sprite only inside one room, so `prop.objects` lists them). Refused, nothing run: **1**, `zoo.dr_hyunh_foertsch.030a` (`objwalktype` 1, a talker, scripts play 4 and 5 on it: a walker-scaled object, which `art masks` refuses for a strip). No sprite swaps, no speech sprites. The two that 7b skipped are in: the shuttle (`w3s5ship`, animation 0 one frame, `shuttle_timer` plays 1, 45 frames) and the door (`w3s5door`, animations 0 and 1 are one frame each, `c006` plays 1). The microgenerator `050c` (`w3s5genr`) is published with animation 0 only: the power ports and `ts_for_path` that play its animations 1 to 3 and 5 to 7 are in `s06` to `s08`, where it has been carried to, and the layer is `s05`'s.

A rerun of every recipe: the first round ran while another job used ComfyUI's input name `card-in`, so a run could upscale the other job's frame (`the upscaler returned 496x1128 for a 208x36 frame`) and any pass was suspect. The cache of the 26 recipes and the published cards were cleared and the lot was run again once that job's input had been renamed (`34824a5`); the results below are the second round, and the same recipes failed. First run, per recipe:

| Result | Recipes |
|---|---|
| Repainted, passed | `boar_scan_s04`, `gibbon_scan_s04`, `mole_scan_s04`, `sensory_array_s04`, `door_s05`, `marine_map_s08` (animation 0, 37 frames), `habitat273_s08`, `worm_s09` (53 frames, 16 canvases), `microgenerator_s05` (once it was cut to animation 0, see below); second run (seed +1000 and denoise 0.25 to 0.2, thresholds unchanged): `screen_041c` (first run: a point moved 4.24 px) |
| Speckle alone, so `repaint: false` and `align: { skip, reason }` (nothing else relaxed; the upscale passed) | `com_port_light_s03`, `grid_overview_s10`, `jelly_corals_12_s08`, `jelly_corals_34_s08`, `jellybird_s01` (59 frames), `leaf_s01`, `monkey_s01` (animations 0 to 3), `sensor_0604`, `sensor_0712`, `sensor_0814`, `shuttle_s05` (animation 0 passed a repaint, animation 1 is speckle alone: the check listed only speckle for it, though its dE max was 20.7), `worm_s02`; and `habitat272_s08` after a second repaint (the first moved a point 3.00 px, the second was speckle and one frame with no window to measure) |
| **Failed twice, listed, nothing published (recipes not committed)** | `flock_s01` (`zoo.akire_flock`: a point moved 3.14 px, then 2.36 and 2.31), `canyon_map_s06` (animation 0: a point moved 3.00 px, then 2.12), `bogforest_map_s07` (a point moved 3.89 px, then 3.13) |
| Refused | `zoo.dr_hyunh_foertsch.030a` |

The microgenerator's first run (all eight animations the scripts play) failed six animations on speckle alone and the other two passed; as `repaint: false` its switches then failed the transition check (4 to 0: flicker 2.9/255 across the switch against a median of 0.0, limit 2.5x). Rather than loosen the rule it was run for the one animation `s05` can show, which repainted and passed (flicker median 3.7, worst shift 0.00 px).

Counts: of the 32, **28 animated** (the leaf, the monkey, the jellybird, two worms, the comm port light, the screen, the three scans and the sensory array, the shuttle, the door, the microgenerator, three sensors, the marine map, five habitat lights, four corals, the grid display), **3 failed twice** (`zoo.akire_flock`, `zoo.canyon_map`, `zoo.bogforest_map`) and **1 refused** (`zoo.dr_hyunh_foertsch.030a`). 13 of the 23 recipes are upscale-only.

Resident memory per room after `art masks` (MiB, budget 64): `zoo.s01` 10.3 (the jellybird 8.3, the monkey 1.4), `s02` 0.4, `s03` 0.2, `s04` 4.0, `s05` 10.2 (the shuttle 9.9), `s06` 0.2, `s07` 0.3, `s08` 17.1 (corals, habitat lights, marine map), `s09` 1.1, `s10` 3.3. None is near the budget. No zoo room needed the cutscene check (see the e2e).

e2e (`unity-placement.spec.ts`): the looping table gained ten zoo layers (the leaf, the comm port light, the screen, the microgenerator, a habitat light and a coral of each sprite, the worm, the grid display), the script-changed table seven rooms (`SCRIPTED`: the monkey and the jellybird, the worm, the scans and the sensory array, the door and shuttle, the sensors, the marine map; all off at entry except the monkey, door and shuttle). `unity-placement` and `unity-art-worlds` pass.

`compare` after: `no-art` 93 to 75, `later-no-art` 47 to 37 (`position` 1, `anim` 1, `state` 1 as before). `triage` (112 sprites; the zoo's 28 have left it):

| World | in-plate | static-missing | animated | invisible | Total |
|---|---|---|---|---|---|
| allanor | 19 | 1 | 5 | 5 | 30 |
| frigis | 4 | 0 | 2 | 0 | 6 |
| horst3 | 8 | 0 | 0 | 2 | 10 |
| lab | 4 | 0 | 1 | 6 | 11 |
| unity | 14 | 2 | 10 | 5 | 31 |
| zoo | 20 | 0 | 4 | 0 | 24 |
| **all** | 69 | 3 | 22 | 18 | 112 |

**Remaining for batch 8 (25: `animated` 22 plus 3 `static-missing`), by world:** Allanor 6, Frigis 2, Unity 12, zoo 4 (the flock, the two maps and Dr. Hyunh), Mertens 1. All of them are in the summary below.

## Batch 8 summary (8a to 8g)

All 159 sprites of batch 8's input (105 `animated` and 54 script-changed or kept) have been looked at. **134 are published as animated layers or stills** (8a 3, 8b 3, 8c 1, 8d 32, 8e 40, 8f 27, 8g 28), **15 failed the card check twice** and **10 were refused**; none is over the budget now. Every published room is under the 64 MiB budget (largest: `unity.s0a` 34.2, `unity.s10` 24.4, `allanor.s12` 18.5). Nothing was loosened: every threshold is as 8a set it, and each upscale-only recipe carries its `align` reason.

**Everything not done (25), with the reason each:**

| Sprite | Why | What it would take |
|---|---|---|
| `allanor.button.1106` (`button_1106`) | Failed twice: the lit animation's median shift was 1.52 px, then 1.08 against a limit of 1. | A third run with another prompt or seed, or a decision on the limit. |
| `allanor.button.1100`, `allanor.button.1110` (`button_s11_pulse`, `w2s17but`) | Failed twice: a point moved 4.24 px, then 3.08, with speckle. Their animation 1 does not exist in the sprite; 8e's fix ignores it, so the recipe is publishable once it passes. | Another prompt or seed. |
| `allanor.amb.090c` | Failed twice: a point moved 2.15 px both times, with speckle. | Another prompt or seed. |
| `allanor.amb.090e` | Failed twice: frame 11 moved 2.41 px, then 2.40. | Another prompt or seed. |
| `allanor.admiral_brodnack` | Refused: walker-scaled (`objwalktype` 1), a talker. | Resampling a strip to the walker's scale (not built), and a design for the mouth. |
| `frigis.anim_manuscript`, `frigis.manuscript.050b` (`w5s5fire`) | Failed twice: animation 1 (17 frames) moved points 3.15 to 3.79 px (limit 2); animation 0 passed on speckle alone. | Another prompt or seed; the fire moves, so a repaint may never hold it. |
| `lab.strange_machine` (`w4s6cdpb`) | Failed twice on measured shifts (2.12 to 3.14 px, flicker median 16.5 to 18.1), not speckle, so `repaint: false` is not the rule's answer. | Another prompt or a chosen seed, or deciding the rule for a craft with a flame. |
| `unity.lights` (`s02`, `lights_s02`) | Failed twice: flicker 3.5 to 5.5 against a median of 0.0 (24 frames of 5 pictures: most neighbours are equal, so the ratio rule cannot pass). | A decision on the ratio for sprites that repeat frames. |
| `unity.shuttle.0400` | Failed twice: animation 2 (42 frames) moved a point 3.64 px, then 2.01, with flicker across the switches 15.7 to 16.4/255 (limit 14). | Another seed, or a decision on the switch check. |
| `unity.shuttle.050f` | Failed twice: a point moved 4.24 px, then flicker 8.8 and 8.0 against a median of 2.2. | Another seed. |
| `unity.side_light.0f03` | Failed twice: a point moved 3.35 px, then 3.49. | Another prompt or seed. |
| `unity.shuttlecraft` (`w6s1shtl`) | Refused: its animation 1 ends in 11 speech-sprite frames (a mouth over a marked frame). | The crew cards' route for mouths. |
| `unity.picard_ball_1`, `_2`, `unity.pentara_ball_1`, `_2`, `unity.brodnack_ball_1`, `_2` (`s07`) | Refused: walker-scaled (`objwalktype` 1, 99 to 191/256), off at entry. | Resampling a strip to the walker's scale. |
| `unity.brodnack_s_body` (`s06`) | Refused: walker-scaled (116/256). | The same. |
| `zoo.akire_flock` (`flock_s01`) | Failed twice: a point moved 3.14 px, then 2.36 and 2.31. | Another prompt or seed. |
| `zoo.canyon_map` (`canyon_map_s06`) | Failed twice: animation 0 (42 frames) moved a point 3.00 px, then 2.12; animation 1 is speckle alone. | Another seed. |
| `zoo.bogforest_map` (`bogforest_map_s07`) | Failed twice: a point moved 3.89 px, then 3.13. | Another seed. |
| `zoo.dr_hyunh_foertsch.030a` | Refused: walker-scaled (`objwalktype` 1), a talker. | Resampling a strip to the walker's scale. |

(The 25 are 15 that failed twice, 10 refused; the table folds the balls and the buttons into one row each.) No sprite is listed as over budget: Mertens' hologram, over it in 8b, was published in 8c by streaming. The refused kinds are what is left of the design: **walker-scaled** (Allanor's admiral, Unity's seven, the zoo's Dr. Hyunh: 9), **speech sprites** (the shuttlecraft: 1), and no sprite swaps were found in any world. (Batch 10 below built the first two: the walker-scaled objects publish as animated layers, and a character's speech sprites play while it replies; the shuttlecraft's mouths are not done.) The 15 that failed twice want a prompt and seed per recipe (the failed recipes are in the job's scratch directory, not committed); the walkers want the strip resampled; `unity.lights` and the shuttle's switches need a decision on the flicker rules, which stay as they are.

## Mertens Station, played through: effects and the layers a play showed wrong

A play of Mertens Station (the beam-down, the walk to the trapped woman, the phaser on the cable, the cable beamed away, the med kit, the probe, the consoles)
showed eight things wrong. The placement dump (`npm run placement`) and the muted ScummVM harness's `shot` found the causes; `apps/web/e2e/unity-mertens-effects.spec.ts`
plays the sequence with the art on and keeps a picture of each step.

| What was wrong | Cause | Fix |
|---|---|---|
| No transporter effect leaving the ship or arriving | Nothing drew one: pad cards vanished, the team appeared | `beam.ts`: `beamEffect` (awayteam.cpp:1082) as the original plays it: `teffect.spr` animation 0 over the objects, then animation 1 while they dissolve over seven 206 ms steps (the original's 4x4 block masks, `Graphics::blit`). Pads' cards (`ShipPlate.beam`), the arriving team (hidden from arrival until the beam-in plays; `energizeAndArrive` waits for it) and props (`PropBeam`) take it. Strips: `art strips beam_effect --sprite teffect --upscale-only` (and `beam_chodak`, `chodbeam.spr`). |
| The cable not shown on the way to the woman | The second screen's cable is not in the plate. `lab.cable_mask.0216`, `lab.big_cable.0203` and the third screen's `lab.cable_mask.031c` are sprites named for a mask, so `art masks` cut them from the plate, but their pixels are the cable's (12 to 21% of each matches the original background) | Cards for them (`card.lab_cable_s02`, `_cable_mask_0216` (three animations, the transporter's `get` plays 1 and 2), `_flat_cable_mask`, `_cable_mask_031c`). |
| The phaser's beam not shown | A thin 3D line the camera and plate hid | `phaserFx.ts`: `phaserShot` (awayteam.cpp:1184) in the original's pixels: the muzzle of the direction a crew member fires in (`art phaser publish`: the executable's `_phaserMuzzles` and the four palette colours, into the local presentation.yaml), the target's aim point (the sprite's `mouthPos`, published with the layer as `aim`), a three-pixel beam on every other of 16 steps, a pulse running back along it. Not done: the crew member's firing animation (the cards have no strips for it). |
| The cable beamed away lands in the corner | A layer is published where the sprite is drawn at the start (`lab.piece_of_cable.0101`: 100, 100). `beamIn: p310_305` moved the object, not its layer | `Stage.moveMask`: a layer follows its object by the pixels it moved from its home (`moveQuad`). Also its effect: the sparkle and dissolve on the beam-in. |
| The cut cable still by the woman after the beam | `lab.big_cable.0307` was a still of animation 1; the transporter's `get` plays animations 2, 3 and 4 on it (and 1 and 2 on `cable_mask.0216`) | Both are animated layers now (`card.lab_cut_cable` animations 1 to 4). |
| The woman not animated after the med kit | One still. The sprite's animation 3 (14 distinct frames) wakes her, then animation 1 sits her up | `card.lab_woman_revive` animates animations 0 and 1; a play that waits (`wait: true`) now lasts as long as the layer plays the animation (`waitForAnim`, `animationMillis`), not 0.6 s; the second screen's woman, drawn at 45/256, is a still; an animated layer of a walker-type object (this woman, at 162/256) is drawn with its rectangles shrunk about the sprite's origin (`scaledAbout`). **Animation 3 is not published**, see below. |
| The probe not on the screen | `lab.strange_machine` (the alien craft over the conduits of the sixth screen; `w4s6cdpb.spr`, 306x136, 30 frames) was one of 8c's two sprites that failed the card check twice, so nothing was drawn | A new recipe (`card.lab_strange_machine`) failed once on a measured shift (2.17 px, limit 2), and passed on its second try (a lower denoise, a new seed, two frames a canvas): 30 frames, median flicker 8.2, worst shift 1.15 px; another run has since settled its seed (see the recipe). 15 MB resident, streamed. |
| Consoles not animated on a button | The buttons were stills or in the plate; their scripts play 1 (and 2) then 0 | Animated layers for the transporter console (`lock_on`, `energize`) and the core console's buttons (`emergency_systems`, `power_redirect` (upscale-only: its repaint failed on speckle alone), `shutdown`, `temporary_shutdown`, `group_1` to `group_4`, `touchbar`). `ObjectState.anim` is set by `alter: anim` as before, and the layer follows it. |

**Not published:** the woman's animation 3 (`card.lab_woman_revive`) failed the card check twice on measured shifts, not speckle (seed 91002: frames 2, 3 and 6 moved a point 2.15, 2.16
and 3.58 px; seed 91303: frames 0 and 4 moved one 2.26 and 2.29 px; limit 2), so by the rule it is listed and nothing is loosened. Until a prompt or seed passes (add 3 to `anims` and
`prop.animate`) the layer draws animation 0 while the script plays 3, then animation 1.

Found on the way: `publishStrips` wrote `pixelHeight: 0` for a sprite with no standing frame, which the presentation schema refuses, and the whole game then stayed on its loading screen.

## Batch 9: the sprites that failed twice, retried

A third look at the 14 that failed the card check twice in batch 8 (`unity.lights` was left as it is). Nothing was loosened: every threshold is the card check's own. Two of the three causes are not drift: a sprite whose original is speckle fails on the share of unmeasurable windows at every seed, and only an upscale-only recipe (`repaint: false` with its `align` reason) can pass; a seed or a lower denoise (0.12 to 0.15 instead of 0.2 to 0.25) fixes real drift.

| Sprite | Cause | Fixed by | Result |
|---|---|---|---|
| `allanor.button.1106` | the corners of a slanted lit rectangle moved a median 1.08 px | seed 95201 for animation 0 | published (worst 1.33 px) |
| `allanor.amb.090e` | a drifting point | denoise 0.15, seed 95501 | published (worst 1.44 px) |
| `allanor.amb.090c` | speckle: 13 to 15 of 25 to 27 windows of four frames, at four seeds | upscale-only | published |
| `allanor.button.1100`, `1110` | frame 0 is a dim flat glow, 11 of 12 windows speckle; the other frames pass at three seeds | upscale-only | published |
| `unity.side_light.0f03` | drift | denoise 0.15 (seed unchanged) | published |
| `zoo.akire_flock` | drift | denoise 0.15, seed 99101 | published (worst 1.28 px) |
| `zoo.canyon_map`, `zoo.bogforest_map` | terrain texture under the grid is speckle (frames 29 to 31, frame 21, animation 1), and a point moved 2.1 to 3.9 px | upscale-only | published |
| `frigis.anim_manuscript`, `frigis.manuscript.050b` | the burning frames' flame wisps are thin and speckled (frame 12: 5 of 8 windows) | upscale-only | published |
| `unity.shuttle.0400` | speckle in frames 11, 14, 39, 41 of animation 2 | upscale-only | published |
| `lab.strange_machine` | drift, one point at 2.17 px at denoise 0.2 | denoise 0.12, seed 94101 | published (worst 1.17 px, flicker median 11.7) |
| `unity.shuttle.050f` | flicker: the last frames of both animations (the hatch closes to a sliver) flicker 5.9 to 8.3/255 against medians 1.7 to 2.1 (limit 2.5x), at six seeds and denoise 0.1 to 0.15, with a depth control too; shifts 0.97 to 3.13 px | nothing held | still not published |

Still not done: `unity.lights` (the flicker ratio rule), `unity.shuttle.050f` (above) and the 10 refused.

## Batch 10: characters that move like the original

Until now a character's card was one frame, hidden or shown with its object. The original plays an idle loop for each (the animation ScummVM's sprite player is on at entry), a talk
animation while it replies, and a crew member fires a phaser with a firing animation. Everything here goes through the strip pipeline of batch 8 (`prop.animate`) and its
checks, unchanged: repaint first, `repaint: false` with the `align` reason only for a failure that is speckle alone, a recipe that fails twice is listed and not published.

Memory: every room's animated layers are under the 64 MiB budget (`art masks` reports it): the largest are `unity.s0a` 47.7 MiB (the guardian adds 13.5), `allanor.s09` 27.8, `unity.s0f` 24.0, `unity.s0e` 21.1.
Tests: vitest in `sprites.test.ts` (priming, positions, flags, `replyAnims`), `strips.test.ts` (`mouthOver`), `masks.test.ts` (`talk`, the under-a-pixel layer), `art.test.ts`, `stage.test.ts` (talking layers, the firing shot), `actors.test.ts`, `cardrun.test.ts`; e2e rows for each step in `unity-placement.spec.ts`.

### 10a: idle loops (14 recipes, 17 objects that are drawn at entry or after a script)

Each recipe lists the animation the object starts on in `prop.animate` (and `prop.anim`, the one the dump says is playing: `zoo_constable_s03` had said 1 where ScummVM is on 0, see below).
The e2e rows (`unity-placement.spec.ts`, "plays the loop the original does") check the published strip against the dump (the animation, a loop that never stops), that the layer is drawn from the
strip and not the still, and, where a loop is a few seconds long, that its frames come in order.

| Object | Strip | Result |
|---|---|---|
| `lab.dr_griems` (Mertens, `s08`) | 32 frames, 10.8 s | repainted, worst shift 1.12 px |
| `lab.o0a04` (the transporter console's ship, `s0a`) | 29 frames | repainted, worst 1.42 px |
| `frigis.stamblyr` (`s06`) | 20 frames | repainted, 0.28 px |
| `frigis.pluvoids` (`s06`) | 4 frames, 0.4 s, and 2 | upscale-only: 18 to 20 of 30 to 32 windows speckle, worst shift 0.83 px |
| `zoo.veronda_bird` (`s03`), the snake (`s01`), the field units (`s04`), the constable of `s10` | 7, 13, 5, 2 frames | repainted |
| `zoo.flock` (`s06`), `zoo.deer` (`s02`) | 13 and 11 frames | upscale-only (as the stills were) |
| `unity.captain_picard.0b04` (`s0b`) | 14 frames, 28 s | repainted, 0.55 px |
| `unity.guardian.0a07` (`s0a`) | 26 frames, 224x192 | upscale-only: frame 13 has 16 of 28 windows speckle, nothing measured moved (0.68 px); 13.5 MB resident |
| `unity.borg` (`s0f`), `unity.disks` (`s0c`) | 60 and 4 frames | borg upscale-only as before; disks repainted |

Not tested at entry (off until a script turns them on): the constable of `s10`, the deer, the disks. Nachyl is under talking below.

### 10b: talking

What the original does (`UnityEngine::replyAnims`, `sayLine`, talk.cpp): a character that replies plays animation 2 for the line and then goes back to animation 3 if its sprite's flags say it talks (`kSpriteTalks`, 2), 1 if they say it idles
(`kSpriteIdle1`, 4), else 0 (a crew-flagged sprite does neither: the crew cards turn). The flags are what the sprite's script sets before it first stops (`SpritePlayer::initFlags`: `spriteFlags`, `replyAnims` in `sprites.ts`).

- **Speech sprites.** A talk animation's frames are speech sprites over a frame an earlier animation marked (`mark`), and the player keeps that mark when it changes animation, so playing animation 2 on its own has no frames (Laraq's has 0). `SpriteJson.primed`
  (set by the recipe's `prop.talk`) plays the start animation first and carries its state. The speech frame's place was also wrong without the sprite's own `position` entries (Laraq's mouth came out at the bottom of her frame):
  `playAnim` now tracks them as `drawSprite` does.
- **Mouths over the body.** The strip of a speech animation is the marked frame repainted once, with each mouth's pixels put back over it where the frame with the mouth differs from the one without (`mouthOver`, `MadeAnim.base`). The body is the same in every frame and the same
  as the start animation's when it is the same frame, so a switch between the two shows only the mouth, and the check is the card check as it was. (The first way, repainting each mouth composite apart, failed the switch check at 3.4 to 3.6/255 against a median of 0.1.)
- **Engine.** `art masks` publishes `talk: { anim, idle }` with the layer; `Stage.speak` (the presenter calls it as a line goes up and down) plays the talk animation on the speaker's layer from its first frame, then the idle one, or the animation it started on where there is no idle strip.
  The layer follows `state.anim` as before: a script that plays another animation takes it.

| Character | Result |
|---|---|
| Laraq (`frigis.chancellor_laraq`, `s01`) | published: 11 frames of one body and six mouths, flicker median 1.6, worst shift 0.50 px; the original's player is on 2 at entry with her body on frame 0 (its mouths skipped), which is what the card is until she speaks |
| Nachyl (`s07`), Aelont of `s07`, the constable of `s03`, Dr. Hyunh of `s09` | published: body movements, no mouths (their animation 2 is 6 to 10 frames; Nachyl's falls into her loop); the constable's card starts on animation 1, see below |
| Madia (`s03`), the gatekeeper (`s0a`), Aelont of `s09` | **listed, three runs each** (denoise 0.3, 0.2, 0.15): their mouths are drawn over a frame that is not the one the idle animation stands on, so speaking is a change of pose in the original, and the two repaints, painted apart, flicker across it: 8.6, 6.0, 5.2/255 (Madia), 5.6, 4.1, 3.6 (gatekeeper), 9.1, 7.4, 6.8 (Aelont) against a limit of 2 or 2.5x the median. Their talk animation itself passes (Madia's, flicker median 2.8); the cards stay stills. |

e2e (`plays her talk animation while she replies`): the layer is on animation 2 (or the one it falls into) from its strip, with frames going by, while the subtitle is the character's; the leader's lines leave it alone; after the line it is on the idle animation.
Laraq, the constable and Nachyl (who speaks as the room loads).

### 10c: the objects drawn at the floor's scale (objwalktype 1)

**The original's NPCs do not walk.** `walkTo` (unity.cpp:888) is only called for `getWalker(context->who)`, the away team; no other object gets a `walk_path`, so there is no walk cycle to show for Brodnack or Dr. Hyunh. What they lacked was their idle loop, at
the floor's scale where they stand. `art masks` no longer refuses an animated layer of such an object (the woman of Mertens already took `scaledAbout`): the rectangles shrink about the sprite's origin and the strips are drawn into them, and a layer that leaves under a pixel
(the floor's vanishing end: Allanor's `s0d`, the master of `s08`) is not published, as a still is not. No sprite swaps (`alter: anim: sprite`) are in any world's objects.

Published (all strips of the loop the dump has the player on): the admiral of Unity's `s04` (118/256, 13 frames) and of Allanor's `s0b` (104/256; one card, `prop.screens`), Captain Pentara (`s04`, 14 frames), the creatures of `s08` and `s0e` (14 frames), the optimators and the
chodak masters of `s07` to `s0e` (12 and 13 frames: the chodak masters of `s07` upscale-only for speckle in one frame, the shared card of `s0c` to `s0e` passed at denoise 0.2 after a point moved 2.38 px at 0.3), the zoo's second Dr. Hyunh (`s03`, a frame and a 6-frame loop), the balls of Picard and Pentara of Unity's `s07`
(upscale-only: speckle, the ball being static) and Brodnack's body (`s06`, a still). Not published: **Brodnack's balls** (`s07`), which failed twice on a measured point (3.33, then 3.55 px). Nothing is over budget (the largest room is `unity.s0a`, 47.7 MiB of its 64: the guardian adds 13.5).

e2e: the published strips and starts, and which of them are on at entry (`script-changed layers are published`), and the idle row of the admiral and Pentara (a cutscene runs in `s04`).

### 10d: the woman of Mertens wakes

Animation 3 of `lab_woman_revive` (14 distinct frames) failed twice at denoise 0.3 with four frames a canvas on measured shifts. At denoise 0.2 with two a canvas it passed the first time at the recipe's seed: worst shift 0.69 px, flicker median 5.5, dE max 1.8, and the switches to her
lying and sitting frames. (`keep` and `warp` are for plate recipes; a card has neither. The whole recipe is at 0.2, so her single frames were painted again.) The med kit's `wait: true` now waits for her stirring: published as strips 0, 1 and 3 on all four of her objects; e2e in the script-changed table.

### 10e: the crew's phaser firing pose

Crew sprites fire with animation 12 plus the direction `phaserShot` picks (kDirections, seven of the twelve are ever played: 12, 14, 17, 18, 19, 21, 22), play it until the frame the executable's muzzle table names, hold it there (`setPaused`) while the beam is drawn, then let it go on into the idle loop.
`recipeAnims` and `makeStrips` now include those seven in a crew card's used set; `CardPlayer` has `hold`, `release` and `startOf`; `Stage.shoot` plays the animation for the direction, waits for the muzzle frame, holds it for the beam and lets it go; `artState().cardAnims` says what each card plays, for the e2e.

| Crew | Result |
|---|---|
| Picard, Data, Troi, Carlstrom (`fedmale.spr`), Butler (`fedfmale.spr`) | their cards are upscale-only (`art strips <id> [--sprite] --upscale-only`, as before): all seven firing animations published (16 frames each, 13 for the last) |
| Riker | all seven (11 frames each); animation 21 (a shot to the left) failed at the recipe seed on its median flicker, 14.5 against 14, and passed at `seedOverrides: { "21": 90121 }` (13.6, worst shift 1.34 px) |
| Worf, La Forge | all seven, at the recipe's own seeds |
| Crusher | 14, 18 and 21 at the recipe's seed; 12, 16 and 20 at seed 90013 (worst shift 1.84, 2.01, 0.88 px). **Animation 22 (a shot up and to the left) is listed**: it failed at the recipe's seed and at 90013, 90023, 90043 and 90053, a point moving 2.2 to 3.7 px each time. Crusher shooting up and to the left fires as before: the beam alone. |

A note on reproducing: the crew batch re-ran animations that were published earlier (their `done` records are keyed by a pins string that had changed), and three of Crusher's, which carry seeds that passed then (6, 41, 78), failed this time (a point moved 2.5, 3.0 and 2.25 px). A failed run publishes nothing, so the strips of the earlier passing runs are what is published; the same recipe and seed on the same machine is not guaranteed to give the same pixels twice.

e2e (`unity-placement.spec.ts`, "plays the firing animation"): Picard fires at the rubble of Horst III; a firing animation (12 to 23) is on a card before the beam is up and while it is. Vitest: `CardPlayer` hold, release and start (`actors.test.ts`), the stage's shot with a firing animation and without one (`stage.test.ts`), the used set (`cardrun.test.ts`).

### Remaining (Batch 10)

- Madia, the gatekeeper and Aelont of `s09` talking (above): a way to repaint two animations' bodies together, or a decision on the switch check for a change of pose.
- Brodnack's balls (`unity.s07`); the constable of `s03`'s animation 0 (15 frames: frames 1-2 flicker 4.7 against a median 1.9 at every seed and at 0.15 denoise), so its card starts on animation 1 where the original is on 0.
- The creature of `s0e`: the original has its player stopped with nothing shown (`anim` -2) and our layer draws frame 0; the creature of `s08` is off at entry (its start animation 2 is what animation 0 jumps to).
- Mouths are the upscaler's, not repainted: a speech sprite is 6x4 pixels. A repaint that matched the body would need the mouth drawn over a repaint that knew about it.
- Laraq's body is on animation 2 in ScummVM from the start, with her mouth frames skipped until she speaks (their mark is made by animation 0); ours is the still until she speaks. The same for the other talkers: the body between lines is their start animation's.
- Crew who fire with a direction their card has no strip for (a failed seed below) fire as before: the beam alone.

## Not fixed

Each of these needs a card (a recipe with a prompt, a 1 to 2 minute run, a check of the repaint) or a decision, not a code change. The counts are from the
last `compare` (a sprite is counted once at entry, once if a script turns it on later).

| What | Count (no-art / later) | Why it is left |
|---|---|---|
| Other characters and creatures with no card (remaining after batch 10) | Allanor: `chodak_shell` (`w2s10dt2`, a prop). Unity: the stasis chambers, Brodnack's two balls (batch 10 gave the admiral, Pentara, the body and the other balls cards). Zoo: Jur-Jur. Horst III has none. | One card each (`card.<world>_<name>_<room>.yaml` with `prop`), and an animation to pick from ScummVM's player. Left for lack of budget; `compare` lists them. |
| Props and scenery that are not characters | about 75 / 37 in all after batch 8g (`no-art` 75, `later-no-art` 37, `anim` 1); the triage below sorts them (the per-world split is in `findings.json` from `compare`): doors, lights, buttons, floor tiles, force fields, consoles, gates, stars, scanners, smoke. | The plate draws most of them as part of the background already, so a missing layer is often invisible; the ones that change (Mertens' shutdown buttons, Horst III's `screen_blank` and `glow`) would need animated layers. Prop cards are stills, "animated NPC cards are not supported yet". |
| A card shows a different pose than ScummVM's player | 1: `frigis.chancellor_laraq.0100` | Not a different pose. Laraq's animation 2 (`w5s1lar1`) is the talking one: mouth `speechSprite`s over the body and a `jump` back to the entry after the first frame, so the body stays on animation 0's frame 0000, which is what the card is until she speaks (batch 10 plays her mouths then). `compare` still counts it (`playing` 2 against the recipe's 0). |
| Allanor's `s0d` chodak master and optimators (`0d04`, `0d05`, `0d06`) | 3 | Cards exist (batch 1), but the original draws them at 2/256 of their size there, as `0804`: `art masks` skips them as under a pixel. |
| `allanor.chodak_master.0804` | 1 | Its card exists. The original draws it at 2/256 of its size there (the floor's scale at the horizon), which `art masks` skips as under a pixel: nothing is shown in either. |
| A card is a still of one frame | the rest | Batch 10 gave the idle loops of the characters and creatures that have one (above); what is still a still is the cards of objects that have a one-frame animation, the three talkers that failed (Madia, the gatekeeper, Aelont of `s09`), the drones of Allanor (`w2s1robo`, `w2s4robo`, `w2s4mama`: not looked at, their animations 0 to 11 are the loops of a walker), and the stasis chambers. |
| The sprite's own `mask` order in a room whose masks were cut before this | other rooms | Only the rooms in the `art masks` list above were re-cut; the unmarked-mask rule may add a mask in another room the next time `art masks` runs on it. |

Not checked: the crew's own placement and animations other than the firing pose (the walk diff's), and sprites the original draws on the ship's screens.

## Vitest with the art environment set

With `COMFY_URL`, `ART_CACHE`, `IMAGES_DIR`, `GAMEDATA_DIR` and `RAW_DIR` set the live tests run (CI sets none and skips them). Eight fail here, none from the placement or card commits (the same files fail on a checkout of `80092a2^` with this machine's art linked in): `live-comfy` and `live-plate` / `live-repaint` (this ComfyUI has no `sdxl_lightning_8step_lora`, and the repaint it makes is not the pinned one), `rawcheck/live-media` (the images export holds every screen, the test expects Horst III's four), `align.published` (`allanor.s14`, a plate made upscale-only in `9ebe604`: no point to see the x axis in it) and `lift/live` (three 5 s timeouts when the whole suite runs at once; each passes on its own).
