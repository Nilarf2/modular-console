import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { pluginCatalog } from '../shared/catalog.js';
import type { AppState, LiveState } from '../shared/types.js';
import { registerServerPlugins } from '../plugins/registry.js';
import { HttpError } from './errors.js';
import { checkPassword, digest, equal, hashPassword, secret } from './crypto.js';
import { Store } from './store.js';
import { settingsSchema } from './validation.js';

export interface AppOptions {
  store: Store; origin?: string; webRoot?: string; demo?: boolean; now?: () => number; timers?: boolean;
}

export async function createApp(options: AppOptions) {
  const { store } = options; const now = options.now ?? Date.now;
  let settings = store.settings();
  const app = Fastify({ logger: false, bodyLimit: 65536, requestTimeout: 15000, connectionTimeout: 15000,
    keepAliveTimeout: 5000, forceCloseConnections: true });
  await app.register(cookie);
  const publicOrigin = options.origin ? new URL(options.origin).origin : undefined;
  const secureCookie = publicOrigin?.startsWith('https:') ?? false;
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  const streams = new Set<() => void>();
  const isDemo = options.demo === true;
  function sessionFor(req: FastifyRequest) { return req.cookies.console_session ? store.session(digest(req.cookies.console_session), now()) : undefined; }
  function requireSession(req: FastifyRequest) { const session = sessionFor(req); if (!session) throw new HttpError(401, '请先登录'); return session; }
  function allowedOrigin(req: FastifyRequest) {
    const source = req.headers.origin;
    if (!source) return true; // Non-browser clients must still carry session + CSRF token.
    if (publicOrigin) return source === publicOrigin;
    try { const url = new URL(source); return url.host === req.headers.host && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); }
    catch { return false; }
  }
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secureCookie) reply.header('Strict-Transport-Security', 'max-age=31536000');
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!path.startsWith('/api/') || path.startsWith('/api/ingest/') || path === '/api/health' || path === '/api/auth') return;
    if (path === '/api/auth/login') {
      if (!allowedOrigin(req)) throw new HttpError(403, '请求来源不匹配');
      return;
    }
    if (isDemo && req.method === 'GET') return;
    if (isDemo) throw new HttpError(403, '示例模式为只读，请在独立实例中配置真实数据');
    const session = requireSession(req);
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!allowedOrigin(req) || typeof req.headers['x-csrf-token'] !== 'string' || !equal(req.headers['x-csrf-token'], session.csrf))
        throw new HttpError(403, '页面会话已变化，请刷新后重试');
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: '配置无效：' + err.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('；') });
    const code = typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 500;
    if (code >= 400 && code < 500) return reply.code(code).send({ error: err instanceof HttpError ? err.message : '请求无效或超过限制' });
    return reply.code(500).send({ error: '服务器处理失败，请检查本机服务状态' });
  });
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  app.get('/api/auth', async req => ({ authenticated: isDemo || !!sessionFor(req), demo: isDemo }));
  app.post('/api/auth/login', async (req, reply) => {
    const a = authAttempts.get(req.ip); const t = now();
    if (a && a.resetAt > t && a.count >= 8) throw new HttpError(429, '登录尝试过多，请 15 分钟后再试');
    const entry = a && a.resetAt > t ? a : { count: 0, resetAt: t + 900000 };
    authAttempts.set(req.ip, entry); entry.count++;
    const { password } = z.object({ password: z.string().min(1).max(256) }).strict().parse(req.body);
    if (!await checkPassword(password, store.value('password') ?? '')) throw new HttpError(401, '密码不正确');
    authAttempts.delete(req.ip);
    const token = secret(); const csrf = secret(); const expires = t + 7 * 86400000;
    store.newSession(digest(token), csrf, expires);
    reply.setCookie('console_session', token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, path: '/', maxAge: 7 * 86400 });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    store.removeSession(digest(req.cookies.console_session!)); reply.clearCookie('console_session', { path: '/' }); return { ok: true };
  });
  app.post('/api/auth/password', async (req, reply) => {
    const v = z.object({ currentPassword: z.string().min(1).max(256), password: z.string().min(12).max(256) }).strict().parse(req.body);
    if (!await checkPassword(v.currentPassword, store.value('password')!)) throw new HttpError(401, '当前密码不正确');
    store.setValue('password', await hashPassword(v.password)); store.clearSessions();
    reply.clearCookie('console_session', { path: '/' }); return { ok: true };
  });
  const plugins = registerServerPlugins({ app, store, now, origin: publicOrigin, demo: isDemo, getSettings: () => settings, saveSettings: s => { store.saveSettings(s); settings = s; } });
  function liveState(): LiveState { return { ...plugins.snapshot(), serverTime: now() }; }
  app.get('/api/state', async (req): Promise<AppState> => ({ ...liveState(), settings, plugins: pluginCatalog, csrfToken: sessionFor(req)?.csrf ?? '', demo: isDemo }));
  app.patch('/api/settings', async req => {
    const next = settingsSchema.parse(req.body);
    const nodes = new Map(plugins.hosts.nodes().map(n => [n.id, n])); const connIds = new Set(store.connections().map(c => c.id));
    for (const w of next.widgets) {
      const def = pluginCatalog.find(p => p.id === w.pluginId)!.widgets.find(d => d.type === w.type)!;
      if ((def.source === 'node' && !nodes.has(w.sourceId ?? '')) || (def.source === 'connection' && !connIds.has(w.sourceId ?? '')))
        throw new HttpError(409, '组件的数据源已删除，请重新选择');
      if (def.capability && !nodes.get(w.sourceId ?? '')?.capabilities.includes(def.capability))
        throw new HttpError(400, '该节点未报告 GPU 能力，请先启动采集端');
    }
    store.saveSettings(next); settings = next;
    if (!settings.enabledPlugins.includes('newapi')) plugins.newapi.clear();
    store.cleanup(now(), settings.retentionDays); return { settings };
  });
  app.get('/api/stream', async (req, reply) => {
    const { intervalMs } = z.object({ intervalMs: z.coerce.number().int().min(200).max(60000).default(1000) }).parse(req.query);
    if (streams.size >= 16) throw new HttpError(429, '实时连接数量已达上限');
    const sse = reply.raw;
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) sse.setHeader(key, value);
    sse.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.hijack();
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); streams.delete(stop); sse.end(); };
    const send = () => {
      if (!isDemo && !sessionFor(req)) { sse.write('event: expired\ndata: {}\n\n'); stop(); return; }
      if (sse.writableLength > 256 * 1024) { stop(); return; }
      sse.write(`event: live\ndata: ${JSON.stringify(liveState())}\n\n`);
    };
    const timer = setInterval(send, intervalMs); timer.unref(); streams.add(stop);
    sse.on('close', stop); send();
  });
  const webRoot = resolve(options.webRoot ?? 'dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, maxAge: 0 });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }
  const timers: ReturnType<typeof setInterval>[] = [];
  if (options.timers !== false) {
    timers.push(setInterval(() => { plugins.hosts.tick(); }, 1000));
    timers.push(setInterval(() => { store.cleanup(now(), settings.retentionDays); for (const [key, v] of authAttempts) if (v.resetAt < now()) authAttempts.delete(key); }, 60000));
    timers.push(setInterval(() => void plugins.newapi.refreshAll().catch(() => {}), 30000));
    for (const t of timers) t.unref();
    if (!isDemo) void plugins.newapi.refreshAll().catch(() => {});
  }
  app.addHook('onClose', async () => { for (const t of timers) clearInterval(t); for (const stop of streams) stop(); await plugins.close(); });
  return { app, metrics: plugins.hosts.metrics, refreshConnection: plugins.newapi.refreshConnection };
}
