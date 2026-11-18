import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export class Archive {
  constructor(directory) {
    this.directory = directory;
    this.tail = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'blobs'), { recursive: true });
    await mkdir(join(this.directory, 'receipts'), { recursive: true });
    return this;
  }
  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx');
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async put(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = digest(buffer);
    await this.atomic(join(this.directory, 'blobs', sha256), buffer);
    return sha256;
  }
  async accept(source, identity, data, raw, related = []) {
    const operation = async () => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const sha256 = digest(bytes);
      // 先写内容，最后写版本清单：任何中途失败都不会留下指向缺失内容的记录。
      for (const item of related) await this.put(item);
      await this.atomic(join(this.directory, 'blobs', sha256), bytes);
      const key = digest(Buffer.from(JSON.stringify([source, identity])));
      const path = join(this.directory, 'receipts', `${key}.json`);
      let previous = { source, identity, versions: [] };
      try { previous = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const encoded = JSON.stringify(data);
      const existing = previous.versions.find(item => item.sha256 === sha256 && JSON.stringify(item.data) === encoded);
      if (existing) return { receipt: key, version: existing.version, duplicate: true, sha256 };
      const version = previous.versions.length + 1;
      previous.versions.push({ version, sha256, data, receivedAt: new Date().toISOString() });
      await this.atomic(path, Buffer.from(JSON.stringify(previous)));
      return { receipt: key, version, duplicate: false, sha256 };
    };
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  async list() {
    await this.tail;
    const names = (await readdir(join(this.directory, 'receipts'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(this.directory, 'receipts', name), 'utf8'))));
  }
  async bytes(sha256) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('摘要格式无效');
    return readFile(join(this.directory, 'blobs', sha256));
  }
}
