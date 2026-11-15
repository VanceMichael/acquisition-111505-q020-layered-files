import { readFile } from 'node:fs/promises';
import { digest } from './archive.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
export function manualRecord(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('人工收件应是对象');
  for (const field of configuration.identityFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') throw new Error(`缺少业务身份 ${field}`);
  }
  const identity = Object.fromEntries(configuration.identityFields.map(field => [field, payload[field]]));
  return { identity, data: structuredClone(payload) };
}
export async function receiveManual(archive, payload) {
  const parsed = manualRecord(payload);
  const raw = Buffer.from(JSON.stringify(payload));
  const receipt = await archive.accept('manual', parsed.identity, parsed.data, raw);
  return { ...receipt, identity: parsed.identity, rawSha256: digest(raw) };
}
