// SPDX-License-Identifier: GPL-3.0-or-later
import { drawArtLayer, drawConsoleShot, FrameSampler, startGaveUp, textureLedger, type BattleAssetState, type CombatViewState, type PerfReport, type Session } from '@another-unity/engine/web';
import type { combatSim } from '@another-unity/engine';
import type { WebGLRenderer } from 'three';

export interface DebugHandle {
  ready: boolean;
  state(): Session['world']['state'];
  /** Nothing running, nothing said, no dialog: the next click will act (unless a timer fires first). Aboard the ship, the next station change. */
  idle(): boolean;
  /** The timed battle's report (`?dev&perf=<scenario>`, Plan 31 R4): null until the run is done. */
  perf(): PerfReport | null;
  /**
   * Skips the spoken line being said, as a click or Space does, and only if no conversation menu is up (a keypress would
   * land on the menu's focused first button). One call in the page, so no menu can mount between the check and the skip.
   * Returns whether a line was skipped.
   */
  skipLine(): boolean;
  /** How many actions the input has started (Input.started): a test checks its click took. */
  started(): number;
  /** The transcript's lines, oldest first: subtitles at 4× can come and go between two checks. */
  heard(): string[];
  /** The time the room's animations play on, in ms (`Stage.animationTime`): a test that times one reads this, not the wall clock, which a loaded machine's slow frames outrun. */
  animationTime(): number;
  /** The presentation clock's speed: a test checks `?speed=` reached it. */
  speed(): number;
  /** Sets the game's speed from now on: a test runs the long opening fast and then slows down to watch an effect. */
  setSpeed(speed: number): void;
  /** Where an object is on the page, in client pixels, so a test clicks it through real picking. */
  point(id: string): { x: number; y: number } | null;
  /** Where a star (or, in the system view, a planet or moon of it) is on the astrogation map now, in client pixels: the point a click picks it at (null away from astrogation, or where it is not on the map). */
  astroPoint(sector: number, star: number, planet?: number, moon?: number): { x: number; y: number } | null;
  /** The astrogation map's camera as it is now: whether it is turning by itself, and where it points (degrees). A test waits for it to be still before it picks a star. */
  astro(): { spinning: boolean; azimuth: number; elevation: number; view: string };
  /** What a click at this client point would pick: an object's id, or null for the floor or nothing. */
  objectAt(x: number, y: number): string | null;
  /** What the current room shows: its plate and model (R10). */
  art(): ReturnType<Session['stage']['artState']> & { ship: { station: string | null; set: boolean; /** A plate, a 3D set, or (at tactical) the battle's space view. */ kind: 'plate' | 'set' | 'space' | null; viewscreen: string | null; /** The transporter room's beam: the pads' cards dissolving (level 0 to 6) and the sparkles drawn. */ beam: { cards: { key: string; level: number }[]; sparkles: string[] } } };
  /** Draws a frame and reads it back: how much of it isn't the background. */
  coverage(): { width: number; height: number; nonBackground: number };
  /** The texture memory the page holds by the sizes tracked, and the renderer's own counts (the report of `?dev`'s console line). */
  memory(): { textures: number; bytes: number; gpuBytes: number; rendererTextures: number; pixelRatio: number; plates: string[]; biggest: string[]; consoleArt: number };
  /** Puts a line on the screen as the presenter does (the subtitle and the log), with no sim behind it: for looking at a speaker the room doesn't have. */
  say(who: string, name: string, text: string): void;
  /** Hails a ship object as the comms list does, aboard the ship, making it active first: for looking at a caller on the viewscreen. */
  hail(object: string): void;
  /** What the mixer has started, oldest first (a loop has `loop`): a test checks the music and the voices that played. */
  sounds(): { bus: string; url: string; loop: boolean }[];
  /**
   * The battle's sound (Plan 28): which of Sound's eight channels play (0-2 the crew's cues, 3-7 the effects), and whether
   * the crew is silenced; null without Web Audio.
   */
  battleSound(): { channels: boolean[]; silenced: boolean } | null;
  /** Marks a star of a sector charted, visited and scanned, with no sim behind it: for looking at a star system's planets on the astrogation map. */
  astroKnow(sector: number, star: number): void;
  /** The crew walking on or off the transporter's pads now: where their feet are in the room's 640x480 pixels, their size (256 is full), the animation they play, and whether they have set off. */
  padWalks(): { pad: number; leaving: boolean; at: [number, number]; scale: number; anim: number; visible: boolean }[];
  /**
   * Sets where the transporter will send the team, as ScummVM's `beam <world>` console command does: a mission's world number (1-8), with no sim behind
   * it. It takes effect when the room next opens: for looking at the room's map and the team it recommends.
   */
  beam(world: number): void;
  /** Puts an object in the away team's inventory, with no sim behind it: for looking at a fuller inventory (the panel's paging). */
  give(object: string): void;
  /**
   * Sets the battle tactical fights next (UnityEngine::_battleScenario), as the harness's `ship 7 <battle>` does before
   * it goes there, with no sim behind it: for fighting a chosen battle in the game (Plan 23).
   */
  battleScenario(scenario: number): void;
  /** The battle's models, sprites and stills now (M8 spec §8): null when no battle's set is loaded or loading. */
  combatAssets(): BattleAssetState | null;
  /**
   * Loads battle `scenario`'s set as a battle's start would (every ship combat.yaml gives it), waits until it is ready, and
   * says what it holds and what the texture ledger held then; `free` frees it at once and says what the ledger holds after.
   */
  loadCombatAssets(scenario: number, free?: boolean): Promise<{ set: BattleAssetState | null; during: number; after: number; loadMs: number; freeMs: number }>;
  /** The space view now (M8 spec §3): its chunk, whether it draws, its window and viewport, and the ships it drew. */
  combatView(): CombatViewState;
  /** The parity mode (M8 spec §9.3): no interpolation, no shimmer. */
  combatParity(on: boolean): void;
  /**
   * Sets up battle `scenario` apart from the world (every ship it lists), runs `steps` steps after `commands` (a view,
   * wide), loads its set and draws it on the whole canvas until `endPreview`, when the frame draws no ship set or map (away
   * from the ship, or with art off). `battle` false: no Enterprise (setup's failure), or the world was replaced meanwhile.
   * `tick`: the world tick it is taken to start at, for a run that doesn't depend on when it is called.
   */
  previewBattle(scenario: number, o?: { seed?: number; steps?: number; commands?: combatSim.CombatCommand[]; tick?: number }): Promise<{ battle: boolean; warnings: string[] }>;
  /** Draws a battle's state from elsewhere (tracediff's replay at a shot's step) as the preview, as previewBattle does. */
  previewState(b: combatSim.BattleState): Promise<void>;
  endPreview(): void;
  /**
   * Draws a frame and reads the space view back: the renderer's draw calls and triangles for the view's scene, and for
   * each ship drawn, how many pixels of the square within half its radius of its centre are not the background.
   */
  combatFrame(): {
    calls: number; triangles: number;
    ships: { index: number; model: string; flat: boolean; r: number; lit: number; of: number }[];
    effects: { kind: string; model: string; r: number; lit: number; of: number }[];
  };
  /** Runs the preview's battle on `steps` steps (previewBattle's: not previewState's, which has no context to step with). */
  stepPreview(steps: number): void;
  /** The world's battle shows the warp overlay, as warpAway's showWarp does (tactical.cpp:818-854); false with no battle. */
  battleWarp(): boolean;
  /**
   * Draws a frame and returns the canvas as a PNG data URL, its drawing buffer's pixels as they are (no page around it): the
   * screenshot check's port side. `console`: with the preview's console drawn over it, as ScummVM's screen has it (Plan 27 R17),
   * and `console` in the result says whether it was (not while the game's fonts load). With the art on and the console's repaint
   * loaded, the console is drawn as the game draws it: the repaint's plate, its art layer, and the frame over them (Plan 30 R17);
   * `repaint` says whether it was.
   */
  combatShot(o?: { console?: boolean }): Promise<{ width: number; height: number; png: string; console: boolean; repaint: boolean }>;
  /**
   * The world's battle as the console shows it (Plan 27), a copy: its page, Wide, the warp overlay, the target, the console's
   * switches the e2e checks its controls against, the banks' settings, the view and zoom, the step; the flight keys the sim holds
   * (BattleState.input.held, FLIGHT's bits), the pause and the speed (Plan 29). Null with no battle at tactical.
   */
  combatConsole(): {
    page: string; wide: boolean; warp: boolean; target: number | null; steps: number; view: number; zoomLevel: number; banks: number[];
    held: number; paused: boolean; speed: number;
    console: {
      shieldsRaised: boolean; weaponsLock: boolean; delegate: boolean; powerLevel: number; spreadDegrees: number; salvo: number[];
      menuSelected: number; engageButton: boolean; selfDestructTime: number; radarShown: boolean; redAlert: boolean;
    };
  } | null;
}

declare global {
  interface Window {
    __au?: DebugHandle;
  }
}

/** Nothing running, nothing said or asked: aboard the ship, no dialog or pending wait either; away, the input's canAct (`DebugHandle.idle`). */
const idleNow = (session: Session): boolean => !session.world.busy && session.store.state.subtitle === null
  && (session.world.state.onShip !== null
    ? session.store.state.dialog === null && session.clock.pending === 0 && !session.world.state.awayFlags.inputBlocked
    : session.input.canAct);

/** How long a timed battle is sampled, after its warm-up. */
export const PERF_SECONDS = 60;

let perfReport: PerfReport | null = null;

/**
 * `?dev&perf=<scenario>` (Plan 31 R4): fights battle `scenario` at tactical the way a player would, as the controls do (`battleScenario`,
 * `combatParity`, `setSpeed`, the console's Wide and Delegate), times each animation frame for `PERF_SECONDS` (after a one-second warm-up), and keeps the report for
 * `window.__au.perf()` and one console line. The run ends early, flagged short, when the battle ends. It waits out the opening's
 * movies and lines first, as the e2e's `quiet` does. The renderer's counts are read and reset each frame, over everything the frame draws.
 */
export function startPerf(session: Session, renderer: WebGLRenderer, scenario: number, seconds: number): void {
  const sampler = new FrameSampler(seconds * 1000);
  type Phase = 'waiting' | 'going' | 'timing';
  let phase: Phase = 'waiting';
  let still = 0;
  let seen = false;
  let stageStart: number | null = null;
  let stage: Phase = 'waiting';
  const finish = () => {
    renderer.info.autoReset = true;
    perfReport = sampler.report();
    console.info(`[perf] battle ${scenario}: ${JSON.stringify(perfReport)}`);
  };
  const frame = (now: number) => {
    if (sampler.done) return;
    requestAnimationFrame(frame);
    const battlePort = session.battlePort();
    // (a stage that never ends, or a battle that ends before it is drawn, gives a short report rather than none)
    if (phase !== 'timing') {
      if (stage !== phase || stageStart === null) { stage = phase; stageStart = now; }
      const b = battlePort.battle();
      if (b !== null) seen = true;
      if (startGaveUp({ stageMs: now - stageStart, seen, battle: b === null ? 'gone' : b.resolved !== null ? 'resolved' : 'live' })) {
        sampler.end();
        finish();
        return;
      }
    }
    if (phase === 'waiting') {
      // (the opening: a line said is skipped, a movie's Skip pressed, a menu's first option taken, until the game is idle for two frames)
      if (session.store.state.subtitle !== null && !document.querySelector('.au-menu')) session.presenter.skipLine();
      [...document.querySelectorAll<HTMLElement>('.au-movie button')].find(b => b.textContent?.trim() === 'Skip')?.click();
      document.querySelector<HTMLElement>('.au-menu button')?.click();
      if (!idleNow(session)) still = 0;
      else if (++still >= 2) {
        session.setCombatParity(false);
        session.world.state.ship.battleScenario = scenario;
        session.store.bump();
        session.loop.speed = 1;
        session.clock.speed = 1;
        phase = 'going';
      }
      return;
    }
    const v = battlePort.battle();
    if (phase === 'going') {
      // (the station change is refused until the game is idle: asked again each frame until it takes)
      if (session.world.state.ship.station !== 'tactical') void session.shipPort().station('tactical').catch(() => {});
      else if (v !== null && session.combatViewState().drawing) {
        battlePort.command({ type: 'wide', on: true });
        battlePort.command({ type: 'delegate', on: true });
        renderer.info.autoReset = false;
        renderer.info.reset();
        phase = 'timing';
      }
      return;
    }
    if (v !== null) seen = true;
    if (seen && (v === null || v.resolved !== null)) {
      sampler.end();
      finish();
      return;
    }
    sampler.frame(now, { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
    renderer.info.reset();
    if (sampler.done) finish();
  };
  requestAnimationFrame(frame);
}

/** For Playwright and the console, in dev builds only (Decision 16). */
export function exposeDebug(session: Session, renderer: WebGLRenderer, canvas: HTMLCanvasElement): void {
  window.__au = {
    ready: true,
    // (a copy: the browser side never writes world.state, and neither does a test through this)
    state: () => structuredClone(session.world.state),
    // (aboard the ship, nothing is running, said or asked: the input's canAct is the away team's)
    idle: () => idleNow(session),
    perf: () => perfReport,
    skipLine: () => {
      if (document.querySelector('.au-menu') || session.store.state.subtitle === null) return false;
      session.presenter.skipLine();
      return true;
    },
    started: () => session.input.started,
    heard: () => session.store.state.transcript.map(l => l.text),
    animationTime: () => session.stage.animationTime,
    speed: () => session.clock.speed,
    setSpeed: speed => { session.loop.speed = speed; session.clock.speed = speed; },
    point: id => {
      const r = canvas.getBoundingClientRect();
      const p = session.stage.screenPoint(id, r.width, r.height);
      return p && { x: r.left + p.x, y: r.top + p.y };
    },
    astroPoint: (sector, star, planet, moon) => session.astroPoint(sector, star, planet, moon),
    astro: () => {
      const c = session.shipPort().mapCamera();
      return { spinning: c.spinning, azimuth: c.azimuth, elevation: c.elevation, view: c.view };
    },
    objectAt: (x, y) => {
      const r = canvas.getBoundingClientRect();
      const hit = session.stage.pick({ x: ((x - r.left) / r.width) * 2 - 1, y: -(((y - r.top) / r.height) * 2 - 1) });
      return hit?.kind === 'object' ? hit.id : null;
    },
    art: () => {
      const aboard = session.world.state.onShip !== null;
      const port = session.shipPort();
      // (a hail replaces the station with the viewscreen's)
      const hailing = aboard && port.viewscreen() !== null;
      // (the computer leaves the ship's station as it was, and draws its own screen)
      const station = !aboard ? null : hailing ? 'viewscreen' : session.world.computer !== null ? 'computer' : session.world.state.ship.station;
      const drawn = station !== null && port.shipArt(station);
      // (the image the window shows: on the viewscreen's own station, or on the bridge with the viewscreen up)
      const windowed = drawn && (hailing || (station === 'bridge' && port.viewscreenUp() && port.shipArt('viewscreen')));
      return { ...session.stage.artState(), ship: { station, set: drawn, kind: !drawn ? null : station === 'tactical' && session.combatViewState().drawing ? 'space' : port.shipPlate(station) !== null ? 'plate' : 'set', viewscreen: windowed ? port.viewscreenImage().kind : null, beam: session.padBeams() } };
    },
    memory: () => ({
      textures: textureLedger.count,
      bytes: textureLedger.bytes,
      gpuBytes: textureLedger.uploadedBytes(t => (renderer.properties.get(t) as { __webglTexture?: unknown }).__webglTexture !== undefined),
      rendererTextures: renderer.info.memory.textures,
      pixelRatio: renderer.getPixelRatio(),
      consoleArt: session.consoleArtBytes(),
      biggest: textureLedger.records().slice(0, 8).map(r => `${r.url.split('/').slice(-2).join('/')} ${r.width}x${r.height} ${(r.bytes / 1048576).toFixed(1)}MB`),
      plates: textureLedger.records().filter(r => /plate(\.half)?\.webp/.test(r.url)).map(r => `${r.url.split('/').pop()} ${r.width}x${r.height}`),
    }),
    sounds: () => session.soundLog(),
    battleSound: () => session.battleSoundState(),
    say: (who, name, text) => session.store.say({ who, name, text }),
    astroKnow: (sector, star) => {
      const u = session.world.content.ship?.universe;
      const sec = u?.sectors[sector];
      const thing = sec && u ? u.stars[sec.firstStar + star] : undefined;
      if (!thing) throw new Error(`no star ${star} in sector ${sector}`);
      const flags = session.world.state.ship.flags;
      while (flags.length <= thing.id) flags.push(0);
      flags[thing.id] |= 1 | 4 | 8;
      session.store.bump();
    },
    padWalks: () => session.padWalks(),
    beam: number => {
      const mission = session.world.content.missions?.find(m => m.number === number);
      if (!mission) throw new Error(`no mission with world number ${number}`);
      session.world.state.beamTarget = mission.screen;
      session.world.state.beamWorld = number;
      session.store.bump();
    },
    combatAssets: () => session.battleAssetState(),
    loadCombatAssets: async (scenario, free = true) => {
      const started = performance.now();
      const set = await session.loadBattleAssetsFor(scenario);
      const loaded = performance.now();
      const during = textureLedger.bytes;
      if (free) session.freeBattleAssets();
      return { set, during, after: textureLedger.bytes, loadMs: Math.round(loaded - started), freeMs: Math.round((performance.now() - loaded) * 10) / 10 };
    },
    combatView: () => session.combatViewState(),
    combatParity: on => session.setCombatParity(on),
    previewBattle: (scenario, o) => session.previewBattle(scenario, o),
    previewState: b => session.previewState(b),
    endPreview: () => session.endPreview(),
    stepPreview: steps => session.stepPreview(steps),
    battleWarp: () => session.battleWarp(),
    combatConsole: () => {
      const v = session.battlePort().battle();
      if (!v) return null;
      const { b } = v;
      const c = b.console;
      return {
        page: v.page, wide: b.view.wide, warp: v.warp, target: b.target, steps: b.steps, view: b.view.view, zoomLevel: b.view.zoomLevel,
        banks: (b.ships[0]?.banks ?? []).map(bank => bank.setting), held: b.input.held, paused: v.paused, speed: session.assists.speed,
        console: {
          shieldsRaised: c.shieldsRaised, weaponsLock: c.weaponsLock, delegate: c.delegate, powerLevel: c.powerLevel, spreadDegrees: c.spreadDegrees,
          salvo: c.salvo.map(s => s.setting), menuSelected: c.menuSelected, engageButton: c.engageButton, selfDestructTime: c.selfDestructTime,
          radarShown: c.radarShown, redAlert: c.redAlert,
        },
      };
    },
    combatFrame: () => {
      // (a frame drawn and read back at once: the canvas isn't kept between frames. The renderer's counts over the whole
      // frame, the view and the bloom's passes after it: each render() would start them again)
      renderer.info.autoReset = false;
      renderer.info.reset();
      try {
        session.frame(0);
      } finally {
        renderer.info.autoReset = true;
      }
      const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
      const v = session.combatViewState();
      const gl = renderer.getContext();
      const vp = v.viewport;
      if (!vp || !v.window) return { calls, triangles, ships: [], effects: [] };
      const pixels = new Uint8Array(vp.width * vp.height * 4);
      gl.readPixels(vp.x, vp.y, vp.width, vp.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const k = vp.width / v.window.width;
      // (the square within half a thing's radius of its centre, in the viewport's pixels (rows come bottom first): how many of its pixels aren't black)
      const look = (x0: number, y0: number, r: number) => {
        const half = Math.max(1, Math.round((r * k) / 2));
        const cx = Math.round(x0 * k), cy = vp.height - 1 - Math.round(y0 * k);
        let lit = 0, of = 0;
        for (let y = cy - half; y <= cy + half; y++) {
          for (let x = cx - half; x <= cx + half; x++) {
            if (x < 0 || y < 0 || x >= vp.width || y >= vp.height) continue;
            of++;
            const i = (y * vp.width + x) * 4;
            if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 0) lit++;
          }
        }
        return { r: Math.round(r * k), lit, of };
      };
      const ships = v.ships.map(s => ({ index: s.index, model: s.model, flat: s.flat, ...look(s.x, s.y, s.r) }));
      const effects = v.effects.map(e => ({ kind: e.kind, model: e.model, ...look(e.x, e.y, e.r) }));
      return { calls, triangles, ships, effects };
    },
    combatShot: async o => {
      // (read straight after drawing, in the same task: the canvas isn't kept between frames)
      session.frame(0);
      if (!o?.console) return { width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png'), console: false, repaint: false };
      // (the frame, then the console over it at the canvas's size, its view rectangle clear; copied before anything is awaited)
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const g = out.getContext('2d')!;
      g.drawImage(canvas, 0, 0);
      const c = session.previewConsole();
      if (c) {
        const frame = document.createElement('canvas');
        frame.width = 640;
        frame.height = 480;
        frame.getContext('2d')!.putImageData(new ImageData(c.rgba, 640, 480), 0, 0);
        // (with the art on, the plate and the art layer under the frame, as the console component lays them: Plan 30 R17)
        let art: { plate: CanvasImageSource & { width: number; height: number }; layer: HTMLCanvasElement } | null = null;
        if (c.repaint) {
          const plate = new Image();
          plate.src = c.repaint.plate;
          await plate.decode();
          const layer = document.createElement('canvas');
          layer.width = 640 * c.repaint.scale;
          layer.height = 480 * c.repaint.scale;
          const lg = layer.getContext('2d')!;
          drawArtLayer({ clearRect: (x, y, w, h) => lg.clearRect(x, y, w, h), drawImage: (im, x, y) => lg.drawImage(im as CanvasImageSource, x, y) }, c.repaint, c.blits);
          art = { plate, layer };
        }
        drawConsoleShot({
          get imageSmoothingEnabled() { return g.imageSmoothingEnabled; },
          set imageSmoothingEnabled(v: boolean) { g.imageSmoothingEnabled = v; },
          drawImage: (im, x, y, w, h) => g.drawImage(im as CanvasImageSource, x, y, w, h),
        }, out.width, out.height, frame, art);
      }
      return { width: out.width, height: out.height, png: out.toDataURL('image/png'), console: c !== null, repaint: c?.repaint != null };
    },
    battleScenario: scenario => {
      session.world.state.ship.battleScenario = scenario;
      session.store.bump();
    },
    give: object => {
      const o = session.world.state.objects[object];
      if (!o) throw new Error(`no object ${object}`);
      o.inventory = true;
      o.active = true;
      session.store.bump();
    },
    hail: object => {
      // (the comms list holds only active objects: a look at a caller makes it one)
      const o = session.world.state.objects[object];
      if (o) o.active = true;
      session.shipPort().comms(object);
    },
    coverage: () => {
      // (read back straight after drawing: the canvas isn't kept between frames)
      session.stage.render(renderer);
      const gl = renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // (rows come bottom first: the top-left pixel is above the horizon, so background)
      const at = (height - 1) * width * 4;
      const [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]];
      let differ = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== r || pixels[i + 1] !== g || pixels[i + 2] !== b) differ++;
      }
      return { width, height, nonBackground: differ / (width * height) };
    },
  };
}
