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

`GET /api/monitors/{id}/{action}` 路由至适配器，capabilities 只声明已实现的能力。新增 quote/history/funding 以外的能力时，同步扩展接口允许列表；不能按用户输入动态加载文件。

缓存按 `id/action` 隔离并合并并发请求：实时报价 5 秒、历史 60 秒、资金费 5 分钟、快照回退 15 秒。失败在下次调用重试，不把旧报价重新标记为实时。

历史应包含 `status: "live" | "snapshot"`。保留真实采集时间及业务数据形状，由专用面板解析，避免混合单位。

| ID / action | 关键字段 |
| --- | --- |
| `hynix/quote` | `ordinary, adr, equivalent, spread, premium, fetchedAt` |
| `hynix/history` | `points, fetchedAt, status, interval, firstAvailable, warnings` |
| `oil/quote` | `brent, wti, fetchedAt`，每腿含 `markPx, oraclePx, funding` |
| `oil/history` | `data, market, metadata, status` |
| `oil/funding` | `data, metadata, status`，UTC 小时资金费 |

实时失败必须抛错，由接口返回 503。历史才可回退到有来源与采集时间的快照，前端明确提示。不能补零、用今日价格生成旧历史，或将采集时间当作交易所未提供的行情时间。

原油面板保留原始公共数据请求和增量资金费缓存；统一接口同时供后续集成使用。海力士面板通过统一接口取数。

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

每个模块使用 `ALERT_DATA_DIR/{id}`，维护独立数据版本、revision 和原子写入。持久化失败不得继续无限重发通知；不要读写其他模块状态。初始化失败释放已取得资源，关闭时先排空 HTTP，再停止后台。

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
