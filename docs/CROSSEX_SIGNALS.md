# CrossEx 七所模拟联动（v2）

新增 `GET /api/monitors/perpetual/opportunities-v2`，沿用 Monitor 登录认证，只读现有行情和汇率缓存，不在读取信号时访问交易所。旧 `opportunities` v1 接口的协议及支持范围保持不变，也遵守下面的可选推送筛选。请先升级 Monitor，再升级 CrossEx。

## 可选的双边现货与充提筛选

在合约价差的“发现机会 → CrossEx 推送筛选”勾选“仅推送双边有现货且共同网络充提正常的机会”，即保存到服务器。默认关闭，升级保留原有行为；开启后即使页面关闭，CrossEx 后台拉取也会应用此规则。此设置不改变 Monitor 行情列表的本地筛选。

在合约价差的“价差排名”“全部报价”及展开的各平台报价中，点击币种旁的“屏蔽并隐藏”，保存后隐藏该币种所有行情行，并停止新机会推送。页面上方“CrossEx 推送筛选”保留完整名单，可输入基础币种（如 `BTC`）添加或逐个解除；解除后按当前筛选重新显示。所有入口共享一次设置轮询及保存锁，保存中禁用修改，服务器确认后更新状态；失败或配置冲突会显示原因并重新读取实际配置，待添加文本保留。

页面在分页和统计前排除已屏蔽币种，搜索、自选及重置本地筛选不会绕过名单。名单内容变化时收起暂停详情并恢复实时行情；普通设置轮询、充提开关变更不收起详情。首次读取名单前暂不展示机会，避免刷新时短暂出现已屏蔽币种。该展示过滤不修改后台行情、已有持仓或独立手动配对的数据。

名单最多 200 个，自动去除首尾空白、转大写、去重排序，按行情 `base` 精确匹配，不把 `BTCUSDT` 猜成 `BTC`。屏蔽覆盖该币种所有交易所及多空方向，独立于现货充提开关生效；保存后关闭页面或重启服务仍保留。仅屏蔽币种不会启动充提轮询，更新名单也不会清除已有充提资料。

两边交易所都必须有该基础币可买卖的现货，且至少有一条共同网络在双方都明确开放充值和提现；代币合约地址须相同。EVM 地址忽略大小写，其他地址严格匹配；仅对明确列出的原生币和网络允许双方空地址，不猜测未知链别名。单向充提、延迟提现、下架、未知状态、地址不匹配和过期资料都排除。现货交易对不要求与合约使用相同计价币。

公开数据覆盖于 2026-09-23 核对：

| 平台 | 已接入证据与处理 |
| --- | --- |
| Binance | [现货 exchangeInfo](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general) 确认可交易现货；[公开充提状态](https://www.binance.com/en/network) 使用 `bapi/capital/v1/public/capital/getNetworkCoinAll` 的币种与链级开放/隐藏/繁忙状态、合约地址。网站接口可能变化，响应异常时停止通过该平台资格。 |
| Gate | [Spot API](https://www.gate.com/docs/developers/apiv4/en/spot/) 的 `spot/currency_pairs` 和 `spot/currencies`，分别核实现货可交易、币种与各链的充提状态和合约地址。 |
| Bybit / OKX | [Bybit coin-info](https://bybit-exchange.github.io/docs/v5/asset/coin-info) 和 [OKX currencies](https://www.okx.com/docs-v5/en/#funding-account-rest-api-get-currencies) 正式接口需要凭据。本功能仅使用公开数据，目前显示无法核验，开启筛选后排除。 |
| Kraken / Hyperliquid / Lighter | 当前未接入能够同时证明对应现货、共同网络与双向充提正常的公开证据，开启筛选后排除；不把资产可交易或 USDC 桥可用当成基础币可充提。 |

只有开启开关才启动独立后台采集：每 60 秒批量读取两个已支持平台，最多 4 个公开请求并行，无逐机会查询。核对时间取各请求开始时间的最早值，并扣除 HTTP `Age`；这是成功读取状态的时间，不是交易所最近一次修改开关的时间。资料超过 180 秒失效；请求失败立即暂停该平台资格，不更新旧成功时间，启动后重新核验。关闭开关会停止轮询并清除资格缓存。

`GET/PUT /api/monitors/perpetual/crossex-settings` 沿用 Monitor 认证及同源写入保护；PUT 接收 `{ revision, config: { requireSpotTransfer: boolean, blockedBases: string[] } }`，配置版本冲突返回 409。旧配置文件缺少 `blockedBases` 时默认空名单；旧客户端 PUT 缺少该字段时保留当前名单，显式 `[]` 才清空。配置以原子写入保存在现有数据目录的 `perpetual/crossex-settings.json`，升级保留，不保存交易所凭据。无常驻后台的网页预览显示不可保存。

两项规则都只过滤 `signals`，在 200 条上限之前应用；`quotes` 全部保留给 CrossEx 既有持仓估值和退出。仅在启用充提筛选且验证通过时，v2 信号附带 `spotTransfer: { networks, checkedAt, expiresAt }`，信号到期时间不晚于充提证据、盘口或汇率的任一到期时间；单独使用币种屏蔽不产生充提已验证标志。设置和元数据变更、资格到期都会使投影缓存失效，机会接口本身不发起交易所请求。v2 的 `crossexFilter` 返回 `requireSpotTransfer`、`blockedBases` 与本次被过滤的候选数量。

支持 Binance、Bybit、OKX、Gate、Kraken、Hyperliquid、Lighter，排除 Deribit。每腿必须是单位为 1 的普通加密永续，当前目录提供身份资料，且没有下架标志。非 Binance 合约另需同基础币 Binance COIN 资料；已知简称冲突、未知分类、盘前、倍数合约不进入 v2。Gate EDGE 与 Lighter AI 继续隔离。

v2 延续下面 v1 的 envelope、quotes / signals 分离、5000 / 200 容量和方向键，`schemaVersion: 2`，另附 `fx: { baseCurrency: "USDT", generatedAt, staleAfterMs: 180000, rates, reasons }`。报价增加 `rawBase`、`settlementCurrency`、`collateralCurrency`、`contractKind`、`counterCurrency`、`crossexSymbol`，Lighter 另有 `marketId`。字段来自当前目录，任何身份变化或缺失撤销资格，不改变价格时间。

| 平台 | 报价 / 结算 | 原生合约示例 |
| --- | --- | --- |
| Binance | USDT 或 USDC / 同币 | BTCUSDT、BTCUSDC |
| Bybit | USDT 或 USDC / 同币 | BTCUSDT、BTCPERP |
| OKX | USDT 或 USDC / 同币 | BTC-USDT-SWAP |
| Gate | USDT / USDT | BTC_USDT |
| Kraken | USD / USD，MULTI 保证金 | PF_XBTUSD，基础币 BTC |
| Hyperliquid | 通常 USDT / USDC（quanto）；HYPE、PURR 为 USDC / USDC | BTC |
| Lighter | USDC / USDC | BTC + 当前 market_id |

`signal.quoteCurrency: "USDT"` 仅表示展示基准。腿上的 `bid`、`ask`、币种保持原值，信号另有 `referenceBuyPrice` / `referenceSellPrice`。买入报价按对应汇率 ask、卖出按 bid 换算后排序；即使两腿都是 USDC，也保留换汇买卖差。报价币和结算币所需汇率都必须有效，尤其不能因 Hyperliquid 的报价为 USDT 而跳过 USDC 结算汇率。

USDC 使用 Gate USDC/USDT，USD 使用 Kraken USDT/USD：`USD.bid = 1 / USDTUSD.ask`，`USD.ask = 1 / USDTUSD.bid`。保留交易所源时间，后台每分钟刷新共享缓存；单币缺失或过期只排除依赖它的信号，失败保留旧时间，倒退的新时间拒绝。USDT=1 只是基准定义。

两腿各自有效期 10 秒，时间差最多 5 秒；v2 额外将未来时间容差收紧至 1 秒。信号过期时间取盘口与所需汇率的最早到期；ID 包含身份、盘口、所需非 USDT 汇率与其源时间，单纯响应刷新不会变更 ID。服务储存异常时暂停信号。估值端仍须检查 quotes 的时效、身份和状态。

CrossEx 使用独立公共深度复核模拟开平仓，按原生结算币损益换算为 USDT，不假设 USD / USDC 等于 USDT，不提供外汇对冲或换汇深度验证。价差页面的原有“平仓与跟踪”仍限定 USDT 线性合约；跨币开平仓使用独立 CrossEx 模块，未扩大原功能的损益模型。

来源：[Gate CrossEx](https://www.gate.com/docs/developers/crossex/zh_CN/)、[Kraken instruments](https://docs.kraken.com/api/docs/futures-api/trading/get-instruments/)、[Hyperliquid contract specifications](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications)。

---

## v1 兼容接口（以下范围不变）

# CrossEx 模拟机会接口

`GET /api/monitors/perpetual/opportunities` 为独立 CrossEx 模拟工作台提供只读信号，沿用常驻后台的 Basic 登录保护。未登录返回 401，非 GET 方法返回 405；成功响应为 HTTP 200，`Cache-Control: no-store`。接口不接受交易所密钥，不发单，也不改变现有监控、提醒或持仓策略。

每次请求仅投影内存中的共享永续快照，不增加交易所请求、轮询、行情历史或文件写入。Windows 完整后台与 Linux 部署使用同一实现；Next 网页预览没有常驻行情时返回下述同一契约，`status: "unavailable"`、`errorCode: "NO_RESIDENT_FEED"`，两组数据为空。

## 响应契约

```ts
{
  schemaVersion: 1,
  mode: "paper",
  source: "market-monitor",
  monitorId: "perpetual",
  generatedAt: number, // 响应生成时间，epoch ms，不代表盘口时间
  status: "live" | "partial" | "snapshot" | "connecting" | "unavailable",
  staleAfterMs: 10000,
  exchanges: PerpetualExchange[], // 原快照的平台元数据
  quotes: PerpetualQuote[],       // 全部受支持的原始报价，最多 5000
  signals: [{                    // 最多 200 条，毛价差从高到低
    id: string,                  // 64 位小写十六进制 SHA-256
    pairKey: string,             // JSON.stringify([base, long.exchange+":"+long.symbol, short.exchange+":"+short.symbol])
    base: string,
    quoteCurrency: "USDT",
    long: PerpetualQuote,
    short: PerpetualQuote,
    grossSpreadPercent: number,
    observedAt: number,          // 两腿最早的独立盘口时间
    expiresAt: number            // observedAt + 10000
  }],
  errorCode?: "NO_RESIDENT_FEED" | "QUOTE_LIMIT_EXCEEDED" | "DUPLICATE_QUOTES",
  error?: string
}
```

类型定义位于 `lib/perpetual-opportunities.ts` 与 `lib/perpetual-types.ts`。正常响应的 `status` 沿用源快照；它反映全平台采集状态，不保证一定存在可用信号。报价超过 5000 条时返回 `status: "unavailable"`、`errorCode: "QUOTE_LIMIT_EXCEEDED"` 及明确条数，`quotes`、`signals` 均为空，不返回部分报价。重复平台合约键同样拒绝并返回 `DUPLICATE_QUOTES`。

## 首版市场与身份

仅支持 Binance / Bybit、USDT 计价且 USDT 结算、`multiplier === 1` 的普通加密永续。要求 `assetClass: "crypto"`、明确 `identitySource` 与 `identityVerified: true`，且未被现有身份规则标记为不可比较。股票、商品、ETF、外汇、盘前、未知身份与倍数合约不进入接口。目录有下架标志或有效下架时间的合约也不进入接口，包括即将下架。

新增字段来自已有官方批量目录，保持原始盘口时间：

- Binance 的 `collateralCurrency` 来自 `marginAsset`；只有 `underlyingType === "COIN"` 且现有身份分类为 crypto 才验证通过。
- Bybit 的 `collateralCurrency` 来自 `settleCoin`；明确存在的 `symbolType: ""` 仅允许 BTC、ETH、SOL、XRP、DOGE、ADA、AVAX、LINK、LTC、BCH、DOT、BNB、SUI、TRX、TON。`symbolType: "innovation"` 沿用现有加密类别。缺失分类、未知新类别（包括未在当前官方枚举中明确列出的 `crypto` 值）均拒绝。
- 两种受支持的 Bybit 类别都必须在当前快照中找到同 base、同计价结算币、倍数 1 且通过 Binance COIN 验证的报价，再进入接口。交叉核对不能替代代币地址核验；目录出现已知身份冲突时仍以现有隔离规则为准，未知类别不自动扩大。

证据在生成此接口响应时按需从当前目录追加，价格和时间保持原始快照值。原 `quote` / SSE 报价、既有持仓身份键与策略保持原样。进程刚启动、尚无当前目录证据时暂不提供信号；已有目录刷新会补齐证据，字段丢失或证据撤销时立即撤销资格。分类与结算币的更新不会刷新盘口时间，不新增目录轮询。上述严格条件只用于本接口，不改动原页面的行情配对范围。

字段依据于 2026-09-22 核对：[Binance exchangeInfo](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)、[Bybit instruments-info](https://bybit-exchange.github.io/docs/v5/market/instrument)、[Bybit symbolType 枚举](https://bybit-exchange.github.io/docs/v5/enum#symboltype)。官方目录没有下架标志不等于从未发布其他公告，本接口只使用已有目录证据。

## 时效、版本与持仓估值

`signals` 复用 `rankPerpetualSpreads`、`quotePriceTime`、`perpetualSpreadKey`：两平台必须 live，两腿完整买卖盘口有效，各自不超过 10 秒、时间差不超过 5 秒；沿用现有最多 5 秒的未来时间容差。盘口时间为 `min(bidAskAt, receivedAt)`，缺少 `bidAskAt` 不会用 `sourceTime` 或 `generatedAt` 补齐。只有严格大于 0 的 `(short.bid / long.ask - 1) × 100` 毛价差进入信号，未扣费用、滑点或资金费。

`id` 哈希输入由方向键、两腿身份及单位、bid、ask、独立盘口时间组成。请求时间、快照排序、单独资金费或 mark 更新不会生成新 ID；盘口价格或确认时间变更会生成新 ID。`pairKey` 对同一做多/做空方向保持稳定，方向反转产生另一键。客户端应同时检查自己的当前时间与 `expiresAt`，不能以响应时间延长信号有效期。

`quotes` 与正价差信号分开保留：满足身份与市场条件的负价差、零价差、过期报价、缺少盘口字段以及非 live 平台报价仍按原样返回，供持仓状态判断；估值使用方必须检查两腿字段、原始时间、平台状态与身份一致性。过期、缺失或范围外的腿不能当作零价格、零盈亏或完整成交。没有信号不代表没有持仓报价。

本次验证：Windows 原生 Node 测试覆盖认证/方法、正负价差、时效/错位/缺失盘口、身份与官方目录透传、下架、稳定 ID、容量边界、旧缓存元数据补齐及撤销；同时运行相关排行/服务/路由回归与 TypeScript 检查。未使用 WSL。
