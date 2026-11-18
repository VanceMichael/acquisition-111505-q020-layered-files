import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseTar, TarError } from './tar.mjs';

export class LayerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayerError';
  }
}

/**
 * Verify a delivered layer against the digest announced in the manifest.
 * The check happens on the bytes as delivered, before any decompression.
 */
export function verifyLayer(declaredDigest, bytes, { size } = {}) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(declaredDigest || ''));
  if (!match) throw new LayerError(`层摘要格式无效 ${JSON.stringify(declaredDigest)}`);
  if (!Buffer.isBuffer(bytes)) throw new LayerError('层内容不是字节');
  if (Number.isInteger(size) && size !== bytes.length) {
    throw new LayerError(`层大小与清单不符：清单 ${size}，实际 ${bytes.length}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== match[1]) throw new LayerError(`层摘要校验失败：清单 ${match[1]}，实际 ${actual}`);
  return actual;
}

const DEFAULT_MAX_TAR_BYTES = 536870912;

export function layerEntries(bytes, { maxTarBytes = DEFAULT_MAX_TAR_BYTES } = {}) {
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: maxTarBytes }); }
  catch (error) { throw new LayerError(`层解压失败：${error.message}`); }
  try { return parseTar(tar); }
  catch (error) {
    if (error instanceof TarError) throw new LayerError(`层归档格式无效：${error.message}`);
    throw error;
  }
}
