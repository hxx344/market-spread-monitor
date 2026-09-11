import { join } from "node:path";
import { openStore } from "./alert-store.mjs";
import { createAlertService } from "./alert-service.mjs";
import { FileStore } from "./oil/store.mjs";
import { Monitor } from "./oil/monitor.mjs";
import { openNotificationStore } from "./notification-store.mjs";
import { createNotificationService } from "./notification-service.mjs";
import { fetchMarket } from "../modules/oil/hyperliquid.mjs";

/** Runtime adapters own their schedule, storage and API. They share one HTTP server. */
export async function createMonitorServices(directory, { externallyLocked = false, env = process.env, notificationOptions, hynixOptions, oilOptions } = {}) {
  const oilStore = new FileStore(join(directory, "oil"), externallyLocked);
  await oilStore.acquire();
  try {
    const hynixStore = await openStore(join(directory, "hynix"));
    const notificationStore = await openNotificationStore(directory, () => [
      { id: "hynix", ...hynixStore.get().config },
      { id: "oil", webhookUrl: env.OIL_FEISHU_WEBHOOK_URL || "", signingSecret: env.OIL_FEISHU_WEBHOOK_SECRET || "" },
    ]);
    const notifications = createNotificationService(notificationStore, notificationOptions);
    const hynix = createAlertService(hynixStore, { ...hynixOptions, notifications });
    const pollSeconds = Number(env.OIL_POLL_INTERVAL_SECONDS || 30);
    if (!Number.isInteger(pollSeconds) || pollSeconds < 10 || pollSeconds > 3600) throw new Error("OIL_POLL_INTERVAL_SECONDS 必须为 10–3600 的整数");
    const oil = new Monitor({ store: oilStore, data: await oilStore.read(), fetchMarket, pollSeconds, ...oilOptions, notify: notifications.send, webhookConfigured: notifications.configured });
    const services = new Map([
      ["hynix", {
        start: () => hynix.start(), stop: () => hynix.stop(), healthy: () => hynix.healthy(),
        async handle(action, method, input) {
          if (action === "quote" && method === "GET") return hynix.quote();
          if (action === "alerts" && method === "GET") return hynix.view();
          if (action === "alerts" && method === "PUT") return hynix.update(input);
          if (action === "alerts/test" && method === "POST") return hynix.test();
        },
        actions: { quote: ["GET"], alerts: ["GET", "PUT"], "alerts/test": ["POST"] },
      }],
      ["oil", {
        start: () => oil.start(), healthy: () => !oil.storageError, async stop() { await oil.stop(); await oilStore.release(); },
        async handle(action, method, input) {
          if (action === "status" && method === "GET") return { ...oil.status(), available: true, monitorId: "oil" };
          if (action === "config" && method === "GET") return oil.configuration();
          if (action === "events" && method === "GET") return { events: oil.data.events };
          if (action === "config" && method === "PUT") {
            if (!Number.isSafeInteger(input?.revision)) throw new Error("缺少配置版本号");
            return oil.configure(input.config, input.revision);
          }
          if (action === "test-notification" && method === "POST") { await notifications.test(); return { ok: true }; }
        },
        actions: { status: ["GET"], config: ["GET", "PUT"], events: ["GET"], "test-notification": ["POST"] },
      }],
    ]);
    services.notifications = notifications;
    return services;
  } catch (error) { await oilStore.release(); throw error; }
}
