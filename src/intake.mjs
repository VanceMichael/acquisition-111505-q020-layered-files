import { readFile } from 'node:fs/promises';
import { digest } from './archive.mjs';
import { acquireDelivery, loadAllowPrefixes, DeliveryError } from './delivery.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
export function manualRecord(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('人工收件应是对象');
  for (const field of configuration.identityFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') throw new Error(`缺少业务身份 ${field}`);
  }
  const identity = Object.fromEntries(configuration.identityFields.map(field => [field, payload[field]]));
  return { identity, data: structuredClone(payload) };
}
export async function receiveManual(archive, payload) {
  const parsed = manualRecord(payload);
  const raw = Buffer.from(JSON.stringify(payload));
  const receipt = await archive.accept('manual', parsed.identity, parsed.data, raw);
  return { ...receipt, identity: parsed.identity, rawSha256: digest(raw) };
}

/** 自动来源的收件业务身份：来源地址与镜像，内容变化保留版本。 */
export function deliveryIdentity(target, image) {
  return { source: target, image };
}

/**
 * 领取一次层式交付：取回清单、逐层校验、合并最终文件视图，并把层字节与
 * 最终文件内容一并归档。任何一层缺失或校验失败都在收件前中止，归档中不会
 * 留下一份看似完整的视图。
 */
export async function receiveDelivery(archive, target, options = {}) {
  if (typeof target !== 'string' || target.length === 0) throw new DeliveryError('缺少来源地址', { kind: 'request', status: 400 });
  let origin;
  try { origin = new URL(target).origin; }
  catch { throw new DeliveryError('来源地址无效', { kind: 'request', status: 400 }); }
  const allowPrefixes = options.allowPrefixes ?? await loadAllowPrefixes();
  const view = await acquireDelivery({ source: target, allowPrefixes, transport: options.transport, limits: options.limits });
  const identity = deliveryIdentity(origin, view.image);
  const { material } = view;
  // 只有最终视图里仍可见的普通文件才归档内容；失效文件只保留在历史证据中，
  // 层字节保留以便复核来源层，链接本身从不读取。
  const files = new Map();
  for (const entry of view.entries) {
    if (entry.type !== 'file' || !entry.sha256) continue;
    const bytes = material.contents.get(entry.sha256);
    if (bytes) files.set(entry.sha256, bytes);
  }
  const related = [...material.layerBytes.map(layer => layer.bytes), ...files.values()];
  const record = {
    kind: 'delivery',
    source: origin,
    image: view.image,
    manifestSha256: view.manifestSha256,
    layers: view.layers,
    entries: view.entries,
    selection: view.selection,
    history: view.history,
    events: view.events,
    pending: view.pending,
    ...(view.incomplete ? { incomplete: true } : {}),
  };
  const raw = Buffer.from(JSON.stringify(record));
  const receipt = await archive.accept(`delivery:${origin}`, identity, record, raw, related);
  return {
    ...receipt,
    identity,
    image: view.image,
    layers: view.layers,
    layerCount: view.layers.length,
    entryCount: view.entries.length,
    selectionCount: view.selection.length,
    historyCount: view.history.length,
    pendingCount: view.pending.length,
    ...(view.incomplete ? { incomplete: true } : {}),
  };
}
