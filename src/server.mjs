import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual, receiveDelivery } from './intake.mjs';
import { DeliveryError, latestDelivery, viewRecord } from './delivery.mjs';

const MAX_EVIDENCE = 100000;
const errorStatus = error => (error instanceof DeliveryError ? error.status : 422);

function evidencePage(view, limit) {
  if (!Array.isArray(view.history)) return [];
  return view.history.slice(Math.max(0, view.history.length - limit));
}

function deliveryView(record, version) {
  const stored = viewRecord(version.data ?? {});
  return {
    source: record.source,
    image: record.identity?.image ?? stored.image,
    version: version.version,
    receivedAt: version.receivedAt,
    manifestSha256: stored.manifestSha256,
    layers: stored.layers,
    entries: stored.entries,
    selection: stored.selection,
    history: stored.history,
    events: stored.events,
    pending: stored.pending,
    ...(stored.incomplete ? { incomplete: true } : {}),
  };
}

async function readJsonBody(incoming) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > 1048576) return { tooLarge: true };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { value: {} };
  try { return { value: JSON.parse(text) }; }
  catch { return { invalid: true }; }
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      const pathname = url.pathname;
      if (incoming.method === 'GET' && pathname === '/health') return reply(200, { status: 'ok', acquisition: 'manual+delivery' });
      if (incoming.method === 'GET' && pathname === '/api/records') return reply(200, await archive.list());

      if (incoming.method === 'POST' && pathname === '/api/collect') {
        const body = await readJsonBody(incoming);
        if (body.tooLarge) return reply(413, { error: '单份收件请求过大' });
        if (body.invalid) return reply(400, { error: 'JSON 无效' });
        const target = body.value?.source ?? body.value?.url;
        try {
          const result = await receiveDelivery(archive, target, body.value?.limits ? { limits: body.value.limits } : {});
          return reply(201, result);
        } catch (error) {
          if (!(error instanceof DeliveryError)) return reply(500, { error: error.message });
          return reply(error.status, {
            error: error.message,
            kind: error.kind,
            ...(error.layer !== null ? { layer: error.layer } : {}),
            ...(error.digest ? { digest: error.digest } : {}),
          });
        }
      }

      if (incoming.method === 'GET' && pathname === '/api/view') {
        const records = await archive.list();
        const found = latestDelivery(records, { source: url.searchParams.get('source') || undefined });
        if (!found) return reply(404, { error: '尚无已领取的层式交付' });
        return reply(200, deliveryView(found.record, found.version));
      }

      if (incoming.method === 'GET' && pathname === '/api/evidence') {
        const records = await archive.list();
        const found = latestDelivery(records, { source: url.searchParams.get('source') || undefined });
        if (!found) return reply(404, { error: '尚无已领取的层式交付' });
        const view = viewRecord(found.version.data ?? {});
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || MAX_EVIDENCE, 1), MAX_EVIDENCE);
        const history = evidencePage(view, limit);
        return reply(200, {
          source: found.record.source,
          image: view.image,
          version: found.version.version,
          history,
          events: view.events,
          pending: view.pending,
          note: '以下条目已被后续层替换、删除或不透明标记屏蔽，只是历史证据，不属于当前最终视图或素材清单。',
        });
      }

      if (incoming.method === 'GET' && pathname === '/api/file') {
        const records = await archive.list();
        const found = latestDelivery(records, { source: url.searchParams.get('source') || undefined });
        if (!found) return reply(404, { error: '尚无已领取的层式交付' });
        const view = viewRecord(found.version.data ?? {});
        const requested = url.searchParams.get('path');
        if (!requested) return reply(400, { error: '缺少 path 参数' });
        const entry = view.entries?.find(item => item.path === requested);
        if (!entry || !entry.selected) return reply(404, { error: '该路径不在当前素材清单中', path: requested });
        if (entry.type !== 'file') return reply(409, { error: '该路径不是普通文件，未读取其目标', type: entry.type });
        let bytes;
        try { bytes = await archive.bytes(entry.sha256); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return reply(409, { error: '归档中缺少该文件内容，交付不再完整', path: requested });
        }
        outgoing.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
          'x-content-sha256': entry.sha256,
          'x-content-layer': String(entry.contentLayer),
          'x-content-path': entry.contentPath ?? entry.path,
        });
        return outgoing.end(bytes);
      }

      if (incoming.method === 'POST' && pathname === '/api/manual') {
        const body = await readJsonBody(incoming);
        if (body.tooLarge) return reply(413, { error: '单份人工收件过大' });
        if (body.invalid) return reply(400, { error: 'JSON 无效' });
        try { return reply(201, await receiveManual(archive, body.value)); } catch (error) { return reply(422, { error: error.message }); }
      }

      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(errorStatus(error), { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
