import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { layerEntries, verifyLayer, LayerError } from './layer.mjs';
import { buildView, ViewError } from './layers.mjs';
import { request, decodeJson } from './transport.mjs';

export class DeliveryError extends Error {
  constructor(message, { kind = 'delivery', status = 502, layer = null, digest = null } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.kind = kind;
    this.status = status;
    this.layer = layer;
    this.digest = digest;
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const DEFAULT_LIMITS = {
  maxManifestBytes: 1048576,
  maxLayers: 64,
  maxLayerBytes: 67108864,
  maxTotalLayerBytes: 268435456,
  maxViewBytes: 268435456,
  maxExpandedLayerBytes: 536870912,
};

export async function loadAllowPrefixes() {
  const configuration = JSON.parse(await readFile(new URL('../fixtures/selection.json', import.meta.url), 'utf8'));
  if (!Array.isArray(configuration.allowedPrefixes)) throw new DeliveryError('素材白名单格式无效', { kind: 'configuration', status: 500 });
  return configuration.allowedPrefixes.filter(prefix => typeof prefix === 'string' && prefix.length > 0);
}

/**
 * Resolve a manifest or layer reference against the actual source address.
 * Cross-origin, protocol-relative and non-HTTP references are rejected so that a
 * delivery cannot redirect the receiver to a host or remote address.
 */
export function resolveSourceReference(source, href, { what = '来源链接' } = {}) {
  let base;
  try { base = new URL(source); }
  catch { throw new DeliveryError(`${what}的来源地址无效 ${JSON.stringify(source)}`, { kind: 'request', status: 400 }); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new DeliveryError(`${what}只接受 http/https 来源`, { kind: 'request', status: 400 });
  }
  if (base.username || base.password) throw new DeliveryError(`${what}来源地址不能包含凭据`, { kind: 'request', status: 400 });
  if (typeof href !== 'string' || href.length === 0) throw new DeliveryError(`${what}为空`, { kind: 'request', status: 400 });
  if (href.includes('\0') || href.startsWith('//') || href.startsWith('\\\\')) {
    throw new DeliveryError(`${what}不能指向其他主机 ${JSON.stringify(href)}`, { kind: 'request', status: 400 });
  }
  let resolved;
  try { resolved = new URL(href, base); }
  catch { throw new DeliveryError(`${what}格式无效 ${JSON.stringify(href)}`, { kind: 'request', status: 400 }); }
  if (resolved.origin !== base.origin) {
    throw new DeliveryError(`${what}不能指向其他主机 ${JSON.stringify(href)}`, { kind: 'request', status: 400 });
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new DeliveryError(`${what}只接受 http/https`, { kind: 'request', status: 400 });
  }
  if (resolved.username || resolved.password) throw new DeliveryError(`${what}不能包含凭据`, { kind: 'request', status: 400 });
  return resolved;
}

async function fetchBytes(url, { transport, maxBytes, what }) {
  let reply;
  try { reply = await transport(url.href, { redirect: 'manual' }); }
  catch (error) { throw new DeliveryError(`${what}读取失败：${error.message}`, { kind: 'unavailable' }); }
  if (reply.status < 200 || reply.status > 299) {
    throw new DeliveryError(`${what}返回 ${reply.status}`, { kind: 'unavailable', status: 502 });
  }
  if (!Buffer.isBuffer(reply.bytes)) throw new DeliveryError(`${what}没有返回字节`, { kind: 'unavailable' });
  if (reply.bytes.length > maxBytes) throw new DeliveryError(`${what}超过大小上限`, { kind: 'unavailable', status: 502 });
  return reply.bytes;
}

function normalizeManifest(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new DeliveryError('层清单不是对象', { kind: 'format', status: 422 });
  if (typeof document.image !== 'string' || document.image.length === 0) throw new DeliveryError('层清单缺少 image', { kind: 'format', status: 422 });
  if (!Array.isArray(document.orderedLayers) || document.orderedLayers.length === 0) {
    throw new DeliveryError('层清单没有 orderedLayers', { kind: 'format', status: 422 });
  }
  return document;
}

/**
 * Fetch and verify an ordered layer delivery and compute its final file view.
 *
 * Returns the public view plus non-enumerable material used by the intake to
 * persist layer and file bytes. No file is written outside the archive, and no
 * symbolic link is resolved or followed.
 */
export async function acquireDelivery({
  source,
  manifestPath = '/image/manifest',
  allowPrefixes = null,
  transport = request,
  limits = {},
} = {}) {
  const prefixes = allowPrefixes ?? await loadAllowPrefixes();
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  const manifestUrl = resolveSourceReference(source, manifestPath, { what: '层清单' });

  const manifestBytes = await fetchBytes(manifestUrl, { transport, maxBytes: bounds.maxManifestBytes, what: '层清单' });
  let document;
  try { document = decodeJson({ status: 200, bytes: manifestBytes }); }
  catch (error) { throw new DeliveryError(`层清单不是有效 JSON：${error.message}`, { kind: 'format', status: 422 }); }
  normalizeManifest(document);
  if (document.orderedLayers.length > bounds.maxLayers) throw new DeliveryError('层数量超过上限', { kind: 'format', status: 422 });

  const layers = [];
  const layerMaterial = [];
  let totalBytes = 0;

  for (let index = 0; index < document.orderedLayers.length; index += 1) {
    const declared = document.orderedLayers[index];
    if (!declared || typeof declared !== 'object') throw new DeliveryError(`第 ${index} 层描述无效`, { kind: 'format', status: 422, layer: index });
    const digest = typeof declared.digest === 'string' ? declared.digest : '';
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new DeliveryError(`第 ${index} 层摘要格式无效 ${JSON.stringify(declared.digest)}`, { kind: 'format', status: 422, layer: index });
    }
    if (!Number.isSafeInteger(declared.size) || declared.size < 0) {
      throw new DeliveryError(`第 ${index} 层大小无效`, { kind: 'format', status: 422, layer: index });
    }
    if (declared.size > bounds.maxLayerBytes) throw new DeliveryError(`第 ${index} 层超过大小上限`, { kind: 'format', status: 422, layer: index });

    const layerUrl = resolveSourceReference(source, declared.href, { what: `第 ${index} 层` });
    const bytes = await fetchBytes(layerUrl, { transport, maxBytes: bounds.maxLayerBytes, what: `第 ${index} 层` });
    totalBytes += bytes.length;
    if (totalBytes > bounds.maxTotalLayerBytes) throw new DeliveryError('层总大小超过上限', { kind: 'format', status: 422 });

    try { verifyLayer(digest, bytes, { size: declared.size }); }
    catch (error) {
      if (!(error instanceof LayerError)) throw error;
      throw new DeliveryError(`第 ${index} 层校验失败：${error.message}`, { kind: 'integrity', status: 502, layer: index, digest });
    }

    let entries;
    try { entries = layerEntries(bytes, { maxTarBytes: bounds.maxExpandedLayerBytes }); }
    catch (error) {
      if (!(error instanceof LayerError)) throw error;
      throw new DeliveryError(`第 ${index} 层无法解释：${error.message}`, { kind: 'integrity', status: 502, layer: index, digest });
    }
    layers.push({ index, digest, size: bytes.length, entries });
    layerMaterial.push({ index, digest, size: bytes.length, bytes });
  }

  let view;
  try {
    view = buildView(layers, { allowPrefixes: prefixes });
  } catch (error) {
    if (!(error instanceof ViewError)) throw error;
    throw new DeliveryError(`最终文件视图无法建立：${error.message}`, { kind: 'format', status: 422 });
  }

  // 只保留最终视图仍可见文件的内容，供归档与文件领取使用。链接目标不会被读取。
  const contents = new Map();
  const visible = new Set(view.entries.filter(entry => entry.type === 'file' && entry.sha256).map(entry => entry.sha256));
  let viewBytes = 0;
  for (const layer of layers) {
    for (const entry of layer.entries) {
      if (entry.type !== 'regular' || !Buffer.isBuffer(entry.data)) continue;
      const contentDigest = sha256(entry.data);
      if (!visible.has(contentDigest) || contents.has(contentDigest)) continue;
      viewBytes += entry.data.length;
      if (viewBytes > bounds.maxViewBytes) throw new DeliveryError('最终视图文件总大小超过上限', { kind: 'format', status: 422 });
      contents.set(contentDigest, entry.data);
    }
  }

  const summary = {
    source: new URL(source).origin,
    image: document.image,
    manifestSha256: sha256(manifestBytes),
    layers: layers.map(layer => ({ index: layer.index, digest: layer.digest, size: layer.size })),
    entries: view.entries,
    selection: view.selection,
    history: view.history,
    events: view.events,
    pending: view.pending,
  };
  if (summary.pending.length) {
    // 未决硬链接不冒充完整文件，但也不阻断其余文件视图。
    summary.incomplete = true;
  }

  Object.defineProperty(summary, 'material', {
    value: { layerBytes: layerMaterial, contents },
    enumerable: false,
  });  return summary;
}

/** Public result for one delivery, without the raw material. */
export async function collectDelivery(options) {
  return acquireDelivery(options);
}

export function viewRecord(view) {
  return { ...view };
}

export function latestDelivery(records, { source } = {}) {
  let wanted = null;
  if (source) {
    try { wanted = `delivery:${new URL(source).origin}`; }
    catch { return null; }
  }
  let best = null;
  for (const record of records) {
    if (typeof record.source !== 'string' || !record.source.startsWith('delivery:')) continue;
    if (wanted && record.source !== wanted) continue;
    if (!Array.isArray(record.versions) || record.versions.length === 0) continue;
    const version = record.versions[record.versions.length - 1];
    if (!best
      || version.receivedAt > best.version.receivedAt
      || (version.receivedAt === best.version.receivedAt && version.version > best.version.version)) {
      best = { record, version };
    }
  }
  return best;
}
