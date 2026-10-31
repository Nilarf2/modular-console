# 部署与运行

控制台由一个 Node.js 进程提供静态页面、API 和 SSE 实时流，数据使用本地 SQLite。部署实例需要 Node.js 24.13.0+；Docker 镜像使用 Node 24。监控采集端是另行部署到目标主机的 Python 3.10+ 程序，不随控制台容器自动安装。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址；容器内为 `0.0.0.0` |
| `PORT` | `9470` | 真实实例端口；示例模式默认 `9471` |
| `CONSOLE_DATA_DIR` | `data/live` | 真实实例私有目录；示例模式默认 `data/demo` |
| `CONSOLE_PUBLIC_ORIGIN` | 未设置 | 浏览器访问的完整源，例如 `https://console.example.com`，不含路径；用于来源校验、Cookie 安全属性和生成采集配置 |
| `CONSOLE_ADMIN_PASSWORD_FILE` | 未设置 | 初始化时读取管理员密码的私有文件；密码长度 12–256 个字符 |
| `CONSOLE_DEMO` | 非 `true` | 只有值为 `true` 才启用只读合成示例 |
| `CONSOLE_HTTP_PORT` | `9470` | 仅 Compose 使用的宿主机端口映射变量 |

应用本身不会自动读取 `.env`，可参考 `.env.example`，通过 shell 或服务管理器设置变量。Compose 会读取 `.env` 做变量替换，但当前只将公开源与宿主机端口作为可替换项；容器监听地址与数据路径由 Compose 明确设置。

## 初始化与权限

源码运行时先执行 `npm ci`、`npm run init`、`npm run build`，再运行 `npm start`。服务首次启动也会自动初始化，所以 Docker Compose 无需单独执行初始化命令。

初始化生成 `console.sqlite`、32 字节 `encryption-key` 和随机 `initial-password`。数据目录权限为 `0700`，关键文件为 `0600`。首次密码只保存在私有文件中，不写入启动输出；请在本机私密读取。设置了密码文件时使用该文件，不生成首次密码文件。已有数据库的管理员密码不会被这个变量重置。登录后修改密码会使现有会话失效；原首次密码文件不会自动更新，可在安全保存新密码后移除旧文件。

管理员密码以 scrypt 散列保存，节点令牌与会话令牌保存为散列，NewAPI 配置以 AES-256-GCM 加密保存在数据库中。密钥与数据库同在私有目录中，保护整个目录仍是必要条件。

## Compose 持久化

```sh
docker compose up -d --build console
docker compose ps
```

真实实例映射 `127.0.0.1:9470`，数据卷为 Compose 项目下的 `console-data`。镜像预先将挂载点交给非 root 的 `node` 用户，新命名卷继承该目录权限。不要使用 `docker compose down -v` 作为普通升级命令，它会删除持久数据。

如需自选宿主机目录，可将卷改为 `./data/live:/app/data/live`，并预先创建目录、为镜像的 UID/GID `1000:1000` 提供访问权限；不要通过放宽为全员可读写解决权限问题。更换容器 UID 时也需要同步调整数据目录归属。

镜像包含 `/api/health` 健康检查，只用于确认 HTTP 服务能够响应。它不证明每个节点或 NewAPI 上游可用。容器根文件系统只读，数据卷与临时目录可写。

## HTTPS 反向代理

Compose 默认只对本机开放 HTTP。对远程浏览器与采集端开放时，使用你管理的 HTTPS 反向代理，并将 `CONSOLE_PUBLIC_ORIGIN` 改成实际的 HTTPS 源。例如 `.env` 中设置 `CONSOLE_PUBLIC_ORIGIN=https://console.example.com`，随后重建容器配置：

```sh
docker compose up -d console
```

这里的域名仅为保留示例。应用按站点根路径运行，当前没有子路径部署配置。代理应保留原始 Host、允许 SSE 长连接，并关闭响应缓冲。以下 Nginx 片段放入已有、正确配置证书的 HTTPS `server` 中：

```nginx
location / {
    proxy_pass http://127.0.0.1:9470;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

应用使用 HttpOnly、SameSite=Strict 会话 Cookie；HTTPS 公开源会启用 Secure Cookie 与 HSTS。写操作检查会话和 CSRF 令牌。当前应用未启用对代理转发 IP 的信任，因此反向代理后的登录限流按代理地址共享；如需按客户端地址做边界限流，可在代理层设置。

采集端访问远程服务必须使用 HTTPS，验证证书并拒绝重定向。注册节点前设置正确公开源，可以让下载的采集配置直接使用它。详见 [采集端部署](../agent/README.md)。

## 备份、恢复与升级

先停止写入，再备份整个私有目录或命名卷，包含数据库、可能存在的 WAL/SHM 文件及 `encryption-key`。例如源码部署先停止 Node 服务；Compose 部署先执行 `docker compose stop console`，再通过本机备份工具读取该卷。备份本身含可解密的凭据，需限制读取权限。

恢复时在服务停止状态下恢复同一份数据库与原始密钥，并恢复运行用户的权限。数据库存在但密钥缺失时，应用拒绝启动，不会生成替代密钥。只恢复数据库无法解密原连接。新版本升级前保留可用备份；当前没有承诺跨版本无损回滚，回滚时应恢复旧程序与升级前完整数据备份。

源码升级流程为停止服务、备份、更新代码、`npm ci`、`npm run build`、启动服务；Compose 为备份后执行 `docker compose up -d --build console`。不要把 `data/`、私有配置、密码文件或备份提交到仓库或镜像构建上下文。

## 独立示例

```sh
docker compose --profile demo up -d --build demo
```

示例监听本机 `9471`，使用独立 `console-demo` 卷和合成主机数据；可匿名查看，拒绝配置写入与采集上传。真实实例和示例必须使用不同数据目录。示例模式只是只读展示模式，不是保护已有真实数据的脱敏器；不要指向真实数据库。

当前版本面向单实例、单管理员，不提供高可用协调、共享数据库、多租户或告警服务。监控历史默认保留 30 天，实际磁盘增长取决于节点数、GPU 数量和历史聚合间隔，应按使用规模调整并观察本机磁盘。
