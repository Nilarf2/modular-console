import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sample, Settings } from '../../shared/types.js';
import type { ServerPluginContext } from '../../server/plugin.js';
import { HttpError, requireValue } from '../../server/errors.js';
import { digest, equal, secret } from '../../server/crypto.js';
import { intervalSchema, nameSchema } from '../../server/validation.js';
import { sampleSchema } from './schema.js';
import { Metrics } from './metrics.js';

export function registerHosts(context: ServerPluginContext) {
  const { app, store, now, origin: publicOrigin, demo: isDemo, getSettings, saveSettings } = context;
  const metrics = new Metrics(store, getSettings);
  if (isDemo && store.nodes().length === 0) {
    for (const [id, name, gpu] of [['demo-edge', 'Edge · 示例', false], ['demo-gpu', 'Studio · 示例', true]] as const) {
      store.addNode(id, name, digest(secret())); store.nodeMeta(id, gpu ? 'Windows' : 'Linux', gpu ? ['cpu', 'memory', 'disk', 'network', 'gpu'] : ['cpu', 'memory', 'disk', 'network']);
    }
    const settings: Settings = { ...getSettings(), widgets: [
      { id: 'demo-fleet', pluginId: 'hosts', type: 'fleet', title: '节点总览', variant: 'detailed', width: 'wide' },
      { id: 'demo-basic', pluginId: 'hosts', type: 'node-basic', title: 'Edge', sourceId: 'demo-edge', variant: 'detailed', width: 'normal' },
      { id: 'demo-gpu', pluginId: 'hosts', type: 'node-gpu', title: 'Studio', sourceId: 'demo-gpu', variant: 'detailed', width: 'normal' },
    ] };
    saveSettings(settings);
  }
  const seedDemo = () => {
    if (!isDemo) return;
    for (const n of store.nodes()) {
      const g = n.id === 'demo-gpu'; const t = now();
      const sample: Sample = { timestamp: t, intervalMs: 1000, cpuPct: g ? 27.5 : 12.3,
        memory: { usedBytes: (g ? 10 : 3.8) * 1024 ** 3, totalBytes: (g ? 32 : 8) * 1024 ** 3 },
        disks: [{ mount: g ? 'C:\\' : '/', usedBytes: 97 * 1024 ** 3, totalBytes: 256 * 1024 ** 3 }],
        network: { rxBytesPerSec: 34528, txBytesPerSec: 82300 }, uptimeSec: 273600,
        gpus: g ? [{ id: 'demo-gpu0', name: '示例 GPU', utilizationPct: 43, memoryUsedBytes: 3.2 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, temperatureC: 58 }] : [] };
      metrics.accept(n, sample, t);
    }
  };
  seedDemo();
  const makeConfig = (id: string, token: string, intervalMs: number) => ({
    consoleUrl: publicOrigin ?? 'http://127.0.0.1:9470', nodeId: id, token, intervalMs,
  });
  app.post('/api/nodes', async req => {
    if (store.nodes().length >= 200) throw new HttpError(400, '最多支持 200 个节点');
    const { name } = z.object({ name: nameSchema }).strict().parse(req.body);
    const id = randomUUID(); const token = secret(); store.addNode(id, name, digest(token));
    return { node: metrics.view(now()).find(n => n.id === id), token, config: makeConfig(id, token, 1000) };
  });
  app.patch('/api/nodes/:id', async req => {
    const { id } = req.params as { id: string }; const n = requireValue(store.node(id), '节点不存在');
    const v = z.object({ name: nameSchema.optional(), intervalMs: intervalSchema.optional() }).strict().parse(req.body);
    store.updateNode(id, v.name ?? n.name, v.intervalMs ?? n.interval_ms);
    return { node: metrics.view(now()).find(n => n.id === id) };
  });
  app.post('/api/nodes/:id/rotate', async req => {
    const { id } = req.params as { id: string }; const n = requireValue(store.node(id), '节点不存在');
    const token = secret(); store.rotateNode(id, digest(token)); return { token, config: makeConfig(id, token, n.interval_ms) };
  });
  app.delete('/api/nodes/:id', async req => {
    const { id } = req.params as { id: string }; requireValue(store.node(id), '节点不存在');
    const settings = { ...getSettings(), widgets: getSettings().widgets.filter(w => !(w.pluginId === 'hosts' && w.sourceId === id)) };
    saveSettings(settings); store.deleteNode(id); metrics.forget(id); return { ok: true };
  });
  app.get('/api/nodes/:id/history', async req => {
    const { id } = req.params as { id: string }; requireValue(store.node(id), '节点不存在');
    const { window } = z.object({ window: z.coerce.number().int().min(60000).max(7 * 86400000).default(3600000) }).parse(req.query);
    return { points: metrics.history(id, now() - window, now()) };
  });
  app.post('/api/ingest/:id', async (req, reply) => {
    if (isDemo) throw new HttpError(403, '示例模式不接收数据');
    const { id } = req.params as { id: string }; const n = store.node(id);
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!n || !token || !equal(digest(token), n.token_hash)) throw new HttpError(401, '采集端认证失败');
    const sample = sampleSchema.parse(req.body); const t = now();
    if (Math.abs(sample.timestamp - t) > 300000) throw new HttpError(400, '采集端时间偏差超过 5 分钟，请校准系统时间');
    if (!metrics.accept(n, sample, t)) return reply.code(429).send({ error: '采样过快、重复或时间倒退', intervalMs: n.interval_ms });
    const platform = typeof req.headers['x-agent-platform'] === 'string' ? req.headers['x-agent-platform'].slice(0, 80) : n.platform;
    const caps = ['cpu', 'memory', 'disk', 'network', ...(sample.gpus.length ? ['gpu'] : [])];
    if ((req.headers['x-agent-capabilities']?.includes('gpu') || n.capabilities.includes('"gpu"')) && !caps.includes('gpu')) caps.push('gpu');
    if (platform !== n.platform || JSON.stringify(caps) !== n.capabilities) store.nodeMeta(id, platform, caps);
    return { ok: true, intervalMs: n.interval_ms };
  });

  return {
    metrics, nodes: () => metrics.view(now()),
    tick: () => { seedDemo(); metrics.tick(now()); },
    close: () => metrics.shutdown(),
  };
}
