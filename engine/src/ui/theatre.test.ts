// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { setTheatre, THEATRE_CLASS } from './theatre';

describe('theatre mode', () => {
  it('sets and clears the body class', () => {
    const off = setTheatre(document, true);
    expect(document.body.classList.contains(THEATRE_CLASS)).toBe(true);
    off();
    expect(document.body.classList.contains(THEATRE_CLASS)).toBe(false);
    setTheatre(document, true);
    setTheatre(document, false);
    expect(document.body.classList.contains(THEATRE_CLASS)).toBe(false);
  });
});
