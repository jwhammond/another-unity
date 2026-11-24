## The stack

The whole thing is TypeScript. Vite builds it, Preact draws the interface, and three.js draws the astrogation map. Vitest runs the unit tests and Playwright drives a real browser through the game.

A service worker keeps the game on the player's machine, so a second visit starts from disk and still works with no network. The built site is a plain set of static files, uploaded straight to Cloudflare Pages behind a login.

The engine is open source, under the GNU GPL version 3 or later. Game content is kept apart from it: the site carries each game's content encrypted, and the player's own copy of the game unlocks it in their browser.

## How it fits together

The **simulation core** (`engine/src/sim`) holds the rules: rooms, objects, scripts, conversations and the ship. It knows nothing about screens. The **data lift** (`tools/lift`) reads the original game's files and writes the game data the simulation runs on. The **art pipeline** (`tools/art`) turns recipes into repainted backgrounds, and publishes only the ones that pass its alignment check.

The **web runtime** (`engine/src/web`, `engine/src/view`, `engine/src/ui`) puts the simulation on a stage with layers and an interface. To keep the remake honest, the **comparison tools** (`tools/placement`, plus step-by-step walks and trace comparison) run the same rooms in ScummVM's Unity engine and in ours, and report where they differ.
