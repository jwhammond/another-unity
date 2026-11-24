// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import { parsePresentation } from '../view/package';
import { facesFromPresentation } from './faces';

// A speaker who is not on the crew is looked up by the game's object name (the subtitle's `who`), the same way a crew member is.
const assets = new AssetIndex([
  ['art/avatars/t_bak.webp', '/u/t_bak.webp'],
  ['art/icons/communicator.webp', '/u/badge.webp'],
]);
const config = parsePresentation(`art:
  portraits:
    t_bak: art/avatars/t_bak.webp
    ship.t_bak.0401: art/avatars/t_bak.webp
    ship.lucana.0400: art/avatars/lucana.webp
  icons:
    communicator: art/icons/communicator.webp
`);
const faces = facesFromPresentation(config, assets, 'communicator');

describe('a conversation partner who is not on the crew', () => {
  it('shows the portrait recorded under their object name, not the combadge', () => {
    expect(faces.speaker('ship.t_bak.0401')).toEqual({ url: '/u/t_bak.webp', placeholder: false });
  });
  it('shows the combadge when the file is not published, or the character has no portrait', () => {
    for (const who of ['ship.lucana.0400', 'ship.avakar.0402']) expect(faces.speaker(who)).toEqual({ url: '/u/badge.webp', placeholder: true });
  });
  it('shows nothing with art off (no presentation art), as before', () => {
    expect(facesFromPresentation(parsePresentation(''), assets, 'communicator').speaker('ship.t_bak.0401')).toBeUndefined();
  });
});
