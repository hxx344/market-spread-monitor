# Market Monitor · 市场价差监控

合并原油与海力士监控面板，保留完整图表、计算口径和后台告警。通过模块注册表、数据适配器和后台服务接口扩展新市场。

| 模块 | 保留能力 |
| --- | --- |
| 原油 | 布伦特 / WTI 标记价与价差、已收盘日 K、日期筛选、月均值、历史多空资金费、等桶数 / 等名义资金费预估、价格与价差多档告警 |
| 海力士 | 正股 / ADR 同口径美元价格、实时溢价、小时历史、SMA / 布林带 / Z-score、双向多档告警 |
| 公共功能 | 单一登录和导航、手机布局、切换保留图表及规则草稿、独立配置与数据、接口版本、后台状态检查 |

## Linux 一键部署和升级

Ubuntu 22.04 / 24.04、Debian 12 / 13，支持 x86_64 和 ARM64：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash
```

自动安装依赖与专用 Node.js、构建、生成登录密码、注册 systemd 并启动。完成后访问 `http://服务器IP:3000`，使用终端显示的账号密码登录。再次执行同一命令即可升级，保留配置与数据；新版启动失败时自动恢复原服务。

新服务使用独立目录。如果同机已有原来的面板，指定空闲端口：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash -s -- --port 3001
```

海力士飞书机器人在面板配置。原油沿用服务器配置方式，在 `/etc/market-spread-monitor.env` 设置 `OIL_FEISHU_WEBHOOK_URL` 与可选 `OIL_FEISHU_WEBHOOK_SECRET`，再运行 `sudo systemctl restart market-spread-monitor`。两边阈值都在各自面板编辑，默认关闭消息发送。

后台独立于浏览器运行：海力士每 10 秒检查，原油默认每 30 秒检查。各模块独立保存规则、修订号、回差、冷却、触发状态和发送记录。运行、HTTPS 与已有配置迁移见 [部署说明](deploy/README.md)。

## 本地运行

Node.js 24，使用仓库内 npm 锁文件：

```bash
npm ci
npm run dev
```

开发地址默认 `http://localhost:5173`。开发模式和 Sites 网页版提供行情、图表及指标；常驻告警需要 Linux 服务。没有后台时页面明确显示未连接，不模拟已保存或已发送。

Windows 本地验证完整后台：复制 `.env.linux.example` 为 `.env.linux`，将 `ALERT_DATA_DIR` 改为 `./runtime-data`，填写至少 12 字符的 `APP_PASSWORD`，然后：

```powershell
npm run build:linux
npm run start:windows
```

正常退出使用 Ctrl+C。Windows 强制结束后若提示锁定，先确认没有其他实例，再清理该数据目录下的 `oil/monitor.lock`。Linux 使用内核锁，崩溃退出会自动释放。

## 扩展接口

- `GET /api/monitors`：`schemaVersion: 1` 和模块清单。
- `GET /api/monitors/{id}/quote`：当前报价，失败返回 503，不用历史冒充实时。
- `GET /api/monitors/{id}/history`：历史与采集时间，失败保留真实快照并标明状态。
- `GET /api/monitors/oil/funding`：原油已结算资金费历史。
- Linux 专用告警接口按模块 ID 隔离。

主要接入点：`lib/monitors.ts`（描述）、`lib/monitor-service.ts`（数据）、`app/monitor-hub.tsx`（面板）、`server/monitor-services.mjs`（可选后台）。新增市场可以复用公共 HTTP 层，详见 [扩展指南](docs/EXTENDING.md)。

## 数据与历史更新

只使用 Hyperliquid / XYZ 公共行情，不需要钱包或交易 API 密钥。

- 原油为 `xyz:BRENTOIL − xyz:CL`。WTI 界面名为 WTIOIL。当前价差用 `markPx`，资金费现金流用 `oraclePx`，费率是每小时小数率。价格历史为共同 UTC 已收盘日 K。历史净资金费采用等预言机美元名义、两腿总敞口作分母；日度值为实际共同小时的平均，不补零。
- 海力士价差为 `xyz:SKHY − xyz:SKHX / 10`，溢价率为 `(SKHY / (SKHX / 10) − 1) × 100%`。实时使用一次 `allMids` 返回的两侧报价，历史使用已完成共同小时。SKHX 已是美元价格，不二次换汇。
- 保留原仓库的真实快照和边界：原油历史范围目前为 2026 年；海力士自上市后的首个完整小时开始。缺失数据保留断点。

来源及原始计算说明：[原油来源版本](https://github.com/hxx344/oil-spread-monitor/tree/5c5cdb5bc5fd641de388452bece9336ec58cb895)、[海力士来源版本](https://github.com/hxx344/hynix-spread-monitor/tree/798148fa3224a40aa2121b374a22d1ced148d9ba)。两个原仓库保持独立。

```bash
npm run data:archive  # 更新海力士小时档案
npm run data:oil      # 更新原油价格和资金费快照
```

快照更新后需要提交并重新部署。运行期历史缓存不自动写回源码；Hyperliquid 每周期保留最近 5,000 根 K 线，长期使用应定期更新档案。扩展原油跨年历史需同步调整原有年份校验和快照范围。

## 验证

```bash
npm test
npm run typecheck
npm run build:linux
node tests/linux-smoke.mjs
npm run build
```

GitHub Actions 检查计算、告警、认证、缓存隔离、配置重启保留、Linux 内核锁、一键安装升级与失败回滚。通知测试使用模拟接收端，不向真实飞书群发送。

可选 WebMCP 工具 `select_market_monitor` 使用同一导航状态；普通浏览器不依赖该能力。
