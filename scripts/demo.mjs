import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { collectDelivery } from '../src/source.mjs';
import { extractFinalView } from '../src/extract.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const extracted = await mkdtemp(join(tmpdir(), 'extract-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const observed = await fetch(source + project.probe, project.probeBody ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.probeBody) } : {}); const raw = Buffer.from(await observed.arrayBuffer());
  console.log(JSON.stringify({ 来源状态: observed.status, 原始字节: raw.length, 来源类型: observed.headers.get('content-type') }));

  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  const report = await collected.json();
  console.log(JSON.stringify({
    自动领取: collected.status,
    完成: report.complete,
    层: report.layers,
    当前文件: report.view.map(node => `${node.type}:${node.path}`),
    素材清单: report.claims.map(claim => ({ 路径: claim.path, 摘要: claim.sha256, 层: claim.layerIndex })),
    历史证据: report.history.map(item => ({ 路径: item.path, 动作: item.action, 原层: item.previous?.layerIndex })),
    链接: report.links,
    未决: report.pending,
  }));

  const extraction = await extractFinalView(await collectDelivery({ source }), extracted);
  console.log(JSON.stringify({ 解包根: extraction.root, 落地文件: extraction.files.map(file => file.path), 越界: extraction.escaped, 链接写入: extraction.links.filter(link => link.materialized) }));

  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));
  console.log(JSON.stringify({ 已存记录: (await (await fetch(base + '/api/records')).json()).map(record => ({ source: record.source, versions: record.versions.length })) }));

  const missing = await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missing: true }) });
  await missing.arrayBuffer();
  const failed = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  console.log(JSON.stringify({ 缺层领取: failed.status, 结果: await failed.json() }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await Promise.all([rm(directory, { recursive: true, force: true }), rm(extracted, { recursive: true, force: true })]);
}
