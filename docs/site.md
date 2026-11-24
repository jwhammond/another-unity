# The site

The pages a visitor passes through before the game: a small LCARS console (the Star Trek: The Next Generation interface style) that
introduces Another Unity, launches A Final Unity, and documents how the engine and the remake were built. It is the same Vite app as the
game, deployed together (docs/deploy.md), behind the same login.

## Pages

| URL | Shell (`apps/web/…`) | Component (`apps/web/src/site/pages/`) | `data-page` |
|---|---|---|---|
| `/` | `index.html` | `Home.tsx` | `home` |
| `/engineering/` | `engineering/index.html` | `Engineering.tsx` | `engineering` |
| `/engineering/engine/` | `engineering/engine/index.html` | `Engine.tsx` | `engine` |
| `/engineering/afu/` | `engineering/afu/index.html` | `Afu.tsx` | `afu` |
| `/engineering/afu/characters/` | `…/characters/index.html` | `Characters.tsx` | `characters` |
| `/engineering/afu/enterprise/` | `…/enterprise/index.html` | `Enterprise.tsx` | `enterprise` |
| `/engineering/afu/missions/<world>/` | `…/missions/<world>/index.html` | `Mission.tsx` (data in `missions.ts`) | `mission`, `data-world` |
| `/play/afu/` | `play/afu/index.html` | the game (`src/boot.ts`) | |

`<world>` is one of `horst3`, `mertens`, `allanor`, `zoo`, `frigis`, `unity`. An old game link such as `/?game=demo&mute` is forwarded to
`/play/afu/` with the same query. ENGAGE opens `/play/afu/` in a tab named `au-afu` (the current tab if the pop-up is blocked).

Each shell is a tiny HTML file that loads `src/site/main.tsx`; it picks the page component from `<body data-page>` through the registry in
`src/site/loader.tsx`. An unknown name shows "Page not found" inside the frame. The prose of each page is a Markdown file in
`src/site/content/` (our own writing, rendered at build time by `mdPlugin.ts`); the text the spec gives verbatim (the AFU blurb, the AI
note, the thanks, the legal notice) is used word for word.

Each mission page has a worlds menu (`pages/WorldMenu.tsx`, a `nav` labelled "Worlds") under the A Final Unity pills: the six worlds as pills in the three accents, the
current one `aria-current="page"`, wrapping on a phone. The same menu is the "Away missions" panel (`#missions`) of the A Final Unity page, which the
"Missions" pill of that section's sub-nav goes to.

Components: `src/site/lcars/` (Frame, SideNav, Panel, Pill, Readout, Band, Figure, BeforeAfter, SpriteSheet, HotspotOverlay,
NearScreen, SoundToggle, Footer). Styles: `src/site/site.css`.

## The LCARS rules

Keep every page within these (they are the spec's density constraints):

- One frame per page (`Frame`): black ground, elbow, side column of labelled blocks, thin bands, pill buttons.
- At most **six** labelled blocks in the side column (`SideNav` throws on more). At 760 px and below the column becomes a top bar of pills
  that wraps onto a second line rather than scrolling sideways.
- Bands are **10-14 px** tall.
- Content in one column of about **68 characters** (`max-width: 68ch`).
- At least **40%** of the frame stays black.
- "Number noise" appears only as one small decorative block in the header, never in content.
- At most **three** accent colours per frame. Home: orange and peach. Engineering: blue and lavender. A Final Unity: gold.
- The title sits top-right in bold caps. Fonts (Antonio, Barlow Semi Condensed) are served with the site through `@fontsource`, never from
  Google; icons are `lucide-preact`.

## Adding a page

1. Add the HTML shell (copy a sibling): `apps/web/<path>/index.html` with `<body data-page="…">`. Vite finds every `index.html` under
   `apps/web` by itself.
2. Add the component in `src/site/pages/`, default-exported, and an entry in the `pages` registry in `src/site/loader.tsx`.
3. Add its key to `PageKey` and, if it belongs under a side-column block, to `NAV` in `src/site/pages/nav.ts` (six blocks at most).
4. Add its URL to `SITE_PAGES` in `src/swRules.ts`. That list is what the service worker precaches, what the deploy check requires in the
   output, and what the e2e test loops over (accessibility, phone width, no failed requests).
5. Write the prose in `src/site/content/*.md` and import it with `Prose`.

## Pictures (never committed)

The screenshots, before/after pairs, portraits and sprite sheets come from the local game data and published art; they are the game's art,
so they are **never committed** (`apps/web/public/site-media/` is git-ignored, as is the deploy output).

```sh
npm run site:media        # writes apps/web/public/site-media/*.webp and manifest.json
```

Inputs are the same environment variables as `tools/art` (`GAMEDATA_DIR`, `RAW_DIR`, `IMAGES_DIR`); `GAMES_DIR` points at another
`games/unity` (tests, dry runs). Ids in the manifest: `home.afu`, `ship.<station>` (the plates: bridge, viewscreen, transporter, astrogation, computer), `ship.engineering`, `ship.holodeck`, `ship.astrogation.screen`, `room.<world>.<room>` (a before/after pair),
`hotspots.<world>.<room>`, `portrait.<name>`, `sheet.<card>`, `sheet.world.<world>`, `icons`. With the game data here but `IMAGES_DIR` unset (or missing) the script and `deploy:build` fail, naming it, and change nothing; the
script builds into `site-media.tmp` and swaps it in only on success. Without `games/unity/presentation.yaml` it clears the folder and
writes an empty manifest. With no manifest (CI, a build without game data) every `Figure` shows an LCARS "no image" placeholder and
nothing fails or logs an error. `npm run deploy:build` runs the step itself; in a demo-only build (`AU_DEPLOY_DEMO_ONLY=1`) it clears
`site-media` and writes an empty manifest, so an earlier run's pictures never ship.

The three screens with no single plate are real pictures of the screen as a player sees it. `ship.engineering` (Power page, a new game's levels, the palette rotation applied once) and
`ship.holodeck` (holodeck.rm with the original's choice dialog listing the first eight movies) are drawn in node by the engine's own renderers
(`apps/web/scripts/siteMedia/screens.ts`: the packed indexed pictures, fonts and palette, no browser). `ship.astrogation.screen` (the map, the plate's panels and
the game's fonts are DOM and canvas) is an element screenshot of the screen only, taken headlessly from the game at `/play/afu/` with the dev hooks
(`siteMedia/astroShot.ts`): it starts a vite dev server on port 5293 (`SITE_MEDIA_PORT`, 5290-5293 only) and stops it again. The step skips, with the reason logged,
when `SITE_MEDIA_BROWSER=0`, `GAMES_DIR` is set, there is no built game or astrogation plate, Playwright's Chromium is missing or the server does not come up; the page then shows its placeholder.
All three are scaled to 960 wide.

Mission pages hold many pictures, so `NearScreen` renders a room's pictures only when they are near the screen. The first Tab press, and
printing, render all of them so keyboard users reach every slider.

## Sound

Synthesized Web Audio chirps only (`lcars/chirp.ts`), never show audio. Off by default; the header toggle stores `'1'` (on) in
`localStorage` under `au-site-sound`. A denied action (the greyed-out game) gives a low buzz.

## Offline

Every page of the site registers the game's service worker (`src/swRegister.ts`). Its install precaches all of `SITE_PAGES` and the game
shell (`au-manifest.json`), so after one online visit any site page and the game load with no network. The worker never caches
`/site-media/*` or its manifest (they are not under `/assets/`), so offline every `Figure` shows its placeholder, including pictures
seen online. The text, styles and fonts work offline; the pictures do not.

## Testing

```sh
npx vitest run apps/web                                        # components, loader, deploy checks
E2E_PORT=5290 npx playwright test -c apps/web/playwright.config.ts apps/web/e2e/site.spec.ts apps/web/e2e/offline.spec.ts
```

`site.spec.ts` loads every page in `SITE_PAGES`: one `h1`, no console errors or failed requests, no serious or critical axe violations
(`@axe-core/playwright`), and no sideways scroll at 390 px. Run it once with the pictures built and once with `public/site-media/` moved
aside (placeholders); both must pass. `offline.spec.ts` visits two pages online, goes offline, and reloads the site and the game.
`npm run deploy -- --dry-run` builds and checks the output (every page present, every precached file present). Set `SHOTS=<dir>` to write
screenshots from the screenshot tests.
