import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../src/archive.mjs';
import { manualRecord, receiveManual } from '../src/intake.mjs';
const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
test('人工收件保留业务身份与原始字节', async context => {
  const path = await mkdtemp(join(tmpdir(), 'archive-')); context.after(() => rm(path, { recursive: true, force: true }));
  const archive = await new Archive(path).initialize(); const receipt = await receiveManual(archive, sample);
  assert.deepEqual(JSON.parse((await archive.bytes(receipt.sha256)).toString()), sample);
  assert.equal((await archive.list())[0].source, 'manual');
});
test('重复收件复用版本而更正保留历史', async context => {
  const path = await mkdtemp(join(tmpdir(), 'archive-')); context.after(() => rm(path, { recursive: true, force: true }));
  const archive = await new Archive(path).initialize();
  await receiveManual(archive, sample); assert.equal((await receiveManual(archive, sample)).duplicate, true);
  await receiveManual(archive, { ...sample, staffNote: '已重新核对' });
  const [record] = await archive.list(); assert.equal(record.versions.length, 2); assert.equal(record.versions[0].data.staffNote, undefined);
  const reopened = await new Archive(path).initialize(); assert.equal((await reopened.list())[0].versions.length, 2);
});
test('并行收件不会覆盖其他版本', async context => {
  const path = await mkdtemp(join(tmpdir(), 'archive-')); context.after(() => rm(path, { recursive: true, force: true }));
  const archive = await new Archive(path).initialize();
  await Promise.all(Array.from({ length: 8 }, (_, index) => receiveManual(archive, { ...sample, staffNote: String(index) })));
  assert.equal((await archive.list())[0].versions.length, 8);
});
test('缺少业务身份时拒绝接收', () => { assert.throws(() => manualRecord({}), /缺少业务身份/); });
