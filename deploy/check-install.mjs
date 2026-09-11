import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ?? "3000";
if (!isAbsolute(process.env.ALERT_DATA_DIR ?? "")) {
  console.error("请先将 /etc/market-spread-monitor.env 中 ALERT_DATA_DIR 设为原有数据目录的绝对路径，再重新运行；原服务未切换。");
  process.exit(1);
}
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
for (let attempt = 0; attempt < 30; attempt++) {
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
  await delay(1000);
}
if (!ready) {
  console.error("新服务未通过登录及告警 API 检查，请查看服务日志。");
  process.exitCode = 1;
} else {
  console.log("统一登录、原油与海力士后台检查通过。");
}
