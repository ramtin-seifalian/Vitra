// Copies the MediaPipe tasks-vision WASM runtime from node_modules into
// public/, so the app serves it from the same origin instead of depending on
// a third-party CDN at runtime (fewer moving parts for a production
// WooCommerce install, and works in network setups that block CDNs).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = join(root, 'public/mediapipe/wasm');

if (!existsSync(src)) {
  console.warn('[copy-mediapipe-wasm] source not found, skipping:', src);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[copy-mediapipe-wasm] copied', src, '->', dest);
