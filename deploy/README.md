# Linux 部署

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash
```

支持 Ubuntu 22.04 / 24.04、Debian 12 / 13，x86_64 / ARM64，要求 systemd 正在运行。脚本通过 sudo 提权或以 root 执行；安装专用 Node.js 24.15.0 并校验下载包。重复执行即升级；新版构建、登录及两个后台检查通过后完成切换，失败恢复旧版本。

## 按变化升级

| 检查结果 | 执行内容 |
| --- | --- |
| 版本、配置、服务文件未变，当前进程健康 | 直接结束，不下载源码、不安装依赖、不构建、不重启 |
| 同版本，仅配置变化或服务停止 | 先校验配置，再重启或恢复服务，不重新构建 |
| 新版本，仅文档或未使用的其他平台工具变化 | 核对内容后直接结束，不安装依赖、不构建、不重启 |
| 新版本，仅独立后端变化 | 复用独立依赖副本及已验证的页面产物，更新后端并重启 |
| 新版本，页面构建输入变化、依赖输入未变 | 复制上次成功版本的独立依赖副本，空间允许时复用 Webpack 与 TypeScript 编译缓存，在固定目录增量构建后切换 |
| Linux 所需依赖、`.npmrc`、Node.js/npm 或架构变化 | 重新安装所需依赖，优先使用本机下载缓存，再构建 |

页面代码、相关配置和构建依赖变化时仍会构建，避免沿用旧页面产物。依赖副本不会与正在运行的旧版本共享硬链接；构建失败不修改旧版本。安装生命周期脚本、本地依赖或 workspace 还会将源码变化纳入依赖检查，避免漏掉准备步骤。本地 `--source-dir` 使用内容摘要，文件时间变化不触发重建。

首次切换到 Linux 精简依赖时会重新安装并构建一次，之后按上述规则复用。没有成功部署记录的旧安装器也会正常安装一次。需要完整重装依赖并构建时，可以运行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash -s -- --rebuild
```

账号密码、告警配置和数据目录始终保留。配置校验不通过时，正在运行的旧服务不会被停止。

### 测量部署耗时

在目标服务器运行以下脚本，实际执行一次正常增量部署，并按耗时从高到低汇总各阶段：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/profile-install.sh | bash
```

如果当前版本没有变化，依赖安装和构建会显示“已复用”。需要测量完整的依赖重装与构建时，显式加入 `--rebuild`：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/profile-install.sh | bash -s -- --rebuild
```

`--rebuild` 保留已有配置、数据及 npm 下载缓存，完成后会切换并重启服务；它不等于一台全新服务器的首次安装。也可在原 `install.sh` 命令后直接添加 `--profile`，与 `--source-dir`、`--port`、`--cleanup` 配合使用。

报告列出总耗时、退出码，以及每阶段的秒数、占比和状态，覆盖版本查询、源码下载、Node 准备、依赖安装或复制、编译缓存、Next 构建（含类型检查）、权限处理、服务切换、健康检查、容量统计和清理/回滚。同一阶段多次执行时累加，阶段时间互不重叠；未执行和明确跳过分别显示，失败时仍输出已经测得的结果并保留原退出码。

下载部署脚本单独计时；阶段总耗时从提权后的安装前置检查开始，不包含下载诊断入口和等待输入 sudo 密码的时间。报告保存在输出指示的 `/tmp/market-spread-profile.XXXXXXXX/summary.txt`，目录和文件仅当前执行用户（正常为 root）可读，可用 `sudo cat` 查看。报告只含固定阶段、耗时及状态，不保存安装输出、登录密码或环境配置；排查时粘贴末尾耗时汇总即可。

### 构建优化

服务器只安装全部运行依赖，以及 Next 构建需要的 TypeScript、类型声明和 Tailwind 工具；不安装 Vite、Vinext、Wrangler、ESLint、Drizzle Kit 等当前 Linux 路径未使用的开发工具。`tsconfig.linux.json` 保留应用类型检查，排除未使用的 Cloudflare、Vite 和数据库生成配置；被应用实际导入的文件仍参与检查和构建内容判断。仓库的完整开发依赖保留。

精简清单和锁文件提交在 `deploy/linux/`，保留根锁文件的依赖版本与平台可选组件。服务器安装时临时使用精简清单，安装完成后恢复原清单与构建脚本。若项目引入根安装生命周期、本地依赖、workspace 或补丁等完整安装要求，会自动回退到原清单。调整依赖后，用 Node.js 24.15.0 配套的 npm 11.12.1 执行 `node scripts/sync-linux-dependencies.mjs` 并提交两份生成文件；CI 用 `--check` 校验一致性，服务器不重新生成锁文件。

安装器在固定的 `/opt/market-spread-monitor/build` 目录构建，再将结果移入独立版本目录。Next 的 Webpack 缓存包含依赖的绝对路径；此前每次在随机版本目录构建，复制过来的缓存会因路径变化失效。现在同一台服务器上的后续构建可按内容复用编译结果。候选目录只移动，不常驻额外一份依赖；正在运行的旧版本保持独立。

编译缓存只复制 `webpack`、`.tsbuildinfo` 和 `.rscinfo`：分别用于 Webpack、TypeScript 增量检查，以及 Next 构建缓存自身的有效期检查；不复制图片或请求等运行缓存。Next 原有过期轮换继续生效。仅更新独立后端、复用整份页面产物时也保留这些编译缓存，供下一次页面更新使用。

同时开启 [Next 官方 Webpack 内存优化](https://nextjs.org/docs/app/guides/memory-usage#try-experimentalwebpackmemoryoptimizations)，减少构建内部重复的字符串与 Buffer 缓存。保留类型检查和框架默认并发，不设置 CPU、内存配额或调度限速。首次安装、首次迁移到固定构建路径，以及依赖或缓存失效时仍需冷构建；主要节省发生在后续代码更新，实际耗时取决于改动内容。

构建失败会清理本次候选版本；突然中断留下的构建目录会在下次部署时核实归属并回收。运行版本、配置、数据和非安装器管理的目录受到保护。日志会分别说明依赖复用、编译缓存复制、完整构建复用及跳过的阶段；一键安装命令不变。

服务定义内容未变时，保留现有文件并跳过重复校验；仅在定义变化或 systemd 报告需要重载时重载。已有开机启动状态直接复用。文件权限处理合并遍历，复用的页面产物通过复制后校验即不再重复校验，启动后的实际健康检查仍保留。

每次执行（包括无需升级时）会先清理安装器管理的旧版本，默认保留当前版本和一份成功回退版本；成功升级后再回收更早版本。实际服务进程的工作目录、传入的源码目录和配置的数据目录额外受保护，可能因此保留更多版本。未知目录和符号链接不参与清理。

下载、依赖复制和构建前都会检查对应分区的可用容量与 inode，按现有依赖及构建大小预留空间。空间紧张时只回收本项目的 npm 下载缓存和 Webpack 编译缓存，不删除运行缓存、配置或数据库；仍不足则在停止旧服务之前退出，打印可用量和所需量。编译缓存只在空间足够时复制，失败的本次版本会自动回收。

出现 `ENOSPC` 时，先检查 `df -h /opt /tmp /var` 和 `df -i /opt /tmp /var`。重新执行上方安装命令会先清理再升级；只回收旧版和可重建缓存、不安装也不重启时运行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash -s -- --cleanup
```

旧安装器曾保留每次成功部署的完整依赖和构建产物，这些文件会在新清理流程中回收；项目运行数据的容量估算不包含部署目录。若清理后仍不足，可用 `sudo du -xhd1 /opt /var /tmp` 定位其他占用；清理器不会删除其他应用数据或系统日志。

| 内容 | 路径或名称 |
| --- | --- |
| 服务 | `market-spread-monitor.service` |
| 系统用户 | `spread-monitor` |
| 当前版本 | `/opt/market-spread-monitor/current` |
| 历史版本 | `/opt/market-spread-monitor/releases` |
| 配置 | `/etc/market-spread-monitor.env`，权限 0600 |
| 行情数据库 | `/var/lib/market-spread-monitor/market.sqlite`，含最新快照、采集状态和逐条行情/资金费记录 |
| 海力士状态 | `/var/lib/market-spread-monitor/hynix/alerts.json` |
| 原油状态 | `/var/lib/market-spread-monitor/oil/monitor.json` |
| Variational 会话 | `/var/lib/market-spread-monitor/variational-session.json`，页面验证保存后创建，权限 0600 |
| 单实例锁 | `/var/lib/market-spread-monitor/instance.lock` |

首次生成登录密码，用户名默认 `admin`。端口默认 3000，首次安装可传 `--port 3001`；已有配置始终保留，后续修改配置后重启：

```bash
sudo systemctl status market-spread-monitor
sudo journalctl -u market-spread-monitor -n 50
sudo systemctl restart market-spread-monitor
```

在面板顶部“统一飞书告警”保存 Webhook 和可选签名密钥，所有模块立即共用，无需修改环境文件或重启。读取 API 不返回完整 Webhook 或密钥。统一配置保存在 `ALERT_DATA_DIR/notifications.json`（0600），备份数据目录时一并保留。阈值与开关在各模块分别设置；`OIL_POLL_INTERVAL_SECONDS` 默认 30，范围 10–3600。网页关闭后后台继续工作。

Variational 的认证行情可在原油交易所对比行点击“更新 Var token”，填写 Cookie 中 `vr-token` 的值，验证成功后立即保存到上述会话文件。下一轮采集自动使用，无需重启或修改环境配置。旧 token 在验证或保存失败时保留；备份、迁移与升级保留整个数据目录即可保留会话。安装无需 token，未配置、过期或认证失败时仍获取公开标记价与预测资金费；资金费请求不携带 token。固定 Variational 请求复用安装器已有的 Python 3 标准库，临时访问拦截不再误报为 token 失效。

旧海力士机器人和旧 `OIL_FEISHU_WEBHOOK_URL` / `OIL_FEISHU_WEBHOOK_SECRET` 只在全局文件首次创建时迁移。两处配置相同或只有一处时直接沿用；不同则在统一设置中选择共用哪一个，选择前暂停发送。之后全局文件优先，清除机器人后不会被旧环境变量重新启用。首次迁移保留旧模块文件用于启动失败回滚；首次主动保存海力士阈值后，模块文件切换为不存储机器人凭据的 v2 格式。开启机器人关键词校验时，请添加“告警”。

`GET /healthz` 检查进程与存储健康；外部行情临时失败在各面板单独显示。业务页面统一登录，API 写操作要求同源和 JSON。内核 `flock` 拒绝同一数据目录的重复进程，异常退出自动释放。

服务首次启动自动建库并导入已有价格及资金费历史，不覆盖已有数据库。采集器与页面请求独立：海力士报价每 10 秒、原油报价按 `OIL_POLL_INTERVAL_SECONDS`、海力士小时历史与原油 15 分钟历史每 60 秒、原油旧日线及两个市场的资金费每 5 分钟更新。历史更新从数据库接续并回补缺口，报价按实际采集时间保存，历史按原始时段去重。页面接口只读库；断网或上游限流时立即返回已保存数据并标明过期，不等待外部接口。

原油主面板与告警已切换 Binance BZUSDT / CLUSDT，单位为 USDT/桶。升级自动使用独立数据集 `oil/binance/quote`、`oil/binance/history`、`oil/binance/funding`、`oil/binance/candles/15m`，保留原 Hyperliquid 数据与配置。15 分钟历史从 2026-04-01 上市时段分页回补，不受旧源 5,000 根限制。告警阈值与开关保留，旧发送记录保留并标注来源；换源时重置触发状态、增加配置修订号，按新源重新判断，无需手动迁移。

首页按每次访问读取同一数据库，把报价卡片和迷你走势直接放进 HTML，并将已有价格历史交给图表初始化；不会缓存成构建时的固定行情。浏览器启动后再刷新接口，刷新失败保留首屏数据与原始时间。

Bybit / Binance 的原油和海力士报价，加上 Hyperliquid 原油，共五组，每 15 秒独立采集并写入同一数据库，页面及首屏对比区只读库。合约使用 USDT 标记价；资金费按各腿实际结算周期换算，缺失时显示 `—`。升级会自动加入这些采集任务，保留已有历史、配置和告警；无需新增 API 密钥。原油主面板历史与告警使用 Binance，海力士保持 Hyperliquid。原油历史资金费按实际 4 小时结算计数，缺失不补零；底层指数自动展期带来的价格盈亏未计入资金费年化。

SQLite 使用 WAL 和事务，行情记录与最新快照同时提交，落盘失败不向告警提供新报价。正常关闭会等待在途采集完成后关闭数据库。备份时停止服务再复制整个数据目录，包含可能存在的 `market.sqlite-wal` 和 `market.sqlite-shm`；不要仅复制正在运行中的主数据库文件。数据目录与代码版本分离，重复部署、升级和回滚均会保留数据库。

HTTPS 反向代理可将 `HOST=127.0.0.1`，参考 [nginx 配置](nginx.conf.example)。保留 Host 和 Authorization，让网页与 API 同源。

## 迁移旧配置

安装器不会读取或修改旧项目。先部署新项目，再停止新旧后台并备份数据；确认不需要旧服务继续发通知后，复制对应文件：

| 旧文件 | 新位置 |
| --- | --- |
| 海力士数据目录的 `alerts.json` | 新 `ALERT_DATA_DIR/hynix/alerts.json` |
| 原油数据目录的 `monitor.json` | 新 `ALERT_DATA_DIR/oil/monitor.json` |

原油环境变量 `FEISHU_WEBHOOK_URL` / `FEISHU_WEBHOOK_SECRET` 改为 `OIL_FEISHU_WEBHOOK_URL` / `OIL_FEISHU_WEBHOOK_SECRET` 并保留原值。不要复制旧锁文件。新数据目录所有者为 `spread-monitor:spread-monitor`，目录和文件权限分别保持 0700 / 0600，再启动新服务。统一登录取代原油 `ADMIN_TOKEN`。

状态文件的原数据格式、revision 和触发状态保持兼容。备份需同时保存环境配置与完整 `ALERT_DATA_DIR`；恢复与迁移都在服务停止时进行。
