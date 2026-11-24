// SPDX-License-Identifier: GPL-3.0-or-later
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const voicesSchema = z.object({
  speakers: z.record(z.string()).default({}),
  other: z.string().default('ff'),
  lines: z.record(z.string()).default({}),
});

/** voices.yaml (Plan 4 Decision 9): each crew member's byte, the byte for anyone else, and the transcripts. */
export type VoicesFile = z.infer<typeof voicesSchema>;

export class VoiceTable {
  constructor(private readonly file: VoicesFile = { speakers: {}, other: 'ff', lines: {} }) {}

  static parse(text: string | undefined): VoiceTable {
    return text === undefined ? new VoiceTable() : new VoiceTable(voicesSchema.parse(parseYaml(text) ?? {}));
  }

  /** The file stem for `voice` said by `speaker`: '@' stands for the speaker's byte (voiceFileFor, unity.cpp:1172-1187). */
  resolve(voice: string, speaker: string): string {
    return voice.includes('@') ? voice.split('@').join(this.file.speakers[speaker] ?? this.file.other) : voice;
  }
}
