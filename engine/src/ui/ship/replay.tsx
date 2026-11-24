// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'preact/hooks';
import type { ShipPort } from '../../web/shipPort';

/**
 * The bridge's Replay (UnityEngine::showConversationLog, talk.cpp:232-256): the previous conversations to choose from,
 * then the chosen one's lines in the transcript box.
 */
export function ReplayPanel({ port, close }: { port: ShipPort; close: () => void }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const log = port.conversationLog();
  if (log.length === 0) {
    return (
      <div class="au-panel au-ship-replay" role="dialog" aria-label="Replay">
        <p>No records</p>
        <button type="button" onClick={close}>Close</button>
      </div>
    );
  }
  if (chosen !== null && log[chosen]) {
    return (
      <div class="au-panel au-ship-replay" role="dialog" aria-label="Replay">
        <ol class="au-transcript" role="log" aria-label="Conversation transcript">
          {log[chosen].map((l, i) => <li key={i}><b>{l.speaker}:</b> {l.text}</li>)}
        </ol>
        <button type="button" onClick={() => setChosen(null)}>Back</button>
        <button type="button" onClick={close}>Close</button>
      </div>
    );
  }
  return (
    <div class="au-panel au-ship-replay" role="dialog" aria-label="Replay">
      <ul>
        {log.map((_, i) => (
          <li key={i}><button type="button" data-conversation={i} onClick={() => setChosen(i)}>{i === 0 ? 'Previous conversation' : `Conversation ${i + 1}`}</button></li>
        ))}
      </ul>
      <button type="button" onClick={close}>Close</button>
    </div>
  );
}
