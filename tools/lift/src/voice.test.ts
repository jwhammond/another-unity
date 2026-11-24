// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { resolveVoice, speakerByte, voiceKey, VoiceIndex } from './voice';

describe('voice keys', () => {
  it('follows voiceFileFor, with @ for the speaker', () => {
    expect(voiceKey(0xfe, 0, 0xe7)).toBe('fe@00e7');
    expect(voiceKey(0x07, 1, 0x10, 't')).toBe('07t1@10');
    expect(voiceKey(0x07, 1, 0x10, 'l')).toBe('07l1@10');
    expect(voiceKey(0x07, 1, 0x10)).toBe('0701@10');
    expect(voiceKey(0xfe, 0xffff, 0xe7)).toBeUndefined();
    expect(voiceKey(0xffffffff, 0xffff, 0xffffffff)).toBeUndefined();
    expect(voiceKey(0xfe, 0x10002, 0xa7)).toBe('fe@02a7');
  });

  it('puts the speaker in: crew 0-9 have their own files, everyone else is ff', () => {
    expect([speakerByte(2), speakerByte(9), speakerByte(10), speakerByte(null)]).toEqual(['02', '09', 'ff', 'ff']);
    expect(resolveVoice('fe@00e7', '02')).toBe('fe0200e7');
  });
});

describe('VoiceIndex', () => {
  it('keeps the first text for each voice, sorted, with the speakers', () => {
    const v = new VoiceIndex();
    v.add('fe@00e7', 'What are these rocks?', 'w007c000#/responses/0');
    v.add('fe@00e7', 'Something else', 'o_070103');
    v.add('fe0000a7', 'A heap of stones.', 'o_070103');
    expect(v.keys()).toEqual(['fe0000a7', 'fe@00e7']);
    expect(v.file({ picard: '00' })).toEqual({
      speakers: { picard: '00' }, other: 'ff',
      lines: { fe0000a7: 'A heap of stones.', 'fe@00e7': 'What are these rocks?' },
    });
  });

  it('counts a voice as mapped if some speaker\'s file exists', () => {
    const v = new VoiceIndex();
    v.add('fe@00e7', 'a', 'w007c000');
    v.add('fe0000a7', 'b', 'o_070103');
    v.add('fe0200a8', 'c', 'o_070103');
    expect(v.check(new Set(['fe0200e7', 'fe0000a7']), ['00', '02'])).toEqual({ lines: 3, mapped: 2, missing: ['fe0200a8'] });
    expect(v.check(new Set(), ['00'], where => where.startsWith('w007'))).toEqual({ lines: 1, mapped: 0, missing: ['fe@00e7'] });
  });
});
