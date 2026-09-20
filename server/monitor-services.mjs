import { join } from "node:path";
import { openStore } from "./alert-store.mjs";
import { createAlertService } from "./alert-service.mjs";
import { FileStore, activateBinanceSource } from "./oil/store.mjs";
import { Monitor } from "./oil/monitor.mjs";
import { openNotificationStore } from "./notification-store.mjs";
import { createNotificationService } from "./notification-service.mjs";
import { openMarketStore } from "./market-store.mjs";
import { createMarketCollector, marketJobs, seedMarketDatabase } from "./market-collector.mjs";
import { externalExchanges, exchangeAction, exchangeFromAction, EXCHANGE_REFRESH_MS } from "../lib/exchange-quotes.ts";
import { OIL_CANDLE_ACTION, OIL_CANDLE_REFRESH_MS } from "../modules/oil/intraday.mjs";
import { openPerpetualStore } from './perpetual-store.mjs';
import { createPerpetualService } from './perpetual-service.mjs';
import { createFundamentalsClient } from './perpetual-fundamentals.mjs';

const exchangeActions = Object.fromEntries(externalExchanges.map(exchange => [exchangeAction(exchange), ["GET"]]));

/** Runtime adapters own their schedule, storage and API. They share one HTTP server. */
export async function createMonitorServices(directory, { externallyLocked = false, env = process.env, notificationOptions, hynixOptions, oilOptions, marketOptions, perpetualOptions } = {}) {
  const oilStore = new FileStore(join(directory, "oil"), externallyLocked);
  await oilStore.acquire();
  let marketStore, perpetualStore;
  try {
    const pollSeconds = Number(env.OIL_POLL_INTERVAL_SECONDS || 30);
    if (!Number.isInteger(pollSeconds) || pollSeconds < 10 || pollSeconds > 3600) throw new Error("OIL_POLL_INTERVAL_SECONDS 必须为 10–3600 的整数");
    marketStore = await openMarketStore(join(directory, "market.sqlite"));
    seedMarketDatabase(marketStore);
    let hynixRunning = false, oilRunning = false;
    const collector = createMarketCollector(marketStore, { jobs: marketJobs({ oilIntervalMs: pollSeconds * 1000 }), ...marketOptions,
      onStored(job) { if (job.action === "quote") { if (job.id === "hynix" && hynixRunning) return hynix.check(); if (job.id === "oil" && oilRunning) return oil.tick(); } },
    });
    const read = (id, action, fresh = false) => {
      if (fresh && !collector.healthy()) throw new Error("行情数据库写入失败，暂停告警。");
      const interval = action === OIL_CANDLE_ACTION ? OIL_CANDLE_REFRESH_MS : exchangeFromAction(action) ? EXCHANGE_REFRESH_MS : action === "quote" ? id === "oil" ? pollSeconds * 1000 : 10_000 : action === "history" && id === "hynix" ? 60_000 : 300_000;
      const value = marketStore.read(id, action, { fresh, maxAgeMs: interval * 2 + 15_000 });
      return collector.healthy() ? value : { ...value, status: "snapshot", collection: { ...value.collection, stale: true, error: "行情数据库写入失败，保留已保存数据。" } };
    };
    const hynixStore = await openStore(join(directory, "hynix"));
    const notificationStore = await openNotificationStore(directory, () => [
      { id: "hynix", ...hynixStore.get().config },
      { id: "oil", webhookUrl: env.OIL_FEISHU_WEBHOOK_URL || "", signingSecret: env.OIL_FEISHU_WEBHOOK_SECRET || "" },
    ]);
    const notifications = createNotificationService(notificationStore, notificationOptions);
    const hynix = createAlertService(hynixStore, { getQuote: async () => read("hynix", "quote", true), ...hynixOptions, notifications });
    const previousOil = await oilStore.read(), oilData = activateBinanceSource(previousOil);
    if (oilData !== previousOil) await oilStore.write(oilData);
    const oil = new Monitor({ store: oilStore, data: oilData, fetchMarket: async () => read("oil", "quote", true), pollSeconds, ...oilOptions, notify: notifications.send, webhookConfigured: notifications.configured });
    perpetualStore = await openPerpetualStore(join(directory, 'perpetual', 'market.sqlite'));
    let coinIds = {};
    if (env.PERPETUAL_COIN_IDS) {
      try {
        coinIds = JSON.parse(env.PERPETUAL_COIN_IDS);
        if (!coinIds || typeof coinIds !== 'object' || Array.isArray(coinIds) || Object.keys(coinIds).length > 2000 || Object.entries(coinIds).some(([base, id]) => !/^[A-Z0-9._-]{1,40}$/.test(base) || typeof id !== 'string' || !/^[a-z0-9-]{1,120}$/.test(id))) throw new Error();
      } catch { throw new Error('PERPETUAL_COIN_IDS 必须为币种到 CoinGecko ID 的 JSON 对象'); }
    }
    const perpetual = createPerpetualService({ store: perpetualStore, qualityOptions: { fundamentals: createFundamentalsClient({ coinIds, apiKey: env.COINGECKO_DEMO_API_KEY || '' }) }, ...perpetualOptions });
    const services = new Map([
      ['perpetual', perpetual],
      ["hynix", {
        start() { hynixRunning = true; hynix.start(); }, stop() { hynixRunning = false; return hynix.stop(); }, healthy: () => hynix.healthy(),
        async handle(action, method, input) {
          if ((["quote", "history", "funding"].includes(action) || exchangeFromAction(action)) && method === "GET") return read("hynix", action);
          if (action === "alerts" && method === "GET") return hynix.view();
          if (action === "alerts" && method === "PUT") return hynix.update(input);
          if (action === "alerts/test" && method === "POST") return hynix.test();
        },
        actions: { quote: ["GET"], history: ["GET"], funding: ["GET"], ...exchangeActions, alerts: ["GET", "PUT"], "alerts/test": ["POST"] },
      }],
      ["oil", {
        start() { oilRunning = true; oil.start(); }, healthy: () => !oil.storageError, async stop() { oilRunning = false; await oil.stop(); },
        async handle(action, method, input) {
          if (action === "status" && method === "GET") return { ...oil.status(), available: true, monitorId: "oil" };
          if (action === OIL_CANDLE_ACTION && method === "GET") return read("oil", action);
          if ((["quote", "history", "funding"].includes(action) || exchangeFromAction(action)) && method === "GET") return read("oil", action);
          if (action === "config" && method === "GET") return oil.configuration();
          if (action === "events" && method === "GET") return { events: oil.data.events };
          if (action === "config" && method === "PUT") {
            if (!Number.isSafeInteger(input?.revision)) throw new Error("缺少配置版本号");
            return oil.configure(input.config, input.revision);
          }
          if (action === "test-notification" && method === "POST") { await notifications.test(); return { ok: true }; }
        },
        actions: { quote: ["GET"], history: ["GET"], funding: ["GET"], [OIL_CANDLE_ACTION]: ["GET"], ...exchangeActions, 'exchanges/hyperliquid/quote': ['GET'], status: ["GET"], config: ["GET", "PUT"], events: ["GET"], "test-notification": ["POST"] },
      }],
    ]);
    services.notifications = notifications;
    services.market = { start: () => collector.start(), healthy: () => collector.healthy(), status: () => marketStore.status(), async stop() { await collector.stop(); marketStore.close(); await oilStore.release(); } };
    return services;
  } catch (error) { perpetualStore?.close(); marketStore?.close(); await oilStore.release(); throw error; }
}
