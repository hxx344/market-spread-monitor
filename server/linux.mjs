import { createServer } from "node:http";
import { resolve } from "node:path";
import next from "next";
import { createMonitorServices } from "./monitor-services.mjs";
import { createHandler } from "./http.mjs";
import { registerInitialMarket } from "./initial-market.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const username = process.env.APP_USERNAME ?? "admin";
const password = process.env.APP_PASSWORD ?? "";
if (!password || password.length < 12 || username.includes(":")) throw new Error("请设置 APP_PASSWORD（至少 12 个字符）；APP_USERNAME 不能包含冒号。");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是 1–65535 的端口号。");
const directory = resolve(process.env.ALERT_DATA_DIR ?? "./runtime-data");
if (process.platform === "linux" && process.env.MONITOR_EXTERNAL_LOCK !== "1") throw new Error("请通过 bash server/entrypoint.sh 启动，确保运行数据目录持有内核锁。");
const services = await createMonitorServices(directory, { externallyLocked: process.env.MONITOR_EXTERNAL_LOCK === "1" });
const releaseInitialMarket = registerInitialMarket(services);
const app = next({ dev: false, hostname: host, port });
let server;
try {
await app.prepare();
server = createServer(createHandler({ services, username, password, nextHandler: app.getRequestHandler() }));
server.requestTimeout = 30_000;
await new Promise((accept, reject) => { server.once("error", reject); server.listen(port, host, accept); });
services.market.start();
for (const service of services.values()) service.start();
console.log(`Market Monitor is listening on http://${host}:${port}; ${[...services.keys()].join(', ')} monitors are running.`);
} catch (error) { releaseInitialMarket(); await Promise.allSettled([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); throw error; }
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 28_000).unref();
  const closed = new Promise(accept => server.close(accept));
  for (const service of services.values()) service.closeStreams?.();
  await closed;
  releaseInitialMarket();
  // Drain active configuration requests before stopping persistence or releasing locks.
  await Promise.all([...services.values()].map(service => service.stop()));
  await services.market.stop();
  await services.notifications.stop();
  await app.close();
  clearTimeout(timeout);
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
// Parent supervisors can request graceful shutdown on Windows as well as Linux.
if (process.channel) process.on("message", message => { if (message?.type === "shutdown") void shutdown(); });
