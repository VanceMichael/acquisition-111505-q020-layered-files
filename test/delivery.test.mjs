import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { collectDelivery, DeliveryError } from '../src/source.mjs';
import { createProvider } from '../provider/server.mjs';
import { fakeSource, tar } from './helpers/tar.mjs';

const layers = [
  [{ name: 'etc/gallery.conf', bytes: 'language=en' }, { name: 'assets/old.txt', bytes: '旧素材' }],
  [
    { name: 'etc/gallery.conf', bytes: 'language=zh' },
    { name: 'assets/.wh.old.txt' },
    { name: 'assets/new.txt', bytes: '新素材' },
    { name: 'cache/.wh..wh..opq' },
    { name: 'cache/current.txt', bytes: '现用缓存' },
    { name: 'assets/alias.txt', type: 'hardlink', linkname: 'assets/new.txt' },
    { name: 'links/internal', type: 'symlink', linkname: '../assets/new.txt' },
  ],
];

test('领取最终视图：后层覆盖、删除标记与来源层可追溯到', async () => {
  const source = fakeSource(layers);
  const report = await collectDelivery({ source: source.base, requestImpl: source.requestImpl });
  assert.equal(report.complete, true);
  const paths = report.claims.map(claim => claim.path);
  assert.deepEqual(paths, ['assets/alias.txt', 'assets/new.txt', 'cache/current.txt', 'etc/gallery.conf']);
  const configuration = report.claims.find(claim => claim.path === 'etc/gallery.conf');
  assert.equal(configuration.layerIndex, 1);
  assert.equal(configuration.layerDigest, source.manifest.orderedLayers[1].digest);
  assert.equal(report.claims.find(claim => claim.path.startsWith('assets/old')), undefined);
  assert.ok(report.history.some(item => item.path === 'assets/old.txt' && item.action === 'deleted'));
  assert.equal(report.view.find(node => node.path === 'cache/stale.txt'), undefined);
  assert.equal(report.links[0].resolvedPath, 'assets/new.txt');
});

test('层校验使用清单摘要与大小；层序按 orderedLayers 从底到顶', async () => {
  const source = fakeSource(layers);
  await collectDelivery({ source: source.base, requestImpl: source.requestImpl });
  assert.deepEqual(source.requests.map(url => new URL(url).pathname), ['/image/manifest', '/layers/0', '/layers/1']);
});

test('层缺失时不产出看似完整的最终视图', async () => {
  const source = fakeSource(layers, { missing: [1] });
  await assert.rejects(collectDelivery({ source: source.base, requestImpl: source.requestImpl }), error => {
    assert.equal(error.code, 'LAYER_UNAVAILABLE');
    assert.equal(error.stage, 'layer:1');
    return true;
  });
});

test('层内容被篡改时拒绝合成，错误指向具体层', async () => {
  const source = fakeSource(layers, { corrupt: [0] });
  await assert.rejects(collectDelivery({ source: source.base, requestImpl: source.requestImpl }), error => {
    assert.equal(error.code, 'LAYER_DIGEST_MISMATCH');
    assert.equal(error.stage, 'layer:0');
    return true;
  });
});

test('清单链接必须留在来源地址内，不能读取宿主机或远程地址', async () => {
  const source = fakeSource(layers, { hrefs: ['file:///etc/passwd', '/layers/1'] });
  await assert.rejects(collectDelivery({ source: source.base, requestImpl: source.requestImpl }), error => {
    assert.ok(['OFF_ORIGIN_LINK', 'INVALID_LINK'].includes(error.code));
    return true;
  });
  const remote = fakeSource(layers, { hrefs: ['http://example.invalid/layer.tar.gz', '/layers/1'] });
  await assert.rejects(collectDelivery({ source: remote.base, requestImpl: remote.requestImpl }), error => {
    assert.equal(error.code, 'OFF_ORIGIN_LINK');
    return true;
  });
});

test('来源地址本身必须是 http(s) 且不带凭据', async () => {
  await assert.rejects(collectDelivery({ source: 'file:///tmp/x' }), /http/);
  await assert.rejects(collectDelivery({ source: 'http://user:pass@host.test/' }), /凭据/);
  await assert.rejects(collectDelivery({ source: 'not a url' }), /URL/);
});

test('通过真实来源服务领取固定交付，重复领取复用同一收件版本', async context => {
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  context.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const directory = await mkdtemp(join(tmpdir(), 'delivery-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const { Archive } = await import('../src/archive.mjs');
  const archive = await new Archive(directory).initialize();
  const base = `http://127.0.0.1:${provider.address().port}`;
  const first = await collectDelivery({ source: base, archive });
  const second = await collectDelivery({ source: base, archive });
  assert.equal(first.archive.version, 1);
  assert.equal(second.archive.version, 1);
  assert.equal(second.archive.duplicate, true);
  const [record] = (await archive.list()).filter(item => item.source === 'image');
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0].data.image, 'gallery-a');
  assert.equal(record.versions[0].data.claims.length, first.claims.length);
  for (const claim of first.claims) {
    const stored = await archive.bytes(claim.sha256);
    assert.equal('sha256:' + (await import('node:crypto')).createHash('sha256').update(stored).digest('hex'), 'sha256:' + claim.sha256);
  }
  const manual = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const { receiveManual } = await import('../src/intake.mjs');
  await receiveManual(archive, manual);
  assert.equal((await archive.list()).length, 2);
});

test('缺层时真实来源不写任何收件记录', async context => {
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  context.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const directory = await mkdtemp(join(tmpdir(), 'delivery-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const { Archive } = await import('../src/archive.mjs');
  const archive = await new Archive(directory).initialize();
  const base = `http://127.0.0.1:${provider.address().port}`;
  await fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missing: true }) });
  await assert.rejects(collectDelivery({ source: base, archive }), error => error instanceof DeliveryError && error.code === 'LAYER_UNAVAILABLE');
  assert.deepEqual(await archive.list(), []);
});
