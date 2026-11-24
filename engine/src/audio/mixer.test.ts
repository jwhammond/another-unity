// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { flush } from '../sim/settle';
import { DEFAULT_LEVELS, DEFAULT_MASTER, DUCK, Mixer } from './mixer';

class FakeParam {
  value = 1;
  setTargetAtTime(v: number): void {
    this.value = v;
  }
}
class FakeNode {
  /** What it was connected to. */
  to: FakeNode[] = [];
  connect<T extends FakeNode>(node: T): T {
    this.to.push(node);
    return node;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakePanner extends FakeNode {
  pan = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
    this.onended?.();
  }
}
class FakeContext {
  currentTime = 0;
  state = 'running';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  panners: FakePanner[] = [];
  createStereoPanner() {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(data: ArrayBuffer) {
    if (data.byteLength === 0) throw new Error('not audio');
    // (a file named mono is one channel, the rest two)
    return { duration: 1.5, numberOfChannels: data.byteLength === 1 ? 1 : 2 };
  }
  async resume() {
    this.state = 'running';
  }
}

function setup() {
  const ctx = new FakeContext();
  const fetched: string[] = [];
  const warnings: string[] = [];
  const mixer = new Mixer(ctx as unknown as AudioContext, async url => {
    fetched.push(url);
    return new ArrayBuffer(url.includes('bad') ? 0 : url.includes('mono') ? 1 : 8);
  }, m => warnings.push(m));
  return { ctx, mixer, fetched, warnings };
}

describe('Mixer', () => {
  it('loops from a loop point at a gain of its own, and ignores a loop point past the end', async () => {
    const { ctx, mixer } = setup();
    await mixer.setLoop('music', '/theme.ogg', { gain: 0.5, loopStart: 0.25 });
    const s = ctx.sources[0];
    expect([s.loop, s.loopStart, s.loopEnd]).toEqual([true, 0.25, 1.5]);
    expect(ctx.gains.at(-1)?.gain.value).toBe(0.5);
    await mixer.setLoop('ambience', '/hum.wav', { loopStart: 9 });
    expect([ctx.sources[1].loopStart, ctx.sources[1].loopEnd]).toEqual([0, 0]);
  });

  it('keeps a log of what started, loops marked, and none for what failed', async () => {
    const { mixer } = setup();
    await mixer.setLoop('music', '/theme.ogg');
    await mixer.play('/line.wav', 'voice');
    await mixer.play('/bad.wav', 'sfx');
    expect(mixer.started).toEqual([{ bus: 'music', url: '/theme.ogg', loop: true }, { bus: 'voice', url: '/line.wav', loop: false }]);
  });

  it('plays on a bus, and ducks the other buses while a voice speaks', async () => {
    const { ctx, mixer } = setup();
    const music = await mixer.play('/theme.ogg', 'music');
    expect(music?.duration).toBe(1.5);
    expect(ctx.sources[0].started).toBe(true);
    expect(mixer.level('music')).toBeCloseTo(1);
    const voice = await mixer.play('/line.wav', 'voice');
    expect(mixer.level('music')).toBeCloseTo(DUCK);
    expect(mixer.level('sfx')).toBeCloseTo(DUCK);
    expect(mixer.level('voice')).toBe(1);
    voice!.stop();
    await voice!.ended;
    await flush();
    expect(mixer.level('music')).toBeCloseTo(1);
  });

  it('plays nothing for a missing, broken or suspended sound, and fetches each file once', async () => {
    const { ctx, mixer, fetched, warnings } = setup();
    expect(await mixer.play(undefined, 'sfx')).toBeNull();
    expect(await mixer.play('/bad.wav', 'sfx')).toBeNull();
    expect(await mixer.play('/bad.wav', 'sfx')).toBeNull();
    expect(fetched).toEqual(['/bad.wav']);
    expect(warnings).toEqual(['could not play /bad.wav: not audio']);
    ctx.state = 'suspended';
    expect(await mixer.play('/ok.wav', 'sfx')).toBeNull();
  });

  it('keeps one loop a bus, and starts the loops a suspended context held back once resumed', async () => {
    const { ctx, mixer } = setup();
    ctx.state = 'suspended';
    await mixer.setLoop('ambience', '/hum.wav');
    expect(ctx.sources).toHaveLength(0);
    await mixer.resume();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].loop).toBe(true);
    await mixer.setLoop('ambience', '/hum.wav');
    expect(ctx.sources).toHaveLength(1);
    await mixer.setLoop('ambience', '/wind.wav');
    expect(ctx.sources[0].stopped).toBe(true);
    expect(ctx.sources).toHaveLength(2);
    await mixer.setLoop('ambience', undefined);
    expect(ctx.sources[1].stopped).toBe(true);
  });

  it('keeps ducking until every overlapping voice has ended', async () => {
    const { ctx, mixer } = setup();
    const a = await mixer.play('/a.wav', 'voice');
    const b = await mixer.play('/b.wav', 'voice');
    a!.stop();
    await a!.ended;
    await flush();
    expect(mixer.level('music')).toBeCloseTo(DUCK);
    b!.stop();
    await b!.ended;
    await flush();
    expect(mixer.level('music')).toBeCloseTo(1);
    expect(ctx.sources).toHaveLength(2);
  });

  it('does not duck for a voice that failed to start', async () => {
    const { ctx, mixer, warnings } = setup();
    ctx.createBufferSource = () => {
      const s = new FakeSource();
      s.start = () => {
        throw new Error('nope');
      };
      return s;
    };
    expect(await mixer.play('/line.wav', 'voice')).toBeNull();
    expect(mixer.level('music')).toBeCloseTo(1);
    expect(warnings).toEqual(['could not play /line.wav: nope']);
  });

  it('sets a bus level, which shows even under a duck', async () => {
    const { mixer } = setup();
    mixer.setLevel('music', 0.2);
    expect(mixer.level('music')).toBeCloseTo(0.2);
    await mixer.play('/line.wav', 'voice');
    expect(mixer.level('music')).toBeCloseTo(0.2 * DUCK);
  });

  it('release drops a cached buffer, so the next play decodes again', async () => {
    const { ctx, mixer, fetched } = setup();
    await mixer.play('/boom.wav', 'sfx');
    await mixer.play('/boom.wav', 'sfx');
    expect(fetched).toEqual(['/boom.wav']);
    // (both have ended)
    for (const source of ctx.sources) source.stop();
    await flush();
    mixer.release(['/boom.wav']);
    await mixer.play('/boom.wav', 'sfx');
    expect(fetched).toEqual(['/boom.wav', '/boom.wav']);
  });

  it('release keeps a buffer that is playing or still wanted', async () => {
    const { ctx, mixer, fetched } = setup();
    const playing = await mixer.play('/long.wav', 'sfx');
    await mixer.preload(['/cue.wav', '/gone.wav']);
    mixer.keep(['/cue.wav']);
    mixer.release(['/long.wav', '/cue.wav', '/gone.wav']);
    await mixer.preload(['/long.wav', '/cue.wav', '/gone.wav']);
    expect(fetched).toEqual(['/long.wav', '/cue.wav', '/gone.wav', '/gone.wav']);
    // (once it has ended, a release drops it)
    playing!.stop();
    await playing!.ended;
    await flush();
    mixer.release(['/long.wav']);
    await mixer.preload(['/long.wav']);
    expect(fetched.at(-1)).toBe('/long.wav');
    expect(fetched).toHaveLength(5);
    expect(ctx.sources).toHaveLength(1);
  });

  it('preloads files, and a fetcher that throws is a warning, not a crash', async () => {
    const warnings: string[] = [];
    const ctx = new FakeContext();
    const mixer = new Mixer(ctx as unknown as AudioContext, () => {
      throw new Error('offline');
    }, m => warnings.push(m));
    await mixer.preload(['/a.wav', '/b.wav']);
    expect(warnings).toEqual(['could not play /a.wav: offline', 'could not play /b.wav: offline']);
    const { mixer: ok, fetched } = setup();
    await ok.preload(['/a.wav', '/b.wav', '/a.wav']);
    expect(fetched).toEqual(['/a.wav', '/b.wav']);
  });

  it('resumes without rejecting, and starts held loops from an interrupted context', async () => {
    const { ctx, mixer, warnings } = setup();
    (ctx as { state: string }).state = 'interrupted';
    await mixer.setLoop('music', '/theme.ogg');
    expect(ctx.sources).toHaveLength(0);
    await mixer.resume();
    expect(ctx.sources).toHaveLength(1);
    const bad = setup();
    bad.ctx.state = 'suspended';
    bad.ctx.resume = async () => {
      throw new Error('blocked');
    };
    await expect(bad.mixer.resume()).resolves.toBeUndefined();
    expect(bad.warnings).toEqual(['could not resume audio: blocked']);
    expect(warnings).toEqual([]);
  });

  it('master scales every bus and survives a mute', () => {
    const { mixer } = setup();
    mixer.setMaster(0.5);
    expect(mixer.master).toBe(0.5);
    mixer.setMuted(true);
    expect(mixer.masterLevel).toBe(0);
    expect(mixer.master).toBe(0.5);
    mixer.setMuted(false);
    expect(mixer.masterLevel).toBe(0.5);
    expect(mixer.master).toBe(0.5);
    mixer.setMuted(true);
    mixer.setMaster(0.3);
    expect(mixer.masterLevel).toBe(0);
    mixer.setMuted(false);
    expect(mixer.masterLevel).toBe(0.3);
  });

  it("the default levels are ScummVM's balance", () => {
    const { mixer } = setup();
    for (const bus of ['voice', 'sfx', 'ambience', 'music'] as const) {
      expect(mixer.level(bus)).toBe(1);
      expect(DEFAULT_LEVELS[bus]).toBe(1);
    }
    expect(mixer.masterLevel).toBe(0.5);
    expect(DEFAULT_MASTER).toBe(0.5);
  });

  it('pauseLoops stops the loops and restarts the wanted ones', async () => {
    const { ctx, mixer } = setup();
    await mixer.setLoop('music', '/a.ogg');
    expect(ctx.sources).toHaveLength(1);
    mixer.pauseLoops(true);
    expect(ctx.sources[0].stopped).toBe(true);
    await mixer.setLoop('music', '/b.ogg');
    await mixer.setLoop('music', '/c.ogg');
    expect(ctx.sources).toHaveLength(1);
    mixer.pauseLoops(false);
    await flush();
    expect(ctx.sources).toHaveLength(2);
    expect(mixer.started.filter(s => s.loop).map(s => s.url)).toEqual(['/a.ogg', '/c.ogg']);
    // (an effect or a voice is left alone)
    const fx = await mixer.play('/fx.wav', 'sfx');
    mixer.pauseLoops(true);
    expect(ctx.sources[2].stopped).toBe(false);
    fx?.stop();
  });

  it('stops a loop that was still loading when the loops paused, and starts only the wanted one after', async () => {
    const ctx = new FakeContext();
    const pending = new Map<string, () => void>();
    const mixer = new Mixer(ctx as unknown as AudioContext, url => new Promise<ArrayBuffer>(resolve => pending.set(url, () => resolve(new ArrayBuffer(8)))));
    const first = mixer.setLoop('music', '/a.ogg');
    await flush();
    mixer.pauseLoops(true);
    await mixer.setLoop('music', '/b.ogg');
    pending.get('/a.ogg')?.();
    await first;
    await flush();
    expect(ctx.sources.every(s => s.stopped)).toBe(true);
    mixer.pauseLoops(false);
    await flush();
    pending.get('/b.ogg')?.();
    await flush();
    expect(ctx.sources.filter(s => !s.stopped)).toHaveLength(1);
    expect(mixer.started.filter(s => s.loop).map(s => s.url)).toEqual(['/a.ogg', '/b.ogg']);
  });

  it('starts no loop from a resume that the loops pausing overtook', async () => {
    const ctx = new FakeContext();
    const pending = new Map<string, () => void>();
    const mixer = new Mixer(ctx as unknown as AudioContext, url => new Promise<ArrayBuffer>(resolve => pending.set(url, () => resolve(new ArrayBuffer(8)))));
    ctx.state = 'suspended';
    await mixer.setLoop('music', '/m.ogg');
    await mixer.setLoop('ambience', '/h.ogg');
    const resumed = mixer.resume();
    await flush();
    mixer.pauseLoops(true);
    pending.get('/m.ogg')?.();
    await resumed;
    await flush();
    expect(pending.has('/h.ogg')).toBe(false);
    expect(ctx.sources.every(s => s.stopped)).toBe(true);
  });

  it('keeps the master between 0 and 1', () => {
    const { mixer } = setup();
    mixer.setMaster(2);
    expect(mixer.master).toBe(1);
    mixer.setMaster(-1);
    expect(mixer.master).toBe(0);
  });

  it('counts the sounds playing on a bus until they end, leaving loops out', async () => {
    const { mixer } = setup();
    const one = await mixer.play('a.wav', 'sfx');
    await mixer.play('b.wav', 'sfx');
    await mixer.play('c.wav', 'sfx', true);
    expect(mixer.playing('sfx')).toBe(2);
    one?.stop();
    await flush();
    expect(mixer.playing('sfx')).toBe(1);
    expect(mixer.playing('music')).toBe(0);
  });

  it('a pan adds a StereoPannerNode with that value', async () => {
    const { ctx, mixer } = setup();
    await mixer.play('a.wav', 'sfx', false, { gain: 0.5, pan: -0.4 });
    const [panner] = ctx.panners;
    expect(ctx.panners).toHaveLength(1);
    expect(panner!.pan.value).toBe(-0.4);
    // (source, panner, its gain, the bus: the gain kept as it was)
    const gain = ctx.sources[0]!.to[0]!.to[0] as FakeGain;
    expect([ctx.sources[0]!.to, gain.gain.value]).toEqual([[panner], 0.5]);
    // (a pan past either side is held at it)
    await mixer.play('b.wav', 'sfx', false, { pan: 3 });
    expect(ctx.panners[1]!.pan.value).toBe(1);
  });

  it('with no pan there is no panner', async () => {
    const { ctx, mixer } = setup();
    const bus = ctx.gains.length;
    await mixer.play('a.wav', 'sfx', false, { gain: 0.5 });
    await mixer.play('b.wav', 'sfx');
    expect(ctx.panners).toEqual([]);
    // (the source straight to its gain, at the gain asked, then the bus; at full volume straight to the bus)
    const gain = ctx.gains[bus]!;
    expect([ctx.sources[0]!.to, gain.gain.value, ctx.sources[1]!.to[0] instanceof FakePanner]).toEqual([[gain], 0.5, false]);
    expect(ctx.sources[1]!.to).toEqual([gain.to[0]]);
  });

  it('a panned mono sound gets √2 times its gain', async () => {
    const { ctx, mixer } = setup();
    const bus = ctx.gains.length;
    await mixer.play('boom.mono.wav', 'sfx', false, { gain: 0.5, pan: 0.3 });
    await mixer.play('hit.mono.wav', 'sfx', false, { pan: -0.6 });
    // (source, panner, a gain of √2 times the one asked (a gain made for it at full volume), the bus)
    const gains = ctx.gains.slice(bus);
    expect(gains.map(g => g.gain.value)).toEqual([0.5 * Math.SQRT2, Math.SQRT2]);
    expect([ctx.sources[0]!.to, ctx.panners[0]!.to, ctx.sources[1]!.to, ctx.panners[1]!.to]).toEqual([[ctx.panners[0]], [gains[0]], [ctx.panners[1]], [gains[1]]]);
  });

  it('a panned stereo sound, and an unpanned mono one, keep their gain', async () => {
    const { ctx, mixer } = setup();
    const bus = ctx.gains.length;
    await mixer.play('boom.wav', 'sfx', false, { gain: 0.5, pan: 0.3 });
    await mixer.play('hit.wav', 'sfx', false, { pan: -0.6 });
    await mixer.play('zap.mono.wav', 'sfx', false, { gain: 0.5 });
    await mixer.play('ping.mono.wav', 'sfx');
    expect(ctx.gains.slice(bus).map(g => g.gain.value)).toEqual([0.5, 0.5]);
    // (the stereo one at full volume, and the mono one at full volume, straight on: no gain of their own)
    expect([ctx.panners[1]!.to[0] === ctx.gains[bus]!.to[0], ctx.sources[3]!.to[0] === ctx.gains[bus]!.to[0], ctx.panners.length]).toEqual([true, true, 2]);
  });
});
