// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SHIP_CLICKS, SHIP_CUES } from '@another-unity/engine';
import { ENGINE_SOUNDS, liftMovies, presentationFor, SHIP_MUSIC, SHIP_SOUNDS, WORLD_PRESENTATION } from './presentation';
import { Problems } from './problems';

const none = { formatString: '', first: 0, last: 0 };

describe('presentationFor', () => {
  it('gives each lifted world its loop, arrival movie and beam-down pieces, and nothing to the others', () => {
    const defaults = [...Array.from({ length: 6 }, () => none), { formatString: 'h3int%02d.rac', first: 1, last: 2 }];
    expect(presentationFor([7, 0x12], defaults)).toEqual({
      music: { horst3: 'h3amb01' },
      ambience: {},
      intro: { horst3: ['h3int01', 'h3int02'] },
      arrival: { horst3: 'ho3arriv' },
      sounds: { combadge: 'combadge', tricorderChirp: 'tricordr', phaserCrew: 'hphaser', phaserOther: 'c_phaser', beamIn: 'beamin', beamOut: 'beamout', beamChodak: 'acid' },
      shipSounds: expect.objectContaining({ holodeckDoor: 'holodoor', holodeckPick: 'baknwlgd', computerOffline: 'fe090098', shipBeep: 'beep7', transporterConfirm: 'trnscnfm', transporterScan: 'scann', transporterNoTarget: 'fe0900b0', transporterLocked: 'fe0900b3', adminOpen: 'rgcd', adminLevel: 'beep14' }),
      shipMusic: { bridge: 'bridgamb', transporter: 'bridgamb', astrogation: 'astro', computer: 'compute', tactical: 'enterpri', engineering: 'engamb' },
      loops: expect.objectContaining({ h3amb01: { gain: 0.184, loopStart: 4.118 } }),
      musicWhenInactive: {},
    });
    expect(WORLD_PRESENTATION.horst3.source).toContain('sound.cpp:379-381');
  });

  it('cites where the original hard-codes each of the engine\'s own sounds', () => {
    expect(ENGINE_SOUNDS.combadge.source).toContain('awayteam.cpp:824-825');
    expect(ENGINE_SOUNDS.tricorderChirp.source).toContain('object.cpp:1277-1279');
    expect(ENGINE_SOUNDS.phaserCrew.source).toContain('awayteam.cpp:1178');
    expect(ENGINE_SOUNDS.phaserOther.source).toContain('awayteam.cpp:1183');
    for (const beam of ['beamIn', 'beamOut', 'beamChodak'] as const) expect(ENGINE_SOUNDS[beam].source).toContain('awayteam.cpp:1106');
    expect(presentationFor([], []).sounds).toEqual({ combadge: 'combadge', tricorderChirp: 'tricordr', phaserCrew: 'hphaser', phaserOther: 'c_phaser', beamIn: 'beamin', beamOut: 'beamout', beamChodak: 'acid' });
  });

  it('skips a world whose beam-down entry is empty or missing', () => {
    expect(presentationFor([7], [none, none, none, none, none, none, none]).intro).toEqual({});
    expect(presentationFor([7], []).intro).toEqual({});
  });

  it('gives screens with a loop of their own that loop, and lab s06 its other loop while the probe is gone (updateMusic)', () => {
    const p = presentationFor([4], [], {
      screens: new Set(['s_0401', 's_0402', 's_0406', 's_040a']),
      objectSlug: id => (id === '040603' ? 'lab.thing' : undefined),
    });
    expect(p.music).toEqual({ lab: 'lbctrfar', 'lab.s02': 'lbbigfar', 'lab.s06': 'probroom', 'lab.s0a': 'lbctnear' });
    expect(p.musicWhenInactive).toEqual({ 'lab.s06': { object: 'lab.thing', music: 'lbbignr' } });
    // (0x5a00 bytes at 22050 stereo frames a second; volume 0x3f of 255)
    expect(p.loops.probroom).toEqual({ gain: 0.247, loopStart: 1.045 });
    expect(p.arrival).toEqual({ lab: 'labarriv' });
  });

  it('has a row for every away world, each citing updateMusic, with a default loop and an arrival movie', () => {
    for (const slug of ['allanor', 'zoo', 'lab', 'frigis', 'unity', 'horst3']) {
      const row = WORLD_PRESENTATION[slug];
      expect(row.source).toMatch(/sound\.cpp:\d+-\d+/);
      expect(row.music.stem).toMatch(/^[a-z0-9]+$/);
      expect(row.arrival).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('liftMovies', () => {
  const map = [{ id: 0, filename: 'Teaser.fvf', description: 'T one' }, { id: 4, filename: 'title.fvf', description: 'T two' }, { id: 21, filename: 'warpout1.fvf', description: 'W one' }];
  const movieMap = [{ stem: 'teaser', title: 'T one' }, { stem: 'title', title: 'T two' }, { stem: 'warpout1', title: 'W one' }];

  it('lifts the opening in order, and the warp movies by name, from index 1', () => {
    const problems = new Problems();
    expect(liftMovies(map, ['-Zap-', 'WARPOUT1.fvf', 'warpout9.fvf'], problems)).toEqual({ opening: ['teaser', 'title'], warpMovies: [null, 'warpout1', null], movieMap });
    // (index 0 is no movie, so it is silent; a name the map lacks warns)
    expect(problems.warnings).toHaveLength(1);
    expect(problems.warnings[0]).toMatch(/_warpMovies\[2\].*warpout9/);
  });

  it('leaves the opening out, with a warning, when the map lacks the teaser or the title', () => {
    const problems = new Problems();
    expect(liftMovies(map.slice(1), [], problems)).toEqual({ warpMovies: [], movieMap: movieMap.slice(1) });
    expect(problems.warnings).toHaveLength(1);
    expect(problems.warnings[0]).toMatch(/no movie 0/);
  });
});

describe('liftMovies: the holodeck\'s list', () => {
  it('keeps movie.map\'s order and descriptions, and names a film with no description by its stem', () => {
    const out = liftMovies([{ id: 3, filename: 'shiptour.fvf', description: 'Orientation' }, { id: 0, filename: 'teaser.fvf' }], [], new Problems());
    expect(out.movieMap).toEqual([{ stem: 'shiptour', title: 'Orientation' }, { stem: 'teaser', title: 'teaser' }]);
  });
});

describe('SHIP_SOUNDS', () => {
  it('names a file for every cue the ship\'s sim sends, and cites where the original plays it', () => {
    for (const cue of [...SHIP_CUES, ...SHIP_CLICKS]) {
      expect(SHIP_SOUNDS[cue], cue).toBeDefined();
      expect(SHIP_SOUNDS[cue]!.stem).toMatch(/^[a-z0-9_]+$/);
      expect(SHIP_SOUNDS[cue]!.source).toMatch(/\.cpp:\d+/);
    }
    expect(presentationFor([], []).shipSounds.holodeckDoor).toBe('holodoor');
  });
});

describe('SHIP_MUSIC', () => {
  it('gives each station the loop its start plays, with playMusic\'s volume and loop point (the astrogation\'s louder, the computer\'s late)', () => {
    const p = presentationFor([], []);
    expect(p.loops.bridgamb).toEqual({ gain: 0.247, loopStart: 0 });
    expect(p.loops.astro).toEqual({ gain: 0.373, loopStart: 5.03 });
    expect(p.loops.compute).toEqual({ gain: 0.247, loopStart: 4.728 });
    expect(Object.keys(p.shipMusic).sort()).toEqual(['astrogation', 'bridge', 'computer', 'engineering', 'tactical', 'transporter']);
    for (const [station, l] of Object.entries(SHIP_MUSIC)) expect(l.source, station).toMatch(/\.cpp:\d+/);
  });
});
