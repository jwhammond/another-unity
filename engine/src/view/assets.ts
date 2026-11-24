// SPDX-License-Identifier: GPL-3.0-or-later
export type SoundBus = 'sfx' | 'music';

/** Audio files may be Opus (tools/media's voice and effects), Ogg (its music) or WAV (test fixtures). */
const AUDIO = ['opus', 'ogg', 'wav'];

/** A game's media, by path relative to the game's directory, with the URL each one is served from. */
export class AssetIndex {
  private readonly urls: Map<string, string>;

  constructor(entries: Iterable<[string, string]> = []) {
    this.urls = new Map(entries);
  }

  /** From a Vite glob, whose keys all start with `base` (the game's directory); `base` should end with '/', and one is added if missing. */
  static fromGlob(base: string, glob: Record<string, string>): AssetIndex {
    if (!base.endsWith('/')) base += '/';
    return new AssetIndex(Object.entries(glob).filter(([k]) => k.startsWith(base)).map(([k, url]) => [k.slice(base.length), url]));
  }

  url(path: string): string | undefined {
    return this.urls.get(path);
  }

  /** audio/voice/<stem> (Plan 4 Decision 9). */
  voice(stem: string): string | undefined {
    return this.first(AUDIO.map(ext => `audio/voice/${stem}.${ext}`));
  }

  /** A play.sound stem: sound effects first, then music, where stereo preset sounds go (Plan 4 Decision 20). */
  sound(stem: string): { url: string; bus: SoundBus } | undefined {
    const sfx = this.first(AUDIO.map(ext => `audio/sfx/${stem}.${ext}`));
    if (sfx) return { url: sfx, bus: 'sfx' };
    const music = this.first(AUDIO.map(ext => `audio/music/${stem}.${ext}`));
    return music ? { url: music, bus: 'music' } : undefined;
  }

  movie(stem: string): string | undefined {
    return this.urls.get(`movies/${stem}.webm`);
  }

  /** models/rooms/<world>/<sNN>.glb for screen <world>.<sNN> (Plan 4's greybox), or models/rooms/<screen>.glb. */
  room(screen: string): string | undefined {
    return this.urls.get(`models/rooms/${screen.split('.').join('/')}.glb`);
  }

  /** A space combat model by its combat.yaml url: space/<key>.glb (Plan 18's space build). */
  spaceModel(url: string): string | undefined {
    return this.urls.get(url);
  }

  private first(paths: string[]): string | undefined {
    for (const p of paths) {
      const url = this.urls.get(p);
      if (url !== undefined) return url;
    }
    return undefined;
  }
}
