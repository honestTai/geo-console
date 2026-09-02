# GEO Console Release Workflow

## 1. 本地验证与打包

从仓库根目录执行：

```bash
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
corepack pnpm lint
bash deploy/package.sh
```

服务器 `.run` 与桌面客户端是两套产物。需要发布桌面版本时额外执行：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/zz-geo.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
corepack pnpm desktop:build
```

私钥不能进入 bundle 或仓库。上传 Tauri 平台产物、对应 `.sig` 与完整 `latest.json` 到受控 HTTPS 更新位置；先用内置公钥验证签名，再更新清单。更新清单不能包含不存在的平台占位记录。

服务器使用 `geo-console desktop-publish <latest.json> <update-asset...>` 原子发布到跨应用升级保留的 `shared/desktop`。先发布版本化资产，最后替换清单；命令保留上一份清单，不删除旧资产。

产物位于 `dist/geo-console-<release>.run` 和对应 `.sha256`。clean worktree 使用 12 位 commit；dirty worktree 使用 `<commit>-dev-<UTC>`。

脚本通过 `git ls-files --cached --others --exclude-standard` 收集服务器文件并明确排除 `apps/desktop`。不要假定只有已提交文件会进入 bundle；桌面客户端必须走独立签名产物流程。

打包器必须把 `deploy/install.sh`、`deploy/package.sh` 和 `deploy/geo-console` 规范化为 LF。生成后检查 bundle 启动器与 payload shell 文件不含 CRLF，避免 Linux 在 `set -o pipefail` 或 shebang 处失败。

## 2. 连接 Demo

连接参数在父级 `SKILL.md`。使用标准 SSH/SCP 的交互式密码提示，不使用 `sshpass`、URL 密码或禁用 host-key 校验。

首次连接：

```bash
ssh root@geo.example.com
```

记录服务端展示的 host-key fingerprint，确认后再继续。先执行只读检查：

```bash
test -f /opt/geo-console/shared/.env && sed -n '/^GEO_DOMAIN=/p;/^GEO_ADMIN_EMAIL=/p' /opt/geo-console/shared/.env
test -L /opt/geo-console/current && readlink -f /opt/geo-console/current
command -v geo-console >/dev/null && geo-console version
```

只读取非 Secret 配置。不要输出完整 `.env` 或 `shared/secrets`。

## 3. 上传与校验

开发机：

```bash
scp dist/geo-console-<release>.run \
    dist/geo-console-<release>.run.sha256 \
    root@geo.example.com:/tmp/
```

服务器：

```bash
cd /tmp
sha256sum -c geo-console-<release>.run.sha256
```

使用明确文件名，不通过 glob 执行未知 bundle。

## 4. 首次安装

只有确认域名和管理员邮箱后执行：

```bash
bash /tmp/geo-console-<release>.run \
  --domain <confirmed-domain> \
  --admin-email <confirmed-admin-email> \
  --capture-concurrency 1
```

默认安装到 `/opt/geo-console`，备份到 `/var/backups/geo-console`。可用 `--backup-dir <absolute-path>` 指定已确认位置。只有明确不需要安装 Docker 或 Swap 时才用 `--skip-docker-install` / `--no-swap`。

安装完成后：

```bash
geo-console doctor
geo-console status
geo-console show-admin-password
```

只向授权用户显示一次 bootstrap password。立即离线备份 `/opt/geo-console/shared/secrets/master_key`，再登录 UI 配置 Provider/HRouter。

## 5. 已有实例升级

先确认版本和备份：

```bash
geo-console version
geo-console doctor
geo-console backup
geo-console upgrade /tmp/geo-console-<release>.run
```

upgrade 会构建新镜像、再次创建切换前备份、停止应用服务、切换 `current` 并激活。PostgreSQL 与 Caddy 数据卷保持不变。

镜像构建在服务器本地执行，但 Web 静态产物由发布机本地构建（`deploy/package.sh` 自动运行 `pnpm --filter @geo/web build` 并把 `apps/web/dist` 打进 bundle)，Web 镜像只复制 dist、不再在构建期安装依赖；Worker 镜像的 corepack/pnpm registry 与 Playwright 浏览器下载走 npmmirror，且镜像构建会松弛 minimumReleaseAge/trustPolicy 元数据检查（`--frozen-lockfile` 的 sha512 完整性校验保留，策略检查仍以发布机本地安装为准）。慢速外网或 SSH 断连时，可用 `nohup geo-console upgrade ... > /tmp/upgrade-<id>.log 2>&1 &` 挂后台再轮询日志。

升级后验证：

```bash
geo-console version
geo-console doctor
geo-console status
geo-console logs api
geo-console logs log-service
```

同时在浏览器或使用有界 HTTP 请求验证：

- `https://<domain>/` 返回产品官网。
- `https://<domain>/app` 重定向到 `/app/`。
- `https://<domain>/app/` 返回工作台，并可进入登录流程。
- 官网“进入工作台”链接指向同域 `/app`。
- `/api/health` 中 `logService.status=ok`，容器内 `log-service:3020/health` 可用，工作台管理员可看到当前机构结构化日志。
- 浏览器调试入口和已签名桌面客户端返回相同动态导航；桌面“检查更新”只能接受 GEO 公钥验证的包。

`geo-console logs` 会持续跟随；只需有界日志时改用当前 release 下的 `docker compose --env-file .env logs --tail=200 <service>`。

## 6. 回滚/恢复

- 若新 release 构建或 pre-switch 检查失败，保持旧 `current` 在线，不执行切换。
- 若切换后失败且没有不兼容 migration，可在确认后重新激活旧 release；管理脚本没有内置 rollback 命令，不要临时改软链接后跳过验证。
- 若 migration 不兼容，使用升级前 dump 和 evidence/S3 版本恢复到新建空 PostgreSQL 与隔离对象位置，验证旧 release 的健康、登录、样本证据、Log Service 和 PDF 后，再切换流量。
- 不要把 dump 直接恢复覆盖唯一数据库，也不要只回滚应用而忽略 schema。

## 7. 清理

上传到 `/tmp` 的 bundle 含源码和 demo skill 凭据。部署与回滚窗口结束、确认不再需要后，按用户授权精确删除对应 `.run` 和 `.sha256` 文件；不要使用宽泛 glob。保留 `/opt/geo-console/releases` 中的受控 release，直到备份和回滚窗口结束。
