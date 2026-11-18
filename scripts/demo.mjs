import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));

  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  console.log(JSON.stringify({ 自动领取: collected.status, ...(await collected.json()) }));

  const view = await (await fetch(base + '/api/view')).json();
  console.log(JSON.stringify({
    最终视图: view.entries.map(entry => `${entry.path} (${entry.type}, 层 ${entry.layer}${entry.contentLayer !== undefined && entry.contentLayer !== null ? `, 内容来自层 ${entry.contentLayer}` : ''})`),
  }));
  console.log(JSON.stringify({
    素材清单: view.selection.map(entry => ({ 路径: entry.path, 类型: entry.type, 层: entry.contentLayer ?? entry.layer, 摘要: entry.sha256 })),
  }));
  const file = await fetch(base + '/api/file?path=etc/gallery.conf');
  console.log(JSON.stringify({ 领取文件: { status: file.status, 层: file.headers.get('x-content-layer'), 内容: await file.text() } }));

  const evidence = await (await fetch(base + '/api/evidence')).json();
  console.log(JSON.stringify({ 历史证据: evidence.history.map(item => `${item.path} ${item.action} 于层 ${item.layer}`) }));

  await fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ corrupt: true }) });
  const broken = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  console.log(JSON.stringify({ 校验失败: { status: broken.status, ...(await broken.json()) } }));
  console.log(JSON.stringify({ 记录未被部分覆盖: (await (await fetch(base + '/api/records')).json()).length }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
