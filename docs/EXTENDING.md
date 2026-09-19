# 扩展监控模块

模块以稳定 ID 标识。`oil` 和 `hynix` 共用登录、HTTP 服务和导航，各自保存价格口径、图表与状态文件。界面不使用 iframe；原油原生图表挂在 ShadowRoot 内，隔离 DOM ID 和 CSS。

## 描述与界面

1. 在 `lib/monitors.ts` 增加 `MonitorDefinition`，声明稳定英文 `id`、中文名称、分类、颜色、报价间隔和 capabilities。
2. 创建 React 面板，在 `app/monitor-hub.tsx` 的 `panels` 注册。导航从描述列表自动生成。
3. 调用模块自己的 API 前缀。Tab 切换保留挂载状态及未保存草稿；卸载时取消请求、定时器、观察器和全局监听。生命周期示例见 `modules/oil/lifecycle.mjs`。

## 数据适配器

在 `lib/monitor-service.ts` 的 `dataAdapters` 注册：

```ts
interface DataAdapter {
  quote: () => Promise<unknown>;
  history: () => Promise<unknown>;
  funding?: () => Promise<unknown>;
}
```

网页预览的 `GET /api/monitors/{id}/{action}` 路由至此适配器，capabilities 只声明已实现的能力。Linux 服务中的同名接口由常驻后台截获并只读 SQLite。新增 quote/history/funding 以外的能力时，同步扩展接口允许列表；不能按用户输入动态加载文件。

缓存按 `id/action` 隔离并合并并发请求：实时报价 5 秒、历史 60 秒、资金费 5 分钟、快照回退 15 秒。失败在下次调用重试，不把旧报价重新标记为实时。

历史应包含 `status: "live" | "snapshot"`。保留真实采集时间及业务数据形状，由专用面板解析，避免混合单位。

| ID / action | 关键字段 |
| --- | --- |
| `hynix/quote` | `ordinary, adr, equivalent, spread, premium, fetchedAt` |
| `hynix/history` | `points, fetchedAt, status, interval, firstAvailable, warnings` |
| `hynix/funding` | `rows, metadata, status, error?`；每行 `time, adr, ordinary` 为已结算小时费率，缺腿为 `null` |
| `oil/quote` | `brent, wti, fetchedAt`，每腿含 `markPx, oraclePx, funding` |
| `oil/history` | `data, market, metadata, status` |
| `oil/funding` | `data, metadata, status`，UTC 小时资金费 |
| `perpetual/quote` | `schemaVersion, generatedAt, staleAfterMs, exchanges, quotes`；价格逐字段保留原更新时间，前端按模式过滤过期报价 |

网页预览的实时失败抛错并返回 503。Linux 可返回已保存报价，必须附带 `status: "snapshot"` 和 `collection.stale: true`，没有记录才返回 503。采集时间永不因读取而更新，过期报价不能用于告警。历史回退保留原来源与采集时间，前端明确提示。不能补零、用今日价格生成旧历史，或将采集时间当作交易所未提供的行情时间。

原油与海力士面板均通过统一接口取数，不在浏览器内直接调用交易所。Linux 后台的数据验证集中在 `lib/market-validation.ts`；在 `server/market-store.mjs` 注册数据集，在 `server/market-collector.mjs` 增加周期、采集函数与初始历史。采集函数接收数据库上次成功快照，需保留旧历史并合并补全记录；不得从页面 GET 触发采集或改写数据库。

`market_datasets` 保存最新完整快照、源采集时间、最近尝试、成功和错误；`market_observations` 按数据集和原始时间保存逐条记录。两表同事务写入，重复导入不覆盖已保存数据。结构版本由 `PRAGMA user_version` 管理，后续变更应追加可兼容迁移，拒绝未知版本。数据库只位于 `ALERT_DATA_DIR/market.sqlite`，不写回源码。

## 统一告警编辑器

所有监控的飞书梯度设置固定放在市场选择卡片下方、行情详情上方，由 `app/monitor-hub.tsx` 渲染 `app/alert-settings.tsx`。各模块不得再在自身页面或 Shadow DOM 中创建单独的告警表单和样式。

新增告警模块时，在描述符的 `capabilities` 中声明 `alerts`，并在 `lib/monitor-alerts.ts` 的 `monitorAlertAdapters` 注册同 ID 的 `MonitorAlertAdapter`。适配器提供指标及单位、字段限制、默认规则，以及 `load` / `save`；公共组件自动处理固定位置、布局、草稿、版本冲突、反馈和发送记录。

每档统一按“名称、指标、方向、阈值、冷却（分钟）、回差”展示，带独立启用与删除按钮。阈值和回差使用指标自己的单位，例如海力士为 `%` / `百分点`，原油为 `美元/桶`。冷却是两次成功提醒的最短间隔；回差是允许再次触发前需要退离阈值的幅度。持续满足条件不会按冷却周期重复发送。

适配器保留原规则 ID 和后端语义，只转换编辑格式。海力士旧配置仍保留全局 `cooldownSeconds` / `hysteresis`；每条规则可选覆盖同名字段，缺省继承全局值。前端统一显示分钟，保存时精确转换为整数秒，不静默舍入。升级不主动迁移旧文件；采用每档覆盖后，降级到不支持该字段的旧版本会丢失覆盖值。

`save` 只负责提交并返回后台规范化后的配置与 revision，不依赖后续状态刷新才能判定成功。`load` 返回可用性、配置、采集与发送错误和历史事件；网页行情版应先检查可用性，不请求不存在的 Linux 配置接口。原油历史使用事件自身的指标、方向和阈值，不按当前规则或事件 UUID 反推。

切换监控仅隐藏公共编辑器，保留展开状态和未保存草稿。后台轮询不能覆盖草稿；较旧或保存前发出的请求不能覆盖刚保存的配置；主动放弃修改必须重新读取后台。新适配器需要验证这些约束，并保证通过 HTTP 部署时也能添加规则。

## 常驻后台适配器

在 `server/monitor-services.mjs` 增加同 ID 服务：

```js
{
  start() {},                 // 非阻塞启动独立调度
  async stop() {},            // 停止调度，等待在途操作及落盘
  healthy() { return true; }, // 存储健康；行情失败另行报告
  actions: { alerts: ["GET", "PUT"], "alerts/test": ["POST"] },
  async handle(action, method, input) { /* 返回 JSON 可序列化结果 */ }
}
```

公共 `server/http.mjs` 负责统一登录、同源保护、请求体大小、JSON 检查、方法校验和错误状态码。只分发显式声明的 action，未知 ID 不可访问；配置版本冲突使用 `error.status = 409`。

合约行情适配器位于 `modules/perpetual/`，每个平台实现合约发现、WS 订阅和消息解析；`server/perpetual-service.mjs` 负责连接分片、心跳、退避重连、逐字段时间及合并广播。稀疏 ticker 更新必须只提供本次实际出现的字段，不能把缓存盘口作为本次新价格返回。计价币与抵押币独立，不能凭相同简称或强行剥离前缀认定两个合约等价。

`perpetual` 使用专属最新报价库 `ALERT_DATA_DIR/perpetual/market.sqlite`，不积累每秒全市场历史。新建只读流接口需要显式声明 `actions.stream` 和 `stream(request,response)`，公共层先完成登录和方法验证；服务须提供 `closeStreams()`，停机时在等待 HTTP 排空前关闭长连接，并清理慢客户端缓冲。

每个模块使用 `ALERT_DATA_DIR/{id}` 保存告警状态，维护独立数据版本、revision 和原子写入；行情由共享的 `services.market` 管理 SQLite 与独立采集调度。报价落盘后触发告警检查，告警也继续定时检查，均只使用库中未过期报价。持久化失败不得继续无限重发通知；不要读写其他模块状态。初始化失败释放已取得资源，关闭时先排空 HTTP，再停止告警、采集并关闭数据库和通知服务。

| Linux 专用接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/monitors/hynix/alerts` | GET / PUT | 状态与配置；PUT 为原有 AlertConfig + revision |
| `/api/monitors/hynix/alerts/test` | POST | 主动发测试消息 |
| `/api/monitors/oil/status` | GET | 采集、过期、通知及存储状态 |
| `/api/monitors/oil/config` | GET / PUT | PUT 为 `{ revision, config }` |
| `/api/monitors/oil/events` | GET | 最近发送记录 |
| `/api/monitors/oil/test-notification` | POST | 主动发测试消息 |

Sites 没有常驻文件后台，告警状态返回 `available: false`。托管告警需要实现调度与持久化，不能只修改该标志。

## 验证

为新增计算与时序提供实际基准及异常数据测试，验证一个模块失败不影响其他模块、缓存和配置不串用。通知测试使用假发送器。完成类型检查、两种构建和 `tests/linux-smoke.mjs`；部署有变更时通过 CI 安装升级测试。
