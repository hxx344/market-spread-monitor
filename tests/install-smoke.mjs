import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
async function run(command, args) {
  return exec(command, args, { timeout: 600_000, maxBuffer: 8_000_000 });
}
async function install(source, succeeds = true) {
  let result, failed = false;
  try {
    // Exercise the documented pipe form and automatic sudo elevation, not just bash file.sh.
    result = await run("bash", ["-o", "pipefail", "-c", 'cat "$1" | bash -s -- --source-dir "$2" --port 31877', "installer-test", installer, source]);
  } catch (error) { result = error; failed = true; }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/登录密码：[^\r\n]*/g, "登录密码：[redacted]");
  assert.equal(failed, !succeeds, output.slice(-6000));
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
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { if ((await state()).available) return; } catch { /* Wait for rollback restart. */ }
    await delay(500);
  }
  throw new Error("Service did not recover");
}
async function current() { return (await run("readlink", ["-f", "/opt/market-spread-monitor/current"])).stdout.trim(); }
async function active() { await run("systemctl", ["is-active", "--quiet", "market-spread-monitor.service"]); }
async function config() { return (await run("sudo", ["cat", "/etc/market-spread-monitor.env"])).stdout; }
async function copySource(name) {
  const target = join(scratch, name);
  await run("mkdir", ["-p", target]);
  await run("bash", ["-o", "pipefail", "-c", 'tar --exclude=./.git --exclude=./node_modules --exclude=./.next --exclude=./.sites-runtime -C "$1" -cf - . | tar -xf - -C "$2"', "copy-source", root, target]);
  return target;
}
try {
  console.log("Installer: fresh install through stdin and sudo");
  await install(root);
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
  const rules = [{ id: "install-test", name: "保存后升级", enabled: false, direction: "above", threshold: 40 }];
  const saved = await fetch(`${base}/api/alerts`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ enabled: false, cooldownSeconds: 60, hysteresis: 0.5, revision: initial.revision, rules }) });
  assert.equal(saved.status, 200);
  const savedState = await state();
  const oilInitial = await oilState();
  const oilConfig = { ...oilInitial.config, enabled: false, rules: [{ id: "install-oil", label: "油价保存后升级", metric: "spread", operator: "gte", threshold: 5, cooldownMinutes: 30, hysteresis: 0.1, enabled: false }] };
  const oilSaved = await fetch(`${base}/api/monitors/oil/config`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ revision: oilInitial.revision, config: oilConfig }) });
  assert.equal(oilSaved.status, 200);
  const firstRelease = await current();

  console.log("Installer: repeat upgrade preserves password, config, and alert state");
  await install(root);
  await active();
  const secondRelease = await current();
  assert.notEqual(firstRelease, secondRelease);
  assert.equal(await config(), originalConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.equal((await state()).revision, savedState.revision);
  assert.deepEqual((await oilState()).config, oilConfig); assert.equal((await oilState()).revision, oilInitial.revision+1);

  console.log("Installer: build failure keeps the old process running");
  const failedBuild = await copySource("failed-build");
  const manifestPath = join(failedBuild, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts["build:linux"] = 'node -e "process.exit(42)"';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const pidBefore = (await run("systemctl", ["show", "--property=MainPID", "--value", "market-spread-monitor.service"])).stdout;
  await install(failedBuild, false);
  assert.equal(await current(), secondRelease);
  assert.equal((await run("systemctl", ["show", "--property=MainPID", "--value", "market-spread-monitor.service"])).stdout, pidBefore);
  await active();
  assert.equal(await config(), originalConfig);

  console.log("Installer: failed startup restores the old release and service");
  const failedStart = await copySource("failed-start");
  const startupManifestPath = join(failedStart, "package.json");
  const startupManifest = JSON.parse(await readFile(startupManifestPath, "utf8"));
  // Application builds were verified twice above. Reuse one to isolate activation failure.
  startupManifest.scripts["build:linux"] = "cp -a /opt/market-spread-monitor/current/.next .next";
  await writeFile(startupManifestPath, JSON.stringify(startupManifest));
  await writeFile(join(failedStart, "server/linux.mjs"), 'throw new Error("intentional installer rollback test");\n');
  const unitBefore = await readFile("/etc/systemd/system/market-spread-monitor.service", "utf8");
  await install(failedStart, false);
  assert.equal(await current(), secondRelease);
  assert.equal(await readFile("/etc/systemd/system/market-spread-monitor.service", "utf8"), unitBefore);
  await ready(); await active();
  assert.equal(await config(), originalConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.equal((await state()).revision, savedState.revision);
  const directories = (await run("find", ["/opt/market-spread-monitor/releases", "-mindepth", "1", "-maxdepth", "1", "-type", "d"])).stdout.trim().split("\n");
  assert.deepEqual((await oilState()).config, oilConfig); assert.equal((await oilState()).revision, oilInitial.revision+1);
  assert.equal(directories.length, 2, "Failed releases must be removed after recovery");
  console.log("Installer smoke passed: install, upgrade, build failure, startup rollback; no Feishu messages sent.");
} finally {
  await run("sudo", ["systemctl", "stop", "market-spread-monitor.service"]).catch(() => {});
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + "/market-spread-installer-test-"));
  await rm(scratch, { recursive: true, force: true });
}
