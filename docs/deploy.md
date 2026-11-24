# Deploying to Cloudflare Pages

The remake is a static site: the browser runs everything and the host hands out files. A deploy is a **direct upload from this
machine** (`wrangler pages deploy`), never Git integration, because the game's data and art are not in the repository.

> **Rights.** The game's voices, movies, sprites and text (lifted into `games/unity/`, git-ignored) and the art repainted from them
> ship **only encrypted**: the deploy build takes them from `games/unity/.sealed` (`npm run gate:seal`), never in the clear. The key
> is made from the player's own CD: the page asks for the CD's folder or a disc image (the import screen, docs/web.md), reads a few
> pieces of it on the device and keeps the key there, and the service worker opens the files with it. Without the CD the game doesn't
> open; the built-in demo still plays. **The site keeps its login for now** (Access or a password, below): opening it to everyone is a
> later decision, which the gate makes possible. Never commit `games/unity/**` outputs, `games/unity/gate.yaml`, `apps/web/dist-deploy/`
> or any build output, and never give Cloudflare a Git connection to this repository. `npm run deploy:check` fails if a game file
> ships in the clear, if lifted text is in any shipped file, or if a source map, env file, trace or Jellyfin file would ship.
> The site's before-and-after pictures (`site:media`) are not the gate's: they ship as they are.

## One-time setup

1. **Pages project.** Dashboard > Workers & Pages > Create > Pages > *Upload assets* (a direct-upload project, not "Connect to Git").
   Note its name; the free address is `<name>.pages.dev`.
2. **Log wrangler in** (opens a browser; the token stays on this machine):
   `npx wrangler login`. Wrangler is a dev dependency (`wrangler@4.148.0`, installed by `npm install`).
3. **Name the project** in your shell profile (never in the repo):
   `export CF_PAGES_PROJECT=<name>`. Optionally `CF_PAGES_BRANCH` (default `main`, the project's production branch; any other
   branch name publishes a *preview* deployment at `<branch>.<name>.pages.dev` instead of the production address).
4. **Put a login in front of it before the first upload.** Either (or both):
   - **Cloudflare Access** (per-person, revocable, free up to 50 users): Zero Trust > Access > Applications > Add > Self-hosted.
     Domains `<name>.pages.dev` and `*.<name>.pages.dev` (covers previews). Policy: Allow, Emails, the testers; login method One-time PIN;
     session length as you like. Nothing in the repo is needed. **Both domains are needed:** the Pages project's own "Enable access
     policy" switch covers only `*.<name>.pages.dev`, which leaves the production address open (this happened on the first deploy,
     2026-10-23). After every first deploy, check `curl -sI https://<name>.pages.dev/` answers `302` to `…cloudflareaccess.com`.
   - **One shared password** (Basic Auth, `functions/_middleware.ts`): set the secret `SITE_PASSWORD` on the project (dashboard >
     the project > Settings > Variables and Secrets > add, type *Secret*; or `npx wrangler pages secret put SITE_PASSWORD
     --project-name $CF_PAGES_PROJECT`). Optionally `SITE_USER` too: then the user name must match as well, otherwise any user name works.
     With no `SITE_PASSWORD` the middleware only passes requests on, so an Access-only site is unaffected. It runs for **every**
     request, and the free plan allows 100,000 Functions requests a day (a play session can make thousands): use Access for more than a
     few testers, and for an Access-only site deploy with `DEPLOY_FUNCTIONS=0` so no function runs at all.

5. **Set up the gate, once** (with `GAMEDATA_DIR` pointing at the game's CD folder, below):
   `npm run gate:init`. It chooses, at random, which pieces of the CD the key is made from, and writes them with a random salt to
   `games/unity/gate.yaml` (git-ignored; it never prints them). It refuses to overwrite an existing one: keep it, and keep it in the
   backup. A new one gives a new key, so every player would have to import the CD again.

## Deploying

The build makes the site's before-and-after pictures from the exported originals (`site:media`, docs/site.md), so with the game data
lifted it needs the art tools' inputs set. Without `IMAGES_DIR` it stops with "IMAGES_DIR is not set" and changes nothing. Put them in
your shell profile, or export them first:

With the game lifted the build also needs `GAMEDATA_DIR`, the game's CD folder: it seals the game with the key made from it.

```sh
export IMAGES_DIR=$HOME/pcode/unity-raw/runs/images/media   # the exported originals (required)
export GAMEDATA_DIR=$HOME/pcode/unity-gamedata/cd            # the game's CD folder, with STTNG.ZIP (required: the key)
export RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw         # the raw IR export
```

```sh
npm run deploy:build     # the production build with the local lifted data and art -> apps/web/dist-deploy, then the checks
npm run deploy:check     # the checks alone, on the existing output
CF_PAGES_PROJECT=<name> npm run deploy              # build, check, show the command, ask "Upload now? [y/N]", upload
CF_PAGES_PROJECT=<name> npm run deploy -- --dry-run # everything but the upload
```

`deploy` refuses to run if `CF_PAGES_PROJECT` is unset or invalid, if the lifted data or the art (`games/unity/game.yaml`,
`games/unity/art`) is missing (`AU_DEPLOY_DEMO_ONLY=1` builds the demo on purpose), if any check fails, or if it has no terminal to ask on.
It uploads with `npx wrangler pages deploy apps/web/dist-deploy --project-name $CF_PAGES_PROJECT --branch ${CF_PAGES_BRANCH:-main}`,
run from the repository root, because Wrangler reads `functions/` from the directory it is started in (not from the uploaded
directory). `DEPLOY_FUNCTIONS=0` starts it from the output instead, which has no `functions/`.

What the build is: first `npm run gate:seal`, which encrypts every file the game takes from `games/unity` (the yaml as one
`content.pack`, `combat.yaml` as `combat.pack`, the art, audio, movies, models and space packs) into `games/unity/.sealed` (git-ignored),
with `check.bin`, the known text the import screen opens to tell the right CD from a wrong one. A file that didn't change seals to the
same bytes and is skipped, so a rebuild is quick and players don't download it again. The transcoder's `*.cmd` notes beside the audio
(they name local paths) are never sealed or shipped. The build stops with "the gate is not set up" when the game is lifted and
`games/unity/gate.yaml` isn't there. Then `VITE_AU_DEPLOY=1 vite build`, which (a) removes `?dev` entirely (`main.ts` replaces the flag at build time, so the
dev overlay, `window.__au` and the `astroKnow`-style test hooks are not in the bundle: the check searches for them), and (b) writes no
source maps, and (c) takes the unity game from `games/unity/.sealed` (`unitySealed.ts`), not the plain files. `apps/web/deploy/_headers` and `404.html` are copied into the output. The checks fail on a missing `index.html`, `sw.js`,
`au-manifest.json` or `_headers`.

### Checks and limits

| Limit (Pages) | Value | Check |
| --- | --- | --- |
| Files in one deployment | 20,000 | fails over, warns within 10% |
| Size of one file | 25 MiB | fails over, warns within 10% |
| `_headers` | 100 rules, 2,000 characters a line | fails over |

The report lists the totals, the ten largest files and the size by type. Over a limit it fails and says what to do: bundle many small files
into packs (as `engineering.pack` does), split or recompress a big file (lossy WebP, a lower Opus bitrate, a smaller movie, more
`manualChunks`), or move media to Cloudflare R2. It also fails on a source map, `.env`, key or certificate, trace or walkthrough,
Jellyfin file, raw yaml/ts/md source, git metadata, a local absolute path or a secret's name inside shipped code, and on the dev hooks above.

With the game lifted (`games/unity/game.yaml` here), the gate's checks run too:
- **Every sealed file is sealed.** Each file `au-manifest.json` lists as `sealed` is in the output and starts with the sealed header.
- **No game file ships in the clear.** No shipped file has the SHA-256 of a file under `games/unity` (but the committed `hooks/` and
  `theme.css`, which are public anyway, and `.sealed/`). Only files of the same size are read, so the check takes seconds.
- **No lifted text ships.** 500 strings of prose (20 characters or more, with a space) are sampled at random from the lifted yaml (not
  `overrides/`, `.sealed/` or `gate.yaml`) and searched for, as they are and as a JS string would hold them, in every shipped file but
  the sealed ones and compressed pictures, sounds, movies and fonts. A hit says only the file and how many strings: the sample is kept
  in memory and never printed.
- The gate's parameters are necessarily in the bundle (the page needs them to read the CD); they are in no committed file.
- The site's before-and-after pictures are outside `games/unity`, so they ship as they are.

On the build of 22 Oct 2026 (Mertens Station, the ship screens and their art): 11,177 files, 360 MiB, largest file `unity-*.js` at
13.1 MiB (the game's lifted data), then a 6.3 MiB movie and 4.7 MiB art; 10,023 of the files are voice clips (`.opus`).
Under both limits. The count is the one to watch as art lands (the full game has far more clips than that).
With Plan 24 (combat's stills, sheets and the lazy combat.yaml): 11,791 files, 412.0 MiB.
With Plan 31 (combat's switch-on, the build of 30 Oct 2026): 11,809 files, 417.0 MiB, largest file the lifted game data's
`unity-*.js` at 13.7 MiB (then a 6.3 MiB movie and 4.7 MiB art); 1,317 `.webp`, 10,071 `.opus`, 152 `.glb`, 15 `.pack`. The
18 space art files (12 `.pack`, 6 `.webp`, `games/unity/art/space`) are among them, each once, by type and byte size.
`deploy:e2e` passes (5 smoke tests, then the gate simulation). The checks first failed on one problem, `assets/main-*.js:
contains the dev overlay`: the text `Dev tools`, the summary of `TacticalPanel`'s `dev` fold-out (`engine/src/ui/ship/tactical.tsx`,
since Plan 27), was in the shipped code. Fixed (Task 7b): the dev chunk gives the label (`DEV_TOOLS_LABEL`, `engine/src/dev/gameCombat.tsx`,
passed as `devLabel` through `ShipPanel`), the visible text under `?dev` unchanged. `deploy:build` now ends `checks passed.`
with the same 11,809 files and 417.0 MiB.
With Plan 35 (the CD gate, the build of 9 Nov 2026): 12,880 files, 438.1 MiB, of which 12,539 are sealed; the largest file is now
`content-*.pack`, the lifted yaml sealed (11.5 MiB), then the 6.3 MiB movie. The gate's checks add about 5 s. `deploy:e2e` passes:
5 smoke tests, 5 gate tests (the CD folder unlocks in well under a second; a sealed movie is answered `206` to its Range), then the
login simulation. The gate's e2e found that the worker had never installed on Pages: it asked for the site's pages by their
`index.html` names, which Pages answers with a redirect to the folder, and a redirected answer is never cached. It now asks for the folder.

### Checking a phone with `?perf`

After a deploy, open the site's `/play/afu/?perf` on the phone (past the login) and play a battle. The panel in the corner gives fps, the longest
frame and the busiest frame's draw calls (see `docs/web.md`, Perf overlay). Look at the first seconds of a battle (the warm-up of Plan 34
should leave no long first frame) and at the busiest battle, 82 (148 calls at its busiest in the e2e, against a budget of 150; the overlay counts every render in a frame,
so it can read higher). A tap resets the worst-case figures. Report the fps, the worst frame
and the calls, with the phone's model. The overlay is a separate chunk, so a link without `?perf` loads none of it.

## Headers and caching

`apps/web/deploy/_headers` (copied into the output):

- `index.html`, `/`, `sw.js`, `au-manifest.json`, `manifest.webmanifest`: `no-cache` (a deploy is seen on the next load).
- Everything under `/assets/` (hashed names: code, art, audio, movies, models, fonts, packs): `public, max-age=31536000, immutable`.
- Content types for `.webp`, `.opus`, `.ogg`, `.wav`, `.webm`, `.glb`, `.wasm`, `.fon`, `.pack`.
- On every response: `X-Robots-Tag: noindex, nofollow, noarchive`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` (no camera, microphone or location), HSTS, and a CSP: own-origin scripts, styles (plus inline: the loading screen and
  the UI's style attributes), images, media, fonts and connections, with `data:`/`blob:` for the renderer and audio decoder, no objects, frames or other origins.
  `deploy:e2e` runs the game under it and fails on any violation.
- `404.html` makes a missing file a real 404. Without it Pages answers any unknown path with the game's page (200), and a stale link to a script or image would get HTML.
- No `_redirects`: the app has one page and uses query parameters.

## The offline cache and the login

The service worker (docs/web.md "Offline cache") never stores a gate's answer. A response is cached only if it is a plain `200` from
our own origin (`type === 'basic'`), was not reached through a redirect, and is not HTML when a script, image, audio or data file was
asked for (`isCacheable` in `swRules.ts`). So Access's redirect to its sign-in page, a Basic Auth `401`, a `403`, an opaque response, or a sign-in page
served as `200` in place of a file are passed to the page and not kept; a precache that meets one fails the install, and the old worker stays.
A page load while online goes to the network first (4 s, then the cached index), so an expired session reaches the login; offline,
on a bad connection or on a server error, the cached index starts the game. After signing in again, reload.

## Cache-busting and builds

File names carry their content hash, so a changed file is a new URL. `au-manifest.json` lists the build and its `version` (the build id, a
hash of the file names) is baked into `sw.js`, which is never cached by the host. A player's browser finds the new worker on the next
visit, installs it in the background, and on the next load shows "Updating..." and reloads once. Old `au-shell-<id>` and `au-data-<id>`
caches are deleted on activation; `au-assets` keeps only files the new manifest still lists. `?sw=0` or `__auCache.clear()` clears it by hand.
Saves are in IndexedDB per **site address**: changing the address (a custom domain later) loses testers' saves, so settle on it before wide testing.

## Rolling back

Dashboard > the project > Deployments: each upload is kept. On a production deployment's menu choose *Rollback to this deployment*
(instant, no upload). Players' workers pick the old build up on their next visit like any other update. From the shell:
`npx wrangler pages deployment list --project-name $CF_PAGES_PROJECT` lists them. To remove a bad upload, delete it in the dashboard.
To fix forward, rebuild and `npm run deploy` again. (Wrangler's own commands talk to Cloudflare, so run them yourself.)

## Trying it locally (no network)

```sh
E2E_PORT=5292 npm run deploy:preview             # wrangler pages dev on the output (builds it first if absent; --rebuild to force)
SITE_PASSWORD=test npm run deploy:preview        # the Basic Auth middleware active, with a throwaway password
E2E_PORT=5292 npm run deploy:e2e                 # headless: the smoke and the CD gate against the preview, then the login simulation
```

`deploy:e2e` needs the same lifted data as a deploy; it plays the demo and, when `games/unity` is lifted, the unity game from
the first screen (after giving the import screen `GAMEDATA_DIR`), with no console error, CSP violation or failed request, checks the headers, and with a fixture server that answers `401`, a redirect to a sign-in page and a sign-in page
in place of a file, checks that nothing of it is cached and that a page load reaches the sign-in. The same part runs `sw-update.spec.ts`
(with `GAMEDATA_DIR`): it unlocks and plays the build, then lays a next deploy over it (made from the output without a second build:
every script chunk and `content.pack` under a new name, and a new version) and loads again as a returning player, who must reach the first
screen under the new build's worker. (The existing e2e specs drive the game
through `window.__au`, which a deploy build removes on purpose, so they run against the dev server as before.)
The preview part also runs `deploy-gate.spec.ts`, the CD gate on the real sealed build, with `GAMEDATA_DIR` as the player's CD (both
specs skip the unity game without it): a folder of made-up files under the CD's names gets "These don't look like the A Final Unity CD.",
the CD folder unlocks the game and the first screen draws, a reload plays without the import screen (offline too), a phone (Pixel 7)
unlocks from an ISO of the folder (`hdiutil makehybrid -iso`, macOS only, made in `apps/web/test-results` and deleted afterwards), and a
cleared key brings the import screen back. Nothing read from the CD is logged.
`npx vitest run functions apps/web` has the unit tests for the middleware, the check rules and `swRules.ts`.
