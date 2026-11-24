// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShipPort } from '../../web/shipPort';
import { ReplayPanel } from './replay';

describe('ReplayPanel', () => {
  let root: HTMLElement;
  let closed = 0;
  afterEach(() => {
    render(null, root);
    root.remove();
  });
  function show(log: { speaker: string; text: string }[][]) {
    closed = 0;
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<ReplayPanel port={{ conversationLog: () => log } as unknown as ShipPort} close={() => { closed++; }} />, root); });
  }
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('says "No records" for an empty log', () => {
    show([]);
    expect(root.textContent).toContain('No records');
    act(() => { button('Close').click(); });
    expect(closed).toBe(1);
  });

  it('lists the conversations, then shows the chosen one as speaker: text lines', () => {
    show([[{ speaker: '-A-', text: 'One.' }], [{ speaker: '-B-', text: 'Two.' }, { speaker: 'Chorus', text: 'Three.' }]]);
    expect([...root.querySelectorAll('[data-conversation]')].map(b => b.textContent)).toEqual(['Previous conversation', 'Conversation 2']);
    act(() => { button('Conversation 2').click(); });
    expect([...root.querySelectorAll('[role="log"] li')].map(li => li.textContent)).toEqual(['-B-: Two.', 'Chorus: Three.']);
    act(() => { button('Back').click(); });
    expect(root.querySelector('[data-conversation]')).not.toBeNull();
  });
});
