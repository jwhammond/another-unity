// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import type { ArtCache } from './cache';
import { FAMILY_NODES, FOLDER_LOADERS, familyEntries, type ExperimentalFamily } from './families';
import { loadModels } from './models';

export interface DoctorLine {
  what: string;
  ok: boolean;
  detail: string;
  /** An experimental family's line: reported, but not needed for the game's art (the exit code ignores it). */
  optional?: boolean;
}

export interface DoctorDeps {
  run(cmd: string, args: string[]): Promise<{ code: number; out: string }>;
  exists(p: string): boolean;
  /** Reads a text file (pins.env, models.yaml). */
  read(p: string): string;
  /** sha256 of a file. */
  hash(p: string): Promise<string>;
  /** Where pins.env and models.yaml live. */
  pinsFile: string;
  modelsFile: string;
  /** The Jellyfin env file's path and mode (null if absent). Its contents are never read here. */
  jellyfinEnv?: { path: string; mode: number | null };
}

const BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
const INSTALL = 'sh tools/art/setup/install.sh';

export function parsePins(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function tryRun(deps: DoctorDeps, cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    return await deps.run(cmd, args);
  } catch (e) {
    return { code: 127, out: (e as Error).message };
  }
}

export async function doctor(cache: ArtCache, deps: DoctorDeps): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const add = (what: string, ok: boolean, detail: string) => lines.push({ what, ok, detail });
  const pins = parsePins(deps.read(deps.pinsFile));

  const blender = process.env.BLENDER || BLENDER;
  if (deps.exists(blender)) {
    const r = await tryRun(deps, blender, ['--version']);
    add('blender', r.code === 0, r.out.split('\n')[0] ?? '');
  } else add('blender', false, `${blender} is missing: ${INSTALL}`);

  for (const [tool, args] of [['ffmpeg', ['-version']], ['cwebp', ['-version']]] as const) {
    const r = await tryRun(deps, tool, [...args]);
    add(tool, r.code === 0, r.code === 0 ? (r.out.split('\n')[0] ?? '').trim() : `${tool} is missing: brew install ${tool === 'cwebp' ? 'webp' : tool}`);
  }

  if (deps.jellyfinEnv) {
    const { path, mode } = deps.jellyfinEnv;
    if (mode === null) add('jellyfin env', false, `${path} is missing (JELLYFIN_URL and JELLYFIN_KEY, mode 600)`);
    else add('jellyfin env', (mode & 0o077) === 0, `${path} mode ${(mode & 0o777).toString(8)}${(mode & 0o077) === 0 ? '' : ': chmod 600'}`);
  }

  const uv = await tryRun(deps, 'uv', ['--version']);
  add('uv', uv.code === 0, uv.code === 0 ? uv.out.trim() : `uv is missing: ${INSTALL}`);

  if (!deps.exists(cache.python)) {
    add('python', false, `no venv at ${cache.venv}: ${INSTALL} --bootstrap`);
  } else {
    const py = await tryRun(deps, cache.python, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])']);
    const want = pins.PYTHON_VERSION ?? '3.12';
    add('python', py.code === 0 && py.out.trim().startsWith(`${want}.`), `${py.out.trim()} (want ${want})`);
    const torch = await tryRun(deps, cache.python, [
      '-c',
      'import torch; print(torch.__version__, "mps" if torch.backends.mps.is_available() else "no-mps")',
    ]);
    add('torch + MPS', torch.code === 0 && torch.out.trim().endsWith(' mps'), torch.out.trim().split('\n').pop() ?? '');
  }

  const aux = join(cache.comfy, 'custom_nodes', 'comfyui_controlnet_aux');
  const ipa = join(cache.comfy, 'custom_nodes', 'ComfyUI_IPAdapter_plus');
  for (const [what, dir, want] of [
    ['ComfyUI commit', cache.comfy, pins.COMFYUI_COMMIT],
    ['controlnet_aux commit', aux, pins.AUX_COMMIT],
    ['IPAdapter_plus commit', ipa, pins.IPADAPTER_COMMIT],
  ] as const) {
    if (!deps.exists(join(dir, '.git'))) {
      add(what, false, `no checkout at ${dir}: ${INSTALL}`);
      continue;
    }
    const r = await tryRun(deps, 'git', ['-C', dir, 'rev-parse', 'HEAD']);
    add(what, r.code === 0 && r.out.trim() === want, `${r.out.trim()} (want ${want})`);
  }

  const models = loadModels(deps.read(deps.modelsFile));
  const used = new Set<string>(Object.values(models.selected ?? {}).filter((k): k is string => k !== undefined));
  const ids = used.size > 0 ? [...used] : Object.keys(models.models);
  for (const id of ids) {
    const m = models.models[id]!;
    // a remote-only file is the COMFY_URL server's: art doctor with COMFY_URL lists it there
    if (m.remoteOnly) continue;
    const path = join(cache.models, m.file);
    if (!deps.exists(path)) {
      add(`model ${id}`, false, `${m.file} is missing: npm run art -- fetch --model ${id}`);
    } else if (m.sha256 === 'pending') {
      add(`model ${id}`, false, `${m.file} has no recorded sha256: npm run art -- fetch --record`);
    } else {
      const h = await deps.hash(path);
      add(`model ${id}`, h === m.sha256, h === m.sha256 ? `${m.file} sha256 ok, ${m.licence}` : `${m.file} sha256 ${h}, want ${m.sha256}`);
    }
  }
  return lines;
}

/** The node classes the graphs in graphs.ts use (the two custom-node packs supply the last group). */
export const REQUIRED_NODES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'CLIPVisionLoader',
  'ControlNetApplyAdvanced',
  'ControlNetLoader',
  'DifferentialDiffusion',
  'EmptyLatentImage',
  'GrowMask',
  'ImageBatch',
  'ImageScale',
  'ImageToMask',
  'ImageUpscaleWithModel',
  'KSampler',
  'LoadImage',
  'LoraLoader',
  'SaveImage',
  'SetLatentNoiseMask',
  'SetUnionControlNetType',
  'UpscaleModelLoader',
  'VAEDecode',
  'VAEEncode',
  'VAELoader',
  // comfyui_controlnet_aux
  'DepthAnythingV2Preprocessor',
  'AnyLineArtPreprocessor_aux',
  // ComfyUI_IPAdapter_plus
  'IPAdapterAdvanced',
  'IPAdapterModelLoader',
] as const;

/** Which loader node and input lists each models.yaml role's files on a server. Annotators are fetched on demand by the aux node, so can't be listed. */
const LOADERS: Partial<Record<string, [string, string]>> = {
  checkpoint: ['CheckpointLoaderSimple', 'ckpt_name'],
  vae: ['VAELoader', 'vae_name'],
  lora: ['LoraLoader', 'lora_name'],
  controlnet: ['ControlNetLoader', 'control_net_name'],
  upscaler: ['UpscaleModelLoader', 'model_name'],
  ipadapter: ['IPAdapterModelLoader', 'ipadapter_file'],
  clip_vision: ['CLIPVisionLoader', 'clip_name'],
};

/** The files a loader input offers, from either /object_info shape ([[...], {}] or ["COMBO", {options: [...]}]). */
function optionsOf(info: Record<string, unknown>, node: string, input: string): string[] | undefined {
  const n = info[node] as
    | {
        input?: {
          required?: Record<string, unknown>;
          optional?: Record<string, unknown>;
        };
      }
    | undefined;
  const spec = (n?.input?.required?.[input] ?? n?.input?.optional?.[input]) as unknown[] | undefined;
  if (!spec) return undefined;
  if (Array.isArray(spec[0])) return spec[0] as string[];
  const opts = (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(opts) ? (opts as string[]) : undefined;
}

export interface RemoteDoctorDeps {
  info(): Promise<{
    comfyui: string;
    torch: string;
    device: string;
    vramTotal: number;
    vramFree?: number;
  }>;
  objectInfo(): Promise<Record<string, unknown>>;
  read(p: string): string;
  pinsFile: string;
  modelsFile: string;
}

/**
 * Doctor for a server at COMFY_URL: its version against pins.env's tag, the node classes the graphs need, and the model
 * files models.yaml selects, by what the loader nodes list. A remote's hashes and commits can't be proved, only its names.
 */
export async function remoteDoctor(url: string, deps: RemoteDoctorDeps): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const add = (what: string, ok: boolean, detail: string) => lines.push({ what, ok, detail });
  const pins = parsePins(deps.read(deps.pinsFile));
  let info: Awaited<ReturnType<RemoteDoctorDeps['info']>>;
  let objects: Record<string, unknown>;
  try {
    info = await deps.info();
    objects = await deps.objectInfo();
  } catch (e) {
    add('server', false, `${url} did not answer: ${(e as Error).message}`);
    return lines;
  }
  add('server', true, url);
  const want = pins.COMFYUI_TAG?.replace(/^v/, '');
  add('ComfyUI version', info.comfyui.replace(/^v/, '') === want, `${info.comfyui} (want ${pins.COMFYUI_TAG}; commit not provable remotely)`);
  add(
    'device',
    info.device === 'cuda' || info.device === 'mps',
    `${info.device}, torch ${info.torch}, ${(info.vramTotal / 2 ** 30).toFixed(1)} GB VRAM (${((info.vramFree ?? 0) / 2 ** 30).toFixed(1)} GB free)`,
  );
  const missing = REQUIRED_NODES.filter(n => !(n in objects));
  add(
    'node classes',
    missing.length === 0,
    missing.length === 0
      ? `all ${REQUIRED_NODES.length} present`
      : `missing: ${missing.join(', ')} (custom nodes: controlnet_aux ${pins.AUX_COMMIT?.slice(0, 7)}, IPAdapter_plus ${pins.IPADAPTER_COMMIT?.slice(0, 7)})`,
  );
  const models = loadModels(deps.read(deps.modelsFile));
  const used = new Set<string>(Object.values(models.selected ?? {}).filter((k): k is string => k !== undefined));
  for (const id of used.size > 0 ? [...used] : Object.keys(models.models)) {
    const m = models.models[id]!;
    if (m.role === 'experimental') continue;
    const loader = LOADERS[m.role];
    if (!loader) {
      add(`model ${id}`, true, `${m.file}: an annotator, fetched on demand by the node (not listed by the server)`);
      continue;
    }
    const have = optionsOf(objects, loader[0], loader[1]);
    if (!have) {
      add(`model ${id}`, false, `cannot tell: ${loader[0]}.${loader[1]} lists nothing (node missing?); want ${m.file}`);
      continue;
    }
    const name = m.file.slice(m.file.indexOf('/') + 1);
    const found = have.find(f => f.replace(/\\/g, '/') === name);
    add(
      `model ${id}`,
      !!found,
      found
        ? `${name} listed by ${loader[0]} (by name only: the remote's sha256 is unverified)`
        : `${name} is not listed by ${loader[0]} (it has: ${have.slice(0, 8).join(', ') || 'nothing'}); put it in models/${m.file}`,
    );
  }
  for (const family of Object.keys(FAMILY_NODES) as ExperimentalFamily[]) {
    const entries = Object.values(familyEntries(models, family)).flat();
    if (entries.length === 0) continue;
    const opt = (what: string, ok: boolean, detail: string) => lines.push({ what, ok, detail, optional: true });
    const gone = FAMILY_NODES[family].filter(n => !(n in objects));
    const missing: string[] = [];
    for (const e of entries) {
      const folder = e.file.slice(0, e.file.indexOf('/'));
      const name = e.file.slice(folder.length + 1);
      const loader = FOLDER_LOADERS[folder];
      const have = loader ? optionsOf(objects, loader[0], loader[1]) : undefined;
      if (!have?.some(f => f.replace(/\\/g, '/') === name)) missing.push(e.file);
    }
    opt(
      `family ${family}`,
      gone.length === 0 && missing.length === 0,
      gone.length === 0 && missing.length === 0
        ? `all ${entries.length} experimental files listed and its ${FAMILY_NODES[family].length} node classes present (by name only)`
        : [gone.length ? `missing nodes: ${gone.join(', ')}` : '', missing.length ? `missing files: ${missing.join(', ')}` : ''].filter(Boolean).join('; '),
    );
  }
  return lines;
}

/** Whether a family's experimental files and nodes are all on the server (art compare waits on this before generating). */
export function familyReady(lines: DoctorLine[], family: ExperimentalFamily): boolean {
  return lines.some(l => l.what === `family ${family}` && l.ok);
}
