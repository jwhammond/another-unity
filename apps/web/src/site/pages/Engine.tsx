// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { Panel } from '../lcars/Panel';
import { Prose } from '../Prose';
import engine from '../content/engine.md';
import source from '../content/engine-source.md';
import aiUsage from '../content/ai-usage.md';
import { NAV } from './nav';

// (the section's own accents, through the tokens the frame class sets)
const TONE = { a1: 'var(--a1)', a2: 'var(--a2)', a3: 'var(--a3)' };

/** How the parts connect: the game's data and the art recipes meet on the stage, which runs in the browser. */
function Diagram() {
  return (
    <svg class="lc-diagram" viewBox="0 0 360 460" role="img"
      aria-label="How the engine fits together. Original game files go through the lift to become game data, which feeds the simulation. Art recipes go through the art pipeline to become published art. The simulation and the published art both feed the stage and UI, which runs in the browser.">
      <defs>
        <marker id="au-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill={TONE.a1} /></marker>
      </defs>
      <g font-family="'Barlow Semi Condensed', 'Arial Narrow', sans-serif" font-size="15">
    <g><rect x={10} y={10} width={150} height={44} rx={10} fill="none" stroke={TONE.a2} stroke-width={3} /><text x={85} y={37} text-anchor="middle" fill="var(--ink)">Original game files</text></g>
    <g><rect x={190} y={10} width={150} height={44} rx={10} fill="none" stroke={TONE.a3} stroke-width={3} /><text x={265} y={37} text-anchor="middle" fill="var(--ink)">Art recipes</text></g>
    <g><rect x={10} y={90} width={150} height={44} rx={10} fill="none" stroke={TONE.a1} stroke-width={3} /><text x={85} y={117} text-anchor="middle" fill="var(--ink)">Lift</text></g>
    <g><rect x={190} y={90} width={150} height={44} rx={10} fill="none" stroke={TONE.a1} stroke-width={3} /><text x={265} y={117} text-anchor="middle" fill="var(--ink)">Art pipeline</text></g>
    <g><rect x={10} y={170} width={150} height={44} rx={10} fill="none" stroke={TONE.a1} stroke-width={3} /><text x={85} y={197} text-anchor="middle" fill="var(--ink)">Game data</text></g>
    <g><rect x={190} y={170} width={150} height={44} rx={10} fill="none" stroke={TONE.a1} stroke-width={3} /><text x={265} y={197} text-anchor="middle" fill="var(--ink)">Published art</text></g>
    <g><rect x={10} y={250} width={150} height={44} rx={10} fill="none" stroke={TONE.a1} stroke-width={3} /><text x={85} y={277} text-anchor="middle" fill="var(--ink)">Simulation</text></g>
    <g><rect x={100} y={330} width={160} height={44} rx={10} fill="none" stroke={TONE.a1} stroke-width={3} /><text x={180} y={357} text-anchor="middle" fill="var(--ink)">Stage and UI</text></g>
    <g><rect x={100} y={405} width={160} height={44} rx={10} fill="none" stroke={TONE.a2} stroke-width={3} /><text x={180} y={432} text-anchor="middle" fill="var(--ink)">Browser</text></g>
    <path d="M85 54 L85 88" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M85 134 L85 168" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M85 214 L85 248" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M265 54 L265 88" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M265 134 L265 168" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M85 294 L85 312 L150 312 L150 328" fill="none" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M265 214 L265 312 L210 312 L210 328" fill="none" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
    <path d="M180 374 L180 403" stroke={TONE.a1} stroke-width={2} marker-end="url(#au-arrow)" />
      </g>
    </svg>
  );
}

export default function Engine() {
  return (
    <Frame section="engineering" title="The engine" code="03-2266" nav={NAV('engine')}>
      <Prose html={engine} />
      <Diagram />
      <Prose html={source} />
      <Panel tone="lavender" heading="AI usage"><Prose html={aiUsage} /></Panel>
    </Frame>
  );
}
