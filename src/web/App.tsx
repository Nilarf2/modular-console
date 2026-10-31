import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Blocks,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  GripVertical,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  AppState,
  HistoryPoint,
  LiveState,
  NodeView,
  Settings,
  WidgetInstance,
} from "../shared/types";
import { ApiError, messageOf, request } from "./api";
import { Dialog, Empty, ErrorMessage } from "./components";
import { PluginWidget } from "./plugins/registry";

type Page = "overview" | "widgets" | "nodes" | "connections" | "settings";
type TokenResult = {
  node?: NodeView;
  token: string;
  config: {
    consoleUrl: string;
    nodeId: string;
    token: string;
    intervalMs: number;
  };
};
const navigation = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "widgets", label: "组件", icon: Blocks },
  { id: "nodes", label: "节点", icon: Server },
  { id: "connections", label: "连接", icon: Link2 },
  { id: "settings", label: "设置", icon: Settings2 },
] as const;
const navTitles = {
  overview: "控制台",
  widgets: "组件管理",
  nodes: "节点",
  connections: "连接",
  settings: "设置",
};

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [editLayout, setEditLayout] = useState(false);
  const [widgetEditor, setWidgetEditor] = useState<
    WidgetInstance | "new" | null
  >(null);
  const [nodeForm, setNodeForm] = useState<NodeView | "new" | null>(null);
  const [connectionForm, setConnectionForm] = useState(false);
  const [tokenResult, setTokenResult] = useState<TokenResult | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    text: string;
    action: () => Promise<void>;
  } | null>(null);
  const [historyNode, setHistoryNode] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const csrfRef = useRef("");
  const pendingRef = useRef(false);
  const unauthorized = useCallback(() => {
    setAuthenticated(false);
    setState(null);
    csrfRef.current = "";
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await request<AppState>("/state");
      csrfRef.current = next.csrfToken;
      setState(next);
      setAuthenticated(true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) unauthorized();
      else throw cause;
    }
  }, [unauthorized]);
  const initialize = useCallback(async () => {
    setError(null);
    try {
      const auth = await request<{ authenticated: boolean; demo: boolean }>(
        "/auth",
      );
      setAuthenticated(auth.authenticated);
      if (auth.authenticated) await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [refresh]);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  const perform = useCallback(
    async (action: () => Promise<void>) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) unauthorized();
        else {
          setError(messageOf(cause));
          if (cause instanceof ApiError && cause.status === 409) {
            try {
              await refresh();
            } catch (refreshError) {
              setError(`${messageOf(cause)}；${messageOf(refreshError)}`);
            }
          }
        }
      } finally {
        pendingRef.current = false;
        setBusy(false);
      }
    },
    [refresh, unauthorized],
  );
  const mutate = useCallback(
    async <T,>(path: string, method: string, body: unknown = {}): Promise<T> =>
      request<T>(path, { method, body, csrf: csrfRef.current }),
    [],
  );
  const saveSettings = useCallback(
    async (settings: Settings) => {
      const result = await mutate<{ settings: Settings }>(
        "/settings",
        "PATCH",
        settings,
      );
      setState((previous) =>
        previous ? { ...previous, settings: result.settings } : previous,
      );
    },
    [mutate],
  );
  useEffect(() => {
    if (!authenticated || !state) return;
    let stream: EventSource | null = null;
    let disposed = false;
    const markStale = () =>
      setState((previous) =>
        previous
          ? {
              ...previous,
              nodes: previous.nodes.map((node) => ({
                ...node,
                online: false,
                sample: null,
              })),
              connections: previous.connections.map((connection) => ({
                ...connection,
                status: connection.status === "disabled" ? "disabled" : "error",
                data: null,
                error:
                  connection.status === "disabled"
                    ? connection.error
                    : "实时连接中断，等待重新同步",
              })),
            }
          : previous,
      );
    const start = () => {
      stream?.close();
      setStreaming(false);
      if (document.hidden || disposed) return;
      stream = new EventSource(
        `/api/stream?intervalMs=${state.settings.refreshMs}`,
      );
      stream.addEventListener("live", (event) => {
        try {
          const live = JSON.parse((event as MessageEvent).data) as LiveState;
          setState((previous) =>
            previous ? { ...previous, ...live } : previous,
          );
          setStreaming(true);
        } catch {
          setError("实时数据格式异常，请刷新页面。");
        }
      });
      stream.addEventListener("expired", () => {
        stream?.close();
        unauthorized();
      });
      stream.onerror = () => {
        setStreaming(false);
        markStale();
        void request<{ authenticated: boolean }>("/auth")
          .then((auth) => {
            if (!auth.authenticated) unauthorized();
          })
          .catch((cause) => setError(messageOf(cause)));
      };
    };
    const visibility = () => {
      if (document.hidden) {
        stream?.close();
        stream = null;
        setStreaming(false);
        markStale();
      } else {
        void refresh()
          .then(start)
          .catch((cause) => setError(messageOf(cause)));
      }
    };
    start();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      stream?.close();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [authenticated, state?.settings.refreshMs, refresh, unauthorized]);
  useEffect(() => {
    if (state) document.title = `${navTitles[page]} · ${state.settings.title}`;
  }, [page, state?.settings.title]);
  const reorder = (id: string, targetId: string) => {
    if (!state || id === targetId) return;
    const widgets = [...state.settings.widgets];
    const from = widgets.findIndex((w) => w.id === id);
    const to = widgets.findIndex((w) => w.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = widgets.splice(from, 1);
    widgets.splice(to, 0, item);
    void perform(() => saveSettings({ ...state.settings, widgets }));
  };
  if (authenticated === false)
    return (
      <Login
        error={error}
        busy={busy}
        onSubmit={(password) =>
          perform(async () => {
            await request("/auth/login", {
              method: "POST",
              body: { password },
            });
            await refresh();
          })
        }
      />
    );
  if (!state)
    return (
      <main className="loading-screen">
        <div className="brand-mark">
          <Box size={25} />
        </div>
        <p>{error ? "暂时无法连接控制台" : "正在连接控制台"}</p>
        <ErrorMessage error={error} />
        {error ? (
          <button className="button primary" onClick={() => void initialize()}>
            重新连接
          </button>
        ) : (
          <LoaderCircle className="spin" size={20} />
        )}
      </main>
    );
  const enabledWidgets = state.settings.widgets.filter((w) =>
    state.settings.enabledPlugins.includes(w.pluginId),
  );
  return (
    <div
      className={`app ${state.settings.animations ? "" : "no-animations"}`}
      style={
        {
          "--sidebar": state.settings.sidebarColor,
          "--accent": state.settings.accentColor,
        } as CSSProperties
      }
    >
      {mobileMenu && (
        <div className="mobile-scrim" onClick={() => setMobileMenu(false)} />
      )}
      <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
        <a
          className="brand"
          href="#overview"
          onClick={(event) => {
            event.preventDefault();
            setPage("overview");
            setMobileMenu(false);
          }}
        >
          <div className="brand-mark">
            <Box size={23} strokeWidth={1.7} />
          </div>
          <span>{state.settings.title || "个人控制台"}</span>
        </a>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-label={item.label}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => {
                setPage(item.id);
                setMobileMenu(false);
              }}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "nodes" && state.nodes.length > 0 && (
                <small>{state.nodes.length}</small>
              )}
              {page === item.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {!streaming && <div className="system-status">
            <span className="status-dot" />
            <span>正在重新连接</span>
          </div>}
          {!state.demo && <button
            className="profile"
            onClick={() =>
              void perform(async () => {
                await mutate("/auth/logout", "POST");
                unauthorized();
              })
            }
            disabled={busy}
          >
            <span>
              <strong>退出登录</strong>
            </span>
            <LogOut size={16} />
          </button>}
        </div>
      </aside>
      <div className="main-shell">
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="heading-title">
                <button
                  className="icon-button mobile-menu-button"
                  aria-label="打开导航"
                  onClick={() => setMobileMenu(true)}
                >
                  <Menu size={20} />
                </button>
                <h1>{navTitles[page]}</h1>
                {page === "overview" && (
                  <span
                    className={`live-badge ${streaming ? "" : "disconnected"}`}
                  >
                    <span className="status-dot online" />
                    {streaming ? "实时" : "重连中"}
                  </span>
                )}
                {state.demo && <span className="demo-badge">示例模式</span>}
              </div>
            </div>
            <div className="heading-actions">
              {page === "overview" && (
                <>
                  <button
                    className={`button secondary ${editLayout ? "selected" : ""}`}
                    onClick={() => setEditLayout(!editLayout)}
                  >
                    <Settings2 size={15} />
                    {editLayout ? "完成布局" : "编辑布局"}
                  </button>
                  <button
                    className="button primary"
                    onClick={() => setWidgetEditor("new")}
                  >
                    <Plus size={16} />
                    添加组件
                  </button>
                </>
              )}
              {page === "widgets" && (
                <button
                  className="button primary"
                  onClick={() => setWidgetEditor("new")}
                >
                  <Plus size={16} />
                  添加组件
                </button>
              )}
              {page === "nodes" && (
                <button
                  className="button primary"
                  onClick={() => setNodeForm("new")}
                >
                  <Plus size={16} />
                  注册节点
                </button>
              )}
              {page === "connections" && (
                <button
                  className="button primary"
                  onClick={() => setConnectionForm(true)}
                  disabled={!state.settings.enabledPlugins.includes("newapi")}
                >
                  <Plus size={16} />
                  添加连接
                </button>
              )}
            </div>
          </div>
          <ErrorMessage error={error} />
          {page === "overview" && (
            <>
              {enabledWidgets.length === 0 ? (
                <Empty
                  icon={<Blocks size={28} />}
                  title="暂无组件"
                  description=""
                >
                  <button
                    className="button primary"
                    onClick={() => setWidgetEditor("new")}
                  >
                    <Plus size={15} />
                    添加组件
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setPage("nodes");
                      setNodeForm("new");
                    }}
                  >
                    注册节点
                    <ArrowRight size={14} />
                  </button>
                </Empty>
              ) : (
                <div className={`widget-grid ${editLayout ? "editing" : ""}`}>
                  {enabledWidgets.map((widget, index) => (
                    <section
                      className={`widget-card ${widget.width === "wide" ? "wide" : ""} ${dragOver === widget.id ? "drag-over" : ""}`}
                      key={widget.id}
                      draggable={editLayout && !busy}
                      onDragStart={(event) => {
                        setDragId(widget.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", widget.id);
                      }}
                      onDragOver={(event) => {
                        if (editLayout) {
                          event.preventDefault();
                          setDragOver(widget.id);
                        }
                      }}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={(event) => {
                        event.preventDefault();
                        reorder(
                          dragId || event.dataTransfer.getData("text/plain"),
                          widget.id,
                        );
                        setDragId(null);
                        setDragOver(null);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDragOver(null);
                      }}
                    >
                      <div className="widget-card-header">
                        <div>
                          {editLayout && (
                            <GripVertical size={16} className="muted" />
                          )}
                          <span
                            className={`widget-header-icon ${widget.pluginId === "newapi" ? "api-icon" : ""}`}
                          >
                            {widget.pluginId === "newapi" ? (
                              <Link2 size={16} />
                            ) : widget.type === "fleet" ? (
                              <Server size={16} />
                            ) : (
                              <Activity size={16} />
                            )}
                          </span>
                          <h3>{widget.title}</h3>
                        </div>
                        <div className="widget-tools">
                          {editLayout && (
                            <>
                              <button
                                className="icon-button"
                                aria-label={`上移 ${widget.title}`}
                                disabled={busy || index === 0}
                                onClick={() =>
                                  reorder(
                                    widget.id,
                                    enabledWidgets[index - 1].id,
                                  )
                                }
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`下移 ${widget.title}`}
                                disabled={
                                  busy || index === enabledWidgets.length - 1
                                }
                                onClick={() =>
                                  reorder(
                                    widget.id,
                                    enabledWidgets[index + 1].id,
                                  )
                                }
                              >
                                <ArrowDown size={14} />
                              </button>
                              <button
                                className="icon-button danger-hover"
                                aria-label={`删除 ${widget.title}`}
                                onClick={() =>
                                  void perform(() =>
                                    saveSettings({
                                      ...state.settings,
                                      widgets: state.settings.widgets.filter(
                                        (w) => w.id !== widget.id,
                                      ),
                                    }),
                                  )
                                }
                                disabled={busy}
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                          <button
                            className="icon-button"
                            aria-label={`编辑 ${widget.title}`}
                            onClick={() => setWidgetEditor(widget)}
                          >
                            <MoreHorizontal size={19} />
                          </button>
                        </div>
                      </div>
                      <PluginWidget
                        widget={widget}
                        live={state}
                        onHistory={setHistoryNode}
                      />
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
          {page === "widgets" && (
            <>
              <div className="panel">
                <div className="panel-heading">
                  <h2>组件</h2>
                  <span>{state.settings.widgets.length} 个</span>
                </div>
                {state.settings.widgets.length ? (
                  state.settings.widgets.map((widget, index) => (
                    <div className="management-row" key={widget.id}>
                      <span className="row-icon">
                        <Blocks size={19} />
                      </span>
                      <div className="row-content">
                        <strong>{widget.title}</strong>
                        <span>
                          {state.plugins.find((p) => p.id === widget.pluginId)
                            ?.name ?? widget.pluginId}{" "}
                          · {widget.variant === "compact" ? "紧凑" : "详细"} ·{" "}
                          {widget.width === "wide" ? "宽幅" : "标准"}
                          {!state.settings.enabledPlugins.includes(
                            widget.pluginId,
                          ) && " · 插件已停用"}
                        </span>
                      </div>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`上移 ${widget.title}`}
                          disabled={busy || index === 0}
                          onClick={() =>
                            reorder(
                              widget.id,
                              state.settings.widgets[index - 1].id,
                            )
                          }
                        >
                          <ArrowUp size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`下移 ${widget.title}`}
                          disabled={
                            busy || index === state.settings.widgets.length - 1
                          }
                          onClick={() =>
                            reorder(
                              widget.id,
                              state.settings.widgets[index + 1].id,
                            )
                          }
                        >
                          <ArrowDown size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`编辑 ${widget.title}`}
                          onClick={() => setWidgetEditor(widget)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button danger-hover"
                          disabled={busy}
                          aria-label={`移除 ${widget.title}`}
                          onClick={() =>
                            void perform(() =>
                              saveSettings({
                                ...state.settings,
                                widgets: state.settings.widgets.filter(
                                  (w) => w.id !== widget.id,
                                ),
                              }),
                            )
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon={<Blocks size={25} />}
                    title="还没有组件"
                    description=""
                  />
                )}
              </div>
              <PluginSettings
                state={state}
                busy={busy}
                onToggle={(id) =>
                  void perform(() =>
                    saveSettings({
                      ...state.settings,
                      enabledPlugins: state.settings.enabledPlugins.includes(id)
                        ? state.settings.enabledPlugins.filter((p) => p !== id)
                        : [...state.settings.enabledPlugins, id],
                    }),
                  )
                }
              />
            </>
          )}
          {page === "nodes" && (
            <>
              <div className="panel">
                {state.nodes.length ? (
                  state.nodes.map((node) => (
                    <div className="management-row node-row" key={node.id}>
                      <span className="row-icon">
                        <Server size={21} />
                      </span>
                      <div className="row-content">
                        <strong>
                          {node.name}
                          <span
                            className={`status-pill ${node.online ? "positive" : ""}`}
                          >
                            <span
                              className={`status-dot ${node.online ? "online" : ""}`}
                            />
                            {node.online ? "在线" : "离线"}
                          </span>
                        </strong>
                        <span>
                          {node.platform || "等待首次连接"} · 采样{" "}
                          {node.intervalMs / 1000}s
                          {node.capabilities.includes("gpu") && " · GPU"}
                          <span className="node-lastseen">
                            {" "}
                            ·{" "}
                            {node.lastSeen
                              ? `最近 ${new Date(node.lastSeen).toLocaleString("zh-CN")}`
                              : "尚未上报"}
                          </span>
                        </span>
                      </div>
                      <div className="row-actions">
                        <button
                          className="button secondary small"
                          onClick={() => setHistoryNode(node.id)}
                        >
                          历史
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`编辑 ${node.name}`}
                          onClick={() => setNodeForm(node)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`轮换 ${node.name} 的令牌`}
                          onClick={() =>
                            setConfirm({
                              title: "轮换节点令牌？",
                              text: `“${node.name}” 的旧令牌将立即失效。请使用新令牌更新节点配置。`,
                              action: async () => {
                                const result = await mutate<TokenResult>(
                                  `/nodes/${node.id}/rotate`,
                                  "POST",
                                );
                                setConfirm(null);
                                setTokenResult(result);
                                await refresh();
                              },
                            })
                          }
                        >
                          <RefreshCw size={15} />
                        </button>
                        <button
                          className="icon-button danger-hover"
                          aria-label={`删除 ${node.name}`}
                          onClick={() =>
                            setConfirm({
                              title: "删除这个节点？",
                              text: `“${node.name}” 将被移除，令牌失效。此操作无法撤销。`,
                              action: async () => {
                                await mutate(`/nodes/${node.id}`, "DELETE");
                                setConfirm(null);
                                await refresh();
                              },
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon={<Server size={28} />}
                    title="暂无节点"
                    description=""
                  >
                    <button
                      className="button primary"
                      onClick={() => setNodeForm("new")}
                    >
                      <Plus size={16} />
                      注册节点
                    </button>
                  </Empty>
                )}
              </div>
            </>
          )}
          {page === "connections" && (
            <>
              {!state.settings.enabledPlugins.includes("newapi") && (
                <div className="panel inline-empty">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        saveSettings({
                          ...state.settings,
                          enabledPlugins: [
                            ...state.settings.enabledPlugins,
                            "newapi",
                          ],
                        }),
                      )
                    }
                  >
                    启用 New API
                  </button>
                </div>
              )}
              <div className="panel">
                {state.connections.length ? (
                  state.connections.map((connection) => (
                    <div className="management-row" key={connection.id}>
                      <span className="row-icon api-icon">
                        <Link2 size={20} />
                      </span>
                      <div className="row-content">
                        <strong>
                          {connection.name}
                          <span
                            className={`status-pill ${connection.status === "ok" ? "positive" : ""}`}
                          >
                            {connection.status === "ok"
                              ? "已连接"
                              : connection.status === "pending"
                                ? "等待同步"
                                : connection.status === "disabled"
                                  ? "已停用"
                                  : "连接异常"}
                          </span>
                        </strong>
                        <span>{connection.baseUrl}</span>
                        {connection.error && (
                          <span className="inline-error">
                            {connection.error}
                          </span>
                        )}
                      </div>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`刷新 ${connection.name}`}
                          disabled={
                            busy ||
                            !state.settings.enabledPlugins.includes("newapi")
                          }
                          onClick={() =>
                            void perform(async () => {
                              await mutate(
                                `/plugins/newapi/connections/${connection.id}/refresh`,
                                "POST",
                              );
                              await refresh();
                            })
                          }
                        >
                          <RefreshCw size={16} />
                        </button>
                        <button
                          className="icon-button danger-hover"
                          aria-label={`删除 ${connection.name}`}
                          onClick={() =>
                            setConfirm({
                              title: "删除这个连接？",
                              text: `“${connection.name}” 的凭据将被删除，关联组件将需要重新选择数据源。`,
                              action: async () => {
                                await mutate(
                                  `/plugins/newapi/connections/${connection.id}`,
                                  "DELETE",
                                );
                                setConfirm(null);
                                await refresh();
                              },
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon={<Link2 size={28} />}
                    title="暂无连接"
                    description=""
                  >
                    <button
                      className="button primary"
                      disabled={
                        !state.settings.enabledPlugins.includes("newapi")
                      }
                      onClick={() => setConnectionForm(true)}
                    >
                      <Plus size={15} />
                      添加连接
                    </button>
                  </Empty>
                )}
              </div>
            </>
          )}
          {page === "settings" && (
            <SettingsPage
              settings={state.settings}
              busy={busy}
              onSave={(settings) => perform(() => saveSettings(settings))}
              error={error}
              onPasswordChange={(currentPassword, password) =>
                perform(async () => {
                  await mutate("/auth/password", "POST", {
                    currentPassword,
                    password,
                  });
                  unauthorized();
                })
              }
            />
          )}
        </main>
      </div>
      {widgetEditor && (
        <WidgetEditor
          state={state}
          widget={widgetEditor === "new" ? null : widgetEditor}
          busy={busy}
          error={error}
          onClose={() => setWidgetEditor(null)}
          onSave={(widget) =>
            perform(async () => {
              await saveSettings({
                ...state.settings,
                widgets:
                  widgetEditor === "new"
                    ? [...state.settings.widgets, widget]
                    : state.settings.widgets.map((w) =>
                        w.id === widget.id ? widget : w,
                      ),
              });
              setWidgetEditor(null);
            })
          }
        />
      )}
      {nodeForm && (
        <NodeForm
          node={nodeForm === "new" ? null : nodeForm}
          busy={busy}
          error={error}
          onClose={() => setNodeForm(null)}
          onSave={(name, intervalMs) =>
            perform(async () => {
              if (nodeForm === "new") {
                const result = await mutate<TokenResult>("/nodes", "POST", {
                  name,
                });
                setTokenResult(result);
              } else
                await mutate(`/nodes/${nodeForm.id}`, "PATCH", {
                  name,
                  intervalMs,
                });
              setNodeForm(null);
              await refresh();
            })
          }
        />
      )}
      {connectionForm && (
        <ConnectionForm
          busy={busy}
          error={error}
          onClose={() => setConnectionForm(false)}
          onSave={(body) =>
            perform(async () => {
              await mutate("/plugins/newapi/connections", "POST", body);
              setConnectionForm(false);
              await refresh();
            })
          }
        />
      )}
      {tokenResult && (
        <TokenDialog
          result={tokenResult}
          onClose={() => setTokenResult(null)}
        />
      )}
      {confirm && (
        <Dialog title={confirm.title} onClose={() => setConfirm(null)}>
          <p className="dialog-description">{confirm.text}</p>
          <ErrorMessage error={error} />
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void perform(confirm.action)}
            >
              {busy ? "处理中…" : "确认操作"}
            </button>
          </div>
        </Dialog>
      )}
      {historyNode && (
        <HistoryDialog
          node={state.nodes.find((n) => n.id === historyNode)}
          nodeId={historyNode}
          onClose={() => setHistoryNode(null)}
          onUnauthorized={unauthorized}
        />
      )}
    </div>
  );
}

function Login({
  error,
  busy,
  onSubmit,
}: {
  error: string | null;
  busy: boolean;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  return (
    <main className="login-screen">
      <div className="login-card">
        <div className="brand-mark">
          <Box size={25} />
        </div>
        <h1>登录</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(password);
          }}
        >
          <label className="field">
            访问密码
            <div className="password-input">
              <LockKeyhole size={17} />
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="输入控制台密码"
              />
            </div>
          </label>
          <ErrorMessage error={error} />
          <button
            className="button primary login-submit"
            disabled={busy || !password}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {busy ? "正在登录…" : "进入控制台"}
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </main>
  );
}
function PluginSettings({
  state,
  busy,
  onToggle,
}: {
  state: AppState;
  busy: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="panel plugin-panel">
      <div className="panel-heading">
        <h2>插件</h2>
      </div>
      {state.plugins.map((plugin) => (
        <div className="management-row" key={plugin.id}>
          <span
            className={`row-icon ${plugin.id === "newapi" ? "api-icon" : ""}`}
          >
            {plugin.id === "newapi" ? (
              <Link2 size={19} />
            ) : (
              <Server size={19} />
            )}
          </span>
          <div className="row-content">
            <strong>
              {plugin.name}
              <small className="version">v{plugin.version}</small>
            </strong>
          </div>
          <button
            className={`switch ${state.settings.enabledPlugins.includes(plugin.id) ? "on" : ""}`}
            role="switch"
            aria-checked={state.settings.enabledPlugins.includes(plugin.id)}
            aria-label={`启用 ${plugin.name}`}
            disabled={busy}
            onClick={() => onToggle(plugin.id)}
          >
            <span />
          </button>
        </div>
      ))}
    </div>
  );
}
function WidgetEditor({
  state,
  widget,
  busy,
  error,
  onClose,
  onSave,
}: {
  state: AppState;
  widget: WidgetInstance | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (widget: WidgetInstance) => Promise<void>;
}) {
  const plugins = state.plugins.filter((p) =>
    state.settings.enabledPlugins.includes(p.id),
  );
  const [pluginId, setPluginId] = useState(
    widget?.pluginId ?? plugins[0]?.id ?? "",
  );
  const plugin = plugins.find((p) => p.id === pluginId);
  const [type, setType] = useState(
    widget?.type ?? plugin?.widgets[0]?.type ?? "",
  );
  const [sourceId, setSourceId] = useState(widget?.sourceId ?? "");
  const [variant, setVariant] = useState<"compact" | "detailed">(
    widget?.variant ?? "detailed",
  );
  const [width, setWidth] = useState<"normal" | "wide">(
    widget?.width ?? "normal",
  );
  const [title, setTitle] = useState(widget?.title ?? "");
  const definition = plugin?.widgets.find((w) => w.type === type);
  const sources =
    definition?.source === "node"
      ? state.nodes
          .filter(
            (n) =>
              !definition.capability ||
              n.capabilities.includes(definition.capability),
          )
          .map((n) => ({ id: n.id, name: n.name }))
      : definition?.source === "connection"
        ? state.connections.map((c) => ({ id: c.id, name: c.name }))
        : [];
  const validSource =
    definition?.source === "none" || sources.some((s) => s.id === sourceId);
  return (
    <Dialog title={widget ? "编辑组件" : "添加组件"} sheet onClose={onClose}>
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!definition || !validSource) return;
          void onSave({
            id: widget?.id ?? crypto.randomUUID(),
            pluginId,
            type,
            title: title.trim() || definition.name,
            variant,
            width,
            ...(definition.source !== "none" ? { sourceId } : {}),
          });
        }}
      >
        <label className="field">
          插件
          <select
            aria-label="插件"
            value={pluginId}
            onChange={(event) => {
              const next = plugins.find((p) => p.id === event.target.value);
              setPluginId(event.target.value);
              setType(next?.widgets[0]?.type ?? "");
              setSourceId("");
            }}
            required
          >
            <option value="" disabled>
              选择插件
            </option>
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {plugins.length === 0 && (
          <p className="field-help">请先在组件管理中启用插件。</p>
        )}
        <label className="field">
          组件类型
          <select
            aria-label="组件类型"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setSourceId("");
            }}
            required
          >
            <option value="" disabled>
              选择类型
            </option>
            {plugin?.widgets.map((w) => (
              <option key={w.type} value={w.type}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {definition?.source !== "none" && definition && (
          <label className="field">
            {definition.source === "node" ? "节点" : "服务连接"}
            <select
              aria-label={definition.source === "node" ? "节点" : "服务连接"}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              required
            >
              <option value="" disabled>
                选择数据源
              </option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {sources.length === 0 && (
              <small>
                {definition.capability
                  ? `暂无 ${definition.capability.toUpperCase()} 节点`
                  : definition.source === "node"
                    ? "暂无节点，请先在节点页面注册。"
                    : "暂无连接，请先在连接页面添加服务。"}
              </small>
            )}
          </label>
        )}
        <label className="field">
          组件标题
          <input
            maxLength={80}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={definition?.name ?? "为组件起个名字"}
          />
        </label>
        <fieldset className="field">
          <legend>内容密度</legend>
          <div className="choice-grid">
            {(["compact", "detailed"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`choice ${variant === v ? "selected" : ""}`}
                aria-pressed={variant === v}
                onClick={() => setVariant(v)}
              >
                <span className="choice-icon">
                  {v === "compact" ? <Box size={20} /> : <Blocks size={20} />}
                </span>
                <strong>{v === "compact" ? "紧凑" : "详细"}</strong>
                {variant === v && <Check size={13} />}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>组件宽度</legend>
          <div className="segmented">
            {(["normal", "wide"] as const).map((v) => (
              <button
                type="button"
                key={v}
                className={width === v ? "active" : ""}
                aria-pressed={width === v}
                onClick={() => setWidth(v)}
              >
                {v === "normal" ? "标准 · 1 列" : "宽幅 · 2 列"}
              </button>
            ))}
          </div>
        </fieldset>
        <ErrorMessage error={error} />
        <div className="sheet-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || !definition || !validSource}
          >
            {busy ? "保存中…" : widget ? "保存修改" : "添加组件"}
            <Plus size={15} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function NodeForm({
  node,
  busy,
  error,
  onClose,
  onSave,
}: {
  node: NodeView | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (name: string, intervalMs: number) => Promise<void>;
}) {
  const [name, setName] = useState(node?.name ?? "");
  const [intervalMs, setIntervalMs] = useState(node?.intervalMs ?? 2000);
  return (
    <Dialog title={node ? "编辑节点" : "注册新节点"} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(name.trim(), intervalMs);
        }}
      >
        <label className="field">
          节点名称
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：家里的服务器"
          />
        </label>
        {node && (
          <label className="field">
            采样间隔（毫秒）
            <input
              type="number"
              min={200}
              max={60000}
              step={200}
              required
              value={intervalMs}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
            />
          </label>
        )}
        <ErrorMessage error={error} />
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? "保存中…" : node ? "保存修改" : "注册节点"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function TokenDialog({
  result,
  onClose,
}: {
  result: TokenResult;
  onClose: () => void;
}) {
  const [config, setConfig] = useState(JSON.stringify(result.config, null, 2));
  const [localError, setLocalError] = useState<string | null>(null);
  const download = () => {
    try {
      const parsed = JSON.parse(config) as unknown;
      const blob = new Blob([JSON.stringify(parsed, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `console-agent-${result.config.nodeId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setLocalError(null);
    } catch {
      setLocalError("配置不是有效 JSON，请检查格式后重试。");
    }
  };
  return (
    <Dialog
      title="保存节点凭据"
      subtitle="令牌仅显示一次"
      onClose={onClose}
    >
      <p className="field-help token-help">
        请将 consoleUrl 改为节点可访问的控制台地址。
      </p>
      <label className="field">
        节点令牌
        <input
          readOnly
          value={result.token}
          onFocus={(event) => event.target.select()}
          className="mono"
        />
      </label>
      <label className="field">
        采集器配置（可编辑）
        <textarea
          rows={9}
          className="mono"
          value={config}
          onChange={(event) => setConfig(event.target.value)}
          spellCheck={false}
        />
      </label>
      <ErrorMessage error={localError} />
      <div className="dialog-actions">
        <button className="button secondary" onClick={onClose}>
          我已保存
        </button>
        <button className="button primary" onClick={download}>
          <Download size={15} />
          下载配置 JSON
        </button>
      </div>
    </Dialog>
  );
}
function ConnectionForm({
  busy,
  error,
  onClose,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [userId, setUserId] = useState("");
  const [token, setToken] = useState("");
  const [quotaPerUnit, setQuotaPerUnit] = useState(500000);
  const [currency, setCurrency] = useState("$");
  return (
    <Dialog title="添加 New API 连接" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            userId: Number(userId),
            token: token.trim(),
            quotaPerUnit,
            currency,
          });
        }}
      >
        <label className="field">
          连接名称
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：我的 API 账户"
          />
        </label>
        <label className="field">
          服务地址
          <input
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com"
          />
        </label>
        <div className="form-columns">
          <label className="field">
            用户 ID
            <input
              type="number"
              min={1}
              step={1}
              required
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="1"
            />
          </label>
          <label className="field">
            货币符号
            <input
              required
              maxLength={12}
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          用户访问令牌
          <input
            type="password"
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="new-password"
            placeholder="输入账户访问令牌"
          />
        </label>
        <label className="field">
          每单位货币对应配额
          <input
            type="number"
            required
            min={1}
            value={quotaPerUnit}
            onChange={(event) => setQuotaPerUnit(Number(event.target.value))}
          />
        </label>
        <ErrorMessage error={error} />
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "连接中…" : "保存连接"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function SettingsPage({
  settings,
  busy,
  onSave,
  error,
  onPasswordChange,
}: {
  settings: Settings;
  busy: boolean;
  onSave: (settings: Settings) => Promise<void>;
  error: string | null;
  onPasswordChange: (
    currentPassword: string,
    password: string,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [passwordDialog, setPasswordDialog] = useState(false);
  const previousSettings = useRef(settings);
  useEffect(() => {
    setDraft(settings);
    if (previousSettings.current !== settings) setSaved(true);
    previousSettings.current = settings;
  }, [settings]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setDraft((previous) => ({ ...previous, [key]: value }));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onSave(draft);
  };
  return (
    <>
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>空间与外观</h2>
            </div>
          </div>
          <label className="field">
            控制台名称
            <input
              required
              maxLength={80}
              value={draft.title}
              onChange={(event) => update("title", event.target.value)}
            />
          </label>
          <div className="form-columns">
            <label className="field">
              侧栏颜色
              <div className="color-input">
                <input
                  type="color"
                  value={draft.sidebarColor}
                  onChange={(event) =>
                    update("sidebarColor", event.target.value)
                  }
                />
                <span>{draft.sidebarColor.toUpperCase()}</span>
              </div>
            </label>
            <label className="field">
              强调色
              <div className="color-input">
                <input
                  type="color"
                  value={draft.accentColor}
                  onChange={(event) =>
                    update("accentColor", event.target.value)
                  }
                />
                <span>{draft.accentColor.toUpperCase()}</span>
              </div>
            </label>
          </div>
          <div className="settings-toggle">
            <div>
              <strong>界面动效</strong>
            </div>
            <button
              className={`switch ${draft.animations ? "on" : ""}`}
              type="button"
              role="switch"
              aria-checked={draft.animations}
              aria-label="界面动效"
              onClick={() => update("animations", !draft.animations)}
            >
              <span />
            </button>
          </div>
        </div>
        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>更新与历史</h2>
            </div>
          </div>
          <label className="field">
            页面刷新间隔{" "}
            <span className="field-value">
              {(draft.refreshMs / 1000).toFixed(1)} 秒
            </span>
            <input
              type="range"
              min={200}
              max={60000}
              step={200}
              value={draft.refreshMs}
              onChange={(event) =>
                update("refreshMs", Number(event.target.value))
              }
            />
            <div className="range-labels">
              <span>0.2 秒</span>
              <span>60 秒</span>
            </div>
          </label>
          <div className="form-columns">
            <label className="field">
              历史保留天数
              <input
                type="number"
                min={1}
                max={3650}
                required
                value={draft.retentionDays}
                onChange={(event) =>
                  update("retentionDays", Number(event.target.value))
                }
              />
            </label>
            <label className="field">
              历史记录间隔（毫秒）
              <input
                type="number"
                min={1000}
                max={3600000}
                step={1000}
                required
                value={draft.historyIntervalMs}
                onChange={(event) =>
                  update("historyIntervalMs", Number(event.target.value))
                }
              />
            </label>
          </div>
        </div>
        <div className="settings-save">
          <button className="button primary" disabled={busy}>
            {busy ? "保存中…" : saved ? "已保存" : "保存设置"}
            <Check size={15} />
          </button>
        </div>
      </form>
      <div className="panel settings-panel security-panel">
        <div className="panel-heading">
          <div>
            <h2>账户安全</h2>
          </div>
          <button
            className="button secondary"
            onClick={() => setPasswordDialog(true)}
          >
            修改密码
          </button>
        </div>
      </div>
      {passwordDialog && (
        <PasswordDialog
          busy={busy}
          error={error}
          onClose={() => setPasswordDialog(false)}
          onSave={onPasswordChange}
        />
      )}
    </>
  );
}
function HistoryDialog({
  node,
  nodeId,
  onClose,
  onUnauthorized,
}: {
  node?: NodeView;
  nodeId: string;
  onClose: () => void;
  onUnauthorized: () => void;
}) {
  const [windowMs, setWindowMs] = useState(3600000);
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPoints([]);
    void request<{ points: HistoryPoint[] }>(
      `/nodes/${nodeId}/history?window=${windowMs}`,
      { signal: controller.signal },
    )
      .then((result) => setPoints(result.points))
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
        else setError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [nodeId, windowMs, onUnauthorized]);
  const times = points.map((p) => p.timestamp);
  const end = Math.max(Date.now(), ...times);
  const start = end - windowMs;
  const path = (metric: "cpu" | "memory") => {
    let output = "";
    let connected = false;
    let previous = 0;
    for (const point of points) {
      const value =
        metric === "cpu"
          ? point.sample?.cpuPct
          : point.sample?.memory
            ? (point.sample.memory.usedBytes / point.sample.memory.totalBytes) *
              100
            : null;
      if (value == null || !Number.isFinite(value)) {
        connected = false;
        continue;
      }
      const x = 40 + ((point.timestamp - start) / windowMs) * 590;
      const y = 170 - Math.min(100, Math.max(0, value)) * 1.35;
      const gap =
        previous > 0 &&
        point.timestamp - previous >
          Math.max((point.sample?.intervalMs ?? 1000) * 3, 120000);
      output += `${connected && !gap ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
      connected = true;
      previous = point.timestamp;
    }
    return output;
  };
  return (
    <Dialog title={`${node?.name ?? "节点"} · 历史趋势`} onClose={onClose}>
      <div className="history-toolbar">
        <div className="segmented">
          {[
            { label: "1 小时", value: 3600000 },
            { label: "24 小时", value: 86400000 },
            { label: "7 天", value: 604800000 },
          ].map((item) => (
            <button
              key={item.value}
              className={windowMs === item.value ? "active" : ""}
              onClick={() => setWindowMs(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="chart-legend">
          <span>
            <i />
            CPU
          </span>
          <span>
            <i />
            内存
          </span>
        </div>
      </div>
      <ErrorMessage error={error} />
      {loading ? (
        <div className="chart-placeholder">
          <LoaderCircle className="spin" size={22} />
          <span>读取历史数据…</span>
        </div>
      ) : points.some((point) => point.sample !== null) ? (
        <div className="history-chart">
          <svg
            viewBox="0 0 650 205"
            role="img"
            aria-label="CPU 和内存历史使用率折线图"
          >
            {[0, 25, 50, 75, 100].map((value) => (
              <g key={value}>
                <line
                  x1="40"
                  x2="630"
                  y1={170 - value * 1.35}
                  y2={170 - value * 1.35}
                  stroke="#eef0f4"
                />
                <text
                  x="28"
                  y={174 - value * 1.35}
                  textAnchor="end"
                  fill="#9298a8"
                  fontSize="10"
                >
                  {value}%
                </text>
              </g>
            ))}
            <path
              d={path("cpu")}
              fill="none"
              stroke="#8796db"
              strokeWidth="2"
            />
            <path
              d={path("memory")}
              fill="none"
              stroke="#92b7a0"
              strokeWidth="2"
            />
            <text x="40" y="197" fill="#9298a8" fontSize="10">
              {new Date(start).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </text>
            <text x="630" y="197" textAnchor="end" fill="#9298a8" fontSize="10">
              现在
            </text>
          </svg>
        </div>
      ) : (
        <div className="chart-placeholder">
          <Activity size={25} />
          <span>这个时间段还没有历史数据</span>
        </div>
      )}
      <div className="dialog-actions">
        <button className="button secondary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Dialog>
  );
}

function PasswordDialog({
  busy,
  error,
  onClose,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (currentPassword: string, password: string) => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return (
    <Dialog
      title="修改管理员密码"
      subtitle="修改后，所有会话将退出"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password === confirmation) void onSave(currentPassword, password);
        }}
      >
        <label className="field">
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="field">
          新密码
          <input
            aria-label="新密码"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <small>至少 12 个字符。</small>
        </label>
        <label className="field">
          确认新密码
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {confirmation && password !== confirmation && (
            <small className="inline-error">两次输入的新密码不一致。</small>
          )}
        </label>
        <ErrorMessage error={error} />
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || password.length < 12 || password !== confirmation}
          >
            {busy ? "保存中…" : "保存并重新登录"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
