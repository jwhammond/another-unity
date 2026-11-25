// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { Prose } from '../Prose';
import text from '../content/afu-tactical.md';
import { SubNav } from '../lcars/SubNav';
import { NAV } from './nav';

/** The tactical updates: space combat as it was kept, and what is new around it. */
export default function Tactical() {
  return (
    <Frame section="afu" title="Tactical" code="05-0066" nav={NAV('tactical')}>
      <SubNav current="tactical" />
      <Prose html={text} />
    </Frame>
  );
}
