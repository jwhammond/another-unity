// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

export const ObjectId = z.string().regex(/^[0-9a-f]{6}$/);
export const ConversationId = z.string().regex(/^w[0-9a-f]{3}c\d{3}$/);
export const ScreenId = z.string().regex(/^s_[0-9a-f]{4}$/);
export const WorldId = z.string().regex(/^w_[0-9a-f]{2}$/);

/** manifest.json: what the export found in the archive, and every file it wrote. */
export const Manifest = z
  .object({
    format: z.literal('another-unity/raw-ir'),
    version: z.literal(1),
    generator: z.string(),
    objects: z.array(ObjectId),
    conversations: z.array(ConversationId),
    screens: z.array(ScreenId),
    worlds: z.array(WorldId),
    files: z.array(z.string()),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

/** zod's issues as "path: message" lines. */
export function zodProblems(result: z.SafeParseReturnType<unknown, unknown>): string[] {
  if (result.success) return [];
  return result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function sortedUnique(list: string[]): boolean {
  return list.every((value, i) => i === 0 || list[i - 1] < value);
}

export function checkManifest(value: unknown): string[] {
  const result = Manifest.safeParse(value);
  if (!result.success) return zodProblems(result);
  const problems: string[] = [];
  for (const key of ['objects', 'conversations', 'screens', 'worlds', 'files'] as const) {
    if (!sortedUnique(result.data[key])) problems.push(`${key}: not sorted and unique`);
  }
  return problems;
}
