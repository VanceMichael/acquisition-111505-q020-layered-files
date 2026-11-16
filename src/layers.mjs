import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const WHITEOUT = '.wh.';
const OPAQUE = '.wh..wh..opq';

export class CompositionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CompositionError';
    this.code = details.code || 'COMPOSITION_FAILED';
    Object.assign(this, details);
  }
}

export function normalizePrefixes(prefixes) {
  if (!Array.isArray(prefixes)) throw new CompositionError('白名单必须是路径数组', { code: 'INVALID_SELECTION' });
  return prefixes.map(prefix => {
    if (typeof prefix !== 'string' || prefix === '') throw new CompositionError('白名单路径无效', { code: 'INVALID_SELECTION' });
    if (prefix.startsWith('/') || /^[A-Za-z]:/.test(prefix)) throw new CompositionError('白名单路径必须是相对路径', { code: 'INVALID_SELECTION' });
    const segments = prefix.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.includes('..')) throw new CompositionError('白名单路径不能越过根目录', { code: 'INVALID_SELECTION' });
    if (!segments.length) throw new CompositionError('白名单路径无效', { code: 'INVALID_SELECTION' });
    return segments.join('/') + (prefix.endsWith('/') ? '/' : '');
  });
}

export function isSelected(path, prefixes) {
  return prefixes.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(prefix + '/'));
}

function describe(node) {
  if (!node) return null;
  const described = { path: node.path, type: node.type, layerIndex: node.layerIndex, layerDigest: node.layerDigest };
  if (node.type === 'file') {
    described.sha256 = node.sha256;
    described.size = node.size;
    described.mode = node.mode;
    if (node.hardlinkOf) {
      described.hardlinkOf = node.hardlinkOf;
      described.contentLayerIndex = node.contentLayerIndex;
      described.contentLayerDigest = node.contentLayerDigest;
    }
  } else if (node.type === 'symlink') {
    described.target = node.target;
    described.internal = node.internal;
    if (node.internal) described.resolvedPath = node.resolvedPath;
  } else if (node.type === 'hardlink') {
    described.target = node.target;
    described.pending = true;
  }
  return described;
}

function parentsOf(path) {
  const segments = path.split('/');
  const parents = [];
  for (let index = 1; index < segments.length; index++) parents.push(segments.slice(0, index).join('/'));
  return parents;
}

function fileNode(entry, layer) {
  return {
    path: entry.path, type: 'file', mode: entry.mode, mtime: entry.mtime,
    bytes: entry.bytes, size: entry.bytes.length, sha256: sha256(entry.bytes),
    layerIndex: layer.index, layerDigest: layer.digest,
  };
}

function directoryNode(path, layer) {
  return { path, type: 'directory', mode: 0o755, mtime: layer.mtime ?? 0, layerIndex: layer.index, layerDigest: layer.digest };
}

function insertNode(state, node, layer, history) {
  const previous = state.get(node.path);
  if (previous && node.type === 'directory' && previous.type === 'directory') {
    // An explicit upper directory only refreshes provenance; children survive.
    state.set(node.path, { ...node, mode: node.mode || previous.mode });
    return;
  }
  if (previous) {
    if (previous.type === 'directory' && node.type !== 'directory') removeSubtree(state, node.path, layer, history, 'replaced');
    history.push({
      path: node.path, action: previous.type === node.type ? 'superseded' : 'replaced',
      layerIndex: layer.index, layerDigest: layer.digest, previous: describe(previous),
    });
  }
  state.set(node.path, node);
}

function removeSubtree(state, path, layer, history, action) {
  const prefix = path + '/';
  for (const key of [...state.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const removed = state.get(key);
    state.delete(key);
    history.push({ path: key, action, layerIndex: layer.index, layerDigest: layer.digest, previous: describe(removed) });
  }
}

function removePath(state, path, layer, history, action) {
  removeSubtree(state, path, layer, history, action);
  const removed = state.get(path);
  if (removed) {
    state.delete(path);
    history.push({ path, action, layerIndex: layer.index, layerDigest: layer.digest, previous: describe(removed) });
  }
}

/**
 * Make sure every ancestor of path is a directory in the merged view.  A
 * lower-layer file or link occupying an ancestor name is replaced instead of
 * being followed or reused; the old value is kept only as history evidence.
 */
function ensureParents(state, path, layer, history) {
  for (const parent of parentsOf(path)) {
    const existing = state.get(parent);
    if (existing && existing.type === 'directory') continue;
    if (existing) {
      // File, symlink and pending hardlink ancestors are never reused or
      // followed; the upper layer says this name is a directory now.
      state.delete(parent);
      history.push({ path: parent, action: 'replaced', layerIndex: layer.index, layerDigest: layer.digest, previous: describe(existing) });
    }
    state.set(parent, directoryNode(parent, layer));
  }
}

/**
 * Whiteout markers only hide lower-layer content; they do not invent new
 * files.  But if a lower-layer file or link occupies an ancestor name, the
 * marker's directory location implies that name is a directory in this layer,
 * so the old value is replaced rather than followed.  Returns false when the
 * marker's directory does not exist at all (nothing can be hidden).
 */
function replaceAncestorConflicts(state, path, layer, history) {
  const parents = parentsOf(path);
  const missing = parents.findIndex(parent => !state.has(parent));
  if (missing !== -1) {
    // An ancestor is absent, so the marker's directory does not exist and has
    // nothing to hide.  Do not create directories from a marker alone.
    return false;
  }
  for (const parent of parents) {
    const existing = state.get(parent);
    if (!existing) return false;
    if (existing.type === 'directory') continue;
    state.delete(parent);
    history.push({ path: parent, action: 'replaced', layerIndex: layer.index, layerDigest: layer.digest, previous: describe(existing) });
    // Everything below the replaced name is gone with it.
    removeSubtree(state, parent, layer, history, 'replaced');
    state.set(parent, directoryNode(parent, layer));
  }
  return true;
}

function resolveHardlinks(state, layer) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (const node of state.values()) {
      // Only links introduced by the layer being applied may resolve against
      // the view that existed when it was applied.  A link whose target only
      // arrives in a later layer stays pending instead of silently picking up
      // content that the link cannot have referred to.
      if (node.type !== 'hardlink' || node.resolved || node.layerIndex !== layer.index) continue;
      const visited = new Set([node.path]);
      let targetPath = node.target;
      let target = state.get(targetPath);
      let cyclic = false;
      // Follow chained hard links only inside this layer: a link never
      // acquires content from a chain that was pending when its own layer was
      // applied.
      while (target && target.type === 'hardlink') {
        if (target.layerIndex !== layer.index) break;
        if (visited.has(target.path)) { cyclic = true; break; }
        visited.add(target.path);
        targetPath = target.target;
        target = state.get(targetPath);
      }
      if (cyclic || !target || target.type !== 'file') continue;
      node.type = 'file';
      node.resolved = true;
      node.bytes = target.bytes;
      node.size = target.size;
      node.sha256 = target.sha256;
      node.mode = node.mode || target.mode;
      node.hardlinkOf = target.hardlinkOf ?? target.path;
      node.contentLayerIndex = target.contentLayerIndex ?? target.layerIndex;
      node.contentLayerDigest = target.contentLayerDigest ?? target.layerDigest;
      changed = true;
    }
  }
}

function classifyEntries(entries) {
  const opaqueDirectories = [];
  const whiteouts = [];
  const regular = [];
  for (const entry of entries) {
    const base = entry.path.split('/').pop();
    if (!base.startsWith(WHITEOUT)) { regular.push(entry); continue; }
    const directory = entry.path.slice(0, Math.max(0, entry.path.length - base.length - 1));
    if (base === OPAQUE) { opaqueDirectories.push(directory); continue; }
    if (base.startsWith('.wh..wh.')) continue; // implementation metadata, never a file
    const victim = base.slice(WHITEOUT.length);
    if (!victim) continue;
    whiteouts.push(directory ? `${directory}/${victim}` : victim);
  }
  return { opaqueDirectories, whiteouts, regular };
}

function applyLayer(state, layer, history) {
  const { opaqueDirectories, whiteouts, regular } = classifyEntries(layer.entries);
  // Directories that this layer's own entries prove exist.
  const impliedDirectories = new Set();
  for (const entry of regular) {
    for (const parent of parentsOf(entry.path)) impliedDirectories.add(parent);
    if (entry.type === 'directory') impliedDirectories.add(entry.path);
  }

  // Marker semantics describe how this layer masks lower layers.  They are
  // applied before this layer's own entries, so an upper entry for the same
  // name always survives regardless of archive order.  A marker alone never
  // creates a new path; it only masks what lower layers already provided.
  for (const directory of opaqueDirectories) {
    if (!directory) {
      for (const key of [...state.keys()]) {
        const removed = state.get(key);
        state.delete(key);
        history.push({ path: key, action: 'opaque', layerIndex: layer.index, layerDigest: layer.digest, previous: describe(removed) });
      }
      continue;
    }
    const existing = state.get(directory);
    if (existing && existing.type !== 'directory') {
      removePath(state, directory, layer, history, 'opaque');
    } else if (!existing && !impliedDirectories.has(directory)) {
      continue; // Nothing below this name and this layer does not define it.
    }
    state.set(directory, directoryNode(directory, layer));
    const prefix = directory + '/';
    for (const key of [...state.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const removed = state.get(key);
      state.delete(key);
      history.push({ path: key, action: 'opaque', layerIndex: layer.index, layerDigest: layer.digest, previous: describe(removed) });
    }
  }

  for (const victim of whiteouts) {
    if (!replaceAncestorConflicts(state, victim, layer, history)) continue;
    removePath(state, victim, layer, history, 'deleted');
  }

  for (const entry of regular) {
    ensureParents(state, entry.path, layer, history);
    if (entry.type === 'directory') {
      insertNode(state, directoryNode(entry.path, layer), layer, history);
    } else if (entry.type === 'file') {
      insertNode(state, fileNode(entry, layer), layer, history);
    } else if (entry.type === 'symlink') {
      insertNode(state, {
        path: entry.path, type: 'symlink', mode: entry.mode, mtime: entry.mtime, size: 0,
        target: entry.target, internal: entry.internal, resolvedPath: entry.resolvedPath,
        layerIndex: layer.index, layerDigest: layer.digest,
      }, layer, history);
    } else if (entry.type === 'hardlink') {
      insertNode(state, {
        path: entry.path, type: 'hardlink', mode: entry.mode, mtime: entry.mtime, size: 0,
        target: entry.target, pending: true, resolved: false,
        layerIndex: layer.index, layerDigest: layer.digest,
      }, layer, history);
    }
  }
  resolveHardlinks(state, layer);
}

/**
 * Merge already-parsed layer entries into the final file view.  Layers must be
 * supplied bottom-first ("orderedLayers").  Current entries become the view;
 * overwritten, hidden and deleted entries are returned separately as history
 * evidence and never as claims.
 */
export function composeLayers(layers, selection = {}) {
  const prefixes = normalizePrefixes(selection.allowedPrefixes ?? []);
  const state = new Map();
  const history = [];
  for (const layer of layers) applyLayer(state, layer, history);

  const ordered = [...state.values()].sort((left, right) => left.path.localeCompare(right.path));
  // Pending hard links have no readable content in the final view, so they are
  // reported separately rather than as visible entries or claims.
  const view = ordered.filter(node => node.type !== 'hardlink').map(describe);
  const pending = ordered
    .filter(node => node.type === 'hardlink')
    .map(node => ({ path: node.path, target: node.target, layerIndex: node.layerIndex, layerDigest: node.layerDigest, reason: '目标不在该层或更低的最终视图中' }));
  const links = ordered
    .filter(node => node.type === 'symlink')
    .map(node => ({
      path: node.path, target: node.target, internal: node.internal, resolvedPath: node.resolvedPath,
      layerIndex: node.layerIndex, layerDigest: node.layerDigest,
    }));
  const claims = ordered
    .filter(node => node.type === 'file' && isSelected(node.path, prefixes))
    .map(node => ({
      path: node.path,
      size: node.size,
      sha256: node.sha256,
      layerIndex: node.layerIndex,
      layerDigest: node.layerDigest,
      ...(node.hardlinkOf ? {
        hardlinkOf: node.hardlinkOf,
        contentLayerIndex: node.contentLayerIndex,
        contentLayerDigest: node.contentLayerDigest,
      } : {}),
      href: `/api/blobs/${node.sha256}`,
    }));
  const contents = new Map(ordered.filter(node => node.type === 'file').map(node => [node.path, node.bytes]));
  return {
    complete: true,
    selection: { allowedPrefixes: prefixes },
    layers: layers.map(layer => ({ index: layer.index, digest: layer.digest, size: layer.size ?? null })),
    view,
    claims,
    links,
    pending,
    history,
    contents,
  };
}
