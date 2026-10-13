# Lessons from merged work

这里保存 market-spread-monitor 的合并经验。改动前先读本文件。每条先给加粗祈使规则，再给证据（SHA / 现象），结尾 `Seen N× (日期…)`。满 3 个不同复盘日迁入 [docs/code-standards.md](docs/code-standards.md) 并在此留 Moved 索引。

## Database

**市场 store 热路径复用 prepared statement，不要每次查询重新 prepare。**

- 证据：`c307a33c` 改 `server/market-store.mjs` / `perpetual-store.mjs`；`tests/store-statements.test.mjs` 验同 SQL 编译次数。
- Seen 1× (2026-10-13)

## Frontend performance

**历史明细面板在数据未变时用 memo 跳过重渲。**

- 证据：`60fa2ef3` memoize 金油历史细节；`tests/gold-oil-details.browser.mjs`。
- Seen 1× (2026-10-13)

## Theme / docs

本窗口另有 `969c29e4`（深色主题），纯样式，无缺陷类教训。

## Moved to the code standards

尚无。
