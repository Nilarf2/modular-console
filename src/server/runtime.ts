import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { hashPassword, secret } from './crypto.js';

export async function openRuntime(directory: string, passwordFile?: string) {
  const dataDir = resolve(directory);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700);
  const keyPath = join(dataDir, 'encryption-key');
  const database = join(dataDir, 'console.sqlite');
  if (!existsSync(keyPath)) {
    if (existsSync(database)) throw new Error('数据库存在但加密密钥缺失。请恢复原密钥；不会生成替代密钥。');
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = readFileSync(keyPath); if (key.length !== 32) throw new Error('加密密钥无效');
  const store = new Store(database, key);
  try {
    if (!store.value('password')) {
      const initialFile = join(dataDir, 'initial-password');
      const password = passwordFile ? readFileSync(passwordFile, 'utf8').trim() : existsSync(initialFile) ? readFileSync(initialFile, 'utf8').trim() : secret();
      if (password.length < 12 || password.length > 256) throw new Error('管理员密码必须为 12–256 个字符');
      if (!passwordFile && !existsSync(initialFile)) writeFileSync(initialFile, password + '\n', { flag: 'wx', mode: 0o600 });
      store.setValue('password', await hashPassword(password));
    }
    return { store, dataDir };
  } catch (e) { store.close(); throw e; }
}
