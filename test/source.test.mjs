import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('层清单给出有序真实摘要且上层带白化标记', async context => {
  const { base } = await withSource(context); const manifest = await (await fetch(base + '/image/manifest')).json(); assert.equal(manifest.orderedLayers.length, 2);
  const raw = Buffer.from(await (await fetch(base + '/layers/1')).arrayBuffer()); const { gunzipSync } = await import('node:zlib'); const tar = gunzipSync(raw);
  assert.match(tar.toString(), /\.wh\.old\.txt/); assert.match(tar.toString(), /\.wh\.\.wh\.\.opq/);
  const { createHash } = await import('node:crypto'); assert.equal('sha256:' + createHash('sha256').update(raw).digest('hex'), manifest.orderedLayers[1].digest);
});
test('层缺失和内容校验失败可以分别复现', async context => {
  const { base, control } = await withSource(context); await control({ missing: true }); assert.equal((await fetch(base + '/layers/1')).status, 404);
  await control({ missing: false, corrupt: true }); const raw = Buffer.from(await (await fetch(base + '/layers/1')).arrayBuffer()); const { gunzipSync } = await import('node:zlib'); assert.throws(() => gunzipSync(raw));
});
