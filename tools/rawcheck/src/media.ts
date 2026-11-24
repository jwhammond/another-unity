// SPDX-License-Identifier: GPL-3.0-or-later
import { open } from 'node:fs/promises';

export interface WavInfo { channels: number; rate: number; frames: number }
export interface PngInfo { width: number; height: number }

/** A canonical 44-byte 16-bit PCM WAV header, checked against the file's size. */
export function wavInfo(head: Buffer, fileSize: number): WavInfo | string {
  if (head.length < 44 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE' ||
      head.toString('latin1', 12, 16) !== 'fmt ' || head.toString('latin1', 36, 40) !== 'data') {
    return 'not a canonical WAV';
  }
  if (head.readUInt16LE(20) !== 1) return 'not PCM';
  if (head.readUInt16LE(34) !== 16) return 'not 16-bit';
  const channels = head.readUInt16LE(22);
  const rate = head.readUInt32LE(24);
  const size = head.readUInt32LE(40);
  if (head.readUInt32LE(4) !== 36 + size || fileSize !== 44 + size) return 'sizes disagree';
  return { channels, rate, frames: size / (2 * channels) };
}

/** The size in a PNG's IHDR. */
export function pngInfo(head: Buffer): PngInfo | string {
  if (head.length < 24 || head.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || head.toString('latin1', 12, 16) !== 'IHDR') {
    return 'not a PNG';
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The first bytes of a file, and its size. */
export async function readHead(path: string, bytes: number): Promise<{ head: Buffer; size: number }> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(head, 0, bytes, 0);
    const { size } = await file.stat();
    return { head: head.subarray(0, bytesRead), size };
  } finally {
    await file.close();
  }
}
