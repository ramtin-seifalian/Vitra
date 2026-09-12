/**
 * Client for the GPU generation service (see `service/`).
 *
 * The endpoint and token are held in localStorage rather than baked in at
 * build time, so the same deployed page can be pointed at a GPU box that moves,
 * or at a laptop running the service in mock mode, without rebuilding. The
 * token is a shared secret for the operator's own service — it is not a
 * third-party credential, and it never leaves this browser except to the
 * endpoint the operator themselves configured.
 */

const URL_KEY = 'vitra:genServiceUrl';
const TOKEN_KEY = 'vitra:genServiceToken';

export function getServiceConfig() {
  let url = '';
  let token = '';
  try {
    url = localStorage.getItem(URL_KEY) ?? '';
    token = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // Private browsing: the fields simply start empty.
  }
  return { url: url || import.meta.env.VITE_GEN_SERVICE_URL || '', token };
}

export function setServiceConfig({ url, token }) {
  try {
    if (url != null) localStorage.setItem(URL_KEY, url.trim());
    if (token != null) localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    // Nothing to do — the values just will not persist across reloads.
  }
}

export function hasService() {
  return Boolean(getServiceConfig().url);
}

/** Is the service up, and which backend is it running? */
export async function probeService(signal) {
  const { url } = getServiceConfig();
  if (!url) throw new Error('no-service-url');
  const response = await fetch(new URL('/health', url).href, { signal });
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
}

/**
 * Send one photo, get a textured GLB back.
 *
 * @param {Blob|File} imageBlob
 * @param {{ removeBackground?: boolean, seed?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ glb: ArrayBuffer, seconds: number|null, job: string|null }>}
 */
export async function generateFromPhoto(imageBlob, options = {}) {
  const { url, token } = getServiceConfig();
  if (!url) throw new Error('no-service-url');

  const form = new FormData();
  form.append('image', imageBlob, 'photo.png');
  if (token) form.append('token', token);
  form.append('remove_background', String(options.removeBackground ?? true));
  form.append('seed', String(options.seed ?? 0));

  const response = await fetch(new URL('/generate', url).href, {
    method: 'POST',
    body: form,
    signal: options.signal,
  });

  if (!response.ok) {
    // The service reports failures as JSON; surface its reason rather than a
    // bare status code, because "CUDA out of memory" is worth seeing.
    let detail = `${response.status}`;
    try {
      const body = await response.json();
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // Not JSON; the status is all there is.
    }
    throw new Error(String(detail));
  }

  const glb = await response.arrayBuffer();
  if (glb.byteLength < 20) throw new Error('empty-response');
  return {
    glb,
    seconds: Number(response.headers.get('X-Vitra-Seconds')) || null,
    job: response.headers.get('X-Vitra-Job'),
  };
}
