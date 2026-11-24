# Generic ComfyUI workflows

Load these in ComfyUI (drag the .json onto the canvas). They are plain, generic graphs, not used by `tools/art`.

## Krea 2 Turbo

- `krea2-turbo-t2i.json`: text to image. Empty latent (EmptySD3LatentImage, 1024x1024) -> KSampler.
- `krea2-turbo-i2i.json`: image to image. LoadImage -> ImageScaleToTotalPixels (1 MP, multiples of 16) -> VAEEncode -> KSampler at denoise 0.6.

Both use 8 steps, CFG 1.0, `er_sde` / `simple`, Turbo's usual settings. At CFG 1 the negative prompt has no effect.
They need ComfyUI with native Krea 2 support (CLIPLoader type `krea2`); 0.41.3 on the 4080 has it.

Files (none are on the 4080 yet):

| File | Folder | Source |
|---|---|---|
| `krea2_turbo_fp8.safetensors` (~12 GB) | `models/diffusion_models/` | a community fp8 conversion, e.g. `AlperKTS/Krea2_FP8` on Hugging Face; the official weights are `krea/Krea-2-Turbo` |
| `qwen3vl_4b_fp8_scaled.safetensors` (~4.9 GB) | `models/text_encoders/` | `Comfy-Org/Qwen3-VL`, `text_encoders/` |
| `qwen_image_vae.safetensors` | `models/vae/` | already installed (Qwen-Image) |

Image to image: denoise 0.3-0.5 keeps the composition; 0.6-0.8 restyles it. With only 8 steps, low denoise runs very few steps; raise steps to 12-16 below 0.4.
