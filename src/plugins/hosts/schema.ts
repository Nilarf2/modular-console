import { z } from 'zod';
const bytes = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const percent = z.number().finite().min(0).max(100).nullable();
const memory = z.object({ usedBytes: bytes, totalBytes: bytes.positive() }).strict()
  .refine(v => v.usedBytes <= v.totalBytes, '已用容量不能超过总容量');
export const sampleSchema = z.object({
  timestamp: z.number().int().positive(), intervalMs: z.number().int().min(1).max(604800000),
  cpuPct: percent, memory: memory.nullable(),
  disks: z.array(memory.safeExtend({ mount: z.string().min(1).max(256) })).max(64),
  network: z.object({ rxBytesPerSec: bytes.nullable(), txBytesPerSec: bytes.nullable() }).strict().nullable(),
  gpus: z.array(z.object({
    id: z.string().min(1).max(128), name: z.string().min(1).max(160), utilizationPct: percent,
    memoryUsedBytes: bytes.nullable(), memoryTotalBytes: bytes.positive().nullable(),
    temperatureC: z.number().finite().min(-50).max(200).nullable(),
  }).strict()).max(32),
  uptimeSec: bytes.nullable(),
}).strict();
