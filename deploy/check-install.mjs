import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { validateWebhook } from "../server/oil/feishu.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ?? "3000";
if (!isAbsolute(process.env.ALERT_DATA_DIR ?? "")) {
  console.error("请先将 /etc/market-spread-monitor.env 中 ALERT_DATA_DIR 设为原有数据目录的绝对路径，再重新运行；原服务未切换。");
  process.exit(1);
}
const numericPort = Number(port);
const oilInterval = Number(process.env.OIL_POLL_INTERVAL_SECONDS || 30);
if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535 || (process.env.APP_PASSWORD ?? "").length < 12 || (process.env.APP_USERNAME ?? "admin").includes(":") || !Number.isInteger(oilInterval) || oilInterval < 10 || oilInterval > 3600) {
  console.error("配置无效：请检查 PORT、APP_PASSWORD（至少 12 字符）、APP_USERNAME 及 OIL_POLL_INTERVAL_SECONDS（10–3600）。原服务尚未切换。");
  process.exit(1);
}
try { validateWebhook(process.env.OIL_FEISHU_WEBHOOK_URL || ""); }
catch { console.error("OIL_FEISHU_WEBHOOK_URL 配置无效。原服务尚未切换。"); process.exit(1); }
if (process.argv.includes("--config-only")) process.exit(0);
if (process.argv.includes("--describe")) {
  if (["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.log(`访问地址：http://127.0.0.1:${port}（保留了本机监听，请通过已有反向代理访问）`);
  } else {
    console.log(`访问地址：http://服务器IP:${port}\n远程访问时，在服务器防火墙和云安全组中放行 TCP ${port}。`);
  }
  console.log(`用户名：${process.env.APP_USERNAME ?? "admin"}`);
  console.log(process.argv.at(-1) === "1" ? `登录密码：${process.env.APP_PASSWORD}` : "登录密码、飞书配置和告警记录均已保留。");
  process.exit(0);
}
const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
const base = `http://${address}:${port}`;
const credentials = `${process.env.APP_USERNAME ?? "admin"}:${process.env.APP_PASSWORD ?? ""}`;
const headers = { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
let ready = false;
const quiet = process.argv.includes("--quiet");
const attempts = process.argv.includes("--once") ? 1 : 30;
for (let attempt = 0; attempt < attempts; attempt++) {
  try {
    const responses = await Promise.all(["/api/monitors/hynix/alerts", "/api/monitors/oil/status", "/healthz"].map(path => fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(1500) })));
    const [hynix, oil, health] = await Promise.all(responses.map(response => response.json()));
    if (responses.every(response => response.ok) && hynix.available === true && oil.available === true && health.service === "market-spread-monitor" && ["oil", "hynix"].every(id => health.monitors.includes(id))) {
      const pid = execFileSync("systemctl", ["show", "--property=MainPID", "--value", "market-spread-monitor.service"], { encoding: "utf8" }).trim();
      const listeners = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8" });
      if (/^[1-9]\d*$/.test(pid) && listeners.includes(`pid=${pid},`)) {
        ready = true;
        break;
      }
    }
  } catch { /* Wait for the new service to listen. */ }
  if (attempt + 1 < attempts) await delay(1000);
}
if (!ready) {
  if (!quiet) console.error("服务未通过登录及告警 API 检查，请查看服务日志。");
  process.exitCode = 1;
} else {
  if (!quiet) console.log("统一登录、原油与海力士后台检查通过。");
}
