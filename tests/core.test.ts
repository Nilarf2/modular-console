import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { hashPassword, digest } from '../src/server/crypto.js';
import { openRuntime } from '../src/server/runtime.js';
import { defaultSettings } from '../src/shared/catalog.js';
import type { AppState, Sample } from '../src/shared/types.js';

const password = 'test-only-password-12345';
const sample = (timestamp: number, overrides: Partial<Sample> = {}): Sample => ({
  timestamp, intervalMs: 200, cpuPct: 0, memory: { usedBytes: 50, totalBytes: 100 }, disks: [],
  network: { rxBytesPerSec: null, txBytesPerSec: 0 }, gpus: [], uptimeSec: 120, ...overrides,
});
async function harness(t: TestContext) {
  const store = new Store(':memory:', randomBytes(32)); await store.setValue('password', await hashPassword(password));
  let time = Date.now(); const advance = (n: number) => { time += n; };
  const result = await createApp({ store, timers: false, now: () => time, webRoot: '/nonexistent' });
  t.after(async () => { await result.app.close(); store.close(); });
  const login = await result.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  const cookie = login.headers['set-cookie']!.toString().split(';')[0];
  const state = (await result.app.inject({ url: '/api/state', headers: { cookie } })).json<AppState>();
  const headers = { cookie, 'x-csrf-token': state.csrfToken };
  const createNode = async (name = 'Test Node') => (await result.app.inject({ method: 'POST', url: '/api/nodes', headers, payload: { name } })).json<{ node: { id: string }; token: string }>();
  return { ...result, store, headers, cookie, state, createNode, advance, now: () => time };
}

test('authentication, CSRF, origin and cookie protect private state', async t => {
  const h = await harness(t);
  assert.equal((await h.app.inject('/api/state')).statusCode, 401);
  assert.equal((await h.app.inject('/api/stream')).statusCode, 401);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/nodes', headers: { cookie: h.cookie }, payload: { name: 'no' } })).statusCode, 403);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/nodes', headers: { ...h.headers, origin: 'https://attacker.invalid' }, payload: { name: 'no' } })).statusCode, 403);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } })).statusCode, 401);
  const node = await h.createNode(); assert.ok(node.node.id); assert.ok(node.token.length > 30);
  const state = await h.app.inject({ url: '/api/state', headers: h.headers });
  assert.ok(!state.body.includes(node.token)); assert.ok(!state.body.includes('token_hash'));
  assert.equal(state.headers['cache-control'], 'no-store'); assert.equal(state.headers['x-frame-options'], 'DENY');
  const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  assert.match(String(login.headers['set-cookie']), /HttpOnly/); assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
});

test('login rate limits failed passwords', async t => {
  const h = await harness(t);
  for (let i = 0; i < 8; i++) assert.equal((await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'invalid' } })).statusCode, 401);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode, 429);
  h.advance(900001);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode, 200);
});

test('per-node tokens, data validation, rate feedback, rotation and removal', async t => {
  const h = await harness(t); const a = await h.createNode('A'); const b = await h.createNode('B');
  const send = (id: string, token: string, body: unknown) => h.app.inject({ method: 'POST', url: `/api/ingest/${id}`, headers: { authorization: `Bearer ${token}`, 'x-agent-platform': 'Linux' }, payload: body as object });
  assert.equal((await send(b.node.id, a.token, sample(h.now()))).statusCode, 401);
  assert.equal((await send(a.node.id, a.token, sample(h.now(), { cpuPct: 101 }))).statusCode, 400);
  assert.equal((await send(a.node.id, a.token, sample(h.now() - 300001))).statusCode, 400);
  await h.app.inject({ method: 'PATCH', url: `/api/nodes/${a.node.id}`, headers: h.headers, payload: { intervalMs: 200 } });
  const r = await send(a.node.id, a.token, sample(h.now(), { intervalMs: 199 }));
  assert.equal(r.statusCode, 200); assert.equal(r.json().intervalMs, 200);
  assert.equal((await send(a.node.id, a.token, sample(h.now()))).statusCode, 429);
  const state = (await h.app.inject({ url: '/api/state', headers: h.headers })).json<AppState>();
  assert.equal(state.nodes[0].sample?.cpuPct, 0); assert.equal(state.nodes[0].sample?.network?.rxBytesPerSec, null);
  assert.equal(state.nodes[0].online, true); assert.equal(state.nodes[1].online, false); assert.equal(state.nodes[1].sample, null);
  const rotated = (await h.app.inject({ method: 'POST', url: `/api/nodes/${a.node.id}/rotate`, headers: h.headers })).json<{ token: string }>();
  h.advance(1000);
  assert.equal((await send(a.node.id, a.token, sample(h.now()))).statusCode, 401);
  assert.equal((await send(a.node.id, rotated.token, sample(h.now()))).statusCode, 200);
  await h.app.inject({ method: 'DELETE', url: `/api/nodes/${a.node.id}`, headers: h.headers });
  h.advance(1000); assert.equal((await send(a.node.id, rotated.token, sample(h.now()))).statusCode, 401);
});

test('high-frequency measurements are averaged into history, with nulls and offline boundaries', async t => {
  const h = await harness(t); const { node } = await h.createNode(); const n = h.store.node(node.id)!;
  const start = h.now();
  for (let i = 0; i < 25; i++) {
    assert.ok(h.metrics.accept(n, sample(h.now(), { cpuPct: i % 2 === 0 ? null : 0 }), h.now())); h.advance(200);
  }
  h.metrics.tick(h.now());
  const rows = h.store.history(n.id, start);
  assert.equal(rows.length, 1); assert.equal(rows[0].sample!.cpuPct, 0); assert.equal(rows[0].sample!.network!.rxBytesPerSec, null);
  h.advance(6000); h.metrics.tick(h.now());
  const offline = h.metrics.view(h.now())[0]; assert.equal(offline.online, false); assert.equal(offline.sample, null);
  assert.equal(h.store.history(n.id, start).at(-1)!.sample, null);
  assert.ok(h.metrics.accept(n, sample(h.now(), { cpuPct: null }), h.now()));
  h.advance(5000); h.metrics.tick(h.now());
  assert.equal(h.store.history(n.id, start).at(-1)!.sample!.cpuPct, null);
});

test('settings validate sources and capabilities; disabled plugins preserve configuration', async t => {
  const h = await harness(t); const a = await h.createNode();
  const w = { id: 'cpu', pluginId: 'hosts', type: 'node-basic', sourceId: a.node.id, title: 'CPU', variant: 'compact' as const, width: 'normal' as const };
  const save = (s: unknown) => h.app.inject({ method: 'PATCH', url: '/api/settings', headers: h.headers, payload: s as object });
  assert.equal((await save({ ...defaultSettings(), widgets: [{ ...w, type: 'node-gpu' }] })).statusCode, 400);
  assert.equal((await save({ ...defaultSettings(), widgets: [{ ...w, sourceId: 'unknown' }] })).statusCode, 409);
  assert.equal((await save({ ...defaultSettings(), widgets: [w, w] })).statusCode, 400);
  assert.equal((await save({ ...defaultSettings(), widgets: [w], enabledPlugins: [] })).statusCode, 200);
  assert.equal(h.store.settings().widgets.length, 1);
  await h.app.inject({ method: 'DELETE', url: `/api/nodes/${a.node.id}`, headers: h.headers });
  assert.equal(h.store.settings().widgets.length, 0);
});

test('retention prunes history, credential store encrypts sensitive config', async t => {
  const h = await harness(t); const a = await h.createNode();
  h.store.insertHistory(a.node.id, { timestamp: h.now() - 2 * 86400000, sample: sample(h.now()) }, h.now());
  h.store.cleanup(h.now(), 1); assert.equal(h.store.history(a.node.id, 0).length, 0);
  const token = 'sensitive-config-value';
  h.store.addConnection('test', 'API', { baseUrl: 'https://service.invalid', token, userId: 1, quotaPerUnit: 500000, currency: 'USD' });
  const row = h.store.db.prepare('SELECT config FROM connections').get() as { config: string };
  assert.ok(!row.config.includes(token)); assert.equal(h.store.connections()[0].token, token);
  const state = await h.app.inject({ url: '/api/state', headers: h.headers }); assert.ok(!state.body.includes(token));
});

test('password change expires sessions and old password immediately', async t => {
  const h = await harness(t);
  const wrong = await h.app.inject({ method: 'POST', url: '/api/auth/password', headers: h.headers, payload: { currentPassword: 'invalid', password: 'new-password-12345' } });
  assert.equal(wrong.statusCode, 401);
  const right = await h.app.inject({ method: 'POST', url: '/api/auth/password', headers: h.headers, payload: { currentPassword: password, password: 'new-password-12345' } });
  assert.equal(right.statusCode, 200);
  assert.equal((await h.app.inject({ url: '/api/state', headers: h.headers })).statusCode, 401);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode, 401);
});

test('persistent startup uses same encryption key, stores password hash and restrictive permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'console-runtime-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await openRuntime(dir); const encoded = first.store.value('password');
  const initial = (await readFile(join(dir, 'initial-password'), 'utf8')).trim();
  assert.ok(encoded?.startsWith('scrypt:')); assert.ok(!encoded?.includes(initial));
  const key = await readFile(join(dir, 'encryption-key')); first.store.close();
  const again = await openRuntime(dir); t.after(() => again.store.close());
  assert.equal(again.store.value('password'), encoded); assert.deepEqual(await readFile(join(dir, 'encryption-key')), key);
  assert.equal((await stat(join(dir, 'initial-password'))).mode & 0o777, 0o600);
});

test('read-only demo never accepts real credentials or ingestion', async t => {
  const store = new Store(':memory:', randomBytes(32));
  const { app } = await createApp({ store, demo: true, timers: false, webRoot: '/nonexistent' }); t.after(async () => { await app.close(); store.close(); });
  const state = (await app.inject('/api/state')).json<AppState>(); assert.equal(state.demo, true); assert.equal(state.nodes.length, 2);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plugins/newapi/connections', payload: { token: 'never-store' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ingest/demo-edge', payload: sample(Date.now()) })).statusCode, 403);
});

test('live SSE obeys cadence and invalidates when session expires', async t => {
  const h = await harness(t); await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/stream?intervalMs=200`, { headers: { cookie: h.cookie }, signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader();
  const chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /event: live/);
  h.store.clearSessions();
  const expired = await reader.read(); assert.match(new TextDecoder().decode(expired.value), /event: expired/);
  await reader.cancel();
});
