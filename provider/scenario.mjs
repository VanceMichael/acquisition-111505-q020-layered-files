export const initialState = () => ({ name: '离线终端层式交付', revision: 1 });

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/image/manifest') {
    const orderedLayers = [];
    for (let index = 0; index < 2; index++) { const raw = await readFile(new URL(`../fixtures/layer-${index}.tar.gz`, import.meta.url)); orderedLayers.push({ digest: 'sha256:' + hash(raw), size: raw.length, href: `/layers/${index}` }); }
    json(200, { image: 'gallery-a', orderedLayers }); return true;
  }
  if (/^\/layers\/[01]$/.test(url.pathname)) {
    const index = Number(url.pathname.split('/').at(-1)); if (state.missing && index === 1) { json(404, { error: '层资料尚未提供' }); return true; }
    let raw = await readFile(new URL(`../fixtures/layer-${index}.tar.gz`, import.meta.url)); if (state.corrupt && index === 1) { raw = Buffer.from(raw); raw[raw.length - 1] ^= 1; }
    bytes(200, raw, 'application/gzip'); return true;
  }
  return false;
}
