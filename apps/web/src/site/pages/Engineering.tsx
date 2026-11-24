// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { Panel } from '../lcars/Panel';
import { Pill } from '../lcars/Pill';
import { Prose } from '../Prose';
import intro from '../content/engineering.md';
import { NAV } from './nav';
import { MISSIONS } from './missions';

export default function Engineering() {
  return (
    <Frame section="engineering" title="Engineering" code="02-0947" nav={NAV('engineering')}>
      <Prose html={intro} />
      <div class="lc-hub">
        <Panel tone="a1" heading="The engine">
          <p>The stack, how the parts connect, and a note on AI usage.</p>
          <Pill tone="a1" href="/engineering/engine/">Open</Pill>
        </Panel>
        <Panel tone="a2" heading="A Final Unity approach">
          <p>How the original's data was lifted and the art remade.</p>
          <Pill tone="a2" href="/engineering/afu/">Open</Pill>
        </Panel>
        <Panel tone="a3" heading="Characters &amp; items">
          <p>The crew and guests before and after, sprite sheets and the kit.</p>
          <Pill tone="a3" href="/engineering/afu/characters/">Characters &amp; items</Pill>
        </Panel>
        <Panel tone="a1" heading="The Enterprise">
          <p>The ship's screens as remade, and what is left to match.</p>
          <Pill tone="a1" href="/engineering/afu/enterprise/">The Enterprise</Pill>
        </Panel>
        <Panel tone="a2" heading="Away missions">
          <p>Each away mission's rooms, hotspots and sprites.</p>
          <div class="lc-pager">
            {MISSIONS.map((m, i) => <Pill key={m.world} tone={(['a1', 'a2', 'a3'] as const)[i % 3]!} href={`/engineering/afu/missions/${m.world}/`}>{m.name}</Pill>)}
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
