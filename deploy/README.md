# Linux 部署

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash
```

支持 Ubuntu 22.04 / 24.04、Debian 12 / 13，x86_64 / ARM64，要求 systemd 正在运行。脚本通过 sudo 提权或以 root 执行；安装专用 Node.js 24.15.0 并校验下载包。重复执行即升级；新版构建、登录及两个后台检查通过后完成切换，失败恢复旧版本。

| 内容 | 路径或名称 |
| --- | --- |
| 服务 | `market-spread-monitor.service` |
| 系统用户 | `spread-monitor` |
| 当前版本 | `/opt/market-spread-monitor/current` |
| 历史版本 | `/opt/market-spread-monitor/releases` |
| 配置 | `/etc/market-spread-monitor.env`，权限 0600 |
| 海力士状态 | `/var/lib/market-spread-monitor/hynix/alerts.json` |
| 原油状态 | `/var/lib/market-spread-monitor/oil/monitor.json` |
| 单实例锁 | `/var/lib/market-spread-monitor/instance.lock` |

首次生成登录密码，用户名默认 `admin`。端口默认 3000，首次安装可传 `--port 3001`；已有配置始终保留，后续修改配置后重启：

```bash
sudo systemctl status market-spread-monitor
sudo journalctl -u market-spread-monitor -n 50
sudo systemctl restart market-spread-monitor
```

海力士 Webhook 与签名密钥在面板保存，读取 API 不返回密钥。原油在环境配置文件填写 `OIL_FEISHU_WEBHOOK_URL`、可选 `OIL_FEISHU_WEBHOOK_SECRET`；`OIL_POLL_INTERVAL_SECONDS` 默认 30，范围 10–3600。重启后在面板启用所需阈值和总开关。网页关闭后后台继续工作。

`GET /healthz` 检查进程与存储健康；外部行情临时失败在各面板单独显示。业务页面统一登录，API 写操作要求同源和 JSON。内核 `flock` 拒绝同一数据目录的重复进程，异常退出自动释放。

HTTPS 反向代理可将 `HOST=127.0.0.1`，参考 [nginx 配置](nginx.conf.example)。保留 Host 和 Authorization，让网页与 API 同源。

## 迁移旧配置

安装器不会读取或修改旧项目。先部署新项目，再停止新旧后台并备份数据；确认不需要旧服务继续发通知后，复制对应文件：

| 旧文件 | 新位置 |
| --- | --- |
| 海力士数据目录的 `alerts.json` | 新 `ALERT_DATA_DIR/hynix/alerts.json` |
| 原油数据目录的 `monitor.json` | 新 `ALERT_DATA_DIR/oil/monitor.json` |

原油环境变量 `FEISHU_WEBHOOK_URL` / `FEISHU_WEBHOOK_SECRET` 改为 `OIL_FEISHU_WEBHOOK_URL` / `OIL_FEISHU_WEBHOOK_SECRET` 并保留原值。不要复制旧锁文件。新数据目录所有者为 `spread-monitor:spread-monitor`，目录和文件权限分别保持 0700 / 0600，再启动新服务。统一登录取代原油 `ADMIN_TOKEN`。

状态文件的原数据格式、revision 和触发状态保持兼容。备份需同时保存环境配置与完整 `ALERT_DATA_DIR`；恢复与迁移都在服务停止时进行。
