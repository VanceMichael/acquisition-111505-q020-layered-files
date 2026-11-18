import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDelivery, loadAllowPrefixes, resolveSourceReference, DeliveryError } from '../src/delivery.mjs';
import { buildView, linkRelation } from '../src/layers.mjs';
import { createIntake } from '../src/server.mjs';
import { buildLayer } from './helpers.mjs';

const prefixes = await loadAllowPrefixes();
const digestOf = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function deliveryServer(layers, { unavailable = [], tampered = {} } = {}) {
  const service = createServer((incoming, outgoing) => {
    if (incoming.url === '/image/manifest') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({
        image: 'gallery-test',
        orderedLayers: layers.map((layer, index) => ({ digest: digestOf(layer), size: layer.length, href: `/layers/${index}` })),
      }));
      return;
    }
    const match = /^\/layers\/(\d+)$/.exec(incoming.url);
    const index = match ? Number(match[1]) : -1;
    if (index >= 0 && layers[index] && !unavailable.includes(index)) {
      const bytes = tampered[index] ? Buffer.from(tampered[index]) : layers[index];
      outgoing.writeHead(200, { 'content-type': 'application/gzip' });
      outgoing.end(bytes);
      return;
    }
    outgoing.writeHead(404, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: '不存在' }));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  return { service, source: `http://127.0.0.1:${service.address().port}` };
}

const viewOf = entries => buildView([{ index: 0, digest: 'sha256:test', entries }], { allowPrefixes: prefixes });
const find = (view, path) => view.entries.find(entry => entry.path === path);

test('后层覆盖同路径，旧层不再是最终内容', () => {
  const view = buildView([
    { index: 0, digest: 'sha256:low', entries: [{ path: 'etc/gallery.conf', type: 'regular', data: Buffer.from('language=en') }] },
    { index: 1, digest: 'sha256:high', entries: [{ path: 'etc/gallery.conf', type: 'regular', data: Buffer.from('language=zh') }] },
  ], { allowPrefixes: prefixes });
  const entry = find(view, 'etc/gallery.conf');
  assert.equal(entry.layer, 1);
  assert.equal(entry.contentLayer, 1);
  assert.equal(entry.size, 11);
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].path, 'etc/gallery.conf');
  assert.equal(view.history[0].entry.layer, 0);
  assert.equal(view.selection.some(item => item.sha256 === view.history[0].entry.sha256), false);
});

test('删除标记与不透明目录不出现在最终视图，旧内容只进历史', () => {
  const view = buildView([
    { index: 0, digest: 'sha256:low', entries: [
      { path: 'assets/old.txt', type: 'regular', data: Buffer.from('旧素材') },
      { path: 'cache/stale.txt', type: 'regular', data: Buffer.from('旧缓存') },
      { path: 'cache/keep.txt', type: 'regular', data: Buffer.from('旧保留') },
    ] },
    { index: 1, digest: 'sha256:high', entries: [
      { path: 'assets/.wh.old.txt', type: 'regular', data: Buffer.alloc(0) },
      { path: 'cache/.wh..wh..opq', type: 'regular', data: Buffer.alloc(0) },
      { path: 'cache/current.txt', type: 'regular', data: Buffer.from('现用缓存') },
    ] },
  ], { allowPrefixes: prefixes });
  assert.equal(find(view, 'assets/old.txt'), undefined);
  assert.equal(find(view, 'assets/.wh.old.txt'), undefined);
  assert.equal(find(view, 'cache/.wh..wh..opq'), undefined);
  assert.equal(find(view, 'cache/stale.txt'), undefined);
  assert.equal(find(view, 'cache/keep.txt'), undefined);
  assert.equal(find(view, 'cache/current.txt').layer, 1);
  assert.deepEqual(view.selection.map(entry => entry.path), ['cache/current.txt']);
  assert.deepEqual(view.history.map(item => item.path).sort(), ['cache/keep.txt', 'cache/stale.txt', 'assets/old.txt'].sort());
  assert.deepEqual(view.events.map(event => event.action), ['whiteout', 'opaque']);
});

test('同一层内的删除标记不隐藏该层自身文件', () => {
  const view = viewOf([
    { path: 'etc/.wh.new.conf', type: 'regular', data: Buffer.alloc(0) },
    { path: 'etc/new.conf', type: 'regular', data: Buffer.from('同层') },
  ]);
  assert.equal(find(view, 'etc/new.conf').size, 6);
  assert.equal(view.events[0].removed, 0);
});

test('同名路径换成目录或链接时不沿用旧内容', () => {
  const asDirectory = buildView([
    { index: 0, digest: 'sha256:low', entries: [{ path: 'etc/thing', type: 'regular', data: Buffer.from('旧文件') }] },
    { index: 1, digest: 'sha256:high', entries: [
      { path: 'etc/thing/inner.conf', type: 'regular', data: Buffer.from('新子项') },
    ] },
  ], { allowPrefixes: prefixes });
  assert.equal(find(asDirectory, 'etc/thing').type, 'directory');
  assert.equal(find(asDirectory, 'etc/thing').implicit, true);
  assert.equal(find(asDirectory, 'etc/thing/inner.conf').size, 9);
  assert.equal(asDirectory.history[0].action, 'replaced');

  const asLink = buildView([
    { index: 0, digest: 'sha256:low', entries: [{ path: 'etc/thing', type: 'regular', data: Buffer.from('旧文件') }] },
    { index: 1, digest: 'sha256:high', entries: [{ path: 'etc/thing', type: 'symlink', linkname: '../etc/gallery.conf' }] },
  ], { allowPrefixes: prefixes });
  const link = find(asLink, 'etc/thing');
  assert.equal(link.type, 'symlink');
  assert.equal(link.size, null);
  assert.equal(link.sha256, null);

  const linkReplacedByDirectory = buildView([
    { index: 0, digest: 'sha256:low', entries: [{ path: 'etc/thing', type: 'symlink', linkname: '/etc/passwd' }] },
    { index: 1, digest: 'sha256:high', entries: [{ path: 'etc/thing/real.conf', type: 'regular', data: Buffer.from('真实') }] },
  ], { allowPrefixes: prefixes });
  assert.equal(find(linkReplacedByDirectory, 'etc/thing').type, 'directory');
});

test('硬链接沿用最终视图内的内容，缺失目标保持未决', () => {
  const resolved = buildView([
    { index: 0, digest: 'sha256:low', entries: [{ path: 'assets/new.txt', type: 'regular', data: Buffer.from('新素材') }] },
    { index: 1, digest: 'sha256:high', entries: [{ path: 'assets/alias.txt', type: 'hardlink', linkname: 'assets/new.txt' }] },
  ], { allowPrefixes: prefixes });
  const alias = find(resolved, 'assets/alias.txt');
  assert.equal(alias.type, 'file');
  assert.equal(alias.pending, false);
  assert.equal(alias.contentLayer, 0);
  assert.equal(alias.contentPath, 'assets/new.txt');
  assert.equal(alias.sha256, find(resolved, 'assets/new.txt').sha256);
  assert.equal(alias.selected, true);

  const pending = viewOf([{ path: 'assets/alias.txt', type: 'hardlink', linkname: 'assets/missing.txt' }]);
  const orphan = find(pending, 'assets/alias.txt');
  assert.equal(orphan.pending, true);
  assert.equal(orphan.selected, false);
  assert.equal(pending.selection.some(entry => entry.path === 'assets/alias.txt'), false);
  assert.deepEqual(pending.pending.map(item => item.path), ['assets/alias.txt']);

  const throughLink = viewOf([
    { path: 'links/out', type: 'symlink', linkname: '/etc/passwd' },
    { path: 'links/alias', type: 'hardlink', linkname: 'links/out' },
  ]);
  assert.equal(find(throughLink, 'links/alias').pending, true);
});

test('链接只解释内部关系，不跟随到宿主机或远程地址', () => {
  assert.deepEqual(linkRelation('links/internal', '../assets/new.txt'), { internal: true, resolved: 'assets/new.txt' });
  for (const target of ['/etc/passwd', '../../etc/shadow', 'https://example.com/a', '//example.com/a', 'C:\\Windows\\win.ini']) {
    assert.equal(linkRelation('links/x', target).internal, false, target);
  }
  const view = viewOf([
    { path: 'links/internal', type: 'symlink', linkname: '../assets/new.txt' },
    { path: 'links/remote', type: 'symlink', linkname: 'https://example.com/a' },
    { path: 'links/absolute', type: 'symlink', linkname: '/etc/passwd' },
  ]);
  assert.equal(find(view, 'links/internal').linkResolved, 'assets/new.txt');
  assert.equal(find(view, 'links/remote').linkInternal, false);
  assert.equal(find(view, 'links/absolute').linkInternal, false);
  assert.equal(find(view, 'links/remote').sha256, null);
});

test('绝对路径和越界成员被拒绝', () => {
  assert.throws(() => viewOf([{ path: '../escape.txt', type: 'regular', data: Buffer.from('x') }]), /越界/);
  assert.throws(() => viewOf([{ path: '/etc/passwd', type: 'regular', data: Buffer.from('x') }]), /绝对/);
  const replacedWithinLayer = viewOf([
    { path: 'links/file', type: 'regular', data: Buffer.from('x') },
    { path: 'links/file/inner', type: 'regular', data: Buffer.from('y') },
  ]);
  assert.equal(find(replacedWithinLayer, 'links/file').type, 'directory');
  assert.equal(find(replacedWithinLayer, 'links/file/inner').size, 1);
});

test('来源链接必须以实际来源地址解释且不能跨主机', async () => {
  const base = 'http://127.0.0.1:4200';
  assert.equal(resolveSourceReference(base, '/layers/0').href, 'http://127.0.0.1:4200/layers/0');
  assert.equal(resolveSourceReference(base, 'layers/0').href, 'http://127.0.0.1:4200/layers/0');
  for (const href of ['http://example.com/x', '//example.com/x', 'file:///etc/passwd', 'https://127.0.0.1:4200/x']) {
    assert.throws(() => resolveSourceReference(base, href), DeliveryError, href);
  }
});

test('完整交付给出可追到来源层的清单并保留历史证据', async context => {
  const layers = [
    buildLayer([
      { path: 'etc/gallery.conf', content: 'language=en' },
      { path: 'assets/old.txt', content: '旧素材' },
      { path: 'cache/stale.txt', content: '旧缓存' },
    ]),
    buildLayer([
      { path: 'etc/gallery.conf', content: 'language=zh' },
      { path: 'assets/.wh.old.txt', content: '' },
      { path: 'assets/new.txt', content: '新素材' },
      { path: 'cache/.wh..wh..opq', content: '' },
      { path: 'cache/current.txt', content: '现用缓存' },
      { path: 'assets/alias.txt', type: 'hardlink', linkname: 'assets/new.txt' },
      { path: 'links/internal', type: 'symlink', linkname: '../assets/new.txt' },
    ]),
  ];
  const { service, source } = await deliveryServer(layers);
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });

  const view = await acquireDelivery({ source });
  assert.equal(view.layers.length, 2);
  assert.deepEqual(view.selection.map(entry => entry.path), [
    'assets/alias.txt', 'assets/new.txt', 'cache/current.txt', 'etc/gallery.conf', 'links/internal',
  ]);
  const file = view.selection.find(entry => entry.path === 'etc/gallery.conf');
  assert.equal(file.layer, 1);
  assert.equal(file.layerDigest, view.layers[1].digest);
  assert.equal(file.size, 11);
  assert.equal(view.selection.some(entry => entry.path === 'assets/old.txt' || entry.path === 'cache/stale.txt'), false);
  const evidence = view.history.map(item => item.path);
  assert.ok(evidence.includes('assets/old.txt'));
  assert.ok(evidence.includes('cache/stale.txt'));
  for (const item of view.history) assert.ok(!view.entries.some(entry => entry.path === item.path && entry.layer === item.entry.layer && entry.sha256 === item.entry.sha256));
  assert.ok(!Object.keys(view).includes('material'), '内部字节不作为公开字段暴露');
});

test('某层缺失或校验失败时不交出最终视图', async context => {
  const layers = [buildLayer([{ path: 'etc/a.conf', content: 'a' }]), buildLayer([{ path: 'etc/b.conf', content: 'b' }])];
  const { service, source } = await deliveryServer(layers);
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });

  const tampered = Buffer.from(layers[1]); tampered[tampered.length - 1] ^= 1;
  const corrupt = await deliveryServer(layers, { tampered: { 1: tampered } });
  const missing = await deliveryServer(layers, { unavailable: [1] });
  context.after(async () => {
    for (const entry of [corrupt, missing]) {
      entry.service.closeAllConnections();
      await new Promise(resolve => entry.service.close(resolve));
    }
  });

  await assert.rejects(acquireDelivery({ source: corrupt.source }), error => error.kind === 'integrity' && error.layer === 1);
  await assert.rejects(acquireDelivery({ source: missing.source }), error => error.kind === 'unavailable');
  const redirecting = createServer((incoming, outgoing) => {
    if (incoming.url === '/image/manifest') { outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ image: 'x', orderedLayers: [{ digest: digestOf(layers[0]), size: layers[0].length, href: '/layers/0' }] })); return; }
    outgoing.writeHead(302, { location: 'http://example.com/layer' }); outgoing.end();
  });
  redirecting.listen(0, '127.0.0.1'); await once(redirecting, 'listening');
  context.after(async () => { redirecting.closeAllConnections(); await new Promise(resolve => redirecting.close(resolve)); });
  await assert.rejects(acquireDelivery({ source: `http://127.0.0.1:${redirecting.address().port}` }), /302|重定向/);
});

test('收件端领取失败时不写入任何交付记录，成功后可按路径取回最终文件', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const layers = [
    buildLayer([{ path: 'etc/gallery.conf', content: 'language=en' }, { path: 'assets/stale.txt', content: '旧' }]),
    buildLayer([{ path: 'etc/gallery.conf', content: 'language=zh' }, { path: 'assets/.wh.stale.txt', content: '' }]),
  ];
  const { service: sourceService, source } = await deliveryServer(layers);
  const intake = await createIntake(directory);
  intake.listen(0, '127.0.0.1'); await once(intake, 'listening');
  context.after(async () => {
    for (const server of [intake, sourceService]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const base = `http://127.0.0.1:${intake.address().port}`;

  const failed = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'http://127.0.0.1:1' }) });
  assert.equal(failed.status, 502);
  assert.equal((await (await fetch(base + '/api/records')).json()).length, 0);
  assert.equal((await fetch(base + '/api/view')).status, 404);
  assert.deepEqual(await readdir(join(directory, 'receipts')), []);

  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  assert.equal(collected.status, 201);
  const result = await collected.json();
  assert.equal(result.layerCount, 2);

  const view = await (await fetch(base + '/api/view')).json();
  assert.deepEqual(view.selection.map(entry => entry.path), ['etc/gallery.conf']);
  assert.equal(view.selection[0].layer, 1);

  const file = await fetch(base + '/api/file?path=etc/gallery.conf');
  assert.equal(file.status, 200);
  assert.equal((await file.text()), 'language=zh');
  assert.equal(file.headers.get('x-content-layer'), '1');
  assert.equal((await fetch(base + '/api/file?path=assets/stale.txt')).status, 404);
  assert.equal((await fetch(base + '/api/file?path=links/internal')).status, 404);

  const evidence = await (await fetch(base + '/api/evidence')).json();
  assert.ok(evidence.history.some(item => item.path === 'assets/stale.txt' && item.action === 'whiteout'));
  assert.equal(evidence.selection, undefined);

  // 重复领取同一交付复用版本，内容变化保留新版本。
  assert.equal((await (await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) })).json()).duplicate, true);
  const blobs = await readdir(join(directory, 'blobs'));
  assert.ok(blobs.length >= 4);
  // 失效内容只作为历史证据，不归档成可取回的当前文件内容。
  const { createHash } = await import('node:crypto');
  const digestOfText = text => createHash('sha256').update(Buffer.from(text)).digest('hex');
  assert.equal(blobs.includes(digestOfText('旧')), false);
  const stored = JSON.parse(await readFile(join(directory, 'receipts', `${result.receipt}.json`), 'utf8'));
  assert.equal(stored.source, `delivery:${source}`);
  assert.equal(stored.versions.length, 1);
});
