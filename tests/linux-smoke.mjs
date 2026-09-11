import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await mkdtemp(join(tmpdir(), "market-spread-linux-smoke-"));
const probe = createServer();
await new Promise(accept => probe.listen(0, "127.0.0.1", accept));
const port = probe.address().port;
await new Promise(accept => probe.close(accept));
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Basic ${Buffer.from("admin:smoke-test-password").toString("base64")}` };
let child, exited, output = "";
function start() {
  child = spawn(process.platform === "linux" ? "bash" : process.execPath, process.platform === "linux" ? ["server/entrypoint.sh"] : ["--experimental-strip-types", "server/linux.mjs"], { cwd: process.cwd(), env: { ...process.env, MONITOR_NODE: process.execPath, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), APP_USERNAME: "admin", APP_PASSWORD: "smoke-test-password", ALERT_DATA_DIR: directory, OIL_FEISHU_WEBHOOK_URL: "", OIL_FEISHU_WEBHOOK_SECRET: "", OIL_POLL_INTERVAL_SECONDS: "10" }, stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data.toString()).slice(-16000); });
  exited = new Promise(accept => child.once("exit", accept));
}
async function stop() {
  if (child && child.exitCode === null) { if (process.platform === "win32") child.send({ type: "shutdown" }); else child.kill("SIGTERM"); }
  if (exited) await exited;
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup: ${output}`);
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(250);
  }
  throw new Error(`Server did not become ready: ${output}`);
}
async function state() { return fetch(`${base}/api/alerts`, { headers }).then(response => response.json()); }
async function oilState() { return fetch(`${base}/api/monitors/oil/config`, { headers }).then(response => response.json()); }
try {
  start(); await ready();
  assert.equal((await fetch(base)).status, 401);
  const page = await fetch(base, { headers });
  assert.equal(page.status, 200);
  const markup = await page.text();
  for (const id of ["oil", "hynix"]) assert.ok(markup.includes(`data-alert-monitor="${id}"`), `${id} must render the shared alert editor`);
  const initial = await state();
  assert.equal(initial.available, true); assert.equal(initial.config.enabled, false);
  const updated = await fetch(`${base}/api/alerts`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ enabled: false, cooldownSeconds: 60, hysteresis: 0.5, revision: initial.revision, rules: [{ id: "smoke-above", name: "smoke-above", enabled: true, direction: "above", threshold: 40, cooldownSeconds: 90, hysteresis: 0.25 }, { id: "smoke-below", name: "smoke-below", enabled: true, direction: "below", threshold: 20 }] }) });
  assert.equal(updated.status, 200);
  const oilInitial = await oilState();
  const oilConfig = { enabled: false, rules: [{ id: "smoke-oil", label: "原油测试", enabled: true, metric: "spread", operator: "gte", threshold: 5, cooldownMinutes: 1, hysteresis: 0.1 }] };
  const oilSaved = await fetch(`${base}/api/monitors/oil/config`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ revision: oilInitial.revision, config: oilConfig }) });
  assert.equal(oilSaved.status, 200);
  const sharedEndpoint = `${base}/api/notifications/feishu`;
  const sharedInitial = await fetch(sharedEndpoint, { headers }).then(response => response.json());
  assert.equal(sharedInitial.available, true); assert.equal(sharedInitial.webhookConfigured, false);
  // Both module switches stay disabled: this verifies storage, never external delivery.
  const sharedSaved = await fetch(sharedEndpoint, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ revision: sharedInitial.revision, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/smoke-storage-only", signingSecret: "smoke-storage-only-secret" }) });
  assert.equal(sharedSaved.status, 200); assert.equal((await sharedSaved.json()).webhookConfigured, true);
  assert.equal((await state()).config.webhookConfigured, true);
  assert.equal((await fetch(`${base}/api/monitors/oil/status`, { headers }).then(response => response.json())).webhookConfigured, true);
  const health = await fetch(`${base}/healthz`).then(r=>r.json());
  assert.deepEqual(health.monitors.sort(), ["hynix", "oil"]);
  let firstCheck = (await state()).status.checkedAt, secondCheck;
  for (let i = 0; i < 70; i++) {
    const current = (await state()).status.checkedAt;
    if (firstCheck && current && current !== firstCheck) { secondCheck = current; break; }
    firstCheck ??= current;
    await delay(500);
  }
  assert.ok(firstCheck && secondCheck, "Background monitor must continue checking without a browser");
  const quoteStatus = (await fetch(`${base}/api/quote`, { headers })).status;
  assert.ok([200, 503].includes(quoteStatus));
  const oilStatus = await fetch(`${base}/api/monitors/oil/status`, { headers }).then(r=>r.json());
  assert.ok(oilStatus.lastAttemptAt, "Oil monitor runs independently of page visits");
  await stop(); start(); await ready();
  const restarted = await state();
  assert.equal(restarted.config.rules.length, 2); assert.equal(restarted.revision, 1);
  assert.equal(restarted.config.rules[0].cooldownSeconds, 90); assert.equal(restarted.config.rules[0].hysteresis, 0.25);
  assert.equal(Object.hasOwn(restarted.config.rules[1], "cooldownSeconds"), false);
  assert.deepEqual((await oilState()).config, oilConfig); assert.equal((await oilState()).revision, 1);
  const sharedRestarted = await fetch(sharedEndpoint, { headers }).then(response => response.json());
  assert.equal(sharedRestarted.revision, 1); assert.equal(sharedRestarted.webhookConfigured, true); assert.equal(sharedRestarted.signingSecretConfigured, true);
  if (process.platform === "linux") {
    const contender=spawn("bash",["server/entrypoint.sh"],{ env:{...process.env, MONITOR_NODE:process.execPath, ALERT_DATA_DIR:directory, HOST:"127.0.0.1", PORT:String(port), APP_USERNAME:"admin", APP_PASSWORD:"smoke-test-password"}, stdio:"ignore" });
    assert.equal(await new Promise(resolve=>contender.once("exit",resolve)), 75, "Second process must fail specifically on the running directory lock");
    child.kill("SIGKILL"); await exited;
    start(); await ready();
    assert.equal((await oilState()).revision,1); assert.equal((await state()).revision,1);
  }
  console.log(JSON.stringify({ platform: process.platform, node: process.version, page: 200, authentication: "passed", configuration: "persisted across restart", backgroundChecks: [firstCheck, secondCheck], quoteStatus, feishuMessagesSent: 0 }));
} finally {
  await stop();
  const absolute = resolve(directory);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep + "market-spread-linux-smoke-"));
  await rm(absolute, { recursive: true, force: true });
}
