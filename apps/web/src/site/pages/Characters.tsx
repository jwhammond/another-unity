// SPDX-License-Identifier: GPL-3.0-or-later
import { Frame } from '../lcars/Frame';
import { Figure } from '../lcars/Figure';
import { BeforeAfter } from '../lcars/BeforeAfter';
import { SpriteSheet } from '../lcars/SpriteSheet';
import { Prose } from '../Prose';
import characters from '../content/characters.md';
import sheets from '../content/characters-sheets.md';
import items from '../content/characters-items.md';
import { SubNav } from '../lcars/SubNav';
import { NAV } from './nav';

const CREW = ['picard', 'riker', 'data', 'troi', 'crusher', 'worf', 'la_forge'];
const GUESTS = ['lucana', 't_bak', 'avakar', 'pentara'];
const NAME: Record<string, string> = { la_forge: 'La Forge', t_bak: "T'Bak" };
const label = (n: string) => NAME[n] ?? n[0]!.toUpperCase() + n.slice(1);

function Heads(p: { names: string[] }) {
  return (
    <div class="lc-heads">
      {p.names.map(n => (
        <div key={n}>
          <BeforeAfter id={`portrait.${n}`} before="Original" after="Remastered" />
          <p class="lc-head-name">{label(n)}</p>
        </div>
      ))}
    </div>
  );
}

/** The characters and items: portraits before and after, sprite sheets and the kit icons. */
export default function Characters() {
  return (
    <Frame section="afu" title="Characters" code="05-2371" nav={NAV('characters')}>
      <SubNav current="characters" />
      <Prose html={characters} />
      <h3 class="lc-label">The crew</h3>
      <Heads names={CREW} />
      <h3 class="lc-label">The guests</h3>
      <Heads names={GUESTS} />
      <Prose html={sheets} />
      <SpriteSheet id="sheet.picard" caption="Captain Picard" />
      <SpriteSheet id="sheet.butler" caption="Butler" />
      <SpriteSheet id="sheet.carlstrom" caption="Carlstrom" />
      <Prose html={items} />
      <Figure id="icons" alt="The kit icons: communicator, medical kit, medical tricorder, phaser and tricorder" ratio="26/5" pixelated />
    </Frame>
  );
}
