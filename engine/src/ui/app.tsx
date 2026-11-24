// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ALL_READINGS } from '../sim/talk';
import type { AdminArt, Faces, TricorderArt } from './faces';
import { AwayPanel } from './awayPanel';
import { PHASER_LABELS } from './panel';
import { cursorCss, loadSpriteCursors, originalCursorSource, panelCursorSource, type CursorKey, type CursorSource, type SpriteCursors } from './cursors';
import { hotspotLabels as hotspotLabelsNow, setHotspotLabels, useHotspotLabels } from './hotspotLabels';
import type { World } from '../sim/world';
import type { Input } from './input';
import type { SavesPort } from './savesPort';
import { AdminConsole } from './admin/adminConsole';
import type { SettingsPort } from '../web/settingsPort';
import type { AstroFonts } from '../view/bitmapText';
import { actionLine, VERBS, type Dialog, type SpokenLine, type UiStore, type VerbMode } from './store';
import { setTheatre } from './theatre';
import { useStore } from './useStore';

/** The interface strip of a ship plate, in the original's pixels: rows 364 to 480 of the 640 by 480 screen (the bridge's STRIP). */
const STRIP_TOP = 364 / 480;

/**
 * Where the dialogue window goes aboard the ship. The bridge's and the viewscreen's plates have their interface strip along the bottom, and
 * the window covers exactly that, opaque, so it never hides the viewscreen's frame or lets the strip's text through. It is set as `--au-strip-*`
 * on the HUD (px) with `data-strip`; elsewhere (away rooms, the other stations, no plate) it is unset and the window keeps its own place.
 */
function useStripDialog(hud: { current: HTMLDivElement | null }): void {
  const place = () => {
    const el = hud.current;
    if (!el) return;
    const screen = el.ownerDocument.querySelector<HTMLElement>('[data-station="bridge"].au-ship-art .au-ship-screen, [data-station="viewscreen"].au-ship-art .au-ship-screen');
    const box = el.getBoundingClientRect();
    const r = screen?.getBoundingClientRect();
    if (!r || r.width === 0) {
      el.removeAttribute('data-strip');
      return;
    }
    const top = r.top + r.height * STRIP_TOP;
    const set = (k: string, v: number) => el.style.setProperty(k, `${Math.round(v)}px`);
    set('--au-strip-x', r.left - box.left);
    set('--au-strip-y', top - box.top);
    set('--au-strip-w', r.width);
    set('--au-strip-h', r.bottom - top);
    el.setAttribute('data-strip', '');
  };
  // (a station's plate mounts and goes without the HUD rendering, and its box moves with the window: measured again as either happens)
  useLayoutEffect(place);
  useEffect(() => {
    const root = hud.current?.closest('#game') ?? document.body;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const changes = typeof MutationObserver === 'undefined' ? null : new MutationObserver(later);
    changes?.observe(root, { childList: true, subtree: true });
    window.addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      changes?.disconnect();
      window.removeEventListener('resize', later);
    };
  }, []);
}

/** What the HUD needs from the running session; `input()` is the current world's controller. */
export interface UiSession {
  store: UiStore;
  input: () => Input;
  /** The portraits and icons, when the art has them and is on; without it the HUD keeps its text buttons and names. */
  faces?: () => Faces | undefined;
  /** Absent where IndexedDB isn't available. */
  saves?: SavesPort;
  /** The settings record and the admin PADD (Plan 32). */
  settings?: SettingsPort;
  /** The admin console's pictures (art.admin), the original's pixels whatever the art setting; without them it is drawn in CSS. */
  adminArt?: () => AdminArt | undefined;
  /** The game's bitmap fonts (art.fonts), which the admin console's words are drawn in, whatever the art setting; null until loaded or without them. */
  adminFonts?: () => AstroFonts | null;
}

const VERB_LABELS: Record<VerbMode, string> = { walk: 'Walk', look: 'Look', use: 'Use', talk: 'Talk' };
const PHASER_SETTINGS = ['Off', 'Low', 'Medium', 'High'];

/** The overlay over the canvas (spec §7.4). A game's theme stylesheet sets its colours. */
export function GameUi({ ui }: { ui: UiSession }) {
  const state = useStore(ui.store);
  const input = ui.input();
  const faces = ui.faces?.();
  const world = input.world;
  const aboard = world.state.onShip !== null;
  const name = (id: string | null) => (id === null ? null : world.state.objects[id]?.name ?? id);
  const toggleLog = () => ui.store.set({ panel: state.panel === 'transcript' ? 'none' : 'transcript' });
  // (the original's admin button drops the held item first: phase4_rest.md §6.1; a refused press, say in a battle, keeps it)
  const openAdmin = ui.settings ? () => { if (ui.settings?.openAdmin()) ui.store.set({ held: null }); } : undefined;
  const labels = useHotspotLabels();
  // H shows or hides the names and outlines over the clickable areas (not while typing, and not with a modifier)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'h') return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      setHotspotLabels(!hotspotLabelsNow());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const hud = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  useStripDialog(hud);
  const heldName = !aboard && state.mode === 'use' ? name(state.held) : null;
  // away, the original's panel when it is published and the art is on (art.panel); else the HUD's own bar
  const panelArt = aboard ? undefined : faces?.panel();
  // the pointer is the game's own, set on the game's root (the frame the HUD is in) so nothing outside it changes: the arrow
  // everywhere and the hand over controls (base.css), and on the room a picture for each verb (the ship's screens keep the arrow)
  // (the four verbs' cursors are the panel's own sprites, once scaled; until then, or with the art off, the drawn ones)
  const [sprites, setSprites] = useState<SpriteCursors>({});
  // (the original's own pointers when they are published, each with its lit twin; else the panel's button sprites, lit as its selected ones; else drawn)
  const cursorArt = aboard ? undefined : faces?.cursors();
  const sources: Partial<Record<CursorKey, CursorSource>> = {};
  if (cursorArt) {
    for (const v of VERBS) {
      sources[v] = originalCursorSource(cursorArt.sprite(v), cursorArt.scale, cursorArt.hotspot(v));
      sources[`${v}_lit`] = originalCursorSource(cursorArt.sprite(`${v}_lit`), cursorArt.scale, cursorArt.hotspot(v));
    }
  } else if (panelArt) {
    for (const v of VERBS) {
      sources[v] = panelCursorSource(v, panelArt.sprite(v));
      sources[`${v}_lit`] = panelCursorSource(v, panelArt.sprite(`${v}_on`));
    }
  }
  const spriteKey = Object.entries(sources).map(([k, s]) => `${k}=${s.url}`).join('|');
  useEffect(() => {
    if (spriteKey === '') {
      setSprites({});
      return;
    }
    let live = true;
    void loadSpriteCursors(sources).then(made => { if (live) setSprites(made); });
    return () => { live = false; };
  }, [spriteKey]);
  // (lit over something to act on, and in Walk over floor to walk on: handleAwayTeamMouseMove's `highlight`)
  const lit = !aboard && (state.hover !== null || (state.mode === 'walk' && state.hoverFloor));
  useEffect(() => {
    const root = hud.current?.closest<HTMLElement>('#game') ?? hud.current?.parentElement;
    if (!root) return;
    root.style.setProperty('--au-cursor', cursorCss('default'));
    root.style.setProperty('--au-cursor-pointer', cursorCss('pointer'));
    root.style.setProperty('--au-cursor-room', cursorCss(aboard ? 'default' : state.mode, sprites, lit));
    root.dataset.mode = aboard ? 'ship' : state.mode;
    root.dataset.cursor = !aboard && sprites[state.mode] ? 'sprite' : 'drawn';
    if (lit) root.dataset.lit = '';
    else delete root.dataset.lit;
  }, [aboard, state.mode, sprites, lit]);
  // theatre mode: the page darkens around a movie, for every cutscene, and lights again when it ends or is skipped
  const movie = state.dialog?.kind === 'movie';
  useEffect(() => (movie ? setTheatre(document, true) : undefined), [movie]);
  // a held item's name rides beside the pointer
  useEffect(() => {
    if (heldName === null) return;
    const move = (e: PointerEvent) => {
      const el = tag.current;
      const box = hud.current?.getBoundingClientRect();
      if (!el || !box) return;
      el.style.left = `${e.clientX - box.left + 18}px`;
      el.style.top = `${e.clientY - box.top + 18}px`;
      el.hidden = false;
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [heldName]);
  return (
    <div class="au-hud" ref={hud}>
      {heldName !== null && <div class="au-held" ref={tag} hidden>{heldName}</div>}
      {/* (an object being dragged is shown as if held: awayteam.cpp:583) */}
      {!aboard && !panelArt && <div class="au-action">{actionLine(state.mode, name(state.held ?? state.dragging), state.hover)}</div>}
      {state.screenTexts.map(t => (
        <div key={`${t.x},${t.y}`} class="au-screentext" style={`left:${t.x / 6.4}%;top:${t.y / 4.8}%;width:${(t.width + 1) / 6.4}%;height:${(t.height + 1) / 4.8}%`}>
          {t.lines.map((line, i) => <div key={i}>{line === '' ? '\u00a0' : line}</div>)}
        </div>
      ))}
      {state.subtitle && !state.subtitle.hidden && (
        <div class="au-subtitle" role="status" data-speaker={state.subtitle.who}>
          <Face face={faces?.speaker(state.subtitle.who)} class="au-speaker" />
          <div class="au-line"><b>{state.subtitle.name}:</b> {state.subtitle.text}</div>
        </div>
      )}
      {panelArt && faces && (
        <AwayPanel
          world={world}
          input={input}
          store={ui.store}
          faces={faces}
          art={panelArt}
          status={state.phaserHover !== null ? PHASER_LABELS[state.phaserHover] ?? '' : actionLine(state.mode, name(state.held ?? state.dragging), state.hover)}
          held={state.held}
          inert={state.dialog !== null}
          admin={openAdmin}
        />
      )}
      {!panelArt && <div class="au-bar" {...{ inert: state.dialog !== null }}>
        {/* (aboard the ship, only the log, the hotspots and the admin console: the verbs, team and inventory are the away mission's) */}
        {!aboard && (
          <div class="au-group au-verbs">
            {VERBS.map(v => (
              <button key={v} aria-pressed={state.mode === v} disabled={!input.canChangeMode} onClick={() => input.setMode(v)}>{VERB_LABELS[v]}</button>
            ))}
          </div>
        )}
        {!aboard && <TeamBar world={world} input={input} store={ui.store} faces={faces} />}
        {!aboard && <Inventory world={world} input={input} held={state.held} faces={faces} />}
        <div class="au-group au-menus">
          <button aria-pressed={state.panel === 'transcript'} onClick={toggleLog}>Log</button>
          <button aria-pressed={labels} title="Show the names and outlines over the clickable areas (H)" onClick={() => setHotspotLabels(!labels)}>Hotspots</button>
          {openAdmin && <button aria-pressed={state.panel === 'admin'} onClick={openAdmin}>Admin</button>}
        </div>
      </div>}
      <Transcript lines={state.transcript} open={state.panel === 'transcript'} />
      {state.panel === 'admin' && ui.settings && <AdminConsole settings={ui.settings} saves={ui.saves} store={ui.store} art={ui.adminArt?.()} fonts={ui.adminFonts?.()} />}
      {state.dialog && <DialogView dialog={state.dialog} store={ui.store} tricorder={aboard ? undefined : faces?.tricorder()} />}
      {state.message && (
        <div class="au-message" role="alert">
          {state.message} <button onClick={() => ui.store.set({ message: null })}>OK</button>
        </div>
      )}
    </div>
  );
}

/** A portrait or icon, drawn with hard pixels. Decorative: the control or line it is in carries the name. */
function Face({ face, class: cls }: { face: string | { url: string; placeholder: boolean } | undefined; class: string }) {
  if (face === undefined) return null;
  const { url, placeholder } = typeof face === 'string' ? { url: face, placeholder: false } : face;
  return <img class={`au-face ${cls}`} src={url} alt="" aria-hidden="true" draggable={false} data-placeholder={placeholder ? '' : undefined} />;
}

function TeamBar({ world, input, store, faces }: { world: World; input: Input; store: UiStore; faces: Faces | undefined }) {
  const s = world.state;
  const here = s.awayTeam.filter(id => s.objects[id]?.screen === s.screen);
  return (
    <div class="au-group au-team">
      {here.map(id => (
        <TeamButton key={id} id={id} name={s.objects[id].name} face={faces?.portrait(id)} pressed={s.currentActor === id} disabled={!input.canAct || world.isIncapacitated(id)} onClick={() => input.selectMember(id)} />
      ))}
      {/* (on the panel whatever the screen says, as the original's is; a screen that turns it off only disables it) */}
      {world.content.rules.items.communicator !== undefined && <button class={faces?.combadge() ? 'au-combadge au-has-face' : 'au-combadge'} aria-label={faces?.combadge() ? 'Combadge' : undefined} title={faces?.combadge() ? 'Combadge' : undefined} disabled={!input.canAct || !input.combadgeReady} onClick={() => void input.combadge().catch(err => store.set({ message: `That didn't work: ${err instanceof Error ? err.message : String(err)}` }))}>{faces?.combadge() ? <Face face={faces.combadge()} class="au-icon" /> : 'Combadge'}</button>}
    </div>
  );
}

/** A crew member's button: the portrait when there is one (the name stays its accessible name and its tooltip), else the name. */
function TeamButton({ id, name, face, pressed, disabled, onClick }: { id: string; name: string; face: string | undefined; pressed: boolean; disabled: boolean; onClick: () => void }) {
  if (face === undefined) return <button aria-pressed={pressed} disabled={disabled} onClick={onClick}>{name}</button>;
  return (
    <button class="au-has-face" data-member={id} aria-label={name} title={name} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Face face={face} class="au-portrait" />
    </button>
  );
}

function Inventory({ world, input, held, faces }: { world: World; input: Input; held: string | null; faces: Faces | undefined }) {
  const items = Object.keys(world.content.objects).filter(id => {
    const o = world.state.objects[id];
    return o !== undefined && o.inventory && o.active;
  });
  const phaser = world.content.rules.items.phaser;
  return (
    // (the drop target for an object dragged in Use mode: Session.bind looks for it)
    <div class="au-group au-inventory" data-drop="inventory" role="group" aria-label="Inventory: drop an object here to pick it up">
      {items.map(id => (
        <span key={id} class="au-item">
          {faces?.icon(id) !== undefined ? (
            <button class="au-has-face" data-item={id} aria-label={world.state.objects[id].name} title={world.state.objects[id].name} aria-pressed={held === id} disabled={!input.canAct} onClick={() => input.clickItem(id)}>
              <Face face={faces.icon(id)} class="au-icon" />
            </button>
          ) : (
            <button aria-pressed={held === id} disabled={!input.canAct} onClick={() => input.clickItem(id)}>{world.state.objects[id].name}</button>
          )}
          {id === phaser && (
            <select
              aria-label="Phaser setting"
              disabled={!input.canAct}
              value={String(world.state.phaserSetting)}
              onChange={e => input.setPhaser(Number((e.currentTarget as HTMLSelectElement).value))}
            >
              {PHASER_SETTINGS.map((label, i) => <option key={label} value={String(i)}>{label}</option>)}
            </select>
          )}
        </span>
      ))}
    </div>
  );
}

/** Always in the page (so tools can read the log); visually hidden until the Log panel is open. */
function Transcript({ lines, open }: { lines: SpokenLine[]; open: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <ol class={open ? 'au-panel au-transcript' : 'au-transcript au-transcript-closed'} role="log" aria-label="Transcript" ref={list}>
      {lines.map((l, i) => <li key={i}><b>{l.name}:</b> {l.text}</li>)}
    </ol>
  );
}

/**
 * The tricorder viewer's layout, in the pixels of its 410 by 478 picture (tricorder.cpp: the picture is drawn with its top left at 115, 0 of the
 * 640 by 480 screen; the buttons' rectangles, the text screen and the four number boxes are from its top left).
 */
const TRICORDER = {
  x: 115, width: 410, height: 478,
  screen: { x: 121, y: 97, w: 223, h: 191, margin: 4 },
  // (each button's rectangle, and the width of its picture, which is a pixel or two wider than the rectangle)
  prev: { x: 179, y: 325, w: 38, h: 28, pic: 40 }, next: { x: 259, y: 325, w: 38, h: 28, pic: 40 }, resume: { x: 256, y: 435, w: 121, h: 42, pic: 121 },
  pageUp: { x: 48, y: 118, pic: 28 }, pageDown: { x: 48, y: 192, pic: 28 }, mode: { x: 49, y: 298, pic: 24 },
  // (the numbers: the page and the last page, the reading and the last reading)
  labels: [{ x: 50, y: 165 }, { x: 50, y: 260 }, { x: 226, y: 329 }, { x: 334, y: 329 }],
} as const;
const pct = (v: number, of: number) => `${(v / of) * 100}%`;
const box = (x: number, y: number, w: number, h: number) => `left:${pct(x, TRICORDER.width)};top:${pct(y, TRICORDER.height)};width:${pct(w, TRICORDER.width)};height:${pct(h, TRICORDER.height)}`;

/** The tricorder's readings, a page at a time; with none, the reading's number. With the original's frame published, the readout is drawn on its screen. */
function TricorderView({ dialog, close, art }: { dialog: Extract<Dialog, { kind: 'tricorder' }>; close: () => void; art?: TricorderArt }) {
  const last = Math.max(0, dialog.pages.length - 1);
  const [at, setAt] = useState(Math.min(dialog.index, last));
  const page = dialog.pages[at];
  const closeButton = useRef<HTMLButtonElement>(null);
  // a paging button that disables under the focus (the first or last page) hands it to Close
  useEffect(() => {
    if (document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled) closeButton.current?.focus();
  }, [at]);
  if (art) {
    const T = TRICORDER;
    // (a button's picture: greyed when it can't be pressed, lit under the pointer; the frame itself carries the plain one)
    const image = (name: 'prev' | 'next' | 'resume', enabled: boolean) => {
      const b = T[name];
      const wide = `width:${(b.pic / b.w) * 100}%`;
      return enabled
        ? <img class="au-tricorder-pic au-tricorder-hover" style={wide} src={art.sprite(name === 'resume' ? 'resume_hover' : (`${name}_hover` as 'prev_hover'))} alt="" draggable={false} />
        : <img class="au-tricorder-pic" style={wide} src={art.sprite(`${name}_off` as 'prev_off')} alt="" draggable={false} />;
    };
    const still = (name: 'page_up_off' | 'page_down_off' | 'mode_readings', at: { x: number; y: number; pic: number }) => (
      <img class="au-tricorder-pic" style={`left:${pct(at.x, T.width)};top:${pct(at.y, T.height)};width:${pct(at.pic, T.width)}`} src={art.sprite(name)} alt="" draggable={false} />
    );
    const numbers = [0, 0, at, last];
    return (
      <Modal label="Tricorder" class="au-tricorder au-tricorder-art" onEscape={close}>
        <img class="au-tricorder-frame" src={art.sprite('frame')} alt="" draggable={false} />
        {/* (always one page of text here: the page buttons are the greyed pictures the original draws then) */}
        {still('page_up_off', T.pageUp)}
        {still('page_down_off', T.pageDown)}
        {still('mode_readings', T.mode)}
        <div class="au-tricorder-screen" style={box(T.screen.x, T.screen.y, T.screen.w, T.screen.h)}>
          {page ? (
            <div class="au-reading" data-page={at}>
              <h2>{page.title}</h2>
              <h3>{page.heading}</h3>
              <p>{page.text}</p>
            </div>
          ) : <p>{dialog.reading === ALL_READINGS ? 'Tricorder: all readings' : `Tricorder reading ${dialog.reading}`}</p>}
        </div>
        {T.labels.map((l, i) => <span key={i} class="au-tricorder-number" style={box(l.x, l.y, 20, 17)}>{numbers[i]}</span>)}
        <button class="au-tricorder-button" style={box(T.prev.x, T.prev.y, T.prev.w, T.prev.h)} aria-label="Previous" disabled={at === 0} onClick={() => setAt(at - 1)}>{image('prev', at !== 0)}</button>
        <button class="au-tricorder-button" style={box(T.next.x, T.next.y, T.next.w, T.next.h)} aria-label="Next" disabled={at === last} onClick={() => setAt(at + 1)}>{image('next', at !== last)}</button>
        <button class="au-tricorder-button" ref={closeButton} style={box(T.resume.x, T.resume.y, T.resume.w, T.resume.h)} aria-label="Close" onClick={close}>{image('resume', true)}</button>
      </Modal>
    );
  }
  return (
    <Modal label="Tricorder" class="au-tricorder" onEscape={close}>
      {page ? (
        <>
          <h2>{page.title}</h2>
          <h3>{page.heading}</h3>
          <p class="au-reading">{page.text}</p>
          <p>{`${at + 1} of ${dialog.pages.length}`}</p>
          <button disabled={at === 0} onClick={() => setAt(at - 1)}>Previous</button>
          <button disabled={at === last} onClick={() => setAt(at + 1)}>Next</button>
        </>
      ) : (
        <p>{dialog.reading === ALL_READINGS ? 'Tricorder: all readings' : `Tricorder reading ${dialog.reading}`}</p>
      )}
      <button ref={closeButton} onClick={close}>Close</button>
    </Modal>
  );
}

/**
 * A modal: focuses its first button when it opens, gives focus back to what had it when it closes, and Escape
 * answers it when `onEscape` is given.
 */
function Modal({ label, class: cls, data, onEscape, children }: { label: string; class?: string; data?: Record<string, string | number | undefined>; onEscape?: () => void; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  useEffect(() => {
    if (!onEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // (handled: the game's own Escape, on the window after this, leaves it alone)
      e.preventDefault();
      onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape]);
  return (
    <div class={cls ? `au-dialog ${cls}` : 'au-dialog'} role="dialog" aria-modal="true" aria-label={label} ref={box} {...data}>
      {children}
    </div>
  );
}

function DialogView({ dialog, store, tricorder }: { dialog: Dialog; store: UiStore; tricorder?: TricorderArt }) {
  const answer = (value: unknown) => () => store.answer(value);
  switch (dialog.kind) {
    case 'choice':
      return (
        <Modal label={dialog.question}>
          <p>{dialog.question}</p>
          {dialog.options.map((o, i) => <button key={o} onClick={answer(i)}>{o}</button>)}
        </Modal>
      );
    case 'menu':
      // (no Escape: the original's conversation menu has no cancel)
      return (
        <Modal label="Say" class="au-menu" data={{ 'data-conversation': dialog.conversation, 'data-situation': dialog.situation }}>
          {dialog.options.map((o, i) => <button key={i} onClick={answer(i)}>{o}</button>)}
        </Modal>
      );
    case 'prompt':
      // (Escape picks the last button: Ignore)
      return (
        <Modal label={dialog.text} onEscape={answer(dialog.buttons.length - 1)}>
          <p>{dialog.text}</p>
          {dialog.buttons.map((b, i) => <button key={b} onClick={answer(i)}>{b}</button>)}
        </Modal>
      );
    case 'tricorder':
      return <TricorderView dialog={dialog} close={answer(undefined)} art={tricorder} />;
    case 'movie':
      // (a film that ends, or can't be loaded or played, answers the scene: a broken film must never hang it)
      return (
        <Modal label="Movie" class="au-movie" onEscape={answer(undefined)}>
          {dialog.url
            ? <video src={dialog.url} autoPlay onClick={answer(undefined)} onEnded={answer(undefined)} onError={answer(undefined)} />
            : <p class="au-movie-card">{dialog.title}</p>}
          <button onClick={answer(undefined)}>Skip</button>
        </Modal>
      );
  }
}
