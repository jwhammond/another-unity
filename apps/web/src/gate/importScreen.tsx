// SPDX-License-Identifier: GPL-3.0-or-later
// The import screen: the player shows the game their own CD (a folder, or a disc image), and the key it gives opens the sealed game.
// Nothing leaves the device: the files are only read here, a few ranges of them, with File.slice.
import { useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { GateError } from './crypto';
import { sourceFromFiles, unlock, type CdSource } from './disc';
import type { GateParams } from './params';
import './importScreen.css';

/** The message for files that aren't the CD: it says what was given, not what was wanted (spec §4.5). */
export const WRONG_FILES = "These don't look like the A Final Unity CD.";
const MISSING = "This folder doesn't have the CD's files.";
const NO_CUE = 'Choose the .cue file with the .bin.';
const NO_BIN = 'Choose the .bin file with the .cue.';
const NO_WORKER = "This browser can't play the protected game. The demo still plays.";
const PRIVATE = 'Your files stay on this device. Nothing is uploaded.';
const UNREAD = "The files couldn't be read. Try choosing them again.";

export interface ImportScreenProps {
  params: GateParams;
  /** check.bin's bytes: the unlock is proved by opening it. */
  check: Uint8Array;
  onUnlocked(key: CryptoKey): void;
  /** False with no service worker (`?sw=0`, or a browser without one): the sealed game can't be opened, so nothing is offered. */
  workerSupported: boolean;
}

type State = { at: 'idle' } | { at: 'checking'; percent: number } | { at: 'failed'; message: string } | { at: 'done' };

function messageFor(err: unknown): string {
  if (!(err instanceof GateError)) return UNREAD;
  switch (err.code) {
    case 'missing-file': return MISSING;
    case 'no-cue': return NO_CUE;
    case 'no-bin': return NO_BIN;
    // (not a disc image at all, or one of another disc: either way, not the CD)
    case 'wrong-files': case 'unreadable': case 'not-sealed': case 'wrong-key': return WRONG_FILES;
  }
}

/** The source, its reads counted against the ranges' total: the bar moves as the ranges are read and hashed. */
function counted(src: CdSource, total: number, report: (part: number) => void): CdSource {
  let read = 0;
  return {
    label: src.label,
    has: path => src.has(path),
    async read(path, offset, length) {
      const bytes = await src.read(path, offset, length);
      read += bytes.length;
      report(Math.min(read / total, 1));
      return bytes;
    },
  };
}

/** What the player gave, by name: the folder, or the files of an image. */
function givenName(files: File[]): string {
  const folder = files.find(f => f.webkitRelativePath)?.webkitRelativePath.split('/')[0];
  return folder ? `${folder}/` : files.map(f => f.name).join(', ');
}

/** A dropped folder's files, each with its path from the folder (as a picked folder's `webkitRelativePath`). */
async function filesFromEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') });
    out.push(file);
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // (readEntries gives a batch at a time, and an empty one at the end)
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const e of batch) await filesFromEntry(e, out);
  }
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.some(e => e.isDirectory)) return [...dt.files];
  const out: File[] = [];
  for (const e of entries) await filesFromEntry(e, out);
  return out;
}

export function ImportScreen({ params, check, onUnlocked, workerSupported }: ImportScreenProps): JSX.Element {
  // (a phone or tablet has no folders to pick: a disc image from its Files app)
  const coarse = useMemo(() => window.matchMedia?.('(pointer: coarse)').matches === true, []);
  const [state, setState] = useState<State>({ at: 'idle' });
  const [given, setGiven] = useState('');
  const [over, setOver] = useState(false);
  const busy = state.at === 'checking' || state.at === 'done';
  const disabled = !workerSupported || busy;
  const total = params.ranges.reduce((n, r) => n + r.length, 0);

  async function take(files: File[]): Promise<void> {
    if (files.length === 0 || disabled) return;
    setGiven(givenName(files));
    setState({ at: 'checking', percent: 0 });
    try {
      const src = await sourceFromFiles(files);
      const key = await unlock(counted(src, total, part => setState({ at: 'checking', percent: Math.floor(part * 100) })), params, check);
      setState({ at: 'done' });
      onUnlocked(key);
    } catch (err) {
      setState({ at: 'failed', message: messageFor(err) });
    }
  }

  const picked = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = [...(input.files ?? [])];
    void take(files);
    // (the same choice again is a change too)
    try { input.value = ''; } catch { /* (a test's files can't be cleared) */ }
  };

  const message = !workerSupported ? NO_WORKER
    : state.at === 'checking' ? `Checking the files… ${state.percent}%`
    : state.at === 'done' ? 'Unlocked'
    : state.at === 'failed' ? state.message
    : '';

  return (
    <div class="au-gate" data-gate="screen" role="dialog" aria-modal="true" aria-labelledby="au-gate-title"
      onDragOver={e => { if (disabled || coarse) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        if (disabled || coarse || !e.dataTransfer) return;
        e.preventDefault();
        setOver(false);
        filesFromDrop(e.dataTransfer).then(take, () => setState({ at: 'failed', message: UNREAD }));
      }}>
      <div class={`au-gate-panel${over ? ' au-gate-over' : ''}`}>
        <h1 id="au-gate-title" class="au-gate-title">Your game CD</h1>
        <p class="au-gate-lead">
          {coarse
            ? 'The game plays from your own copy. Choose a disc image of the CD: an .iso, or a .bin with its .cue.'
            : "The game plays from your own copy. Choose the CD's folder (the CD drive itself will do) or a disc image of it, or drop either here."}
        </p>
        <div class="au-gate-choices">
          {!coarse && (
            <label class={`au-gate-choice${disabled ? ' au-gate-off' : ''}`}>
              Choose the CD folder
              <input type="file" data-gate="folder" disabled={disabled} multiple
                ref={el => { if (el) el.webkitdirectory = true; }} onChange={picked} />
            </label>
          )}
          <label class={`au-gate-choice${disabled ? ' au-gate-off' : ''}`}>
            Choose a disc image
            <input type="file" data-gate="image" accept=".iso,.bin,.cue" multiple disabled={disabled} onChange={picked} />
          </label>
        </div>
        {state.at === 'checking' && (
          <div class="au-gate-bar" role="progressbar" aria-label="Checking the files" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
            <div class="au-gate-fill" style={{ width: `${state.percent}%` }} />
          </div>
        )}
        <p class={`au-gate-message${state.at === 'failed' || !workerSupported ? ' au-gate-error' : ''}`} data-gate="message" role="status">{message}</p>
        {given && workerSupported && <p class="au-gate-given" data-gate="given">Given: {given}</p>}
        <p class="au-gate-private">{PRIVATE}</p>
      </div>
    </div>
  );
}
