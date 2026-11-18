const BLOCK_SIZE = 512;

export class TarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TarError';
  }
}

function stringField(bytes, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  return bytes.toString('utf8', offset, end);
}

function numericField(bytes, offset, length) {
  if (bytes[offset] & 0x80) {
    // GNU base-256 representation, used for large sizes.
    let value = BigInt(bytes[offset] & 0x7f);
    for (let index = offset + 1; index < offset + length; index += 1) value = (value << 8n) | BigInt(bytes[index]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TarError('tar 数值超出范围');
    return Number(value);
  }
  const text = stringField(bytes, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError('tar 数值字段无效');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarError('tar 数值超出范围');
  return value;
}

function checksumMatches(header) {
  const expected = numericField(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return expected === unsigned || expected === signed;
}

function parsePax(bytes) {
  const values = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(bytes.toString('ascii', offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const end = offset + length;
    if (end > bytes.length) throw new TarError('pax 扩展头被截断');
    const record = bytes.toString('utf8', space + 1, end).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return values;
}

function textData(bytes) {
  const zero = bytes.indexOf(0);
  return bytes.toString('utf8', 0, zero === -1 ? bytes.length : zero);
}

/**
 * Parse an uncompressed tar archive without touching the filesystem.
 * Only regular files, directories, symlinks and hardlinks are accepted.
 * Header checksums, bounds and pax/GNU long names are validated.
 */
export function parseTar(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = [];
  const globalPax = {};
  let nextPax = null;
  let longName = null;
  let longLink = null;
  let offset = 0;
  let zeroBlocks = 0;

  while (offset + BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    if (header.every(byte => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    if (!checksumMatches(header)) throw new TarError('tar 头校验和无效');

    const size = numericField(header, 124, 12);
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    // pax 记录的大小优先于头部字段，大型成员在头部常写为占位值。
    const pending = typeflag === 'x' ? nextPax : null;
    const declaredSize = pending && pending.size !== undefined ? Number(pending.size) : size;
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) throw new TarError('tar 成员大小无效');
    const padded = Math.ceil(declaredSize / BLOCK_SIZE) * BLOCK_SIZE;
    if (offset + declaredSize > bytes.length) throw new TarError('tar 成员数据被截断');
    if (offset + padded > bytes.length) throw new TarError('tar 成员填充被截断');
    const data = bytes.subarray(offset, offset + declaredSize);
    offset += padded;

    if (typeflag === 'x' || typeflag === 'g') {
      const values = parsePax(data);
      if (typeflag === 'x') nextPax = values;
      else Object.assign(globalPax, values);
      continue;
    }
    if (typeflag === 'L') { longName = textData(data); continue; }
    if (typeflag === 'K') { longLink = textData(data); continue; }

    const pax = { ...globalPax, ...(nextPax || {}) };
    nextPax = null;

    const entrySize = declaredSize;

    let name = stringField(header, 0, 100);
    const magic = stringField(header, 257, 6);
    const prefix = stringField(header, 345, 155);
    if (prefix && magic.startsWith('ustar')) name = `${prefix}/${name}`;
    if (pax.path !== undefined) name = pax.path;
    else if (longName !== null) name = longName;

    let linkname = stringField(header, 157, 100);
    if (pax.linkpath !== undefined) linkname = pax.linkpath;
    else if (longLink !== null) linkname = longLink;

    longName = null;
    longLink = null;

    let type;
    if (typeflag === '0' || typeflag === '7') type = 'regular';
    else if (typeflag === '1') type = 'hardlink';
    else if (typeflag === '2') type = 'symlink';
    else if (typeflag === '5') type = 'directory';
    else throw new TarError(`不支持的 tar 成员类型 ${JSON.stringify(typeflag)}`);

    entries.push({
      path: name,
      type,
      mode: numericField(header, 100, 8),
      size: entrySize,
      mtime: numericField(header, 136, 12),
      linkname,
      data: type === 'regular' ? data : null,
    });
  }

  if (offset < bytes.length && bytes.subarray(offset).some(byte => byte !== 0)) {
    throw new TarError('tar 归档尾部包含非零数据');
  }
  return entries;
}
