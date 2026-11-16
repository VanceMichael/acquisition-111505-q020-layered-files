import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, lstat, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { extractFinalView, ExtractionError } from '../src/extract.mjs';
import { composeLayers } from '../src/layers.mjs';
import { parseTar } from '../src/tar.mjs';
import { tar } from './helpers/tar.mjs';

const selection = { allowedPrefixes: ['etc/', 'assets/'] };
const lower = parseTar(tar([
  { name: 'etc/gallery.conf', bytes: 'language=en' },
  { name: 'assets/old.txt', bytes: '旧素材' },
]));
const upper = parseTar(tar([
  { name: 'etc/gallery.conf', bytes: 'language=zh' },
  { name: 'assets/.wh.old.txt' },
  { name: 'assets/new.txt', bytes: '新素材' },
  { name: 'links/internal', type: 'symlink', linkname: '../assets/new.txt' },
  { name: 'links/escape', type: 'symlink', linkname: '/etc/passwd' },
  { name: 'links/remote', type: 'symlink', linkname: 'http://example.invalid/x' },
]));
const composition = composeLayers([
  { index: 0, digest: 'sha256:lower', entries: lower },
  { index: 1, digest: 'sha256:upper', entries: upper },
], selection);

test('只按最终视图解包到指定根目录，失效内容不落地', async context => {
  const root = await mkdtemp(join(tmpdir(), 'extract-')); context.after(() => rm(root, { recursive: true, force: true }));
  const result = await extractFinalView(composition, root);
  assert.deepEqual(result.files.map(file => file.path), ['assets/new.txt', 'etc/gallery.conf']);
  assert.equal((await readFile(join(root, 'etc/gallery.conf'), 'utf8')), 'language=zh');
  await assert.rejects(readFile(join(root, 'assets/old.txt')), /ENOENT/);
  assert.deepEqual(result.escaped, []);
  for (const file of result.files) {
    const offset = relative(root, file.destination);
    assert.ok(!offset.startsWith('..' + sep) && !isAbsolute(offset));
  }
});

test('不为链接创建文件系统入口，也不跟随链接读取宿主或远程内容', async context => {
  const root = await mkdtemp(join(tmpdir(), 'extract-')); context.after(() => rm(root, { recursive: true, force: true }));
  const result = await extractFinalView(composition, root);
  assert.equal(result.links.length, 3);
  assert.ok(result.links.every(link => link.materialized === false));
  await assert.rejects(lstat(join(root, 'links')), /ENOENT/);
  assert.deepEqual(result.links.map(link => [link.path, link.internal]), [
    ['links/escape', false], ['links/internal', true], ['links/remote', false],
  ]);
});

test('根内已有的符号链接不能被用来写到根目录之外', async context => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-')); context.after(() => rm(outside, { recursive: true, force: true }));
  const root = await mkdtemp(join(tmpdir(), 'extract-')); context.after(() => rm(root, { recursive: true, force: true }));
  await symlink(outside, join(root, 'etc'));
  await assert.rejects(extractFinalView(composition, root), error => error instanceof ExtractionError && error.code === 'UNSAFE_EXTRACT_PATH');
  assert.deepEqual(await readdir(outside), []);
});

test('解包目标已存在的符号链接不被覆盖写入', async context => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-')); context.after(() => rm(outside, { recursive: true, force: true }));
  const victim = join(outside, 'gallery.conf'); await writeFile(victim, '原始');
  const root = await mkdtemp(join(tmpdir(), 'extract-')); context.after(() => rm(root, { recursive: true, force: true }));
  await (await import('node:fs/promises')).mkdir(join(root, 'etc'));
  await symlink(victim, join(root, 'etc/gallery.conf'));
  await assert.rejects(extractFinalView(composition, root), error => error instanceof ExtractionError && error.code === 'UNSAFE_EXTRACT_PATH');
  assert.equal(await readFile(victim, 'utf8'), '原始');
});

test('现有普通文件被最终视图内容替换，可选中全部当前文件', async context => {
  const root = await mkdtemp(join(tmpdir(), 'extract-')); context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'stale'), '旧文件');
  const result = await extractFinalView(composition, root, { selectionOnly: false });
  assert.equal((await readFile(join(root, 'etc/gallery.conf'), 'utf8')), 'language=zh');
  assert.equal(result.selectionOnly, false);
});

test('必须给出绝对且非链接的根目录', async () => {
  await assert.rejects(extractFinalView(composition, 'relative/root'), /绝对路径/);
  const target = await mkdtemp(join(tmpdir(), 'target-'));
  const link = join(tmpdir(), `link-${Date.now()}-${Math.random()}`);
  await symlink(target, link);
  try {
    await assert.rejects(extractFinalView(composition, link), /符号链接/);
  } finally { await rm(link, { force: true }); await rm(target, { recursive: true, force: true }); }
});
