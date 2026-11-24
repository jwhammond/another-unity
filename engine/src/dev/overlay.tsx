// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'preact/hooks';
import type { World } from '../sim/world';
import type { DebugView } from '../view/stage';
import { CombatPanel } from './combatPanel';
import type { RuleTrace } from './trace';

/** What the dev tools need from the session. */
export interface DevPort {
  world(): World;
  stage: { setDebug(d: Partial<DebugView>): void; readonly debugView: DebugView };
  trace: RuleTrace;
  jump(screen: string, entrance: string): void;
  /** Problems with hot-reloaded content. */
  problems(): string[];
  restart(): void;
}

type Tab = 'trace' | 'state' | 'view' | 'combat';
const TABS: Tab[] = ['trace', 'state', 'view', 'combat'];
const DEBUG_VIEWS: (keyof DebugView)[] = ['hotspots', 'markers', 'navmesh', 'art'];
/** How many trace lines the overlay shows. */
const SHOWN = 200;

/** The dev overlay (spec §7.5), opened and closed with the backquote key. */
export function DevOverlay({ dev }: { dev: DevPort }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('trace');
  const [, setVersion] = useState(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === '`') setOpen(o => !o);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => dev.trace.subscribe(() => setVersion(v => v + 1)), [dev]);
  if (!open) return null;
  const problems = dev.problems();
  return (
    <div class="au-dev" role="region" aria-label="Dev tools">
      <nav class="au-group">
        {TABS.map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
        <button onClick={() => dev.restart()}>Restart</button>
      </nav>
      {problems.length > 0 && <ul class="au-dev-error">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
      {tab === 'trace' && <TracePanel trace={dev.trace} />}
      {tab === 'state' && <StatePanel world={dev.world()} />}
      {tab === 'view' && <ViewPanel dev={dev} />}
      {tab === 'combat' && <CombatPanel world={dev.world()} />}
    </div>
  );
}

function TracePanel({ trace }: { trace: RuleTrace }) {
  return (
    <div>
      <ol aria-label="Rule trace">
        {trace.entries.slice(-SHOWN).map((e, i) => <li key={i} class={`au-dev-${e.kind}`}>{e.tick} {e.text}</li>)}
      </ol>
      <button onClick={() => trace.clear()}>Clear</button>
    </div>
  );
}

function StatePanel({ world }: { world: World }) {
  const [filter, setFilter] = useState('');
  const s = world.state;
  const shown = filter === ''
    ? { screen: s.screen, currentActor: s.currentActor, awayTeam: s.awayTeam, awayFlags: s.awayFlags, regions: s.regions[s.screen], counters: s.counters, tick: s.tick }
    : Object.fromEntries(Object.entries(s.objects).filter(([id]) => id.includes(filter)));
  return (
    <div>
      <input aria-label="Filter objects" placeholder="object id" value={filter} onInput={e => setFilter((e.currentTarget as HTMLInputElement).value)} />
      <pre>{JSON.stringify(shown, null, 2)}</pre>
    </div>
  );
}

function ViewPanel({ dev }: { dev: DevPort }) {
  const content = dev.world().content;
  const [screen, setScreen] = useState(dev.world().state.screen);
  const markers = Object.keys(content.screens[screen]?.markers ?? {});
  const [entrance, setEntrance] = useState(markers[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const debug = dev.stage.debugView;
  return (
    <div>
      <div class="au-group">
        {DEBUG_VIEWS.map(k => (
          <label key={k}>
            <input
              type="checkbox"
              aria-label={k}
              checked={debug[k]}
              onChange={e => {
                const next: Partial<DebugView> = {};
                next[k] = (e.currentTarget as HTMLInputElement).checked;
                dev.stage.setDebug(next);
              }}
            />
            {k}
          </label>
        ))}
      </div>
      <div class="au-group">
        <select
          aria-label="Screen"
          value={screen}
          onChange={e => {
            const next = (e.currentTarget as HTMLSelectElement).value;
            setScreen(next);
            setEntrance(Object.keys(content.screens[next]?.markers ?? {})[0] ?? '');
          }}
        >
          {Object.keys(content.screens).map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <select aria-label="Entrance" value={entrance} onChange={e => setEntrance((e.currentTarget as HTMLSelectElement).value)}>
          {markers.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button
          onClick={() => {
            try {
              dev.jump(screen, entrance);
              setError(null);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Jump
        </button>
      </div>
      {error && <p class="au-dev-error">{error}</p>}
    </div>
  );
}
export { DEV_TOOLS_LABEL, GameCombat } from './gameCombat';
