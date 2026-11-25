// SPDX-License-Identifier: GPL-3.0-or-later
import '@another-unity/engine/ui/base.css';
import '@another-unity/engine/ui/ship/ship.css';
import '@another-unity/engine/ui/admin/admin.css';
import { ending, SaveError } from '@another-unity/engine';
import { arrivalMovie, AUTOSAVE_SLOT, Autosave, autosaveEnabled, bindSkipClick, GameUi, Mixer, SaveSlots, Session, ShipPanel, textureLedger, WakeLockKeeper } from '@another-unity/engine/web';
import { h, render, type ComponentChildren } from 'preact';
import { SRGBColorSpace, Vector2, WebGLRenderer } from 'three';
import { bindContextLoss } from './contextLoss';
import { devGate, perfOverlayAsked } from './devGate';
import { lowMemoryDevice, pixelRatioFor } from './device';
import { MissionSelect } from './missionSelect';
import { exposeDebug, PERF_SECONDS, startPerf } from './debug';
import { BRIDGES, GAMES, GATES, SHIP_STARTS } from './games';
import { onContentChange } from './hot';
import { bindFullscreenButtons, isTouchDevice, requestLandscape } from './landscape';
import { bindLoading, offerGameFiles, trackStep } from './loading';
import { installErrorLog } from './feedback/errorLog';
import { feedbackTransport } from './feedback/transport';

// (the last errors and warnings, for a feedback report: feedback/errorLog.ts)
installErrorLog();
const params = new URLSearchParams(location.search);
// (players get the dev tools and window.__au only with ?dev: Decision 16. A deploy build (docs/deploy.md: VITE_AU_DEPLOY=1) has no ?dev
// at all: the flag is replaced at build time, so the dev branches and what only they use are dropped from the bundle)
const deploy = import.meta.env.VITE_AU_DEPLOY === '1';
const { devParam, dev, realCombat } = devGate(params, { devServer: import.meta.env.DEV, deploy });
// (the dev mission select, R11: a game with a ship otherwise opens on its bridge)
const missions = dev && params.has('missions');

// (index.html's loading screen, started by boot.ts: each real step of the start tells it, and it fades out when the game is up)
const loading = bindLoading();

async function main(): Promise<void> {
  const frame = document.querySelector<HTMLElement>('#game');
  const canvas = document.querySelector<HTMLCanvasElement>('#view');
  const labels = document.querySelector<HTMLElement>('#labels');
  const ui = document.querySelector<HTMLElement>('#ui');
  if (!frame || !canvas || !labels || !ui) throw new Error('index.html is missing #game, #view, #labels or #ui');

  const gameId = params.get('game') ?? (location.pathname.startsWith('/play/afu') ? 'unity' : 'demo');
  const load = GAMES[gameId];
  if (!load) {
    loading.done(false);
    ui.textContent = `There is no game called "${gameId}". Try ${Object.keys(GAMES).map(g => `?game=${g}`).join(' or ')}.`;
    return;
  }
  // (the deploy build's unity is sealed: the player's CD unlocks it first, on the import screen, once per device. A deploy-only chunk)
  const gate = deploy ? GATES[gameId] : undefined;
  let flow: typeof import('./gate/gateFlow') | undefined;
  if (gate) {
    const [gateFlow, parts] = await Promise.all([import('./gate/gateFlow'), gate()]);
    flow = gateFlow;
    await flow.ensureUnlocked({ ui: document.body, params: parts.params, checkUrl: parts.checkUrl, worker: flow.browserWorker() });
    // (the start screen's Game files…: the CD again, as when the key is gone)
    const keys = flow.browserKeys;
    offerGameFiles(() => { void keys.clear().catch(() => undefined).finally(() => location.reload()); });
  }
  loading.begin('Loading game data');
  // (the package's files are counted as they come, and the bar creeps between them, so a long wait never looks frozen)
  const stopCounting = trackStep(loading, 'Loading game data');
  // (a 403 from a sealed file: the worker lost the key, so back to the import screen)
  const pkg = await (flow ? flow.loadUnlocked(load) : load()).finally(stopCounting);
  loading.begin('Starting the display');

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  // (a phone, or a device short of memory: half-resolution plates, and a pixel ratio of 2 at most)
  const lowRes = lowMemoryDevice(location.search);
  renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio, lowRes));
  const resize = () => {
    const r = frame.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
  };
  resize();
  window.addEventListener('resize', resize);
  // (?perf, bare: the frame-rate overlay, for a phone; a chunk of its own, loaded only then. ?perf=<n> is the perf runner's: Plan 34 Task 8)
  if (perfOverlayAsked(params)) {
    import('@another-unity/engine/dev/perfOverlay').then(m => m.startPerfOverlay(renderer, document.body), (err: unknown) => console.warn(err));
  }

  let audio: Mixer | null = null;
  try {
    audio = new Mixer(new AudioContext(), undefined, m => console.warn(m));
    // (?mute: silent for this load, whatever the settings' master; the session sets the levels from the settings record)
    audio.setMuted(params.has('mute'));
  } catch {
    // (no Web Audio: the game plays silent, with timed lines)
    audio = null;
  }
  loading.begin('Opening saves');
  const saves = await SaveSlots.open(pkg.id).catch(() => null);

  // (a dev ship start: a new game on the bridge, with the trigger states an earlier mission would have left; it goes
  // through the session, so a restart keeps it: M11)
  const startAt = dev ? params.get('start') : null;
  const shipStart = dev ? params.get('ship') : null;
  const shipTriggers = shipStart !== null && startAt === null ? SHIP_STARTS[gameId]?.[shipStart] : undefined;
  if (shipStart !== null && startAt === null && shipTriggers === undefined) console.warn(`There is no dev ship start called "${shipStart}".`);
  // (the difficulty setting, 0-2: R6; for this load only, never written back: Plan 32)
  const difficulty = params.get('difficulty');
  // (the player's game, written down by the autosave the last time the page was hidden: not for the dev tools or a test)
  const autosaving = saves !== null && autosaveEnabled(location.search, navigator.webdriver === true) && startAt === null && shipStart === null && !missions;
  const resume = autosaving ? await saves.get(AUTOSAVE_SLOT).catch(() => undefined) : undefined;
  const parts: Parameters<typeof Session.start>[1] = {
    difficulty: difficulty === null ? undefined : Number(difficulty),
    devShip: shipTriggers,
    // (the dev mission select is a start somewhere else too: it goes straight to a mission's beam-down, with no opening movies over its dialog)
    opening: startAt === null && !missions,
    // (the movies begin at Start, not under the loading screen)
    deferOpening: true,
    progress: (label, within) => {
      loading.begin(label);
      if (within !== undefined) loading.part(within);
    },
    render: (stage, over) => {
      if (!over) return stage.render(renderer);
      if (!over.viewport) return renderer.render(over.scene, over.camera);
      // (a set in a box of the frame: the stage clears and draws as it does, or the frame is only cleared, then the set over the box alone)
      if (over.clear) renderer.clear();
      else stage.render(renderer);
      over.before?.(renderer);
      const { x, y, width, height } = over.viewport;
      const px = renderer.getPixelRatio();
      const size = renderer.getSize(new Vector2());
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setViewport(x / px, y / px, width / px, height / px);
      renderer.setScissor(x / px, y / px, width / px, height / px);
      renderer.setScissorTest(true);
      renderer.clear();
      renderer.render(over.scene, over.camera);
      over.after?.(renderer);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.autoClear = autoClear;
    },
    // (the space view's warm-up, before a battle's first frame: Plan 34 Task 8)
    prepare: job => job(renderer),
    labels,
    // (the boxes drawn in and the pointer's mapping are in the renderer's pixels, capped at 2 on a low-memory device)
    pixelRatio: () => renderer.getPixelRatio(),
    // (?art=0 or ?art=1: for this load only, over the settings record's, Plan 32)
    artOff: params.has('art') ? params.get('art') === '0' : undefined,
    panelOff: params.get('panel') === '0',
    ship3d: devParam && params.has('ship3d'),
    // (tactical fights the combat sim, but for ?dev&combat=dialog: Plan 31 R7)
    realCombat,
    audio,
    saves,
    log: (level, m) => console[level](m),
    // (SETTINGS > GAME > SEND FEEDBACK: the report goes to the site's Pages Function, behind Turnstile)
    feedback: feedbackTransport(),
    // (at least 0.1: ?speed=0 or a negative speed would stop the game)
    speed: Math.max(0.1, Number(params.get('speed')) || 1),
    holdMusic: gameId in BRIDGES,
    lowRes,
  };
  let resumed = resume !== undefined;
  const session = await Session.start(pkg, parts, resume).catch((err: unknown) => {
    // (an autosave this version cannot read, or from other content: a new game, and the autosave is written over)
    if (resume === undefined || !(err instanceof SaveError)) throw err;
    console.warn(`The autosave could not be used (${err.message}): starting a new game.`);
    resumed = false;
    return Session.start(pkg, parts);
  });
  // (the dev tools' check of every screen: a new game there, past the bridge, M3 Plan 8 R10)
  // (a dev start's away team, by object ids: ?team=worf,crusher; the first leads)
  const team = params.get('team')?.split(',').filter(Boolean);
  if (startAt !== null) {
    await session.begin({ screen: startAt, entrance: params.get('entrance') ?? 'entrance_0', ...(team?.length ? { awayTeam: team, leader: team[0] } : {}) });
  }
  session.bind(canvas);
  // (a click while someone speaks ends the line, on the ship's screens and the panels too, and presses nothing under it)
  bindSkipClick(frame, session.store, () => session.skipLine());
  render(h(GameUi, { ui: session.uiPort() }), ui);
  const bridge = missions ? BRIDGES[gameId] : undefined;
  // (a game with a ship, started the player's way: the bridge, with the loop running)
  const onShip = bridge === undefined && startAt === null && session.content.ship !== undefined;
  // (with a bridge, a new game goes back through it: the briefing again, the loop and music held until the team
  // beams down, and then the arrival movie and the beam-down piece again)
  let showBridge = () => {};
  let rounds = 0;
  // (a refused restart rejects: the panel says so and stays; the dev overlay's button only logs it)
  const restartThroughBridge = async () => {
    await session.restart();
    session.loop.stop();
    session.holdMusic();
    rounds++;
    showBridge();
  };
  // (the battle's own view at tactical, with the dev tools: Plan 23)
  let battleView: ComponentChildren;
  let devLabel: string | undefined;
  // (the world's battle at tactical: the console, Plan 27)
  const battlePort = session.battlePort();
  if (dev) {
    // (loaded only with the dev tools: players don't download it)
    const { DevOverlay, GameCombat, DEV_TOOLS_LABEL } = await import('@another-unity/engine/dev/overlay');
    battleView = h(GameCombat, { port: battlePort });
    devLabel = DEV_TOOLS_LABEL;
    const tools = document.body.appendChild(document.createElement('div'));
    const port = session.devPort();
    render(h(DevOverlay, { dev: bridge && startAt === null ? { ...port, restart: () => { restartThroughBridge().catch((err: unknown) => console.warn(err)); } } : port }), tools);
    onContentChange({ changed: next => session.reloadContent(next), failed: err => session.reloadFailed(err) });
    exposeDebug(session, renderer, canvas);
  }
  // (no art for the ship's screens yet: HTML panels over the frame, under the HUD's subtitles and dialogs. It shows nothing
  // while the team is away, and comes up when they are back aboard, from a dev start too)
  if (session.content.ship !== undefined && bridge === undefined) {
    const panel = frame.insertBefore(document.createElement('div'), ui);
    panel.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    render(h(ShipPanel, { port: session.shipPort(), battle: battleView, battlePort, devLabel }), panel);
  }
  // (the HUD's own fullscreen button, for a touch device)
  bindFullscreenButtons();
  // (loaded: the screen waits for Start, whose press also wakes the audio; the game only runs once it is pressed)
  // (an autosave waits: Start reads Continue, and a smaller button starts a new game)
  loading.resumable = resumed;
  // (the save menu's slots, to load from here too; the autosave is Continue's)
  loading.saved = (await saves?.list().catch(() => []) ?? []).filter(m => m.slot !== AUTOSAVE_SLOT).map(m => ({ slot: m.slot, label: m.label }));
  loading.done();
  // (the same press asks, on a touch device, for fullscreen and the landscape lock, which need a gesture)
  const choice = await loading.waitForStart(() => {
    void audio?.resume();
    if (isTouchDevice()) void requestLandscape();
  });
  if (resumed && choice === 'new') await session.newGame();
  if (typeof choice === 'object') {
    await session.loadSlot(choice.slot).catch((err: unknown) => console.warn(`Slot ${choice.slot} could not be loaded (${err instanceof Error ? err.message : String(err)}): carrying on.`));
  }
  // (a new game on the ship opens with its movies, before the loop runs: nothing else happens until they end or are skipped)
  session.beginOpening();
  if (startAt !== null) {
    session.loop.start();
    void session.playIntro(false);
  } else if (onShip) {
    session.loop.start();
  } else if (bridge) {
    // (the mission select: the loop and the music start when the team beams down)
    const panel = document.body.appendChild(document.createElement('div'));
    // (a new key each round starts the panel over at the briefing, whoever restarted)
    showBridge = () => render(h(MissionSelect, {
      key: rounds,
      text: bridge,
      port: {
        missions: () => session.content.missions ?? [],
        choose: async world => {
          const m = session.content.missions?.find(x => x.world === world);
          if (m) await session.begin({ screen: m.screen, entrance: m.entrance });
        },
        arrivalMovie: () => {
          const stem = arrivalMovie(session.pkg.presentation, session.content, session.world.state.screen);
          return stem === undefined ? undefined : session.pkg.assets.movie(stem);
        },
        beamDown: effect => {
          session.loop.start();
          // (the context must be running before the piece starts, or it would be skipped; the click on the bridge
          // has already woken it, but resuming twice is harmless)
          void (async () => {
            await audio?.resume();
            await session.playIntro(effect);
          })();
        },
        onShip: () => session.world.state.onShip,
        restart: restartThroughBridge,
        ending: reason => ending(session.content, reason),
        subscribe: listener => session.store.subscribe(listener),
      },
    }), panel);
    showBridge();
  } else {
    session.loop.start();
  }
  // (the screen stays on while the game is played, and comes back on when the tab does)
  new WakeLockKeeper().acquire();
  // (written down as the page is hidden or goes, at each screen and every minute: a phone may kill the tab, and Continue picks it up)
  const autosave = autosaving ? new Autosave(session, { onError: err => console.warn('autosave:', err) }) : null;
  autosave?.start();
  // (a lost WebGL context: the game is written down, and the art uploads again when the context returns; if it doesn't, a reload into Continue)
  bindContextLoss(canvas, {
    lost: () => { console.warn('The WebGL context was lost.'); autosave?.flush(); },
    restored: () => { console.warn('The WebGL context was restored.'); session.store.bump(); },
    giveUp: () => { autosave?.flush(); setTimeout(() => location.reload(), 300); },
  });
  // (a timed battle: ?dev&perf=<scenario>, run by `npm run perf`: Plan 31 R4)
  const perfBattle = dev ? Number(params.get('perf')) : 0;
  if (perfBattle > 0) startPerf(session, renderer, perfBattle, PERF_SECONDS);
  if (dev) {
    // (the textures' memory, for ?dev: what the art costs, by the sizes tracked and by the renderer's own count)
    let last = '';
    setInterval(() => {
      const gpu = textureLedger.uploadedBytes(t => (renderer.properties.get(t) as { __webglTexture?: unknown }).__webglTexture !== undefined);
      const line = `${textureLedger.summary()}; on the GPU ${(gpu / 1048576).toFixed(1)} MB; renderer: ${renderer.info.memory.textures} textures, ${renderer.info.memory.geometries} geometries, pixel ratio ${renderer.getPixelRatio()}${lowRes ? ', half-resolution plates' : ''}`;
      if (line !== last) console.info(`[memory] ${line}`);
      last = line;
    }, 2000);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  loading.fail(err);
  const ui = document.querySelector('#ui');
  if (ui) ui.textContent = `The game could not start: ${err instanceof Error ? err.message : String(err)}`;
});
