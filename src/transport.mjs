export async function request(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...options });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: Object.fromEntries(response.headers), bytes };
}
export function decodeJson(reply) {
  if (reply.status < 200 || reply.status > 299) throw new Error(`来源返回 ${reply.status}`);
  return JSON.parse(reply.bytes.toString('utf8'));
}
