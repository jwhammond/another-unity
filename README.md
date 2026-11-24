# Another Unity

A browser remake of the 1995 adventure game A Final Unity. The engine runs in the browser; the game's
content is lifted from the original data into a content model the engine plays.

## Where it comes from

The engine is derived from ScummVM's Unity engine: large parts are ported from it, and the source
comments cite the `.cpp` files they follow. ScummVM is GPLv3-or-later, and so is this project.

## The game's data

The original game's data is not in this repository and never will be. To play A Final Unity you need your
own copy of the CD. [docs/unity-local.md](docs/unity-local.md) describes building the game from it on your
own machine. A deployed site unlocks the game from your CD in the browser; see
[docs/deploy.md](docs/deploy.md).

## The demo

Without a CD there is a small built-in demo made of made-up content: open the site with `?game=demo`.

## Building and testing

Node 22 or later. `npm install`, then `npm run typecheck`. `npm run ci` runs the checks that need no game
data.

## Support

If you'd like to support the engine's development, you can [buy me a coffee on Ko-fi](https://ko-fi.com/sz750108)
or sponsor [jwhammond](https://github.com/sponsors/jwhammond) on GitHub.

## License

GPL-3.0-or-later: see [LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT) and [NOTICE](NOTICE).
