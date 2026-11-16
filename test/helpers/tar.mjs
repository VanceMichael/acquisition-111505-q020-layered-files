import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/**
 * Minimal tar writer used only by tests.  It writes ustar headers with real
 * checksums so the receiver is exercised through the same byte format as a
 * delivered layer.
 */
function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header({ name, type = '0', size = 0, linkname = '', mode = 0o644, uid = 0, gid = 0, mtime = 0 }) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'latin1');
  block.write(octal(uid, 8), 108, 8, 'latin1');
  block.write(octal(gid, 8), 116, 8, 'latin1');
  block.write(octal(size, 12), 124, 12, 'latin1');
  block.write(octal(mtime, 12), 136, 12, 'latin1');
  block.write('        ', 148, 8, 'latin1');
  block.write(type, 156, 1, 'latin1');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return block;
}

export function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? '', 'utf8');
    const type = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : entry.type === 'hardlink' ? '1' : entry.type === 'fifo' ? '6' : entry.type === 'device' ? '3' : '0';
    const size = type === '0' ? bytes.length : 0;
    blocks.push(header({
      name: entry.name, type, size,
      linkname: entry.linkname ?? '', mode: entry.mode ?? (type === 'directory' ? 0o755 : 0o644),
      mtime: entry.mtime ?? 0,
    }));
    if (size) {
      blocks.push(bytes);
      const padding = (512 - (size % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const gzip = buffer => gzipSync(buffer);
export const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

/** A fake source usable with collectDelivery's requestImpl hook. */
export function fakeSource(layers, options = {}) {
  const encoded = layers.map(layer => {
    const raw = Buffer.isBuffer(layer) ? layer : gzip(tar(layer));
    return raw;
  });
  const manifest = {
    image: options.image ?? 'test-image',
    orderedLayers: encoded.map((raw, index) => ({
      digest: 'sha256:' + sha256(raw),
      size: raw.length,
      href: options.hrefs?.[index] ?? `/layers/${index}`,
    })),
  };
  const requests = [];
  const requestImpl = async url => {
    requests.push(url);
    const path = new URL(url).pathname;
    if (path === (options.probe ?? '/image/manifest')) {
      return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(manifest)) };
    }
    const match = /^\/layers\/(\d+)$/.exec(path);
    if (match) {
      const index = Number(match[1]);
      if (options.missing?.includes(index)) return { status: 404, headers: {}, bytes: Buffer.from('{}') };
      let raw = encoded[index];
      if (!raw) return { status: 404, headers: {}, bytes: Buffer.from('{}') };
      if (options.corrupt?.includes(index)) { raw = Buffer.from(raw); raw[raw.length - 1] ^= 1; }
      return { status: 200, headers: {}, bytes: raw };
    }
    return { status: 404, headers: {}, bytes: Buffer.from('{}') };
  };
  return { requestImpl, manifest, requests, encoded, base: options.base ?? 'http://source.test/' };
}
