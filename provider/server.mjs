import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { handle, initialState } from './scenario.mjs';

export function createProvider() {
  const state = initialState();
  return createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://localhost');
    const json = (status, payload, headers = {}) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); outgoing.end(JSON.stringify(payload)); };
    const bytes = (status, payload, type = 'application/octet-stream', headers = {}) => { outgoing.writeHead(status, { 'content-type': type, ...headers }); outgoing.end(payload); };
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const raw = Buffer.concat(chunks); let body = null;
      if (raw.length && incoming.headers['content-type']?.includes('application/json')) body = JSON.parse(raw.toString('utf8'));
      if (url.pathname === '/health') return json(200, { status: 'ok', source: state.name });
      if (url.pathname === '/__control' && incoming.method === 'POST') { Object.assign(state, body); return json(200, state); }
      if (url.pathname === '/__state') return json(200, state);
      const handled = await handle({ incoming, outgoing, url, body, raw, state, json, bytes });
      if (!handled && !outgoing.writableEnded) json(404, { error: '来源路径不存在' });
    } catch (error) { if (!outgoing.headersSent) json(400, { error: error.message }); else outgoing.destroy(error); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createProvider();
  service.listen(Number(process.env.SOURCE_PORT || 4200), '0.0.0.0', () => console.log('本地来源已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
