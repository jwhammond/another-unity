// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artCache } from './cache';
import { FAMILY_NODES } from './families';
import { doctor, familyReady, remoteDoctor, REQUIRED_NODES, type DoctorDeps } from './doctor';

const cache = artCache({ ART_CACHE: '/cache' });
const PINS = 'PYTHON_VERSION=3.12\nCOMFYUI_COMMIT=c0ffee\nAUX_COMMIT=badc0de\nIPADAPTER_COMMIT=1pa\n';
const SHA = 'b'.repeat(64);
const MODELS = `models:
  m1: {role: checkpoint, file: checkpoints/m1.safetensors, url: "https://e.com/m1", sha256: ${SHA}, licence: MIT, licenceUrl: "https://e.com/l"}
  m2: {role: vae, file: vae/m2.safetensors, url: "https://e.com/m2", sha256: pending, licence: MIT, licenceUrl: "https://e.com/l"}
`;

function deps(over: Partial<DoctorDeps> & { present?: string[] } = {}): DoctorDeps {
  const present = new Set(over.present ?? []);
  return {
    run: async (cmd, args) => {
      if (cmd.endsWith('Blender')) return { code: 0, out: 'Blender 5.0.0\n  build date' };
      if (cmd === 'uv') return { code: 0, out: 'uv 0.13.1' };
      if (cmd === 'git') return { code: 0, out: args[1]!.includes('controlnet_aux') ? 'badc0de\n' : args[1]!.includes('IPAdapter') ? '1pa\n' : 'c0ffee\n' };
      if (args.join(' ').includes('torch')) return { code: 0, out: '2.9.0 mps\n' };
      return { code: 0, out: '3.12.8\n' };
    },
    exists: p => present.has(p),
    read: p => (p === 'pins' ? PINS : MODELS),
    hash: async () => SHA,
    pinsFile: 'pins',
    modelsFile: 'models',
    ...over,
  };
}
const everything = [
  '/Applications/Blender.app/Contents/MacOS/Blender',
  cache.python,
  join(cache.comfy, '.git'),
  join(cache.comfy, 'custom_nodes/comfyui_controlnet_aux/.git'),
  join(cache.comfy, 'custom_nodes/ComfyUI_IPAdapter_plus/.git'),
  join(cache.models, 'checkpoints/m1.safetensors'),
  join(cache.models, 'vae/m2.safetensors'),
];

describe('doctor', () => {
  it('reports Blender, uv, Python 3.12, MPS, the ComfyUI and aux commits against pins.env, and each selected model\'s hash', async () => {
    const lines = await doctor(cache, deps({ present: everything }));
    const by = Object.fromEntries(lines.map(l => [l.what, l]));
    expect(by.blender).toMatchObject({ ok: true, detail: 'Blender 5.0.0' });
    expect(by.uv!.ok).toBe(true);
    expect(by.python!.ok).toBe(true);
    expect(by['torch + MPS']!.ok).toBe(true);
    expect(by['ComfyUI commit']!.ok).toBe(true);
    expect(by['controlnet_aux commit']!.ok).toBe(true);
    expect(by['IPAdapter_plus commit']!.ok).toBe(true);
    expect(by['model m1']!.ok).toBe(true);
    expect(by['model m2']).toMatchObject({ ok: false });
    expect(by['model m2']!.detail).toMatch(/--record/);
  });

  it('flags a commit that differs from pins.env and a hash that differs from the lock', async () => {
    const lines = await doctor(cache, deps({ present: everything, hash: async () => 'c'.repeat(64) }));
    expect(lines.find(l => l.what === 'model m1')!.ok).toBe(false);
    const moved = await doctor(cache, deps({ present: everything, run: async cmd => ({ code: 0, out: cmd === 'git' ? 'other\n' : '3.12.1 mps' }) }));
    expect(moved.find(l => l.what === 'ComfyUI commit')!.ok).toBe(false);
  });

  it('a missing venv is one failed line with the install command, not a throw', async () => {
    const lines = await doctor(cache, deps({ present: [] }));
    const py = lines.find(l => l.what === 'python')!;
    expect(py.ok).toBe(false);
    expect(py.detail).toMatch(/install\.sh/);
    expect(lines.find(l => l.what === 'ComfyUI commit')!.ok).toBe(false);
  });

  it('a missing tool is a failed line, not a throw', async () => {
    const lines = await doctor(cache, deps({ present: everything, run: async () => { throw new Error('ENOENT'); } }));
    expect(lines.find(l => l.what === 'uv')!.ok).toBe(false);
  });

  it('reports ffmpeg and cwebp, and the Jellyfin env file\'s mode without reading it', async () => {
    const mk = (mode: number | null) => deps({ present: everything, jellyfinEnv: { path: '/cache/jellyfin.env', mode } });
    const ok = await doctor(cache, mk(0o100600));
    expect(ok.find(l => l.what === 'ffmpeg')!.ok).toBe(true);
    expect(ok.find(l => l.what === 'cwebp')!.ok).toBe(true);
    expect(ok.find(l => l.what === 'jellyfin env')).toMatchObject({ ok: true });
    const open = await doctor(cache, mk(0o100644));
    expect(open.find(l => l.what === 'jellyfin env')).toMatchObject({ ok: false });
    expect(open.find(l => l.what === 'jellyfin env')!.detail).toMatch(/644.*chmod 600/);
    expect((await doctor(cache, mk(null))).find(l => l.what === 'jellyfin env')!.ok).toBe(false);
    const missing = await doctor(cache, deps({ present: everything, run: async cmd => (cmd === 'cwebp' ? Promise.reject(new Error('ENOENT')) : { code: 0, out: '3.12.8 mps' }) }));
    expect(missing.find(l => l.what === 'cwebp')!.ok).toBe(false);
  });
});

describe('remoteDoctor', () => {
  const pins = 'COMFYUI_TAG=v0.41.3\nAUX_COMMIT=a587a4c1\nIPADAPTER_COMMIT=a0f451a5\n';
  const models = `models:
  ck:
    role: checkpoint
    file: checkpoints/a.safetensors
    url: https://x/a
    sha256: "${'0'.repeat(64)}"
    licence: MIT
    licenceUrl: https://x
  ip:
    role: ipadapter
    file: ipadapter/b.safetensors
    url: https://x/b
    sha256: "${'0'.repeat(64)}"
    licence: MIT
    licenceUrl: https://x
selected:
  checkpoint: ck
  depth: ck
  lineart: ck
  depthAnnotator: ck
  lineartAnnotator: ck
  upscaler: ck
  ipadapterStyle: ip
`;
  const objects = (nodes: string[], ckpts: string[]): Record<string, unknown> => {
    const o: Record<string, unknown> = Object.fromEntries(nodes.map(n => [n, { input: { required: {} } }]));
    o.CheckpointLoaderSimple = { input: { required: { ckpt_name: [ckpts] } } };
    return o;
  };
  const run = (version: string, o: Record<string, unknown>) =>
    remoteDoctor('http://h:1', {
      info: async () => ({
        comfyui: version,
        torch: 't',
        device: 'cuda',
        vramTotal: 2 ** 34,
        vramFree: 2 ** 33,
      }),
      objectInfo: async () => o,
      read: p => (p === 'pins' ? pins : models),
      pinsFile: 'pins',
      modelsFile: 'models',
    });

  it('is clean when the version, every node and every model file match', async () => {
    const o = objects([...REQUIRED_NODES], ['a.safetensors']);
    o.IPAdapterModelLoader = {
      input: {
        required: { ipadapter_file: ['COMBO', { options: ['b.safetensors'] }] },
      },
    };
    const lines = await run('0.41.3', o);
    expect(lines.filter(l => !l.ok)).toEqual([]);
  });

  it('reports each experimental family as an optional line: its files by folder loader and its node classes', async () => {
    const withExp = `${models.replace('selected:', `  q-unet:
    role: experimental
    family: qwen-image
    remoteOnly: true
    file: diffusion_models/q.safetensors
    url: https://x/q
    sha256: "${'1'.repeat(64)}"
    licence: Apache-2.0
    licenceUrl: https://x
  q-te:
    role: experimental
    family: qwen-image
    remoteOnly: true
    file: text_encoders/te.safetensors
    url: https://x/te
    sha256: "${'2'.repeat(64)}"
    licence: Apache-2.0
    licenceUrl: https://x
selected:`)}`;
    const o = objects([...REQUIRED_NODES, ...FAMILY_NODES['qwen-image']], ['a.safetensors']);
    o.IPAdapterModelLoader = { input: { required: { ipadapter_file: [['b.safetensors']] } } };
    o.UNETLoader = { input: { required: { unet_name: [['q.safetensors']] } } };
    o.CLIPLoader = { input: { required: { clip_name: [[]] } } };
    const lines = await remoteDoctor('http://h:1', { info: async () => ({ comfyui: '0.41.3', torch: 't', device: 'cuda', vramTotal: 2 ** 34 }), objectInfo: async () => o, read: p => (p === 'pins' ? pins : withExp), pinsFile: 'pins', modelsFile: 'models' });
    const fam = lines.find(l => l.what === 'family qwen-image')!;
    expect(fam).toMatchObject({ ok: false, optional: true });
    expect(fam.detail).toContain('missing files: text_encoders/te.safetensors');
    expect(familyReady(lines, 'qwen-image')).toBe(false);
    // the required lines are still all good: an experimental family never fails the doctor
    expect(lines.filter(l => !l.ok && !l.optional)).toEqual([]);
    o.CLIPLoader = { input: { required: { clip_name: [['te.safetensors']] } } };
    const again = await remoteDoctor('http://h:1', { info: async () => ({ comfyui: '0.41.3', torch: 't', device: 'cuda', vramTotal: 2 ** 34 }), objectInfo: async () => o, read: p => (p === 'pins' ? pins : withExp), pinsFile: 'pins', modelsFile: 'models' });
    expect(familyReady(again, 'qwen-image')).toBe(true);
    expect(again.some(l => l.what === 'family flux')).toBe(false);
  });

  it('names the wrong version, the missing nodes and the missing model files', async () => {
    const o = objects(
      REQUIRED_NODES.filter(n => n !== 'IPAdapterAdvanced'),
      ['other.safetensors'],
    );
    const bad = (await run('0.40.0', o)).filter(l => !l.ok);
    expect(bad.map(l => l.what)).toEqual(['ComfyUI version', 'node classes', 'model ck', 'model ip']);
    expect(bad[1]!.detail).toContain('IPAdapterAdvanced');
    expect(bad[2]!.detail).toContain('a.safetensors is not listed');
  });
});
