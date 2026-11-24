// SPDX-License-Identifier: GPL-3.0-or-later
import type { Generator, GeneratorInfo, Graph, Job } from '../generator';
import { decodePng, encodePng } from '../image';

/** Records each job and returns a solid PNG of the size the graph asks for (so later tasks' tests can check sizes). */
export class FakeGenerator implements Generator {
  readonly jobs: Job[] = [];
  /** Test hook: throw this on the next run. */
  failWith?: Error;

  constructor(private readonly fill: [number, number, number, number] = [128, 128, 128, 255]) {}

  async run(job: Job): Promise<Record<string, Uint8Array>> {
    this.jobs.push(job);
    if (this.failWith) throw this.failWith;
    const out: Record<string, Uint8Array> = {};
    for (const [name, node] of Object.entries(job.outputs)) {
      const [width, height] = sizeOf(job, [node, 0]);
      const data = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) data.set(this.fill, i * 4);
      out[name] = encodePng({ width, height, data });
    }
    return out;
  }

  async info(): Promise<GeneratorInfo> {
    return { comfyui: 'fake', torch: 'fake', device: 'fake', vramTotal: 0 };
  }

  async nodeTypes(): Promise<Set<string>> {
    return new Set();
  }
}

type Ref = [string, number];
const isRef = (v: unknown): v is Ref => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

/** The pixel size an output has: follow the first image/latent/sample input back to a size-giving node. */
export function sizeOf(job: Job, ref: Ref): [number, number] {
  const graph: Graph = job.graph;
  const node = graph[ref[0]];
  if (!node) throw new Error(`no node ${ref[0]}`);
  const i = node.inputs;
  switch (node.class_type) {
    case 'EmptyLatentImage':
      return [Number(i.width), Number(i.height)];
    case 'ImageScale':
      return [Number(i.width), Number(i.height)];
    case 'LoadImage': {
      const bytes = job.inputs[String(i.image)];
      if (!bytes) throw new Error(`FakeGenerator: no input "${String(i.image)}"`);
      const d = decodePng(bytes);
      return [d.width, d.height];
    }
    case 'ImageUpscaleWithModel': {
      const [w, h] = sizeOf(job, i.image as Ref);
      return [w * 4, h * 4];
    }
    case 'VAEDecode':
      return sizeOf(job, i.samples as Ref);
    case 'KSampler':
      return sizeOf(job, i.latent_image as Ref);
    case 'VAEEncode':
      return sizeOf(job, i.pixels as Ref);
    default: {
      const next = ['images', 'image', 'samples', 'pixels', 'latent_image'].map(k => i[k]).find(isRef);
      if (!next) throw new Error(`FakeGenerator cannot size ${node.class_type}`);
      return sizeOf(job, next);
    }
  }
}
