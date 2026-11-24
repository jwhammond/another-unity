// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleLiftedText } from './textSample';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

/** A made-up game folder: lines of prose, short labels, ids, an override and a sealed copy. */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'textsample-'));
  made.push(dir);
  await mkdir(join(dir, 'conversations'), { recursive: true });
  await mkdir(join(dir, 'overrides'), { recursive: true });
  await mkdir(join(dir, '.sealed'), { recursive: true });
  await writeFile(join(dir, 'game.yaml'), [
    'title: Made Up Game',
    'start: room_with_a_very_long_identifier',
    'intro: "The kettle on the moon whistles a tune nobody knows."',
    'count: 12345678901234567890',
  ].join('\n'));
  await writeFile(join(dir, 'conversations', 'one.yaml'), [
    'lines:',
    '  - text: A purple teapot argues with the lighthouse keeper.',
    '  - text: Short line.',
    '  - nested: { say: "Seven paper boats sail across the breakfast table." }',
    '---',
    'second: The second document has a sentence of its own too.',
  ].join('\n'));
  await writeFile(join(dir, 'overrides', 'coords.yaml'), 'note: This override sentence must never be sampled at all.\n');
  await writeFile(join(dir, '.sealed', 'game.yaml'), 'note: This sealed sentence must never be sampled either.\n');
  await writeFile(join(dir, 'gate.yaml'), 'salt: an example gate value with spaces in it\n');
  await writeFile(join(dir, 'notes.txt'), 'A text file that is not yaml is never read here.\n');
  await writeFile(join(dir, 'broken.yaml'), 'a: [unclosed\n  b: "nope\n');
  return dir;
}

describe('sampleLiftedText', () => {
  it('sampleLiftedText picks long strings only, skips overrides', async () => {
    const dir = await fixture();
    const all = sampleLiftedText(dir).sort();
    expect(all).toEqual([
      'A purple teapot argues with the lighthouse keeper.',
      'Seven paper boats sail across the breakfast table.',
      'The kettle on the moon whistles a tune nobody knows.',
      'The second document has a sentence of its own too.',
    ]);
  });

  it('takes `count` of them, chosen by `random`, and honours `minLength`', async () => {
    const dir = await fixture();
    const two = sampleLiftedText(dir, { count: 2, random: () => 0 });
    expect(two).toHaveLength(2);
    expect(new Set(two).size).toBe(2);
    expect(sampleLiftedText(dir, { count: 2, random: () => 0 })).toEqual(two);
    expect(sampleLiftedText(dir, { minLength: 51 }).sort()).toEqual(['The kettle on the moon whistles a tune nobody knows.']);
  });

  it('leaves out the name-shaped values held directly under `skipKeys`, unless they also appear elsewhere', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'objects.yaml'), [
      'things:',
      '  - name: The Lighthouse Keeper',
      '    text: A purple teapot argues with the lighthouse keeper.',
      '  - name: Seven paper boats sail across the breakfast table.',
      '    heading: { name: The Nested Map Name }',
      '  - name: Four words, a question?',
      '  - title: A title of more than four words is prose',
      '  - name: Just Four Words Here',
    ].join('\n'));
    const all = sampleLiftedText(dir, { skipKeys: ['name', 'heading'] }).sort();
    expect(all).toContain('A purple teapot argues with the lighthouse keeper.');
    expect(all).toContain('Seven paper boats sail across the breakfast table.');
    expect(all).not.toContain('The Lighthouse Keeper');
    expect(all).not.toContain('The Nested Map Name');
    expect(sampleLiftedText(dir)).toContain('The Lighthouse Keeper');
    const titles = sampleLiftedText(dir, { skipKeys: ['name', 'title'] });
    expect(titles).toContain('Four words, a question?');
    expect(titles).toContain('A title of more than four words is prose');
    expect(titles).not.toContain('Just Four Words Here');
  });
});
