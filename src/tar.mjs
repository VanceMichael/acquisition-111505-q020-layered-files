import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
const DEFAULT_MAX_LAYER_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100000;

export class LayerFormatError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LayerFormatError';
    this.code = details.code || 'LAYER_INVALID';
    Object.assign(this, details);
  }
}

function numeric(header, offset, length) {
  const first = header[offset];
  if (first & 0x80) {
    // GNU base-256 encoding.  The top bit is a marker, the remaining bits are
    // an unsigned big-endian integer for the fields this receiver uses.
    let value = 0n;
    for (let index = offset + 1; index < offset + length; index++) value = (value << 8n) | BigInt(header[index]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new LayerFormatError('tar 数值超出安全范围', { code: 'UNSAFE_TAR_NUMBER' });
    return Number(value);
  }
  const text = header.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new LayerFormatError('tar 数值格式无效', { code: 'INVALID_TAR_NUMBER' });
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new LayerFormatError('tar 数值超出安全范围', { code: 'UNSAFE_TAR_NUMBER' });
  return value;
}

function checksum(header) {
  const expected = numeric(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index++) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (expected !== unsigned && expected !== signed) {
    throw new LayerFormatError('tar 头校验和无效', { code: 'INVALID_TAR_CHECKSUM' });
  }
}

function text(header, offset, length) {
  const end = header.indexOf(0, offset);
  const bounded = end === -1 || end > offset + length ? header.subarray(offset, offset + length) : header.subarray(offset, end);
  return bounded.toString('utf8');
}

function paxRecords(bytes) {
  const values = {};
  let offset = 0;
  while (offset < bytes.length) {
    // PAX record lengths and offsets are byte counts, not UTF-16 code units.
    const space = bytes.indexOf(0x20, offset);
    if (space === -1 || space === offset) throw new LayerFormatError('PAX 记录缺少长度', { code: 'INVALID_PAX' });
    const lengthText = bytes.subarray(offset, space).toString('latin1');
    if (!/^[0-9]+$/.test(lengthText)) throw new LayerFormatError('PAX 记录长度无效', { code: 'INVALID_PAX' });
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) {
      throw new LayerFormatError('PAX 记录长度无效', { code: 'INVALID_PAX' });
    }
    const record = bytes.subarray(space + 1, offset + length).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new LayerFormatError('PAX 记录缺少键值', { code: 'INVALID_PAX' });
    values[record.slice(0, equals)] = record.slice(equals + 1).replace(/\n$/, '');
    offset += length;
  }
  return values;
}

/**
 * Normalize a tar member name using POSIX semantics.  Tar names are always
 * slash-separated, even when the receiving host is not.  Absolute names,
 * parent traversal, empty names and control characters are rejected.
 */
export function normalizeMemberPath(raw, { allowRoot = false } = {}) {
  if (typeof raw !== 'string') throw new LayerFormatError('tar 成员名不是字符串', { code: 'UNSAFE_TAR_PATH' });
  if (raw.includes('\0')) throw new LayerFormatError('tar 成员名包含 NUL', { code: 'UNSAFE_TAR_PATH' });
  // Tar names are slash-separated; a backslash is a host path separator on
  // some systems and must never be reinterpreted as one here.
  if (raw.includes('\\')) throw new LayerFormatError('tar 成员名包含反斜杠', { code: 'UNSAFE_TAR_PATH' });
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new LayerFormatError('tar 成员名不能是绝对路径', { code: 'UNSAFE_TAR_PATH' });
  const segments = raw.split('/');
  const kept = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new LayerFormatError('tar 成员名不能越过根目录', { code: 'UNSAFE_TAR_PATH' });
    if (/[\u0000-\u001f\u007f]/.test(segment)) throw new LayerFormatError('tar 成员名包含控制字符', { code: 'UNSAFE_TAR_PATH' });
    kept.push(segment);
  }
  if (kept.length === 0) {
    if (allowRoot) return '';
    throw new LayerFormatError('tar 成员名为空', { code: 'UNSAFE_TAR_PATH' });
  }
  return kept.join('/');
}

/**
 * Resolve a link target inside the delivery root without touching the host
 * filesystem.  Returns { internal, path }.  A symlink that points outside is
 * retained as metadata but is never followed.
 */
export function resolveInternalLink(memberPath, target) {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) return { internal: false, path: null };
  if (target.includes('\\')) return { internal: false, path: null };
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target) || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return { internal: false, path: null };
  }
  const segments = memberPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { internal: false, path: null };
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return { internal: true, path: segments.join('/') };
}

function normalizeHardlinkTarget(raw) {
  return normalizeMemberPath(raw, { allowRoot: false });
}

function decodeHeader(header, state) {
  checksum(header);
  let name = text(header, 0, 100);
  const prefix = text(header, 345, 155);
  if (prefix) name = `${prefix}/${name}`;
  const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
  let size = numeric(header, 124, 12);
  let linkname = text(header, 157, 100);
  const pax = { ...state.globalPax, ...state.nextPax };
  if (pax.path !== undefined) name = pax.path;
  if (pax.linkpath !== undefined) linkname = pax.linkpath;
  if (pax.size !== undefined) {
    const parsed = Number(pax.size);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LayerFormatError('PAX size 无效', { code: 'INVALID_PAX' });
    size = parsed;
  }
  return {
    name,
    typeflag,
    size,
    linkname,
    mode: numeric(header, 100, 8),
    mtime: numeric(header, 136, 12),
    uid: numeric(header, 108, 8),
    gid: numeric(header, 116, 8),
  };
}

/**
 * Parse an uncompressed tar archive.  Only regular files, directories,
 * symbolic links and hard links are accepted.  Device nodes, FIFOs and other
 * executable/special members are rejected instead of being materialized.
 */
export function parseTar(buffer, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Buffer.isBuffer(buffer)) throw new LayerFormatError('tar 内容不是字节');
  const entries = [];
  const state = { globalPax: {}, nextPax: {} };
  let offset = 0;
  let zeroBlocks = 0;
  let complete = false;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      offset += BLOCK;
      zeroBlocks++;
      if (zeroBlocks >= 2) { complete = true; break; }
      continue;
    }
    zeroBlocks = 0;
    const decoded = decodeHeader(header, state);
    state.nextPax = {};
    offset += BLOCK;

    const dataLength = Math.ceil(decoded.size / BLOCK) * BLOCK;
    if (decoded.size > maxFileBytes) throw new LayerFormatError('tar 成员过大', { code: 'TAR_MEMBER_TOO_LARGE' });
    if (offset + dataLength > buffer.length) throw new LayerFormatError('tar 数据被截断', { code: 'TRUNCATED_TAR' });
    const data = buffer.subarray(offset, offset + decoded.size);
    offset += dataLength;

    if (decoded.typeflag === 'x' || decoded.typeflag === 'g' || decoded.typeflag === 'L' || decoded.typeflag === 'K') {
      if (decoded.typeflag === 'x') state.nextPax = paxRecords(data);
      else if (decoded.typeflag === 'g') state.globalPax = { ...state.globalPax, ...paxRecords(data) };
      else {
        const longValue = data.toString('utf8').replace(/\0.*$/, '');
        if (decoded.typeflag === 'L') state.nextPax = { ...state.nextPax, path: longValue };
        else state.nextPax = { ...state.nextPax, linkpath: longValue };
      }
      continue;
    }
    if (decoded.typeflag === 'V' || decoded.typeflag === 'D') continue;

    let type;
    if (decoded.typeflag === '0' || decoded.typeflag === '7') type = 'file';
    else if (decoded.typeflag === '5') type = 'directory';
    else if (decoded.typeflag === '2') type = 'symlink';
    else if (decoded.typeflag === '1') type = 'hardlink';
    else if (decoded.typeflag === '3' || decoded.typeflag === '4' || decoded.typeflag === '6' || decoded.typeflag === '9') {
      throw new LayerFormatError(`不支持 tar 成员类型 ${decoded.typeflag}`, { code: 'UNSUPPORTED_TAR_MEMBER' });
    } else {
      throw new LayerFormatError(`未知 tar 成员类型 ${decoded.typeflag}`, { code: 'UNSUPPORTED_TAR_MEMBER' });
    }

    const path = normalizeMemberPath(decoded.name, { allowRoot: type === 'directory' });
    if (!path) continue; // Archive root directory entry.
    if (type === 'file' && data.length !== decoded.size) throw new LayerFormatError('tar 文件数据不完整', { code: 'TRUNCATED_TAR' });
    if (type === 'symlink' || type === 'hardlink') {
      if (!decoded.linkname) throw new LayerFormatError('链接成员缺少目标', { code: 'INVALID_TAR_LINK' });
      if (type === 'hardlink') {
        let target;
        try { target = normalizeHardlinkTarget(decoded.linkname); }
        catch (error) { throw new LayerFormatError('硬链接目标越出交付根目录', { code: 'UNSAFE_TAR_LINK', cause: error }); }
        entries.push({ path, type, mode: decoded.mode, mtime: decoded.mtime, size: 0, target });
      } else {
        const resolved = resolveInternalLink(path, decoded.linkname);
        entries.push({
          path, type, mode: decoded.mode, mtime: decoded.mtime, size: 0,
          target: decoded.linkname, internal: resolved.internal, resolvedPath: resolved.path,
        });
      }
    } else {
      entries.push({
        path, type, mode: decoded.mode, mtime: decoded.mtime,
        size: type === 'file' ? decoded.size : 0,
        bytes: type === 'file' ? Buffer.from(data) : undefined,
      });
    }
    if (entries.length > maxEntries) throw new LayerFormatError('tar 成员数量过多', { code: 'TOO_MANY_TAR_ENTRIES' });
  }
  // A properly terminated archive may contain zero members; a truncated one
  // may not be mistaken for a complete layer.
  if (!complete) throw new LayerFormatError('tar 结尾不完整', { code: 'TRUNCATED_TAR' });
  return entries;
}

/**
 * A delivered layer is a gzip-wrapped tar.  Plain tar bytes are rejected so a
 * mislabeled response cannot bypass the delivery format; the decompressed size
 * is capped so a malicious gzip cannot exhaust memory.
 */
export function decodeLayer(raw, options = {}) {
  const maxBytes = options.maxLayerBytes ?? DEFAULT_MAX_LAYER_BYTES;
  if (!Buffer.isBuffer(raw) || raw.length === 0) throw new LayerFormatError('层内容为空', { code: 'EMPTY_LAYER' });
  if (raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) {
    throw new LayerFormatError('层不是 gzip 内容', { code: 'INVALID_GZIP' });
  }
  let tar;
  try { tar = gunzipSync(raw, { maxOutputLength: maxBytes }); }
  catch (error) { throw new LayerFormatError('层 gzip 解压失败', { code: 'INVALID_GZIP', cause: error }); }
  if (tar.length > maxBytes) throw new LayerFormatError('层解压后过大', { code: 'LAYER_TOO_LARGE' });
  return parseTar(tar, options);
}

export function readLayer(raw, options = {}) {
  return decodeLayer(raw, options);
}
