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
| 新版本，依赖输入未变 | 复制上次成功版本的独立依赖副本和 `.next/cache`，构建新代码后切换 |
| 依赖清单、`.npmrc`、Node.js/npm 或架构变化 | 重新安装依赖，优先使用本机下载缓存，再构建 |

新版本仍需要构建，避免沿用旧页面产物。依赖副本不会与正在运行的旧版本共享硬链接；构建失败不修改旧版本。安装生命周期脚本、本地依赖或 workspace 还会将源码变化纳入依赖检查，避免漏掉准备步骤。本地 `--source-dir` 使用内容摘要，文件时间变化不触发重建。

旧安装器没有成功部署记录，更新到此版本时会正常安装一次；之后开始按上述规则复用。需要完整重装依赖并构建时，可以运行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash -s -- --rebuild
```

账号密码、告警配置和数据目录始终保留。配置校验不通过时，正在运行的旧服务不会被停止。

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
| 单实例锁 | `/var/lib/market-spread-monitor/instance.lock` |

首次生成登录密码，用户名默认 `admin`。端口默认 3000，首次安装可传 `--port 3001`；已有配置始终保留，后续修改配置后重启：

```bash
sudo systemctl status market-spread-monitor
sudo journalctl -u market-spread-monitor -n 50
sudo systemctl restart market-spread-monitor
```

在面板顶部“统一飞书告警”保存 Webhook 和可选签名密钥，所有模块立即共用，无需修改环境文件或重启。读取 API 不返回完整 Webhook 或密钥。统一配置保存在 `ALERT_DATA_DIR/notifications.json`（0600），备份数据目录时一并保留。阈值与开关在各模块分别设置；`OIL_POLL_INTERVAL_SECONDS` 默认 30，范围 10–3600。网页关闭后后台继续工作。

旧海力士机器人和旧 `OIL_FEISHU_WEBHOOK_URL` / `OIL_FEISHU_WEBHOOK_SECRET` 只在全局文件首次创建时迁移。两处配置相同或只有一处时直接沿用；不同则在统一设置中选择共用哪一个，选择前暂停发送。之后全局文件优先，清除机器人后不会被旧环境变量重新启用。首次迁移保留旧模块文件用于启动失败回滚；首次主动保存海力士阈值后，模块文件切换为不存储机器人凭据的 v2 格式。开启机器人关键词校验时，请添加“告警”。

`GET /healthz` 检查进程与存储健康；外部行情临时失败在各面板单独显示。业务页面统一登录，API 写操作要求同源和 JSON。内核 `flock` 拒绝同一数据目录的重复进程，异常退出自动释放。

服务首次启动自动建库并导入已有价格及资金费历史，不覆盖已有数据库。采集器与页面请求独立：海力士报价每 10 秒、原油报价按 `OIL_POLL_INTERVAL_SECONDS`、海力士小时历史每 60 秒、原油日线及两个市场的资金费每 5 分钟更新。历史更新从数据库接续并回补缺口，报价按实际采集时间保存，历史按原始时段去重。页面接口只读库；断网或上游限流时立即返回已保存数据并标明过期，不等待外部接口。

首页按每次访问读取同一数据库，把报价卡片和迷你走势直接放进 HTML，并将已有价格历史交给图表初始化；不会缓存成构建时的固定行情。浏览器启动后再刷新接口，刷新失败保留首屏数据与原始时间。

Bybit / Binance 的原油和海力士报价共四组，每 15 秒独立采集并写入同一数据库，页面及首屏对比区只读库。合约使用 USDT 标记价；资金费按各腿实际结算周期换算，缺失时显示 `—`。升级会自动加入这四组采集任务，保留已有历史、配置和告警；无需新增 API 密钥。现有历史图表及告警仍对应 Hyperliquid。

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
