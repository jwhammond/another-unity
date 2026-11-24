// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentType } from 'preact';
import { Frame } from '../lcars/Frame';
import { Panel } from '../lcars/Panel';
import { Pill } from '../lcars/Pill';
import { BeforeAfter } from '../lcars/BeforeAfter';
import { SpriteSheet } from '../lcars/SpriteSheet';
import { NearScreen } from '../lcars/NearScreen';
import { HotspotOverlay } from '../lcars/HotspotOverlay';
import { Prose } from '../Prose';
import horst3 from '../content/missions/horst3.md';
import mertens from '../content/missions/mertens.md';
import allanor from '../content/missions/allanor.md';
import zoo from '../content/missions/zoo.md';
import frigis from '../content/missions/frigis.md';
import unity from '../content/missions/unity.md';
import { SubNav } from '../lcars/SubNav';
import { NAV } from './nav';
import { WorldMenu } from './WorldMenu';
import { MISSIONS, missionFor, type MissionWorld } from './missions';

const TEXT: Record<MissionWorld, string> = { horst3, mertens, allanor, zoo, frigis, unity };
const CODE: Record<MissionWorld, string> = { horst3: '07-3012', mertens: '08-4140', allanor: '09-2214', zoo: '10-3030', frigis: '11-5055', unity: '12-6060' };
const EFFECT: Record<string, string> = { beam_effect: 'The transporter effect', beam_chodak: "The Chodak's beam" };
const caption = (c: string, world: string) => (c.startsWith('world.') ? `${world}: the world's own cards` : (EFFECT[c] ?? c));

/** A mission's HTML cut at its h2s: the intro, "The look" (with the intro), the room notes (with the rooms) and the rest (with the sprites). */
export function splitProse(html: string): { top: string; rooms: string; sprites: string } {
  const [intro = '', ...rest] = html.split(/(?=<h2[ >])/);
  const out = { top: intro, rooms: '', sprites: '' };
  for (const part of rest) {
    const head = /<h2[^>]*>(.*?)<\/h2>/s.exec(part)?.[1]?.replace(/<[^>]+>/g, '') ?? '';
    if (/^the look$/i.test(head)) out.top += part;
    else if (/room/i.test(head)) out.rooms += part;
    else out.sprites += part;
  }
  return out;
}
const href = (w: string) => `/engineering/afu/missions/${w}/`;

/** One away mission: its rooms before and after, the hotspots of the first room and the sprite sheets. The world comes from <body data-world>. */
const Mission: ComponentType = () => {
  const m = missionFor(document.body.dataset.world);
  if (!m)
    return (
      <Frame section="afu" title="Away missions" code="07-0000" nav={NAV('mission')}>
        <SubNav current="missions" />
        <WorldMenu />
        <Panel tone="a1" heading="No such mission">
          <p>There is no away mission by that name. <a href="/engineering/afu/">Back to A Final Unity</a></p>
        </Panel>
      </Frame>
    );
  const text = splitProse(TEXT[m.world]);
  const i = MISSIONS.indexOf(m);
  const prev = MISSIONS[i - 1];
  const next = MISSIONS[i + 1];
  return (
    <Frame section="afu" title={m.name} code={CODE[m.world]} nav={NAV('mission')}>
      <SubNav current="missions" />
      <WorldMenu current={m.world} />
      <Prose html={text.top} />
      <Panel tone="a1" heading="The rooms">
        {text.rooms && <Prose html={text.rooms} />}
        {m.rooms.map(r => (
          <div key={r} class="lc-room">
            <h3 class="lc-label">Room {r.slice(1).toUpperCase()}</h3>
            <NearScreen ratio="960 / 600"><BeforeAfter id={`room.${m.gameWorld}.${r}`} before="Original" after="Remastered" /></NearScreen>
          </div>
        ))}
      </Panel>
      <Panel tone="a2" heading="Hotspots">
        <HotspotOverlay id={`hotspots.${m.gameWorld}.${m.rooms[0]}`} />
      </Panel>
      <Panel tone="a3" heading="Sprites">
        {text.sprites && <Prose html={text.sprites} />}
        {m.cards.map(c => <SpriteSheet key={c} id={`sheet.${c}`} caption={caption(c, m.name)} />)}
      </Panel>
      <div class="lc-pager">
        {prev ? <Pill href={href(prev.world)} tone="a1">{`Previous: ${prev.name}`}</Pill> : <Pill href="/engineering/afu/" tone="a1">A Final Unity</Pill>}
        {next ? <Pill href={href(next.world)} tone="a2">{`Next: ${next.name}`}</Pill> : <Pill href="/engineering/afu/" tone="a2">A Final Unity</Pill>}
      </div>
    </Frame>
  );
};
export default Mission;
