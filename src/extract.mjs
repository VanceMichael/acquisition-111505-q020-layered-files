import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeMemberPath } from './tar.mjs';

export class ExtractionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.code = details.code || 'EXTRACTION_FAILED';
    Object.assign(this, details);
  }
}

async function inspectRoot(root) {
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink()) throw new ExtractionError('解包根目录不能是符号链接', { code: 'UNSAFE_EXTRACT_ROOT' });
    if (!stats.isDirectory()) throw new ExtractionError('解包根目录不是目录', { code: 'UNSAFE_EXTRACT_ROOT' });
    return stats;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true, mode: 0o755 });
    return inspectRoot(root);
  }
}

/**
 * Walk from the extraction root to path, refusing to traverse any existing
 * symbolic link or non-directory component.  This makes it impossible for a
 * symlink already present on the host (or one planted earlier in this run) to
 * redirect a write outside the root.
 */
async function safeParent(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats;
    try { stats = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o755 });
      return current;
    }
    if (stats.isSymbolicLink()) throw new ExtractionError('解包路径中已存在符号链接', { code: 'UNSAFE_EXTRACT_PATH', path: current });
    if (!stats.isDirectory()) throw new ExtractionError('解包路径中已存在非目录成员', { code: 'UNSAFE_EXTRACT_PATH', path: current });
  }
  return current;
}

async function writeContained(root, path, bytes, mode) {
  const normalized = normalizeMemberPath(path);
  const segments = normalized.split('/');
  const parent = await safeParent(root, segments.slice(0, -1));
  const destination = join(parent, segments.at(-1));
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) throw new ExtractionError('解包目标已存在符号链接', { code: 'UNSAFE_EXTRACT_PATH', path: destination });
    if (existing.isDirectory()) throw new ExtractionError('解包目标已存在目录', { code: 'UNSAFE_EXTRACT_PATH', path: destination });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  // Executable bits are deliberately not copied: this receiver stores material,
  // it does not install or run it.
  const safeMode = ((mode ?? 0o644) & 0o666) | 0o600;
  let handle;
  try { handle = await open(destination, flags, safeMode); }
  catch (error) {
    if (error.code === 'ELOOP') throw new ExtractionError('解包目标已存在符号链接', { code: 'UNSAFE_EXTRACT_PATH', path: destination });
    throw error;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return destination;
}

/**
 * Materialize the current final view (by default only the selected claims)
 * under root.  Symbolic links are never created or followed; they are returned
 * as metadata so callers can reason about internal delivery relationships.
 */
export async function extractFinalView(composition, root, options = {}) {
  if (!composition || !composition.contents) throw new ExtractionError('缺少可解包的最终视图', { code: 'INVALID_COMPOSITION' });
  if (typeof root !== 'string' || root === '') throw new ExtractionError('必须指定解包根目录', { code: 'INVALID_EXTRACT_ROOT' });
  if (!isAbsolute(root)) throw new ExtractionError('解包根目录必须是绝对路径', { code: 'INVALID_EXTRACT_ROOT' });
  const base = resolve(root);
  await inspectRoot(base);

  const selectionOnly = options.selectionOnly !== false;
  const wanted = selectionOnly
    ? new Set(composition.claims.map(claim => claim.path))
    : new Set(composition.view.filter(node => node.type === 'file').map(node => node.path));

  const files = [];
  for (const [path, bytes] of composition.contents) {
    if (!wanted.has(path) || !bytes) continue;
    const node = composition.view.find(entry => entry.path === path);
    const destination = await writeContained(base, path, bytes, node?.mode);
    files.push({
      path,
      destination,
      size: bytes.length,
      sha256: node.sha256,
      layerIndex: node.layerIndex,
      layerDigest: node.layerDigest,
      ...(node.hardlinkOf ? { hardlinkOf: node.hardlinkOf, contentLayerIndex: node.contentLayerIndex, contentLayerDigest: node.contentLayerDigest } : {}),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    root: base,
    selectionOnly,
    files,
    links: composition.links.map(link => ({ ...link, materialized: false })),
    pending: composition.pending,
    // Every written path is guaranteed to be below base; expose the check so
    // callers do not have to trust path joining.
    escaped: files.filter(file => {
      const offset = relative(base, file.destination);
      return offset.startsWith('..' + sep) || offset === '..' || isAbsolute(offset);
    }).map(file => file.path),
  };
}
