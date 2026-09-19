# 合约下架标记

2026-09-20 核对。标记针对某个平台的具体合约，不代表同币种在所有平台下架。排名的两条平台腿、展开明细及全部报价均展示文字；有官方时间时按 `YYYY-MM-DD HH:mm 北京时间` 展示，无时间则注明待公布。超过公布时间显示“已到下架时间”，随后在成功刷新目录时移除；不把常规维护或暂时停盘推断成下架。

## 已接入的目录字段

| 平台 | 官方字段 | 处理 |
| --- | --- | --- |
| Binance | `deliveryDate`，毫秒 | 仅仍在交易的永续；精确排除正常占位值 `4133404800000` |
| Bybit | `deliveryTime`，毫秒 | 官方定义包含永续下架时间；0/空值不标记 |
| OKX | `expTime`，毫秒 | 官方定义包含永续下架时间；空值不标记 |
| Bitget | `offTime`，毫秒 | `-1` 表示普通状态；不使用维护或禁止开仓时间 |
| Gate | `in_delisting`、`delisted_time`，秒 | 布尔状态可单独标记；最终时间转为毫秒；`delisting_time` 是进入只减仓时间，不用它替代最终时间 |
| Aster | `deliveryDate`，毫秒 | 排除同一正常占位值；接口未保证提前填入，不能承诺全部提前覆盖 |

只对既有交易范围内的线性永续合约展示；不会为标记而纳入原先排除的 RWA、交割合约或停止开仓市场。已过最终截止时间、已终止的市场不重新订阅。Gate 明确 `in_delisting=true` 且 `position_size=0` 的终止记录也排除。

来源：[Binance exchangeInfo](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#exchange-information)、[Bybit instruments-info](https://bybit-exchange.github.io/docs/v5/market/instrument)、[OKX instruments](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments)、[Bitget contracts](https://www.bitget.com/api-doc/classic/contract/market/Get-All-Symbols-Contracts)、[Gate futures contracts](https://www.gate.com/docs/developers/apiv4/en/futures/)、[Aster exchangeInfo](https://asterdex.github.io/aster-api-website/futures/market-data/#exchange-information)。

本次真实目录核验中，Bitget `AINUSDT.offTime=1790060400000` 对应 2026-09-22 15:00 北京时间，与[官方下架公告](https://www.bitget.com/support/articles/12560603895497)一致。此例用于核验单位与含义，不在代码中硬编码币种或公告。

## 尚不能可靠提前预警的平台

Hyperliquid / Entropy 的 `isDelisted` 表示当前状态，没有确认的未来下架时点；HIP-3 暂停可恢复，不据此猜测永久下架。Lighter / rh-Lighter 的 active/inactive、隐藏或只减仓配置也不是未来下架计划。未提供可靠字段时不添加预警标记。

来源：[Hyperliquid perpetual meta](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)、[HIP-3 暂停与恢复](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals)、[Lighter 官方 OpenAPI](https://github.com/elliottech/lighter-python/blob/main/openapi.json)、[rh-Lighter 公开目录](https://api.rh.lighter.xyz/api/v1/orderBookDetails)。

## 更新与资源占用

每 5 分钟复用各平台现有批量合约目录，不逐币请求公告。标记变化沿用每秒增量流，不重连行情，不改变价格及接收时间；撤销公告会清除标记，读取失败保留上次结果。仍只存每合约最新一条记录，不新增历史表、定时清理任务或前端倒计时定时器。该功能不向外发送消息。

测试覆盖官方字段、占位日期、无时间标志、秒/毫秒转换、已终止过滤、撤销与查询失败、保留旧报价时间及不重连。浏览器使用明确的本地合成场景验证电脑/手机的未来、未知及已到时三种状态；真实公开目录另行核验，不将合成场景作为真实公告。
