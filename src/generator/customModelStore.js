/**
 * Persistence for user-generated frames: the exported GLB is kept in
 * IndexedDB (blobs of a few MB are far past what localStorage takes), so the
 * generator page can hand a frame over to the try-on page, and it survives a
 * reload. Entirely local — nothing is uploaded anywhere.
 */
// A synchronous marker mirroring "IndexedDB holds a model". Reading the GLB
// back takes a database round-trip that races the try-on page's 3D bundle for
// the main thread, which left the user staring at a page with no sign of the
// frame they had just generated. localStorage answers "is there one?"
// instantly; IndexedDB still stores the model itself.
const FLAG_KEY = 'vitra:hasCustomModel';

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
export async function saveCustomModel(glb, meta = {}) {
  const result = await transact('readwrite', (store) =>
    store.put({ glb, meta: { ...meta, savedAt: Date.now() } }, KEY)
  );
  setFlag(true);
  return result;
}

function setFlag(present) {
  try {
    if (present) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    // Private browsing, or storage disabled: callers fall back to the async
    // check, which is slower but still correct.
  }
}

/**
 * Instant, synchronous answer to "has a frame been generated?". May be stale
 * in one direction only — it can claim a model exists that IndexedDB has since
 * lost — so loading still has to handle a missing record.
 */
export function hasCustomModelFlag() {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
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
  const present = (await loadCustomModel()) !== null;
  setFlag(present);
  return present;
}

export async function clearCustomModel() {
  const result = await transact('readwrite', (store) => store.delete(KEY));
  setFlag(false);
  return result;
}
