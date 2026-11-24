// SPDX-License-Identifier: GPL-3.0-or-later
// The gate's key, kept in IndexedDB so the service worker can open the sealed files. The CryptoKey itself is stored (IndexedDB clones it);
// it is made non-extractable, so neither the page nor the worker can read its bytes back.

const DB_NAME = 'au-gate';
const STORE = 'keys';
const ID = 'unity';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  const request = idb.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
  };
  return done(request);
}

async function withStore<T>(idb: IDBFactory, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(idb);
  try {
    const tx = db.transaction(STORE, mode);
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await done(run(tx.objectStore(STORE)));
    await committed;
    return result;
  } finally {
    db.close();
  }
}

export async function saveKey(key: CryptoKey, idb: IDBFactory = indexedDB): Promise<void> {
  await withStore(idb, 'readwrite', s => s.put(key, ID));
}

/** The stored key, or undefined if the CD hasn't been checked on this machine (or the key was cleared). */
export async function loadKey(idb: IDBFactory = indexedDB): Promise<CryptoKey | undefined> {
  return (await withStore(idb, 'readonly', s => s.get(ID) as IDBRequest<CryptoKey | undefined>)) ?? undefined;
}

export async function clearKey(idb: IDBFactory = indexedDB): Promise<void> {
  await withStore(idb, 'readwrite', s => s.delete(ID));
}
