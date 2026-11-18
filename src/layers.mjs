import { createHash } from 'node:crypto';

export class ViewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewError';
  }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const WHITEOUT_PREFIX = '.wh.';
const OPAQUE_MARKER = '.wh..wh..opq';
const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

export function normalizeMemberPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) throw new ViewError('成员路径无效');
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) throw new ViewError(`拒绝绝对成员路径 ${JSON.stringify(input)}`);
  const resolved = [];
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) throw new ViewError(`拒绝越界成员路径 ${JSON.stringify(input)}`);
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join('/');
}

/**
 * Describe where a link points using lexical resolution only. Nothing is read
 * through the link: an escaping or remote target is reported as not internal.
 */
export function linkRelation(path, linkTarget) {
  if (typeof linkTarget !== 'string' || linkTarget.length === 0) return { internal: false, resolved: null };
  if (linkTarget.startsWith('/') || /^[A-Za-z]:[\\/]/.test(linkTarget) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(linkTarget)) {
    return { internal: false, resolved: null };
  }
  const resolved = path.split('/').slice(0, -1);
  for (const part of linkTarget.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return { internal: false, resolved: null };
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return { internal: true, resolved: resolved.join('/') };
}

function snapshot(node) {
  return {
    path: node.path,
    type: node.type,
    layer: node.layer,
    layerDigest: node.layerDigest,
    size: node.size ?? null,
    sha256: node.sha256 ?? null,
    linkTarget: node.linkTarget ?? null,
    hardlinkTarget: node.hardlinkTarget ?? null,
    contentLayer: node.contentLayer ?? null,
    contentPath: node.contentPath ?? null,
    pending: node.pending === true,
  };
}

function reportEntry(node, allowPrefixes) {
  const entry = {
    path: node.path,
    type: node.type,
    layer: node.layer,
    layerDigest: node.layerDigest,
  };
  if (node.implicit) entry.implicit = true;
  if (node.type === 'file') {
    entry.size = node.size;
    entry.sha256 = node.sha256;
    entry.contentLayer = node.contentLayer ?? null;
    entry.contentPath = node.contentPath ?? null;
    if (node.hardlinkTarget) entry.hardlinkTarget = node.hardlinkTarget;
    entry.pending = node.pending === true;
  } else if (node.type === 'symlink') {
    entry.size = null;
    entry.sha256 = null;
    entry.pending = false;
    entry.linkTarget = node.linkTarget;
    entry.linkInternal = node.linkInternal;
    entry.linkResolved = node.linkResolved;
  } else {
    entry.size = null;
    entry.sha256 = null;
    entry.pending = false;
  }
  entry.selected = !node.implicit
    && node.type !== 'directory'
    && !node.pending
    && allowPrefixes.some(prefix => node.path === prefix.replace(/\/+$/, '') || node.path.startsWith(prefix));
  entry.claimable = entry.selected && node.type === 'file';
  return entry;
}

/**
 * Merge ordered layers into one final file view without extracting anything.
 *
 * Layer entries have the shape produced by parseTar:
 * { path, type: 'regular'|'directory'|'symlink'|'hardlink', linkname, data, mode }
 *
 * Entries are applied in layer order and, within a layer, in archive order, so the
 * result is the file view the terminal would actually see. Whiteouts (.wh.name)
 * and opaque markers (.wh..wh..opq) only hide lower layers; the markers themselves
 * never appear as files. Any content they hide is moved to `history` as evidence
 * and is not part of the current view or selection. Symbolic links are metadata
 * only and are never followed.
 */
export function buildView(layers, { allowPrefixes = [] } = {}) {
  const view = new Map();
  const history = [];
  const events = [];

  function removeSubtree(path, action, meta, { predicate = () => true, includeSelf = true } = {}) {
    const prefix = `${path}/`;
    const lower = node => node.layer < meta.layer;
    let removed = 0;
    for (const key of [...view.keys()].sort()) {
      if (key !== path && !key.startsWith(prefix)) continue;
      if (key === path && !includeSelf) continue;
      const node = view.get(key);
      if (!predicate(node)) continue;
      if (lower(node)) {
        history.push({ path: key, action, ...meta, entry: snapshot(node) });
        removed += 1;
      }
      view.delete(key);
    }
    return removed;
  }

  function ensureParents(path, layerIndex, layerDigest) {
    let current = '';
    for (const part of path.split('/').slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      const node = view.get(current);
      if (!node) {
        view.set(current, { path: current, type: 'directory', layer: layerIndex, layerDigest, implicit: true });
        continue;
      }
      if (node.type === 'directory') continue;
      // An upper member needs this path to be a directory, so the old file or
      // link at the same path cannot keep providing content.
      removeSubtree(current, 'replaced', { layer: layerIndex, layerDigest });
      view.set(current, { path: current, type: 'directory', layer: layerIndex, layerDigest, implicit: true });
    }
  }

  function ensureDirectory(path, layerIndex, layerDigest) {
    const existing = view.get(path);
    if (existing && existing.type !== 'directory') removeSubtree(path, 'replaced', { layer: layerIndex, layerDigest });
    if (!view.has(path)) view.set(path, { path, type: 'directory', layer: layerIndex, layerDigest, implicit: true });
  }

  function displace(path, layerIndex, layerDigest) {
    if (view.has(path)) removeSubtree(path, 'replaced', { layer: layerIndex, layerDigest });
  }

  function resolveHardlink(targetPath, seen = new Set()) {
    if (seen.has(targetPath)) return null;
    seen.add(targetPath);
    const target = view.get(targetPath);
    if (!target || target.type !== 'file') return null;
    if (!target.pending) return target;
    if (!target.hardlinkTarget) return null;
    return resolveHardlink(target.hardlinkTarget, seen);
  }

  function adoptHardlink(node, target) {
    node.size = target.size;
    node.sha256 = target.sha256;
    node.contentLayer = target.contentLayer ?? target.layer;
    node.contentPath = target.contentPath ?? target.path;
    node.data = target.data;
    node.pending = false;
  }

  function applyEntry(entry, layerIndex, layerDigest) {
    if (!entry || typeof entry !== 'object') throw new ViewError('层成员无效');
    if (typeof entry.path !== 'string' || entry.path.includes('\0')) throw new ViewError('成员路径无效');
    if (entry.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry.path)) throw new ViewError(`拒绝绝对成员路径 ${JSON.stringify(entry.path)}`);

    const trimmed = entry.path.replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '.') return;
    const slash = trimmed.lastIndexOf('/');
    const base = slash === -1 ? trimmed : trimmed.slice(slash + 1);
    const parent = slash === -1 ? '' : trimmed.slice(0, slash);
    const lowerOnly = node => node.layer < layerIndex;

    if (base === OPAQUE_MARKER) {
      const directory = normalizeMemberPath(parent);
      if (directory === '') throw new ViewError(`不透明标记 ${trimmed} 不能位于根目录`);
      ensureDirectory(directory, layerIndex, layerDigest);
      const removed = removeSubtree(directory, 'opaque', { layer: layerIndex, layerDigest, marker: trimmed },
        { predicate: lowerOnly, includeSelf: false });
      events.push({ action: 'opaque', path: directory, marker: trimmed, layer: layerIndex, layerDigest, removed });
      return;
    }

    if (base.startsWith(WHITEOUT_PREFIX)) {
      const targetBase = base.slice(WHITEOUT_PREFIX.length);
      if (targetBase === '' || targetBase.startsWith(WHITEOUT_PREFIX)) return; // 其他交付内部标记，不作为文件
      const target = normalizeMemberPath(parent ? `${parent}/${targetBase}` : targetBase);
      if (target === '') return;
      const removed = removeSubtree(target, 'whiteout', { layer: layerIndex, layerDigest, marker: trimmed }, { predicate: lowerOnly });
      events.push({ action: 'whiteout', path: target, marker: trimmed, layer: layerIndex, layerDigest, removed });
      return;
    }

    const path = normalizeMemberPath(trimmed);
    if (path === '') return;
    if (entry.type !== 'directory') ensureParents(path, layerIndex, layerDigest);

    if (entry.type === 'directory') {
      const existing = view.get(path);
      if (existing && existing.type !== 'directory') displace(path, layerIndex, layerDigest);
      const current = view.get(path);
      if (current) {
        // 目录条目自身不隐藏低层子项，只有不透明标记会。
        current.layer = layerIndex;
        current.layerDigest = layerDigest;
        delete current.implicit;
      } else {
        view.set(path, { path, type: 'directory', layer: layerIndex, layerDigest });
      }
      return;
    }

    if (entry.type === 'regular') {
      if (!Buffer.isBuffer(entry.data)) throw new ViewError(`成员 ${path} 缺少内容`);
      displace(path, layerIndex, layerDigest);
      view.set(path, {
        path,
        type: 'file',
        layer: layerIndex,
        layerDigest,
        size: entry.data.length,
        sha256: hash(entry.data),
        contentLayer: layerIndex,
        contentPath: path,
        data: entry.data,
        mode: entry.mode,
      });
      return;
    }

    if (entry.type === 'symlink') {
      const relation = linkRelation(path, entry.linkname);
      displace(path, layerIndex, layerDigest);
      view.set(path, {
        path,
        type: 'symlink',
        layer: layerIndex,
        layerDigest,
        linkTarget: entry.linkname ?? '',
        linkInternal: relation.internal,
        linkResolved: relation.resolved,
      });
      return;
    }

    if (entry.type === 'hardlink') {
      const targetPath = normalizeMemberPath(entry.linkname ?? '');
      if (targetPath === '') throw new ViewError(`成员 ${path} 的硬链接目标无效`);
      displace(path, layerIndex, layerDigest);
      const node = { path, type: 'file', layer: layerIndex, layerDigest, hardlinkTarget: targetPath, pending: true };
      const target = resolveHardlink(targetPath);
      if (target) adoptHardlink(node, target);
      view.set(path, node);
      return;
    }

    throw new ViewError(`成员 ${path} 类型 ${JSON.stringify(entry.type)} 不受支持`);
  }

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (!layer || !Array.isArray(layer.entries)) throw new ViewError('层成员列表无效');
    const layerIndex = Number.isInteger(layer.index) ? layer.index : index;
    for (const entry of layer.entries) applyEntry(entry, layerIndex, layer.digest ?? null);
  }

  // 硬链接目标可能在同一层内稍后才出现，最终视图确定后再解析一次。
  for (const node of view.values()) {
    if (node.type !== 'file' || !node.pending) continue;
    const target = resolveHardlink(node.hardlinkTarget);
    if (target) adoptHardlink(node, target);
  }

  const pending = [...view.values()]
    .filter(node => node.type === 'file' && node.pending)
    .sort(byPath)
    .map(node => ({
      path: node.path,
      hardlinkTarget: node.hardlinkTarget,
      layer: node.layer,
      layerDigest: node.layerDigest,
      reason: '硬链接目标在最终视图中不可用',
    }));

  const entries = [...view.values()].sort(byPath).map(node => reportEntry(node, allowPrefixes));
  return { entries, selection: entries.filter(entry => entry.selected), history, events, pending };
}
