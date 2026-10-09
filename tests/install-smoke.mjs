import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
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
const buildWorkspace = "/opt/market-spread-monitor/build";
const unitPath = "/etc/systemd/system/market-spread-monitor.service";
let headers;
const timings = [];
const profileDirectories = new Set();
const profiles = new Map();
const profilePhases = new Set([
  "preflight", "startup_cleanup", "system_packages", "source_identity", "node_runtime", "source_download",
  "fingerprints", "fast_probe", "service_setup", "space_check", "source_copy", "config_check", "deps_copy",
  "artifact_copy", "compiler_cache", "build_workspace", "deps_install", "next_build", "build_validate",
  "permissions", "unit_prepare", "service_switch", "health_check", "success_record", "final_cleanup",
  "describe", "rollback", "exit_cleanup",
]);
const profileSkipReasons = new Set(["unchanged", "reused", "not_needed", "cache_unavailable", "space_low"]);
async function run(command, args) {
  return exec(command, args, { timeout: 600_000, maxBuffer: 8_000_000 });
}
async function readProfile(output, exitCode) {
  const matches = [...output.matchAll(/^计时报告：(\/tmp\/market-spread-profile\.[A-Za-z0-9]{8}\/summary\.txt)\s*$/gm)];
  assert.equal(matches.length, 1, "Profile mode must print exactly one report path");
  const summaryPath = matches[0][1];
  const directory = summaryPath.slice(0, -"/summary.txt".length);
  profileDirectories.add(directory);
  const eventsPath = join(directory, "events.tsv");
  const permissions = (await run("sudo", ["stat", "-c", "%a:%u:%F", "--", directory, summaryPath, eventsPath])).stdout.trim().split("\n");
  assert.deepEqual(permissions, ["700:0:directory", "600:0:regular file", "600:0:regular file"], "Reports must be private root-owned regular files in a private directory");
  const summary = (await run("sudo", ["cat", "--", summaryPath])).stdout;
  const eventsText = (await run("sudo", ["cat", "--", eventsPath])).stdout;
  const reportText = summary + eventsText;
  const password = (await config()).match(/^APP_PASSWORD=(.*)$/m)?.[1];
  assert.ok(password, "The installed password must be available for report redaction verification");
  const secrets = [password, "install-storage-only-secret", ...Object.entries(process.env)
    .filter(([key, value]) => /TOKEN|PASSWORD|SECRET/i.test(key) && value && value.length >= 8)
    .map(([, value]) => value)];
  for (const secret of secrets) assert.equal(reportText.includes(secret), false, "A deployment report must not contain configuration passwords or environment secrets");
  assert.ok(summary.includes(`部署退出码：${exitCode}\n`), "The summary must preserve the installer exit code");
  assert.ok(/^总耗时：\d+\.\d{3} 秒$/m.test(summary), "The summary must include total elapsed time");
  const phaseRows = new Map();
  const table = summary.trim().split("\n").filter(line => line.includes("\t"));
  assert.equal(table.shift(), "秒数\t占比\t状态\t阶段");
  for (const line of table) {
    const fields = line.split("\t");
    assert.equal(fields.length, 4, "Each summary phase must have exactly four fields");
    const [seconds, share, status, label] = fields;
    assert.ok(/^\d+\.\d{3}$/.test(seconds), "Summary duration must be seconds with millisecond precision");
    assert.ok(/^\d+(?:\.\d+)?%$/.test(share), "Summary share must be a percentage");
    const id = label.match(/ \[([a-z_]+)\]$/)?.[1];
    assert.ok(profilePhases.has(id), "Summary phase identifiers must come from the fixed allowlist");
    assert.equal(phaseRows.has(id), false, "Summary phases must not be duplicated");
    phaseRows.set(id, { seconds: Number(seconds), status });
  }
  assert.deepEqual(new Set(phaseRows.keys()), profilePhases, "The summary must distinguish all executed and skipped phases");
  const events = eventsText.trim().split("\n").map(line => {
    const fields = line.split("\t");
    assert.equal(fields.length, 4, "Profile events must contain only four fixed fields");
    const [type, milliseconds, id, status] = fields;
    assert.ok(/^\d+$/.test(milliseconds), "Event times must be integer milliseconds");
    if (type === "phase") {
      assert.ok(profilePhases.has(id), "Event phases must come from the fixed allowlist");
      assert.ok(/^\d+$/.test(status), "Phase status must be an exit code");
    } else if (type === "skip") {
      assert.ok(profilePhases.has(id), "Skipped phases must come from the fixed allowlist");
      assert.ok(profileSkipReasons.has(status), "Skip reasons must come from the fixed allowlist");
    } else {
      assert.equal(type, "end", "Profile events must never contain command output or arbitrary metadata");
      assert.equal(id, String(exitCode), "The final event must preserve the installer exit code");
      assert.equal(status, "0");
    }
    return { type, milliseconds: Number(milliseconds), id, status };
  });
  assert.equal(events.filter(event => event.type === "end").length, 1);
  assert.equal(events.at(-1).type, "end", "Reporting must finish after installer cleanup");
  for (let index = 1; index < events.length; index++) assert.ok(events[index].milliseconds >= events[index - 1].milliseconds, "Profile event times must never run backwards");
  assert.equal(events.filter(event => event.type === "phase").at(-1)?.id, "exit_cleanup", "The report must include exit cleanup");
  return { events, phases: phaseRows };
}
function assertProfilePhases(output, { completed = [], failed = [], skipped = {} }) {
  const profile = profiles.get(output);
  assert.ok(profile, "Expected a verified deployment report");
  for (const id of [...completed, ...failed]) assert.ok(profile.events.some(event => event.type === "phase" && event.id === id), `Expected execution of profile phase ${id}`);
  for (const id of completed) assert.equal(profile.phases.get(id).status, "完成", `Expected successful profile phase ${id}`);
  for (const id of failed) assert.ok(/^失败（退出码 [1-9]\d*）$/.test(profile.phases.get(id).status), `Expected failed profile phase ${id}`);
  for (const [id, reason] of Object.entries(skipped)) {
    assert.ok(profile.events.some(event => event.type === "skip" && event.id === id && event.status === reason), `Expected profile phase ${id} skipped because ${reason}`);
    assert.equal(profile.events.some(event => event.type === "phase" && event.id === id), false, `Skipped profile phase ${id} must not be reported as executed`);
    assert.ok(/^(?:跳过|已复用)（.+）$/.test(profile.phases.get(id).status), `Expected skipped status for profile phase ${id}`);
    assert.equal(profile.phases.get(id).seconds, 0, `Skipped profile phase ${id} must not claim execution time`);
  }
}
async function install(source, succeeds = true, { script = installer, cleanup = false, profile = false } = {}) {
  const started = Date.now();
  let result, failed = false;
  try {
    // Exercise the documented pipe form and automatic sudo elevation, not just bash file.sh.
    result = await run("bash", ["-o", "pipefail", "-c", 'cat "$1" | bash -s -- --source-dir "$2" --port 31877 "${@:3}"', "installer-test", script, source, ...(cleanup ? ["--cleanup"] : []), ...(profile ? ["--profile"] : [])]);
  } catch (error) { result = error; failed = true; }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/登录密码：[^\r\n]*/g, "登录密码：[redacted]");
  if (profile) profiles.set(output, await readProfile(output, failed ? result.code : 0));
  else assert.equal(output.includes("计时报告："), false, "Ordinary installation must not create a timing report");
  assert.equal(failed, !succeeds, output.slice(-6000));
  assert.equal(existsSync(buildWorkspace), false, "Completed or failed installation must not leave a third dependency/build workspace");
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
async function assertLinuxDependencies(release, source) {
  for (const name of ["vite", "vinext", "wrangler", "eslint", "@cloudflare/vite-plugin"]) {
    assert.equal(existsSync(join(release, "node_modules", name)), false, `Linux installation must omit ${name}`);
  }
  for (const name of ["next", "react", "typescript", "tailwindcss", "@tailwindcss/postcss", "tw-animate-css", "@types/node", "@types/react", "@types/react-dom"]) {
    assert.ok(existsSync(join(release, "node_modules", name, "package.json")), `Linux installation must retain ${name}`);
  }
  for (const name of ["package.json", "package-lock.json"]) {
    assert.deepEqual(await readFile(join(release, name)), await readFile(join(source, name)), `Installation must restore the original ${name} byte for byte`);
    assert.equal(existsSync(join(release, `.install-source-${name}`)), false, "Temporary install manifests must be removed");
  }
}
async function assertNoWork(output, { release, processId, builds, dependencyTime, unitTime }) {
  assert.match(output, /跳过.*依赖安装.*构建.*重启/);
  assert.ok(!output.includes("正在安装依赖"));
  assert.equal(await current(), release);
  assert.equal(await pid(), processId);
  assert.equal(await buildCount(), builds);
  assert.equal((await stat(join(release, "node_modules/.package-lock.json"))).mtimeMs, dependencyTime);
  assert.equal((await stat(unitPath)).mtimeMs, unitTime);
}
function logBuildEvidence(label, output) {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter(line => /Installer (cache|compile)|cached modules|built modules|compiled successfully|Compiled successfully|restore cache|pack from cache/i.test(line));
  console.log(`Installer ${label} build evidence:\n${lines.join("\n")}`);
}
async function releases() { return (await run("find", ["/opt/market-spread-monitor/releases", "-mindepth", "1", "-maxdepth", "1", "-type", "d"])).stdout.trim().split("\n").sort(); }
async function copySource(name) {
  const target = join(scratch, name);
  await run("mkdir", ["-p", target]);
  await run("bash", ["-o", "pipefail", "-c", 'tar --exclude=./.git --exclude=./node_modules --exclude=./.next --exclude=./.sites-runtime -C "$1" -cf - . | tar -xf - -C "$2"', "copy-source", root, target]);
  return target;
}
async function exhaustedStorageInstaller(kind) {
  // Mock only capacity reporting. Run the real installer and cleanup on this empty CI VM;
  // do not fill the disk, consume inodes or alter global commands to induce the failure.
  const target = join(scratch, `installer-no-${kind}.sh`);
  const available = kind === "space" ? 0 : 1_000_000_000;
  const inodes = kind === "inodes" ? 0 : 1_000_000_000;
  await writeFile(target, `df() {
  if [[ "$*" == *-Pi* ]]; then
    printf 'Filesystem Inodes IUsed IFree IUse%% Mounted\\040on\\nfixture 2000000000 1 ${inodes} 1%% /\\n'
  else
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\040on\\nfixture 2000000000 1 ${available} 1%% /\\n'
  fi
}
${await readFile(installer, "utf8")}`);
  return target;
}
try {
  const baseline = await copySource("baseline");
  const manifestPath = join(baseline, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts["build:linux"] = "node tests/install-build-wrapper.mjs";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const routePath = join(baseline, "app/install-cache-probe/route.ts");
  const routeSource = version => `export const dynamic = 'force-dynamic';\nexport function GET() { return Response.json({ version: '${version}' }); }\n`;
  await mkdir(join(baseline, "app/install-cache-probe"));
  await writeFile(routePath, routeSource("initial-compiled-route"));
  await writeFile(join(baseline, "tests/install-build-wrapper.mjs"), `import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync, cpSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
assert.equal(realpathSync('.'), '/opt/market-spread-monitor/build', 'Every real Next build must use the same physical directory');
assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).scripts['build:linux'], 'node tests/install-build-wrapper.mjs', 'The original build script must be restored before npm runs it');
assert.ok(JSON.parse(readFileSync('package-lock.json', 'utf8')).packages[''].devDependencies.eslint, 'The complete source lock must be restored before compilation');
for (const name of ['vite', 'vinext', 'wrangler', 'eslint', '@cloudflare/vite-plugin']) assert.equal(existsSync('node_modules/' + name), false, 'Linux build must omit ' + name);
for (const name of ['typescript', 'tailwindcss', '@tailwindcss/postcss']) assert.ok(existsSync('node_modules/' + name + '/package.json'), 'Linux build requires ' + name);
appendFileSync('/var/cache/market-spread-monitor/install-test-builds', JSON.stringify({ cwd: realpathSync('.') }) + '\\n');
const mode = existsSync('install-fixture-mode') ? readFileSync('install-fixture-mode','utf8').trim() : '';
if (mode === 'check-build-cache') {
  const previousCache = '/opt/market-spread-monitor/current/.next/cache/';
  for (const name of ['webpack', '.rscinfo', '.tsbuildinfo']) assert.ok(existsSync('.next/cache/' + name), 'Missing reusable compiler cache: ' + name);
  for (const name of ['.rscinfo', '.tsbuildinfo']) {
    assert.equal(readFileSync('.next/cache/' + name, 'utf8'), readFileSync(previousCache + name, 'utf8'), name + ' contents must be preserved before compilation');
    assert.equal(statSync('.next/cache/' + name).mtimeMs, statSync(previousCache + name).mtimeMs, name + ' modification time must survive the copy');
    assert.notEqual(statSync('.next/cache/' + name).ino, statSync(previousCache + name).ino, name + ' must not share a writable inode with the running version');
  }
  const packs = readdirSync('.next/cache/webpack', { recursive: true }).filter(name => name.endsWith('.pack'));
  assert.ok(packs.length > 0, 'The warm build must receive actual Webpack cache packs');
  const pack = 'webpack/' + packs[0];
  assert.equal(statSync('.next/cache/' + pack).mtimeMs, statSync(previousCache + pack).mtimeMs);
  assert.notEqual(statSync('.next/cache/' + pack).ino, statSync(previousCache + pack).ino);
  for (const name of ['images', 'fetch-cache', 'install-unapproved-cache']) assert.equal(existsSync('.next/cache/' + name), false, 'Runtime and unapproved caches must not enter the compiler workspace');
  console.log('Installer cache: independent Webpack packs, .rscinfo and .tsbuildinfo preserved before compilation');
}
if (mode === 'fail-build') { writeFileSync('node_modules/.isolation-probe', 'new release only'); process.exit(42); }
if (mode === 'reuse-build') { cpSync('/opt/market-spread-monitor/current/.next', '.next', {recursive:true}); }
else {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next','build','--webpack'], {stdio:'inherit', env: {...process.env, NEXT_WEBPACK_LOGGING: '1'}});
  console.log('Installer compile milliseconds:', Date.now() - started);
  process.exit(result.status ?? 1);
}
`);
  console.log("Installer: fresh install through stdin and sudo");
  const coldBuild = await install(baseline, true, { profile: true });
  assertProfilePhases(coldBuild, { completed: ["deps_install", "next_build", "permissions", "health_check", "success_record", "exit_cleanup"] });
  logBuildEvidence("cold", coldBuild);
  await active();
  const originalConfig = await config();
  const values = Object.fromEntries(originalConfig.trim().split("\n").map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.ok(values.APP_PASSWORD.length >= 24);
  headers = { Authorization: `Basic ${Buffer.from(`${values.APP_USERNAME}:${values.APP_PASSWORD}`).toString("base64")}` };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/install-cache-probe`, { headers })).json(), { version: "initial-compiled-route" });
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
  const firstUnitTime = (await stat(unitPath)).mtimeMs;
  await assertLinuxDependencies(firstRelease, baseline);
  assert.match(coldBuild, /安装 Linux 所需依赖/);
  const dependencyKB = Number((await run("du", ["-sk", join(firstRelease, "node_modules")])).stdout.trim().split(/\s+/)[0]);
  assert.ok(Number.isSafeInteger(dependencyKB) && dependencyKB > 0);
  console.log("Installer Linux dependency size:", JSON.stringify({ dependencyKB }));

  console.log("Installer: unchanged source (even after touch) performs no build, install, release switch or restart");
  await utimes(join(baseline, "README.md"), new Date(), new Date());
  const unchanged = await install(baseline, true, { profile: true });
  assertProfilePhases(unchanged, { completed: ["exit_cleanup"], skipped: { deps_install: "reused", next_build: "reused" } });
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

  console.log("Installer: docs/tests-only commits update checked source without relabelling or restarting the artifact");
  const originalArtifactSource = await readFile(join(firstRelease, ".install-source"), "utf8");
  await writeFile(join(baseline, "README.md"), (await readFile(join(baseline, "README.md"), "utf8")) + "\nInstaller documentation fixture.\n");
  await writeFile(join(baseline, "tests/documentation-only.test.mjs"), "// Test-only source change.\n");
  const docsOnly = await install(baseline);
  assert.match(docsOnly, /运行和构建内容未变/);
  assert.equal(await current(), firstRelease);
  assert.equal(await pid(), firstPid);
  assert.equal(await buildCount(), 1);
  assert.equal(await readFile(join(firstRelease, ".install-source"), "utf8"), originalArtifactSource);
  assert.notEqual(await readFile(join(firstRelease, ".install-checked-source"), "utf8"), originalArtifactSource);

  console.log("Installer: unrelated Sites configuration and development dependency changes require no install, build or restart");
  const noWork = { release: firstRelease, processId: firstPid, builds: 1, dependencyTime: firstDependencyTime, unitTime: firstUnitTime };
  const viteConfig = join(baseline, "vite.config.ts");
  await writeFile(viteConfig, (await readFile(viteConfig, "utf8")) + "\n// Sites-only configuration fixture.\n");
  await assertNoWork(await install(baseline), noWork);
  const developmentManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourceLockPath = join(baseline, "package-lock.json");
  const developmentLock = JSON.parse(await readFile(sourceLockPath, "utf8"));
  const eslintVersion = developmentLock.packages["node_modules/eslint"].version;
  const eslintRange = developmentManifest.devDependencies.eslint === `~${eslintVersion}` ? `^${eslintVersion}` : `~${eslintVersion}`;
  developmentManifest.devDependencies.eslint = eslintRange;
  developmentLock.packages[""].devDependencies.eslint = eslintRange;
  await writeFile(manifestPath, JSON.stringify(developmentManifest));
  await writeFile(sourceLockPath, JSON.stringify(developmentLock));
  await assertNoWork(await install(baseline), noWork);
  assert.equal(await readFile(join(firstRelease, ".install-source"), "utf8"), originalArtifactSource, "Ignored tool changes must not relabel the compiled artifact");

  console.log("Installer: configuration changes only restart, and invalid configuration leaves the old process running");
  const expectedConfig = originalConfig.replace("OIL_POLL_INTERVAL_SECONDS=30", "OIL_POLL_INTERVAL_SECONDS=45");
  await replaceConfig(expectedConfig);
  const configured = await install(baseline);
  assert.equal(await current(), firstRelease);
  assert.notEqual(await pid(), firstPid);
  assert.equal(await buildCount(), 1);
  assert.match(configured, /仅应用配置或恢复服务/);
  assert.equal((await stat(unitPath)).mtimeMs, firstUnitTime, "Configuration-only recovery must not rewrite the service unit");
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

  console.log("Installer: changed TypeScript route reuses independent compiler caches and returns newly compiled code");
  for (const name of ["images", "fetch-cache", "install-unapproved-cache"]) {
    await run("sudo", ["mkdir", "-p", join(firstRelease, ".next/cache", name)]);
    await run("sudo", ["install", "-m", "0644", "/dev/null", join(firstRelease, ".next/cache", name, "install-preserve-marker")]);
  }
  await writeFile(join(baseline, "install-fixture-mode"), "check-build-cache");
  await writeFile(routePath, routeSource("upgraded-compiled-route"));
  await writeFile(join(baseline, "public/install-version-marker.txt"), "upgraded-source");
  const upgraded = await install(baseline, true, { profile: true });
  assertProfilePhases(upgraded, { completed: ["deps_copy", "compiler_cache", "next_build", "health_check", "success_record", "exit_cleanup"], skipped: { deps_install: "reused" } });
  assert.match(upgraded, /Installer cache: independent Webpack packs, \.rscinfo and \.tsbuildinfo preserved before compilation/);
  assert.match(upgraded.replace(/\u001b\[[0-9;]*m/g, ""), /\bcached modules\b[^\r\n]*\b[1-9][0-9]* modules?\b/, "The warm compilation must report actual cached modules, not merely copied cache files");
  logBuildEvidence("warm", upgraded);
  const secondRelease = await current();
  assert.notEqual(firstRelease, secondRelease);
  assert.match(upgraded, /依赖未变，复用已安装依赖/);
  assert.ok(!upgraded.includes("正在安装依赖"));
  assert.equal(await buildCount(), 2);
  assert.equal((await stat(unitPath)).mtimeMs, firstUnitTime, "Application upgrades must retain an unchanged service unit");
  await assertLinuxDependencies(secondRelease, baseline);
  assert.equal((await stat(join(secondRelease, "node_modules/.package-lock.json"))).mtimeMs, firstDependencyTime);
  assert.notEqual((await stat(join(firstRelease, "node_modules/next/package.json"))).ino, (await stat(join(secondRelease, "node_modules/next/package.json"))).ino);
  assert.equal(await (await fetch(`${base}/install-version-marker.txt`, { headers })).text(), "upgraded-source");
  assert.deepEqual(await (await fetch(`${base}/install-cache-probe`, { headers })).json(), { version: "upgraded-compiled-route" }, "Compiler cache reuse must not serve the previous TypeScript route");
  for (const name of ["images", "fetch-cache", "install-unapproved-cache"]) await run("sudo", ["test", "-f", join(firstRelease, ".next/cache", name, "install-preserve-marker")]);
  assert.equal(await config(), expectedConfig);
  const releaseSet = await releases();
  assert.equal(await databaseMarker(), 'persisted', 'Source upgrade preserves the existing SQLite database');

  console.log("Installer: cleanup reclaims stale managed releases without restarting or deleting outside targets");
  const oldSuccess = "/opt/market-spread-monitor/releases/aaaaaaaaaaaa-OLD00001";
  const interrupted = "/opt/market-spread-monitor/releases/bbbbbbbbbbbb-FAIL0001";
  const externalTarget = join(scratch, "outside-release-root");
  const externalMarker = join(externalTarget, "preserve.txt");
  await run("mkdir", ["-p", externalTarget]);
  await writeFile(externalMarker, "outside installation releases");
  for (const path of [oldSuccess, interrupted]) {
    await run("sudo", ["mkdir", "-p", path]);
    await run("sudo", ["install", "-m", "0644", "/dev/null", join(path, ".install-owned")]);
  }
  await run("sudo", ["install", "-m", "0644", "/dev/null", join(oldSuccess, ".install-ready")]);
  await run("sudo", ["touch", "-d", "2000-01-01T00:00:00Z", join(oldSuccess, ".install-ready")]);
  await run("sudo", ["ln", "-s", externalTarget, "/opt/market-spread-monitor/releases/cccccccccccc-LINK0001"]);
  const beforeCleanupPid = await pid();
  const beforeCleanupBuilds = await buildCount();
  await install(baseline, true, { cleanup: true });
  assert.deepEqual(await releases(), releaseSet, "Cleanup retains current and the latest successful rollback release");
  assert.equal(await current(), secondRelease);
  assert.equal(await pid(), beforeCleanupPid);
  assert.equal(await buildCount(), beforeCleanupBuilds);
  assert.equal(await readFile(externalMarker, "utf8"), "outside installation releases", "Cleanup must not follow release symlinks");
  assert.equal(await config(), expectedConfig);
  assert.equal(await databaseMarker(), 'persisted', 'Cleanup preserves the existing SQLite database');

  console.log("Installer: insufficient disk space or inodes fails before build and preserves the running release");
  await writeFile(join(baseline, "install-fixture-mode"), "fail-build");
  for (const kind of ["space", "inodes"]) {
    const output = await install(baseline, false, { script: await exhaustedStorageInstaller(kind) });
    assert.match(output, kind === "space" ? /空间不足/ : /inode\s*不足/);
    assert.equal(await current(), secondRelease);
    assert.equal(await pid(), beforeCleanupPid);
    assert.equal(await buildCount(), beforeCleanupBuilds, "Capacity rejection must happen before building");
    assert.deepEqual(await releases(), releaseSet, "Capacity rejection leaves no incomplete release");
    assert.equal(await config(), expectedConfig);
    assert.equal(await databaseMarker(), 'persisted', 'Capacity rejection preserves the existing SQLite database');
    await active();
  }

  console.log("Installer: build failure keeps the old process running");
  await writeFile(join(baseline, "install-fixture-mode"), "fail-build");
  const pidBefore = await pid();
  const failedBuildOutput = await install(baseline, false, { profile: true });
  assertProfilePhases(failedBuildOutput, { completed: ["deps_copy", "exit_cleanup"], failed: ["next_build"], skipped: { deps_install: "reused" } });
  assert.ok(!failedBuildOutput.includes("正在安装依赖"));
  assert.equal(await current(), secondRelease);
  assert.equal(await pid(), pidBefore);
  assert.deepEqual(await releases(), releaseSet, "Build failure removes the incomplete candidate without removing the rollback release");
  assert.equal(existsSync(join(secondRelease, "node_modules/.isolation-probe")), false);
  await active();
  assert.equal(await config(), expectedConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.equal((await state()).revision, savedState.revision);
  assert.deepEqual((await oilState()).config, oilConfig);
  assert.deepEqual(await sharedState(), sharedConfig);
  assert.equal(await databaseMarker(), 'persisted', 'Build failure preserves the existing SQLite database');
  assert.deepEqual(await (await fetch(`${base}/install-cache-probe`, { headers })).json(), { version: "upgraded-compiled-route" });

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
  const thirdRelease = await current();
  assert.match(changedDependencies, /正在安装依赖/);
  assert.ok(!changedDependencies.includes("依赖未变"));
  assert.notEqual(await readFile(join(await current(), ".install-dependencies"), "utf8"), await readFile(join(secondRelease, ".install-dependencies"), "utf8"));
  assert.notEqual((await stat(join(await current(), "node_modules/.package-lock.json"))).mtimeMs, firstDependencyTime);
  await active();
  assert.equal(await config(), expectedConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.deepEqual((await oilState()).config, oilConfig);
  assert.deepEqual(await releases(), [secondRelease, thirdRelease].sort(), "Only the current release and one successful rollback release may remain");
  assert.equal(existsSync(firstRelease), false, "The oldest successful release is reclaimed after the next successful upgrade");
  console.log("Installer timings:", JSON.stringify(timings));
  assert.deepEqual(await sharedState(), sharedConfig);
  assert.equal(await databaseMarker(), 'persisted', 'Dependency rebuild preserves the existing SQLite database');

  console.log("Installer: an independent server change reuses the verified Next artifact and preserves its provenance");
  const compiledSource = await readFile(join(thirdRelease, ".install-build-source"), "utf8");
  const buildBeforeBackend = await buildCount();
  await writeFile(join(baseline, "server/linux.mjs"), originalServer + "\n// Independent server entry update.\n");
  const backendOnly = await install(baseline, true, { profile: true });
  assertProfilePhases(backendOnly, { completed: ["deps_copy", "artifact_copy", "health_check", "success_record", "exit_cleanup"], skipped: { deps_install: "reused", next_build: "reused" } });
  const backendRelease = await current();
  assert.notEqual(backendRelease, thirdRelease);
  assert.match(backendOnly, /Next 构建输入未变/);
  assert.equal(await buildCount(), buildBeforeBackend);
  assert.equal(await readFile(join(backendRelease, ".install-build-source"), "utf8"), compiledSource);
  for (const name of ["webpack", ".rscinfo", ".tsbuildinfo"]) await run("sudo", ["test", "-e", join(backendRelease, ".next/cache", name)]);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await stat(join(backendRelease, "server/linux.mjs"))).uid, 0);
  assert.equal((await stat(join(backendRelease, "node_modules/next/package.json"))).uid, 0);
  assert.equal((await stat(join(backendRelease, "server/linux.mjs"))).mode & 0o022, 0);

  console.log("Installer: a Next API server import invalidates the build");
  const summaryFile = join(baseline, "server/hub-summary.mjs");
  await writeFile(summaryFile, (await readFile(summaryFile, "utf8")) + "\n// Next-facing API implementation update.\n");
  const importedChange = await install(baseline);
  assert.ok(!importedChange.includes("Next 构建输入未变"));
  assert.equal(await buildCount(), buildBeforeBackend + 1);

  console.log("Installer: a damaged build manifest is rebuilt while valid dependencies remain reusable");
  const damagedRelease = await current();
  await run("sudo", ["rm", join(damagedRelease, ".next/build-manifest.json")]);
  const repaired = await install(baseline);
  assert.match(repaired, /依赖未变，复用已安装依赖/);
  assert.ok(!repaired.includes("Next 构建输入未变"));
  assert.equal(await buildCount(), buildBeforeBackend + 2);
  assert.ok(existsSync(join(await current(), ".next/build-manifest.json")));
  assert.equal(await databaseMarker(), 'persisted');

  console.log("Installer: legacy dependency, runtime and build fingerprints migrate once, then the next run is a no-op");
  const beforeMigration = await current();
  const buildsBeforeMigration = await buildCount();
  const dependenciesBeforeMigration = (await stat(join(beforeMigration, "node_modules/.package-lock.json"))).mtimeMs;
  const legacyMarkers = { ".install-dependencies": "1".repeat(64), ".install-runtime": "2".repeat(64), ".install-build": "3".repeat(64) };
  // Emulate all three old-schema keys. Changing only the dependency marker can
  // leave the valid runtime/build fast path untouched and would not test migration.
  for (const [name, value] of Object.entries(legacyMarkers)) {
    const marker = join(scratch, name);
    await writeFile(marker, `${value}\n`);
    await run("sudo", ["install", "-m", "0644", marker, join(beforeMigration, name)]);
  }
  const migrated = await install(baseline);
  const migratedRelease = await current();
  assert.notEqual(migratedRelease, beforeMigration);
  assert.match(migrated, /正在安装依赖/);
  assert.ok(!migrated.includes("Next 构建输入未变"));
  assert.equal(await buildCount(), buildsBeforeMigration + 1);
  await assertLinuxDependencies(migratedRelease, baseline);
  const migratedDependencyTime = (await stat(join(migratedRelease, "node_modules/.package-lock.json"))).mtimeMs;
  assert.notEqual(migratedDependencyTime, dependenciesBeforeMigration);
  const migratedMarkers = {};
  for (const [name, value] of Object.entries(legacyMarkers)) {
    migratedMarkers[name] = await readFile(join(migratedRelease, name), "utf8");
    assert.notEqual(migratedMarkers[name].trim(), value);
    assert.match(migratedMarkers[name].trim(), /^[a-f0-9]{64}$/);
  }
  const migratedReleases = await releases();
  const migratedNoWork = {
    release: migratedRelease, processId: await pid(), builds: buildsBeforeMigration + 1,
    dependencyTime: migratedDependencyTime, unitTime: (await stat(unitPath)).mtimeMs,
  };
  await assertNoWork(await install(baseline), migratedNoWork);
  assert.deepEqual(await releases(), migratedReleases);
  for (const [name, value] of Object.entries(migratedMarkers)) assert.equal(await readFile(join(migratedRelease, name), "utf8"), value);
  assert.equal(await databaseMarker(), 'persisted', 'Schema migration must preserve the existing SQLite database');
  assert.equal(await config(), expectedConfig);
  assert.deepEqual((await state()).config.rules, rules);
  assert.deepEqual((await oilState()).config, oilConfig);
  assert.deepEqual(await sharedState(), sharedConfig);
  assert.deepEqual(await (await fetch(`${base}/install-cache-probe`, { headers })).json(), { version: "upgraded-compiled-route" });
  const buildRecords = (await run("sudo", ["cat", "/var/cache/market-spread-monitor/install-test-builds"])).stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(buildRecords.length >= 2);
  assert.ok(buildRecords.every(record => record.cwd === buildWorkspace), "All build attempts, including failed ones, use the stable workspace path");
  console.log("Complete installer timings:", JSON.stringify(timings));
  console.log("Installer smoke passed: private timing reports, Linux dependency profile, no-op updates, unchanged service unit, cache reuse, storage reclamation, space/inode preflight, config-only restart, recovery, rollback, schema migration and shared Feishu persistence; no Feishu messages sent.");
} finally {
  await run("sudo", ["systemctl", "stop", "market-spread-monitor.service"]).catch(() => {});
  for (const directory of profileDirectories) {
    assert.ok(/^\/tmp\/market-spread-profile\.[A-Za-z0-9]{8}$/.test(directory), "Only reports created by this smoke test may be removed");
    await run("sudo", ["rm", "-rf", "--one-file-system", "--", directory]);
  }
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + "/market-spread-installer-test-"));
  await rm(scratch, { recursive: true, force: true });
}
