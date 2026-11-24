// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'preact/hooks';
import type { World } from '../sim/world';
import type { Faces, PanelArt, PanelSprite } from './faces';
import type { Input } from './input';
import {
  ADMIN, COMMUNICATOR, HEALTH, healthBands, INVENTORY_STRIP, inventoryPage, LEFT_ARROW, MARKER_FRAME_MS, markerRect, NO_PHASER, PANEL, panelBox,
  PHASER_GAUGE, PHASER_SQUARES, phaserSquareRect, phaserIndexAt, phaserIndexFor, phaserSettingOf, PORTRAIT, RIGHT_ARROW, slotRect, STATUS, VERB_RECTS, type PanelRect,
} from './panel';
import type { UiStore, VerbMode } from './store';

const VERB_LABELS: Record<VerbMode, string> = { walk: 'Walk', look: 'Look', use: 'Use', talk: 'Talk' };
const PHASER_SETTINGS = ['Off', 'Low', 'Medium', 'High'];

/** The panel's own picture, placed over a rectangle: hard pixels, never dragged, not read out. */
function Sprite({ art, name, rect, box, class: cls }: { art: PanelArt; name: PanelSprite; rect?: PanelRect; box?: Record<string, string>; class?: string }) {
  return <img class={cls ? `au-sprite ${cls}` : 'au-sprite'} src={art.sprite(name)} alt="" aria-hidden="true" draggable={false} style={rect ? panelBox(rect) : box} />;
}

export interface AwayPanelProps {
  world: World;
  input: Input;
  store: UiStore;
  faces: Faces;
  art: PanelArt;
  /** The status line: the verb and what is under the pointer (actionLine). */
  status: string;
  held: string | null;
  inert: boolean;
  /** Opens the admin console; absent where the session has none, and the button does nothing. */
  admin?: () => void;
}

/**
 * The away team's panel as the original draws it (drawAwayTeamUI, awayteam.cpp:866-918): the published panel in its 640 by 80 box at the
 * frame's foot, scaled with it, and a control over each of the original's rectangles (handleAwayTeamPanelClick, awayteam.cpp:797-834).
 */
export function AwayPanel(p: AwayPanelProps) {
  const { world, input, art } = p;
  const s = world.state;
  const mode = p.store.state.mode;
  const phaser = world.content.rules.items.phaser;
  return (
    <div class="au-awaypanel" {...{ inert: p.inert }} role="toolbar" aria-label="Away team">
      <Sprite art={art} name="panel" rect={PANEL} />
      <div class="au-status" style={{ ...panelBox(STATUS), background: art.colours.status }}>{p.status}</div>
      <Admin {...p} />
      <Member {...p} />
      {VERB_RECTS.map(({ mode: v, rect }) => (
        <button key={v} class="au-pb au-verb" data-verb={v} style={panelBox(rect)} aria-label={VERB_LABELS[v]} title={VERB_LABELS[v]} aria-pressed={mode === v} disabled={!input.canChangeMode} onClick={() => input.setMode(v)}>
          <Sprite art={art} name={mode === v ? `${v}_on` : v} />
        </button>
      ))}
      {/* (on the panel whatever the screen says, as the original's is; a screen that turns it off only disables it) */}
      {world.content.rules.items.communicator !== undefined && (
        <button class="au-pb au-combadge" style={panelBox(COMMUNICATOR)} aria-label="Combadge" title="Combadge" disabled={!input.canAct || !input.combadgeReady} onClick={() => void input.combadge().catch(err => p.store.set({ message: `That didn't work: ${err instanceof Error ? err.message : String(err)}` }))} />
      )}
      <Inventory {...p} />
      <Phaser {...p} hasPhaser={phaser !== undefined && s.objects[phaser]?.inventory === true && s.objects[phaser]?.active === true} />
    </div>
  );
}

/** The computer button: the original's admin console, as the panel's admin button opens it (openAdminMenu; phase4_rest.md §6.1). */
function Admin({ art, admin }: AwayPanelProps) {
  return (
    <button class="au-pb au-admin" style={panelBox(ADMIN)} aria-label="Admin" title="Admin" disabled={!admin} onClick={() => admin?.()}>
      <Sprite art={art} name="admin" />
    </button>
  );
}

/** The black box: the current member's portrait, a click the next member (kPortraitRect, selectNextAwayTeamMember), and their health beside it. */
function Member({ world, input, faces, art }: AwayPanelProps) {
  const s = world.state;
  const id = s.currentActor;
  const name = s.objects[id]?.name ?? id;
  const face = faces.portrait(id);
  const down = world.isIncapacitated(id);
  const others = s.awayTeam.filter(m => m !== id && world.isActiveAwayTeamMember(m) && s.objects[m]?.active !== false).length > 0;
  const def = world.content.objects[id]?.phaser;
  const health = healthBands(s.phaser[id]?.health ?? def?.health ?? 0, def?.health ?? 0, def?.threshold ?? 0);
  const fill = { empty: art.colours.empty, healthy: art.colours.healthy, injured: art.colours.injured };
  return (
    <>
      <button
        class="au-pb au-member"
        data-member={id}
        data-down={down ? '' : undefined}
        style={panelBox(PORTRAIT)}
        aria-label={`${name}${down ? ' (incapacitated)' : ''}: next team member`}
        title={others ? `${name}: click for the next team member` : name}
        disabled={!input.canAct}
        onClick={() => input.selectNextMember()}
      >
        {face !== undefined ? <img class="au-face au-portrait" src={face} alt="" aria-hidden="true" draggable={false} /> : <span class="au-member-name">{name}</span>}
      </button>
      <div class="au-health" style={{ ...panelBox(HEALTH), background: art.colours.separator }} aria-hidden="true">
        {health.map((b, i) => <i key={i} style={{ background: fill[b] }} />)}
      </div>
    </>
  );
}

/** Six slots, three each side of the scroll buttons, paged one item at a time (handleAwayTeamPanelClick's arrows). */
function Inventory({ world, input, faces, art, held }: AwayPanelProps) {
  const items = Object.keys(world.content.objects).filter(id => {
    const o = world.state.objects[id];
    return o !== undefined && o.inventory && o.active;
  });
  const [offset, setOffset] = useState(0);
  const page = inventoryPage(items, offset);
  return (
    // (the drop target for an object dragged in Use mode: Session.bind looks for it; the original's is the whole strip, awayteam.cpp:662)
    <div class="au-inventory au-strip" data-drop="inventory" role="group" aria-label="Inventory: drop an object here to pick it up" style={panelBox(INVENTORY_STRIP)}>
      {page.shown.map((id, i) => {
        const box = local(slotRect(i), INVENTORY_STRIP);
        if (id === undefined) return <Sprite key={`empty${i}`} art={art} name="slot" class="au-slot" box={box} />;
        const name = world.state.objects[id]!.name;
        const icon = faces.icon(id);
        return (
          <button key={id} class="au-pb au-slot" style={box} data-item={id} data-held={held === id ? '' : undefined} aria-label={name} title={name} aria-pressed={held === id} disabled={!input.canAct} onClick={() => input.clickItem(id)}>
            <Sprite art={art} name="slot" />
            {icon !== undefined ? <img class="au-face au-icon" src={icon} alt="" aria-hidden="true" draggable={false} /> : <span class="au-item-name">{name}</span>}
          </button>
        );
      })}
      <Arrow art={art} side="left" rect={local(LEFT_ARROW, INVENTORY_STRIP)} can={page.left} label="Previous items" onClick={() => setOffset(page.offset - 1)} />
      <Arrow art={art} side="right" rect={local(RIGHT_ARROW, INVENTORY_STRIP)} can={page.right} label="More items" onClick={() => setOffset(page.offset + 1)} />
    </div>
  );
}

/** A rectangle as percentages of another (a slot's box inside the strip's). */
function local([l, t, r, b]: PanelRect, [ol, ot, or, ob]: PanelRect): { left: string; top: string; width: string; height: string } {
  const pct = (v: number) => `${+(v * 100).toFixed(4)}%`;
  return { left: pct((l - ol) / (or - ol)), top: pct((t - ot) / (ob - ot)), width: pct((r - l) / (or - ol)), height: pct((b - t) / (ob - ot)) };
}

function Arrow({ art, side, rect, can, label, onClick }: { art: PanelArt; side: 'left' | 'right'; rect: ReturnType<typeof local>; can: boolean; label: string; onClick: () => void }) {
  return (
    <button class="au-pb au-arrow" data-side={side} style={rect} aria-label={label} title={label} disabled={!can} onClick={onClick}>
      {can ? (
        <>
          <Sprite art={art} name={side} class="au-off-hover" />
          <Sprite art={art} name={`${side}_lit`} class="au-on-hover" />
        </>
      ) : (
        <Sprite art={art} name={`${side}_off`} />
      )}
    </button>
  );
}

/**
 * The phaser's power bar: 16 positions, every 4 a setting; a click or a drag sets it (setPhaserFromGauge), and an animated marker shows
 * where. Without a phaser it is covered over (kSpriteNoPhaser). For the keyboard and a screen reader it is a slider of the four settings.
 */
function Phaser(p: AwayPanelProps & { hasPhaser: boolean }) {
  const { world, input, art, hasPhaser } = p;
  const [last, setLast] = useState<number | null>(null);
  const setting = world.state.phaserSetting;
  const index = phaserIndexFor(setting, last);
  const gauge = useRef<HTMLDivElement>(null);
  if (!hasPhaser) return <Sprite art={art} name="no_phaser" rect={NO_PHASER} />;
  const at = (e: PointerEvent) => {
    const box = gauge.current!.parentElement!.getBoundingClientRect();
    const x = PANEL[0] + ((e.clientX - box.left) / box.width) * (PANEL[2] - PANEL[0]);
    const i = phaserIndexAt(x);
    if (input.setPhaser(phaserSettingOf(i))) setLast(i);
  };
  // (while the pointer is over the gauge the status line names the setting under it)
  const hover = (e: PointerEvent) => {
    const box = gauge.current!.parentElement!.getBoundingClientRect();
    const x = PANEL[0] + ((e.clientX - box.left) / box.width) * (PANEL[2] - PANEL[0]);
    const to = phaserSettingOf(phaserIndexAt(x));
    if (p.store.state.phaserHover !== to) p.store.set({ phaserHover: to });
  };
  const step = (to: number) => {
    const next = Math.max(0, Math.min(3, to));
    if (input.setPhaser(next)) setLast(null);
  };
  const disabled = !input.canAct;
  return (
    <>
      <div
        ref={gauge}
        class="au-gauge"
        style={panelBox(PHASER_GAUGE)}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Phaser setting"
        aria-valuemin={0}
        aria-valuemax={3}
        aria-valuenow={setting}
        aria-valuetext={PHASER_SETTINGS[setting]}
        aria-disabled={disabled}
        onPointerDown={e => {
          if (disabled || e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          at(e);
        }}
        onPointerMove={e => {
          hover(e);
          if (!disabled && (e.buttons & 1) !== 0) at(e);
        }}
        onPointerEnter={hover}
        onPointerLeave={() => p.store.set({ phaserHover: null })}
        onKeyDown={e => {
          if (disabled) return;
          const to = { ArrowLeft: setting - 1, ArrowDown: setting - 1, ArrowRight: setting + 1, ArrowUp: setting + 1, Home: 0, End: 3 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          step(to);
        }}
      />
      {/* (the squares beyond the setting are dimmed: it reads as filled up to it) */}
      {Array.from({ length: PHASER_SQUARES }, (_, i) => i + 1).map(i => (
        <i key={i} class="au-gauge-square" data-lit={i <= index ? '' : undefined} style={panelBox(phaserSquareRect(i))} aria-hidden="true" />
      ))}
      <Marker art={art} index={index} />
    </>
  );
}

/** The marker, cycling its three frames. */
function Marker({ art, index }: { art: PanelArt; index: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % 3), MARKER_FRAME_MS);
    return () => clearInterval(t);
  }, []);
  return <Sprite art={art} name={`marker${frame}` as PanelSprite} rect={markerRect(index)} class="au-marker" />;
}
