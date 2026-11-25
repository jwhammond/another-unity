// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { Panel } from '../lcars/Panel';
import { Pill } from '../lcars/Pill';
import { Prose } from '../Prose';
import horst3 from '../content/missions/horst3.md';
import mertens from '../content/missions/mertens.md';
import allanor from '../content/missions/allanor.md';
import zoo from '../content/missions/zoo.md';
import frigis from '../content/missions/frigis.md';
import unity from '../content/missions/unity.md';
import { SubNav } from '../lcars/SubNav';
import { NAV } from './nav';
import { WorldMenu, missionHref } from './WorldMenu';
import { MISSIONS, type MissionWorld } from './missions';

const TEXT: Record<MissionWorld, string> = { horst3, mertens, allanor, zoo, frigis, unity };
const TONES = ['a1', 'a2', 'a3'] as const;
/** A mission's opening paragraph: its page's text up to the first heading, first paragraph only. */
export const lead = (html: string) => /<p>[\s\S]*?<\/p>/.exec(html.split(/<h2[ >]/)[0] ?? '')?.[0] ?? '';

/** The away missions: the six worlds as a menu at the top, then each one's opening paragraph with a link to its page. */
export default function Missions() {
  return (
    <Frame section="afu" title="Away missions" code="07-0000" nav={NAV('mission')}>
      <SubNav current="missions" />
      <WorldMenu />
      <div class="lc-hub">
        {MISSIONS.map((m, i) => (
          <Panel key={m.world} tone={TONES[i % 3]!} heading={m.name}>
            <Prose html={lead(TEXT[m.world])} />
            <Pill tone={TONES[i % 3]!} href={missionHref(m.world)}>Open</Pill>
          </Panel>
        ))}
      </div>
    </Frame>
  );
}
