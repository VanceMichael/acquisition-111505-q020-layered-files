import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { decodeLayer, parseTar, normalizeMemberPath, resolveInternalLink } from '../src/tar.mjs';
import { tar, gzip } from './helpers/tar.mjs';

test('解析 gzip 层并保留文件、目录、符号链接与硬链接', () => {
  const entries = decodeLayer(gzip(tar([
    { name: 'etc/gallery.conf', bytes: 'language=zh' },
    { name: 'etc', type: 'directory' },
    { name: 'links/internal', type: 'symlink', linkname: '../etc/gallery.conf' },
    { name: 'etc/alias.conf', type: 'hardlink', linkname: 'etc/gallery.conf' },
  ])));
  assert.deepEqual(entries.map(entry => [entry.path, entry.type]), [
    ['etc/gallery.conf', 'file'], ['etc', 'directory'], ['links/internal', 'symlink'], ['etc/alias.conf', 'hardlink'],
  ]);
  assert.equal(entries[0].bytes.toString(), 'language=zh');
  assert.equal(entries[2].internal, true);
  assert.equal(entries[2].resolvedPath, 'etc/gallery.conf');
});

test('绝对成员、越界成员与 NUL 被拒绝', () => {
  assert.throws(() => parseTar(tar([{ name: '/etc/passwd', bytes: 'x' }])), /绝对路径/);
  assert.throws(() => parseTar(tar([{ name: '../escape', bytes: 'x' }])), /越过根目录/);
  assert.throws(() => parseTar(tar([{ name: 'a/../../escape', bytes: 'x' }])), /越过根目录/);
  assert.throws(() => normalizeMemberPath('a\0b'), /NUL/);
  assert.throws(() => normalizeMemberPath('etc\\gallery.conf'), /反斜杠/);
});

test('只接受资料类成员，设备与 FIFO 一律拒绝', () => {
  assert.throws(() => parseTar(tar([{ name: 'dev/null', type: 'fifo' }])), /不支持/);
  assert.throws(() => parseTar(tar([{ name: 'dev/sda', type: 'device' }])), /不支持/);
});

test('头校验和错误与截断数据被拒绝', () => {
  const valid = tar([{ name: 'a.txt', bytes: 'hello' }]);
  const broken = Buffer.from(valid); broken[0] = 0x62;
  assert.throws(() => parseTar(broken), /校验和/);
  assert.throws(() => parseTar(valid.subarray(0, 700)), /截断/);
});

test('gzip 内容损坏时报告为层格式错误', () => {
  const raw = Buffer.from(gzip(tar([{ name: 'a.txt', bytes: 'hello' }])));
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decodeLayer(raw), /gzip/);
});

test('未按交付格式压缩的层被拒绝', () => {
  assert.throws(() => decodeLayer(tar([{ name: 'a.txt', bytes: 'hello' }])), /gzip/);
  assert.throws(() => decodeLayer(Buffer.alloc(0)), /空/);
});

test('链接目标只解释交付内部路径，绝不视为宿主或远程地址', () => {
  assert.deepEqual(resolveInternalLink('links/internal', '../assets/new.txt'), { internal: true, path: 'assets/new.txt' });
  assert.deepEqual(resolveInternalLink('a/b', '/etc/passwd'), { internal: false, path: null });
  assert.deepEqual(resolveInternalLink('a/b', '../../etc/passwd'), { internal: false, path: null });
  assert.deepEqual(resolveInternalLink('a/b', 'file:///etc/passwd'), { internal: false, path: null });
  assert.deepEqual(resolveInternalLink('a/b', 'http://example.invalid/x'), { internal: false, path: null });
  assert.deepEqual(resolveInternalLink('a/b', 'C:\\Windows\\win.ini'), { internal: false, path: null });
});

test('解压上限防止压缩炸弹', () => {
  const big = Buffer.alloc(1024 * 1024, 0x61);
  const raw = gzip(tar([{ name: 'big.txt', bytes: big }]));
  assert.throws(() => decodeLayer(raw, { maxLayerBytes: 4096 }), /解压失败|过大/);
  assert.equal(gunzipSync(gzip(Buffer.from('ok'))).toString(), 'ok');
});

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  // The decimal length prefix counts its own digits.
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
}

test('PAX 扩展名与长路径被采用', () => {
  const longName = 'assets/' + '深'.repeat(60) + '.txt';
  const pax = Buffer.from(paxRecord('path', longName), 'utf8');
  const paxHeader = Buffer.alloc(512, 0);
  paxHeader.write('PaxHeader', 0, 100, 'utf8');
  paxHeader.write(octalForTest(0o644, 8), 100, 8, 'latin1');
  paxHeader.write(octalForTest(pax.length, 12), 124, 12, 'latin1');
  paxHeader.write('x', 156, 1, 'latin1');
  paxHeader.write('ustar\0', 257, 6, 'latin1');
  let sum = 0; for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : paxHeader[index];
  paxHeader.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  // The PAX header extends the member that follows it; it is not a file itself.
  const archive = Buffer.concat([
    paxHeader, pax, Buffer.alloc((512 - (pax.length % 512)) % 512),
    tar([{ name: 'short.txt', bytes: 'x' }]),
  ]);
  const entries = parseTar(archive);
  assert.deepEqual(entries.map(entry => entry.path), [longName]);
});

function octalForTest(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}
