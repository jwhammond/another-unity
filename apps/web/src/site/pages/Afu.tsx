// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { BeforeAfter } from '../lcars/BeforeAfter';
import { Prose } from '../Prose';
import approach from '../content/afu-approach.md';
import more from '../content/afu-more.md';
import { Panel } from '../lcars/Panel';
import { WorldMenu } from './WorldMenu';
import { SubNav } from '../lcars/SubNav';
import { NAV } from './nav';

export default function Afu() {
  return (
    <Frame section="afu" title="A Final Unity" code="04-1995" nav={NAV('afu')}>
      <SubNav current="approach" />
      <Prose html={approach} />
      <h2 class="lc-label">Before and after</h2>
      <BeforeAfter id="room.lab.s01" before="Original" after="Remastered" ratio="8/5" />
      <Prose html={more} />
      <Panel id="missions" tone="a2" heading="Away missions">
        <p>Each away mission's rooms, hotspots and sprites.</p>
        <WorldMenu />
      </Panel>
    </Frame>
  );
}
