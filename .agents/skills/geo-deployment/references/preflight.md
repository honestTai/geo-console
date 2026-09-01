# GEO Console Deployment Preflight

## 目标与授权

- 确认是 local、demo 还是另一个明确命名的服务器。
- 首次安装确认 HTTPS domain、DNS A/AAAA、管理员邮箱、备份目的地、对象存储模式。
- 已有部署确认当前 release、`/opt/geo-console/current`、共享配置、备份和维护窗口。
- SSH 登录权限不等于授权修改云安全组、DNS、对象存储、外部 PostgreSQL 或删除数据。

## 主机

- Linux 为受支持的 Ubuntu/Debian，root/sudo 可用。
- Docker Engine、Buildx、Compose plugin 已安装，或允许安装器从 Docker 官方 APT 仓库安装。
- Demo 至少 2 CPU、约 4 GB RAM、30 GB 可用空间；目标为 50 GB SSD。没有 Swap 时确认是否允许创建 `/swapfile` 2 GB。
- 系统时间同步；云安全组只开放 80/443，SSH 只允许管理来源；3010 与 5432 不映射公网。
- domain 已解析到目标 IP，80/443 未被其他服务占用，Caddy 可访问 ACME。

## 配置与 Secret

- `GEO_DOMAIN` 是域名而不是 IP；`GEO_ADMIN_EMAIL` 已确认。
- Demo 的 capture concurrency 保持 1；只有容量和 Provider 配额明确时才提高。
- `GEO_BACKUP_DIR` 是绝对、安全、容量充足且有异机同步策略的目录。
- `shared/secrets/postgres_password`、`master_key`、`admin_password` 权限为 600，目录为 700；master key 解码后必须恰好 32 字节。
- 主密钥有离线副本；不要打印、提交或在聊天中回显任何 Secret。
- local object mode 确认 evidence volume 与备份同盘风险；S3 mode 确认 private bucket、versioning、encryption、endpoint、region、path style、恢复负责人和实例角色/Key。

## 发布包

- 在开发机运行仓库四项检查，再用 Bash 执行 `deploy/package.sh`。
- 记录 commit、release ID、打包时间、工作区是否 dirty。
- 检查 bundle 不含 `.env`、顶层 `secrets`、数据库、artifacts、backups 或无关大文件。
- 由于项目 skill 中含 demo SSH 密码，bundle 是敏感产物，只能进入同一 demo 管理边界。
- 本地与服务器分别校验 SHA-256；校验失败不得执行。

## 上线前退出条件

- `docker compose config --quiet` 通过。
- 旧实例已有最新成对备份；S3 模式已抽查对象版本。
- 明确 migration 只能向前和可接受的停机窗口。
- 明确失败后的策略：保持旧实例在线、停止切换，或恢复到新建空数据库；不能原地覆盖唯一数据库。
