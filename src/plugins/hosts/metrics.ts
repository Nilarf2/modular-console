import type { GpuSample, HistoryPoint, NodeView, Sample, Settings } from '../../shared/types.js';
import type { NodeRecord } from '../../server/store.js';
import { Store } from '../../server/store.js';

// Average valid measurements only. An unavailable measurement never becomes an idle zero.
interface Mean { sum: number; count: number }
const mean = (): Mean => ({ sum: 0, count: 0 });
const add = (m: Mean, n: number | null | undefined) => { if (n !== null && n !== undefined) { m.sum += n; m.count++; } };
const val = (m: Mean) => m.count ? m.sum / m.count : null;
class Bucket {
  first: number; last: number; latest: Sample;
  cpu = mean(); memory = mean(); rx = mean(); tx = mean();
  gpu = new Map<string, { latest: GpuSample; utilization: Mean; memory: Mean; temperature: Mean }>();
  constructor(sample: Sample, now: number) { this.first = now; this.last = now; this.latest = sample; this.push(sample, now); }
  push(sample: Sample, now: number) {
    this.latest = sample; this.last = now;
    add(this.cpu, sample.cpuPct); add(this.memory, sample.memory?.usedBytes);
    add(this.rx, sample.network?.rxBytesPerSec); add(this.tx, sample.network?.txBytesPerSec);
    for (const g of sample.gpus) {
      let acc = this.gpu.get(g.id);
      if (!acc) { acc = { latest: g, utilization: mean(), memory: mean(), temperature: mean() }; this.gpu.set(g.id, acc); }
      acc.latest = g; add(acc.utilization, g.utilizationPct); add(acc.memory, g.memoryUsedBytes); add(acc.temperature, g.temperatureC);
    }
  }
  finish(): HistoryPoint {
    return { timestamp: this.last, sample: {
      ...this.latest, timestamp: this.last, cpuPct: val(this.cpu),
      memory: this.latest.memory && this.memory.count ? { ...this.latest.memory, usedBytes: val(this.memory)! } : null,
      network: this.rx.count || this.tx.count ? { rxBytesPerSec: val(this.rx), txBytesPerSec: val(this.tx) } : null,
      gpus: this.latest.gpus.map(g => {
        const a = this.gpu.get(g.id)!;
        return { ...g, utilizationPct: val(a.utilization), memoryUsedBytes: val(a.memory), temperatureC: val(a.temperature) };
      }),
    } };
  }
}
interface RuntimeNode { sample: Sample | null; receivedAt: number | null; bucket?: Bucket; wasOnline: boolean; lastAccepted: number }
export class Metrics {
  private runtime = new Map<string, RuntimeNode>();
  constructor(private store: Store, private settings: () => Settings) {}
  private runtimeFor(id: string) {
    let state = this.runtime.get(id);
    if (!state) { state = { sample: null, receivedAt: null, wasOnline: false, lastAccepted: 0 }; this.runtime.set(id, state); }
    return state;
  }
  accept(node: NodeRecord, sample: Sample, now: number): boolean {
    const s = this.runtimeFor(node.id);
    if (now - s.lastAccepted < 100 || (s.sample && sample.timestamp <= s.sample.timestamp)) return false;
    s.lastAccepted = now;
    if (!s.wasOnline && (s.receivedAt !== null || node.last_seen !== null))
      this.store.insertHistory(node.id, { timestamp: now - 1, sample: null }, s.receivedAt ?? node.last_seen);
    s.sample = sample; s.receivedAt = now; s.wasOnline = true;
    if (s.bucket && now - s.bucket.first >= this.settings().historyIntervalMs) this.flush(node.id, s);
    if (!s.bucket) s.bucket = new Bucket(sample, now); else s.bucket.push(sample, now);
    return true;
  }
  private flush(id: string, s: RuntimeNode) {
    if (!s.bucket) return;
    this.store.insertHistory(id, s.bucket.finish(), s.receivedAt); s.bucket = undefined;
  }
  tick(now: number) {
    for (const n of this.store.nodes()) {
      const s = this.runtime.get(n.id); if (!s) continue;
      if (s.bucket && now - s.bucket.first >= this.settings().historyIntervalMs) this.flush(n.id, s);
      if (s.wasOnline && s.receivedAt !== null && now - s.receivedAt > Math.max(5000, n.interval_ms * 3)) {
        this.flush(n.id, s); s.wasOnline = false;
        this.store.insertHistory(n.id, { timestamp: now, sample: null }, s.receivedAt);
      }
    }
  }
  view(now: number): NodeView[] {
    return this.store.nodes().map(n => {
      const s = this.runtime.get(n.id);
      const online = s?.receivedAt !== null && s?.receivedAt !== undefined && now - s.receivedAt <= Math.max(5000, n.interval_ms * 3);
      return { id: n.id, name: n.name, platform: n.platform, capabilities: JSON.parse(n.capabilities) as string[],
        lastSeen: s?.receivedAt ?? n.last_seen, online, sample: online ? s!.sample : null, intervalMs: n.interval_ms };
    });
  }
  history(id: string, since: number, now: number): HistoryPoint[] {
    const resolution = Math.max(1, Math.floor((now - since) / 1000));
    const rows = this.store.history(id, since, resolution); const s = this.runtime.get(id);
    if (s?.bucket && s.bucket.last >= since) rows.push(s.bucket.finish());
    if (s && !s.wasOnline && rows.length && rows[rows.length - 1].sample) rows.push({ timestamp: now, sample: null });
    // Add a discontinuity after a restart or unexpected collection gap, even if no offline event was written.
    const withGaps: HistoryPoint[] = [];
    for (const p of rows) {
      const previous = withGaps.at(-1);
      if (previous?.sample && p.sample && p.timestamp - previous.timestamp > Math.max(this.settings().historyIntervalMs * 3, resolution * 3))
        withGaps.push({ timestamp: previous.timestamp + 1, sample: null });
      withGaps.push(p);
    }
    if (withGaps.length <= 1200) return withGaps;
    // Keep transitions and min/max timestamps per segment; average groups without bridging gaps.
    const result: HistoryPoint[] = []; const step = Math.ceil(withGaps.length / 1100); let batch: HistoryPoint[] = [];
    const flush = () => {
      if (!batch.length) return;
      const b = new Bucket(batch[0].sample!, batch[0].timestamp);
      for (const p of batch.slice(1)) b.push(p.sample!, p.timestamp);
      result.push(b.finish()); batch = [];
    };
    let previous: HistoryPoint | undefined;
    for (const p of withGaps) {
      const gap = previous && p.timestamp - previous.timestamp > Math.max(this.settings().historyIntervalMs * 3, resolution * 3);
      if (!p.sample || gap) { flush(); result.push({ timestamp: gap ? previous!.timestamp + 1 : p.timestamp, sample: null }); }
      if (p.sample) { batch.push(p); if (batch.length >= step) flush(); }
      previous = p;
    }
    flush(); return result;
  }
  forget(id: string) { this.runtime.delete(id); }
  shutdown() { for (const [id, s] of this.runtime) this.flush(id, s); }
}
