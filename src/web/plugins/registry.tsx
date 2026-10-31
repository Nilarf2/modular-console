import type { FrontendPlugin, WidgetRenderProps } from "./types";
import { hostsPlugin } from "./hosts";
import { newapiPlugin } from "./newapi";
const registry = new Map<string, FrontendPlugin>();
export function registerPlugin(plugin: FrontendPlugin) {
  registry.set(plugin.id, plugin);
}
registerPlugin(hostsPlugin);
registerPlugin(newapiPlugin);
export function PluginWidget(props: WidgetRenderProps) {
  const plugin = registry.get(props.widget.pluginId);
  return plugin ? (
    plugin.render(props)
  ) : (
    <p className="widget-empty">插件未安装</p>
  );
}
