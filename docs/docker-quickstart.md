# Docker 一键启动

先安装 Docker Engine 与 Compose v2，Windows/macOS 使用 Docker Desktop 的 Linux 容器模式。建议至少 4 核、8 GB 内存、20 GB 可用空间。首次会下载基础镜像、依赖和 Chromium，后续沿用缓存。

## 启动

下载并解压完整源码，或克隆 GitHub 仓库，在根目录执行：

```bash
# macOS / Linux / WSL
bash docker/quickstart/start.sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File docker/quickstart/start.ps1
```

首次只需填写管理员邮箱。脚本生成独立的数据库密码、主密钥、日志令牌和管理员密码，配置保存在 `.quickstart/`，不会提交到 Git 或打入镜像。

启动完成访问 **http://localhost:8080/app/**。管理员密码在 `.quickstart/secrets/admin_password`，首次登录后修改密码。这个地址是你本机的服务，不是官方体验环境。默认只绑定本机，不对局域网或公网开放。

如官方 npm 下载缓慢，可在启动前设置 `NPM_REGISTRY=https://registry.npmmirror.com`（PowerShell 使用 `$env:NPM_REGISTRY`）；锁文件和供应链校验不关闭。

## 日常操作

```bash
bash docker/quickstart/start.sh status
bash docker/quickstart/start.sh logs
bash docker/quickstart/start.sh stop
bash docker/quickstart/start.sh restart
```

PowerShell 对应在脚本后加 `-Action status`、`-Action logs`、`-Action stop` 或 `-Action restart`。

再次执行 start 不会重新生成密码。缺失任何 Secret 时会停止，要求从备份恢复，不会用新密钥覆盖已有加密数据。stop 不删除容器卷。

## 数据和备份

Compose 项目名为 `zzgeo-quickstart`，与旧服务器发行项目分开。PostgreSQL 数据在 `zzgeo-quickstart_database` 卷，原始证据与报告在 `zzgeo-quickstart_evidence` 卷。`.quickstart/` 包含解密需要的主密钥和启动配置，必须单独安全备份。

不要执行 `docker compose down -v`，这会删除数据库和证据卷。备份/恢复按 [运维文档](operations.md) 执行；恢复只进入新建数据库，不能覆盖唯一数据副本。

## 公网部署

默认配置只用于本机。公网使用先准备域名和 HTTPS，再编辑 `.quickstart/config.env`：把 `GEO_SITE_ADDRESS` 改为真实域名、`GEO_ORIGIN` 改为对应 HTTPS Origin，设置 `GEO_BIND=0.0.0.0`、HTTP/HTTPS 端口为 80/443。域名解析与防火墙由部署者配置，Caddy 申请证书。

本机使用 localhost；生产 Cookie 保持 Secure，不通过禁用安全 Cookie 支持任意 IP 上的明文 HTTP。数据库、API、日志服务和 Worker 不映射到主机端口。

## 与服务器发行包的区别

这是面向源码使用者的 Docker 自构建入口，不依赖项目维护者的私有基础镜像。包含九个服务、数据库自动迁移、中文 PDF 所需浏览器运行时和完整源码下载。线上维护者升级仍用 `deploy/package.sh` 的制品流程，不把两套 Compose 混在同一个数据卷上。
