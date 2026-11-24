// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One token of a synthetic tactics file. A `page` token carries `args[0]` (where it goes), a zero, and the name in 16 bytes, padded to 88 bytes
 * as the game's pages are: a first page puts the code at 0x6b. `text` follows the args as its length and its bytes, padded to 4, as
 * TacticScript::text reads a label or a message (tactics.cpp:127-133): its length is the arg after the last of `args`.
 */
export interface TacticTokenSpec { cls: number; opcode: number; args?: number[]; page?: string; text?: string }

const int = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A token's bytes after its 12-byte header. */
function body(t: TacticTokenSpec): number[] {
  if (t.page !== undefined) {
    const name = [...t.page.slice(0, 16)].map(c => c.charCodeAt(0));
    const out = [...int(t.args?.[0] ?? 0), ...int(0), ...name, ...new Array<number>(16 - name.length).fill(0)];
    while (out.length < 88) out.push(0);
    return out;
  }
  const out = (t.args ?? []).flatMap(int);
  if (t.text !== undefined) {
    out.push(...int(t.text.length), ...[...t.text].map(c => c.charCodeAt(0)));
    while (out.length % 4) out.push(0);
  }
  return out;
}

/** A synthetic tactics file: "TACTICS", then each token as class, opcode, length (int32 LE) and its bytes. */
export function makeTacticsBin(tokens: TacticTokenSpec[]): Uint8Array {
  const out: number[] = [...'TACTICS'].map(c => c.charCodeAt(0));
  for (const t of tokens) {
    const b = body(t);
    out.push(...int(t.cls), ...int(t.opcode), ...int(b.length), ...b);
  }
  return Uint8Array.from(out);
}

/** A float argument's bits, as TacticScript::floatArg reads them (tactics.cpp:114-119). */
export function floatBits(f: number): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, f, true);
  return v.getInt32(0, true);
}

/** An argument of an assembled token: a number, the offset of a label, or a float's bits. */
export type TacticArg = number | { label: string } | { float: number };
/** A token to assemble, or a label naming the offset of the token after it. */
export type TacticItem = (Omit<TacticTokenSpec, 'args'> & { args?: TacticArg[] }) | { label: string };

/**
 * A synthetic tactics file with labels: each `{ label }` names the offset of the token after it, and an argument
 * `{ label }` is that offset (a GOTO's page, a page token's own code). A label named twice throws. Returns the file and the labels' offsets.
 */
export function assembleTactics(items: TacticItem[]): { bin: Uint8Array; labels: Record<string, number> } {
  const labels: Record<string, number> = {};
  const resolve = (a: TacticArg, final: boolean): number => {
    if (typeof a === 'number') return a;
    if ('float' in a) return floatBits(a.float);
    if (final && labels[a.label] === undefined) throw new Error(`no label ${a.label}`);
    return labels[a.label] ?? 0;
  };
  const tokens = (final: boolean): TacticTokenSpec[] => {
    const out: TacticTokenSpec[] = [];
    let at = 7;
    const placed = new Set<string>();
    for (const item of items) {
      if (!('cls' in item)) {
        if (placed.has(item.label)) throw new Error(`duplicate label ${item.label}`);
        placed.add(item.label);
        labels[item.label] = at;
        continue;
      }
      const t: TacticTokenSpec = { ...item, args: (item.args ?? []).map(a => resolve(a, final)) };
      out.push(t);
      at += 12 + body(t).length;
    }
    return out;
  };
  // (the first pass places the labels, the second fills them in: a token's size doesn't depend on its args' values)
  tokens(false);
  return { bin: makeTacticsBin(tokens(true)), labels };
}
