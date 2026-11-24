// SPDX-License-Identifier: GPL-3.0-or-later
/** Stands for the speaker's byte in a voice key; the presenter puts it in (voices.yaml's speakers). */
export const SPEAKER = '@';

const h2 = (n: number) => n.toString(16).padStart(2, '0');

/** voiceFileFor (unity.cpp:1172-1187), without the speaker and the .vac. */
export function voiceKey(group: number, subgroup32: number, id: number, type?: 'l' | 't'): string | undefined {
  // (voiceFileFor takes a uint16 subgroup; descriptions store 32 bits)
  const subgroup = subgroup32 & 0xffff;
  if (id === 0xffffffff || subgroup === 0xffff) return undefined;
  if (group === 0xfe) return `fe${SPEAKER}${h2(subgroup)}${h2(id)}`;
  if (type) return `${h2(group)}${type}${subgroup.toString(16)}${SPEAKER}${h2(id)}`;
  return `${h2(group)}${h2(subgroup)}${SPEAKER}${h2(id)}`;
}

/** Only the main crew (0-9) have their own voice files; anyone else is 0xff. */
export function speakerByte(crew: number | null): string {
  return crew !== null && crew >= 0 && crew <= 9 ? h2(crew) : 'ff';
}

export function resolveVoice(key: string, byte: string): string {
  return key.replace(SPEAKER, byte);
}

export interface VoicesFile {
  /** Each crew member's byte. */
  speakers: Record<string, string>;
  other: 'ff';
  /** Each voice key's transcript. */
  lines: Record<string, string>;
}

export class VoiceIndex {
  private readonly lines = new Map<string, { text: string; where: string[] }>();

  add(key: string, text: string, where: string): void {
    const line = this.lines.get(key);
    if (line) line.where.push(where);
    else this.lines.set(key, { text, where: [where] });
  }

  keys(): string[] {
    return [...this.lines.keys()].sort();
  }

  file(speakers: Record<string, string>): VoicesFile {
    return { speakers, other: 'ff', lines: Object.fromEntries(this.keys().map(k => [k, this.lines.get(k)?.text ?? ''])) };
  }

  /** How many voices (used where `only` says) have a file among `available` (lowercase stems) for some speaker. */
  check(available: ReadonlySet<string>, bytes: string[], only: (where: string) => boolean = () => true) {
    let lines = 0;
    let mapped = 0;
    const missing: string[] = [];
    for (const key of this.keys()) {
      if (!this.lines.get(key)?.where.some(only)) continue;
      lines++;
      const files = key.includes(SPEAKER) ? [...bytes, 'ff'].map(b => resolveVoice(key, b)) : [key];
      if (files.some(f => available.has(f))) mapped++;
      else missing.push(key);
    }
    return { lines, mapped, missing };
  }
}
