export class TransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransportError';
  }
}

export async function request(url, options = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new TransportError(`不支持的目标协议 ${target.protocol}`);
  if (target.username || target.password) throw new TransportError('目标地址不能包含凭据');
  const { maxBytes, ...rest } = options;
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...rest });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new TransportError(`来源要求重定向到 ${response.headers.get('location') ?? '未知地址'}，已拒绝跟随`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && maxBytes !== undefined && declared > maxBytes) {
    throw new TransportError(`响应声明 ${declared} 字节，超过上限`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (maxBytes !== undefined && bytes.length > maxBytes) throw new TransportError('响应超过大小上限');
  return { status: response.status, headers: Object.fromEntries(response.headers), bytes };
}
export function decodeJson(reply) {
  if (reply.status < 200 || reply.status > 299) throw new Error(`来源返回 ${reply.status}`);
  return JSON.parse(reply.bytes.toString('utf8'));
}
