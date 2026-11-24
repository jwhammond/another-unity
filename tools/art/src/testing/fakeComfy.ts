// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeComfyOpts {
  /** Answer POST /prompt with these node_errors (200). */
  nodeErrors?: Record<string, unknown>;
  /** The history entry says error with these messages. */
  errorMessages?: unknown;
  /** Never complete. */
  hang?: boolean;
  /** Polls that answer "not yet" before completion. */
  pendingPolls?: number;
  classTypes?: string[];
}

/** A node:http server speaking the endpoints tools/art uses. The image it serves is whatever `image` holds. */
export class FakeComfy {
  readonly uploads: { name: string; bytes: number }[] = [];
  readonly prompts: unknown[] = [];
  readonly views: string[] = [];
  image = new Uint8Array([137, 80, 78, 71]);
  private server!: Server;
  url = '';
  private polls = 0;

  constructor(private readonly opts: FakeComfyOpts = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise(r => this.server.close(() => r()));
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (v: unknown): void => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(v));
    };
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      const buf = await this.body(req);
      const name = /filename="([^"]+)"/.exec(buf.toString('latin1'))?.[1] ?? '';
      this.uploads.push({ name, bytes: buf.length });
      return json({ name, subfolder: '', type: 'input' });
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      this.prompts.push(JSON.parse((await this.body(req)).toString('utf8')));
      return json({ prompt_id: 'p1', number: 1, node_errors: this.opts.nodeErrors ?? {} });
    }
    if (url.pathname === '/history/p1') {
      if (this.opts.hang || this.polls++ < (this.opts.pendingPolls ?? 0)) return json({});
      if (this.opts.errorMessages) return json({ p1: { outputs: {}, status: { status_str: 'error', completed: false, messages: this.opts.errorMessages } } });
      const outputs: Record<string, unknown> = {};
      for (const id of ['9', '10']) outputs[id] = { images: [{ filename: `out${id}.png`, subfolder: '', type: 'output' }] };
      return json({ p1: { outputs, status: { status_str: 'success', completed: true, messages: [] } } });
    }
    if (url.pathname === '/view') {
      this.views.push(url.searchParams.get('filename') ?? '');
      res.setHeader('content-type', 'image/png');
      return void res.end(Buffer.from(this.image));
    }
    if (url.pathname === '/system_stats') {
      return json({
        system: { comfyui_version: '0.0.0-fake', pytorch_version: '2.0' },
        devices: [{ type: 'mps', vram_total: 100, vram_free: 40 }],
      });
    }
    if (url.pathname === '/object_info') {
      return json(Object.fromEntries((this.opts.classTypes ?? ['KSampler']).map(c => [c, {}])));
    }
    res.statusCode = 404;
    res.end('no');
  }
}
