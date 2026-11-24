// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CombatCue } from '../content/types';
import { FakeChannels } from '../testing/sound';
import { CUE_CHANNELS, CUE_GAP, CuePlayer, SPEAKER_COMPUTER, SPEAKER_EFFECT, type CueSource } from './cues';

/**
 * Made-up cues: 0 and 1 speaker 4, 1 with a gap of 291 ticks (1000 ms); 2 the computer's; 3 an effect's (speaker 8);
 * 4 speaker 9, also an effect's file; 5 has no file; 6 and 7 speakers 1 and 2; 8 a file the game lacks; 9 a gap of -1 and
 * 10 a gap of 2 ticks (speakers 5 and 6); 11 an effect's file on speaker 10, which blocks nobody.
 */
const CUES: CombatCue[] = [
  { speaker: 4, file: 'a.vac', gap: 0 }, { speaker: 4, file: 'b.vac', gap: 291 }, { speaker: 7, file: 'c.vac', gap: 0 },
  { speaker: 8, file: 'd.mac', gap: 0 }, { speaker: 9, file: 'e.mac', gap: 0 }, { speaker: 0, file: null, gap: 0 },
  { speaker: 1, file: 'f.vac', gap: 0 }, { speaker: 2, file: 'g.vac', gap: 0 }, { speaker: 3, file: 'lacking.vac', gap: 0 },
  { speaker: 5, file: 'h.vac', gap: -1 }, { speaker: 6, file: 'i.vac', gap: 2 }, { speaker: 10, file: 'k.mac', gap: 0 },
];

function setup(o: { computer?: boolean } = {}) {
  const ch = new FakeChannels();
  const source: CueSource = {
    cues: () => CUES,
    url: file => (file.startsWith('lacking') ? undefined : `u:${file}`),
    computerOn: () => o.computer ?? true,
  };
  const cues = new CuePlayer(ch, source);
  /** What started, as [channel, file]. */
  const started = () => ch.log.map(([c, url]) => [c, url.slice(2)]);
  return { ch, cues, started };
}

describe('the crew\'s cues (CuePlayer, cues.cpp:31-150; Plan 28)', () => {
  it('has three channels, the gap 0x5af ticks, the computer speaker 7 and the effects from 8 (cues.h:33-37, cues.cpp:31)', () => {
    // (0x5af * 1000 / 291 = 1455000 / 291 = 5000)
    expect([CUE_CHANNELS, CUE_GAP, SPEAKER_COMPUTER, SPEAKER_EFFECT]).toEqual([3, 5000, 7, 8]);
  });

  it('plays a cue on the first free channel, a speaker under 8 on the voice bus and the rest on the effects\' (start, cues.cpp:90-100)', () => {
    const { ch, cues } = setup();
    expect(cues.play(0, 1000)).toBe(true);
    expect(cues.play(3, 1000)).toBe(true);
    expect(cues.play(4, 1000)).toBe(true);
    expect(ch.log).toEqual([[0, 'u:a.vac', 'voice', 255], [1, 'u:d.mac', 'sfx', 255], [2, 'u:e.mac', 'sfx', 255]]);
  });

  it('waits out a cue\'s gap, 5000 ms and its own ticks, before it plays it again (blocked, start: cues.cpp:57-58, 95)', () => {
    const { ch, cues, started } = setup();
    cues.play(1, 1000);
    ch.end(0);
    // (1000 + 5000 + 291 ticks' 1000 ms = 7000)
    expect([cues.play(1, 6999), cues.play(1, 7000)]).toEqual([false, true]);
    ch.end(0);
    // (cue 0 has no gap of its own: 5000)
    cues.play(0, 7000);
    ch.end(0);
    expect([cues.play(0, 11999), cues.play(0, 12000)]).toEqual([false, true]);
    expect(started()).toEqual([[0, 'b.vac'], [0, 'b.vac'], [0, 'a.vac'], [0, 'a.vac']]);
  });

  it('wraps the ticks\' product as the original\'s uint32 does, and truncates the milliseconds (ticksToMillis, cues.cpp:33-35)', () => {
    const { ch, cues } = setup();
    // (gap -1: (2^32 - 1) * 1000 mod 2^32 = 4294966296, / 291 = 14759334; at 1000 + 5000 + 14759334 = 14765334)
    cues.play(9, 1000);
    ch.end(0);
    expect([cues.play(9, 14765333), cues.play(9, 14765334)]).toEqual([false, true]);
    // (gap 2: 2000 / 291 = 6.87, truncated to 6; at 1000 + 5000 + 6 = 6006)
    cues.play(10, 1000);
    ch.end(1);
    expect([cues.play(10, 6005), cues.play(10, 6006)]).toEqual([false, true]);
  });

  it('holds an effect\'s cue to its gap too: the gap is checked before the speaker (blocked, cues.cpp:57-61)', () => {
    const { ch, cues } = setup();
    cues.play(3, 1000);
    ch.end(0);
    expect([cues.play(3, 5999), cues.play(3, 6000)]).toEqual([false, true]);
  });

  it('lets nobody say two things at once, and blocks a cue with no file, one past the table, and the computer\'s without its cores (blocked, cues.cpp:54-73)', () => {
    const { ch, cues } = setup({ computer: false });
    cues.play(0, 1000);
    // (speaker 4 speaks on channel 0: their other line waits; once it has ended, it plays)
    expect(cues.play(1, 1000)).toBe(false);
    ch.end(0);
    expect(cues.play(1, 1000)).toBe(true);
    expect([cues.play(5, 1000), cues.play(99, 1000), cues.play(2, 1000)]).toEqual([false, false, false]);
    expect(ch.log.map(([c, url]) => [c, url])).toEqual([[0, 'u:a.vac'], [0, 'u:b.vac']]);
    const on = setup();
    expect(on.cues.play(2, 1000)).toBe(true);
  });

  it('starts a cue the game lacks all the same: its gap is set, and nothing plays (start, cues.cpp:93-99; sound.cpp:170-172)', () => {
    const { ch, cues } = setup();
    cues.play(0, 1000);
    cues.play(6, 1000);
    cues.play(7, 1000);
    // (no channel free: the important cue takes channel 0, the first of the three started together, and plays nothing)
    expect(cues.play(8, 1000, true)).toBe(false);
    expect([ch.log.length, ch.cut, ch.playing(0)]).toEqual([3, [0], false]);
    // (its gap holds it 5000 ms though it never played: refill channel 0, and an important cue that isn't blocked would cut it)
    cues.play(11, 2000);
    expect(cues.play(8, 5999, true)).toBe(false);
    expect(ch.cut).toEqual([0]);
    cues.play(8, 6000, true);
    expect(ch.cut).toEqual([0, 0]);
  });

  it('drops a cue with no free channel unless it is important; an important one takes the newest channel without a chain (freeChannel, cues.cpp:75-88)', () => {
    const { ch, cues, started } = setup();
    cues.play(0, 1000);
    cues.play(6, 1100);
    cues.play(7, 1200);
    expect(cues.play(3, 1300)).toBe(false);
    // (channel 2 started last: the important cue cuts it short)
    expect(cues.play(3, 1300, true)).toBe(true);
    expect([ch.cut, started().at(-1)]).toEqual([[2], [2, 'd.mac']]);
    // (two started at the same time: the first of them is the newest, as the original's strict > leaves it)
    const tie = setup();
    tie.cues.play(0, 1000);
    tie.cues.play(6, 1000);
    tie.cues.play(7, 1000);
    tie.cues.play(3, 1000, true);
    expect(tie.ch.cut).toEqual([0]);
  });

  it('gives an important cue only a channel with no chain (freeChannel, cues.cpp:80-86)', () => {
    const { ch, cues, started } = setup();
    cues.play(0, 1000);
    cues.play(6, 1100);
    cues.play(7, 1200);
    // (chained to channel 2, the last: channel 1, started at 1100, is the newest with no chain)
    cues.playAfter(3, 1300);
    expect(cues.play(4, 1400, true)).toBe(true);
    expect([ch.cut, started().at(-1)]).toEqual([[1], [1, 'e.mac']]);
  });

  it('plays a cue after the last one: at once if that has ended, else chained to its channel, which is no longer free (playAfter, update: cues.cpp:119-141)', () => {
    const { ch, cues, started } = setup();
    // (nothing played yet: at once)
    cues.playAfter(0, 1000);
    expect(started()).toEqual([[0, 'a.vac']]);
    cues.playAfter(3, 1000);
    cues.update(1100);
    expect(started()).toHaveLength(1);
    // (channel 0's line ended: channel 0 isn't free while its chain waits, so the next cue goes to channel 1)
    ch.end(0);
    cues.play(6, 1150);
    expect(started().at(-1)).toEqual([1, 'f.vac']);
    // (the chain's cue starts on its own channel at the next update, and the cue after it chains there in turn)
    cues.update(1200);
    expect(started().at(-1)).toEqual([0, 'd.mac']);
    cues.playAfter(7, 1200);
    ch.end(0);
    cues.update(1300);
    expect(started().at(-1)).toEqual([0, 'g.vac']);
  });

  it('drops a chained cue that is blocked when its turn comes (update, cues.cpp:136-140)', () => {
    const { ch, cues, started } = setup();
    cues.play(0, 1000);
    cues.playAfter(1, 1000);
    ch.end(0);
    // (channel 0 has ended, its chain waiting for the next update; meanwhile speaker 4 speaks again, on channel 1)
    cues.play(0, 6000);
    cues.update(6100);
    // (cue 1 is speaker 4's too: blocked when its turn comes, so dropped, and channel 0 is free again)
    expect(started()).toEqual([[0, 'a.vac'], [1, 'a.vac']]);
    ch.end(1);
    cues.update(6200);
    expect(started()).toHaveLength(2);
    cues.play(6, 6200);
    expect(started().at(-1)).toEqual([0, 'f.vac']);
  });

  it('plays a later cue at its time, important ones taking a channel then (playLater, update: cues.cpp:111-117, 143-149)', () => {
    const { cues, started } = setup();
    cues.playLater(0, 498, 1000);
    cues.update(1497);
    expect(started()).toEqual([]);
    cues.update(1498);
    expect(started()).toEqual([[0, 'a.vac']]);
    cues.play(6, 1500);
    cues.play(7, 1500);
    cues.playLater(3, 100, 1500, true);
    cues.update(1600);
    // (no channel free: the newest is channel 1, started at 1500 as channel 2 was, and the first of the two)
    expect(started().at(-1)).toEqual([1, 'd.mac']);
  });

  it('stops only the cue channels on reset, not the effects\' (reset, cues.cpp:41-44)', () => {
    const { ch, cues } = setup();
    cues.play(0, 1000);
    ch.play(5, 'u:x', 'sfx');
    cues.reset();
    expect([ch.cut, ch.playing(5)]).toEqual([[0], true]);
  });

  it('falls silent once the Enterprise is lost but for speaker 8\'s cues, and runs no chain or later cue; reset speaks again (blocked, update, reset: cues.cpp:41-52, 60-63, 132-133)', () => {
    const { ch, cues, started } = setup();
    cues.play(0, 1000);
    cues.playAfter(6, 1000);
    cues.playLater(7, 100, 1000);
    cues.silenced = true;
    ch.end(0);
    cues.update(2000);
    expect(started()).toEqual([[0, 'a.vac']]);
    // (speaker 8 still plays; speaker 9, whose file is an effect's too, doesn't: the test is == kCueSpeakerEffect)
    expect([cues.play(3, 2000), cues.play(4, 2000), cues.play(1, 2000)]).toEqual([true, false, false]);
    // (reset stops the cue channels, and forgets the chains, the later cues, the gaps and the silence)
    cues.reset();
    expect([ch.cut, ch.playing(1), cues.silenced]).toEqual([[1], false, false]);
    cues.update(2100);
    expect(started()).toHaveLength(2);
    expect(cues.play(0, 2100)).toBe(true);
  });
});
