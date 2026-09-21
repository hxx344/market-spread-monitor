import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// This exercises real root installation only on an empty, disposable CI VM.
assert.equal(process.env.GITHUB_ACTIONS, "true", "Installer smoke test requires a disposable GitHub Actions VM");
assert.equal(process.platform, "linux");
assert.equal(existsSync("/etc/market-spread-monitor.env"), false, "Do not overwrite an existing installation");
assert.equal(existsSync("/opt/market-spread-monitor"), false, "Do not overwrite an existing installation");
const exec = promisify(execFile);
const root = process.cwd();
const installer = join(root, "deploy/install.sh");
const scratch = await mkdtemp(join(tmpdir(), "market-spread-installer-test-"));
const base = "http://127.0.0.1:31877";
let headers;
const timings = [];
async function run(command, args) {
  return exec(command, args, { timeout: 600_000, maxBuffer: 8_000_000 });
}
async function install(source, succeeds = true) {
  const started = Date.now();
  let result, failed = false;
  try {
    // Exercise the documented pipe form and automatic sudo elevation, not just bash file.sh.
    result = await run("bash", ["-o", "pipefail", "-c", 'cat "$1" | bash -s -- --source-dir "$2" --port 31877', "installer-test", installer, source]);
  } catch (error) { result = error; failed = true; }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/登录密码：[^\r\n]*/g, "登录密码：[redacted]");
  assert.equal(failed, !succeeds, output.slice(-6000));
  timings.push({ source: source.split("/").at(-1), seconds: Number(((Date.now() - started) / 1000).toFixed(2)), success: !failed });
  return output;
}
async function state() {
  const response = await fetch(`${base}/api/alerts`, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function oilState() {
  const response = await fetch(`${base}/api/monitors/oil/config`, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function sharedState() {
  const response = await fetch(`${base}/api/notifications/feishu`, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); return response.json();
}
async function databaseMarker(write = false) {
  // The installed collector is live; give its short write transaction time to finish.
  const script = `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/var/lib/market-spread-monitor/market.sqlite');
    db.exec('PRAGMA busy_timeout=5000');
    if(process.argv[1]==='write') db.prepare('INSERT OR IGNORE INTO market_observations(dataset,time,payload,source_ms) VALUES (?,?,?,?)').run('install/retention',1,'persisted',1);
    console.log(db.prepare('SELECT payload FROM market_observations WHERE dataset=? AND time=?').get('install/retention',1)?.payload); db.close();`;
  return (await run('sudo', [process.execPath, '--input-type=module', '-e', script, write ? 'write' : 'read'])).stdout.trim();
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { if ((await state()).available && (await fetch(`${base}/api/monitors/oil/status`, { headers })).ok) return; } catch { /* Wait for rollback restart. */ }
    await delay(500);
  }
  throw new Error("Service did not recover");
}
async function current() { return (await run("readlink", ["-f", "/opt/market-spread-monitor/current"])).stdout.trim(); }
async function active() { await run("systemctl", ["is-active", "--quiet", "market-spread-monitor.service"]); }
async function config() { return (await run("sudo", ["cat", "/etc/market-spread-monitor.env"])).stdout; }
async function pid() { return (await run("systemctl", ["show", "--property=MainPID", "--value", "market-spread-monitor.service"])).stdout; }
async function replaceConfig(value) {
  const path = join(scratch, "config.env");
  await writeFile(path, value, { mode: 0o600 });
  await run("sudo", ["install", "-m", "0600", path, "/etc/market-spread-monitor.env"]);
}
async function buildCount() { return (await run("sudo", ["cat", "/var/cache/market-spread-monitor/install-test-builds"])).stdout.trim().split("\n").length; }
async function releases() { return (await run("find", ["/opt/market-spread-monitor/releases", "-mindepth", "1", "-maxdepth", "1", "-type", "d"])).stdout.trim().split("\n").sort(); }
async function copySource(name) {
  const target = join(scratch, name);
  await run("mkdir", ["-p", target]);
  await run("bash", ["-o", "pipefail", "-c", 'tar --exclude=./.git --exclude=./node_modules --exclude=./.next --exclude=./.sites-runtime -C "$1" -cf - . | tar -xf - -C "$2"', "copy-source", root, target]);
  return target;
}
try {
  const baseline = await copySource("baseline");
  const manifestPath = join(baseline, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts["build:linux"] = "node tests/install-build-wrapper.mjs";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(baseline, "tests/install-build-wrapper.mjs"), `import { appendFileSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync('/var/cache/market-spread-monitor/install-test-builds', 'build\\n');
const mode = existsSync('install-fixture-mode') ? readFileSync('install-fixture-mode','utf8').trim() : '';
if (mode === 'fail-build') { writeFileSync('node_modules/.isolation-probe', 'new release only'); process.exit(42); }
if (mode === 'reuse-build') { cpSync('/opt/market-spread-monitor/current/.next', '.next', {recursive:true}); }
else { const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next','build','--webpack'], {stdio:'inherit'}); process.exit(result.status ?? 1); }
`);
  console.log("Installer: fresh install through stdin and sudo");
  await install(baseline);
  await active();
  const originalConfig = await config();
  const values = Object.fromEntries(originalConfig.trim().split("\n").map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.ok(values.APP_PASSWORD.length >= 24);
  headers = { Authorization: `Basic ${Buffer.from(`${values.APP_USERNAME}:${values.APP_PASSWORD}`).toString("base64")}` };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 200);
  const initial = await state();
  const persistedFunding = await fetch(`${base}/api/monitors/hynix/funding`, { headers }).then(response => response.json());
  assert.equal(persistedFunding.collection.source, 'database');
  assert.ok(persistedFunding.rows.length >= 1512);
  assert.equal(await databaseMarker(true), 'persisted');
  const rules = [{ id: "install-test", name: "保存后升级", enabled: false, direction: "above", threshold: 40 }];
  const saved = await fetch(`${base}/api/alerts`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ enabled: false, cooldownSeconds: 60, hysteresis: 0.5, revision: initial.revision, rules }) });
  assert.equal(saved.status, 200);
  const savedState = await state();
  const oilInitial = await oilState();
  const oilConfig = { ...oilInitial.config, enabled: false, rules: [{ id: "install-oil", label: "油价保存后升级", metric: "spread", operator: "gte", threshold: 5, cooldownMinutes: 30, hysteresis: 0.1, enabled: false }] };
  const oilSaved = await fetch(`${base}/api/monitors/oil/config`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ revision: oilInitial.revision, config: oilConfig }) });
  assert.equal(oilSaved.status, 200);
  const sharedInitial = await sharedState();
  const sharedSaved = await fetch(`${base}/api/notifications/feishu`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ revision: sharedInitial.revision, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/install-storage-only", signingSecret: "install-storage-only-secret" }) });
  assert.equal(sharedSaved.status, 200);
  const sharedConfig = await sharedState();
  assert.equal(sharedConfig.webhookConfigured, true); assert.equal(sharedConfig.signingSecretConfigured, true);
  const firstRelease = await current();
  const firstPid = await pid();
  assert.equal(await buildCount(), 1);
  const firstDependencyTime = (await stat(join(firstRelease, "node_modules/.package-lock.json"))).mtimeMs;

  console.log("Installer: unchanged source (even after touch) performs no build, install, release switch or restart");
  await utimes(join(baseline, "README.md"), new Date(), new Date());
  const unchanged = await install(baseline);
  await active();
  assert.equal(firstRelease, await current());
  assert.equal(firstPid, await pid());
  assert.equal(await buildCount(), 1);
  assert.equal((await releases()).length, 1);
  assert.match(unchanged, /跳过源码下载、依赖安装、构建和重启/);
  assert.equal(await config(), originalConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.equal((await state()).revision, savedState.revision);
  assert.deepEqual((await oilState()).config, oilConfig); assert.equal((await oilState()).revision, oilInitial.revision+1);
  assert.deepEqual(await sharedState(), sharedConfig);

  console.log("Installer: configuration changes only restart, and invalid configuration leaves the old process running");
  const expectedConfig = originalConfig.replace("OIL_POLL_INTERVAL_SECONDS=30", "OIL_POLL_INTERVAL_SECONDS=45");
  await replaceConfig(expectedConfig);
  const configured = await install(baseline);
  assert.equal(await current(), firstRelease);
  assert.notEqual(await pid(), firstPid);
  assert.equal(await buildCount(), 1);
  assert.match(configured, /仅应用配置或恢复服务/);
  assert.equal((await (await fetch(`${base}/api/monitors/oil/status`, { headers })).json()).pollSeconds, 45);
  assert.deepEqual(await sharedState(), sharedConfig);
  const configuredPid = await pid();
  await replaceConfig(expectedConfig.replace(/APP_PASSWORD=.*/, "APP_PASSWORD=short"));
  await install(baseline, false);
  assert.equal(await pid(), configuredPid);
  await replaceConfig(expectedConfig);

  console.log("Installer: a changed systemd override is applied even after daemon-reload");
  const overridePath = join(scratch, "override.conf");
  await writeFile(overridePath, "[Service]\nRestartSec=6s\n");
  await run("sudo", ["install", "-D", "-m", "0644", overridePath, "/etc/systemd/system/market-spread-monitor.service.d/override.conf"]);
  await run("sudo", ["systemctl", "daemon-reload"]);
  await install(baseline);
  assert.notEqual(await pid(), configuredPid);
  assert.equal(await buildCount(), 1);

  console.log("Installer: stopped or disabled services recover without rebuilding");
  const overridePid = await pid();
  await run("sudo", ["systemctl", "disable", "market-spread-monitor.service"]);
  await install(baseline);
  assert.equal(await pid(), overridePid);
  await run("systemctl", ["is-enabled", "--quiet", "market-spread-monitor.service"]);
  await run("sudo", ["systemctl", "stop", "market-spread-monitor.service"]);
  await install(baseline);
  await active();
  assert.equal(await current(), firstRelease);
  assert.equal(await buildCount(), 1);

  console.log("Installer: new source reuses independent dependency copies and builds changed code");
  await writeFile(join(baseline, "public/install-version-marker.txt"), "upgraded-source");
  const upgraded = await install(baseline);
  const secondRelease = await current();
  assert.notEqual(firstRelease, secondRelease);
  assert.match(upgraded, /依赖未变，复用已安装依赖/);
  assert.ok(!upgraded.includes("正在安装依赖"));
  assert.equal(await buildCount(), 2);
  assert.equal((await stat(join(secondRelease, "node_modules/.package-lock.json"))).mtimeMs, firstDependencyTime);
  assert.notEqual((await stat(join(firstRelease, "node_modules/next/package.json"))).ino, (await stat(join(secondRelease, "node_modules/next/package.json"))).ino);
  assert.equal(await (await fetch(`${base}/install-version-marker.txt`, { headers })).text(), "upgraded-source");
  assert.equal(await config(), expectedConfig);
  const releaseSet = await releases();
  assert.equal(await databaseMarker(), 'persisted', 'Source upgrade preserves the existing SQLite database');

  console.log("Installer: build failure keeps the old process running");
  await writeFile(join(baseline, "install-fixture-mode"), "fail-build");
  const pidBefore = await pid();
  const failedBuildOutput = await install(baseline, false);
  assert.ok(!failedBuildOutput.includes("正在安装依赖"));
  assert.equal(await current(), secondRelease);
  assert.equal(await pid(), pidBefore);
  assert.equal(existsSync(join(secondRelease, "node_modules/.isolation-probe")), false);
  await active();
  assert.equal(await config(), expectedConfig);

  console.log("Installer: failed startup restores the old release and service");
  await writeFile(join(baseline, "install-fixture-mode"), "reuse-build");
  const originalServer = await readFile(join(baseline, "server/linux.mjs"), "utf8");
  await writeFile(join(baseline, "server/linux.mjs"), 'throw new Error("intentional installer rollback test");\n');
  const unitBefore = await readFile("/etc/systemd/system/market-spread-monitor.service", "utf8");
  await install(baseline, false);
  assert.equal(await current(), secondRelease);
  assert.equal(await readFile("/etc/systemd/system/market-spread-monitor.service", "utf8"), unitBefore);
  await ready(); await active();
  assert.equal(await config(), expectedConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.equal((await state()).revision, savedState.revision);
  assert.deepEqual((await oilState()).config, oilConfig); assert.equal((await oilState()).revision, oilInitial.revision+1);
  assert.deepEqual(await releases(), releaseSet, "Failed releases must be removed after recovery");
  assert.equal(await databaseMarker(), 'persisted', 'Failed startup rollback preserves the existing SQLite database');

  console.log("Installer: changed npm configuration invalidates dependencies");
  await writeFile(join(baseline, "server/linux.mjs"), originalServer);
  await rm(join(baseline, "install-fixture-mode"));
  await writeFile(join(baseline, ".npmrc"), "audit=false\n");
  const changedDependencies = await install(baseline);
  assert.match(changedDependencies, /正在安装依赖/);
  assert.ok(!changedDependencies.includes("依赖未变"));
  assert.notEqual(await readFile(join(await current(), ".install-dependencies"), "utf8"), await readFile(join(secondRelease, ".install-dependencies"), "utf8"));
  assert.notEqual((await stat(join(await current(), "node_modules/.package-lock.json"))).mtimeMs, firstDependencyTime);
  await active();
  assert.equal(await config(), expectedConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.deepEqual((await oilState()).config, oilConfig);
  console.log("Installer timings:", JSON.stringify(timings));
  assert.deepEqual(await sharedState(), sharedConfig);
  console.log("Installer smoke passed: no-op, cache reuse, config-only restart, recovery, rollback and shared Feishu persistence; no Feishu messages sent.");
  assert.equal(await databaseMarker(), 'persisted', 'Dependency rebuild preserves the existing SQLite database');
} finally {
  await run("sudo", ["systemctl", "stop", "market-spread-monitor.service"]).catch(() => {});
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + "/market-spread-installer-test-"));
  await rm(scratch, { recursive: true, force: true });
}
