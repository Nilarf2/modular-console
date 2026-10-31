import type { PluginManifest, Settings } from './types.js';

// Public, versioned metadata. Core persists instances without owning their renderer.
export const pluginCatalog: PluginManifest[] = [
  {
    id: 'hosts', apiVersion: 1, version: '0.1.0', name: '主机监控', icon: 'server',
    description: '独立节点、GPU 工作站与多节点状态，按需组合。',
    widgets: [
      { type: 'node-basic', name: '基础节点', description: 'CPU、内存、磁盘与网络，不含 GPU。', source: 'node' },
      { type: 'node-gpu', name: 'GPU 节点', description: '基础性能与每块 GPU 的负载、显存和温度。', source: 'node', capability: 'gpu' },
      { type: 'fleet', name: '节点汇总', description: '集中查看多个节点的在线状态和资源负载。', source: 'none' },
    ],
  },
  {
    id: 'newapi', apiVersion: 1, version: '0.1.0', name: 'NewAPI', icon: 'activity',
    description: '只读连接自托管 NewAPI，查看额度与用量。',
    widgets: [{ type: 'usage', name: '额度与用量', description: '账户余额、累计消耗和今日统计。', source: 'connection' }],
  },
];

export function defaultSettings(): Settings {
  return {
    title: '我的控制台', sidebarColor: '#eef0fa', accentColor: '#6568d9', refreshMs: 1000,
    retentionDays: 30, historyIntervalMs: 5000, animations: true,
    enabledPlugins: ['hosts', 'newapi'], widgets: [],
  };
}
