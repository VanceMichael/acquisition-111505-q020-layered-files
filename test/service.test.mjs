import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
test('真实 HTTP 人工入口与查询使用同一归档', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-')); const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const response = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  assert.equal(response.status, 201); assert.equal((await response.json()).version, 1);
  assert.equal((await (await fetch(base + '/api/records')).json()).length, 1);
  const invalid = await fetch(base + '/api/manual', { method: 'POST', body: '{' }); assert.equal(invalid.status, 400);
});

test('自动领取经真实 HTTP 入口返回最终视图并可按摘要取回内容', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-')); const service = await createIntake(directory);
  const provider = createProvider();
  service.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(service, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    service.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  assert.equal(collected.status, 201);
  const report = await collected.json();
  assert.equal(report.complete, true);
  assert.deepEqual(report.claims.map(claim => claim.path), ['assets/alias.txt', 'assets/new.txt', 'cache/current.txt', 'etc/gallery.conf']);
  assert.equal(report.view.some(node => node.path === 'assets/old.txt'), false);
  assert.equal(report.claims.find(claim => claim.path === 'etc/gallery.conf').layerIndex, 1);
  const blob = await fetch(base + report.claims.find(claim => claim.path === 'etc/gallery.conf').href);
  assert.equal(blob.status, 200);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'language=zh');
  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records.filter(record => record.source === 'image').length, 1);
});

test('层缺失时 HTTP 领取返回失败且不留下收件', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-')); const service = await createIntake(directory);
  const provider = createProvider();
  service.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(service, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    service.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missing: true }) });
  const response = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.complete, false);
  assert.equal(body.code, 'LAYER_UNAVAILABLE');
  assert.equal(body.stage, 'layer:1');
  assert.deepEqual(await (await fetch(base + '/api/records')).json(), []);
});

test('领取请求必须是含 source 的 JSON 对象', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'service-')); const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;
  assert.equal((await fetch(base + '/api/collect', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/collect', { method: 'POST', body: '[]' })).status, 422);
  assert.equal((await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 422);
  assert.equal((await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'file:///etc/passwd' }) })).status, 422);
});
