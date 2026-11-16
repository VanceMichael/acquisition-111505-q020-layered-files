import { readFile } from 'node:fs/promises';
import { request, decodeJson } from './transport.mjs';
import { decodeLayer } from './tar.mjs';
import { composeLayers } from './layers.mjs';
import { digest } from './archive.mjs';

const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
const selectionConfiguration = JSON.parse(await readFile(new URL('../fixtures/selection.json', import.meta.url), 'utf8'));

export class DeliveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.code = details.code || 'DELIVERY_FAILED';
    this.stage = details.stage || 'unknown';
    Object.assign(this, details);
  }
}

export function normalizeSource(source) {
  if (typeof source !== 'string' || source === '') throw new DeliveryError('缺少来源地址', { code: 'INVALID_SOURCE' });
  let base;
  try { base = new URL(source); }
  catch { throw new DeliveryError('来源地址不是有效 URL', { code: 'INVALID_SOURCE' }); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new DeliveryError('来源地址必须是 http 或 https', { code: 'INVALID_SOURCE' });
  if (base.username || base.password) throw new DeliveryError('来源地址不能携带凭据', { code: 'INVALID_SOURCE' });
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.search = '';
  base.hash = '';
  return base;
}

function sameOrigin(base, target) {
  return target.protocol === base.protocol && target.host === base.host;
}

/** Resolve a link relative to the actual source address; absolute links must stay on that origin. */
export function resolveSourceLink(base, reference, stage) {
  if (typeof reference !== 'string' || reference === '') throw new DeliveryError('链接为空', { code: 'INVALID_LINK', stage });
  let target;
  // Only plain HTTP(S) references are resolved; backslashes and other schemes
  // (file:, data:, …) are not rewritten into a network path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) && !/^https?:/i.test(reference)) {
    throw new DeliveryError('链接协议不受支持', { code: 'INVALID_LINK', stage });
  }
  try { target = new URL(reference, base); }
  catch { throw new DeliveryError('链接无法解析', { code: 'INVALID_LINK', stage }); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new DeliveryError('链接协议不受支持', { code: 'INVALID_LINK', stage });
  if (target.username || target.password) throw new DeliveryError('链接不能携带凭据', { code: 'INVALID_LINK', stage });
  if (!sameOrigin(base, target)) throw new DeliveryError('链接指向来源之外的地址', { code: 'OFF_ORIGIN_LINK', stage });
  return target;
}

function checkLayerDescriptor(descriptor, index) {
  const stage = `layer:${index}`;
  if (!descriptor || typeof descriptor !== 'object') throw new DeliveryError('层清单项不是对象', { code: 'INVALID_MANIFEST', stage });
  if (typeof descriptor.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)) {
    throw new DeliveryError('层摘要格式无效', { code: 'INVALID_MANIFEST', stage });
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw new DeliveryError('层大小无效', { code: 'INVALID_MANIFEST', stage });
  if (typeof descriptor.href !== 'string' || descriptor.href === '') throw new DeliveryError('层缺少链接', { code: 'INVALID_MANIFEST', stage });
}

async function fetchVerifiedLayer(base, descriptor, index, options) {
  const stage = `layer:${index}`;
  const target = resolveSourceLink(base, descriptor.href, stage);
  let reply;
  try { reply = await (options.requestImpl ?? request)(target.href); }
  catch (error) { throw new DeliveryError(`层 ${index} 无法获取`, { code: 'LAYER_UNAVAILABLE', stage, cause: error }); }
  if (reply.status < 200 || reply.status > 299) throw new DeliveryError(`层 ${index} 返回 ${reply.status}`, { code: 'LAYER_UNAVAILABLE', stage, status: reply.status });
  const bytes = reply.bytes;
  if (descriptor.size !== bytes.length) throw new DeliveryError(`层 ${index} 大小与清单不符`, { code: 'LAYER_SIZE_MISMATCH', stage, expected: descriptor.size, actual: bytes.length });
  const actual = 'sha256:' + digest(bytes);
  if (actual !== descriptor.digest) throw new DeliveryError(`层 ${index} 摘要与清单不符`, { code: 'LAYER_DIGEST_MISMATCH', stage, expected: descriptor.digest, actual });
  let entries;
  try { entries = decodeLayer(bytes, options.limits); }
  catch (error) { throw new DeliveryError(`层 ${index} 无法解析：${error.message}`, { code: 'LAYER_INVALID', stage, cause: error }); }
  return { index, digest: descriptor.digest, size: bytes.length, raw: bytes, entries };
}

/**
 * Fetch the manifest and every ordered layer, verify each layer before reading
 * it, and only then compose the final view.  Any missing or invalid layer
 * aborts the whole collection: no partial "final" report is produced and no
 * delivery record is archived.
 */
export async function collectDelivery(options = {}) {
  const base = normalizeSource(options.source);
  const requestImpl = options.requestImpl ?? request;
  const probe = options.probe ?? project.probe;
  const selection = options.selection ?? selectionConfiguration;

  const manifestUrl = resolveSourceLink(base, probe, 'manifest');
  let manifestReply;
  try { manifestReply = await requestImpl(manifestUrl.href); }
  catch (error) { throw new DeliveryError('清单无法获取', { code: 'MANIFEST_UNAVAILABLE', stage: 'manifest', cause: error }); }
  if (manifestReply.status < 200 || manifestReply.status > 299) {
    throw new DeliveryError(`清单返回 ${manifestReply.status}`, { code: 'MANIFEST_UNAVAILABLE', stage: 'manifest', status: manifestReply.status });
  }
  let manifest;
  try { manifest = decodeJson(manifestReply); }
  catch (error) { throw new DeliveryError('清单不是有效 JSON', { code: 'INVALID_MANIFEST', stage: 'manifest', cause: error }); }
  if (!manifest || !Array.isArray(manifest.orderedLayers) || manifest.orderedLayers.length === 0) {
    throw new DeliveryError('清单缺少 orderedLayers', { code: 'INVALID_MANIFEST', stage: 'manifest' });
  }
  if (typeof manifest.image !== 'string' || manifest.image === '') throw new DeliveryError('清单缺少 image', { code: 'INVALID_MANIFEST', stage: 'manifest' });
  manifest.orderedLayers.forEach(checkLayerDescriptor);

  const layers = [];
  for (let index = 0; index < manifest.orderedLayers.length; index++) {
    // Layers are read strictly bottom-first: a later layer is only fetched once
    // everything below it has been verified.
    layers.push(await fetchVerifiedLayer(base, manifest.orderedLayers[index], index, options));
  }

  let composition;
  try { composition = composeLayers(layers, selection); }
  catch (error) { throw new DeliveryError(`最终视图无法合成：${error.message}`, { code: 'COMPOSITION_FAILED', stage: 'compose', cause: error }); }

  const { contents, ...publicReport } = composition;
  const report = {
    image: manifest.image,
    source: base.href,
    manifest: { href: manifestUrl.pathname, layers: manifest.orderedLayers.map(layer => ({ digest: layer.digest, size: layer.size, href: layer.href })) },
    ...publicReport,
    complete: true,
  };
  // File bytes stay in-process only: non-enumerable so JSON responses and
  // archived receipts never embed binary content, while callers that need to
  // extract the verified view can still reach it.
  Object.defineProperty(report, 'contents', { value: contents, enumerable: false });

  if (options.archive) {
    // Archive only after every layer verified and the view composed.  The
    // receipt identity is the image plus its manifest, so repeated collections
    // of the same delivery reuse one version instead of duplicating history.
    for (const layer of layers) await options.archive.store(layer.raw);
    for (const bytes of contents.values()) await options.archive.store(bytes);
    const receipt = await options.archive.accept(
      'image',
      { image: manifest.image, manifestDigest: digest(manifestReply.bytes), layerDigests: manifest.orderedLayers.map(layer => layer.digest) },
      report,
      manifestReply.bytes,
    );
    report.archive = { receipt: receipt.receipt, version: receipt.version, duplicate: receipt.duplicate };
  }
  return report;
}
