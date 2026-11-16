import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive, digest } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { collectDelivery, DeliveryError } from './source.mjs';

const MAX_BODY = 1048576;

async function readJsonBody(incoming) {
  const chunks = []; let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > MAX_BODY) { const error = new Error('请求体过大'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('JSON 无效'); error.status = 400; throw error; }
}

function statusFor(error) {
  if (error instanceof DeliveryError) {
    if (['MANIFEST_UNAVAILABLE', 'LAYER_UNAVAILABLE'].includes(error.code)) return 502;
    if (['INVALID_MANIFEST', 'INVALID_SOURCE', 'INVALID_LINK', 'OFF_ORIGIN_LINK'].includes(error.code)) return 422;
    return 502;
  }
  return error.status || 500;
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: 'manual+image' });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        let payload; try { payload = await readJsonBody(incoming); } catch (error) { return reply(error.status, { error: error.message }); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(422, { error: '自动领取应给出 { source }' });
        try {
          return reply(201, await collectDelivery({ source: payload.source, archive }));
        } catch (error) {
          // No receipt, no layers and no final-view report are emitted when a
          // layer is missing or fails verification: the response states the
          // failure stage and the source state is left untouched.
          return reply(statusFor(error), {
            error: error.message,
            code: error.code || 'DELIVERY_FAILED',
            stage: error.stage || null,
            complete: false,
          });
        }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        let payload; try { payload = await readJsonBody(incoming); } catch (error) { return reply(error.status, { error: error.message }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      const blob = incoming.method === 'GET' && /^\/api\/blobs\/[0-9a-f]{64}$/.test(incoming.url || '') ? incoming.url.slice('/api/blobs/'.length) : null;
      if (blob) {
        let bytes;
        try { bytes = await archive.bytes(blob); }
        catch (error) { return reply(error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? '摘要不存在' : error.message }); }
        if (digest(bytes) !== blob) return reply(500, { error: '归档内容与摘要不符' });
        outgoing.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
        return outgoing.end(bytes);
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
