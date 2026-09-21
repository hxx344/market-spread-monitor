# 按金额校验盘口与计价币换算

盘口校验只在展开组合后由用户点击触发。它不发出订单，也不保存深度历史；列表依旧保持展开时的暂停状态。切换组合会清除上一个组合的校验结果，页面隐藏、模块关闭或组件卸载会取消浏览器等待。

输入金额为**做多腿的 USDT 名义本金**，不是保证金。按做多腿卖盘逐档消耗预算后，使用取得的同一标的数量匹配做空腿买盘。两腿只有都能完整覆盖数量，才返回盘口成交价差；不足时展示已覆盖金额及原因，不把部分成交视为完整套利。开仓价差损耗以百分点表示，是买卖一档价差与逐档成交价差的差值。

当前只估算公开盘口，不含下单步长、最小订单金额、价格保护、撤单变化、手续费和退出成交。现货汇率使用一档买卖价，未校验换汇深度；大额组合不可据此认定换汇一定能成交。返回的盘口总额仅代表已取档位，不能代表全市场容量。

## 数据源与单位

| 平台 | 盘口方式 | 公开档位 | 数量转换 |
| --- | --- | --- | --- |
| Binance | 按需 REST `/fapi/v1/depth` | 每侧 50 | 原始合约标的数量 × 币种乘数 |
| Bybit | 按需 REST `/v5/market/orderbook`，linear | 每侧 50 | 同上 |
| OKX | 按需 REST `/api/v5/market/books` | 每侧 50 | 合约张数 × 目录 `ctVal` × 币种乘数；仅支持确认的 linear、标准 `ctMult=1` |
| Bitget | 按需 REST `/api/v2/mix/market/merge-depth`，scale0 | 每侧 50 | 原始合约标的数量 × 币种乘数 |
| Gate | 按需 REST `/api/v4/futures/usdt/order_book` | 每侧 50 | 合约张数 × `quanto_multiplier` × 币种乘数 |
| Hyperliquid | 按需 REST `info`，`l2Book` | 官方每侧最多 20 | `sz` × 币种乘数 |
| Lighter | 单次 WS `order_book/{market_id}` 快照 | 每侧保留 50 | `size` × 币种乘数 |
| rh-Lighter | 独立部署的单次 WS 同名通道 | 每侧保留 50 | `size` × 币种乘数 |
| Aster | 按需 REST `/fapi/v1/depth` | 每侧 50 | 原始合约标的数量 × 币种乘数 |
| Entropy | 按需 REST Hyperliquid `info`，保留 `io:` 命名空间 | 官方每侧最多 20 | `sz`，独立的每股/合约标的单位 |

价格同时除以币种乘数，保证数量归一前后的名义价值相同。OKX/Gate 的单合约单位额外短缓存 5 分钟，最多 10 个；未知单位拒绝估算，不默认一张等于一币。Lighter 两个部署仅接受订阅全量快照，忽略增量帧，取得快照后立即断开连接，不维持额外行情订阅。它们的 REST 订单接口不提供可靠的快照源时间，因此没有用本地收包时间冒充源时间。

## 新鲜度与资源上限

- 源快照及本地接收时间都不得超过 10 秒，两腿源时间差不得超过 5 秒，未来来源时间最多容忍 5 秒。过期/时间未知/倒挂盘口不给完整成交结论。
- 盘口按合约共享，成功缓存 5 秒、失败缓存 10 秒；最多同时保留 10 个合约，30 秒未请求释放名额。无浏览器订阅时没有额外后台盘口采集。
- 盘口、合约单位与汇率查询共用预算：同时最多 2 个上游请求，每 500 毫秒最多启动一个、每分钟最多 60 次，待处理队列最多 12 个。HTTP/WS 单请求最多 8 秒。收到限流后统一退避，队列满立即返回原因。
- 不持久化盘口、汇率或模拟结果。内存使用由上述市场数、档位数和队列数限定。

## 稳定币汇率

`GET /api/monitors/perpetual/fx` 返回基准为 USDT 的买卖价快照。USDT=1 仅是计价单位定义；USDC、USD1、USDG 使用 Gate 公开现货 `币种_USDT` 盘口，并保留交易所快照时间、买价、卖价及来源 URL。USD 未接入可信直接盘口，明确缺失。缺失、倒挂、过期或无数量盘口不会用 1 补齐。

汇率按需刷新，60 秒共享缓存，最大有效期 180 秒。买入使用币种兑 USDT 的卖价，卖出使用买价，保留换汇买卖差。每条汇率独立判断新鲜度，不能用整包刷新时间替代。临时更新失败会沿用尚未过期的旧汇率，并保留旧源时间；超过有效期后排除。

## 接口与验证

`POST /api/monitors/perpetual/depth`：

```json
{"long":{"exchange":"binance","symbol":"BTCUSDT"},"short":{"exchange":"bybit","symbol":"BTCUSDT"},"notional":1000}
```

服务端只从当前行情目录解析已知平台、合约和标的，用户输入不能指定上游 URL。不同标的、同一交易所、已到下架时间、未知合约或非法金额会被拒绝。接口复用项目现有登录和同源 JSON 请求校验。

2026-09-21 对 10 家真实公开接口完成了小额名义本金的只读校验，确认 Lighter 两站 WS 快照、CEX 合约张数转换和 Hyperliquid/Entropy 20 档限制。单元测试覆盖等量匹配、部分成交、币种乘数、合约单位、汇率方向、新鲜度、错序增量帧、缓存合并、队列与市场数边界。真实接口结果会随流动性和上游可用性变化。

官方格式参考：[Bybit](https://bybit-exchange.github.io/docs/v5/market/orderbook)、[OKX](https://www.okx.com/docs-v5/en/)、[Gate 合约](https://www.gate.com/docs/developers/apiv4/en/futures/)、[Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot)、[Lighter](https://apidocs.lighter.xyz/docs/websocket-reference)、[Aster](https://asterdex.github.io/aster-api-website/futures/market-data/#order-book)。
