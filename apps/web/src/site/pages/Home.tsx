// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'preact/hooks';
import { Frame } from '../lcars/Frame';
import { Panel } from '../lcars/Panel';
import { Pill } from '../lcars/Pill';
import { Readout } from '../lcars/Readout';
import { Prose } from '../Prose';
import { Figure } from '../lcars/Figure';
import intro from '../content/home-intro.md';
import blurb from '../content/afu-blurb.md';
import thanks from '../content/thanks.md';
import { GameCard, launchGame } from './GameCard';
import { NAV } from './nav';
import { useMediaCount } from '../media';
import { installedTarget } from '../../legacy';

export default function Home() {
  const [open, setOpen] = useState(false);
  const rooms = useMediaCount('room.');
  // (an installed app opens the game, as its start_url says; a browser tab shows the site)
  useEffect(() => {
    const to = installedTarget(window.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches ?? false, location.pathname);
    if (to) location.replace(to);
  }, []);
  return (
    <Frame section="home" title="Another Unity" code="01-1701" nav={NAV('home')}>
      <Prose html={intro} />
      <h2 class="lc-label">Select mission</h2>
      <div class="lc-games">
        <GameCard id="afu" title="Star Trek: A Final Unity Remastered" tag="Beta · 1995" expanded={open} onToggle={() => setOpen(!open)}
          picture={<Figure id="home.afu" alt="The Enterprise bridge in the remastered game" ratio="16/9" />} />
        <GameCard id="ef" title="Star Trek: Voyager: Elite Force: The Adventure Game" tag="Coming soon" disabled
          picture={<Figure id="home.ef" alt="" ratio="16/9" />} />
      </div>
      {open && (
        <div id="afu-detail" class="lc-detail">
          <div class="lc-detail-side">
            {/* (away missions: Horst III, Mertens Station, Allanor, the zoo, Frigis and Unity; rooms with new art: the room.* entries of the site-media manifest, a dash until it is in or when there is none) */}
            <Readout rows={[['Status', 'Beta playtest'], ['Away missions', '6'], ['Rooms with new art', rooms === 'loading' || rooms === 0 ? '—' : String(rooms)]]} />
            <Pill tone="a1" onClick={() => launchGame()}>Engage</Pill>
          </div>
          <Panel tone="a3" heading="Star Trek: A Final Unity · Remastered"><Prose html={blurb} /></Panel>
        </div>
      )}
      <h2 class="lc-label">Special thanks</h2>
      <Prose html={thanks} />
    </Frame>
  );
}
