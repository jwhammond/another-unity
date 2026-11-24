// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { liftObject } from './objects';
import { miniRaw, obj, type J } from './testing/mini';
import { rawFromMini, testCtx } from './testing/ctx';

describe('liftObject', () => {
  it('lifts a world object in full, with its marker, descriptions, phaser data and rules', () => {
    const ctx = testCtx();
    const { def, hotspot } = liftObject(ctx.raw.objects.get('070103')!, ctx, true);
    const width = ctx.markers.projection('horst3.s01')!.distance(70, 336);
    expect(def).toMatchObject({
      id: 'horst3.rubble', name: 'rubble', screen: 'horst3.s01', at: 'horst3.rubble', width, pixelWidth: 70,
      descriptions: {
        picard: { text: 'A heap of grey stones.', voice: 'fe00025c' },
        data: { text: 'Igneous rock.', voice: 'fe0202a8' },
      },
      phaser: {
        health: 2, threshold: 2, damageFrom: 1, gtpFrom: 1,
        on: { stun: [{ do: [{ react: { who: 'actor', do: 'stun', shot: true } }] }] },
      },
      on: { look: [{ when: { other: '$none' }, do: [{ alter: { object: 'horst3.rubble', describe: true } }] }] },
    });
    expect(def.phaser?.gtpUpTo).toBeUndefined();
    expect(def.on?.use).toHaveLength(2);
    expect(Object.keys(def.on ?? {})).toEqual(['use', 'look']);
    expect(ctx.markers.screenMarkers('horst3.s01')['horst3.rubble']).toBeDefined();
    expect(hotspot).toEqual({ object: 'horst3.rubble', screen: 'horst3.s01', x: 208, y: 336, width: 70, height: 70, flags: 0x32, objwalktype: 0, spriteId: 65535, yAdjust: -1 });
    expect(ctx.ids.toYaml().lists).toMatchObject({
      'o_070103#/use_entries': 'horst3.rubble/use', 'o_070103#/phaser_data/stun_entries': 'horst3.rubble/phaser/stun',
    });
  });

  it('lifts a position in space, and none for the unset 0xffff or -1', () => {
    const ctx = testCtx();
    expect(liftObject(ctx.raw.objects.get('5f0100')!, ctx, true).def.universe).toEqual({ x: 90, y: 90, z: 90 });
    expect(liftObject(ctx.raw.objects.get('5f0104')!, ctx, true).def.universe).toEqual({ x: 10, y: 20, z: 30 });
    expect(liftObject(ctx.raw.objects.get('070103')!, ctx, true).def).not.toHaveProperty('universe');
    const open = rawFromMini(miniRaw(files => {
      files['objects/o_5f0102.json'] = obj('5f0102', { name: 'Beacon', universe_x: 0xffff, universe_y: 0xffff, universe_z: 0xffff });
    }));
    expect(liftObject(open.objects.get('5f0102')!, testCtx(open), true).def).not.toHaveProperty('universe');
  });

  it('lifts crew with no screen, and an item in the inventory', () => {
    const ctx = testCtx();
    expect(liftObject(ctx.raw.objects.get('000000')!, ctx, true).def).toEqual({
      id: 'picard', name: 'Picard', screen: null, crew: true, skills: 0x5444, talk: '!',
      descriptions: { picard: { text: 'The captain stands ready.', voice: 'fe00043d' } },
      phaser: { health: 10, threshold: 2, damageFrom: 1, gtpFrom: 4 },
    });
    expect(liftObject(ctx.raw.objects.get('007001')!, ctx, true)).toEqual({
      def: { id: 'tricorder', name: 'tricorder', screen: null, inventory: true },
    });
    // (the communicator isn't start equipment: the combadge uses it)
    expect(liftObject(ctx.raw.objects.get('007002')!, ctx, true).def.inventory).toBeUndefined();
  });

  it('puts an object of an unlocated screen nowhere, like crew, keeping only its raw width', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      files['objects/o_070301.json'] = obj('070301', { name: 'advisor', x: 100, y: 200, width: 20 });
    })));
    expect(liftObject(ctx.raw.objects.get('070301')!, ctx, true)).toEqual({ def: { id: 'horst3.advisor', name: 'advisor', screen: null, pixelWidth: 20 } });
  });

  it('lifts a crew member\'s raw width, which has no screen to convert it at (the TALK walk-up, unity.cpp:2028)', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['objects/o_000001.json'] as J).width = 60;
    })));
    const { def } = liftObject(ctx.raw.objects.get('000001')!, ctx, true);
    expect(def.pixelWidth).toBe(60);
    expect(def.width).toBeUndefined();
  });

  it('lifts talk with its voice, a timer and a "gtp up to" setting', () => {
    const ctx = testCtx();
    const { def } = liftObject(ctx.raw.objects.get('070201')!, ctx, true);
    expect(def).toMatchObject({
      id: 'horst3.guard', screen: 'horst3.s02', at: 'horst3.guard', timer: 10, talk: 'Halt!', talkVoice: '07t1@10',
      width: ctx.markers.projection('horst3.s02')!.distance(30, 350), pixelWidth: 30,
      phaser: { health: 5, threshold: 1, damageFrom: 2, gtpFrom: 3, gtpUpTo: 1 },
    });
    expect(Object.keys(def.on ?? {})).toEqual(['use', 'timer']);
  });

  it('lifts a stub with nothing that names anything else', () => {
    const ctx = testCtx();
    const { def } = liftObject(ctx.raw.objects.get('070201')!, ctx, false);
    expect(def).toEqual({
      id: 'horst3.guard', name: 'guard', screen: 'horst3.s02', at: 'horst3.guard',
      width: ctx.markers.projection('horst3.s02')!.distance(30, 350), pixelWidth: 30,
    });
    expect(ctx.ids.need.conversations.size).toBe(0);
  });

  it('flags an action square (objwalktype 3), and no other kind', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['objects/o_070201.json'] as J).objwalktype = 3;
    })));
    expect(liftObject(ctx.raw.objects.get('070201')!, ctx, true).def.actionSquare).toBe(1);
    const plain = testCtx();
    expect(liftObject(plain.raw.objects.get('070201')!, plain, true).def.actionSquare).toBeUndefined();
    expect(liftObject(plain.raw.objects.get('070104')!, plain, true).def.actionSquare).toBeUndefined();
  });

  it('fails on an object that starts stunned', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['objects/o_070201.json'] as J).flags = 0xb4;
    })));
    liftObject(ctx.raw.objects.get('070201')!, ctx, true);
    expect(ctx.problems.errors).toEqual(["o_070201: starts stunned (flag 0x80), which the content model can't express"]);
  });

  it('drops a transition to an object, or a talk string to a conversation, that the export lacks (M3 Decision 3)', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      Object.assign(files['objects/o_070104.json'] as J, { transition: '070199', talk_string: '@9,1' });
    })));
    const { def } = liftObject(ctx.raw.objects.get('070104')!, ctx, true);
    expect(def.transition).toBeUndefined();
    expect(def.talk).toBeUndefined();
    expect(ctx.problems.errors).toEqual([]);
    // (the door's own rules warn too: its entrance 1 is beyond s_0702's one)
    expect(ctx.problems.warnings).toEqual(expect.arrayContaining([
      'o_070104: no object 070199 in the export: the original would fail following it (unity.cpp:1970), so the transition is dropped',
      'o_070104#/talk_string: no conversation w007c009 in the export: the original would fail opening it (conversation.cpp:246-263), so the talk string is dropped',
    ]));
  });
});
