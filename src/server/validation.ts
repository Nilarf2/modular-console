import { z } from 'zod';
import { pluginCatalog } from '../shared/catalog.js';

export const intervalSchema = z.number().int().min(200).max(60000);
export const widgetSchema = z.object({
  id: z.string().min(1).max(80), pluginId: z.string().min(1).max(80),
  type: z.string().min(1).max(80), title: z.string().min(1).max(80),
  sourceId: z.string().max(80).optional(), variant: z.enum(['detailed', 'compact']),
  width: z.enum(['normal', 'wide']),
}).strict();
export const settingsSchema = z.object({
  title: z.string().trim().min(1).max(80), sidebarColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i), refreshMs: intervalSchema,
  retentionDays: z.number().int().min(1).max(3650),
  historyIntervalMs: z.number().int().min(1000).max(3600000), animations: z.boolean(),
  enabledPlugins: z.array(z.string()).max(32), widgets: z.array(widgetSchema).max(80),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.widgets.map(w => w.id)).size !== v.widgets.length || new Set(v.enabledPlugins).size !== v.enabledPlugins.length)
    ctx.addIssue({ code: 'custom', message: '模块或组件标识重复' });
  for (const id of v.enabledPlugins) if (!pluginCatalog.some(p => p.id === id))
    ctx.addIssue({ code: 'custom', message: '未知模块' });
  for (const w of v.widgets) if (!pluginCatalog.some(p => p.id === w.pluginId && p.widgets.some(d => d.type === w.type)))
    ctx.addIssue({ code: 'custom', message: '未知组件类型' });
});
export const nameSchema = z.string().trim().min(1).max(80);
export const connectionSchema = z.object({
  name: nameSchema, baseUrl: z.string().max(1024), userId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  token: z.string().trim().min(8).max(4096), quotaPerUnit: z.number().finite().positive().max(1e12).default(500000),
  currency: z.string().trim().min(1).max(12).default('USD'),
}).strict();
