# Playing in the browser

```sh
npm install
npm run dev                  # writes the demo's greybox rooms and sounds, then serves the app
```

Open http://localhost:5173/?game=demo.

The site in front of the game (the LCARS pages, `/play/afu/`, the pictures build) is described in [site.md](site.md).

## A Final Unity (local only)

Once Horst III is lifted into `games/unity` (`npm run unity:build`, see `docs/unity-local.md`), the
app also has `?game=unity`. Without `games/unity/game.yaml` the app has only the demo, so a clean
checkout and CI build as before. `unity` starts a new game on the ship's bridge (greybox HTML panels, no art yet).
The stations are the bridge (its items, the turbolift, the crew's talk, Replay, Comms and the Lounge), astrogation (a three.js map: plot a
sector, star and planet by their names, then Engage; the journey runs on the sim clock, and a story warp engages by itself), the
viewscreen (a hail plays there), the computer, the transporter room (four pads, the equipment and kit, Recommended, Energize) and the
tactical panel. The tactical panel is a placeholder: a battle hail opens it with Win, Flee and Lose (Win destroys the enemies and
returns by the Exit object, Flee takes the Warp object or Exit, Lose ends the game), and an Answer button for a hook's waiting hail.
The difficulty (0-2, `?difficulty=` or the admin console's DIFFICULTY) sets the transporter's advice. A new game opens with the skippable movies. Saves
are version 4: an older save's queued ship effects are applied once on load. The dev tools add `?dev&missions` and `?dev&ship=horst3`;
`docs/unity-local.md` has the route.

Not built yet: Engineering, flying a battle, moons, stations and phenomena as courses, preset courses, region chatter, encounters
and hazards.

`apps/web/e2e/unity-ship.spec.ts` plays a new game from the bridge to the lab's beam-down, and from two route checkpoints to the
zoo's and Horst III's, through the UI, headless. It skips without `RAW_DIR`.

`apps/web/e2e/unity.spec.ts` plays the first screen in headless Chromium, and jumps to the second to check
that each member of the team there takes a click. It skips unless `RAW_DIR` is
set and the content is lifted (`RAW_DIR=… npm run e2e -- unity.spec.ts`), and it never checks the
game's text: it counts transcript lines.

**Never deploy a build made with `games/unity` lifted.** `npm run build` then puts the original's
audio and movie into `apps/web/dist` (which git ignores), and the game's content into the `unity`
chunk. That chunk is about 820 kB minified, over `chunkSizeWarningLimit` (600 kB, set for three), so
such a build ends with Vite's "Some chunks are larger than 600 kB" warning: it is expected locally,
and the limit stays where it is so a demo build still warns if one of its own chunks grows.

### Art (local only)

A room can show a repainted plate (and a glTF model and crew cards) from `presentation.yaml`'s `art` key, made by `tools/art`
(`docs/unity-local.md`, "Art"). The greybox room stays underneath, hidden by its materials only, so picking and walking are exactly as
without art, and it is what shows when a layer is missing or fails to load (a warning in the console). `?art=0`, or the dev overlay's
`art` checkbox, shows the greybox; `window.__au.art()` reports the plate, model, masks and cards of the current room.

- **Masks.** A room's `art.rooms.<id>.masks` are images cut from its plate, one per mask object, each with the rect it covers and a floor
  `depth`. The stage draws each as a transparent quad standing on the floor at that depth (no depth test: three draws them far to near), so
  a card standing behind a mask is drawn under it. A mask above the horizon is skipped, and a crew name tag hides while its card is fully
  behind the masks that are showing.
- **Animated cards.** A card with `anims` plays strips (equal cells, one anchor and delay list each) chosen by the screen-space direction of
  a walk and by the presenter's speech and turn events (`CardPlayer`); the single `image` is the still shown until its strips load.
- **`pixelHeight`.** The height of the sprite's figure in the original's pixels. The card is scaled so that figure stands at the height the
  sprite had on screen, so each character has their own height; a card without it uses the stage's actor height.

#### The ship's plates

`art.ship` maps a station (`bridge`, `viewscreen`, `transporter`, `astrogation`, `computer`) to `{ plate, window?, areas?, crew?, gltf?,
camera?, viewscreen? }` (`engine/src/view/package.ts`; `shipArtFromPresentation` in `view/art.ts`). A station with a `plate` is drawn in
**plate mode**: a 640 x 480 textured quad seen by an orthographic camera (`plateCamera()` in `view/shipPlate.ts`), drawn by the session in
exactly the panel's `.au-ship-screen` box (`screenViewport`: the client rect in device pixels, rounded as CSS rounds it) with a viewport and
scissor, so the plate lies under the DOM panel's buttons, which stay the hit areas. `.au-ship` gets the class `au-ship-art`, which makes
its background and the item borders transparent. **The viewport rule:** nothing but the plate is drawn outside that box, and the box is
4:3.

- `areas` are named rectangles in the plate's 640 x 480 pixels; a panel's sections sit in them (`areaStyle`) over an opaque black ground, in
  the same DOM order with the same handlers. The transporter's, computer's and astrogation's sections, and the viewscreen's name, use them.
- **The viewscreen** is a render target (`view/space.ts`: a seeded starfield, warp streaks, a lit two-tone planet or a hail's sprite) shown
  in the plate's keyed `window`: `window` is an image whose alpha is the window's shape, drawn over the plate with the target as its colour.
  One `WebGLRenderTarget` exists at a time, sized to the window's device-pixel box, drawn only while a window shows (the viewscreen's
  station, and the bridge with the viewscreen up), and freed with the art. `viewscreenImage()` (read-only over the world) picks space, warp,
  a planet or a hail's sprite the way the original does.
- **The map's area:** astrogation draws its map in the `map` area (`areaViewport`), after the plate, cleared to the plate's black. The
  pointer is mapped through the same rectangle (`pointerInViewport`), so a click picks the same star with art on or off, and outside the
  area press, click, orbit and wheel do nothing. `window.__au.astroPoint(sector, star)` is a star's client point.
- **Crew** on the bridge and on the transporter's pads are Plan 15's cards, placed in original pixels (`art.ship.bridge.crew` and the
  pads' `stand` points).
- **The dev flag:** `?dev&ship3d` shows the 3D set from `art.ship[station].gltf` where one is published; without it no glb is requested.
- `?art=0` or the overlay's `art` checkbox shows the flat panels; `window.__au.art().ship` reports `{ station, set, kind: 'plate' | 'set'
  | null, viewscreen }`. The checks are in `apps/web/e2e/unity-art-ship.spec.ts`.

### Theatre mode

While a movie plays (the opening, the warp movie on Engage, the beam-down pieces: any `movie` dialog) the HUD puts the class `theatre`
on `<body>`, set in one place (`engine/src/ui/app.tsx`, `theatre.ts`) so every cutscene gets it. `base.css` fades a black veil over the
whole page in 0.35 s, with the movie dialog above it at full brightness; it fades back when the movie ends or is skipped. The veil takes
no pointer input, so clicking the movie, Skip or Escape still skip. With `prefers-reduced-motion` the switch is instant.

## Offline cache

A service worker (`apps/web/src/sw.ts`, rules in `swRules.ts`, built to `/sw.js` by `apps/web/swPlugin.ts`) keeps the game on the player's
machine, so a second visit starts from disk and works with no network. It is registered by `swRegister.ts` (called from `boot.ts`).

- **The shell** (the index, the hashed JS and CSS, the icon): precached when a build's worker installs, in `au-shell-<build>`.
- **Game data** (any yaml or json, a game's package chunk `unity-*.js` or `demo-*.js`, which holds its yaml, and `combat-<hash>.js`, the unity game's combat.yaml, read when a battle is near: M8 spec §8; each exactly its name and Rollup's eight-character hash, so the space view's code chunk, `spaceScene-*.js`, loaded as the first battle is drawn, stays in the shell and is precached with it): cache-first in
  `au-data-<build>`, stored the first time it is fetched.
- **Big assets** (webp, png, ogg, opus, wav, webm, mp4, glb): cache-first in `au-assets`, stored as they are first used (not precached).
  Their file names carry their content hash, so the cache is not versioned; each new worker deletes the entries its build no longer lists.
  A Range request is answered from a cached whole file (206). One that misses goes to the network, and the whole file is fetched on the side.
- **The build id** is a hash of the build's file names. Activation deletes every `au-*` cache that isn't this build's.
- **Updates:** a new worker installs in the background and waits, so a game in play isn't swapped. On the next load the page finds it waiting,
  fires `au:updating` (`onUpdating()` in `swRegister.ts`, for the loading screen's "Updating…"), activates it and reloads once.
  The sealed game can't wait for that next load: its page comes from the network first, so the first load after a deploy is the new
  build's page under the old build's worker, which doesn't know the new sealed files' names. Each page carries its build's version (a
  `<meta name="au-version">` the build writes), and before any sealed file the gate asks the worker for its own (a `version` message);
  on a mismatch it waits for the new worker to install, switches to it the same way (one reload), and if none takes over, says to reload.
- **Storage:** the page asks for `navigator.storage.persist()`; a refusal is only logged. Saves are in IndexedDB and are never touched by the worker.
- **Download for offline:** `await __auCache.cacheAll(p => console.log(p))` fetches every game-data file and asset of the build's
  `au-manifest.json`, with progress (`done/total`, `bytes/totalBytes`). Production builds only. The manifest lists what the build emitted,
  so local art is in it only if `games/unity/art` was there at build time.
- **Clear it:** `?sw=0` removes the worker and all `au-*` caches on that load (and doesn't register); the next load without it registers again.
  `__auCache.clear()` does the same from the console, or use the browser's "Clear site data".
- **Behind a login** (docs/deploy.md): only a plain 200 of our own origin, not reached through a redirect and not HTML for a non-page file, is ever
  cached (`isCacheable`); a redirect to a sign-in page, a 401/403 or an opaque answer passes to the page unstored. A page load goes to the network
  first (4 s), so an expired session shows the login; offline or on a server error the cached index starts the game.
- **Sealed files** (the deploy's unity game, the CD gate below): `au-manifest.json` lists them under `sealed`. The worker keeps each as it
  came (ciphertext) in `au-assets`, opens it with the key from IndexedDB, and answers the request, or its Range (a 206, as Safari's
  `<video>` asks), from the plain bytes. With no key, or the wrong one, it answers `403`; a plain file in place of a sealed one (a
  sign-in page) passes to the page unstored, as above. "Download for offline" fetches the sealed files too.
- **Dev server:** the worker is a dev variant (`/sw.js`, built on request) that keeps only media (`au-dev-assets`), showing the cached file and
  refreshing it for the next load. Code, HMR and `?import`/`?url` module requests are never touched. `?sw=0` turns it off there too.

## The CD gate (deploy build)

The deploy build's unity game is sealed (docs/deploy.md): every file it takes from `games/unity` is AES-GCM encrypted by `npm run
gate:seal`, and the key is made from the player's own CD. Only the deploy build does this; `npm run dev` and `npm run build` read the
plain `games/unity` as before, and the demo is never sealed. Code: `apps/web/src/gate/`.

- **The import screen** (`importScreen.tsx`, shown by `gateFlow.ts` before the game loads) appears on the first start on a device with
  no key. On a desktop it takes the CD's folder (the CD drive itself will do), picked or dropped, or a disc image; a phone or tablet (a
  coarse pointer) has no folders, so it takes a disc image from its Files app: an `.iso`, or a `.bin` (raw, 2352-byte sectors) with its
  `.cue`. Only a few pieces of the CD are read, with `File.slice`, so a phone never loads the whole image. Nothing leaves the device.
- **The key** is derived with WebCrypto from those pieces and proved by opening `check.bin`. A wrong folder or image says "These don't
  look like the A Final Unity CD."; a folder without the CD's files says so. The key is stored as a non-extractable `CryptoKey` in
  IndexedDB (`au-gate`), the worker is told, `navigator.storage.persist()` is asked for, and the game starts once the worker controls
  the page: the first play needs no reload.
- **The worker decrypts** (Offline cache, "Sealed files"), so the engine loads its URLs as it always has. The protected game needs a
  service worker: with none (`?sw=0`, plain HTTP, a browser without one) the screen says the browser can't play it, and the demo still plays.
- **A lost key** (site data cleared, or Safari dropping an unused site's storage): a sealed file's `403` clears the stored key and
  reloads, and the import screen is back. Saves are in their own IndexedDB and are kept. The start screen's "Game files…" asks for the
  CD again on purpose.

## Controls

- **Verbs:** the Walk, Look, Use and Talk buttons, or the keys W, L, U and T. The right mouse button
  cycles Look, Use, Walk and Talk, as the original's does. Click something in the room to do the verb to
  it. Only Walk mode walks to the floor (a click off the floor walks to the nearest point of it); in the
  other modes a click on nothing cancels what the member was about to do.
- **Getting things:** as in the original, there is no Get verb. In Use mode, press on the thing, drag it
  onto the inventory and let go there. Let go on the thing itself to use it, or on something else to use
  the one with the other; anywhere else does nothing. The original has no key for this, so neither does
  the browser: picking things up needs a pointer.
- **Inventory:** in Use mode, click an item to pick it up, then click what to use it with (or another
  item). In Look mode, clicking an item looks at it, and looking at the tricorder opens it. Escape
  lets go. The phaser has its setting beside it.
- **Conversations:** pick a line from the menu; as in the original, there is no backing out.
- **Away team:** click a member's name to act as them. **Combadge** asks whether to call the ship; the
  game waits while it asks. A screen can turn it off (Horst III's second screen does), and it is then
  shown disabled, as the original's panel ignores a click on it.
- **Speech:** a click (or Space) skips the line being said. **Log** shows the transcript.
- **Admin console:** the Admin button or Esc opens the original's PADD: LOAD and SAVE (9 slots and an autosave row), NEW, QUIT, sound
  levels, text, difficulty and SETTINGS (GAME, COMBAT and KEYS tabs). In tactical F1 opens the Combat Options screen. L toggles the log
  aboard, Shift+L away. Plan 32 (`docs/unity-local.md`). On the game-over screen the console stays up with no SAVE and no RESUME (the
  game is over). Any way in (the bar, the bridge strip, the away panel, Esc) is refused during a battle
  (Tactical's Combat Options up), while a warp is pending, while a line is said or a dialog is up, and while input is blocked; the Admin
  buttons then keep the held item (they drop it only when the console opens), and Esc with an item held lets go of it first, opening the console only on a second press.
- **Settings record:** one `au.settings` JSON record in `localStorage` (`engine/src/web/settings.ts`), per browser and not in a save: master,
  voices and music levels, text, art, hotspot labels, movies, 3D sound, difficulty, the combat assists, combat options (stars, resolution, radar,
  detail) and the keys. **3D SOUND** (GAME tab, on by default; `threeD`) pans combat's effects by their ship's bearing from the camera
  (0.6 sin of the bearing, never past ±0.6, keeping the level: a mono effect is raised by √2 under the panner, so it is unity at the centre; the crew's cues and sounds at the camera stay centred); off, the mix is the original's mono,
  with no panner at all. It is read leniently (a bad field is its default, and a record from before 3D SOUND reads it as on) and folds in the old `au.difficulty`, `au.combatAssists` and
  `au.hotspotLabels` once, where there is no record. `?mute`, `?art` and `?difficulty` override a load and are never written back. `?res` is not a setting: it is a device
  parameter (`half` or `full` plates for this device, `apps/web/src/device.ts`), so the record never holds it.
- **Saves:** nine slots and an autosave, kept in the browser (IndexedDB), plus Export and Import as a file. Saving,
  loading, importing and restarting are only possible while nothing is happening.
  A v2 save (before the ship) migrates only if the game's content is unchanged: a save checks that it has every object,
  trigger and conversation the game has, and the ship lift added the ship world's objects and triggers, so a v2 save from before
  it is refused cleanly ("save does not match this game"), not loaded broken. (Ruling: no player saves exist yet; the cost is
  that dev saves from before m4 won't load. A v2 save taken against content that has the ship does migrate, back aboard included.)

## The demo, start to finish

1. As Data, use the tricorder on the control panel, and reroute the power.
2. As Picard, walk to the door: it opens on the lab.
3. In Use mode, drag the isolinear chip onto the inventory.
4. Talk to the guard ("Who goes there?", then "We mean no harm.").
5. Use the tricorder on the guard; set the phaser to Medium and use it on him.
6. Wait: the alarm gets louder, twice.

## URL parameters

The game is at `/play/afu/`; `/` is the site's home page. An old link to `/` with a `game=` parameter is sent on to `/play/afu/` with the same query, but one without it (for example `/?dev`) now lands on Home: add `game=` (or use `/play/afu/?dev`).

| Parameter | |
|---|---|
| `game=demo` | which game (`apps/web/src/games/index.ts`) |
| `speed=4` | runs the sim and the presentation 4 times as fast |
| `mute` | starts with the master volume at 0 |
| `team=worf,crusher` | with `dev` and `start=`: the away team (by object id, the first leads) instead of game.yaml's |
| `art=0` | the flat panels and greybox rooms, no art (the gameplay e2e specs run this way) |
| `ship3d` | with `dev`: the 3D ship set where one is published (`art.ship[station].gltf`) |
| `perf` | a bare `perf` (not `perf=82`, which is `npm run perf`'s) shows the frame-rate overlay on any build, with no `?dev`: see Perf overlay |
| `sw=0` | no offline cache on this load: unregisters the worker and deletes its caches (see Offline cache) |
| `dev` | the dev tools and `window.__au` in a production build (`npm run build`; they are always on under `npm run dev`, and players don't get them without it). Anyone can add it, so in production it lets a player cheat (jump to any screen, read the game's state) |

## Dev tools

Press the backquote key (`` ` ``):

- **trace:** every rule group that ran or was skipped (with the result flags), each effect, warnings,
  failed actions and screen changes, by sim tick.
- **state:** the world's state; type an object id to see those objects.
- **view:** show hotspots, markers and the navmesh; jump to any screen's marker.
- **Restart**, on the overlay's tab bar whatever the tab, starts a new game.

Editing a game's YAML under `npm run dev` reloads it: once nothing is running, the game carries
on in the new content. Content with problems is listed in the overlay and the game carries on
as it was; a change the running game no longer fits (a new object) asks for a restart.

## Perf overlay

A bare `?perf` (for example `/play/afu/?perf`) puts a small panel in the corner: the frame rate over the last second, the longest frame of that
second, and the busiest frame's draw calls, with the worst frame and the most calls since it opened (a first-frame stall would scroll out of
a one-second window). A tap on it resets those. It is for reading a phone's numbers on the deployed site, so it is not behind `?dev`; it is
its own chunk (`perfOverlay-*.js`), which a player without `?perf` never downloads. `?perf=<battle>` is the perf runner's (`npm run perf`) and
shows nothing. Code: `engine/src/dev/perfOverlay.tsx`, the gate `perfOverlayAsked` in `apps/web/src/devGate.ts`.

## Combat's backdrops

A battle's backdrop is one of four nebula plates (`art/space/backdrop/plate<n>.webp`). The choice is `BACKDROP_TABLE` in
`engine/src/view/combat/files.ts`, a table by battle number (Plan 34): scenario mod 4 left plate 0 with 12 of the 40 battles, so the table starts
from mod 4 and moves five (16, 48, 80, 1, 71). Each plate has 10 battles, neighbouring numbers and the route's 51, 71 and 52 never share a plate,
and a battle not in the table falls back to mod 4.

## Tests

```sh
npm test                      # Vitest, including the DOM tests (happy-dom)
npm run typecheck             # the sim's DOM-free config and the browser config
npx playwright install chromium
npm run e2e                   # headless Chromium: smoke, the demo walkthrough, saves, and that a
                              # production build has no dev tools without ?dev (and, with RAW_DIR
                              # set and games/unity lifted, unity.spec.ts)
```

A checkout's e2e run takes two ports: `E2E_PORT` (default 5174) for the dev server and `E2E_PORT + 1` for the production preview. Checkouts
running at the same time set `E2E_PORT` two apart (for example 5186 and 5188), or the preview of one meets the dev server of the next.
