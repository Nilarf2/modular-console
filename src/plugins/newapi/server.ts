import { randomUUID } from 'node:crypto';
import type { ConnectionView } from '../../shared/types.js';
import type { ServerPluginContext } from '../../server/plugin.js';
import { HttpError, requireValue } from '../../server/errors.js';
import { connectionSchema } from '../../server/validation.js';
import { fetchNewApi, validateNewApiUrl } from './connector.js';

export function registerNewApi(context: ServerPluginContext) {
  const { app, store, now, getSettings, saveSettings } = context;
  const connectionViews = new Map<string, ConnectionView>();
  const busyConnections = new Set<string>();
  let closed = false;
  const active = new Set<Promise<void>>();
  function connections(): ConnectionView[] {
    return store.connections().map(c => connectionViews.get(c.id) ?? {
      id: c.id, name: c.name, baseUrl: c.baseUrl, userId: c.userId, status: getSettings().enabledPlugins.includes('newapi') ? 'pending' : 'disabled', updatedAt: null, error: null, data: null,
    });
  }
  async function doRefresh(id: string) {
    if (closed) return;
    if (!getSettings().enabledPlugins.includes('newapi')) throw new HttpError(409, '请先启用 NewAPI 模块');
    if (busyConnections.has(id)) return;
    const c = requireValue(store.connections().find(c => c.id === id), '连接不存在');
    busyConnections.add(id);
    const base = { id, name: c.name, baseUrl: c.baseUrl, userId: c.userId };
    try {
      const data = await fetchNewApi(c);
      if (!closed && store.connections().some(c => c.id === id) && getSettings().enabledPlugins.includes('newapi'))
        connectionViews.set(id, { ...base, status: 'ok', data, updatedAt: now(), error: null });
    } catch (err) {
      if (!closed && store.connections().some(c => c.id === id) && getSettings().enabledPlugins.includes('newapi'))
        connectionViews.set(id, { ...base, status: 'error', data: null, updatedAt: now(), error: err instanceof Error ? err.message : '连接失败' });
    } finally { busyConnections.delete(id); }
  }
  function refreshConnection(id: string): Promise<void> {
    const work = doRefresh(id);
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => {});
    return work;
  }
  app.post('/api/plugins/newapi/connections', async req => {
    if (store.connections().length >= 32) throw new HttpError(400, '最多支持 32 个 NewAPI 连接');
    const v = connectionSchema.parse(req.body); let baseUrl: string;
    try { baseUrl = validateNewApiUrl(v.baseUrl); } catch { throw new HttpError(400, '连接地址无效，请使用服务的 HTTP(S) 地址'); }
    const id = randomUUID(); const { name, ...config } = v;
    store.addConnection(id, name, { ...config, baseUrl });
    if (getSettings().enabledPlugins.includes('newapi')) await refreshConnection(id);
    return { connection: connections().find(c => c.id === id) };
  });
  app.post('/api/plugins/newapi/connections/:id/refresh', async req => {
    const { id } = req.params as { id: string }; const current = connectionViews.get(id);
    if (current?.updatedAt && now() - current.updatedAt < 10000) throw new HttpError(429, '请间隔 10 秒后刷新');
    await refreshConnection(id); return { connection: connections().find(c => c.id === id) };
  });
  app.delete('/api/plugins/newapi/connections/:id', async req => {
    const { id } = req.params as { id: string }; requireValue(store.connections().find(c => c.id === id), '连接不存在');
    const settings = { ...getSettings(), widgets: getSettings().widgets.filter(w => !(w.pluginId === 'newapi' && w.sourceId === id)) };
    saveSettings(settings); store.deleteConnection(id); connectionViews.delete(id); return { ok: true };
  });

  async function refreshAll() {
    if (closed || !getSettings().enabledPlugins.includes('newapi')) return;
    await Promise.all(store.connections().map(c => refreshConnection(c.id)));
  }
  return {
    connections, refreshAll, refreshConnection,
    clear: () => connectionViews.clear(),
    close: async () => { closed = true; await Promise.allSettled(active); },
  };
}
