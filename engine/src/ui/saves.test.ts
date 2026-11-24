// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { exportSave, NAME_MAX, SaveSlots, saveName, validNameChar } from './saves';

describe('SaveSlots', () => {
  it("keeps a game's saves by slot, apart from another game's", async () => {
    const idb = new IDBFactory();
    const demo = await SaveSlots.open('demo', idb);
    const other = await SaveSlots.open('other', idb);
    await demo.put(2, '{"b":1}', { label: 'lab', screen: 'lab', savedAt: 2 });
    await demo.put(1, '{"a":1}', { label: 'corridor', screen: 'corridor', savedAt: 1 });
    await other.put(1, '{"z":1}', { label: 'x', screen: 'x', savedAt: 3 });
    expect(await demo.list()).toEqual([
      { slot: 1, label: 'corridor', screen: 'corridor', savedAt: 1 },
      { slot: 2, label: 'lab', screen: 'lab', savedAt: 2 },
    ]);
    expect(await demo.get(1)).toBe('{"a":1}');
    expect(await other.get(1)).toBe('{"z":1}');
    await demo.put(1, '{"a":2}', { label: 'corridor', screen: 'corridor', savedAt: 4 });
    expect(await demo.get(1)).toBe('{"a":2}');
    await demo.remove(2);
    expect((await demo.list()).map(m => m.slot)).toEqual([1]);
    expect(await demo.get(3)).toBeUndefined();
  });

  it('a slot-3 save from the old store loads from row 3', async () => {
    const idb = new IDBFactory();
    // (a record as the five-slot store wrote it: key game/slot, label "<screen>, <date>")
    const raw = idb.open('another-unity', 1);
    raw.onupgradeneeded = () => raw.result.createObjectStore('saves', { keyPath: 'key' });
    const db = await new Promise<IDBDatabase>(r => { raw.onsuccess = () => r(raw.result); });
    db.transaction('saves', 'readwrite').objectStore('saves').put({ key: 'demo/3', game: 'demo', slot: 3, text: '{"old":1}', label: 'lab, 1/2/2020', screen: 'lab', savedAt: 7 });
    await new Promise(r => setTimeout(r, 10));
    db.close();
    const slots = await SaveSlots.open('demo', idb);
    expect(await slots.get(3)).toBe('{"old":1}');
    expect(await slots.list()).toEqual([{ slot: 3, label: 'lab, 1/2/2020', screen: 'lab', savedAt: 7 }]);
  });

  it('slots 6-9 save and list', async () => {
    const slots = await SaveSlots.open('demo', new IDBFactory());
    for (const n of [9, 6, 7, 8]) await slots.put(n, `{"n":${n}}`, { label: saveName(n, ''), screen: 's', savedAt: n });
    expect((await slots.list()).map(m => [m.slot, m.label])).toEqual([[6, 'Save Game 6'], [7, 'Save Game 7'], [8, 'Save Game 8'], [9, 'Save Game 9']]);
    expect(await slots.get(9)).toBe('{"n":9}');
  });
});

describe('save names', () => {
  it('a name is cut at 30 characters and refused characters are dropped', () => {
    expect(NAME_MAX).toBe(30);
    expect(saveName(1, 'a'.repeat(40))).toBe('a'.repeat(30));
    expect(saveName(1, 'a@b[c\\d]e^f_g`h{i|j}k~l\u0007m')).toBe('abcdefghijklm');
    // (refused characters go before the cut, so they don't use up room)
    expect(saveName(1, '@'.repeat(5) + 'b'.repeat(30))).toBe('b'.repeat(30));
    for (const c of '@[\\]^_`{|}~\n\t') expect(validNameChar(c)).toBe(false);
    // (the console's font is ASCII: no accents, no emoji)
    for (const c of ['é', '\u{1F600}', '\u0080']) expect(validNameChar(c)).toBe(false);
    expect(saveName(1, 'caf\u00e9 \u{1F600}ok')).toBe('caf ok');
    for (const c of 'aZ09 -.,!?()\'"') expect(validNameChar(c)).toBe(true);
  });

  it('an empty name saves as Save Game N', () => {
    expect(saveName(4, '')).toBe('Save Game 4');
    expect(saveName(7, '   ')).toBe('Save Game 7');
    expect(saveName(2, '@@')).toBe('Save Game 2');
  });
});

describe('exportSave', () => {
  it('keeps the file link alive until the download has started', () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:save');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      exportSave('{}', 'demo-save.json');
      expect(click).toHaveBeenCalledOnce();
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith('blob:save');
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
      vi.useRealTimers();
    }
  });
});
