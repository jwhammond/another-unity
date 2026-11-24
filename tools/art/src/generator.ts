// SPDX-License-Identifier: GPL-3.0-or-later
/** The boundary every art tool goes through, and the only thing the unit tests mock. */
export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface Job {
  graph: Graph;
  /** Input images by the name the graph's LoadImage nodes use. */
  inputs: Record<string, Uint8Array>;
  /** Output name -> the SaveImage node's id. */
  outputs: Record<string, string>;
}

export interface GeneratorInfo {
  comfyui: string;
  torch: string;
  device: string;
  vramTotal: number;
  /** The server's own count of free device memory, when it reports one. */
  vramFree?: number;
}

export interface Generator {
  /** PNG bytes per output name. */
  run(job: Job): Promise<Record<string, Uint8Array>>;
  info(): Promise<GeneratorInfo>;
  /** class_types the server knows (GET /object_info). */
  nodeTypes(): Promise<Set<string>>;
}
