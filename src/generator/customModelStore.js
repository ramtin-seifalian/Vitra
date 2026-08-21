/**
 * Persistence for user-generated frames: the exported GLB is kept in
 * IndexedDB (blobs of a few MB are far past what localStorage takes), so the
 * generator page can hand a frame over to the try-on page, and it survives a
 * reload. Entirely local — nothing is uploaded anywhere.
 */
const DB_NAME = 'vitra';
const DB_VERSION = 1;
const STORE = 'customModels';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run one request in its own transaction, resolving only once the
 * transaction has *committed* — not merely when the request succeeded. The
 * caller navigates away right after saving, and a pending write transaction
 * is aborted by navigation, so resolving early loses the model.
 */
function transact(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onabort = tx.onerror = () => {
          db.close();
          reject(tx.error ?? request.error);
        };
      })
  );
}

/**
 * Save a generated frame.
 * @param {ArrayBuffer} glb  binary glTF of the model
 * @param {object} meta      { frameWidthMM, templeLengthMM, lensOpacity, savedAt }
 */
export function saveCustomModel(glb, meta = {}) {
  return transact('readwrite', (store) =>
    store.put({ glb, meta: { ...meta, savedAt: Date.now() } }, KEY)
  );
}

/** Load the saved frame, or null if there isn't one (or IndexedDB is blocked). */
export async function loadCustomModel() {
  try {
    return (await transact('readonly', (store) => store.get(KEY))) ?? null;
  } catch (err) {
    console.warn('[vitra] custom model unavailable', err);
    return null;
  }
}

/** Cheap existence check for deciding whether to show the "my frame" button. */
export async function hasCustomModel() {
  return (await loadCustomModel()) !== null;
}

export function clearCustomModel() {
  return transact('readwrite', (store) => store.delete(KEY));
}
