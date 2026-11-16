import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLayers } from '../src/layers.mjs';
import { parseTar } from '../src/tar.mjs';
import { tar } from './helpers/tar.mjs';

const bottom = parseTar(tar([
  { name: 'etc/gallery.conf', bytes: 'language=en' },
  { name: 'assets/old.txt', bytes: '旧素材' },
  { name: 'cache/stale.txt', bytes: '旧缓存' },
  { name: 'cache/keep.txt', bytes: '保留' },
]));
const top = parseTar(tar([
  { name: 'etc/gallery.conf', bytes: 'language=zh' },
  { name: 'assets/.wh.old.txt' },
  { name: 'assets/new.txt', bytes: '新素材' },
  { name: 'cache/.wh..wh..opq' },
  { name: 'cache/current.txt', bytes: '现用缓存' },
  { name: 'links/internal', type: 'symlink', linkname: '../assets/new.txt' },
  { name: 'assets/alias.txt', type: 'hardlink', linkname: 'assets/new.txt' },
]));
const layers = [
  { index: 0, digest: 'sha256:bottom', entries: bottom },
  { index: 1, digest: 'sha256:top', entries: top },
];
const selection = { allowedPrefixes: ['etc/', 'assets/', 'cache/', 'links/'] };

test('后层覆盖同路径内容并记录来源层', () => {
  const { view, claims, history } = composeLayers(layers, selection);
  const configuration = view.find(node => node.path === 'etc/gallery.conf');
  assert.equal(configuration.layerIndex, 1);
  assert.equal(claims.find(claim => claim.path === 'etc/gallery.conf').layerIndex, 1);
  assert.equal(claims.find(claim => claim.path === 'etc/gallery.conf').layerDigest, 'sha256:top');
  const overwritten = history.find(item => item.path === 'etc/gallery.conf');
  assert.equal(overwritten.action, 'superseded');
  assert.equal(overwritten.previous.layerIndex, 0);
  assert.equal(overwritten.previous.type, 'file');
});

test('删除标记使旧层文件退出当前视图但保留为历史证据', () => {
  const { view, claims, history } = composeLayers(layers, selection);
  assert.equal(view.find(node => node.path === 'assets/old.txt'), undefined);
  assert.equal(claims.find(claim => claim.path === 'assets/old.txt'), undefined);
  const deleted = history.find(item => item.path === 'assets/old.txt');
  assert.equal(deleted.action, 'deleted');
  assert.equal(deleted.previous.sha256 !== undefined, true);
});

test('不透明目录屏蔽低层子项而保留本层内容', () => {
  const { view, claims, history } = composeLayers(layers, selection);
  assert.equal(view.find(node => node.path === 'cache/stale.txt'), undefined);
  assert.equal(view.find(node => node.path === 'cache/keep.txt'), undefined);
  assert.ok(view.find(node => node.path === 'cache/current.txt'));
  assert.deepEqual(claims.filter(claim => claim.path.startsWith('cache/')).map(claim => claim.path), ['cache/current.txt']);
  assert.ok(history.some(item => item.path === 'cache/keep.txt' && item.action === 'opaque'));
});

test('删除标记本身不是文件，也不进入任何清单', () => {
  const { view, claims, history } = composeLayers(layers, selection);
  for (const node of view) assert.ok(!node.path.split('/').pop().startsWith('.wh.'));
  for (const claim of claims) assert.ok(!claim.path.includes('.wh.'));
  for (const item of history) assert.ok(!item.path.includes('.wh.'));
});

test('硬链接与符号链接各按其根内关系解释', () => {
  const { view, claims, links } = composeLayers(layers, selection);
  const alias = claims.find(claim => claim.path === 'assets/alias.txt');
  assert.equal(alias.hardlinkOf, 'assets/new.txt');
  assert.equal(alias.sha256, claims.find(claim => claim.path === 'assets/new.txt').sha256);
  const internal = links.find(link => link.path === 'links/internal');
  assert.equal(internal.resolvedPath, 'assets/new.txt');
  assert.equal(internal.internal, true);
});

test('缺失目标的硬链接保持未决，不被当作可领取文件', () => {
  const unresolved = parseTar(tar([{ name: 'assets/late.txt', type: 'hardlink', linkname: 'assets/later.txt' }]));
  const result = composeLayers([{ index: 0, digest: 'sha256:a', entries: unresolved }], selection);
  assert.deepEqual(result.pending.map(item => item.path), ['assets/late.txt']);
  assert.equal(result.claims.length, 0);
  assert.equal(result.view.find(node => node.path === 'assets/late.txt'), undefined);
});

test('上层把同名路径从文件换成目录时旧内容不复用', () => {
  const lower = parseTar(tar([{ name: 'assets/item', bytes: '旧文件' }]));
  const upper = parseTar(tar([
    { name: 'assets/item/inner.txt', bytes: '新目录内容' },
  ]));
  const result = composeLayers([
    { index: 0, digest: 'sha256:lower', entries: lower },
    { index: 1, digest: 'sha256:upper', entries: upper },
  ], selection);
  const item = result.view.find(node => node.path === 'assets/item');
  assert.equal(item.type, 'directory');
  assert.equal(result.claims.find(claim => claim.path === 'assets/item'), undefined);
  assert.equal(result.contents.get('assets/item'), undefined);
  assert.ok(result.history.some(entry => entry.path === 'assets/item' && entry.action === 'replaced'));
  assert.equal(result.claims.find(claim => claim.path === 'assets/item/inner.txt').layerIndex, 1);
});

test('上层把同名路径从文件换成链接时旧内容不复用', () => {
  const lower = parseTar(tar([{ name: 'assets/item', bytes: '旧文件' }]));
  const upper = parseTar(tar([{ name: 'assets/item', type: 'symlink', linkname: 'new.txt' }, { name: 'assets/new.txt', bytes: '新素材' }]));
  const result = composeLayers([
    { index: 0, digest: 'sha256:lower', entries: lower },
    { index: 1, digest: 'sha256:upper', entries: upper },
  ], selection);
  const item = result.view.find(node => node.path === 'assets/item');
  assert.equal(item.type, 'symlink');
  assert.equal(item.target, 'new.txt');
  assert.equal(result.claims.find(claim => claim.path === 'assets/item'), undefined);
  assert.ok(result.history.some(entry => entry.path === 'assets/item' && entry.action === 'replaced'));
});

test('上层写入链接路径下的子项时不沿用也不跟随旧链接', () => {
  const lower = parseTar(tar([{ name: 'assets/item', type: 'symlink', linkname: 'new.txt' }]));
  const upper = parseTar(tar([{ name: 'assets/item/new.txt', bytes: '上层内容' }]));
  const result = composeLayers([
    { index: 0, digest: 'sha256:lower', entries: lower },
    { index: 1, digest: 'sha256:upper', entries: upper },
  ], selection);
  const item = result.view.find(node => node.path === 'assets/item');
  assert.equal(item.type, 'directory');
  assert.equal(result.claims.find(claim => claim.path === 'assets/item/new.txt').sha256 !== undefined, true);
  assert.ok(result.history.some(entry => entry.path === 'assets/item' && entry.action === 'replaced'));
});

test('包含白名单之外的当前文件可查询但不进入领取清单', () => {
  const entries = parseTar(tar([{ name: 'bin/tool', bytes: 'not for collectors' }, { name: 'etc/ok.conf', bytes: 'ok' }]));
  const result = composeLayers([{ index: 0, digest: 'sha256:x', entries }], selection);
  assert.deepEqual(result.claims.map(claim => claim.path), ['etc/ok.conf']);
  assert.ok(result.view.find(node => node.path === 'bin/tool'));
});

test('同层目录项不影响已存在的子项，跨层目录合并保留子项', () => {
  const result = composeLayers([
    { index: 0, digest: 'sha256:a', entries: parseTar(tar([{ name: 'etc/a.conf', bytes: 'a' }])) },
    { index: 1, digest: 'sha256:b', entries: parseTar(tar([{ name: 'etc', type: 'directory' }, { name: 'etc/b.conf', bytes: 'b' }])) },
  ], selection);
  assert.deepEqual(result.claims.map(claim => claim.path), ['etc/a.conf', 'etc/b.conf']);
});

test('指向不存在低层内容的标记不虚构文件或目录', () => {
  const result = composeLayers([
    { index: 0, digest: 'sha256:a', entries: parseTar(tar([{ name: 'etc/a.conf', bytes: 'a' }])) },
    { index: 1, digest: 'sha256:b', entries: parseTar(tar([{ name: 'ghost/.wh.gone.txt' }, { name: 'nowhere/.wh..wh..opq' }])) },
  ], selection);
  assert.deepEqual(result.view.map(node => node.path), ['etc', 'etc/a.conf']);
  assert.deepEqual(result.history, []);
});

test('上层在低层链接同名处放置删除标记时不沿用该链接', () => {
  const lower = parseTar(tar([{ name: 'assets', type: 'symlink', linkname: 'etc' }, { name: 'etc/gallery.conf', bytes: 'x' }]));
  const upper = parseTar(tar([{ name: 'assets/.wh.old.txt' }]));
  const result = composeLayers([
    { index: 0, digest: 'sha256:lower', entries: lower },
    { index: 1, digest: 'sha256:upper', entries: upper },
  ], selection);
  assert.equal(result.view.find(node => node.path === 'assets').type, 'directory');
  assert.ok(result.history.some(entry => entry.path === 'assets' && entry.action === 'replaced'));
  assert.equal(result.links.find(link => link.path === 'assets'), undefined);
});

test('不透明目录可替换低层同名文件或链接', () => {
  const lower = parseTar(tar([{ name: 'cache', bytes: '低层文件' }, { name: 'run', type: 'symlink', linkname: 'cache' }]));
  const upper = parseTar(tar([{ name: 'cache/.wh..wh..opq' }, { name: 'run/.wh..wh..opq' }, { name: 'run/current.txt', bytes: '现用' }]));
  const result = composeLayers([
    { index: 0, digest: 'sha256:lower', entries: lower },
    { index: 1, digest: 'sha256:upper', entries: upper },
  ], { allowedPrefixes: ['cache/', 'links/', 'run/'] });
  assert.equal(result.view.find(node => node.path === 'cache').type, 'directory');
  assert.equal(result.view.find(node => node.path === 'run').type, 'directory');
  assert.deepEqual(result.claims.map(claim => claim.path), ['run/current.txt']);
  assert.equal(result.claims[0].layerIndex, 1);
});
