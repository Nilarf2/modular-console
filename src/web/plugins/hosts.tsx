import {
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  History,
  MemoryStick,
  Wifi,
  Zap,
} from "lucide-react";
import type { Sample } from "../../shared/types";
import type { FrontendPlugin, WidgetRenderProps } from "./types";
import { bytes, percent, ratio } from "./types";

function average(values: (number | null)[]) {
  const known = values.filter((value): value is number => value !== null);
  return known.length
    ? known.reduce((sum, value) => sum + value, 0) / known.length
    : null;
}
function Bar({ value, tone = "" }: { value: number | null; tone?: string }) {
  return (
    <div className={`meter ${tone}`} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
    </div>
  );
}
function HostMetrics({
  sample,
  compact,
}: {
  sample: Sample | null;
  compact: boolean;
}) {
  const memory = sample?.memory;
  const memoryPct = ratio(memory?.usedBytes, memory?.totalBytes);
  const disks = sample?.disks ?? [];
  const disk = disks.find((d) => d.mount === "/") ?? disks[0];
  const diskPct = ratio(disk?.usedBytes, disk?.totalBytes);
  return (
    <>
      <div className={`host-metrics ${compact ? "compact-metrics" : ""}`}>
        <div className="host-metric">
          <div className="metric-label">
            <Cpu size={14} /> CPU
          </div>
          <div className="metric-value">{percent(sample?.cpuPct)}</div>
          <Bar value={sample?.cpuPct ?? null} />
        </div>
        <div className="host-metric">
          <div className="metric-label">
            <MemoryStick size={14} /> 内存
          </div>
          <div className="metric-value">{percent(memoryPct)}</div>
          <Bar value={memoryPct} tone="lavender" />
          {!compact && (
            <small>
              {bytes(memory?.usedBytes)}{" "}
              <span>/ {bytes(memory?.totalBytes)}</span>
            </small>
          )}
        </div>
        <div className="host-metric">
          <div className="metric-label">
            <HardDrive size={14} /> 磁盘
          </div>
          <div className="metric-value">{percent(diskPct)}</div>
          <Bar value={diskPct} tone="sage" />
          {!compact && (
            <small>
              {bytes(disk?.usedBytes)} <span>/ {bytes(disk?.totalBytes)}</span>
            </small>
          )}
        </div>
      </div>
      <div className="network-line">
        <span>
          <Wifi size={14} /> 网络{!compact && "吞吐"}
        </span>
        <div>
          <span>
            <ArrowDown size={12} /> {bytes(sample?.network?.rxBytesPerSec)}
            <small>/s</small>
          </span>
          <span>
            <ArrowUp size={12} /> {bytes(sample?.network?.txBytesPerSec)}
            <small>/s</small>
          </span>
        </div>
      </div>
    </>
  );
}
function HostWidget({ widget, live, onHistory }: WidgetRenderProps) {
  if (widget.type === "fleet") {
    const nodes = live.nodes;
    return (
      <div className="fleet-widget">
        <div className="fleet-summary">
          <div>
            <strong>
              {nodes.filter((n) => n.online).length}
              <span> / {nodes.length}</span>
            </strong>
            <small>节点在线</small>
          </div>
          <div className="fleet-icon">
            <Cpu size={24} />
          </div>
        </div>
        <div className="fleet-rows">
          {nodes.length === 0 ? (
            <p className="widget-empty">暂无节点</p>
          ) : (
            nodes.map((node) => (
              <button
                className="fleet-row"
                key={node.id}
                onClick={() => onHistory(node.id)}
                aria-label={`查看 ${node.name} 历史`}
              >
                <span className={`status-dot ${node.online ? "online" : ""}`} />
                <span className="fleet-name">
                  {node.name}
                  <small>
                    {node.platform || "等待连接"}
                    {widget.variant === "detailed" &&
                    node.capabilities.includes("gpu")
                      ? " · GPU"
                      : ""}
                  </small>
                </span>
                <span className="fleet-metric">
                  <small>CPU</small>
                  {percent(node.online ? node.sample?.cpuPct : null)}
                </span>
                <span className="fleet-metric">
                  <small>内存</small>
                  {percent(
                    node.online
                      ? ratio(
                          node.sample?.memory?.usedBytes,
                          node.sample?.memory?.totalBytes,
                        )
                      : null,
                  )}
                </span>
                {widget.variant === "detailed" && (
                  <span className="fleet-metric fleet-gpu">
                    <small>GPU</small>
                    {node.capabilities.includes("gpu")
                      ? percent(
                          node.online && node.sample?.gpus.length
                            ? average(
                                node.sample.gpus.map(
                                  (gpu) => gpu.utilizationPct,
                                ),
                              )
                            : null,
                        )
                      : "—"}
                  </span>
                )}
                <span
                  className={`status-text ${node.online ? "positive" : ""}`}
                >
                  {node.online ? "在线" : "离线"}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }
  const node = live.nodes.find((n) => n.id === widget.sourceId);
  if (!node)
    return (
      <p className="widget-empty">未配置节点</p>
    );
  const sample = node.online ? node.sample : null;
  const compact = widget.variant === "compact";
  return (
    <>
      <div className="source-line">
        <span className={`status-dot ${node.online ? "online" : ""}`} />
        <span>{node.name}</span>
        <span className="source-platform">{node.platform || "等待接入"}</span>
        <span className={`status-text ${node.online ? "positive" : ""}`}>
          {node.online ? "在线" : "离线"}
        </span>
      </div>
      <HostMetrics sample={sample} compact={compact} />
      {widget.type === "node-gpu" && (
        <div className="gpu-list">
          {sample?.gpus.length ? (
            sample.gpus.map((gpu) => (
              <div className="gpu-row" key={gpu.id}>
                <span className="gpu-symbol">
                  <Zap size={16} />
                </span>
                <div className="gpu-info">
                  <strong>{gpu.name}</strong>
                  <small>
                    {bytes(gpu.memoryUsedBytes)} / {bytes(gpu.memoryTotalBytes)}
                    {!compact &&
                      ` · ${gpu.temperatureC == null ? "—" : `${gpu.temperatureC}°C`}`}
                  </small>
                </div>
                <b>{percent(gpu.utilizationPct)}</b>
              </div>
            ))
          ) : (
            <div className="muted gpu-placeholder">
              <Zap size={15} />{" "}
              {node.online ? "等待 GPU 采样" : "GPU 数据不可用"}
            </div>
          )}
        </div>
      )}
      <div className="widget-foot">
        <span>
          采样 {node.intervalMs / 1000}s
          {sample &&
            ` · ${new Date(sample.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}`}
        </span>
        <button className="text-button" onClick={() => onHistory(node.id)}>
          <History size={13} /> 历史趋势
        </button>
      </div>
    </>
  );
}
export const hostsPlugin: FrontendPlugin = {
  id: "hosts",
  render: (props) => <HostWidget {...props} />,
};
