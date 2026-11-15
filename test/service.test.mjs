import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
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
