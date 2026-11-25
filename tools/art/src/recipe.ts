// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { controlWindow } from './sigmas';
import { FAMILIES } from './models';
import { noiseFor } from './families';
import { parseManifest } from './refs';
import { CAMERA_PARAMS } from './shipcam';
import { DEDITHER_DEFAULTS as DD } from './dedither';

const sampling = z
  .object({
    seed: z.number().int().nonnegative(),
    steps: z.number().int().positive(),
    cfg: z.number().positive(),
    sampler: z.string(),
    scheduler: z.string(),
  })
  .strict();
/** A ControlNet's window is RELATIVE to the sampled steps (0 the first, 1 past the last); sigmas.ts maps it onto ComfyUI's percents. */
const control = z
  .object({ strength: z.number().min(0).max(2), start: z.number().min(0).max(1).default(0), end: z.number().min(0).max(1).default(1) })
  .strict()
  .refine(c => c.start < c.end, 'start must come before end');
/** Plan 15 R4: an IP-Adapter reference. `refs` are ids in art/refs/show.yaml; the window is relative to the sampled steps, like a control's. */
const reference = z
  .object({
    refs: z.array(z.string()).min(1),
    model: z.enum(['style', 'face']),
    weight: z.number().min(0).max(1.5),
    weightType: z.enum(['linear', 'style transfer', 'strong style transfer', 'ease in-out']).default('linear'),
    start: z.number().min(0).max(1).default(0),
    end: z.number().min(0).max(1).default(1),
    /** Cards only (Task 9). */
    mask: z.enum(['none', 'figure', 'head']).default('none'),
  })
  .strict()
  .refine(c => c.start < c.end, 'start must come before end');
const maskSchema = z
  .object({
    protect: z.number().min(0).max(1).default(0.5),
    pointRadius: z.number().positive().default(18),
    band: z.number().positive().default(8),
    smallRect: z.number().nonnegative().default(6000),
    edgeLow: z.number().min(0).max(1).default(0.12),
    edgeHigh: z.number().min(0).max(1).default(0.3),
    edgeGrow: z.number().int().nonnegative().default(2),
    feather: z.number().nonnegative().default(4),
    emissiveSat: z.number().positive().default(0.35),
    emissiveVal: z.number().min(0).max(1).default(0.3),
    emissiveLum: z.number().positive().default(0.88),
    emissiveGrow: z.number().int().nonnegative().default(3),
  })
  .strict()
  .refine(m => m.edgeLow < m.edgeHigh, 'edgeLow must be below edgeHigh');
export type MaskSpec = z.infer<typeof maskSchema>;
export type ReferenceSpec = z.infer<typeof reference>;
const post = z.union([
  z.object({ depth: z.object({ resolution: z.number().int().positive().default(1024) }).strict() }).strict(),
  /** `skip` (with a `reason`) turns the check off, and is allowed only for an upscale-only room plate (`repaint: false`). */
  z.object({ align: z.object({ maxShift: z.number().positive().default(2), skip: z.boolean().optional(), reason: z.string().min(1).optional() }).strict() }).strict(),
  /** The local warp (warp.ts): before `align`. maxWarp and maxShare cap it to a touch-up. */
  z.object({
    warp: z
      .object({
        radius: z.number().positive().max(200).default(24),
        minShift: z.number().positive().default(1),
        passes: z.number().int().min(1).max(3).default(2),
        maxWarp: z.number().positive().max(8).default(5),
        maxShare: z.number().positive().max(1).default(0.25),
      })
      .strict(),
  }).strict(),
  z.object({ normal: z.object({ strength: z.number().positive().default(2) }).strict() }).strict(),
  z.object({ tilePreview: z.literal(true) }).strict(),
]);

/** Original pixels, [x, y, width, height]. */
export type Rect = [number, number, number, number];
const rect = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().positive(), z.number().int().positive()]);
const SHIP_STEMS = ['bridge', 'viewscr', 'transp', 'astropnl', 'compupnl'] as const;
/** Plan 16 R11: the ship screen each station repaints (its stem in the cache's originals/ship/). */
export const PLATE_STEMS = { bridge: 'bridge', viewscreen: 'viewscr', transporter: 'transp', astrogation: 'astropnl', computer: 'compupnl' } as const;
export type PlateStation = keyof typeof PLATE_STEMS;

export const repaintRecipe = z
  .object({
    /** The screen id it is for, e.g. lab.s01. */
    id: z.string(),
    kind: z.literal('repaint'),
    /** A room's background (the images export's screen id, e.g. s_0401), or one of the ship's own screens (R11). */
    source: z.union([
      z.object({ background: z.string().regex(/^s_[0-9a-f]{4}$/) }).strict(),
      z.object({ ship: z.enum(SHIP_STEMS) }).strict(),
      /** A hail's picture (a viewscreen sprite's first frame, e.g. viewpent), decoded with its own palette into the cache's originals/view/. */
      z.object({ hail: z.string().regex(/^[a-z0-9_]+$/) }).strict(),
      /**
       * Plan 30 R3, R5: tactical's console (spc00a.pic as tactical draws it, in the space palette) or the atlas of space.mrg's pictures it
       * repaints, decoded by `art:space originals` into the cache's originals/space/.
       */
      z.object({ space: z.enum(['console', 'pages']) }).strict(),
      /**
       * Plan 32 Task 12: the admin console's body (adminmnu.spr's first picture, 420 by 478) or the F1 Combat Options screen (final.spr, 562 by
       * 334), decoded from the game zip by admin.ts into the cache's originals/admin/, its clear pixels black. Plan 33 Task 7: or one of the
       * screen's pages (adminmnu.spr's animations 1-5), drawn on the console where the console draws it.
       */
      z.object({ admin: z.enum(['console', 'final', 'load', 'save', 'new', 'quit', 'sound']) }).strict(),
    ]),
    /** R12, ship source only: interface the original paints into its background. The denoise mask is 0 there and the plate takes the run's own upscale. */
    keep: z.array(rect).default([]),
    /** R14, ship source only: named rectangles of a station that must hold still (alignment points and mask), original pixels. */
    areas: z.record(z.string().regex(/^[a-z]+$/), rect).default({}),
    /** R15, ship source only: where the viewscreen's window sits. */
    window: z.object({ at: z.tuple([z.number().int(), z.number().int()]) }).strict().optional(),
    /**
     * `false`: an upscale-only room plate (the de-dithered 4x upscale, no diffusion pass), for an original with too little structure to
     * measure (a flat grey with one band). Only such a plate may skip the alignment check (`align: { skip: true, reason }`).
     */
    repaint: z.boolean().default(true),
    /** Keys into art/models.yaml; omitted ones take `selected`. */
    models: z
      .object({
        checkpoint: z.string().optional(),
        vae: z.string().optional(),
        lora: z.string().optional(),
        depth: z.string().optional(),
        lineart: z.string().optional(),
        upscaler: z.string().optional(),
      })
      .strict()
      .default({}),
    /** The model family (Plan 17 experiment): sdxl (default, models.yaml's `selected`), or an experimental family's remote-only models. */
    model: z.enum(FAMILIES).default('sdxl'),
    /** flux only: FluxGuidance's distilled guidance (default 4.5, Krea's recommendation). */
    guidance: z.number().positive().max(20).optional(),
    /** qwen-image only: ModelSamplingAuraFlow's shift (default 3.1, ComfyUI's Qwen-Image workflows). */
    shift: z.number().positive().max(20).optional(),
    sampling,
    prompt: z.string(),
    negative: z.string().default(''),
    denoise: z.number().min(0.05).max(0.7),
    depth: control.optional(),
    lineart: control.optional(),
    reference: z.array(reference).default([]),
    /**
     * Masked denoise: `denoise` is the open surfaces' (the sampler's), and the soft mask from the lifted room and the
     * original gives protected zones `protect` times it (maskdenoise.ts).
     */
    mask: maskSchema.optional(),
    /**
     * The de-dither pre-step on the 1x original, before the 4x upscale (dedither.ts): the dither's palette steps are averaged away so
     * the upscaler doesn't turn them into streaks; edges, lines and `keep` are left as they are. Absent: the original goes in as it is.
     */
    dedither: z
      .object({
        method: z.enum(['bilateral', 'none']).default(DD.method),
        sigma: z.number().positive().max(4).default(DD.sigma),
        factor: z.number().positive().max(10).default(DD.factor),
        minRange: z.number().nonnegative().max(255).default(DD.minRange),
        range: z.number().positive().max(442).default(DD.range),
        passes: z.number().int().min(0).max(4).default(DD.passes),
        glowSat: z.number().min(0).max(2).default(DD.glowSat),
        glowLum: z.number().min(0).max(2).default(DD.glowLum),
        glowGrow: z.number().int().min(0).max(8).default(DD.glowGrow),
      })
      .strict()
      .optional(),
    size: z
      .object({
        work: z.tuple([z.number().int(), z.number().int()]).default([1152, 864]),
        out: z.tuple([z.number().int(), z.number().int()]).default([2560, 1920]),
      })
      .strict()
      .default({}),
    post: z.array(post).default([]),
  })
  .strict();
/**
 * Plan 15 Task 9 (R6): a crew card's animations, repainted toward the show. Up to `group` consecutive frames of one animation share a
 * 1024x1024 canvas, one seed and one set of references; the original alpha is forced afterwards. The prompt may name the show, the character
 * and the actor (the user's rule from 2026-10-19, when it helps the likeness or the look); it never quotes game text.
 */
export const cardRecipe = z
  .object({
    /** card.<object> */
    id: z.string().regex(/^card\.[a-z0-9_]+$/),
    kind: z.literal('card'),
    /** The crew object's id, e.g. riker. */
    object: z.string().regex(/^[a-z0-9_]+$/),
    /** The sprite file, e.g. riker.spr. */
    sprite: z.string().regex(/^[a-z0-9]+\.spr$/),
    /**
     * A prop or a person lying on a room's floor, not a crew actor: the lifted objects (ids like lab.big_cable.0308) that stand this card's
     * animation `anim` (a single frame, one cell) over the room's plate. `screens` are other rooms that draw the same sprite (Mertens' woman lies in
     * three rooms, and as a trapped, an injured and a dead woman): the objects listed are the ones each room has. `art masks <screen>` draws it as a layer in the mask's place:
     * at the sprite's own rectangle, sorted by the object's row, shown while the object is here and active.
     * `animate` (Batch 8) lists animations whose every frame is published, as a strip (the frames the original plays, up to its pause or its jump back), instead of a
     * still of the first: the layer then draws the frame the object's animation is on. `anim` is the one it starts on; listing it makes that one a strip too. Put the
     * object's other animations (a door's opening one) in `anims` as well, or the batch never runs them.
     * `talk` (Batch 10) is the animation the object plays while it replies (a character's speech sprites, animation 2): its mouths are drawn over the frame the starting animation marked, so
     * the sprite is played from the start animation into it (`SpriteJson.primed`); list it in `animate` as well, and the layer plays it while a line is said (UnityEngine::replyAnims).
     */
    prop: z.object({ screen: z.string().regex(/^[a-z0-9]+\.s[0-9a-f]{2}$/), screens: z.array(z.string().regex(/^[a-z0-9]+\.s[0-9a-f]{2}$/)).default([]), objects: z.array(z.string().regex(/^[a-z0-9]+\.[a-z0-9_.]+$/)).min(1), anim: z.number().int().nonnegative().default(0), talk: z.number().int().nonnegative().optional(), animate: z.array(z.number().int().nonnegative()).default([]).refine(a => new Set(a).size === a.length, 'list each animation once') }).strict().optional(),
    /**
     * false: an upscale-only card (the plates' `repaint: false`): the sprite's 4x upscaled frames are published as they are, with no diffusion pass. For a
     * texture that is speckle (a carcass, a dark view of cubes) no repaint can be checked; the upscale is geometrically faithful and is checked as any card.
     */
    repaint: z.boolean().default(true),
    /** `align: { skip: true, reason }` turns the alignment check off for a card with nothing measurable; allowed only with `repaint: false`. */
    align: z.object({ skip: z.literal(true), reason: z.string().min(1) }).strict().optional(),
    /** The animations to repaint: R8's used set, or sprite animation indices (the canonical ones). */
    anims: z.union([z.literal('used'), z.array(z.number().int().nonnegative())]).default('used'),
    /** Frames per work canvas (R6). */
    group: z.number().int().min(1).max(6).default(4),
    /** Animation index (canonical) to its own group size: a short animation that would split across two canvases (a seam in the hair and skin tone) goes on one. */
    groupOverrides: z.record(z.string().regex(/^[0-9]+$/), z.number().int().min(1).max(6)).default({}),
    /** Animation index (canonical) to its own seed (R6): an animation whose repaint failed its checks at the recipe's seed and passed at a swept one. One line. */
    seedOverrides: z.record(z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()).default({}),
    models: z.object({ checkpoint: z.string().optional(), vae: z.string().optional(), lora: z.string().optional(), depth: z.string().optional(), lineart: z.string().optional(), upscaler: z.string().optional() }).strict().default({}),
    /** The model family (Plan 17 experiment): sdxl (default, models.yaml's `selected`), or an experimental family's remote-only models. */
    model: z.enum(FAMILIES).default('sdxl'),
    /** flux only: FluxGuidance's distilled guidance (default 4.5, Krea's recommendation). */
    guidance: z.number().positive().max(20).optional(),
    /** qwen-image only: ModelSamplingAuraFlow's shift (default 3.1, ComfyUI's Qwen-Image workflows). */
    shift: z.number().positive().max(20).optional(),
    sampling,
    prompt: z.string(),
    negative: z.string().default(''),
    denoise: z.number().min(0.1).max(0.7),
    depth: control.optional(),
    lineart: control.optional(),
    /** Face (mask `head`) and body/style (mask `figure`) references: ids in art/refs/show.yaml. */
    reference: z.array(reference).default([]),
    checks: z
      .object({ flickerRatio: z.number().positive().default(2.5), flickerMax: z.number().positive().default(12), deltaE: z.number().positive().default(12), speckle: z.number().min(0).max(1).optional() })
      .strict()
      .default({}),
  })
  .strict();
/**
 * Plan 33 Task 6: a bridge crew sprite's frames repainted as a crew card's are (R6: the same canvas, ControlNets and masked references), for the
 * strips `art ship publish bridge` makes. Each distinct frame is painted alone on its canvas with the one seed, and keeps its own alpha (the
 * cut-out's, upscaled with the colour). `hold`: where a frame is the same as the earlier frame it has most in common with (each channel of
 * the upscaled frames within `tolerance`, the alpha equal), it takes that frame's repaint, feathered over `feather` upscaled pixels from where
 * they differ, so a talking mouth doesn't shimmer the rest of the face (feather 0 turns it off). `face` paints the head again, larger.
 * `checks` gate each repainted strip (bridgeanim.ts gateStrip): the card checks' absolute limits only (alpha identical, the outline in place,
 * every frame pair's flicker within `flickerMax`, the colour within `deltaE`), not their flicker ratio, which fails a walk whose median is a
 * held pose's. A strip that fails is published as the upscale.
 */
export const bridgeCrewRecipe = cardRecipe
  .omit({ id: true, kind: true, object: true, sprite: true, prop: true, repaint: true, align: true, anims: true, group: true, groupOverrides: true, seedOverrides: true, checks: true })
  .extend({
    /** bridgecrew.<object> */
    id: z.string().regex(/^bridgecrew\.[a-z]+$/),
    kind: z.literal('bridgecrew'),
    /** The bridge object (ship.yaml's bridge.objects), e.g. worf. */
    object: z.string().regex(/^[a-z]+$/),
    /** Its sprite file, e.g. brdgworf.spr. */
    sprite: z.string().regex(/^brdg[a-z]+\.spr$/),
    model: z.literal('sdxl').default('sdxl'),
    hold: z.object({ tolerance: z.number().min(0).max(64).default(20), feather: z.number().min(0).max(64).default(12) }).strict().default({}),
    checks: z.object({ flickerMax: z.number().positive().default(12), deltaE: z.number().positive().default(12), speckle: z.number().min(0).max(1).optional() }).strict().default({}),
    /**
     * A second pass on the head (one line): the head box (headBoxes), grown by `pad` of its size on each side, repainted on a canvas of its own at
     * `denoise` with the face references alone (at `weight`, else their own) over the whole crop, and blended back over `feather` of the box from
     * its edges. On the whole figure the face is a tenth of the canvas, too small for the eyes.
     */
    face: z.object({ denoise: z.number().min(0.1).max(0.7), pad: z.number().min(0).max(1).default(0.3), feather: z.number().min(0.01).max(0.5).default(0.15), weight: z.number().min(0).max(1.5).optional() }).strict().optional(),
    /**
     * Colour fix-ups after the head pass, before the hold (bridgerepaint.ts applyFixups): frame `frame` of animation `anim` takes the colour in
     * `box` ([x, y, w, h], in the animation's cell, the upscaled pixels its strip has) from frame `from` of the same animation: `copy` (the default)
     * takes its colour at the same place, `tone` matches the box's lightness and colour to the source box's (bridgerepaint.ts tone). Never the alpha.
     */
    fixups: z
      .array(z.object({ anim: z.number().int().min(0), frame: z.number().int().min(0), box: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().positive(), z.number().int().positive()]), from: z.number().int().min(0), mode: z.enum(['copy', 'tone']).optional() }).strict())
      .optional(),
    /**
     * Frames painted from masters (bridgerepaint.ts paintFromMasters), in place of each frame painted alone and held: a frame that differs from an
     * earlier master in at most `maxChange` of its figure takes that master's paint, with only what moved (grown by `grow` upscaled pixels and
     * blended in over `feather`) repainted, at `denoise` (else the recipe's), in the master's colours. Any other frame is a master of its own,
     * painted whole. Nothing that stays still can change, so nothing shimmers. `hold` doesn't apply; `fixups` do, after.
     */
    master: z
      .object({
        maxChange: z.number().min(0).max(1).default(0.35),
        grow: z.number().min(0).max(128).default(16),
        feather: z.number().min(1).max(128).default(12),
        denoise: z.number().min(0.1).max(1).optional(),
        /**
         * The likeness a frame painted from a master is pulled toward: the master's own painted head (its head box, as the head pass crops it) in
         * place of the face references, at `faceWeight` (else theirs). A head that turns or talks then keeps the face the master was given.
         */
        faceFromMaster: z.boolean().default(false),
        /** The recipe's head pass (`face`) on a frame painted from a master whose head moved, as a master's is: the face as good as a master's. */
        facePass: z.boolean().default(false),
        /**
         * The head pass painted for several frames at once: a master's head with those of its frames whose head moved, this many to one canvas, as
         * the room crew's frames are painted together, so they come out as one face. Every frame's body is painted first, its head last.
         */
        headGroup: z.number().int().min(1).max(6).optional(),
        faceWeight: z.number().min(0).max(1.5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BridgeCrewRecipe = z.infer<typeof bridgeCrewRecipe>;
export const blenderRecipe = z
  .object({
    id: z.string(),
    kind: z.literal('blender'),
    /** Under art/blender/. */
    script: z.string().regex(/^[a-z0-9_/]+\.py$/),
    params: z.record(z.unknown()).default({}),
    /** Textures from texture recipes, by recipe id: their last outputs are passed to the script as paths. */
    textures: z.array(z.string()).default([]),
    out: z.literal('glb').default('glb'),
  })
  .strict();
export const textureRecipe = z
  .object({
    id: z.string().regex(/^tex\.[a-z0-9-]+$/),
    kind: z.literal('texture'),
    models: z.object({ checkpoint: z.string().optional(), vae: z.string().optional(), lora: z.string().optional() }).strict().default({}),
    sampling,
    prompt: z.string(),
    negative: z.string().default(''),
    size: z
      .number()
      .int()
      .refine(n => n % 64 === 0, 'size must be a multiple of 64')
      .default(1024),
    seam: z
      .object({ band: z.number().int().positive().default(64), denoise: z.number().min(0.3).max(0.9).default(0.7) })
      .strict()
      .default({}),
    post: z.array(post).default([{ normal: { strength: 2 } }, { tilePreview: true }]),
  })
  .strict();

/**
 * Plan 16 R2: a ship set. `trace` rows are [u, v, X, Y, Z]: pixels read off the decoded original and the same point in our own design
 * (metres, Y up). `support` says which plane each lifted item rectangle is unprojected onto, keyed by the item's index in ship.yaml.
 * The rectangles themselves come from the lift at run time, so a `rects` or `items` key is refused (strict) and no lifted number
 * is committed.
 */
const supportSchema = z.union([
  z.object({ axis: z.enum(['x', 'y', 'z']), at: z.number() }).strict(),
  /** An item that isn't part of the 3D scene (a button of the original's own UI strip). */
  z.object({ ui: z.literal(true) }).strict(),
]);
export const shipRecipe = blenderRecipe
  .extend({
    id: z.string().regex(/^ship\.[a-z0-9-]+$/),
    kind: z.literal('ship'),
    station: z.enum(['bridge', 'transporter', 'astrogation', 'computer']),
    /** Where the fit starts: position, angles in degrees, vertical FOV in degrees, lens shift in pixels. */
    start: z
      .object({ position: z.tuple([z.number(), z.number(), z.number()]), yaw: z.number().default(0), pitch: z.number().default(0), roll: z.number().default(0), fovY: z.number(), shiftY: z.number().default(0) })
      .strict(),
    /** The camera parameters the fit solves for; the others stay at `start`'s. */
    free: z.array(z.enum(CAMERA_PARAMS)).min(4).default(['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'fovY']),
    trace: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).min(6).max(12),
    support: z.record(z.string().regex(/^\d+$/), supportSchema),
    /** The script's own numbers: metres, colours as hex. */
    design: z.record(z.unknown()).default({}),
    /** The fit's largest allowed RMS reprojection error, pixels. */
    maxRms: z.number().positive().default(3),
    /** Material recipes (mat.*) whose last bakes are passed to the script as `--textures`. */
    materials: z.array(z.string().regex(/^mat\.[a-z0-9-]+$/)).default([]),
  })
  .strict();
export type ShipRecipe = z.infer<typeof shipRecipe>;

/**
 * Plan 16 R5: a procedural material. `script` (under art/blender/mat/) builds a node graph, and Cycles bakes it on the CPU
 * (seeded, `samples` samples, no denoise) to `size`-square albedo, roughness and height maps. TypeScript then makes them tile
 * (`band` px cosine cross) and derives the normal map from the height.
 */
export const materialRecipe = z
  .object({
    id: z.string().regex(/^mat\.[a-z0-9-]+$/),
    kind: z.literal('material'),
    script: z.string().regex(/^mat\/[a-z0-9_-]+\.py$/),
    seed: z.number().int().default(1),
    size: z
      .number()
      .int()
      .refine(n => n % 64 === 0, 'size must be a multiple of 64')
      .default(1024),
    samples: z.number().int().positive().default(64),
    band: z.number().int().min(0).default(96),
    normalStrength: z.number().positive().default(2),
    /** The script's own numbers: colours as hex, scales. */
    params: z.record(z.unknown()).default({}),
  })
  .strict();
export type MaterialRecipe = z.infer<typeof materialRecipe>;

/**
 * Plan 30 R8: every combat texture's repaint, one recipe for all (each texture's run is `tex.space.<lower-case name>` in the cache): its
 * 4x de-dithered upscale, img2img at `denoise` under its UV islands, the damage textures at their bases' seeds. A texture under `minSide`
 * texels a side, or named in `upscaleOnly`, is the upscale alone; `seeds` gives one texture a seed of its own (a re-roll), by name.
 */
export const spaceTexturesRecipe = z
  .object({
    id: z.literal('space.textures'),
    kind: z.literal('spacetex'),
    models: z.object({ checkpoint: z.string().optional(), vae: z.string().optional(), lora: z.string().optional(), upscaler: z.string().optional() }).strict().default({}),
    sampling,
    prompt: z.string(),
    negative: z.string().default(''),
    denoise: z.number().min(0.1).max(0.5),
    /** The islands grown by `grow` texels before the mask is scaled to the work size and feathered by `feather` work pixels. */
    islands: z.object({ grow: z.number().int().min(0).max(4).default(1), feather: z.number().nonnegative().default(4) }).strict().default({}),
    minSide: z.number().int().positive().default(32),
    seeds: z.record(z.string().regex(/^[a-z0-9_.-]+$/), z.number().int().nonnegative()).default({}),
    upscaleOnly: z.array(z.string().regex(/^[a-z0-9_.-]+$/)).default([]),
    dedither: z.object({ method: z.enum(['bilateral', 'none']).default(DD.method), sigma: z.number().positive().max(4).default(DD.sigma) }).strict().default({}),
    align: z.object({ maxShift: z.number().positive().default(2) }).strict().default({}),
  })
  .strict();
export type SpaceTexturesRecipe = z.infer<typeof spaceTexturesRecipe>;

/**
 * Plan 30 R11, R12, R5: what combat shows as the original drew it, only de-dithered and upscaled 4x: the effects' sprite sheets, the
 * scanner pictures (their areas left clear, the console's indices draw them) and space.mrg's other pictures and digits.
 */
export const spaceUpscalesRecipe = z
  .object({
    id: z.literal('space.upscales'),
    kind: z.literal('spaceup'),
    models: z.object({ upscaler: z.string().optional() }).strict().default({}),
    dedither: z.object({ method: z.enum(['bilateral', 'none']).default(DD.method), sigma: z.number().positive().max(4).default(DD.sigma) }).strict().default({}),
  })
  .strict();
export type SpaceUpscalesRecipe = z.infer<typeof spaceUpscalesRecipe>;

/** R3 / I2: a ControlNet active on no sampled step does nothing, and that must not pass silently. */
function checkControls(r: z.infer<typeof repaintRecipe> | z.infer<typeof cardRecipe> | z.infer<typeof bridgeCrewRecipe>, ctx: z.RefinementCtx): void {
  const want = r.model === 'sdxl' ? ['karras', 'normal'] : ['simple'];
  for (const name of ['depth', 'lineart'] as const) {
    const c = r[name];
    if (!c) continue;
    if (!want.includes(r.sampling.scheduler)) {
      ctx.addIssue({ code: 'custom', path: ['sampling', 'scheduler'], message: `the ${name} window can't be mapped onto the sampled steps for scheduler "${r.sampling.scheduler}" (${r.model}: ${want.join(' or ')})` });
      continue;
    }
    const w = controlWindow(r.sampling.steps, r.denoise, r.sampling.scheduler, c, noiseFor(r.model, r.shift));
    if (w.activeFraction <= 0) ctx.addIssue({ code: 'custom', path: [name], message: `${name} is active on no sampled step (window ${c.start}-${c.end} of ${r.sampling.steps} steps at denoise ${r.denoise})` });
  }
  // the families' own knobs, and what each can take as references
  if (r.guidance !== undefined && r.model !== 'flux') ctx.addIssue({ code: 'custom', path: ['guidance'], message: 'guidance is for model: flux only' });
  if (r.shift !== undefined && r.model !== 'qwen-image') ctx.addIssue({ code: 'custom', path: ['shift'], message: 'shift is for model: qwen-image only' });
  if (r.model === 'qwen-image' && r.reference.length > 0) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'qwen-image takes no references: ComfyUI core has no image prompt for the base model (the Edit model\'s image inputs are a different model)' });
  if (r.model !== 'sdxl' && 'models' in r && Object.values(r.models).some(v => v !== undefined)) ctx.addIssue({ code: 'custom', path: ['models'], message: `models: is for sdxl; ${r.model} takes its family's experimental models from art/models.yaml` });
}
/** R11: a `plate.<station>` id goes with its own ship stem; keep, areas and window belong to a ship source only. */
function checkSource(r: z.infer<typeof repaintRecipe>, ctx: z.RefinementCtx): void {
  if ('hail' in r.source) {
    if (!/^hail\.[a-z0-9_]+$/.test(r.id)) ctx.addIssue({ code: 'custom', path: ['id'], message: `a hail-source recipe's id is hail.<name>, not "${r.id}"` });
    if (r.keep.length > 0) ctx.addIssue({ code: 'custom', path: ['keep'], message: 'keep is for a ship source only' });
    if (Object.keys(r.areas).length > 0) ctx.addIssue({ code: 'custom', path: ['areas'], message: 'areas is for a ship source only' });
    if (r.window) ctx.addIssue({ code: 'custom', path: ['window'], message: 'window is for a ship source only' });
    return;
  }
  if ('admin' in r.source) {
    const want = r.source.admin === 'console' ? 'plate.admin' : r.source.admin === 'final' ? 'plate.final' : `plate.admin.${r.source.admin}`;
    if (r.id !== want) ctx.addIssue({ code: 'custom', path: ['id'], message: `an admin-source recipe for "${r.source.admin}" is ${want}, not "${r.id}"` });
    if (r.window) ctx.addIssue({ code: 'custom', path: ['window'], message: 'a window is for plate.viewscreen only' });
    return;
  }
  if ('space' in r.source) {
    const want = r.source.space === 'console' ? 'plate.tactical' : 'pages.tactical';
    if (r.id !== want) ctx.addIssue({ code: 'custom', path: ['id'], message: `a space-source recipe for "${r.source.space}" is ${want}, not "${r.id}"` });
    if (r.source.space === 'pages' && (r.keep.length > 0 || Object.keys(r.areas).length > 0)) ctx.addIssue({ code: 'custom', path: ['areas'], message: 'the pages\' atlas takes its points from its pictures: no keep or areas' });
    if (r.window) ctx.addIssue({ code: 'custom', path: ['window'], message: 'a window is for plate.viewscreen only' });
    return;
  }
  const plate = /^plate\.([a-z]+)$/.exec(r.id)?.[1];
  if ('ship' in r.source) {
    const want = plate && plate in PLATE_STEMS ? PLATE_STEMS[plate as PlateStation] : undefined;
    if (!want) ctx.addIssue({ code: 'custom', path: ['id'], message: `a ship-source recipe's id is plate.<station> (${Object.keys(PLATE_STEMS).join(', ')}), not "${r.id}"` });
    else if (want !== r.source.ship) ctx.addIssue({ code: 'custom', path: ['source'], message: `${r.id} repaints the ship screen "${want}", not "${r.source.ship}"` });
    if (r.window && r.id !== 'plate.viewscreen') ctx.addIssue({ code: 'custom', path: ['window'], message: 'a window is for plate.viewscreen only' });
    if (r.areas.window) ctx.addIssue({ code: 'custom', path: ['areas', 'window'], message: '"window" is not an area name: the window comes from `window` and is published as an area' });
    return;
  }
  if (plate) ctx.addIssue({ code: 'custom', path: ['source'], message: `${r.id} is a plate recipe and needs source: { ship: <stem> }` });
  if (r.keep.length > 0) ctx.addIssue({ code: 'custom', path: ['keep'], message: 'keep is for a ship source only' });
  if (Object.keys(r.areas).length > 0) ctx.addIssue({ code: 'custom', path: ['areas'], message: 'areas is for a ship source only' });
  if (r.window) ctx.addIssue({ code: 'custom', path: ['window'], message: 'window is for a ship source only' });
}
/** The post steps' order and where each belongs: warp before align; an align skip only for an upscale-only plate, and with its reason. */
function checkPost(r: { post: z.infer<typeof post>[]; kind: string; repaint?: boolean }, ctx: z.RefinementCtx): void {
  const at = (k: string): number => r.post.findIndex(p => k in p);
  if (r.kind !== 'repaint' && at('warp') >= 0) ctx.addIssue({ code: 'custom', path: ['post'], message: 'warp is for repaint recipes only' });
  if (at('warp') >= 0 && at('align') >= 0 && at('warp') > at('align')) ctx.addIssue({ code: 'custom', path: ['post'], message: 'warp must come before align (the check gates the warped plate)' });
  if (at('warp') >= 0 && at('align') < 0) ctx.addIssue({ code: 'custom', path: ['post'], message: 'warp needs an align step after it: the check must gate the warped plate' });
  const a = r.post.find((p): p is Extract<z.infer<typeof post>, { align: unknown }> => 'align' in p);
  if (a?.align.skip) {
    if (r.repaint !== false) ctx.addIssue({ code: 'custom', path: ['post'], message: 'align: { skip: true } is allowed only for an upscale-only plate (repaint: false); a repainted plate must pass the check' });
    if (!a.align.reason) ctx.addIssue({ code: 'custom', path: ['post'], message: 'align skip needs a reason' });
  }
}
export const recipeSchema = z.discriminatedUnion('kind', [repaintRecipe, blenderRecipe, textureRecipe, cardRecipe, bridgeCrewRecipe, shipRecipe, materialRecipe, spaceTexturesRecipe, spaceUpscalesRecipe]).superRefine((r, ctx) => {
  if (r.kind === 'repaint') checkSource(r, ctx);
  if (r.kind === 'repaint' || r.kind === 'texture') checkPost(r, ctx);
  if (r.kind === 'repaint' || r.kind === 'card' || r.kind === 'bridgecrew') checkControls(r, ctx);
  if (r.kind === 'card' && r.align && r.repaint !== false) ctx.addIssue({ code: 'custom', path: ['align'], message: 'align: { skip: true } is allowed only for an upscale-only card (repaint: false); a repainted card must pass the check' });
});
export type Recipe = z.infer<typeof recipeSchema>;
export type BlenderRecipe = z.infer<typeof blenderRecipe>;
export type CardRecipe = z.infer<typeof cardRecipe>;
export type RepaintRecipe = z.infer<typeof repaintRecipe>;

/** The station a ship-source recipe is for (from its id), or null for a room recipe. */
export function plateStation(r: RepaintRecipe): PlateStation | null {
  if (!('ship' in r.source)) return null;
  const s = /^plate\.([a-z]+)$/.exec(r.id)?.[1];
  return s && s in PLATE_STEMS ? (s as PlateStation) : null;
}
/** A room recipe's screen id (images export), e.g. s_0401. Throws for a ship source. */
export function backgroundOf(r: RepaintRecipe): string {
  if (!('background' in r.source)) throw new Error(`${r.id} repaints a ship screen or a hail, not a room's background`);
  return r.source.background;
}

const REFS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'art', 'refs');
/** The ids in every art/refs/*.yaml manifest (or in one file, when given a .yaml path); read only when a recipe has references. */
export function manifestIds(from = REFS_DIR): Set<string> {
  const files = from.endsWith('.yaml') ? [from] : readdirSync(from).filter(f => /^[a-z0-9-]+\.yaml$/.test(f)).sort().map(f => join(from, f));
  return new Set(files.flatMap(f => Object.keys(parseManifest(readFileSync(f, 'utf8'), parseYaml).refs)));
}

/**
 * Parses a recipe file; its `id` must be the file's stem (`lab.s01.yaml` is `lab.s01`), and each reference must name a manifest id
 * (`known` defaults to every art/refs/*.yaml's).
 */
export function parseRecipe(text: string, file: string, known?: Set<string>): Recipe {
  const recipe = recipeSchema.parse(parseYaml(text));
  if ((recipe.kind === 'repaint' || recipe.kind === 'card' || recipe.kind === 'bridgecrew') && recipe.reference.length > 0) {
    const ids = known ?? manifestIds();
    for (const r of recipe.reference) for (const id of r.refs) if (!ids.has(id)) throw new Error(`${file}: reference "${id}" is in no manifest under art/refs/`);
  }
  const stem = basename(file).replace(/\.ya?ml$/, '');
  if (recipe.id !== stem) throw new Error(`${file}: id "${recipe.id}" is not the file's stem "${stem}"`);
  return recipe;
}
