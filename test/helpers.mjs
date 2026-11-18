import { gzipSync } from 'node:zlib';

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header({ name, typeflag, size = 0, linkname = '', mode = 0o644, mtime = 0 }) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(mtime, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(typeflag, 156, 'ascii');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return Buffer.from(`${length}${body}`, 'utf8');
}

function pad(bytes) {
  const remainder = bytes.length % 512;
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(512 - remainder, 0)]);
}

/** Build an uncompressed tar archive from entries: { path, type, content, linkname }. */
export function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const typeflag = { file: '0', directory: '5', symlink: '2', hardlink: '1', fifo: '6' }[type];
    if (!typeflag) throw new Error(`未知类型 ${type}`);
    const content = type === 'file' ? Buffer.from(entry.content ?? '') : Buffer.alloc(0);
    let name = entry.path;
    if (type === 'directory' && !name.endsWith('/')) name += '/';
    if (Buffer.byteLength(name) > 99) {
      const record = paxRecord('path', entry.path);
      blocks.push(header({ name: 'PaxHeader', typeflag: 'x', size: record.length }));
      blocks.push(pad(record));
      name = entry.path;
    }
    blocks.push(header({
      name,
      typeflag,
      size: content.length,
      linkname: entry.linkname ?? '',
      mode: type === 'directory' ? 0o755 : 0o644,
    }));
    if (content.length) blocks.push(pad(content));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export const buildLayer = entries => gzipSync(buildTar(entries), { level: 9 });
