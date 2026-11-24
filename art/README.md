# Art

What is committed here is the recipe for the art, never the art itself: recipes (`recipes/*.yaml`), the model lock (`models.yaml`, with each model's URL, sha256 and licence), the benchmark's numbers (`bench/*.yaml`) and the Blender scripts (`blender/`). They hold no game text and no image bytes from the game.

What never is committed: model weights, plates, depth and normal maps, cards, textures, glTF built from traced layouts, benchmark images and intermediates. They live under `~/pcode/unity-art-cache/` or `games/unity/art/`, both outside git, and `tools/art/src/ip.test.ts` fails if git tracks any of them.
