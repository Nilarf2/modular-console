import { createApp } from './app.js';
import { openRuntime } from './runtime.js';
import { join } from 'node:path';

const demo = process.env.CONSOLE_DEMO === 'true';
const { store, dataDir } = await openRuntime(process.env.CONSOLE_DATA_DIR ?? (demo ? 'data/demo' : 'data/live'), process.env.CONSOLE_ADMIN_PASSWORD_FILE);
const { app } = await createApp({ store, origin: process.env.CONSOLE_PUBLIC_ORIGIN, demo });
const port = Number(process.env.PORT ?? (demo ? 9471 : 9470));
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`Console ${demo ? '(read-only demo)' : ''} listening on ${process.env.HOST ?? '127.0.0.1'}:${port}`);
console.log(`Private data: ${dataDir}. Initial password (if generated): ${join(dataDir, 'initial-password')}`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); store.close(); };
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
