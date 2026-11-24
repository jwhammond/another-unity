// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'preact/hooks';
import type { ShipPort } from '../../web/shipPort';

export function usePort(port: ShipPort): void {
  const [, setRevision] = useState(0);
  useEffect(() => port.subscribe(() => setRevision(n => n + 1)), [port]);
}

/** Runs a port action; a refusal ("wait until nothing is happening") is shown, not thrown. */
export function useAttempt(): [string | null, (run: () => Promise<void>) => void] {
  const [problem, setProblem] = useState<string | null>(null);
  return [problem, run => {
    setProblem(null);
    run().catch((err: unknown) => {
      console.warn(err);
      setProblem(err instanceof Error ? err.message : String(err));
    });
  }];
}
