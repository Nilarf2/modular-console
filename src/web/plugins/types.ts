import type { ReactNode } from "react";
import type { LiveState, WidgetInstance } from "../../shared/types";
export interface WidgetRenderProps {
  widget: WidgetInstance;
  live: LiveState;
  onHistory: (nodeId: string) => void;
}
export interface FrontendPlugin {
  id: string;
  render: (props: WidgetRenderProps) => ReactNode;
}
export const percent = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n)}%`;
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
export function ratio(
  used: number | undefined,
  total: number | undefined,
): number | null {
  return used == null || total == null || total <= 0
    ? null
    : (used / total) * 100;
}
