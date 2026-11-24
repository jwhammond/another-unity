# Publishing the repository

The steps to put the project on GitHub. Nothing here runs by itself; do each step by hand, and nothing here pushes.

## Why a snapshot, not the history

The public repository does not get this repo's history. Older commits hold the game's own text (lines lifted into tests,
fixtures and the working notes), and rewriting every commit to take it out is more risk than it is worth. Instead the
public repository is pushed from a branch of its own, `public`, whose first commit holds today's tree with no parent, and
each later publish adds one commit on top of it. The local history stays as it is.

The snapshot is HEAD's tree less `docs/superpowers/` (the working notes, which quote the game while the engine was built).
It is made from the last commit: uncommitted changes are not in it, so commit what you mean to publish first.

## The first publish

1. Commit what you mean to publish; `git status` shows nothing you meant to include.
2. Add the license lines to any new source files: `npm run publish:spdx` (it only touches tracked files). Commit the result.
3. Scan the tree: `npm run publish:scan -- --tree HEAD`. It checks every tracked file (outside the working notes) against
   every lifted string of the game but the names (values of four words or fewer under a `name`, `title` or `heading` key,
   not ending as a sentence does), and for secrets, the gate's parameters, the game's files, original media and absolute
   home paths; each of these is a failure. The tree holds no media at all: any binary file, any picture, sound, movie, model or
   packed file by its extension (`.webp`, `.png`, `.opus`, `.webm`, `.glb`, `.pack` and the like) and any file over 2 MB fails too.
   Fix what it reports and commit, until it is clean. A hit that should stay (a name, or a short engine string the original's
   source also holds) goes in `tools/publish/allow.json` with its path, line hash and the reason; a file of the project's own that
   should stay (an icon it drew) goes there with its `path`, its `blob` (the id the report prints) and a `why`, so the same path
   with other bytes fails again. The scan needs `games/unity/gate.yaml` and the lifted game: without either, or if no lifted
   string comes out of it, it stops with an error rather than pass a tree it could not check. The lifted-text rule finds only
   whole lifted values of 12 characters or more, so short lines and paraphrases of the game's text need a human look.
4. Make the snapshot: `npm run publish:snapshot`. It makes one new commit, scans its tree, and moves the `public` branch to
   it only when nothing fails; on a failure `public` stays where it was and it exits 1 (2 when an input of the scan is missing,
   before any commit is made). The working tree, the index and your
   branch are not touched.
5. Create the repository and the remote:
   `gh repo create <name> --public --remote origin --source .`
6. Push the snapshot as the public repo's `main`: `git push -u origin public:main`

The commit's author name and email become public on the push. Check `git log -1 --format='%an <%ae>' public` first.

## Later publishes

Commit on your working branch as usual, then run steps 2 to 4 again. `npm run publish:snapshot` makes one new commit on
`public` whose parent is the last snapshot (not a new first commit), so the public history grows one commit per publish; if
the tree has not changed it makes none. Then push it: `git push origin public:main`.

`npm run publish:scan` without `--tree` scans the whole local history instead; that history is not published, so its
lifted-text hits in old commits are expected.

## Afterwards, on GitHub

- The license shows as GPL-3.0 in the repository's sidebar.
- `LICENSE`, `COPYRIGHT`, `NOTICE` and `README.md` render at the root.
- Browse the file tree: no `docs/superpowers`, no `games/unity` content beyond the committed stubs, no art, audio or video
  from the game, no `.env` files or keys.
- Search the repository for any name or path you did not mean to publish.
