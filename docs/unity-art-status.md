# M6 status: the art for every away room

Where the art stands on 2026-10-20 (branch `m5`). The commands are in `docs/unity-local.md` (the Art section). The sprites the original draws over each room (props, people, masks) that the art does not yet stand in for are in `docs/unity-sprite-placement.md`. As
always, nothing generated is committed: plates, masks and cards live in `games/unity/art/` and `~/pcode/unity-art-cache/`, both
git-ignored. Only recipes are committed.

## The rooms

80 away rooms in six worlds: 75 have a published plate, and 5 cannot have one. The table was generated from
`games/unity/presentation.yaml` (`art.rooms`) and the recipes in `art/recipes/`, not written by hand. Of the 67 rooms in M6's scope
(everything but Mertens), 62 have art; the 5 without are the ones that can't.

The states:

- **repainted**: the diffusion repaint passed the 2 px alignment check;
- **repainted + warped**: the same, after the local warp moved a few points back (`allanor.s0a`, `frigis.s0a`);
- **upscale-only, check passed**: no diffusion (`repaint: false`), the de-dithered 4x upscale, and the check passed (`allanor.s07`,
  `frigis.s03`; the user's ruling, because the repaint drifted a point 6 to 7.5 px, past the warp's 5 px cap);
- **upscale-only, check skipped**: `allanor.s14`, whose original is a flat grey with one horizontal black band, so no edge can measure
  the x axis and no plate could pass the check; the recipe says so in `align: { skip: true, reason }` and the publish logs it;
- **no art possible**: `allanor.s02`, `allanor.s15` and `frigis.s0b` are listed by their world's `sl*.scr`, but their background files
  (`sb002002.scr`, `sb002021.scr`, `sb005011.scr`) are in neither STTNG.ZIP nor afu.iso: cut rooms. `horst3.s05` and `zoo.s0f` are not
  rooms at all, only object lists of advice triggers and dialogue-line holders.

"Near-lossless WebP" means the lossy WebP drifted from its PNG or failed the check, and the fallback in `art publish` was used (see
the Art section). `published.json` in the run's folder records the encoding.

### Horst III (5 rooms)

| Room | Art |
|---|---|
| horst3.s01 | repainted |
| horst3.s02 | repainted |
| horst3.s03 | repainted |
| horst3.s04 | repainted |
| horst3.s05 | no art possible: not a room, an object list of advice triggers (w0705obj) |

### Allanor (21 rooms)

| Room | Art |
|---|---|
| allanor.s01 | repainted |
| allanor.s02 | no art possible: the original is missing (a cut room; sb002002.scr is in neither STTNG.ZIP nor afu.iso) |
| allanor.s03 | repainted |
| allanor.s04 | repainted (near-lossless WebP) |
| allanor.s05 | repainted |
| allanor.s06 | repainted |
| allanor.s07 | upscale-only, check passed |
| allanor.s08 | repainted |
| allanor.s09 | repainted |
| allanor.s0a | repainted + warped |
| allanor.s0b | repainted (near-lossless WebP) |
| allanor.s0c | repainted |
| allanor.s0d | repainted |
| allanor.s0e | repainted |
| allanor.s0f | repainted |
| allanor.s10 | repainted |
| allanor.s11 | repainted |
| allanor.s12 | repainted |
| allanor.s13 | repainted |
| allanor.s14 | upscale-only, check skipped (flat grey original with one black band: no edge can measure the x axis) |
| allanor.s15 | no art possible: the original is missing (a cut room; sb002021.scr) |

### The zoo (12 rooms)

| Room | Art |
|---|---|
| zoo.s01 | repainted |
| zoo.s02 | repainted |
| zoo.s03 | repainted |
| zoo.s04 | repainted |
| zoo.s05 | repainted |
| zoo.s06 | repainted |
| zoo.s07 | repainted |
| zoo.s08 | repainted |
| zoo.s09 | repainted (near-lossless WebP) |
| zoo.s0a | repainted |
| zoo.s0f | no art possible: not a room, an object list of advice triggers (w030fobj) |
| zoo.s10 | repainted |

### Frigis (13 rooms)

| Room | Art |
|---|---|
| frigis.s01 | repainted |
| frigis.s02 | repainted |
| frigis.s03 | upscale-only, check passed |
| frigis.s04 | repainted |
| frigis.s05 | repainted |
| frigis.s06 | repainted (near-lossless WebP) |
| frigis.s07 | repainted |
| frigis.s08 | repainted |
| frigis.s09 | repainted |
| frigis.s0a | repainted + warped |
| frigis.s0b | no art possible: the original is missing (a cut room; sb005011.scr) |
| frigis.s0c | repainted |
| frigis.s0d | repainted |

### Unity (16 rooms)

| Room | Art |
|---|---|
| unity.s01 | repainted |
| unity.s02 | repainted |
| unity.s03 | repainted |
| unity.s04 | repainted |
| unity.s05 | repainted |
| unity.s06 | repainted |
| unity.s07 | repainted |
| unity.s08 | repainted |
| unity.s09 | repainted |
| unity.s0a | repainted |
| unity.s0b | repainted |
| unity.s0c | repainted |
| unity.s0d | repainted |
| unity.s0e | repainted |
| unity.s0f | repainted |
| unity.s10 | repainted |

### Mertens Station (lab) (13 rooms)

| Room | Art |
|---|---|
| lab.s01 | repainted |
| lab.s02 | repainted |
| lab.s03 | repainted |
| lab.s04 | repainted |
| lab.s05 | repainted |
| lab.s06 | repainted |
| lab.s07 | repainted |
| lab.s08 | repainted |
| lab.s09 | repainted |
| lab.s0a | repainted |
| lab.s0b | repainted |
| lab.s0c | repainted |
| lab.s0d | repainted (near-lossless WebP) |

## The ship plates and Mertens

The five ship plates (bridge, viewscreen, transporter, astrogation and computer) and the 13 Mertens rooms were re-run through the
pipeline with the de-dither step before the 4x upscale (268fea8), and 17 of 18 were republished. `lab.s0d` failed for a while: its
screens' 1 px grid sits at the de-dither's frequency (so displays are now left out of it), and the first republish failed its WebP
check at one point. It is now de-dithered and published with the near-lossless fallback. The Mertens crew and the ship's painted
buttons are described in the Art section of `docs/unity-local.md` and in `docs/unity-ship-buttons.md`.

## Hails, props and NPC cards

- **Hail stills:** done for all 13 character callers (`art/recipes/hail.*.yaml`). The 6 space-view callers have no character, so they
  have none.
- **Away-team portraits and kit icons:** nine portraits and the five standard-kit icons are published and shown in the away panel and
  beside the subtitles.
- **NPC prop cards:** 28 `card.*` recipes for the Allanor, Frigis, zoo and Unity worlds (3cfc5c2, on the 4080), of which 26 were
  published at first, as a still of frame 0 of the anim named in the recipe. Horst III has no character sprites.
  - Allanor: brodnack s08 and s09; chodak s08, s09 and s0e; drone s04 and s06.
  - Frigis: aelont s09, laraq s01, nachyl s07, stamblyr s06.
  - The zoo: bird s03, constable s10, field units s04, hyunh s09, iydia s04, snake s01, tzudan s09, zzolis s04.
  - Unity: brodnack s04, creature s08 and s0e, pentara s04, pentara body s06, stasis chambers s08 (two).
  - Published later, so every NPC card recipe is now published: `allanor_brodnack_s07` (allanor.alien.0704; seed 92141, denoise 0.2, lineart 1.3;
    flicker median 2.0, worst shift 0.64 px), `allanor_crawl_s0e` (anim 1, 101 frames; denoise 0.2, seed 92107; flicker median 4.5, worst
    shift 1.65 px, dE 1.3) and `zoo_constable_s03` (anim 1, 29 frames; seed 92153, denoise 0.15, lineart 1.3; flicker median 2.4, worst
    shift 0.21 px). Both "not picked up" recipes had named a sprite.json entry offset (33, 208), not an animation index; `art batch` now
    errors on an animation the sprite lacks instead of skipping it. The constable's anim 0 stays rejected: frame 2 flickers 4.7 against a
    median 1.9 whatever the seed, so its card uses anim 1, which starts on the same pose.
  - **Cards for `allanor.s07` and `frigis.s03`** (7cae3e2): `card.allanor_chodak_s07`, `card.allanor_brodnack_s07` (allanor.alien.0704,
    brodnack.spr) and `card.frigis_madia_s03` (w5s3madi.spr) are published.
  - **Animated NPC cards are not supported yet.** A prop card is always one still.

## The bridge's details

What "garbled" on the bridge was, found by comparing the published plate and crew with the decoded original and ScummVM
(`engines/unity/bridge.cpp`, `unity.cpp`):

- **The plate is aligned.** The published `plate.bridge` passes the check (53 of 57 points measured, worst 1.4 px, medians 0.1 px), as
  does a fresh run of the recipe. `live-plate`'s "40 of 45 points fail" came from two runs on 2026-10-21 03:40 and 03:49 that made a different plate (sha 9ee74a8e,
  a 4 px shift of every point); the plate is deterministic on this ComfyUI (767027018d9d on every run since), and the test then failed on its
  second assertion instead, which was stale: the kept strip is the original's own 4x upscale (`keepUpscaled`), not `upscaled`, which has been the de-dithered one since 268fea8.
  The test compares against `keepUpscaled` now and passes.
- **The blocky crew** were the sprites at their own pixels (`scale: 1`, dither and all) drawn over a smooth 4x plate. The original draws them 1:1 over
  an equally dithered background, so nothing clashed there. They are now published through the same card upscaler as the away crew
  (`makeCard`: Real-ESRGAN colours, the original's alpha edge), frame by frame with the bridge palette, as `scale: 4` strips (`art ship publish bridge`).
  Upscaling also showed a ring the sprites carry round the figure (the 2-3 px steel-blue grey (80, 80, 104) and (80, 96, 132) the figure was cut
  from, most visible round Picard's head), so `prepareCrewFrame` takes those greys off the silhouette too (skin, hair, gold, red and Troi's blue uniform are not touched).
- **Data and the conn console, Worf and the rail** are not a depth bug. The original has no masks on the bridge: it draws the crew's sprites over `bridge.rm`
  in order of `y_adjust = -depth` (Picard 0, Worf and Riker +10, Troi +90, Data +99 last), and the frames of Worf, Troi and Data carry the console, rail and chair
  they sit behind as part of their picture. Ours matte that picture out and draw in the same order (`shipPlate.test.ts` pins it), so the plate's own console top
  and rail stand in front of Data's lap and Worf's waist. The legs that show under Data's console are the original's too.
- **The white shape under the console** was the lit pedestal panel (a pale cyan quad with a soft glow in the original, 53x53 and 70x46 px under the two consoles). The repaint blew it out to white and
  waved its lower edge. The two panels are `keep` rectangles in `art/recipes/plate.bridge.yaml` now (the run's own upscale of the original stands there: pale cyan, straight edge).
- **The door signs** (a brown-framed plaque, 24x9 px, on each side door) came out of the repaint as rings and specks. The two plaques are now `keep` rectangles in
  `art/recipes/plate.bridge.yaml` (the run passed the same check, worst 1.4 px; 0.2% of the plate's pixels changed).
- **Back-wall displays** (the repaint turned the dithered LCARS screens into smears) are two `keep` rectangles above the conn console's arc, so the original's blocks and
  colours show as the upscale draws them. The floor and wall seam lines are still the repaint's simplification. The plate passed the same check with all of these (53 of 57 points, worst 1.4 px).
- **The light outline round the crew** (Riker's most) was picture left in the frames: Riker's, Picard's and the others' cut-out frames were never matted (the matte skipped any frame
  with a fifth of it empty), so the wall's cream and the carpet's blue stayed at the edge and between the legs, and the plate's own colours showed them up. `prepareCrewFrame`
  now mattes those frames too, for light pixels only (their black shoulders and hair match the black displays by chance), drops a light patch of 16 pixels or more that the figure
  encloses, and takes an edge pixel that is nearer the picture behind it than the figure beside it (two passes). Skin, hair and the uniforms are nearer themselves, so stay.

## Conversation portraits

Every spoken line has a speaker, and the original shows the speaker's picture in the dialog box: `setSpeaker` looks the speaker's object id up in
`icon.map` and draws that sprite (a 48x50 head, or an emblem item for a ship's hail) in the frame on the dialog's left, its speaking animation
playing while the voice does (`unity.cpp` `setSpeaker`, `drawDialogFrameAround`). A speaker `icon.map` has no entry for gets no picture. Nothing else in
a conversation shows a face: the lounge and the away NPCs have no sprite of the person beside the box, and the viewscreen's hail still (`hail.*`, below)
is the caller's picture, not the dialog icon. The audit (2026-10-21) took every object that is a response's target in the 182 conversations,
matched against `icon.map` (the speaker ids and line counts are from the export's `conversations/`), and played the lounge in the browser.

Ours draws the speaker in the subtitle box (`art.portraits[<object name>]`, the combadge when there is none; art off: text only, a choice
`unity-portraits.spec.ts` pins). The pictures are 64x64 pixel portraits made the way Butler's and Carlstrom's are: a Krea 2 Turbo face from the game's
head as layout, grabbed into its frame, pixelated (`art avatar`, then `art publish-kit`). `speakers:` in the recipe names the object names that show
the one file. Ours is still, where the original's head animates.

| Character (lines) | Where shown | Original source | Ours now | Action |
|---|---|---|---|---|
| Lucana, T'Bak, Avakar (24, 25, 21) | the bridge's Conf. Lounge | `w5shluca`, `w5shtbak`, `w5shavak` | own portraits (`avatar.lucana`, `.t_bak`, `.avakar`) | done, set 1 |
| Captain Pentara (78) | world 6's talks; the hail (5f0120, 74 lines) | `w5shpen3`; the hail's icon is the Garidian emblem `unitgari` | own portrait (`avatar.pentara`), for the hail's object too | done, set 2 (the hail shows her where the original shows the emblem) |
| Injured woman, Benyt (191) | lab, world 4 | `w4shbeny` | own portrait (`avatar.benyt`) | done, set 2 |
| Dr. Griems (147) | lab, world 4 | `w4shgrie` | own portrait (`avatar.griems`) | done, set 2 |
| Dr. Hyunh-Foertsch (128) | zoo, world 3 | `w3shvihn` | own portrait (`avatar.hyunh_foertsch`) | done, set 2 |
| Consultant Iydia (120) | zoo, world 3 | `w3shlyda` | own portrait (`avatar.iydia`; the original's red markings are a plain ruddy skin, and the backdrop is the blue the grab always uses) | done, set 2 |
| Chancellor Laraq (279) | Frigis, world 5 | `w5shlara` | own portrait (`avatar.laraq`) | done, set 3 |
| Aelont (97 + 9) | Frigis | `w5shaelo`, `w5shael2` | own portrait (`avatar.aelont`, for both objects) | done, set 5: the grab takes `backdrop: dark` (the dark pixels joined to the picture's edge are the backdrop; the figure's colours are graded to the rest), so Aelont sits on the black the original has; the game box is InsightFace's on the head scaled up 10x. A faint dark halo above the cap is the game's cap pixels that touch the edge |
| Nachyl (50) | Frigis | `w5shnach` | own portrait (`avatar.nachyl`) | done, set 5: the same dark backdrop (black and dark grey) |
| Madia (37), Stamblyr (39) | Frigis | `w5shmadi`, `w5shstam` | own portraits (`avatar.madia`, `avatar.stamblyr`) | done, set 5. InsightFace finds no face in Stamblyr's head at any brightness, but one on it blurred by 12 px (the dithering gone) and padded, which gave his box; it finds none in Madia's however it is brightened or blurred, so her box was measured by hand on a brightened, gridded copy (circlet at y 11, mouth at y 32). Madia's grab is graded only 0.15 toward the game figure (its few lit pixels are gold and turned her skin orange at 0.5) |
| Gatekeeper (324) | Frigis | `w5shgtgd` | own picture (`avatar.gatekeeper`) | done, set 6: not a person, so the non-face path (below) |
| Constable Lliksze (154), Tzudan (92), Zzolis (85), Veronda bird (3) | zoo | `w3shllik`, `w3shtzud`, `w3shzzol`, `w3shbird` | own pictures (`avatar.lliksze`, `.tzudan`, `.zzolis`, `.veronda_bird`) | done, set 6: the painted masks and the bird repainted by the non-face path (Lliksze's picture is for the two objects icon.map has, 030e and 1010). Zzolis's beads came out grey, not gold |
| Tracker Melas (101) | zoo | `w3shmela` | own picture (`avatar.melas`) | done, set 6: a bald grey-pink alien in a red collar |
| Admiral Brodnack (94 on unity), the Chodak master and Brodnack on allanor (30), allanor's alien 020704 (141) | unity and allanor | `w6shbrod` | own picture (`avatar.brodnack`) | done, set 6: the insect-eyed alien with huge orange eyes, on blue |
| Optimators One and Two, the dead Optimator (47 + 88) | allanor | `w2shopt1`, `w2shopt2` | own pictures (`avatar.optimator_one`, `avatar.optimator_two`; the dead one has Two's, as icon.map gives it) | done, set 6: the same family, One with a plain crown, Two with the silver ridged crest |
| Guardian, the Ancient, the glow, Brodnack as Guardian (45) | unity | `w6shunit`, `w6shanct`, `w6shbdas` | one picture for all four (`avatar.guardian`) | done, set 6, with a choice: the sprites are specks of light on black (`w6shbdas` is wholly black), the Ancient's a faint blue figure of light, so the one picture is a slender figure of pale blue light in the dark, from `w6shanct`'s |
| The creature (31), the drone (23) | unity, allanor | `w6shgrun`, `w2shdrod` | own pictures (`avatar.creature`, also the stasis chamber's two objects; `avatar.drone`) | done, set 6: a green lizard face; a small drone with a glowing pink core |
| Captain Picard, green (4) | unity, the two objects 060b00 and 060707 | `w6shgpic` (Picard with a green outline) | Picard's portrait (`speakers` of `avatar.picard`) | done, set 4 (the original's green outline is not drawn) |
| Computer, zoo (2) | zoo | `w3shcomp` (a pale head) | own picture (`avatar.zoo_computer`) | done, set 4: the pale sculpted head, repainted by the non-face path (only the one object icon.map names, 03030c) |
| The tricorder (21) | tricorder readings | `tricrdr` (the same sprite as the kit's icon) | `icons.tricorder` | done, set 4: a speaker with no portrait now shows the icon of the item of that name (`faces.speaker`), the tricorder's readings speak as `tricorder`; the subtitle's picture is `object-fit: contain`, so the icon is not stretched |
| Emblems: the Garidian (79), Romulan (57), Ferengi (27), Klingon (23), Cymco (19), Morassia (10), Chodak (4) | the ship's hails (the viewscreen's dialog) | `unitgari`, `iromuemb`, `ifergemb`, `iklinemb`, `unitcymb`, `unitmora`, `ichodemb` | own emblems (`avatar.emblem_garidian`, `_romulan`, `_ferengi`, `_klingon`, `_cymco`, `_morassia`, `_chodak`), under each ship object icon.map gives that sprite (the Garidian one for the scout ship and the life pod; Captain Pentara's hail keeps her portrait) | done, set 4: the emblem repainted at denoise 0.6 with a no-text negative prompt, shape and colours kept |
| Starfleet (100), Admirals Reddreck (35) and Williams (3), Shanok (17), Tybok (23), Commander Chan (29), Laraq's hail (23), the starbase (1), the Computer Voice | the ship's hails | none (`icon.map` has no entry) | combadge | none: the original shows no picture; ours shows the combadge, a placeholder it chose |
| The unnamed ids 000010 and 000020-000036 (about 520) | scripted lines | none | combadge | none, as above |

The pictures are checked by eye against the game's head on a sheet (`~/pcode/unity-raw/runs/avatars/<id>.compare.png`: the game portrait, the
Krea face, the grab, the 64x64 pixel version), by `art publish-kit` (each WebP must equal its PNG exactly) and by `unity-portraits-npc.spec.ts`, which
plays the lounge and a lab conversation and checks the speaker's file is the one in the subtitle. Redo (2026-10-21, user feedback: no collar pips on non-Starfleet people, and the Garidians should look Romulan). Nobody in this table is Starfleet: the Garidians (Lucana, T'Bak, Avakar, Captain Pentara, whose hail shows the Garidian emblem) are aliens, Dr. Griems and Benyt are lab-station civilians, Dr. Hyunh-Foertsch and Consultant Iydia are zoo staff, Laraq rules Frigis. The first set showed collar studs on Pentara, Griems, Benyt, Iydia and Laraq and on all three guests. Every recipe now says no pins, insignia or badge in the prompt and lists them in `negative:`, and clothing follows the sprite (the Garidians' plain grey high collar over a red-brown, maroon or orange-brown tunic; Griems's plain green tunic). Krea 2 Turbo at cfg 1 ignores a negative prompt, so these recipes use cfg 2.5. The Garidians' prompts ask for pointed ears, a Romulan brow ridge, upswept brows and a straight-fringed Romulan cut in each one's own hair colour. Lucana, Pentara and the five others pass. T'Bak's Romulan redo (two tries) came out Klingon-heavy in the brow and yellow in the skin, so by the user's choice T'Bak keeps his earlier portrait (the recipe and the published picture are as before the redo, grey collar and all); the other eight redone portraits stay. Not passed, in the pictures as published: Avakar (two tries: one small collar stud on the one published, three on the other).

Attempts that failed: the first T'Bak (a hair band
cut off at the top, and skin darker than the game's) and Dr. Hyunh-Foertsch's hand-measured face box (the head smeared across the top); each was run
again with the cause changed. Aelont and Nachyl failed on the grab's blue-only backdrop, not on the face; they went through once the grab learned a dark one.

The remaining portraits (set 4: the easy ones; set 5: the grab fixes above; set 6: the non-face path). A head that is not a person's face (a mask, a machine, an emblem) is made by the same recipe shape without a `grab` block: `layout` (the game's own picture upscaled, blurred by 0 to 2 px) as the img2img base for a Krea 2 Turbo variant at cfg 2.5 with the negative prompt, and `pixel` for the 64x64 step; `pick` names the variant. No face identity, no grab, no face detection. Nothing needed a second try: every picture passed by eye on the first run (no pips or studs on anyone; the aliens keep their sprite's colours; the emblems keep their shapes), and none is on the failed list. Only Madia's grab was run again, for its grade. A conversation test (`unity-portraits-npc.spec.ts`) covers the Gatekeeper; Aelont's and Nachyl's talks do not start from the first menu option, so their pictures are checked by eye on the sheets only (and a combined sheet, the game's head above and ours below).

## Open

- Animated NPC cards (the cards above stand still).
- The 3 cut rooms stay greybox, and the 2 advice lists are not rooms.
