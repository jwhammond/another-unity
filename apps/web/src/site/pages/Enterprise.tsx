// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { Figure } from '../lcars/Figure';
import { Panel } from '../lcars/Panel';
import { Prose } from '../Prose';
import intro from '../content/enterprise-intro.md';
import bridge from '../content/enterprise-bridge.md';
import astrogation from '../content/enterprise-astrogation.md';
import transporter from '../content/enterprise-transporter.md';
import engineering from '../content/enterprise-engineering.md';
import holodeck from '../content/enterprise-holodeck.md';
import computer from '../content/enterprise-computer.md';
import { SubNav } from '../lcars/SubNav';
import { NAV } from './nav';

/** The ship's screens as remade: each station says what matches the original and what remains. */
export default function Enterprise() {
  return (
    <Frame section="afu" title="The Enterprise" code="06-1864" nav={NAV('enterprise')}>
      <SubNav current="enterprise" />
      <Prose html={intro} />
      <Panel tone="a1" heading="Bridge">
        <Prose html={bridge} />
        <Figure id="ship.bridge" alt="The bridge screen of the remake" ratio="4/3" />
        <Figure id="ship.viewscreen" alt="The viewscreen screen of the remake" ratio="4/3" />
      </Panel>
      <Panel tone="a2" heading="Astrogation">
        <Prose html={astrogation} />
        <Figure id="ship.astrogation.screen" alt="The astrogation screen of the remake, as a player sees it: the sector map, the panels and the information box" ratio="4/3" />
        <Prose html={computer} />
        <Figure id="ship.computer" alt="The computer screen of the remake" ratio="4/3" />
      </Panel>
      <Panel tone="a3" heading="Transporter">
        <Prose html={transporter} />
        <Figure id="ship.transporter" alt="The transporter screen of the remake" ratio="4/3" />
      </Panel>
      <Panel tone="a1" heading="Engineering">
        <Prose html={engineering} />
        <Figure id="ship.engineering" alt="The engineering screen of the remake, as a player sees it" ratio="4/3" />
      </Panel>
      <Panel tone="a2" heading="Holodeck">
        <Prose html={holodeck} />
        <Figure id="ship.holodeck" alt="The holodeck screen of the remake, as a player sees it" ratio="4/3" />
      </Panel>
    </Frame>
  );
}
