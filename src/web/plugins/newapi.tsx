import { ArrowUpRight, CreditCard, Activity } from "lucide-react";
import type { FrontendPlugin, WidgetRenderProps } from "./types";
function UsageWidget({ widget, live }: WidgetRenderProps) {
  const connection = live.connections.find((c) => c.id === widget.sourceId);
  if (!connection)
    return (
      <p className="widget-empty">未配置连接</p>
    );
  const fresh =
    connection.status === "ok" &&
    connection.updatedAt != null &&
    live.serverTime - connection.updatedAt < 300_000;
  const data = fresh ? connection.data : null;
  const format = (n: number | null | undefined) =>
    n == null ? "—" : n.toLocaleString("zh-CN");
  const money = (n: number | null | undefined) =>
    n == null || !data
      ? "—"
      : `${data.currency} ${(n / data.quotaPerUnit).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <div className="usage-widget">
      <div className="source-line">
        <span className={`status-dot ${fresh ? "online" : ""}`} />
        <span>{connection.name}</span>
        <span className={`status-text ${fresh ? "positive" : ""}`}>
          {fresh
            ? "已同步"
            : connection.status === "pending"
              ? "等待同步"
              : "数据不可用"}
        </span>
      </div>
      <div className="balance">
        <span>
          <CreditCard size={15} /> 剩余额度
        </span>
        <strong>{money(data?.quota)}</strong>
        <small>
          {data?.username
            ? `账户 ${data.username}`
            : connection.error || "等待有效数据"}
        </small>
      </div>
      <div className="usage-detail">
        <div>
          <span>累计消耗</span>
          <strong>{money(data?.usedQuota)}</strong>
        </div>
        <div>
          <span>累计请求</span>
          <strong>
            {format(data?.requestCount)}
            <small> 次</small>
          </strong>
        </div>
      </div>
      {widget.variant === "detailed" && (
        <div className="today-usage">
          <div className="today-label">
            <Activity size={14} /> 今日概览
            <ArrowUpRight size={14} />
          </div>
          <div className="today-grid">
            <div>
              <small>消耗额度</small>
              <strong>{money(data?.todayQuota)}</strong>
            </div>
            <div>
              <small>请求</small>
              <strong>{format(data?.todayRequests)}</strong>
            </div>
            <div>
              <small>Tokens</small>
              <strong>{format(data?.todayTokens)}</strong>
            </div>
          </div>
        </div>
      )}
      <div className="widget-foot">
        <span>
          {connection.updatedAt
            ? `更新于 ${new Date(connection.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
            : "尚未同步"}
        </span>
        <span>New API</span>
      </div>
    </div>
  );
}
export const newapiPlugin: FrontendPlugin = {
  id: "newapi",
  render: (props) => <UsageWidget {...props} />,
};
