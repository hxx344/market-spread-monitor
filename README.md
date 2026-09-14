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

首次自动安装依赖与专用 Node.js、构建、生成登录密码、创建 SQLite 行情库、导入已有历史、注册 systemd 并启动采集。完成后访问 `http://服务器IP:3000`，使用终端显示的账号密码登录。再次执行同一命令即可升级，保留配置与数据库；新版启动失败时自动恢复原服务。

首页由服务器直接读取数据库并渲染已有报价与走势，首次打开即可看到已保存的数据，无需等浏览器启动后再取数。页面启动后继续刷新；旧数据保留原始采集时间，尚未采集到的报价显示为空。

升级会按变化执行：版本与配置未变、服务健康时直接结束；仅配置变化或服务停止时只恢复服务；普通代码更新会复用未变的依赖和 Next.js 构建缓存，再构建新代码。依赖清单、npm 配置或运行环境变化时才重新安装依赖。从旧安装器升级后，首次成功部署会建立这些复用记录。

新服务使用独立目录。如果同机已有原来的面板，指定空闲端口：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/market-spread-monitor/main/deploy/install.sh | bash -s -- --port 3001
```

在面板顶部的“统一飞书告警”中保存一次 Webhook 和可选签名密钥，原油、海力士及后续模块共用，立即生效，无需重启。各模块的阈值、开关、冷却和发送记录仍独立，默认关闭消息发送。连接测试也集中在统一设置中。

升级时自动迁移原海力士配置及 `OIL_FEISHU_WEBHOOK_URL` / `OIL_FEISHU_WEBHOOK_SECRET`。只有一个机器人或两处配置相同时直接沿用；不同则在统一设置中选择已有机器人或填写新机器人，保存前暂停发送。统一配置保存于数据目录的 `notifications.json`，不会向浏览器回传完整 Webhook 或密钥；清除后重启也不会重新导入旧配置。如机器人开启关键词校验，请添加“告警”，让两个模块的消息都能通过。

后台独立于浏览器运行：海力士每 10 秒检查，原油默认每 30 秒检查。各模块独立保存规则、修订号、回差、冷却、触发状态和发送记录。运行、HTTPS 与已有配置迁移见 [部署说明](deploy/README.md)。

Linux 服务持续采集并写入 `ALERT_DATA_DIR/market.sqlite`：海力士报价每 10 秒、原油报价默认每 30 秒、海力士小时价格历史每 60 秒、原油日线与两类已结算资金费每 5 分钟。首次导入仓库中的真实历史，之后从数据库接续增量更新并回补缺口；行情快照和逐条观测在同一事务内保存。页面只读取已保存的数据，打开、刷新和切换页面都不会调用交易所。没有任何页面打开时也会继续采集，进程重启后立即可读上次记录。

采集失败保留数据及原采集时间，并标记过期；告警只使用成功落盘且未过期的报价。数据库存储失败会使健康检查降级并暂停告警。数据库位于版本目录之外，升级和回滚不会重建已有数据，不需要安装独立数据库服务。

## 本地运行

Node.js 24，使用仓库内 npm 锁文件：

```bash
npm ci
npm run dev
```

开发地址默认 `http://localhost:5173`。开发模式和 Sites 网页版提供行情、图表及指标，仍按请求获取行情；常驻采集、数据库持久化和告警需要运行 Linux 服务。没有后台时页面明确显示未连接，不模拟已保存或已发送。

Windows 本地验证完整后台：复制 `.env.linux.example` 为 `.env.linux`，将 `ALERT_DATA_DIR` 改为 `./runtime-data`，填写至少 12 字符的 `APP_PASSWORD`，然后：

```powershell
npm run build:linux
npm run start:windows
```

正常退出使用 Ctrl+C。Windows 强制结束后若提示锁定，先确认没有其他实例，再清理该数据目录下的 `oil/monitor.lock`。Linux 使用内核锁，崩溃退出会自动释放。

## 扩展接口

- `GET /api/monitors`：`schemaVersion: 1` 和模块清单。
- `GET /api/monitors/{id}/quote`：Linux 返回数据库最新报价及 `collection` 采集状态，过期数据标记 `status: "snapshot"`，从未收到数据时返回 503；网页预览的实时获取失败仍返回 503。
- `GET /api/monitors/{id}/history`：历史与采集时间，失败保留真实快照并标明状态。
- `GET /api/monitors/{id}/exchanges/{exchange}/quote`：Bybit / Binance 实时报价及每腿资金费率、结算周期和下次结算时间；`exchange` 为 `bybit` 或 `binance`。Linux 只读数据库，首次无数据返回 503，更新失败保留上次报价并标明过期。
- `GET /api/monitors/oil/funding`：原油已结算资金费历史。
- Linux 专用告警接口按模块 ID 隔离。

主要接入点：`lib/monitors.ts`（描述）、`lib/monitor-service.ts`（数据）、`app/monitor-hub.tsx`（面板）、`server/monitor-services.mjs`（可选后台）。新增市场可以复用公共 HTTP 层，详见 [扩展指南](docs/EXTENDING.md)。

## 数据与历史更新

使用 Hyperliquid / XYZ、Bybit、Binance 公共行情，不需要钱包或交易 API 密钥。

- 交易所实时对比区并列显示价差、溢价率、做空及做多价差的当前预估年化资金费。Bybit / Binance 每 15 秒更新；原油两腿为 `BZUSDT / CLUSDT`，海力士为 `SKHYUSDT / SKHYNIXUSDT`。后两家的合约报价均为 USDT 标记价，正股接口已完成换汇；Hyperliquid 单独标注 USD，海力士沿用中间价。只比较各交易所内部两腿，不把 USD 和 USDT 假定为严格等值。
- 对比区原油使用等桶数，海力士使用 10 份 ADR 对 1 股正股。做空价差年化为 `(空腿数量 × 计费价格 × 周期费率 / 周期小时 − 多腿数量 × 计费价格 × 周期费率 / 周期小时) / 两腿总名义 × 8760`；做多为相反数。Bybit / Binance 的计费价格为标记价，Hyperliquid 为预言机价。每条腿分别读取当前结算周期，不固定为 8 小时；费率、周期或结算时间缺失时保留价格、年化显示 `—`，真实零费率显示零。当前费率可能在结算前变化。
- 本次新增实时并列对比；已有历史图表及告警仍对应 Hyperliquid。Linux 常驻采集会保存四组新报价，并将已有报价直接带入首屏；某一家暂不可用不影响其他交易所。

- 原油为 `xyz:BRENTOIL − xyz:CL`。WTI 界面名为 WTIOIL。当前价差用 `markPx`，资金费现金流用 `oraclePx`，费率是每小时小数率。价格历史为共同 UTC 已收盘日 K。历史净资金费采用等预言机美元名义、两腿总敞口作分母；日度值为实际共同小时的平均，不补零。
- 原油历史面板同时显示做多、做空价差的区间累计资金费及累计年化，并可切换累计年化曲线和日均小时费率。按上方所选日期区间纳入全部共同结算小时（即使某日缺少价格 K 线），年化为净小时费率之和除以有效小时数再乘 `8760`，不复利；切换近 1 月、近 3 月、今年以来会从新区间起点重新累计。缺口不补零，并显示已覆盖及缺失小时数。
- 海力士价差为 `xyz:SKHY − xyz:SKHX / 10`，溢价率为 `(SKHY / (SKHX / 10) − 1) × 100%`。实时使用一次 `allMids` 返回的两侧报价，历史使用已完成共同小时。SKHX 已是美元价格，不二次换汇。
- 海力士卡片净资金费按空 10 份 ADR、多 1 股正股计算。设两腿预言机价格为 `P_ADR`、`P_正股`，小时资金费率为 `r_ADR`、`r_正股`，年化率为 `(10 × P_ADR × r_ADR − P_正股 × r_正股) / (10 × P_ADR + P_正股) × 24 × 365`，界面显示百分比，正值表示净收取。数据来自 `metaAndAssetCtxs`，不含杠杆、手续费或价差变化；资金费获取失败显示 `—`，正常报价和溢价告警继续工作。
- 海力士历史资金费采用与原油历史图一致的**两腿等名义金额**口径：做空价差为空 ADR、多正股，每个已结算小时净率为 `(r_ADR − r_正股) / 2`，做多为相反数。历史接口没有结算时的预言机价格，因此这与顶部固定 10:1 配仓的当前预估年化口径不同。历史面板提供小时费率、累计资金费和累计年化三种曲线；累计为所选区间有效小时之和，年化为该和除以有效小时数再乘 `8760`，不复利。缺口断线、不补零，同时显示覆盖小时数；累计值仅包含已覆盖部分。
- 历史资金费通过 `/api/monitors/hynix/funding` 获取，每 5 分钟检查并增量回补缺口。`data/hynix-funding.json` 保存真实备用记录，更新失败保留最近成功数据及原获取时间；初始范围从 2026-07-10 15:00 UTC 结算开始，对应现有价差图首个完整价格小时结束。维护归档可运行 `node --experimental-strip-types scripts/archive-hynix-funding.mjs`。
- 保留原仓库的真实快照和边界：原油历史范围目前为 2026 年；海力士自上市后的首个完整小时开始。缺失数据保留断点。

来源及原始计算说明：[原油来源版本](https://github.com/hxx344/oil-spread-monitor/tree/5c5cdb5bc5fd641de388452bece9336ec58cb895)、[海力士来源版本](https://github.com/hxx344/hynix-spread-monitor/tree/798148fa3224a40aa2121b374a22d1ced148d9ba)。两个原仓库保持独立。

```bash
npm run data:archive  # 更新海力士小时档案
npm run data:oil      # 更新原油价格和资金费快照
```

这些命令更新的是源码备用档案，更新后需要提交并重新部署。Linux 常驻采集会自动把新历史保存在数据库，无需定期更新源码档案；网页预览仍使用源码档案和运行期缓存。扩展原油跨年历史需同步调整原有年份校验和快照范围。

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
