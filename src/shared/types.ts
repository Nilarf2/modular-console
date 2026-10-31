export interface GpuSample {
  id: string; name: string; utilizationPct: number | null;
  memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null;
}
export interface Sample {
  timestamp: number; intervalMs: number; cpuPct: number | null;
  memory: { usedBytes: number; totalBytes: number } | null;
  disks: { mount: string; usedBytes: number; totalBytes: number }[];
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null } | null;
  gpus: GpuSample[]; uptimeSec: number | null;
}
export interface NodeView {
  id: string; name: string; platform: string; capabilities: string[];
  lastSeen: number | null; online: boolean; sample: Sample | null; intervalMs: number;
}
export interface WidgetInstance {
  id: string; pluginId: string; type: string; title: string;
  sourceId?: string; variant: 'detailed' | 'compact'; width: 'normal' | 'wide';
}
export interface WidgetDefinition {
  type: string; name: string; description: string; source: 'node' | 'connection' | 'none';
  capability?: string;
}
export interface PluginManifest {
  id: string; apiVersion: 1; name: string; description: string; version: string;
  icon: string; widgets: WidgetDefinition[];
}
export interface Settings {
  title: string; sidebarColor: string; accentColor: string; refreshMs: number;
  retentionDays: number; historyIntervalMs: number; animations: boolean;
  enabledPlugins: string[]; widgets: WidgetInstance[];
}
export interface NewApiData {
  username: string; quota: number | null; usedQuota: number | null;
  requestCount: number | null; todayQuota: number | null;
  todayTokens: number | null; todayRequests: number | null;
  quotaPerUnit: number; currency: string;
}
export interface ConnectionView {
  id: string; name: string; baseUrl: string; userId: number;
  status: 'pending' | 'ok' | 'error' | 'disabled';
  updatedAt: number | null; error: string | null; data: NewApiData | null;
}
export interface HistoryPoint { timestamp: number; sample: Sample | null }
export interface LiveState {
  nodes: NodeView[]; connections: ConnectionView[]; serverTime: number;
}
export interface AppState extends LiveState {
  settings: Settings; plugins: PluginManifest[]; csrfToken: string; demo: boolean;
}
