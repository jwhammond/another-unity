// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'preact/hooks';
import type { UiState, UiStore } from './store';

/** The store's state, re-rendering the component whenever it changes. */
export function useStore(store: UiStore): UiState {
  const [state, setState] = useState(store.state);
  useEffect(() => {
    setState(store.state);
    return store.subscribe(() => setState(store.state));
  }, [store]);
  return state;
}
